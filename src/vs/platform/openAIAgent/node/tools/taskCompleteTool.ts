/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Signal that the task is fully complete.
 *
 * Aligned with Copilot's `task_complete` tool — `summary` is optional.
 */
export const TOOL_TASK_COMPLETE = defineTool({
	name: ToolName.TaskComplete,
	description:
		'Signal that the task is fully complete. Call this when you have finished all work — whether it involved code changes, answering a question, or any other interaction.',
	parameters: {
		type: 'object',
		properties: {
			summary: { type: 'string', description: 'Optional: a brief summary of what was accomplished.' },
		},
		required: [],
	},
	isDestructive: false,
	toolKind: 'task',
});
