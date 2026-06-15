/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
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
