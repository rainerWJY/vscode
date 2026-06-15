/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Creates a new file or overwrites an existing one.
 *
 * Aligned with Copilot's `create_file` tool — `content` is optional;
 * if omitted, the model may generate content through the prompt.
 */
export const TOOL_CREATE_FILE = defineTool({
	name: ToolName.CreateFile,
	description:
		'Create a new file or overwrite an existing one. Provide the full intended content of the file. This tool will overwrite the existing file if there is one at the provided path.',
	parameters: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'The absolute path to the file to create or overwrite.' },
			content: { type: 'string', description: 'The full content to write to the file. If omitted, the model may generate the content through other means.' },
		},
		required: ['filePath'],
	},
	isDestructive: true,
	toolKind: 'edit',
});
