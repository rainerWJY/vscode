/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
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

// ---- handler (tool executor) ------------------------------------------------

export function createRunInTerminalExecutor(
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		try {
			const command = input.parameters.command as string;
			logService.info(`[RunInTerminalTool] run_in_terminal: command="${command.substring(0, 200)}"`);
			const { execSync } = await import('node:child_process');
			const output = execSync(command, {
				timeout: 30_000,
				maxBuffer: 1024 * 1024,
				encoding: 'utf-8',
			});
			const outStr = output || '(no output)';
			logService.info(`[RunInTerminalTool] run_in_terminal done: exit=0, outputLen=${outStr.length}`);
			return { toolCallId: input.toolCallId, content: outStr, success: true };
		} catch (err) {
			const stderr = typeof err === 'object' && err !== null ? (err as Record<string, unknown>).stderr : undefined;
			const errMsg = typeof stderr === 'string' ? stderr : (err instanceof Error ? err.message : String(err));
			logService.error(`[RunInTerminalTool] run_in_terminal ERROR: ${errMsg.substring(0, 300)}`);
			return { toolCallId: input.toolCallId, content: `Command failed: ${errMsg}`, success: false };
		}
	};
}
