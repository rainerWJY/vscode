/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * List the contents of a directory.
 *
 * Returns names of children — those ending in "/" are folders.
 * Aligned with Copilot's `list_dir` tool.
 */
export const TOOL_LIST_DIR = defineTool({
	name: ToolName.ListDirectory,
	description:
		'List the contents of a directory. Returns names of children — those ending in "/" are folders.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'The absolute path to the directory to list.' },
		},
		required: ['path'],
	},
	isDestructive: false,
	toolKind: 'read',
});
