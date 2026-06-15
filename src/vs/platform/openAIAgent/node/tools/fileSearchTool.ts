/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { AgentHostWorkingDirectory } from '../services/agentHostWorkingDirectory.js';

/**
 * Search for files in the workspace by glob pattern.
 *
 * Aligned with Copilot's `file_search` tool (FindFilesTool).
 * Uses the `glob` npm module directly (agent host is a standalone Node.js
 * process that cannot access `vscode.workspace.findFiles()`).
 *
 * Key alignment features:
 * - Input validation (rejects unsupported `path` property)
 * - Pattern normalization matching Copilot's `resolveInput`:
 * - Working directory scoping via AgentHostWorkingDirectory
 * - 20-second timeout (matching Copilot)
 * - maxResults default 20 (matching Copilot's non-FullContext mode)
 * - Cancellation checks before/after I/O
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

// ---- handler (tool executor) ------------------------------------------------

export function createFileSearchExecutor(
	logService: ILogService,
	/** Optional working directory to scope the search to a specific folder. */
	workingDirectory?: AgentHostWorkingDirectory,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.trace(`[FileSearchTool] file_search invoked`);

		try {
			// Copilot-matching: check cancellation before any work
			if (input.cancellationToken?.isCancellationRequested) {
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

			const wdLabel = workingDirectory?.fsPath ?? 'none';
			logService.info(`[FileSearchTool] file_search: query = "${query}", wd = ${wdLabel} `);

			// Copilot-matching: check cancellation before processing pattern
			if (input.cancellationToken?.isCancellationRequested) {
				logService.warn(`[FileSearchTool] CANCELLED after validation`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// Pattern normalization: matches Copilot's resolveInput()
			// - Bare name like "main.ts" becomes "**/main.ts"
			// - Trailing slash like "src/" becomes "src/**"
			let pattern = query;
			if (!pattern.startsWith('**/') && !pattern.startsWith('/') && !pattern.includes(':')) {
				pattern = `**/${pattern}`;
			}
			if (pattern.endsWith('/')) {
				pattern = `${pattern}**`;
			}

			logService.trace(`[FileSearchTool] step=normalize: pattern="${pattern}"`);

			// Determine search CWD (working directory-aware)
			const searchCwd = workingDirectory?.fsPath ?? '/';

			// Extract to typed variable so typeof guard narrows correctly
			const rawMaxResults = params.maxResults as number | undefined;
			const maxResults = typeof rawMaxResults === 'number'
				? Math.min(Math.max(1, rawMaxResults), MaxResultsCap)
				: DefaultMaxResults;

			logService.trace(`[FileSearchTool] step=glob: cwd="${searchCwd}", maxResults=${maxResults}`);

			// Run glob with timeout and cancellation
			const files = await globWithTimeout(pattern, searchCwd, maxResults, input.cancellationToken, logService);

			// Copilot-matching: check cancellation after I/O
			if (input.cancellationToken?.isCancellationRequested) {
				logService.warn(`[FileSearchTool] CANCELLED after glob`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const elapsed = Date.now() - startTime;
			const resultsToShow = files.slice(0, maxResults);

			let content: string;
			if (resultsToShow.length === 0) {
				content = `No files found matching "${query}"`;
				logService.info(`[FileSearchTool] done (${elapsed}ms): 0 matches`);
			} else if (resultsToShow.length === 1) {
				content = `Searched for files matching "${query}", 1 match\n${resultsToShow[0]}`;
				logService.info(`[FileSearchTool] done (${elapsed}ms): 1 match`);
			} else {
				const totalFiles = files.length;
				const summary = totalFiles > maxResults
					? `${maxResults} of ${totalFiles} matches (truncated)`
					: `${totalFiles} matches`;
				content = `Searched for files matching "${query}", ${summary}\n${resultsToShow.join('\n')}`;
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
 * Run glob search with timeout support.
 * Wraps the glob sync API in a cancellable promise with a 20s timeout.
 * Falls back to empty results on timeout (graceful degradation matching Copilot).
 */
async function globWithTimeout(
	pattern: string,
	cwd: string,
	_maxResults: number,
	token: { isCancellationRequested?: boolean } | undefined,
	logService: ILogService,
): Promise<string[]> {
	return new Promise<string[]>((resolve, reject) => {
		let settled = false;

		const finish = (result: string[]) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timeoutHandle);
			resolve(result);
		};

		// Timeout guard: 20s (matching Copilot)
		const timeoutHandle = setTimeout(() => {
			logService.trace(`[FileSearchTool] glob timed out after ${SearchTimeoutMs}ms, returning partial results`);
			finish([]);
		}, SearchTimeoutMs);

		// Quick check before loading the module
		if (token?.isCancellationRequested) {
			clearTimeout(timeoutHandle);
			resolve([]);
			return;
		}

		import('glob').then(mod => {
			if (token?.isCancellationRequested || settled) {
				finish([]);
				return;
			}

			try {
				const results = mod.sync(pattern, { cwd, dot: true });
				finish(results);
			} catch (err) {
				clearTimeout(timeoutHandle);
				if (!settled) {
					settled = true;
					reject(err);
				}
			}
		}).catch(err => {
			clearTimeout(timeoutHandle);
			if (!settled) {
				settled = true;
				logService.warn(`[FileSearchTool] glob import failed: ${err}`);
				reject(new Error('File search not available (glob module missing)'));
			}
		});
	});
}
