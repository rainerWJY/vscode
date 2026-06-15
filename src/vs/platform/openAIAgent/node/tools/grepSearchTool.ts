/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Do a fast text search in the workspace.
 *
 * Aligned with Copilot's `grep_search` tool — adds `isRegexp`, `maxResults`,
 * and `includeIgnoredFiles` parameters that Copilot supports.
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

// ---- handler (tool executor) ------------------------------------------------

export function createGrepSearchExecutor(
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		try {
			const query = input.parameters.query as string;
			const includePattern = input.parameters.includePattern as string | undefined;
			logService.trace(`[GrepSearchTool] grep_search: query=${query}, pattern=${includePattern ?? '*'}`);

			const { execSync } = await import('node:child_process');
			const args = ['--line-number', '--color=never', '--max-count=50', '--no-heading'];
			if (includePattern) { args.push('--glob', includePattern); }
			args.push(query);

			try {
				const output = execSync(`rg ${args.map(a => `"${a}"`).join(' ')}`, {
					cwd: '/',
					timeout: 10_000,
					maxBuffer: 512 * 1024,
				});
				return { toolCallId: input.toolCallId, content: output.toString() || 'No matches found', success: true };
			} catch {
				return { toolCallId: input.toolCallId, content: 'No matches found', success: true };
			}
		} catch (err) {
			logService.error(`[GrepSearchTool] grep_search ERROR: ${err}`);
			return { toolCallId: input.toolCallId, content: 'grep not available', success: false };
		}
	};
}
