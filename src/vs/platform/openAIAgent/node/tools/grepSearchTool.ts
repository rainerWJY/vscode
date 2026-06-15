/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { ILogService } from '../../../../platform/log/common/log.js';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { type IAgentHostPathService } from '../services/agentHostPathService.js';
import { AgentHostWorkingDirectory } from '../services/agentHostWorkingDirectory.js';

/**
 * Do a fast text search in the workspace.
 *
 * Aligned with Copilot's `grep_search` tool (FindTextInFilesTool).
 * Uses ripgrep directly (agent host is a standalone Node.js process
 * that cannot access `vscode.workspace.findTextInFiles2()`).
 *
 * Key alignment features:
 * - Input validation (rejects unsupported `pattern` property)
 * - 20-second timeout (matching Copilot)
 * - Regex→literal fallback when regex yields no results (matching Copilot)
 * - MaxResults cap at 200 (matching Copilot)
 * - Cancellation checks before/after I/O
 * - includeIgnoredFiles support
 * - No-match instructions suggesting includeIgnoredFiles
 */
export const TOOL_GREP_SEARCH = defineTool({
	name: ToolName.FindTextInFiles,
	description:
		'Do a fast text search in the workspace. Use regex patterns with alternation (|) or character classes to search for multiple potential words at once.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The text or regex pattern to search for.' },
			isRegexp: { type: 'boolean', description: 'Whether the pattern is a regex.' },
			includePattern: { type: 'string', description: 'Limit search to files matching this glob pattern.' },
			maxResults: { type: 'number', description: 'Maximum number of results to return.' },
			includeIgnoredFiles: { type: 'boolean', description: 'Whether to include files normally ignored by .gitignore.' },
		},
		required: ['query'],
	},
	isDestructive: false,
	toolKind: 'search',
});

/** Copilot caps results at 200. */
const MaxResultsCap = 200;

/** Timeout for ripgrep search: 20s (matching Copilot). */
const SearchTimeoutMs = 20_000;

// ---- includePattern normalization (matches Copilot's resolveInput) ----------
// Moved to AgentHostWorkingDirectory.normalizeGlob()

// ---- handler (tool executor) ------------------------------------------------

export function createGrepSearchExecutor(
	pathService: IAgentHostPathService,
	logService: ILogService,
	/** Optional working directory to scope ripgrep to a specific folder. */
	workingDir?: AgentHostWorkingDirectory,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.info(`[GrepSearchTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, query="${input.parameters.query}", isRegexp=${input.parameters.isRegexp}, workingDir=${workingDir?.getSearchCwd() ?? '/'}`);
		try {
			const token = input.cancellationToken;

			// Copilot-matching: check cancellation before any work
			if (token?.isCancellationRequested) {
				logService.warn(`[GrepSearchTool] cancelled before any work`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const params = input.parameters;

			// Input validation: Copilot checks for "pattern" vs "query"
			if ((params as unknown as Record<string, string>).pattern) {
				logService.warn(`[GrepSearchTool] input validation failed: 'pattern' property not supported`);
				return {
					toolCallId: input.toolCallId,
					content: 'The property "pattern" is not supported, please use "query"',
					success: false,
				};
			}

			const query = params.query as string;
			if (!query || typeof query !== 'string') {
				logService.warn(`[GrepSearchTool] input validation failed: missing or invalid 'query'`);
				return { toolCallId: input.toolCallId, content: 'query is required', success: false };
			}

			const isRegExp = params.isRegexp !== undefined ? Boolean(params.isRegexp) : true;
			const askedForTooMany = params.maxResults !== undefined && Number(params.maxResults) > MaxResultsCap;

			// Copilot-matching: default maxResults=20 (Default mode), cap at 200
			const maxResults = Math.min(Number(params.maxResults) || 20, MaxResultsCap);

			// Use shared AgentHostWorkingDirectory for pattern normalization
			const rawIncludePattern = params.includePattern as string | undefined;
			const includePattern = workingDir?.normalizeGlob(rawIncludePattern) ?? rawIncludePattern;

			const includeIgnoredFiles = Boolean(params.includeIgnoredFiles);
			const queryIsValidRegex = isValidRegex(query);

			logService.info(`[GrepSearchTool] step=validate: query="${query}", isRegExp=${isRegExp}, ` +
				`maxResults=${maxResults}, includePattern=${includePattern ?? '*'} ` +
				`includeIgnoredFiles=${includeIgnoredFiles}, workingDir=${workingDir?.getSearchCwd() ?? '/'}`);

			// Resolve ripgrep binary path
			const rgPath = await rgDiskPath();

			// Copilot-matching: check cancellation before I/O
			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// Build ripgrep arguments
			const baseArgs = buildRgArgs(query, { isRegExp, maxResults, includePattern, includeIgnoredFiles });

			// Use working directory's cwd; fall back to root (search entire filesystem)
			const rgCwd = workingDir?.getSearchCwd() ?? '/';

			logService.info(`[GrepSearchTool] step=rg_spawn: rgPath=${rgPath}, cwd=${rgCwd}, args=${JSON.stringify(baseArgs)}`);

			// First attempt with the requested mode
			let results = await searchWithRg(rgPath, baseArgs, maxResults, rgCwd, token, logService);

			// Copilot-minfo(`[GrepSearchTool] step=rg_retry_literal: 0 regex hits, retrying as is a valid regex, retry literal
			if (!results.length && isRegExp && queryIsValidRegex) {
				logService.trace(`[GrepSearchTool] No regex results, retrying with literal search`);
				const literalArgs = buildRgArgs(query, { isRegExp: false, maxResults, includePattern, includeIgnoredFiles });
				results = await searchWithRg(rgPath, literalArgs, maxResults, rgCwd, token, logService);
			}

			// Copilot-matching: check cancellation after I/O
			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const elapsed = Date.now() - startTime;
			const numResults = results.length;
			logService.info(`[GrepSearchTool] >>> done: ${numResults} results in ${elapsed}ms`);

			if (!numResults) {
				let noMatchMsg = 'No matches found';
				if (!includeIgnoredFiles) {
					noMatchMsg += '\n\nYour search pattern might be excluded by .*ignore files or search.exclude settings. ' +
						'If you believe there should be results, try setting "includeIgnoredFiles" to true.';
				}
				return { toolCallId: input.toolCallId, content: noMatchMsg, success: true };
			}

			const countText = numResults === 1 ? '1 match' : `${numResults} matches`;
			const capText = askedForTooMany ? ` (maxResults capped at ${MaxResultsCap})` : '';
			const resultText = results.join('\n');

			return {
				toolCallId: input.toolCallId,
				content: `${countText}${capText}\n${resultText}`,
				success: true,
			};
		} catch (err) {
			const elapsed = Date.now() - startTime;
			logService.error(`[GrepSearchTool] grep_search ERROR after ${elapsed}ms: ${err}`);
			return { toolCallId: input.toolCallId, content: `Search failed: ${err instanceof Error ? err.message : String(err)}`, success: false };
		}
	};
}

// ---- ripgrep invocation (async spawn, cancellable) -------------------------

function buildRgArgs(
	query: string,
	opts: { isRegExp: boolean; maxResults: number; includePattern?: string; includeIgnoredFiles: boolean },
): string[] {
	const args: string[] = [
		'--line-number',
		'--color=never',
		'--no-heading',
		'--max-count=50',
	];

	if (!opts.isRegExp) {
		args.push('--fixed-strings');
	}

	if (opts.includeIgnoredFiles) {
		args.push('--no-ignore');
	}

	if (opts.includePattern) {
		args.push('--glob-case-insensitive', '--glob', opts.includePattern);
	}

	args.push('--', query);
	return args;
}

async function searchWithRg(
	rgPath: string,
	args: string[],
	maxResults: number,
	cwd: string,
	token: { isCancellationRequested?: boolean; onCancellationRequested?: (callback: () => void) => { dispose: () => void } } | undefined,
	logService: ILogService,
): Promise<string[]> {
	return new Promise<string[]>((resolve, reject) => {
		const lines: string[] = [];
		let limitHit = false;
		let settled = false;

		let child: cp.ChildProcessWithoutNullStreams;
		try {
			child = cp.spawn(rgPath, args, { cwd });
		} catch (err) {
			reject(err);
			return;
		}

		const finish = (result: string[]) => {
			if (settled) { return; }
			settled = true;
			try { if (!child.killed) { child.kill(); } } catch { /* ignore */ }
			resolve(result);
		};

		// Timeout guard (20s matching Copilot)
		const timeoutHandle = setTimeout(() => {
			logService.trace(`[GrepSearchTool] rg timed out after ${SearchTimeoutMs}ms`);
			finish(lines);
		}, SearchTimeoutMs);

		// Cancellation listener
		let cancelDispose: { dispose: () => void } | undefined;
		if (token?.onCancellationRequested) {
			cancelDispose = token.onCancellationRequested(() => {
				logService.trace(`[GrepSearchTool] rg cancelled`);
				finish(lines);
			});
		}

		logService.info(`[GrepSearchTool] step=rg_running: pid=${child.pid}, args=${JSON.stringify(args)}`);

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (limitHit) { return; }
			const newLines = chunk.split('\n');
			for (const line of newLines) {
				const trimmed = line.replace(/\r$/, '');
				if (!trimmed) { continue; }
				lines.push(trimmed);
				if (lines.length >= maxResults) {
					limitHit = true;
					logService.trace(`[GrepSearchTool] rg hit maxResults=${maxResults}, killing`);
					try { child.kill(); } catch { /* ignore */ }
					break;
				}
			}
		});

		let stderr = '';
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});

		child.on('error', err => {
			logService.error(`[GrepSearchTool] rg error: ${err}`);
			clearTimeout(timeoutHandle);
			cancelDispose?.dispose();
			reject(err);
		});

		child.on('close', (code) => {
			clearTimeout(timeoutHandle);
			cancelDispose?.dispose();
			logService.trace(`[GrepSearchTool] rg exited: code=${code}, lines=${lines.length}, stderr=${stderr ? stderr.substring(0, 200) : 'none'}`);
			if (stderr && lines.length === 0) {
				logService.warn(`[GrepSearchTool] rg stderr: ${stderr} (exit code ${code})`);
			}
			finish(lines);
		});
	});
}

// ---- helpers ----------------------------------------------------------------

function isValidRegex(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}
