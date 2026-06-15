/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
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

// ---- handler (tool executor) ------------------------------------------------

export function createTaskCompleteExecutor(
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		logService.info(`[TaskCompleteTool] task_complete: ${input.parameters.summary || 'Done'}`);
		return { toolCallId: input.toolCallId, content: `Task completed: ${input.parameters.summary || 'Done'}`, success: true };
	};
}
