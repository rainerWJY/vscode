/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StringSHA1 } from '../../../../base/common/hash.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { TerminalManager } from '../services/agentHostTerminalManager.js';

// ---- snapshot tracking (matches Copilot's output delta diffing) -------------

interface IOutputSnapshot {
	readonly length: number;
	readonly hash: string;
}

const _outputSnapshots = new Map<string, IOutputSnapshot>();

function _hashOutput(output: string, upTo: number): string {
	const sha = new StringSHA1();
	sha.update(output.substring(0, upTo));
	return sha.digest();
}

/** Clean up snapshot when a process exits or is forgotten. */
function _forgetSnapshot(id: string): void {
	_outputSnapshots.delete(id);
}

/**
 * Get output from a terminal execution.
 *
 * Aligned with Copilot's `GetTerminalOutputTool`:
 * - Output delta tracking: subsequent polls show only new output
 * - Unchanged output detection via SHA-1 hash comparison
 * - Clean error messages when the terminal execution is not found
 */
export const TOOL_GET_TERMINAL_OUTPUT = defineTool({
	name: ToolName.GetTerminalOutput,
	description:
		`Get output from an active terminal execution (identified by the \`id\` returned from ${ToolName.RunInTerminal}).`,
	parameters: {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				description: `The ID of an active terminal execution to check (returned by ${ToolName.RunInTerminal} for async executions, or for sync executions that timed out and were moved to the background). This must be the exact opaque UUID returned by that tool; terminal names, labels, or integers are invalid.`,
				pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
			},
		},
		required: ['id'],
	},
	isDestructive: false,
	toolKind: 'task',
});

// ---- handler (tool executor) ------------------------------------------------

/**
 * Create a `get_terminal_output` tool executor.
 *
 * Aligned with Copilot's `GetTerminalOutputTool.invoke()`:
 * - Retrieves buffered output from a background process via `TerminalManager`
 * - Tracks output snapshots (length + SHA-1 hash) per execution ID for delta diffing
 * - On unchanged output: returns "unchanged since previous poll" message
 * - On new output: returns only the delta since the previous snapshot
 * - On first poll: returns the full output
 * - Cleans up snapshot when process exits
 */
export function createGetTerminalOutputExecutor(
	logService: ILogService,
	terminalManager: TerminalManager,
	sessionUri: string,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const termId = input.parameters.id as string;
		logService.info(`[GetTerminalOutputTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, termId=${termId ? termId.substring(0, 8) : '(missing)'}`);

		if (!termId) {
			return {
				toolCallId: input.toolCallId,
				content: `Error: 'id' (the persistent terminal UUID returned by ${ToolName.RunInTerminal} in async mode) must be provided.`,
				success: false,
			};
		}

		const result = terminalManager.getOutput(sessionUri, termId);

		if (!result.isRunning && result.exitCode === undefined && result.output.length === 0) {
			logService.warn(`[GetTerminalOutputTool] unknown termId: ${termId.substring(0, 8)}`);
			_forgetSnapshot(termId);
			return {
				toolCallId: input.toolCallId,
				content: `Error: No active terminal execution found with ID ${termId}. The ID must be the exact value returned by ${ToolName.RunInTerminal} in async mode.`,
				success: false,
			};
		}

		// ---- Output delta diffing (matches Copilot) -------------------------
		const previousSnapshot = _outputSnapshots.get(termId);
		const currentSnapshot: IOutputSnapshot = {
			length: result.output.length,
			hash: _hashOutput(result.output, result.output.length),
		};
		_outputSnapshots.set(termId, currentSnapshot);

		// Build the output prefix
		let prefix = `Output of terminal ${termId}`;

		// Compare with previous snapshot
		if (previousSnapshot !== undefined) {
			if (currentSnapshot.length === previousSnapshot.length && currentSnapshot.hash === previousSnapshot.hash) {
				// Unchanged output
				_forgetSnapshot(termId);
				const unchangedMsg = `${prefix} unchanged since previous poll (${result.output.length} characters already shown). No new output.`;
				logService.info(`[GetTerminalOutputTool] unchanged: termId=${termId.substring(0, 8)}, len=${result.output.length}`);
				return {
					toolCallId: input.toolCallId,
					content: unchangedMsg,
					success: true,
				};
			}

			if (result.output.length > previousSnapshot.length &&
				_hashOutput(result.output, previousSnapshot.length) === previousSnapshot.hash) {
				// Output grew — show only the delta
				const delta = result.output.slice(previousSnapshot.length);
				prefix += ` since previous poll (${delta.length} new characters, ${result.output.length} total characters)`;
				const parts: string[] = [`${prefix}:\n${delta}`];

				if (result.exitCode !== undefined) {
					parts.push(`\n[Process exited with code ${result.exitCode}]`);
					_forgetSnapshot(termId);
				} else if (result.inputDetected) {
					parts.push(`\n[Process appears to be waiting for input. Use ${ToolName.SendToTerminal} with id="${termId}" to respond.]`);
				} else if (!result.isRunning) {
					parts.push('\n[Process has stopped.]');
					_forgetSnapshot(termId);
				}

				const content = parts.join('\n');
				logService.info(`[GetTerminalOutputTool] delta: termId=${termId.substring(0, 8)}, deltaLen=${delta.length}, totalLen=${result.output.length}`);
				return { toolCallId: input.toolCallId, content, success: true };
			}
		}

		// Fall through: first poll, or hash mismatch (output was replaced/truncated)
		prefix += `:\n${result.output}`;
		const parts: string[] = [prefix];

		if (result.exitCode !== undefined) {
			parts.push(`\n[Process exited with code ${result.exitCode}]`);
			_forgetSnapshot(termId);
		} else if (result.inputDetected) {
			parts.push(`\n[Process appears to be waiting for input. Use ${ToolName.SendToTerminal} with id="${termId}" to respond.]`);
		} else if (result.isRunning) {
			parts.push(`\n[Process is still running. Call ${ToolName.GetTerminalOutput} again with id="${termId}" to get updated output.]`);
		} else {
			parts.push('\n[Process has stopped.]');
			_forgetSnapshot(termId);
		}

		const content = parts.join('\n');
		logService.info(`[GetTerminalOutputTool] done: termId=${termId.substring(0, 8)}, outputLen=${result.output.length}, isRunning=${result.isRunning}, exitCode=${result.exitCode}, inputDetected=${result.inputDetected}`);

		return {
			toolCallId: input.toolCallId,
			content,
			success: true,
		};
	};
}
