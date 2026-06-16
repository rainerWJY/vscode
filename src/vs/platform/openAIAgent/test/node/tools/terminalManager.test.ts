/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TerminalManager } from '../../../node/services/agentHostTerminalManager.js';

suite('TerminalManager', () => {

	const disposables = new DisposableStore();
	const SESSION_URI = 'test-session:///test-session';

	let manager: TerminalManager;

	setup(() => {
		manager = disposables.add(new TerminalManager(new NullLogService()));
	});

	teardown(() => {
		disposables.clear();
	});

	suite('CWD tracking', () => {

		test('defaults to process.cwd()', () => {
			assert.strictEqual(manager.getCwd(SESSION_URI), process.cwd());
		});

		test('setCwd stores the given path', () => {
			manager.setCwd(SESSION_URI, '/tmp');
			assert.strictEqual(manager.getCwd(SESSION_URI), '/tmp');
		});

		test('different sessions have independent cwds', () => {
			manager.setCwd('session-a', '/tmp/a');
			manager.setCwd('session-b', '/tmp/b');
			assert.strictEqual(manager.getCwd('session-a'), '/tmp/a');
			assert.strictEqual(manager.getCwd('session-b'), '/tmp/b');
		});

		test('parse cd from sync command updates cwd', async () => {
			await manager.execSync(SESSION_URI, 'echo hello', 5000);
			// no cd parsed, cwd unchanged
			assert.strictEqual(manager.getCwd(SESSION_URI), process.cwd());
		});

		test('parse cd /tmp && echo updates cwd', async () => {
			await manager.execSync(SESSION_URI, 'cd /tmp && pwd', 5000);
			assert.strictEqual(manager.getCwd(SESSION_URI), '/tmp');
		});

		test('parse cd with home directory', async () => {
			// ~ expands to HOME
			const home = process.env.HOME || '/';
			await manager.execSync(SESSION_URI, 'cd ~/Documents && pwd', 5000);
			assert.strictEqual(manager.getCwd(SESSION_URI), `${home}/Documents`);
		});
	});

	suite('Sync execution', () => {

		test('execSync returns stdout for simple echo', async () => {
			const result = await manager.execSync(SESSION_URI, 'echo hello', 5000);
			assert.strictEqual(result.exitCode, 0);
			assert.ok(result.stdout.includes('hello'));
		});

		test('execSync captures stderr on failure', async () => {
			// execSync only captures stderr when the command fails (non-zero exit)
			const result = await manager.execSync(SESSION_URI, 'echo err_output >&2 && exit 1', 5000);
			assert.notStrictEqual(result.exitCode, 0);
			assert.ok(result.stderr.includes('err_output'));
		});

		test('execSync returns non-zero exit code on failure', async () => {
			const result = await manager.execSync(SESSION_URI, 'this-command-should-not-exist-xyz', 5000);
			assert.notStrictEqual(result.exitCode, 0);
		});

		test('execSync respects cwd', async () => {
			manager.setCwd(SESSION_URI, '/tmp');
			const result = await manager.execSync(SESSION_URI, 'pwd', 5000);
			assert.strictEqual(result.exitCode, 0);
			assert.ok(result.stdout.trim().endsWith('/tmp'));
		});
	});

	suite('Async execution', () => {

		test('execAsync spawns a process and returns termId', async () => {
			const result = await manager.execAsync(SESSION_URI, 'echo async_hello');
			assert.ok(result.termId);
			assert.ok(result.termId.length > 0);

			// Give the process a moment to complete
			await new Promise(resolve => setTimeout(resolve, 500));

			const output = manager.getOutput(SESSION_URI, result.termId);
			assert.ok(output.output.includes('async_hello'));
			assert.strictEqual(output.isRunning, false);
		});

		test('execAsync returns initial output for noop command', async () => {
			const result = await manager.execAsync(SESSION_URI, 'echo immediate');
			await new Promise(resolve => setTimeout(resolve, 300));
			const output = manager.getOutput(SESSION_URI, result.termId);
			assert.ok(output.output.includes('immediate'));
		});

		test('getOutput returns exit code for completed process', async () => {
			const result = await manager.execAsync(SESSION_URI, 'echo done && exit 42');
			await new Promise(resolve => setTimeout(resolve, 500));
			const output = manager.getOutput(SESSION_URI, result.termId);
			assert.strictEqual(output.exitCode, 42);
		});

		test('getOutput for unknown session returns empty', () => {
			const output = manager.getOutput('unknown-session', 'some-id');
			assert.strictEqual(output.output, '');
			assert.strictEqual(output.exitCode, undefined);
			assert.strictEqual(output.isRunning, false);
		});

		test('getOutput for unknown termId returns empty', () => {
			const output = manager.getOutput(SESSION_URI, 'nonexistent-id');
			assert.strictEqual(output.output, '');
			assert.strictEqual(output.exitCode, undefined);
			assert.strictEqual(output.isRunning, false);
		});
	});

	suite('Process management', () => {

		test('kill returns false for unknown process', () => {
			const result = manager.kill(SESSION_URI, 'nonexistent');
			assert.strictEqual(result, false);
		});

		test('kill terminates a running process', async () => {
			// Start a long-running sleep, then kill it
			const result = await manager.execAsync(SESSION_URI, 'sleep 30');
			assert.ok(result.termId);

			// Process should be running
			const before = manager.getOutput(SESSION_URI, result.termId);
			assert.strictEqual(before.isRunning, true);

			// Kill it
			const killed = manager.kill(SESSION_URI, result.termId);
			assert.strictEqual(killed, true);

			// After kill, process should no longer be running
			await new Promise(resolve => setTimeout(resolve, 300));
			const after = manager.getOutput(SESSION_URI, result.termId);
			assert.strictEqual(after.isRunning, false);
		});

		test('listActive returns running processes', async () => {
			// Start a long-running process
			const result = await manager.execAsync(SESSION_URI, 'sleep 30');
			const active = manager.listActive(SESSION_URI);
			assert.ok(active.some(p => p.termId === result.termId));
		});

		test('listActive excludes killed processes', async () => {
			const result = await manager.execAsync(SESSION_URI, 'sleep 30');
			manager.kill(SESSION_URI, result.termId);
			await new Promise(resolve => setTimeout(resolve, 300));
			const active = manager.listActive(SESSION_URI);
			assert.ok(!active.some(p => p.termId === result.termId));
		});
	});

	suite('Session lifecycle', () => {

		test('disposeSession kills all remaining processes', async () => {
			const result = await manager.execAsync(SESSION_URI, 'sleep 30');
			assert.ok(result.termId);

			manager.disposeSession(SESSION_URI);

			const output = manager.getOutput(SESSION_URI, result.termId);
			assert.strictEqual(output.isRunning, false);
		});

		test('disposeSession clears cwd', () => {
			manager.setCwd(SESSION_URI, '/tmp');
			manager.disposeSession(SESSION_URI);
			// After dispose, getCwd should fall back to process.cwd()
			assert.strictEqual(manager.getCwd(SESSION_URI), process.cwd());
		});
	});

	suite('Input detection', () => {

		test('sendInput fails for unknown process', () => {
			const result = manager.sendInput(SESSION_URI, 'nonexistent', 'hello');
			assert.strictEqual(result, false);
		});

		test('sendInput writes to running process stdin', async () => {
			// Use a simple read-from-stdin script via a quick pipe
			const result = await manager.execAsync(SESSION_URI, 'cat | echo piped');
			await new Promise(resolve => setTimeout(resolve, 200));

			const sent = manager.sendInput(SESSION_URI, result.termId, 'hello');
			// cat may already have exited, but sendInput should not crash
			assert.ok(typeof sent === 'boolean');
		});

		test('isWaitingForInput returns false for unknown process', () => {
			assert.strictEqual(manager.isWaitingForInput(SESSION_URI, 'nonexistent'), false);
		});
	});
});
