/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { registerTask, getTask, unregisterTask, unregisterSession } from '../../../node/tools/taskRegistry.js';

const SESSION_A = 'session:///a';
const SESSION_B = 'session:///b';
const WS = '/workspace';
const TASK_ID = 'my-task';
const LABEL = 'My Task';

suite('TaskRegistry', () => {

	teardown(() => {
		// Clean up all sessions after each test
		unregisterSession(SESSION_A);
		unregisterSession(SESSION_B);
	});

	test('register and get a task', () => {
		registerTask(SESSION_A, {
			workspaceFolder: WS,
			taskId: TASK_ID,
			label: LABEL,
			isBackground: false,
			startTime: Date.now(),
			exitCode: 0,
		});

		const record = getTask(SESSION_A, WS, TASK_ID);
		assert.ok(record);
		assert.strictEqual(record.label, LABEL);
		assert.strictEqual(record.isBackground, false);
		assert.strictEqual(record.exitCode, 0);
	});

	test('register a background task with termId', () => {
		registerTask(SESSION_A, {
			workspaceFolder: WS,
			taskId: TASK_ID,
			label: LABEL,
			isBackground: true,
			termId: 'abc-123',
			startTime: Date.now(),
		});

		const record = getTask(SESSION_A, WS, TASK_ID);
		assert.ok(record);
		assert.strictEqual(record.isBackground, true);
		assert.strictEqual(record.termId, 'abc-123');
		assert.strictEqual(record.exitCode, undefined); // still running
	});

	test('getTask returns undefined for unknown task', () => {
		const record = getTask(SESSION_A, WS, 'nonexistent');
		assert.strictEqual(record, undefined);
	});

	test('getTask returns undefined for wrong session', () => {
		registerTask(SESSION_A, {
			workspaceFolder: WS,
			taskId: TASK_ID,
			label: LABEL,
			isBackground: false,
			startTime: Date.now(),
		});

		const record = getTask(SESSION_B, WS, TASK_ID);
		assert.strictEqual(record, undefined);
	});

	test('getTask returns undefined for wrong workspaceFolder', () => {
		registerTask(SESSION_A, {
			workspaceFolder: '/other-ws',
			taskId: TASK_ID,
			label: LABEL,
			isBackground: false,
			startTime: Date.now(),
		});

		const record = getTask(SESSION_A, WS, TASK_ID);
		assert.strictEqual(record, undefined);
	});

	test('unregisterTask removes a task', () => {
		registerTask(SESSION_A, {
			workspaceFolder: WS,
			taskId: TASK_ID,
			label: LABEL,
			isBackground: false,
			startTime: Date.now(),
		});

		assert.ok(getTask(SESSION_A, WS, TASK_ID));
		unregisterTask(SESSION_A, WS, TASK_ID);
		assert.strictEqual(getTask(SESSION_A, WS, TASK_ID), undefined);
	});

	test('unregisterSession removes all tasks for a session', () => {
		registerTask(SESSION_A, {
			workspaceFolder: WS,
			taskId: 'task-1',
			label: 'Task 1',
			isBackground: false,
			startTime: Date.now(),
		});
		registerTask(SESSION_A, {
			workspaceFolder: WS,
			taskId: 'task-2',
			label: 'Task 2',
			isBackground: false,
			startTime: Date.now(),
		});
		registerTask(SESSION_B, {
			workspaceFolder: WS,
			taskId: 'task-b',
			label: 'Task B',
			isBackground: false,
			startTime: Date.now(),
		});

		unregisterSession(SESSION_A);

		assert.strictEqual(getTask(SESSION_A, WS, 'task-1'), undefined);
		assert.strictEqual(getTask(SESSION_A, WS, 'task-2'), undefined);
		// Session B should be untouched
		assert.ok(getTask(SESSION_B, WS, 'task-b'));
	});

	test('overwrite existing task', () => {
		registerTask(SESSION_A, {
			workspaceFolder: WS,
			taskId: TASK_ID,
			label: 'Old Label',
			isBackground: false,
			startTime: 100,
		});

		registerTask(SESSION_A, {
			workspaceFolder: WS,
			taskId: TASK_ID,
			label: 'New Label',
			isBackground: true,
			termId: 'xyz-789',
			startTime: 200,
		});

		const record = getTask(SESSION_A, WS, TASK_ID);
		assert.ok(record);
		assert.strictEqual(record.label, 'New Label');
		assert.strictEqual(record.isBackground, true);
		assert.strictEqual(record.termId, 'xyz-789');
	});

	test('supports same taskId under different workspaceFolders', () => {
		registerTask(SESSION_A, {
			workspaceFolder: '/ws1',
			taskId: TASK_ID,
			label: 'WS1 Task',
			isBackground: false,
			startTime: 100,
		});
		registerTask(SESSION_A, {
			workspaceFolder: '/ws2',
			taskId: TASK_ID,
			label: 'WS2 Task',
			isBackground: true,
			startTime: 200,
		});

		const ws1 = getTask(SESSION_A, '/ws1', TASK_ID);
		const ws2 = getTask(SESSION_A, '/ws2', TASK_ID);
		assert.ok(ws1);
		assert.ok(ws2);
		assert.strictEqual(ws1.label, 'WS1 Task');
		assert.strictEqual(ws2.label, 'WS2 Task');
		assert.strictEqual(ws1.isBackground, false);
		assert.strictEqual(ws2.isBackground, true);
	});
});
