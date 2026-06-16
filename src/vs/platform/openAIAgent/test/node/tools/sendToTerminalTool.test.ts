/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TerminalManager } from '../../../node/services/agentHostTerminalManager.js';
import { createSendToTerminalExecutor } from '../../../node/tools/sendToTerminalTool.js';
import { createRunInTerminalExecutor } from '../../../node/tools/runInTerminalTool.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

const SESSION_URI = 'test-session:///test-session';

function makeInput(toolCallId: string, params: Record<string, unknown>): ToolInput {
	return { toolCallId, name: 'send_to_terminal', parameters: params };
}

suite('SendToTerminalTool', () => {

	const disposables = new DisposableStore();
	let manager: TerminalManager;
	let sendExecutor: ReturnType<typeof createSendToTerminalExecutor>;
	let runExecutor: ReturnType<typeof createRunInTerminalExecutor>;

	setup(() => {
		manager = disposables.add(new TerminalManager(new NullLogService()));
		sendExecutor = createSendToTerminalExecutor(new NullLogService(), manager, SESSION_URI);
		runExecutor = createRunInTerminalExecutor(new NullLogService(), manager, SESSION_URI);
	});

	teardown(() => {
		manager.disposeSession(SESSION_URI);
		disposables.clear();
	});

	test('returns error for missing id', async () => {
		const result = await sendExecutor(makeInput('call-1', { command: 'hello' }));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('id" parameter is required'));
	});

	test('returns error for nonexistent process', async () => {
		const result = await sendExecutor(makeInput('call-2', {
			id: '00000000-0000-0000-0000-000000000000',
			command: 'hello',
		}));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('No active terminal'));
	});

	test('sends text to running async process', async () => {
		// Start a long-running async process that reads stdin
		const runResult = await runExecutor(makeInput('run-1', {
			command: 'cat',
			explanation: 'Start cat to read stdin',
			goal: 'Test stdin',
			mode: 'async',
		}));
		assert.ok(runResult.success);

		// Extract termId
		const termIdMatch = runResult.content.match(/Terminal ID: (\S+)/);
		assert.ok(termIdMatch);

		// Give the process a moment to start
		await new Promise(resolve => setTimeout(resolve, 300));

		// Send text to the process
		const sendResult = await sendExecutor(makeInput('call-3', {
			id: termIdMatch[1],
			command: 'hello from test',
		}));
		assert.strictEqual(sendResult.success, true);
	});

	test('sends empty Enter when command is whitespace', async () => {
		const runResult = await runExecutor(makeInput('run-2', {
			command: 'cat',
			explanation: 'Start cat',
			goal: 'Test empty stdin',
			mode: 'async',
		}));
		assert.ok(runResult.success);

		const termIdMatch = runResult.content.match(/Terminal ID: (\S+)/);
		assert.ok(termIdMatch);

		// Give the process a moment to start
		await new Promise(resolve => setTimeout(resolve, 300));

		// Send whitespace (should send just Enter)
		const sendResult = await sendExecutor(makeInput('call-4', {
			id: termIdMatch[1],
			command: '',
		}));
		assert.strictEqual(sendResult.success, true);
	});

	test('waitForOutput polls for response', async () => {
		const runResult = await runExecutor(makeInput('run-3', {
			command: 'cat',
			explanation: 'Start cat',
			goal: 'Test waitForOutput',
			mode: 'async',
		}));
		assert.ok(runResult.success);

		const termIdMatch = runResult.content.match(/Terminal ID: (\S+)/);
		assert.ok(termIdMatch);

		// Give the process a moment to start
		await new Promise(resolve => setTimeout(resolve, 300));

		const sendResult = await sendExecutor(makeInput('call-5', {
			id: termIdMatch[1],
			command: 'hello wait',
			waitForOutput: true,
		}));
		assert.strictEqual(sendResult.success, true);
	});
});
