/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { TerminalManager } from '../services/agentHostTerminalManager.js';

/**
 * Kill a background terminal process by its ID.
 *
 * Aligned with Copilot's `KillTerminalTool`. Used to terminate a
 * background process spawned via `run_in_terminal` with `mode=async`.
 */
export const TOOL_KILL_TERMINAL = defineTool({
	name: ToolName.KillTerminal,
	description:
		'Kill a terminal process by its ID. Use this to stop a background process that is hung, taking too long, ' +
		'or no longer needed. The process ID is returned by `run_in_terminal` when using async mode. ' +
		'Only call this if the command is genuinely hung and you need to retry with a different approach.',
	parameters: {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				description: `The ID of the terminal execution to kill (returned by ${ToolName.RunInTerminal} as the terminal ID).`,
				pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
			},
		},
		required: ['id'],
	},
	isDestructive: true,
	toolKind: 'shell',
});

// ---- handler (tool executor) ------------------------------------------------

/**
 * Create a `kill_terminal` tool executor.
 *
 * Kills a background process by termId. Returns the last known output
 * before termination.
 */
export function createKillTerminalExecutor(
	logService: ILogService,
	terminalManager: TerminalManager,
	sessionUri: string,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		const termId = input.parameters.id as string;
		logService.info(`[KillTerminalTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, termId=${termId ? termId.substring(0, 8) : '(missing)'}`);

		// ---- step=validate ----
		if (!termId) {
			logService.warn(`[KillTerminalTool] step=validate FAILED: missing id`);
			return { toolCallId: input.toolCallId, content: 'A "id" parameter is required.', success: false };
		}
		logService.info(`[KillTerminalTool] step=validate: termId=${termId.substring(0, 8)}`);

		// ---- step=check_process ----
		const before = terminalManager.getOutput(sessionUri, termId);
		logService.info(`[KillTerminalTool] step=check_process: isRunning=${before.isRunning}, inputDetected=${before.inputDetected}, outputLen=${before.output.length}`);

		if (!before.isRunning && !before.inputDetected) {
			logService.warn(`[KillTerminalTool] step=check_process FAILED: not found or already dead`);
			return {
				toolCallId: input.toolCallId,
				content: `No active terminal found with id "${termId}". It may have already exited.`,
				success: false,
			};
		}

		// ---- step=kill ----
		logService.info(`[KillTerminalTool] step=kill: sending SIGTERM`);
		const killed = terminalManager.kill(sessionUri, termId);
		const elapsed = Date.now() - startTime;

		if (killed) {
			logService.info(`[KillTerminalTool] step=kill SUCCESS: elapsed=${elapsed}ms`);
			const parts: string[] = [];
			if (before.output.trim().length > 0) {
				parts.push(before.output);
			}
			parts.push(`[Process ${termId.substring(0, 8)} was killed by the user.]`);
			return {
				toolCallId: input.toolCallId,
				content: parts.join('\n'),
				success: true,
			};
		}

		// ---- step=kill FAILED ----
		logService.warn(`[KillTerminalTool] step=kill FAILED after ${elapsed}ms`);
		return {
			toolCallId: input.toolCallId,
			content: `Failed to kill terminal ${termId}.`,
			success: false,
		};
	};
}
