/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
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
