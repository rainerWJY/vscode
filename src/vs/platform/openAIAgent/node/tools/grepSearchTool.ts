/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'node:child_process';
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
 * - 15+10 second cascading timeout (regex attempt, then literal fallback)
 * - Regex→literal fallback when regex yields no results (matching Copilot)
 * - MaxResults cap at 200 (matching Copilot)
 * - Cancellation checks before/after I/O
 * - Uses execSync instead of cp.spawn to avoid Node.js v24 async spawn + cwd hangs
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

/** Timeout for ripgrep search: 15s (reduced from 20s; literal fallback gets its own shorter timeout).
 *  Uses execSync instead of cp.spawn to avoid Node.js v24 async spawn + cwd hangs. */
const SearchTimeoutMs = 15_000;

/** Timeout for literal-only retry: 10s (fixed-strings search is usually faster). */
const SearchLiteralTimeoutMs = 10_000;

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

			logService.info(`[GrepSearchTool] step=rg_execSync: rgPath=${rgPath}, cwd=${rgCwd}, args=${JSON.stringify(baseArgs)}`);

			// First attempt with the requested mode
			let results = await searchWithRg(rgPath, baseArgs, maxResults, rgCwd, token, logService);

			// Copilot-minfo(`[GrepSearchTool] step=rg_retry_literal: 0 regex hits, retrying as is a valid regex, retry literal
			if (!results.length && isRegExp && queryIsValidRegex) {
				const literalTimeout = Date.now() - startTime;
				logService.info(`[GrepSearchTool] No regex results after ${literalTimeout}ms, retrying with literal search (timeout=${SearchLiteralTimeoutMs}ms)`);
				const literalArgs = buildRgArgs(query, { isRegExp: false, maxResults, includePattern, includeIgnoredFiles });
				results = await searchWithRgLiteral(rgPath, literalArgs, maxResults, rgCwd, token, logService);
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

/**
 * Build ripgrep CLI arguments from search parameters.
 * @internal - exported for testing only.
 */
export function buildRgArgs(
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

/**
 * Shared helper: run ripgrep via execSync with the given timeout.
 *
 * Returns the matching lines (up to maxResults), or empty array on timeout / no matches. */
async function searchWithRgTimeout(
	rgPath: string,
	args: string[],
	maxResults: number,
	cwd: string,
	timeoutMs: number,
	token: { isCancellationRequested?: boolean } | undefined,
	logService: ILogService,
): Promise<string[]> {
	if (token?.isCancellationRequested) {
		logService.trace(`[GrepSearchTool] rg cancelled before execSync`);
		return [];
	}

	const cmd = `"${rgPath}" ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
	const startTime = Date.now();
	try {
		const stdout = execSync(cmd, {
			cwd,
			encoding: 'utf-8',
			timeout: timeoutMs,
			shell: process.env.SHELL || '/bin/sh',
			maxBuffer: 1024 * 1024,
		}) as string;

		const elapsed = Date.now() - startTime;
		const lines = stdout.split('\n')
			.map(l => l.replace(/\r$/, ''))
			.filter(Boolean);

		const capped = lines.slice(0, maxResults);
		logService.trace(`[GrepSearchTool] rg completed in ${elapsed}ms: lines=${capped.length}`);
		return capped;
	} catch (err: any) {
		const elapsed = Date.now() - startTime;

		if (err.status === 1) {
			logService.trace(`[GrepSearchTool] rg done (no matches) in ${elapsed}ms`);
			return [];
		}

		if (err.killed || err.signal === 'SIGTERM') {
			const partial = (err.stdout as string) || '';
			const lines = partial ? partial.split('\n').filter(Boolean) : [];
			logService.info(`[GrepSearchTool] rg timed out after ${elapsed}ms: ${lines.length} partial results`);
			return lines.slice(0, maxResults);
		}

		logService.warn(`[GrepSearchTool] rg error: ${err.message.substring(0, 200)}`);
		return [];
	}
}

/**
 * Run ripgrep with default timeout (15s).
 * Calls {@link searchWithRgTimeout} with the default SearchTimeoutMs.
 */
async function searchWithRg(
	rgPath: string,
	args: string[],
	maxResults: number,
	cwd: string,
	token: { isCancellationRequested?: boolean } | undefined,
	logService: ILogService,
): Promise<string[]> {
	return searchWithRgTimeout(rgPath, args, maxResults, cwd, SearchTimeoutMs, token, logService);
}

/**
 * Run ripgrep with literal-fallback timeout (10s).
 * Called on retry when regex mode produced no results.
 */
async function searchWithRgLiteral(
	rgPath: string,
	args: string[],
	maxResults: number,
	cwd: string,
	token: { isCancellationRequested?: boolean } | undefined,
	logService: ILogService,
): Promise<string[]> {
	return searchWithRgTimeout(rgPath, args, maxResults, cwd, SearchLiteralTimeoutMs, token, logService);
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
