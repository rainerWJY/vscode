/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TerminalManager } from '../../../node/services/agentHostTerminalManager.js';
import { TOOL_GET_TASK_OUTPUT, createGetTaskOutputExecutor } from '../../../node/tools/getTaskOutputTool.js';
import { registerTask, unregisterSession } from '../../../node/tools/taskRegistry.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- constants & helpers ----------------------------------------------------

const SESSION_URI = 'test-session:///get-task-output-test';
const WORKSPACE = '/tmp';
const TASK_LABEL = 'test-task';
const DEFAULT_TIMEOUT = 60_000;
const logService = new NullLogService();

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'get_task_output', parameters: params, cancellationToken };
}

function initTempDir(): string {
	const dir = '/tmp/vscode_gettaskoutput_test_' + Date.now() + '_' + Math.random().toString(36).slice(2);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanTempDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function createTasksJson(dir: string, tasks: Record<string, unknown>[]): void {
	const vscodeDir = path.join(dir, '.vscode');
	fs.mkdirSync(vscodeDir, { recursive: true });
	fs.writeFileSync(path.join(vscodeDir, 'tasks.json'), JSON.stringify({
		version: '2.0.0',
		tasks,
	}, null, '\t'), 'utf-8');
}

// ---- suite helper -----------------------------------------------------------

/**
 * Helper: wraps a suite with temp-dir beforeEach/afterEach.
 */
function withTempDir(fn: (ctx: { dir: string }) => void): void {
	const ctx = {} as { dir: string };
	setup(() => {
		ctx.dir = initTempDir();
	});
	teardown(() => {
		cleanTempDir(ctx.dir);
	});
	fn(ctx);
}

function withManager(fn: (ctx: { manager: TerminalManager; disposables: DisposableStore }) => void): void {
	const ctx = {} as { manager: TerminalManager; disposables: DisposableStore };
	setup(() => {
		ctx.disposables = new DisposableStore();
		ctx.manager = ctx.disposables.add(new TerminalManager(new NullLogService()));
	});
	teardown(() => {
		unregisterSession(SESSION_URI);
		ctx.manager.disposeSession(SESSION_URI);
		ctx.disposables.clear();
	});
	fn(ctx);
}

// ---- tests ------------------------------------------------------------------

suite('GetTaskOutputTool', () => {

	suite('Tool definition', () => {

		test('has correct name', () => {
			assert.strictEqual(TOOL_GET_TASK_OUTPUT.name, 'get_task_output');
		});

		test('has description', () => {
			assert.ok(TOOL_GET_TASK_OUTPUT.description.length > 0);
		});

		test('is not destructive', () => {
			assert.strictEqual(TOOL_GET_TASK_OUTPUT.isDestructive, false);
		});

		test('has task toolKind', () => {
			assert.strictEqual(TOOL_GET_TASK_OUTPUT.toolKind, 'task');
		});

		test('requires id and workspaceFolder parameters', () => {
			const params = TOOL_GET_TASK_OUTPUT.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.id);
			assert.ok(props.workspaceFolder);
			const required = params.required as string[];
			assert.ok(required.includes('id'));
			assert.ok(required.includes('workspaceFolder'));
		});
	});

	suite('Input validation', () => {

		test('rejects missing workspaceFolder', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);
			const result = await executor(makeInput('call-1', { id: 'some-task' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('workspaceFolder'));
			manager.disposeSession(SESSION_URI);
			manager.dispose();
		});

		test('rejects missing id', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);
			const result = await executor(makeInput('call-2', { workspaceFolder: '/tmp' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('id'));
			manager.disposeSession(SESSION_URI);
			manager.dispose();
		});

		test('rejects missing both', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);
			const result = await executor(makeInput('call-3', {}));
			assert.strictEqual(result.success, false);
			manager.disposeSession(SESSION_URI);
			manager.dispose();
		});
	});

	suite('Cancellation', () => {

		test('returns cancellation when token is already cancelled', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);
			const result = await executor(makeInput('call-cancel', {
				id: 'some-task',
				workspaceFolder: '/tmp',
			}, CancellationToken.Cancelled));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Cancellation requested'));
			manager.disposeSession(SESSION_URI);
			manager.dispose();
		});
	});

	suite('Background task polling (via TaskRegistry + TerminalManager)', () => {

		test('polls background task via terminal manager', async function () {
			this.timeout(DEFAULT_TIMEOUT);
			const manager = new TerminalManager(new NullLogService());
			const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

			try {
				// Start a background process
				const { termId } = await manager.execAsync(SESSION_URI, 'echo hello_from_background');

				// Register it in TaskRegistry as a background task
				registerTask(SESSION_URI, {
					workspaceFolder: WORKSPACE,
					taskId: 'bg-task-1',
					label: 'BG Task 1',
					isBackground: true,
					termId,
					startTime: Date.now(),
				});

				// Wait a bit for the process to produce output
				await new Promise(resolve => setTimeout(resolve, 500));

				// Poll via get_task_output — should hit the background path
				const result = await executor(makeInput('call-bg-1', {
					id: 'bg-task-1',
					workspaceFolder: WORKSPACE,
				}));

				assert.strictEqual(result.success, true);
				assert.ok(result.content.includes('hello_from_background'), `Expected "hello_from_background" in output, got: ${result.content}`);
			} finally {
				unregisterSession(SESSION_URI);
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});

		test('returns delta on second poll of background task', async function () {
			this.timeout(DEFAULT_TIMEOUT);
			const manager = new TerminalManager(new NullLogService());
			const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

			try {
				// Start a long-running process that can be polled multiple times
				const { termId } = await manager.execAsync(SESSION_URI, 'echo line1 && sleep 0.2 && echo line2');

				registerTask(SESSION_URI, {
					workspaceFolder: WORKSPACE,
					taskId: 'bg-delta',
					label: 'BG Delta',
					isBackground: true,
					termId,
					startTime: Date.now(),
				});

				// Wait for initial output
				await new Promise(resolve => setTimeout(resolve, 600));

				// First poll: should get full output (no delta)
				const result1 = await executor(makeInput('call-delta-1', {
					id: 'bg-delta',
					workspaceFolder: WORKSPACE,
				}));
				assert.strictEqual(result1.success, true);
				assert.ok(result1.content.includes('line1'), `First poll should include line1`);
				assert.ok(result1.content.includes('line2'), `First poll should include line2`);

				// Second poll: output is unchanged, expect delta message
				const result2 = await executor(makeInput('call-delta-2', {
					id: 'bg-delta',
					workspaceFolder: WORKSPACE,
				}));
				assert.strictEqual(result2.success, true);
				assert.ok(result2.content.includes('unchanged'), `Second poll should say unchanged, got: ${result2.content}`);
			} finally {
				unregisterSession(SESSION_URI);
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});

		test('falls back to re-execute when background task termId is stale', async function () {
			this.timeout(DEFAULT_TIMEOUT);
			const dir = initTempDir();
			try {
				createTasksJson(dir, [
					{ label: 'stale-task', type: 'shell', command: 'echo fallback_works' },
				]);

				const manager = new TerminalManager(new NullLogService());
				const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

				// Register with a non-existent termId
				registerTask(SESSION_URI, {
					workspaceFolder: dir,
					taskId: 'stale-task',
					label: 'Stale Task',
					isBackground: true,
					termId: 'non-existent-term-id',
					startTime: Date.now(),
				});

				const result = await executor(makeInput('call-stale', {
					id: 'stale-task',
					workspaceFolder: dir,
				}));

				assert.strictEqual(result.success, true);
				assert.ok(result.content.includes('fallback_works'), `Expected fallback execSync output, got: ${result.content}`);

				manager.disposeSession(SESSION_URI);
				manager.dispose();
			} finally {
				cleanTempDir(dir);
				unregisterSession(SESSION_URI);
			}
		});
	});

	suite('Non-background task (tasks.json + execSync)', () => {

		withTempDir((ctx) => {
			test('returns output for existing task', async () => {
				createTasksJson(ctx.dir, [
					{ label: 'echo-task', type: 'shell', command: 'echo hello_task_output' },
				]);

				const manager = new TerminalManager(new NullLogService());
				const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

				try {
					const result = await executor(makeInput('call-nb-1', {
						id: 'echo-task',
						workspaceFolder: ctx.dir,
					}));
					assert.strictEqual(result.success, true);
					assert.ok(result.content.includes('hello_task_output'));
				} finally {
					manager.disposeSession(SESSION_URI);
					manager.dispose();
				}
			});

			test('returns error for non-existent task', async () => {
				createTasksJson(ctx.dir, [
					{ label: 'real-task', type: 'shell', command: 'echo real' },
				]);

				const manager = new TerminalManager(new NullLogService());
				const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

				try {
					const result = await executor(makeInput('call-nb-2', {
						id: 'nonexistent-task',
						workspaceFolder: ctx.dir,
					}));
					assert.strictEqual(result.success, false);
					assert.ok(result.content.includes('not found'));
				} finally {
					manager.disposeSession(SESSION_URI);
					manager.dispose();
				}
			});

			test('returns error when no tasks.json exists', async () => {
				const emptyDir = initTempDir();
				try {
					const manager = new TerminalManager(new NullLogService());
					const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

					const result = await executor(makeInput('call-nb-3', {
						id: 'any-task',
						workspaceFolder: emptyDir,
					}));
					assert.strictEqual(result.success, false);
					assert.ok(result.content.includes('No tasks.json found'));
					manager.disposeSession(SESSION_URI);
					manager.dispose();
				} finally {
					cleanTempDir(emptyDir);
				}
			});

			test('includes preamble with task status message', async () => {
				createTasksJson(ctx.dir, [
					{ label: 'preamble-task', type: 'shell', command: 'echo preamble_output' },
				]);

				const manager = new TerminalManager(new NullLogService());
				const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

				try {
					const result = await executor(makeInput('call-nb-4', {
						id: 'preamble-task',
						workspaceFolder: ctx.dir,
					}));
					assert.strictEqual(result.success, true);
					// Should have a preamble about executing the task
					assert.ok(result.content.includes('preamble_output'));
				} finally {
					manager.disposeSession(SESSION_URI);
					manager.dispose();
				}
			});

			test('handles tasks with args', async () => {
				createTasksJson(ctx.dir, [
					{ label: 'args-task', type: 'shell', command: 'echo', args: ['arg1', 'arg2'] },
				]);

				const manager = new TerminalManager(new NullLogService());
				const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

				try {
					const result = await executor(makeInput('call-nb-5', {
						id: 'args-task',
						workspaceFolder: ctx.dir,
					}));
					assert.strictEqual(result.success, true);
					assert.ok(result.content.includes('arg1'));
					assert.ok(result.content.includes('arg2'));
				} finally {
					manager.disposeSession(SESSION_URI);
					manager.dispose();
				}
			});
		});
	});

	suite('Output delta tracking', () => {

		test('first poll returns full output', async () => {
			// Direct unit test of the delta mechanism by using a background task
			const manager = new TerminalManager(new NullLogService());
			const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

			try {
				const { termId } = await manager.execAsync(SESSION_URI, 'echo delta_first_poll');
				registerTask(SESSION_URI, {
					workspaceFolder: WORKSPACE,
					taskId: 'delta-1',
					label: 'Delta 1',
					isBackground: true,
					termId,
					startTime: Date.now(),
				});
				await new Promise(resolve => setTimeout(resolve, 500));

				const result = await executor(makeInput('call-d1', {
					id: 'delta-1',
					workspaceFolder: WORKSPACE,
				}));
				assert.strictEqual(result.success, true);
				// First poll should have full output (not "unchanged")
				assert.ok(!result.content.includes('unchanged'), `First poll should not say unchanged`);
				assert.ok(result.content.includes('delta_first_poll'), `First poll should contain output`);
			} finally {
				unregisterSession(SESSION_URI);
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});

		test('polling finished background task shows "unchanged"', async function () {
			this.timeout(DEFAULT_TIMEOUT);
			const manager = new TerminalManager(new NullLogService());
			const executor = createGetTaskOutputExecutor(logService, manager, SESSION_URI);

			try {
				const { termId } = await manager.execAsync(SESSION_URI, 'echo unchanged_test');
				registerTask(SESSION_URI, {
					workspaceFolder: WORKSPACE,
					taskId: 'delta-2',
					label: 'Delta 2',
					isBackground: true,
					termId,
					startTime: Date.now(),
				});

				await new Promise(resolve => setTimeout(resolve, 600));

				// First poll: cache snapshot
				await executor(makeInput('call-d2a', {
					id: 'delta-2',
					workspaceFolder: WORKSPACE,
				}));

				// Second poll: should be unchanged
				const result = await executor(makeInput('call-d2b', {
					id: 'delta-2',
					workspaceFolder: WORKSPACE,
				}));

				assert.strictEqual(result.success, true);
				assert.ok(result.content.includes('unchanged'), `Expected "unchanged" message, got: ${result.content.substring(0, 200)}`);
			} finally {
				unregisterSession(SESSION_URI);
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});
	});
});
