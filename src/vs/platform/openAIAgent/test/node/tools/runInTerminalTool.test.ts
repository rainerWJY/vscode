/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TerminalManager } from '../../../node/services/agentHostTerminalManager.js';
import { createRunInTerminalExecutor } from '../../../node/tools/runInTerminalTool.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

const SESSION_URI = 'test-session:///test-session';

function makeInput(toolCallId: string, params: Record<string, unknown>): ToolInput {
	return { toolCallId, name: 'run_in_terminal', parameters: params };
}

suite('RunInTerminalTool', () => {

	const disposables = new DisposableStore();
	let manager: TerminalManager;
	let executor: ReturnType<typeof createRunInTerminalExecutor>;

	setup(() => {
		manager = disposables.add(new TerminalManager(new NullLogService()));
		executor = createRunInTerminalExecutor(new NullLogService(), manager, SESSION_URI);
	});

	teardown(() => {
		manager.disposeSession(SESSION_URI);
		disposables.clear();
	});

	suite('Validation', () => {

		test('rejects empty command', async () => {
			const result = await executor(makeInput('call-1', { command: '' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('must be non-empty'));
		});

		test('rejects whitespace-only command', async () => {
			const result = await executor(makeInput('call-2', { command: '   ' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('must be non-empty'));
		});

		test('rejects missing command', async () => {
			const result = await executor(makeInput('call-3', { explanation: 'test', goal: 'test' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('must be non-empty'));
		});
	});

	suite('Sync mode', () => {

		test('executes simple command and returns output', async () => {
			const result = await executor(makeInput('call-4', {
				command: 'echo sync_works',
				explanation: 'Test sync mode',
				goal: 'Verify sync execution',
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('sync_works'));
		});

		test('returns stderr output on failure', async () => {
			// execSync only captures stderr when the command fails
			const result = await executor(makeInput('call-5', {
				command: 'echo stderr_test >&2 && exit 1',
				explanation: 'Test stderr',
				goal: 'Verify stderr handling',
			}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('stderr_test'));
		});

		test('returns non-zero exit code on error', async () => {
			const result = await executor(makeInput('call-6', {
				command: 'exit 42',
				explanation: 'Test failure',
				goal: 'Verify error handling',
			}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('42'));
		});

		test('persists cwd across commands', async () => {
			// Run cd first, then pwd — cwd should persist
			await executor(makeInput('call-7', {
				command: 'cd /tmp',
				explanation: 'Change directory',
				goal: 'Test cwd tracking',
			}));

			const result = await executor(makeInput('call-8', {
				command: 'pwd',
				explanation: 'Print working directory',
				goal: 'Test cwd persistence',
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.trim().endsWith('/tmp'));
		});
	});

	suite('Async mode', () => {

		test('returns termId for async command', async () => {
			const result = await executor(makeInput('call-9', {
				command: 'echo async_test',
				explanation: 'Test async mode',
				goal: 'Verify async execution',
				mode: 'async',
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('Terminal ID:'));
			assert.ok(result.content.includes('get_terminal_output'));
		});

		test('async mode with isBackground flag', async () => {
			const result = await executor(makeInput('call-10', {
				command: 'echo background_test',
				explanation: 'Test legacy background mode',
				goal: 'Verify isBackground support',
				isBackground: true,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('Terminal ID:'));
		});

		test('async output is retrievable via TerminalManager', async () => {
			const result = await executor(makeInput('call-11', {
				command: 'echo retrievable_test',
				explanation: 'Test output retrieval',
				goal: 'Verify async output',
				mode: 'async',
			}));

			// Extract termId from output
			const termIdMatch = result.content.match(/Terminal ID: (\S+)/);
			assert.ok(termIdMatch, 'Expected termId in output');

			await new Promise(resolve => setTimeout(resolve, 500));
			const output = manager.getOutput(SESSION_URI, termIdMatch[1]);
			assert.ok(output.output.includes('retrievable_test'));
		});
	});

	suite('Timeout', () => {

		test('respects custom timeout', async () => {
			const startTime = Date.now();
			const result = await executor(makeInput('call-12', {
				command: 'echo timeout_test',
				explanation: 'Test timeout',
				goal: 'Verify timeout parameter',
				timeout: 10000,
			}));
			const elapsed = Date.now() - startTime;
			assert.strictEqual(result.success, true);
			assert.ok(elapsed < 5000, 'Should complete well before the 10s timeout');
		});
	});
});
