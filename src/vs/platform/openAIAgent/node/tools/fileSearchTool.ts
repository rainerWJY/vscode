/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as path from 'path';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { AgentHostWorkingDirectory } from '../services/agentHostWorkingDirectory.js';
import type { IAgentHostIgnoreService } from '../services/agentHostIgnoreService.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';

/**
 * Search for files in the workspace by glob pattern.
 *
 * Fully aligned with Copilot's `FindFilesTool` (`extensions/copilot/src/extension/tools/node/findFilesTool.tsx`).
 * Uses ripgrep (`rg --files --glob`) for fast, async file discovery — the agent
 * host is a standalone Node.js process that cannot access `vscode.workspace.findFiles()`.
 *
 * Key alignment features:
 * - Input validation (rejects unsupported `path` property)
 * - `inputGlobToPattern()` — full pattern normalization matching Copilot
 * - `RelativePattern` support for working-directory-scoped searches
 * - `.gitignore` / `.copilotignore` filtering via `IAgentHostIgnoreService`
 * - Multi-root folder name prefix detection (e.g. `folderName/src/**`)
 * - gpt-4.1 model-specific second pattern (`/**` workaround)
 * - `raceTimeoutAndCancellationError` — throw on timeout, not silent empty
 * - 20-second timeout (matching Copilot)
 * - maxResults default 20 / cap 200 (matching Copilot)
 * - Fully async — ripgrep runs as a child process, non-blocking
 * - Comprehensive logging
 */
export const TOOL_FILE_SEARCH = defineTool({
	name: ToolName.FindFiles,
	description:
		'Search for files in the workspace by glob pattern. Use **/*.{js,ts} to match all js/ts files, src/** to match all files under src, or a specific file name like "main.ts" to find a file.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Glob pattern or file name to search for.' },
			maxResults: { type: 'number', description: 'Maximum number of results to return.' },
		},
		required: ['query'],
	},
	isDestructive: false,
	toolKind: 'search',
});

/** File search timeout: 20s (matching Copilot). */
const SearchTimeoutMs = 20_000;

/** Default maxResults (matching Copilot's non-FullContext mode). */
const DefaultMaxResults = 20;

/** Hard cap on results (matching Copilot's MaxResultsCap). */
const MaxResultsCap = 200;

// ---- types (aligned with Copilot's RelativePattern / GlobPattern) -----------

/**
 * A glob pattern that is scoped to a base URI.
 * Equivalent to `vscode.RelativePattern` and Copilot's `RelativePattern` in
 * `extensions/copilot/src/platform/filesystem/common/fileTypes.ts`.
 */
/**
 * A glob pattern that is scoped to a base URI.
 * Equivalent to `vscode.RelativePattern` and Copilot's `RelativePattern` in
 * `extensions/copilot/src/platform/filesystem/common/fileTypes.ts`.
 * @internal - exported for testing only.
 */
export class RelativePattern {
	constructor(
		public readonly baseUri: URI,
		public readonly pattern: string,
	) { }
}

/** A glob pattern: either a plain string or a `RelativePattern`. */
export type GlobPattern = string | RelativePattern;

/**
 * Result of {@link inputGlobToPattern}.
 * Aligned with Copilot's `InputGlobResult` in `toolUtils.ts`.
 * @internal - exported for testing only.
 */
export interface InputGlobResult {
	/** The resolved glob patterns to pass to the search. */
	readonly patterns: GlobPattern[];
	/** The workspace folder name if the pattern was scoped to a specific folder, for display. */
	readonly folderName: string | undefined;
	/** The glob pattern within the folder (e.g. `src/**`), for display. Only set when folderName is set. */
	readonly folderRelativePattern: string | undefined;
}

// ---- pattern normalization (aligned with Copilot's `inputGlobToPattern`) ----

/**
 * Converts a user input glob or file path into glob patterns.
 * Handles:
 * - Absolute paths within a working directory
 * - Patterns prefixed with a workspace folder name in multi-folder setups
 * - Working directory scoping (agents window)
 * - gpt-4.1 model-specific second pattern (`/**` workaround)
 *
 * Aligned with Copilot's `inputGlobToPattern()` in `toolUtils.ts`.
 */
/**
 * @internal - exported for testing only.
 */
export function inputGlobToPattern(
	query: string,
	workingDir: AgentHostWorkingDirectory | undefined,
	modelFamily?: string,
): InputGlobResult {
	let pattern: GlobPattern = query;
	let folderName: string | undefined;
	let folderRelativePattern: string | undefined;

	// ---- Handle absolute paths within working directory ----
	if (path.isAbsolute(query)) {
		try {
			const uri = URI.file(query);
			if (workingDir) {
				const folder = workingDir.getFolder(uri);
				if (folder) {
					const rel = extUriBiasedIgnorePathCase.relativePath(folder, uri) || '';
					pattern = new RelativePattern(folder, rel);
					folderName = workingDir.getFolderName();
					folderRelativePattern = rel;
				}
			}
		} catch (e) {
			// ignore invalid URIs — fall through to string pattern
		}
	}

	// ---- Multi-root folder name prefix detection ----
	// In multi-root workspaces (and only when no explicit workingDirectory),
	// detect patterns like "folderName/src/**" or "**/folderName/src/**" and
	// rewrite to a RelativePattern.
	if (typeof pattern === 'string' && workingDir && !workingDir.hasExplicitWorkingDirectory) {
		let raw = pattern;
		if (raw.startsWith('**/')) {
			raw = raw.slice(3);
		}

		const slashIndex = raw.indexOf('/');
		const candidateName = slashIndex >= 0 ? raw.slice(0, slashIndex) : raw;
		if (candidateName && !candidateName.includes('*')) {
			// Try matching against working directory folder name
			if (candidateName === workingDir.getFolderName()) {
				const remainder = slashIndex >= 0 ? raw.slice(slashIndex + 1) : '**';
				const resolvedRemainder = remainder || '**';
				pattern = new RelativePattern(URI.file(workingDir.fsPath ?? ''), resolvedRemainder);
				folderName = candidateName;
				folderRelativePattern = resolvedRemainder;
			}
		}
	}

	// ---- Working directory scoping (agents window) ----
	// When a working directory is set and the pattern is still unscoped,
	// scope it to the session's working directory.
	if (typeof pattern === 'string' && workingDir?.hasExplicitWorkingDirectory) {
		pattern = new RelativePattern(URI.file(workingDir.fsPath ?? ''), pattern);
	}

	// ---- Build patterns array ----
	const patterns: GlobPattern[] = [pattern];

	// ---- gpt-4.1 workaround ----
	// gpt-4.1 struggles to append /** to the pattern itself, so add a second
	// pattern with /** appended. Other models don't need this workaround.
	if (modelFamily === 'gpt-4.1') {
		if (typeof pattern === 'string' && !pattern.endsWith('/**')) {
			patterns.push(pattern + '/**');
		} else if (typeof pattern !== 'string' && !pattern.pattern.endsWith('/**')) {
			patterns.push(new RelativePattern(pattern.baseUri, pattern.pattern + '/**'));
		}
	}

	return { patterns, folderName, folderRelativePattern };
}

/**
 * Format a query label for display in tool result messages.
 * Matches Copilot's `formatQueryLabel()` in `findFilesTool.tsx`.
 *
 * When scoped to a folder, shows `folderName · pattern` instead of the raw query.
 */
/**
 * @internal - exported for testing only.
 */
export function formatQueryLabel(globResult: InputGlobResult, rawQuery: string): string {
	if (globResult.folderName) {
		if (globResult.folderRelativePattern && globResult.folderRelativePattern !== '**') {
			return `\`${globResult.folderName}\` · \`${globResult.folderRelativePattern}\``;
		}
		return `\`${globResult.folderName}\``;
	}
	return `\`${rawQuery}\``;
}

// ---- handler (tool executor) ------------------------------------------------

export function createFileSearchExecutor(
	logService: ILogService,
	/** Optional working directory to scope the search to a specific folder. */
	workingDirectory?: AgentHostWorkingDirectory,
	/** Ignore service for .gitignore / search.exclude filtering. */
	ignoreService?: IAgentHostIgnoreService,
	/** Model family for model-specific pattern adjustments (e.g. gpt-4.1). */
	modelFamily?: string,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.trace(`[FileSearchTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, workingDir=${workingDirectory?.fsPath ?? 'none'}`);

		try {
			const token = input.cancellationToken;

			// Copilot-matching: check cancellation before any work
			if (token?.isCancellationRequested) {
				logService.warn(`[FileSearchTool] CANCELLED before any work`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const params = input.parameters;

			// Input validation: Copilot rejects "path" property
			if ((params as Record<string, unknown>).path) {
				logService.warn(`[FileSearchTool] input validation failed: 'path' property not supported`);
				return {
					toolCallId: input.toolCallId,
					content: 'The property "path" is not supported. Use "query" instead.',
					success: false,
				};
			}

			const query = params.query as string;
			if (!query || typeof query !== 'string') {
				logService.warn(`[FileSearchTool] input validation failed: missing or invalid 'query'`);
				return { toolCallId: input.toolCallId, content: 'A "query" string parameter is required.', success: false };
			}

			logService.info(`[FileSearchTool] step=validate: query="${query}", wd=${workingDirectory?.fsPath ?? 'none'}`);

			// Copilot-matching: check cancellation before pattern processing
			if (token?.isCancellationRequested) {
				logService.warn(`[FileSearchTool] CANCELLED after validation`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Pattern normalization (matching Copilot's inputGlobToPattern) ----
			const globResult = inputGlobToPattern(query, workingDirectory, modelFamily);
			logService.trace(`[FileSearchTool] step=normalize: ${globResult.patterns.length} pattern(s), folder="${globResult.folderName ?? 'none'}"${globResult.folderRelativePattern ? `, rel="${globResult.folderRelativePattern}"` : ''}`);

			// Extract to typed variable so typeof guard narrows correctly
			const rawMaxResults = params.maxResults as number | undefined;
			const maxResults = typeof rawMaxResults === 'number'
				? Math.min(Math.max(1, rawMaxResults), MaxResultsCap)
				: DefaultMaxResults;

			logService.trace(`[FileSearchTool] step=glob: maxResults=${maxResults}`);

			// Run ripgrep with timeout and cancellation
			const files = await rgFindFiles(globResult.patterns, maxResults, token, ignoreService, logService);

			// Copilot-matching: check cancellation after I/O
			if (token?.isCancellationRequested) {
				logService.warn(`[FileSearchTool] CANCELLED after glob`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const elapsed = Date.now() - startTime;
			const resultsToShow = files.slice(0, maxResults);
			const queryLabel = formatQueryLabel(globResult, query);

			let content: string;
			if (resultsToShow.length === 0) {
				content = `No files found matching ${queryLabel}`;
				logService.info(`[FileSearchTool] done (${elapsed}ms): 0 matches`);
			} else if (resultsToShow.length === 1) {
				content = `Searched for files matching ${queryLabel}, 1 match\n${resultsToShow[0]}`;
				logService.info(`[FileSearchTool] done (${elapsed}ms): 1 match`);
			} else {
				const totalFiles = files.length;
				const summary = totalFiles > maxResults
					? `${maxResults} of ${totalFiles} matches (truncated)`
					: `${totalFiles} matches`;
				content = `Searched for files matching ${queryLabel}, ${summary}\n${resultsToShow.join('\n')}`;
				if (totalFiles > maxResults) {
					content += '\n...';
				}
				logService.info(`[FileSearchTool] done (${elapsed}ms): ${totalFiles} total, showing ${maxResults}`);
			}

			return { toolCallId: input.toolCallId, content, success: true };
		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[FileSearchTool] ERROR (${elapsed}ms): ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error searching files: ${errMsg}`, success: false };
		}
	};
}

/**
 * Races a promise against cancellation and timeout.
 *
 * Aligned with Copilot's `raceTimeoutAndCancellationError()` in
 * `extensions/copilot/src/util/common/racePromise.ts`.
 *
 * - On cancellation: throws `CancellationError`
 * - On timeout: throws `Error` with a descriptive message
 * - On success: returns the result
 */
async function raceTimeoutAndCancellationError<T>(
	promiseGenerator: (cancellationToken: CancellationToken) => Promise<T>,
	parentToken: CancellationToken | undefined,
	timeoutInMs: number,
	timeoutMessage: string,
): Promise<T> {
	const cancellationSource = new CancellationTokenSource(parentToken);
	try {
		const result = await raceTimeout(
			promiseGenerator(cancellationSource.token),
			timeoutInMs,
		);

		if (result === undefined) {
			// Timeout sentinel from raceTimeout
			cancellationSource.cancel();
			throw new Error(timeoutMessage);
		}

		return result;
	} finally {
		cancellationSource.dispose();
	}
}

// sentinel value used internally by raceTimeout
const CANCELLED = Symbol('cancelled');

/**
 * Ripgrep-based file search equivalent of Copilot's `this.searchService.findFiles()`.
 *
 * Uses `rg --files --glob <pattern>` — ripgrep's built-in file listing mode with
 * glob filtering. This is:
 * - Fully async (non-blocking child process, matching Copilot's async search)
 * - Natively respects `.gitignore` (no custom filtering needed for standard ignores)
 * - Much faster than `glob.sync()` in large directories
 * - Already available via `@vscode/ripgrep-universal` (same binary VS Code uses)
 *
 * Additional `AgentHostIgnoreService` filtering catches `.copilotignore` patterns
 * and built-in excludes that ripgrep doesn't know about.
 */
async function rgFindFiles(
	patterns: GlobPattern[],
	maxResults: number,
	token: CancellationToken | undefined,
	ignoreService: IAgentHostIgnoreService | undefined,
	logService: ILogService,
): Promise<string[]> {
	// ---- Group patterns by their base directory ----
	// Patterns with the same CWD can be combined into a single ripgrep invocation.
	interface PatternGroup {
		cwd: string;
		globs: string[];
	}

	const groups = new Map<string, PatternGroup>();

	for (const p of patterns) {
		if (typeof p === 'string') {
			// String patterns are relative to root '/'. We'll set CWD to '/'
			// and pass the pattern directly as a --glob.
			const key = '/';
			let group = groups.get(key);
			if (!group) {
				group = { cwd: key, globs: [] };
				groups.set(key, group);
			}
			group.globs.push(p);
		} else {
			// RelativePattern: use baseUri as CWD, pass pattern as --glob
			const key = p.baseUri.fsPath;
			let group = groups.get(key);
			if (!group) {
				group = { cwd: key, globs: [] };
				groups.set(key, group);
			}
			group.globs.push(p.pattern);
		}
	}

	logService.trace(`[FileSearchTool] rg: ${groups.size} group(s): ${Array.from(groups.keys()).join(', ')}`);

	// ---- Run ripgrep with raceTimeoutAndCancellationError ----
	const matchedPaths = await raceTimeoutAndCancellationError(
		async (searchToken) => {
			const rgPath = await rgDiskPath();
			const allResults = new Map<string, string>();

			for (const [, group] of groups) {
				if (searchToken.isCancellationRequested) {
					break;
				}

				// Build ripgrep args: --files mode with --glob for each pattern
				const args: string[] = [
					'--files',
					'--hidden',
					'--no-require-git',
					'--follow',
					'--no-config',
					'--glob-case-insensitive',
					'--glob', '!.git',
				];

				for (const g of group.globs) {
					// ripgrep's --glob is relative to CWD, matching RelativePattern semantics
					args.push('--glob', g);
				}

				logService.trace(`[FileSearchTool] rg: cwd=${group.cwd}, args=${JSON.stringify(args)}`);

				// Spawn ripgrep and collect results via stdout stream
				const groupResults = await spawnRgFiles(
					rgPath, args, group.cwd, maxResults * 3, searchToken, logService,
				);

				for (const f of groupResults) {
					// rg --files returns relative paths from CWD; convert to absolute
					const absPath = path.resolve(group.cwd, f);
					allResults.set(absPath, absPath);
					if (allResults.size >= maxResults * 3) {
						break;
					}
				}

				if (allResults.size >= maxResults * 3) {
					break;
				}
			}

			if (searchToken.isCancellationRequested) {
				return CANCELLED as unknown as string[];
			}

			let results = Array.from(allResults.values());

			// ---- Filter through ignore service (.copilotignore / built-in excludes) ----
			// ripgrep already respects .gitignore natively. The ignore service adds
			// .copilotignore support and built-in excludes as a safety net.
			if (ignoreService) {
				const filtered: string[] = [];
				for (const filePath of results) {
					if (searchToken.isCancellationRequested) {
						return CANCELLED as unknown as string[];
					}
					try {
						const uri = URI.file(filePath);
						if (!(await ignoreService.isIgnored(uri))) {
							filtered.push(filePath);
						}
					} catch {
						// If ignore check fails, include the file
						filtered.push(filePath);
					}
					if (filtered.length >= maxResults) {
						break;
					}
				}
				logService.trace(`[FileSearchTool] ignore-filter: ${results.length} → ${filtered.length} (cap=${maxResults})`);
				results = filtered;
			}

			return results;
		},
		token,
		SearchTimeoutMs,
		'Timeout in searching files, try a more specific search pattern',
	);

	// Handle cancellation sentinel
	if (matchedPaths === (CANCELLED as unknown as string[])) {
		throw new CancellationError();
	}

	return matchedPaths;
}

/**
 * Spawn a single ripgrep `--files` process and collect result lines.
 *
 * Based on the pattern used in:
 * - `grepSearchTool.ts` — `searchWithRg()` for text search
 * - `agentHostWorkspaceFiles.ts` — `_enumerate()` for file enumeration
 *
 * Returns relative file paths (as output by `rg --files`).
 */
async function spawnRgFiles(
	rgPath: string,
	args: string[],
	cwd: string,
	maxLines: number,
	token: CancellationToken | undefined,
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

		// Cancellation listener (matching grepSearchTool.ts pattern)
		let cancelDispose: { dispose: () => void } | undefined;
		if (token?.onCancellationRequested) {
			cancelDispose = token.onCancellationRequested(() => {
				logService.trace(`[FileSearchTool] rg cancelled`);
				finish(lines);
			});
		}

		logService.trace(`[FileSearchTool] rg spawned: pid=${child.pid}, cwd=${cwd}, args=${JSON.stringify(args)}`);

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (limitHit) { return; }
			const newLines = chunk.split('\n');
			for (const line of newLines) {
				const trimmed = line.replace(/\r$/, '');
				if (!trimmed) { continue; }
				lines.push(trimmed);
				if (lines.length >= maxLines) {
					limitHit = true;
					logService.trace(`[FileSearchTool] rg hit maxLines=${maxLines}, killing`);
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
			logService.error(`[FileSearchTool] rg error: ${err}`);
			cancelDispose?.dispose();
			reject(err);
		});

		child.on('close', (code) => {
			cancelDispose?.dispose();
			logService.trace(`[FileSearchTool] rg exited: code=${code}, lines=${lines.length}, stderr=${stderr ? stderr.substring(0, 200) : 'none'}`);
			if (stderr && lines.length === 0) {
				logService.warn(`[FileSearchTool] rg stderr: ${stderr} (exit code ${code})`);
			}
			finish(lines);
		});
	});
}
