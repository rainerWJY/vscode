/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Creates and runs a build, run, or custom task for the workspace.
 *
 * Aligned with VS Code workbench's `CreateAndRunTaskTool`
 * (`src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/task/createAndRunTaskTool.ts`).
 *
 * Key alignment features:
 * - Same input schema: workspaceFolder, task.{label,type,command,args,isBackground,problemMatcher,group}
 * - Creates/updates .vscode/tasks.json in the workspace folder
 * - Runs the task command with arguments
 * - Returns terminal output
 * - Comprehensive logging
 *
 * What differs (architecture constraints):
 * - No ITaskService — runs command directly via execSync instead
 * - No ITerminalService — collects output from execSync directly
 * - No telemetry
 * - No problem matcher integration
 */
export const TOOL_CREATE_AND_RUN_TASK = defineTool({
	name: ToolName.CoreCreateAndRunTask,
	description:
		'Creates and runs a build, run, or custom task for the workspace by generating or adding to a tasks.json file based on the project structure (such as package.json or README.md). If the user asks to build, run, launch and they have no tasks.json file, use this tool. If they ask to create or add a task, use this tool.',
	parameters: {
		type: 'object',
		properties: {
			workspaceFolder: {
				type: 'string',
				description: 'The absolute path of the workspace folder where the tasks.json file will be created.',
			},
			task: {
				type: 'object',
				description: 'The task to add to the new tasks.json file.',
				properties: {
					label: { type: 'string', description: 'The label of the task.' },
					type: {
						type: 'string',
						description: "The type of the task. The only supported value is 'shell'.",
						enum: ['shell'],
					},
					command: {
						type: 'string',
						description: 'The shell command to run for the task. Use this to specify commands for building or running the application.',
					},
					args: {
						type: 'array',
						description: 'The arguments to pass to the command.',
						items: { type: 'string' },
					},
					isBackground: {
						type: 'boolean',
						description: 'Whether the task runs in the background without blocking the UI or other tasks.',
					},
					problemMatcher: {
						type: 'array',
						description: "The problem matcher to use to parse task output for errors and warnings.",
						items: { type: 'string' },
					},
					group: {
						type: 'string',
						description: 'The group to which the task belongs.',
					},
				},
				required: ['label', 'type', 'command'],
			},
		},
		required: ['task', 'workspaceFolder'],
	},
	isDestructive: true,
	toolKind: 'task',
});

// ---- handler (tool executor) ------------------------------------------------

export function createCreateAndRunTaskExecutor(
	fileService: IFileService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.info(`[CreateAndRunTaskTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}`);

		try {
			const token = input.cancellationToken;

			// Copilot-matching: check cancellation before any work
			if (token?.isCancellationRequested) {
				logService.warn(`[CreateAndRunTaskTool] cancelled before any work`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const params = input.parameters;
			const workspaceFolder = params.workspaceFolder as string;
			const task = params.task as Record<string, unknown>;

			// ---- Input validation ----
			if (!workspaceFolder || !task || !task.label || !task.command) {
				logService.warn(`[CreateAndRunTaskTool] step=validate FAILED: missing required fields`);
				return {
					toolCallId: input.toolCallId,
					content: 'Invalid input: workspaceFolder, task.label, and task.command are required.',
					success: false,
				};
			}

			const taskType = (task.type as string) || 'shell';
			const taskLabel = task.label as string;
			const taskCommand = task.command as string;
			const taskArgs = task.args as string[] | undefined;
			const isBackground = Boolean(task.isBackground);
			const problemMatcher = task.problemMatcher as string[] | undefined;
			const group = task.group as string | undefined;

			logService.info(`[CreateAndRunTaskTool] step=validate: workspaceFolder="${workspaceFolder}", task="${taskLabel}", type="${taskType}", command="${taskCommand}"`);

			// Copilot-matching: check cancellation before I/O
			if (token?.isCancellationRequested) {
				logService.warn(`[CreateAndRunTaskTool] cancelled after validation`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 1: Create/update .vscode/tasks.json ----
			const tasksJsonDir = path.posix.join(workspaceFolder, '.vscode');
			const tasksJsonPath = path.posix.join(tasksJsonDir, 'tasks.json');
			const tasksJsonUri = URI.file(tasksJsonPath);

			const newTask: Record<string, unknown> = {
				label: taskLabel,
				type: taskType,
				command: taskCommand,
			};
			if (taskArgs && taskArgs.length > 0) { newTask.args = taskArgs; }
			if (isBackground) { newTask.isBackground = true; }
			if (problemMatcher && problemMatcher.length > 0) { newTask.problemMatcher = problemMatcher; }
			if (group) { newTask.group = group; }

			logService.info(`[CreateAndRunTaskTool] step=tasks_json: uri=${tasksJsonPath}`);

			const fileExists = await fileService.exists(tasksJsonUri);

			let tasksJsonContent: string;
			if (!fileExists) {
				// Ensure the .vscode directory exists
				try {
					fs.mkdirSync(tasksJsonDir, { recursive: true });
				} catch {
					// If fileService.createFile can't create the dir, try direct fs
				}

				tasksJsonContent = JSON.stringify({
					version: '2.0.0',
					tasks: [newTask],
				}, null, '\t');
				await fileService.createFile(tasksJsonUri, VSBuffer.fromString(tasksJsonContent), { overwrite: true });
				logService.info(`[CreateAndRunTaskTool] step=tasks_json CREATED: ${tasksJsonPath}`);
			} else {
				const content = await fileService.readFile(tasksJsonUri);
				const tasksJson = JSON.parse(content.value.toString());
				tasksJson.tasks = tasksJson.tasks || [];
				tasksJson.tasks.push(newTask);
				tasksJsonContent = JSON.stringify(tasksJson, null, '\t');
				await fileService.writeFile(tasksJsonUri, VSBuffer.fromString(tasksJsonContent));
				logService.info(`[CreateAndRunTaskTool] step=tasks_json UPDATED: ${tasksJsonPath}`);
			}

			// Copilot-matching: check cancellation after I/O
			if (token?.isCancellationRequested) {
				logService.warn(`[CreateAndRunTaskTool] cancelled after tasks.json write`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 2: Run the task command ----
			const fullCommand = taskArgs && taskArgs.length > 0
				? `${taskCommand} ${taskArgs.join(' ')}`
				: taskCommand;

			logService.info(`[CreateAndRunTaskTool] step=run: cwd="${workspaceFolder}", command="${fullCommand.substring(0, 200)}"`);

			let output: string;
			try {
				const result = execSync(fullCommand, {
					cwd: workspaceFolder,
					timeout: 60_000,
					maxBuffer: 1024 * 1024,
					encoding: 'utf-8',
				});
				output = result || '(no output)';
				logService.info(`[CreateAndRunTaskTool] step=run done: exit=0, outputLen=${output.length}`);
			} catch (execErr) {
				const stderr = typeof execErr === 'object' && execErr !== null
					? (execErr as Record<string, unknown>).stderr
					: undefined;
				const errMsg = typeof stderr === 'string' && stderr
					? stderr.substring(0, 1000)
					: (execErr instanceof Error ? execErr.message : String(execErr));
				logService.warn(`[CreateAndRunTaskTool] step=run completed with error: ${errMsg.substring(0, 200)}`);
				output = `Task completed with errors:\n${errMsg}`;
			}

			const elapsed = Date.now() - startTime;
			const tasksJsonSummary = fileExists ? 'updated existing tasks.json' : 'created tasks.json';
			logService.info(`[CreateAndRunTaskTool] >>> done: task="${taskLabel}", ${tasksJsonSummary}, outputLen=${output.length}, elapsed=${elapsed}ms`);

			return {
				toolCallId: input.toolCallId,
				content: output,
				success: true,
			};
		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[CreateAndRunTaskTool] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error creating and running task: ${errMsg}`, success: false };
		}
	};
}
