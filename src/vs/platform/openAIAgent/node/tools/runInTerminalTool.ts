/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Execute a command in the terminal.
 *
 * Renamed from `bash` to `run_in_terminal` to align with Copilot's naming.
 * Models trained on Copilot data expect `run_in_terminal` for shell execution.
 * Includes `description` and `timeout` parameters like Copilot.
 */
export const TOOL_RUN_IN_TERMINAL = defineTool({
	name: ToolName.RunInTerminal,
	description:
		'Execute a command in the terminal. Long-running commands will time out. Avoid commands that require user interaction.',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The command to execute.' },
			description: { type: 'string', description: 'A brief description of what the command does.' },
			timeout: { type: 'number', description: 'Optional timeout in milliseconds.' },
		},
		required: ['command'],
	},
	isDestructive: true,
	toolKind: 'shell',
});
