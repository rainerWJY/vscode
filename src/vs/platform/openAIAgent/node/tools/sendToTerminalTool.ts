/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { TerminalManager } from '../services/agentHostTerminalManager.js';

/**
 * Send input text to an active terminal execution.
 *
 * Aligned with Copilot's `SendToTerminalTool` (workbench:
 * `sendToTerminalTool.ts`). Sends text to a background process's stdin.
 * The process must have been spawned via `run_in_terminal` with
 * `mode=async`.
 *
 * - Sends text followed by a newline
 * - An empty or whitespace-only string sends just Enter
 * - `waitForOutput=true` waits briefly and returns the updated output
 */
export const TOOL_SEND_TO_TERMINAL = defineTool({
	name: ToolName.SendToTerminal,
	description:
		`Send input text to an active terminal execution (identified by the \`id\` returned from ${ToolName.RunInTerminal}). ` +
		`The 'command' field may be empty or whitespace to press Enter (useful for interactive prompts). ` +
		`By default, returns the last lines of terminal output captured shortly after sending. ` +
		`Set 'waitForOutput' to true for interactive programs (games, REPLs, etc.) to wait until the terminal ` +
		`becomes idle before returning output — this gives you the program's response to your input.`,
	parameters: {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				description: `The ID of an active terminal execution to send a command to (returned by ${ToolName.RunInTerminal} for async executions).`,
				pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
			},
			command: {
				type: 'string',
				description: 'The input text to send to the terminal. The text is sent followed by Enter. Provide an empty or whitespace string to send just Enter (for interactive prompts).',
			},
			waitForOutput: {
				type: 'boolean',
				description: 'When true, waits for the terminal to become idle (no new output for a short period) before returning, instead of returning immediately. Use this for interactive programs where you need to see the full response to your input. Defaults to false.',
			},
		},
		required: ['id', 'command'],
	},
	isDestructive: false,
	toolKind: 'shell',
});

// ---- handler (tool executor) ------------------------------------------------

/**
 * Create a `send_to_terminal` tool executor.
 *
 * Sends text to a background process's stdin. If `waitForOutput=true`,
 * polls briefly for the process's response.
 */
export function createSendToTerminalExecutor(
	logService: ILogService,
	terminalManager: TerminalManager,
	sessionUri: string,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		const termId = input.parameters.id as string;
		const command = input.parameters.command as string;
		const waitForOutput = input.parameters.waitForOutput as boolean | undefined;

		logService.info(`[SendToTerminalTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, termId=${termId ? termId.substring(0, 8) : '(missing)'}`);

		if (!termId) {
			return { toolCallId: input.toolCallId, content: 'A "id" parameter is required.', success: false };
		}

		// Get output before sending
		const before = terminalManager.getOutput(sessionUri, termId);
		if (!before.isRunning && !before.inputDetected) {
			logService.warn(`[SendToTerminalTool] process not found or not running: termId=${termId.substring(0, 8)}`);
			return {
				toolCallId: input.toolCallId,
				content: `No active terminal found with id "${termId}". The process may have already exited or the id is invalid.`,
				success: false,
			};
		}

		// Send the input
		const sent = terminalManager.sendInput(sessionUri, termId, command);
		if (!sent) {
			logService.error(`[SendToTerminalTool] failed to write to stdin: termId=${termId.substring(0, 8)}`);
			return {
				toolCallId: input.toolCallId,
				content: `Failed to send input to terminal ${termId}. The process may have exited or stdin is not available.`,
				success: false,
			};
		}

		// If waitForOutput, poll for a short while to let the process respond
		if (waitForOutput) {
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		// Get output after sending
		const after = terminalManager.getOutput(sessionUri, termId);

		const elapsed = Date.now() - startTime;
		const newOutput = after.output.length > before.output.length
			? after.output.substring(before.output.length)
			: '';

		const parts: string[] = [];
		if (newOutput.trim().length > 0) {
			parts.push(newOutput);
		} else {
			parts.push('(Input sent. No new output yet.)');
		}
		if (after.inputDetected) {
			parts.push(`\n[Process may be waiting for more input. Send again or call ${ToolName.GetTerminalOutput} with id="${termId}" to check.]`);
		}
		if (!after.isRunning && after.exitCode !== undefined) {
			parts.push(`\n[Process exited with code ${after.exitCode}]`);
		}

		logService.info(`[SendToTerminalTool] done in ${elapsed}ms: outputLen=${parts.join('').length}`);

		return {
			toolCallId: input.toolCallId,
			content: parts.join('\n'),
			success: true,
		};
	};
}
