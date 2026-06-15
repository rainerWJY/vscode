/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Search for files in the workspace by glob pattern.
 *
 * Renamed from `search` to `file_search` to align with Copilot's naming.
 * Also adds `maxResults` parameter for consistency with Copilot.
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

// ---- handler (tool executor) ------------------------------------------------

export function createFileSearchExecutor(
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		try {
			const query = input.parameters.query as string;
			logService.trace(`[FileSearchTool] file_search: query=${query}`);

			let patternSync: (pattern: string, opts: Record<string, unknown>) => string[];
			try {
				const globModule = await import('glob');
				patternSync = (pattern, opts) => globModule.sync(pattern, opts);
			} catch {
				logService.warn(`[FileSearchTool] glob import failed, search tool disabled`);
				return { toolCallId: input.toolCallId, content: 'File search not available (glob module missing)', success: false };
			}

			const files = patternSync(query, { cwd: '/' });
			const result = files.slice(0, 200).join('\n') || 'No files found';
			return { toolCallId: input.toolCallId, content: result, success: true };
		} catch (err) {
			logService.error(`[FileSearchTool] file_search ERROR: ${err}`);
			return { toolCallId: input.toolCallId, content: `Error searching: ${err}`, success: false };
		}
	};
}
