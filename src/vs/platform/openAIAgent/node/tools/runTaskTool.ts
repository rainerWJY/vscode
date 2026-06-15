/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Runs a VS Code task from an existing tasks.json file.
 *
 * Aligned with VS Code workbench's `RunTaskTool`
 * (`workbench/contrib/terminalContrib/chatAgentTools/browser/tools/task/runTaskTool.ts`).
 *
 * Key alignment:
 * - Same input schema: workspaceFolder, id
 * - Finds task in .vscode/tasks.json by label matching
 * - Runs the task command with arguments
 * - Returns terminal output
 *
 * What differs (architecture constraints):
 * - No ITaskService — reads tasks.json directly and runs via execSync
 * - No ITerminalService — can't monitor background tasks
 * - No telemetry, no prepareToolInvocation UI
 */
export const TOOL_RUN_TASK = defineTool({
	name: ToolName.CoreRunTask,
	description:
		`Runs a VS Code task.\n\n- If you see that an appropriate task exists for building or running code, prefer to use this tool to run the task instead of using the ${ToolName.RunInTerminal} tool.\n- Make sure that any appropriate build or watch task is running before trying to run tests or execute code.\n- If the user asks to run a task, use this tool to do so.`,
	parameters: {
		type: 'object',
		properties: {
			workspaceFolder: {
				type: 'string',
				description: 'The workspace folder path containing the task',
			},
			id: {
				type: 'string',
				description: 'The task label or ID to run.',
			},
		},
		required: ['workspaceFolder', 'id'],
	},
	isDestructive: true,
	toolKind: 'task',
});

// ---- handler (tool executor) ------------------------------------------------

export function createRunTaskExecutor(
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.info(`[RunTaskTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}`);

		try {
			const token = input.cancellationToken;

			if (token?.isCancellationRequested) {
				logService.warn(`[RunTaskTool] cancelled before any work`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const workspaceFolder = input.parameters.workspaceFolder as string;
			const taskId = input.parameters.id as string;

			if (!workspaceFolder || !taskId) {
				logService.warn(`[RunTaskTool] step=validate FAILED: missing workspaceFolder or id`);
				return { toolCallId: input.toolCallId, content: 'Invalid input: workspaceFolder and id are required.', success: false };
			}

			logService.info(`[RunTaskTool] step=validate: workspaceFolder="${workspaceFolder}", taskId="${taskId}"`);

			if (token?.isCancellationRequested) {
				logService.warn(`[RunTaskTool] cancelled after validation`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 1: Read tasks.json ----
			const tasksJsonPath = path.posix.join(workspaceFolder, '.vscode', 'tasks.json');
			logService.info(`[RunTaskTool] step=read_tasks_json: path="${tasksJsonPath}"`);

			if (!fs.existsSync(path.join(workspaceFolder, '.vscode', 'tasks.json'))) {
				logService.warn(`[RunTaskTool] step=read_tasks_json FAILED: no tasks.json found`);
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
				logService.warn(`[RunTaskTool] step=read_tasks_json FAILED: invalid JSON`);
				return {
					toolCallId: input.toolCallId,
					content: `Failed to parse tasks.json. The file may be malformed.`,
					success: false,
				};
			}

			// ---- Step 2: Find task by label ----
			const task = (tasksJson.tasks || []).find(t => t.label === taskId);
			if (!task) {
				const available = (tasksJson.tasks || []).map(t => `"${t.label}"`).join(', ');
				logService.warn(`[RunTaskTool] step=find_task FAILED: "${taskId}" not found among [${available}]`);
				return {
					toolCallId: input.toolCallId,
					content: `Task not found: "${taskId}". Available tasks: ${available || '(none)'}`,
					success: false,
				};
			}

			const command = task.command as string;
			const taskArgs = task.args as string[] | undefined;

			if (!command) {
				logService.warn(`[RunTaskTool] step=find_task FAILED: task "${taskId}" has no command`);
				return {
					toolCallId: input.toolCallId,
					content: `Task "${taskId}" has no command defined.`,
					success: false,
				};
			}

			logService.info(`[RunTaskTool] step=find_task: found "${taskId}", command="${command}"`);

			if (token?.isCancellationRequested) {
				logService.warn(`[RunTaskTool] cancelled after finding task`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 3: Run the task command ----
			const fullCommand = taskArgs && taskArgs.length > 0
				? `${command} ${taskArgs.join(' ')}`
				: command;

			logService.info(`[RunTaskTool] step=run: cwd="${workspaceFolder}", command="${fullCommand.substring(0, 200)}"`);

			let output: string;
			try {
				const result = execSync(fullCommand, {
					cwd: workspaceFolder,
					timeout: 60_000,
					maxBuffer: 1024 * 1024,
					encoding: 'utf-8',
				});
				output = result || '(no output)';
				logService.info(`[RunTaskTool] step=run done: exit=0, outputLen=${output.length}`);
			} catch (execErr) {
				const stderr = typeof execErr === 'object' && execErr !== null
					? (execErr as Record<string, unknown>).stderr
					: undefined;
				const errMsg = typeof stderr === 'string' && stderr
					? stderr.substring(0, 1000)
					: (execErr instanceof Error ? execErr.message : String(execErr));
				logService.warn(`[RunTaskTool] step=run completed with error: ${errMsg.substring(0, 200)}`);
				output = `Task completed with errors:\n${errMsg}`;
			}

			const elapsed = Date.now() - startTime;
			logService.info(`[RunTaskTool] >>> done: task="${taskId}", outputLen=${output.length}, elapsed=${elapsed}ms`);

			return {
				toolCallId: input.toolCallId,
				content: output,
				success: true,
			};

		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[RunTaskTool] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error running task: ${errMsg}`, success: false };
		}
	};
}
