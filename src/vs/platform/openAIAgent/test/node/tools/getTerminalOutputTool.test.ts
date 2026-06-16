/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TerminalManager } from '../../../node/services/agentHostTerminalManager.js';
import { createGetTerminalOutputExecutor } from '../../../node/tools/getTerminalOutputTool.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

const SESSION_URI = 'test-session:///test-session';

function makeInput(toolCallId: string, params: Record<string, unknown>): ToolInput {
	return { toolCallId, name: 'get_terminal_output', parameters: params };
}

suite('GetTerminalOutputTool', () => {

	const disposables = new DisposableStore();
	let manager: TerminalManager;
	let executor: ReturnType<typeof createGetTerminalOutputExecutor>;

	setup(() => {
		manager = disposables.add(new TerminalManager(new NullLogService()));
		executor = createGetTerminalOutputExecutor(new NullLogService(), manager, SESSION_URI);
	});

	teardown(async () => {
		// Clean up any remaining processes
		manager.disposeSession(SESSION_URI);
		disposables.clear();
	});

	test('returns error for missing id', async () => {
		const result = await executor(makeInput('call-1', {}));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('must be provided'));
	});

	test('returns error for unknown termId', async () => {
		const result = await executor(makeInput('call-2', { id: '00000000-0000-0000-0000-000000000000' }));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('No active terminal execution'));
	});

	test('returns full output on first poll after async command', async () => {
		const asyncResult = await manager.execAsync(SESSION_URI, 'echo first_poll_test_output');
		await new Promise(resolve => setTimeout(resolve, 500));

		const result = await executor(makeInput('call-3', { id: asyncResult.termId }));
		assert.strictEqual(result.success, true);
		assert.ok(result.content.includes('first_poll_test_output'));
		assert.ok(result.content.includes('Output of terminal'));
	});

	test('returns delta on subsequent poll with new output', async () => {
		// Use sync for simpler testing: write output, poll, write more, poll again
		// This tests the delta diffing code path via the snapshot mechanism
		const asyncResult = await manager.execAsync(SESSION_URI, 'echo line1 && sleep 1 && echo line2');
		await new Promise(resolve => setTimeout(resolve, 200));

		// First poll — should get "line1"
		const poll1 = await executor(makeInput('call-4', { id: asyncResult.termId }));
		assert.ok(poll1.success);
		assert.ok(poll1.content.includes('line1'));

		// Wait for line2
		await new Promise(resolve => setTimeout(resolve, 1500));

		// Second poll — should get "line2" as delta
		const poll2 = await executor(makeInput('call-5', { id: asyncResult.termId }));
		assert.ok(poll2.success);
		assert.ok(poll2.content.includes('new characters'));
	});

	test('returns unchanged message when no new output', async () => {
		// Use sleep to keep the process alive between polls so snapshot is preserved
		const asyncResult = await manager.execAsync(SESSION_URI, 'echo first_line && sleep 5 && echo second_line');
		await new Promise(resolve => setTimeout(resolve, 300));

		// First poll consumes initial output
		const poll1 = await executor(makeInput('call-6', { id: asyncResult.termId }));
		assert.ok(poll1.success);

		// Poll again immediately — output should be unchanged (process still running, no new output)
		await new Promise(resolve => setTimeout(resolve, 100));
		const poll2 = await executor(makeInput('call-7', { id: asyncResult.termId }));
		assert.ok(poll2.success);
		assert.ok(poll2.content.includes('unchanged since previous poll'));
	});

	test('shows inputDetected when process is waiting', async () => {
		// Start a process that prompts for input
		const asyncResult = await manager.execAsync(SESSION_URI, 'read -p "Enter name: " name && echo got $name');
		await new Promise(resolve => setTimeout(resolve, 500));

		const result = await executor(makeInput('call-8', { id: asyncResult.termId }));
		assert.ok(result.success);

		// The "Enter name: " prompt may trigger the input detection pattern
		const output = manager.getOutput(SESSION_URI, asyncResult.termId);
		if (output.inputDetected) {
			assert.ok(result.content.includes('waiting for input'));
		}
	});

	test('shows exit code for completed process', async () => {
		const asyncResult = await manager.execAsync(SESSION_URI, 'echo exit_test && exit 0');
		await new Promise(resolve => setTimeout(resolve, 500));

		const result = await executor(makeInput('call-9', { id: asyncResult.termId }));
		assert.ok(result.success);
		assert.ok(result.content.includes('Process exited with code'));
	});
});
