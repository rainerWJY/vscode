/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * A handle that the parent (OpenAIAgent) implements so the tool can spawn
 * a fully isolated sub-agent session (same tool set, separate loop, own model).
 */
export interface ISubagentRunner {
	(prompt: string, description: string, model: string | undefined, agentName: string | undefined, toolCallId: string): Promise<string>;
}

/**
 * Launch a new agent to handle complex, multi-step tasks autonomously.
 *
 * Mirrors Copilot's `runSubagent` built-in tool. The subagent gets its own
 * tool-calling loop and can use the full tool set. Results are returned as
 * a single text message.
 *
 * Supports `agentName` to invoke a named agent with its own tool whitelist,
 * instructions, and model (from the Agent Host's agent registry).
 */
export const TOOL_RUN_SUBAGENT = defineTool({
	name: ToolName.CoreRunSubagent,
	description:
		'Launch a new agent to handle complex, multi-step tasks autonomously. ' +
		'This tool is good at researching complex questions, searching for code, and executing multi-step tasks. ' +
		'When you are searching for a keyword or file and are not confident that you will find the right match ' +
		'in the first few tries, use this agent to perform the search for you.' +
		'\n\n' +
		'- Agents do not run async or in the background; you will wait for the agent\'s result.\n' +
		'- When the agent is done, it will return a single message back to you.\n' +
		'- Each agent invocation is stateless. You will not be able to send additional messages to the agent,\n' +
		'  nor will the agent be able to communicate with you outside of its final report.\n' +
		'  Therefore, your prompt should contain a highly detailed task description and you should specify\n' +
		'  exactly what information the agent should return back to you.\n' +
		'- The agent\'s outputs should generally be trusted.\n' +
		'- Clearly tell the agent whether you expect it to write code or just to do research.\n' +
		'- If the user asks for a certain agent, you MUST provide that EXACT agent name (case-sensitive) to invoke that specific agent.',
	parameters: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description:
					'A detailed description of the task for the agent to perform. ' +
					'Include specifics about what to search for, what to return, and any constraints.',
			},
			description: {
				type: 'string',
				description: 'A short (3-5 word) description of the task, shown to the user.',
			},
			model: {
				type: 'string',
				description:
					'Optional model for the subagent. Format: "Model Name (Vendor)", vendor is usually "copilot". ' +
					'Only use to enforce a specific model.',
			},
			agentName: {
				type: 'string',
				description:
					'Optional name of a specific agent to invoke. ' +
					'If not provided, uses the current agent with all tools available.',
			},
		},
		required: ['prompt', 'description'],
	},
	isDestructive: false,
	toolKind: 'other',
});

// ---- handler (tool executor) ------------------------------------------------

export function createRunSubagentExecutor(
	logService: ILogService,
	runner: ISubagentRunner,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const params = input.parameters as { prompt: string; description: string; model?: string; agentName?: string };
		const startTime = Date.now();

		logService.info(
			`[RunSubagentTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, ` +
			`agentName="${params.agentName ?? '(default)'}", description="${params.description}", promptLen=${params.prompt?.length ?? 0}`
		);

		if (!params.prompt) {
			return {
				toolCallId: input.toolCallId,
				content: 'Error: `prompt` parameter is required.',
				success: false,
			};
		}

		try {
			const result = await runner(params.prompt, params.description, params.model, params.agentName, input.toolCallId);
			const elapsed = Date.now() - startTime;
			logService.info(`[RunSubagentTool] >>> done in ${elapsed}ms: resultLen=${result.length}`);
			return {
				toolCallId: input.toolCallId,
				content: result,
				success: true,
			};
		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[RunSubagentTool] FAILED after ${elapsed}ms: ${errMsg}`);
			return {
				toolCallId: input.toolCallId,
				content: `Error invoking subagent: ${errMsg}`,
				success: false,
			};
		}
	};
}
