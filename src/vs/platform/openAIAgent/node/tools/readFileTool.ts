/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Read the contents of a file.
 *
 * Parameters align with Copilot's `read_file` tool:
 * - `offset` (1-based line number) instead of `startLine`
 * - `limit` (max lines) instead of `endLine`
 * - Binary files use offset/limit as byte offsets.
 */
export const TOOL_READ_FILE = defineTool({
	name: ToolName.ReadFile,
	description:
		'Read the contents of a file. You can specify an offset and limit (especially handy for long files), but it\'s recommended to read the whole file by not providing these parameters.',
	parameters: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: 'The absolute path of the file to read.',
			},
			offset: {
				type: 'number',
				description:
					'Optional: the 1-based line number to start reading from. Only use this if the file is too large to read at once. If not specified, the file will be read from the beginning.',
			},
			limit: {
				type: 'number',
				description:
					'Optional: the maximum number of lines to read. Only use this together with `offset` if the file is too large to read at once.',
			},
		},
		required: ['filePath'],
	},
	isDestructive: false,
	toolKind: 'read',
});
