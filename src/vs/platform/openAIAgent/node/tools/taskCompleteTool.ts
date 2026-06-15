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
 * Aligned with Copilot's `task_complete` tool:
 * - `summary` is optional
 * - The executor returns the summary as result content
 * - The session loop breaks after this tool is called (no wasted rounds)
 */
export const TOOL_TASK_COMPLETE = defineTool({
	name: ToolName.TaskComplete,
	description:
		"Signal that the user's task is fully done. You MUST call this tool when your work is complete — " +
		'whether you made code changes, answered a question, or completed any other kind of task. ' +
		'Provide a brief summary of what was accomplished. ' +
		'Do not restate the summary in your message text — it is shown to the user directly.\n\n' +
		'IMPORTANT: Before calling this tool, you MUST output a brief text message summarizing what was done. ' +
		'The task is not complete until both your summary message AND this tool call are present.\n\n' +
		'When to call:\n' +
		"- After answering the user's question or completing a conversational request\n" +
		'- After you have completed ALL requested changes\n' +
		'- After verifying results: terminal commands succeeded, tool calls returned expected output\n\n' +
		'When NOT to call:\n' +
		'- If a terminal command failed or produced unexpected output\n' +
		'- If an external tool call returned an error\n' +
		'- If you encountered errors you have not resolved\n' +
		'- If there are remaining steps to complete\n' +
		'- If you have not verified your changes work',
	parameters: {
		type: 'object',
		properties: {
			summary: {
				type: 'string',
				description: 'Brief summary of what was accomplished. Omit for trivial interactions.',
			},
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
		const params = input.parameters as { summary?: string };
		const summary = params?.summary ?? 'All done!';
		logService.info(`[TaskCompleteTool] task_complete: ${summary}`);
		return {
			toolCallId: input.toolCallId,
			content: summary,
			success: true,
		};
	};
}
