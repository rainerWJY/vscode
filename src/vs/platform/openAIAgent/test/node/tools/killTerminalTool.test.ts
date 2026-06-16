/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TerminalManager } from '../../../node/services/agentHostTerminalManager.js';
import { createKillTerminalExecutor } from '../../../node/tools/killTerminalTool.js';
import { createRunInTerminalExecutor } from '../../../node/tools/runInTerminalTool.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

const SESSION_URI = 'test-session:///test-session';

function makeInput(toolCallId: string, params: Record<string, unknown>): ToolInput {
	return { toolCallId, name: 'kill_terminal', parameters: params };
}

suite('KillTerminalTool', () => {

	const disposables = new DisposableStore();
	let manager: TerminalManager;
	let killExecutor: ReturnType<typeof createKillTerminalExecutor>;
	let runExecutor: ReturnType<typeof createRunInTerminalExecutor>;

	setup(() => {
		manager = disposables.add(new TerminalManager(new NullLogService()));
		killExecutor = createKillTerminalExecutor(new NullLogService(), manager, SESSION_URI);
		runExecutor = createRunInTerminalExecutor(new NullLogService(), manager, SESSION_URI);
	});

	teardown(() => {
		manager.disposeSession(SESSION_URI);
		disposables.clear();
	});

	test('returns error for missing id', async () => {
		const result = await killExecutor(makeInput('call-1', {}));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('id" parameter is required'));
	});

	test('returns error for nonexistent process', async () => {
		const result = await killExecutor(makeInput('call-2', {
			id: '00000000-0000-0000-0000-000000000000',
		}));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('No active terminal'));
	});

	test('kills a running background process', async () => {
		// Start a long-running process in async mode
		const runResult = await runExecutor(makeInput('run-1', {
			command: 'sleep 30',
			explanation: 'Start long process',
			goal: 'Test kill',
			mode: 'async',
		}));
		assert.ok(runResult.success);

		// Extract termId from the output
		const termIdMatch = runResult.content.match(/Terminal ID: (\S+)/);
		assert.ok(termIdMatch, 'Expected Terminal ID in run_in_terminal output');

		// Kill it
		const killResult = await killExecutor(makeInput('call-3', {
			id: termIdMatch[1],
		}));
		assert.strictEqual(killResult.success, true);
		assert.ok(killResult.content.includes('was killed'));

		// Verify the process is no longer running
		await new Promise(resolve => setTimeout(resolve, 300));
		const output = manager.getOutput(SESSION_URI, termIdMatch[1]);
		assert.strictEqual(output.isRunning, false);
	});

	test('returns last output before kill', async () => {
		const runResult = await runExecutor(makeInput('run-2', {
			command: 'echo prekill_output && sleep 30',
			explanation: 'Start process with output',
			goal: 'Test output preservation',
			mode: 'async',
		}));
		assert.ok(runResult.success);

		const termIdMatch = runResult.content.match(/Terminal ID: (\S+)/);
		assert.ok(termIdMatch);

		await new Promise(resolve => setTimeout(resolve, 500));

		const killResult = await killExecutor(makeInput('call-4', {
			id: termIdMatch[1],
		}));
		assert.strictEqual(killResult.success, true);
		assert.ok(killResult.content.includes('prekill_output'));
	});
});
