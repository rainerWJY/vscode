/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TerminalManager } from '../../../node/services/agentHostTerminalManager.js';
import { TOOL_CREATE_AND_RUN_TASK, createCreateAndRunTaskExecutor } from '../../../node/tools/createAndRunTaskTool.js';
import { getTask, unregisterSession } from '../../../node/tools/taskRegistry.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

const SESSION_URI = 'test-session:///create-and-run-task-test';
const logService = new NullLogService();

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'create_and_run_task', parameters: params, cancellationToken };
}

function initTempDir(): string {
	const dir = '/tmp/vscode_createandrun_test_' + Date.now() + '_' + Math.random().toString(36).slice(2);
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

/**
 * A minimal IFileService-like object backed by real fs.promises I/O.
 */
class TestFileService {
	async stat(uri: URI) {
		const s = await fs.promises.stat(uri.fsPath);
		return {
			resource: uri,
			name: uri.fsPath.split('/').pop() || '',
			isFile: s.isFile(),
			isDirectory: s.isDirectory(),
			isSymbolicLink: s.isSymbolicLink(),
			mtime: s.mtimeMs,
			ctime: s.ctimeMs,
			size: s.size,
			readonly: false,
			locked: false,
			children: undefined,
			etag: `"${s.mtimeMs}-${s.size}"`,
			executable: Boolean(s.mode & 0o111),
		};
	}

	async exists(uri: URI): Promise<boolean> {
		try {
			await fs.promises.access(uri.fsPath);
			return true;
		} catch {
			return false;
		}
	}

	async readFile(uri: URI) {
		const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
		return { value: VSBuffer.fromString(content) };
	}

	async createFile(uri: URI, buffer: VSBuffer) {
		const dir = uri.fsPath.substring(0, uri.fsPath.lastIndexOf('/'));
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(uri.fsPath, buffer.buffer, 'utf-8');
		return this.stat(uri);
	}

	async writeFile(uri: URI, buffer: VSBuffer) {
		const dir = uri.fsPath.substring(0, uri.fsPath.lastIndexOf('/'));
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(uri.fsPath, buffer.buffer, 'utf-8');
		return this.stat(uri);
	}
}

/** Helper: wraps a suite with temp-dir setup/teardown + manager setup/teardown. */
function withFixture(fn: (ctx: { dir: string; svc: TestFileService; manager: TerminalManager; disposables: DisposableStore }) => void): void {
	const ctx = {} as { dir: string; svc: TestFileService; manager: TerminalManager; disposables: DisposableStore };
	setup(() => {
		ctx.dir = initTempDir();
		ctx.svc = new TestFileService();
		ctx.disposables = new DisposableStore();
		ctx.manager = ctx.disposables.add(new TerminalManager(new NullLogService()));
	});
	teardown(() => {
		unregisterSession(SESSION_URI);
		ctx.manager.disposeSession(SESSION_URI);
		ctx.disposables.clear();
		cleanTempDir(ctx.dir);
	});
	fn(ctx);
}

// ---- tests ------------------------------------------------------------------

suite('CreateAndRunTaskTool', () => {

	suite('Tool definition', () => {

		test('has correct name', () => {
			assert.strictEqual(TOOL_CREATE_AND_RUN_TASK.name, 'create_and_run_task');
		});

		test('has description', () => {
			assert.ok(TOOL_CREATE_AND_RUN_TASK.description.length > 0);
		});

		test('is destructive', () => {
			assert.strictEqual(TOOL_CREATE_AND_RUN_TASK.isDestructive, true);
		});

		test('has task toolKind', () => {
			assert.strictEqual(TOOL_CREATE_AND_RUN_TASK.toolKind, 'task');
		});

		test('requires task and workspaceFolder parameters', () => {
			const params = TOOL_CREATE_AND_RUN_TASK.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.task);
			assert.ok(props.workspaceFolder);
			const required = params.required as string[];
			assert.ok(required.includes('task'));
			assert.ok(required.includes('workspaceFolder'));
		});
	});

	suite('Input validation', () => {

		test('rejects missing task', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createCreateAndRunTaskExecutor(new TestFileService() as any, logService, manager, SESSION_URI);
			try {
				const result = await executor(makeInput('call-1', { workspaceFolder: '/tmp' }));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('task.label'));
			} finally {
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});

		test('rejects missing workspaceFolder', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createCreateAndRunTaskExecutor(new TestFileService() as any, logService, manager, SESSION_URI);
			try {
				const result = await executor(makeInput('call-2', {
					task: { label: 'test', type: 'shell', command: 'echo hi' },
				}));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('workspaceFolder'));
			} finally {
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});

		test('rejects missing label', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createCreateAndRunTaskExecutor(new TestFileService() as any, logService, manager, SESSION_URI);
			try {
				const result = await executor(makeInput('call-3', {
					workspaceFolder: '/tmp',
					task: { type: 'shell', command: 'echo hi' },
				}));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('task.label'));
			} finally {
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});

		test('rejects missing command', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createCreateAndRunTaskExecutor(new TestFileService() as any, logService, manager, SESSION_URI);
			try {
				const result = await executor(makeInput('call-4', {
					workspaceFolder: '/tmp',
					task: { label: 'test', type: 'shell' },
				}));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('command'));
			} finally {
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});
	});

	suite('Cancellation', () => {

		test('returns cancellation when token is already cancelled', async () => {
			const manager = new TerminalManager(new NullLogService());
			const executor = createCreateAndRunTaskExecutor(new TestFileService() as any, logService, manager, SESSION_URI);
			try {
				const result = await executor(makeInput('call-cancel', {
					workspaceFolder: '/tmp',
					task: { label: 'test', type: 'shell', command: 'echo hi' },
				}, CancellationToken.Cancelled));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('Cancellation requested'));
			} finally {
				manager.disposeSession(SESSION_URI);
				manager.dispose();
			}
		});
	});

	suite('Standard task (sync exec)', () => {

		withFixture((ctx) => {

			test('creates tasks.json and runs a simple command', async () => {
				const executor = createCreateAndRunTaskExecutor(ctx.svc as any, logService, ctx.manager, SESSION_URI);

				const result = await executor(makeInput('call-sync-1', {
					workspaceFolder: ctx.dir,
					task: { label: 'echo-task', type: 'shell', command: 'echo hello_sync' },
				}));

				assert.strictEqual(result.success, true);
				assert.ok(result.content.includes('hello_sync'));

				// Verify tasks.json was created
				const tasksJsonPath = ctx.dir + '/.vscode/tasks.json';
				assert.ok(fs.existsSync(tasksJsonPath), 'tasks.json should exist');
			});

			test('registers task in registry after execution', async () => {
				const executor = createCreateAndRunTaskExecutor(ctx.svc as any, logService, ctx.manager, SESSION_URI);

				await executor(makeInput('call-sync-2', {
					workspaceFolder: ctx.dir,
					task: { label: 'registry-task', type: 'shell', command: 'echo registered' },
				}));

				const record = getTask(SESSION_URI, ctx.dir, 'registry-task');
				assert.ok(record, 'Task should be registered');
				assert.strictEqual(record.isBackground, false);
				assert.strictEqual(record.exitCode, 0);
			});

			test('handles task with args', async () => {
				const executor = createCreateAndRunTaskExecutor(ctx.svc as any, logService, ctx.manager, SESSION_URI);

				const result = await executor(makeInput('call-sync-3', {
					workspaceFolder: ctx.dir,
					task: { label: 'args-task', type: 'shell', command: 'echo', args: ['argA', 'argB'] },
				}));

				assert.strictEqual(result.success, true);
				assert.ok(result.content.includes('argA'));
				assert.ok(result.content.includes('argB'));
			});

			test('appends task to existing tasks.json', async () => {
				const executor = createCreateAndRunTaskExecutor(ctx.svc as any, logService, ctx.manager, SESSION_URI);

				// First task
				await executor(makeInput('call-sync-4a', {
					workspaceFolder: ctx.dir,
					task: { label: 'first-task', type: 'shell', command: 'echo first' },
				}));

				// Second task
				await executor(makeInput('call-sync-4b', {
					workspaceFolder: ctx.dir,
					task: { label: 'second-task', type: 'shell', command: 'echo second' },
				}));

				const tasksJson = JSON.parse(fs.readFileSync(ctx.dir + '/.vscode/tasks.json', 'utf-8'));
				assert.strictEqual(tasksJson.tasks.length, 2);
				assert.strictEqual(tasksJson.tasks[0].label, 'first-task');
				assert.strictEqual(tasksJson.tasks[1].label, 'second-task');
			});
		});
	});

	suite('Background task (async exec)', () => {

		withFixture((ctx) => {

			test('starts background task and returns termId', async () => {
				const executor = createCreateAndRunTaskExecutor(ctx.svc as any, logService, ctx.manager, SESSION_URI);

				const result = await executor(makeInput('call-bg-1', {
					workspaceFolder: ctx.dir,
					task: { label: 'bg-task', type: 'shell', command: 'echo background_started', isBackground: true },
				}));

				assert.strictEqual(result.success, true);
				assert.ok(result.content.includes('Terminal ID:'), `Expected "Terminal ID:" in output, got: ${result.content.substring(0, 200)}`);
				assert.ok(result.content.includes('get_terminal_output'), `Expected "get_terminal_output" hint, got: ${result.content.substring(0, 200)}`);
			});

			test('registers background task in registry with termId', async () => {
				const executor = createCreateAndRunTaskExecutor(ctx.svc as any, logService, ctx.manager, SESSION_URI);

				await executor(makeInput('call-bg-2', {
					workspaceFolder: ctx.dir,
					task: { label: 'bg-reg-task', type: 'shell', command: 'echo bg_registered', isBackground: true },
				}));

				const record = getTask(SESSION_URI, ctx.dir, 'bg-reg-task');
				assert.ok(record, 'Background task should be registered');
				assert.strictEqual(record.isBackground, true);
				assert.ok(record.termId, 'Background task should have a termId');
				assert.strictEqual(record.exitCode, undefined); // still running
			});

			test('background task output is retrievable via terminal manager', async function () {
				this.timeout(30000);
				const executor = createCreateAndRunTaskExecutor(ctx.svc as any, logService, ctx.manager, SESSION_URI);

				const result = await executor(makeInput('call-bg-3', {
					workspaceFolder: ctx.dir,
					task: { label: 'bg-echo', type: 'shell', command: 'echo bg_output_test', isBackground: true },
				}));

				assert.strictEqual(result.success, true);

				// Extract termId from output
				const termIdMatch = result.content.match(/Terminal ID: (\S+)/);
				assert.ok(termIdMatch, 'Expected termId in output');

				// Wait for process output
				await new Promise(resolve => setTimeout(resolve, 600));

				// Verify output via terminal manager
				const output = ctx.manager.getOutput(SESSION_URI, termIdMatch[1]);
				assert.ok(output.output.includes('bg_output_test'), `Expected "bg_output_test" in terminal output, got: ${output.output}`);
			});

			test('creates tasks.json for background task', async () => {
				const executor = createCreateAndRunTaskExecutor(ctx.svc as any, logService, ctx.manager, SESSION_URI);

				await executor(makeInput('call-bg-4', {
					workspaceFolder: ctx.dir,
					task: { label: 'bg-json-task', type: 'shell', command: 'echo bg_json', isBackground: true },
				}));

				const tasksJsonPath = ctx.dir + '/.vscode/tasks.json';
				assert.ok(fs.existsSync(tasksJsonPath), 'tasks.json should exist');
				const tasksJson = JSON.parse(fs.readFileSync(tasksJsonPath, 'utf-8'));
				assert.strictEqual(tasksJson.tasks.length, 1);
				assert.strictEqual(tasksJson.tasks[0].isBackground, true);
			});
		});
	});
});
