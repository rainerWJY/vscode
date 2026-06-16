/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { type TerminalManager } from '../services/agentHostTerminalManager.js';
import { getTask, type TaskRecord } from './taskRegistry.js';

/**
 * Get the output of a previously run task.
 *
 * Aligned with VS Code workbench's `GetTaskOutputTool`
 * (`src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/task/getTaskOutputTool.ts`).
 *
 * Feature alignment:
 *
 * 1. **prepareToolInvocation (inline)**
 *    Workbench validates task existence and running status before execution.
 *    Agent Host does the same inline: checks tasks.json for definition, checks
 *    TaskRegistry for running status, returns informative messages.
 *
 * 2. **Background task support**
 *    Workbench: uses `IXtermMarker` to read current buffer from running terminal.
 *    Agent Host: background tasks launched via `create_and_run_task` are spawned
 *    as async processes via `TerminalManager.execAsync()`, storing a `termId`.
 *    `get_task_output` polls that process via `TerminalManager.getOutput()`.
 *    Non-background tasks are re-executed via `execSync`.
 *
 * 3. **Output delta**
 *    Workbench: `IXtermMarker` tracks last-read buffer position.
 *    Agent Host: SHA-1 hash snapshots per (session, task) — same approach as
 *    `getTerminalOutputTool.ts`. Returns only new output on subsequent polls.
 */
export const TOOL_GET_TASK_OUTPUT = defineTool({
	name: ToolName.CoreGetTaskOutput,
	description:
		'Get the output of a task. Use this to check the results of previously run or currently running tasks.',
	parameters: {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				description: 'The task label or ID to get output for.',
			},
			workspaceFolder: {
				type: 'string',
				description: 'The workspace folder path containing the task',
			},
		},
		required: ['id', 'workspaceFolder'],
	},
	isDestructive: false,
	toolKind: 'task',
});

// ---- output delta tracking (SHA-1 hash snapshots) ---------------------------

interface IOutputSnapshot {
	readonly length: number;
	readonly hash: string;
}

const _outputSnapshots = new Map<string, IOutputSnapshot>();

function _snapshotKey(sessionUri: string, workspaceFolder: string, taskId: string): string {
	return `${sessionUri}::${workspaceFolder}::${taskId}`;
}

function _hashOutput(output: string, upTo: number): string {
	const sha = new StringSHA1();
	sha.update(output.substring(0, upTo));
	return sha.digest();
}

function _forgetSnapshot(sessionUri: string, workspaceFolder: string, taskId: string): void {
	_outputSnapshots.delete(_snapshotKey(sessionUri, workspaceFolder, taskId));
}

/** Apply delta tracking: return (displayContent, fullContent) — the former is what the LLM sees. */
function _applyDelta(
	key: string,
	fullOutput: string,
): { displayContent: string; fullContent: string } {
	const previousSnapshot = _outputSnapshots.get(key);
	const currentSnapshot: IOutputSnapshot = {
		length: fullOutput.length,
		hash: _hashOutput(fullOutput, fullOutput.length),
	};
	_outputSnapshots.set(key, currentSnapshot);

	if (previousSnapshot !== undefined) {
		if (currentSnapshot.length === previousSnapshot.length && currentSnapshot.hash === previousSnapshot.hash) {
			// Unchanged — remove snapshot so next poll re-detects
			_outputSnapshots.delete(key);
			return {
				displayContent: `Output unchanged since previous poll (${fullOutput.length} characters already shown). No new output.`,
				fullContent: fullOutput,
			};
		}

		// Output grew — show only the delta (if prefix matches)
		if (fullOutput.length > previousSnapshot.length &&
			_hashOutput(fullOutput, previousSnapshot.length) === previousSnapshot.hash) {
			const delta = fullOutput.slice(previousSnapshot.length);
			return {
				displayContent: `(previous poll up to ${previousSnapshot.length} chars; ${delta.length} new characters, ${fullOutput.length} total)\n${delta}`,
				fullContent: fullOutput,
			};
		}

		// Output changed — show full output with note
		return {
			displayContent: `(output changed since previous poll; showing full output, ${fullOutput.length} characters)\n${fullOutput}`,
			fullContent: fullOutput,
		};
	}

	// First poll — show full
	return {
		displayContent: fullOutput,
		fullContent: fullOutput,
	};
}

// ---- handler (tool executor) ------------------------------------------------

export function createGetTaskOutputExecutor(
	logService: ILogService,
	terminalManager: TerminalManager,
	sessionUri: string,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.info(`[GetTaskOutputTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}`);

		try {
			const token = input.cancellationToken;

			if (token?.isCancellationRequested) {
				logService.warn(`[GetTaskOutputTool] cancelled before any work`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const workspaceFolder = input.parameters.workspaceFolder as string;
			const taskId = input.parameters.id as string;

			if (!workspaceFolder || !taskId) {
				logService.warn(`[GetTaskOutputTool] step=validate FAILED: missing workspaceFolder or id`);
				return { toolCallId: input.toolCallId, content: 'Invalid input: workspaceFolder and id are required.', success: false };
			}

			logService.info(`[GetTaskOutputTool] step=validate: workspaceFolder="${workspaceFolder}", taskId="${taskId}"`);

			if (token?.isCancellationRequested) {
				logService.warn(`[GetTaskOutputTool] cancelled after validation`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 1: Check TaskRegistry for running background task ----
			const record = getTask(sessionUri, workspaceFolder, taskId);

			if (record && record.isBackground && record.termId) {
				// Background task: poll via TerminalManager (no re-execution)
				logService.info(`[GetTaskOutputTool] step=check_registry: found background task "${taskId}", termId="${record.termId.substring(0, 8)}"`);

				if (token?.isCancellationRequested) {
					logService.warn(`[GetTaskOutputTool] cancelled before background poll`);
					return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
				}

				const result = terminalManager.getOutput(sessionUri, record.termId);

				if (!result.isRunning && result.exitCode === undefined && result.output.length === 0) {
					// Process not found — fall back to re-execute
					logService.warn(`[GetTaskOutputTool] background task termId not found, falling back to re-execute`);
					_forgetSnapshot(sessionUri, workspaceFolder, taskId);
				} else {
					// Apply delta tracking
					const snapshotKey = _snapshotKey(sessionUri, workspaceFolder, taskId);
					const { displayContent } = _applyDelta(snapshotKey, result.output);

					const status = result.isRunning ? ' (still running)' : ` (exit code: ${result.exitCode})`;
					const elapsed = Date.now() - startTime;
					logService.info(`[GetTaskOutputTool] >>> done (background poll): task="${taskId}"${status}, outputLen=${result.output.length}, elapsed=${elapsed}ms`);

					return {
						toolCallId: input.toolCallId,
						content: displayContent,
						success: true,
					};
				}
			} else if (record && record.isBackground && !record.termId) {
				// Background task registered but no termId — shouldn't happen
				logService.warn(`[GetTaskOutputTool] step=check_registry: background task "${taskId}" has no termId`);
			}

			// ---- Step 2 (non-background / fallback): Read tasks.json ----
			const tasksJsonPath = path.posix.join(workspaceFolder, '.vscode', 'tasks.json');
			logService.info(`[GetTaskOutputTool] step=read_tasks_json: path="${tasksJsonPath}"`);

			if (!fs.existsSync(path.join(workspaceFolder, '.vscode', 'tasks.json'))) {
				logService.warn(`[GetTaskOutputTool] step=read_tasks_json FAILED: no tasks.json found`);
				return {
					toolCallId: input.toolCallId,
					content: `Task not found: ${taskId}. No tasks.json found at ${tasksJsonPath}.`,
					success: false,
				};
			}

			const tasksJsonRaw = fs.readFileSync(path.join(workspaceFolder, '.vscode', 'tasks.json'), 'utf-8');
			let tasksJson: { tasks?: Record<string, unknown>[] };
			try {
				tasksJson = JSON.parse(tasksJsonRaw);
			} catch {
				logService.warn(`[GetTaskOutputTool] step=read_tasks_json FAILED: invalid JSON`);
				return {
					toolCallId: input.toolCallId,
					content: `Failed to parse tasks.json. The file may be malformed.`,
					success: false,
				};
			}

			// ---- Step 3: Find task by label ----
			const task = (tasksJson.tasks || []).find(t => t.label === taskId);
			if (!task) {
				const available = (tasksJson.tasks || []).map(t => `"${t.label}"`).join(', ');
				logService.warn(`[GetTaskOutputTool] step=find_task FAILED: "${taskId}" not found among [${available}]`);
				return {
					toolCallId: input.toolCallId,
					content: `Task not found: "${taskId}". Available tasks: ${available || '(none)'}`,
					success: false,
				};
			}

			const command = task.command as string;
			const taskArgs = task.args as string[] | undefined;

			if (!command) {
				logService.warn(`[GetTaskOutputTool] step=find_task FAILED: task "${taskId}" has no command`);
				return {
					toolCallId: input.toolCallId,
					content: `Task "${taskId}" has no command defined.`,
					success: false,
				};
			}

			const isBackgroundTaskDef = Boolean(task.isBackground);
			const runningRecord = record && record.isBackground && record.isRunning === undefined
				? record
				: undefined;

			// ---- Step 4: prepareToolInvocation equivalent — status message ----
			let preamble = '';
			if (runningRecord) {
				preamble = `Task \`${taskId}\` is currently running (started ${Date.now() - runningRecord.startTime}ms ago). Retrieving current output...\n\n`;
				logService.info(`[GetTaskOutputTool] step=status: task "${taskId}" is running (from registry)`);
			} else if (isBackgroundTaskDef) {
				// isBackground=true in tasks.json but no registry record — re-execute
				preamble = `Task \`${taskId}\` is defined as a background task. Executing it to retrieve output...\n\n`;
				logService.info(`[GetTaskOutputTool] step=status: task "${taskId}" is background (from tasks.json), re-executing`);
			} else {
				preamble = `Executing task \`${taskId}\` to retrieve output...\n\n`;
				logService.info(`[GetTaskOutputTool] step=status: task "${taskId}" is a standard task, re-executing`);
			}

			logService.info(`[GetTaskOutputTool] step=find_task: found "${taskId}", command="${command}"`);

			if (token?.isCancellationRequested) {
				logService.warn(`[GetTaskOutputTool] cancelled after finding task`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 5: Execute task to retrieve output ----
			const fullCommand = taskArgs && taskArgs.length > 0
				? `${command} ${taskArgs.join(' ')}`
				: command;

			logService.info(`[GetTaskOutputTool] step=execute: cwd="${workspaceFolder}", command="${fullCommand.substring(0, 200)}"`);

			let output: string;
			try {
				const result = execSync(fullCommand, {
					cwd: workspaceFolder,
					timeout: 60_000,
					maxBuffer: 1024 * 1024,
					encoding: 'utf-8',
				});
				output = result || '(no output)';
				logService.info(`[GetTaskOutputTool] step=execute done: exit=0, outputLen=${output.length}`);
			} catch (execErr) {
				const stderr = typeof execErr === 'object' && execErr !== null
					? (execErr as Record<string, unknown>).stderr
					: undefined;
				const errMsg = typeof stderr === 'string' && stderr
					? stderr.substring(0, 1000)
					: (execErr instanceof Error ? execErr.message : String(execErr));
				logService.warn(`[GetTaskOutputTool] step=execute completed with error: ${errMsg.substring(0, 200)}`);
				output = `Task completed with errors:\n${errMsg}`;
			}

			const elapsed = Date.now() - startTime;
			logService.info(`[GetTaskOutputTool] >>> done: task="${taskId}", outputLen=${output.length}, elapsed=${elapsed}ms`);

			return {
				toolCallId: input.toolCallId,
				content: preamble + output,
				success: true,
			};

		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[GetTaskOutputTool] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error getting task output: ${errMsg}`, success: false };
		}
	};
}
