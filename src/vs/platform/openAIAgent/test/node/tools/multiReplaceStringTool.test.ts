/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TOOL_MULTI_REPLACE_STRING, createMultiReplaceStringExecutor } from '../../../node/tools/multiReplaceStringTool.js';
import { AgentHostPathService } from '../../../node/services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../../../node/services/agentHostIgnoreService.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'multi_replace_string_in_file', parameters: params, cancellationToken };
}

const logService = new NullLogService();
const realPathService = new AgentHostPathService(logService);

const neverIgnoreService: IAgentHostIgnoreService = {
	isEnabled: true, init: async () => { },
	isIgnored: async (_uri: URI) => false,
	getIgnoreSummary: () => 'mock',
	dispose: () => { },
};

class TestFileService {
	async stat(uri: URI) {
		const s = await fs.promises.stat(uri.fsPath);
		return {
			resource: uri, name: uri.fsPath.split('/').pop() || '',
			isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(),
			mtime: s.mtimeMs, ctime: s.ctimeMs, size: s.size,
			readonly: false, locked: false, children: undefined,
			etag: `"${s.mtimeMs}-${s.size}"`, executable: Boolean(s.mode & 0o111),
		};
	}
	async writeFile(uri: URI, buffer: VSBuffer) {
		await fs.promises.mkdir(uri.fsPath.substring(0, uri.fsPath.lastIndexOf('/')), { recursive: true });
		await fs.promises.writeFile(uri.fsPath, buffer.buffer, 'utf-8');
		return this.stat(uri);
	}
	async readFile(uri: URI) { return VSBuffer.fromString(await fs.promises.readFile(uri.fsPath, 'utf-8')); }
	async createFile(uri: URI, buffer: VSBuffer) {
		await fs.promises.mkdir(uri.fsPath.substring(0, uri.fsPath.lastIndexOf('/')), { recursive: true });
		await fs.promises.writeFile(uri.fsPath, buffer.buffer, 'utf-8');
		return this.stat(uri);
	}
}

function initTempDir(): string {
	const dir = '/tmp/vscode_multirepl_test_' + Date.now() + '_' + Math.random().toString(36).slice(2);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(dir: string, name: string, content: string): void {
	const fp = dir + '/' + name;
	fs.mkdirSync(fp.substring(0, fp.lastIndexOf('/')), { recursive: true });
	fs.writeFileSync(fp, content, 'utf-8');
}

function readFile(dir: string, name: string): string {
	return fs.readFileSync(dir + '/' + name, 'utf-8');
}

// ---- suite ----------------------------------------------------------------

suite('MultiReplaceStringTool', () => {

	test('has correct name', () => {
		assert.strictEqual(TOOL_MULTI_REPLACE_STRING.name, 'multi_replace_string_in_file');
	});

	test('has description', () => {
		assert.ok(TOOL_MULTI_REPLACE_STRING.description.length > 0);
	});

	test('is destructive', () => {
		assert.strictEqual(TOOL_MULTI_REPLACE_STRING.isDestructive, true);
	});

	test('has edit toolKind', () => {
		assert.strictEqual(TOOL_MULTI_REPLACE_STRING.toolKind, 'edit');
	});

	test('requires replacements array', () => {
		const meta = TOOL_MULTI_REPLACE_STRING;
		const required = meta.parameters.required as string[];
		assert.ok(required.includes('replacements'));
	});

	suite('executor', () => {

		let dir: string;
		let svc: TestFileService;

		setup(() => {
			dir = initTempDir();
			svc = new TestFileService();
		});

		teardown(() => {
			cleanTempDir(dir);
		});

		test('requires replacements array', async () => {
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('required'));
		});

		test('validates each replacement entry', async () => {
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { replacements: [{ filePath: dir + '/test.txt' }] }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('required'));
		});

		test('applies single replacement to one file', async () => {
			writeFile(dir, 'test.txt', 'hello world');
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {
				replacements: [{ filePath: dir + '/test.txt', oldString: 'world', newString: 'there' }]
			}));
			assert.strictEqual(result.success, true);
			assert.strictEqual(readFile(dir, 'test.txt'), 'hello there');
		});

		test('applies multiple replacements to one file sequentially', async () => {
			writeFile(dir, 'test.txt', 'a\nb\nc');
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {
				replacements: [
					{ filePath: dir + '/test.txt', oldString: 'a', newString: 'x' },
					{ filePath: dir + '/test.txt', oldString: 'c', newString: 'z' },
				]
			}));
			assert.strictEqual(result.success, true);
			assert.strictEqual(readFile(dir, 'test.txt'), 'x\nb\nz');
		});

		test('applies replacements to multiple files', async () => {
			writeFile(dir, 'f1.txt', 'hello');
			writeFile(dir, 'f2.txt', 'world');
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {
				replacements: [
					{ filePath: dir + '/f1.txt', oldString: 'hello', newString: 'hi' },
					{ filePath: dir + '/f2.txt', oldString: 'world', newString: 'there' },
				]
			}));
			assert.strictEqual(result.success, true);
			assert.strictEqual(readFile(dir, 'f1.txt'), 'hi');
			assert.strictEqual(readFile(dir, 'f2.txt'), 'there');
		});

		test('reports partial failure', async () => {
			writeFile(dir, 'f1.txt', 'hello');
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {
				replacements: [
					{ filePath: dir + '/f1.txt', oldString: 'hello', newString: 'hi' },
					{ filePath: dir + '/f1.txt', oldString: 'nonexistent', newString: 'new' },
				]
			}));
			assert.strictEqual(result.success, false);
			assert.strictEqual(readFile(dir, 'f1.txt'), 'hi'); // First edit still applied
		});

		test('creates new files via empty oldString', async () => {
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {
				replacements: [{ filePath: dir + '/newfile.txt', oldString: '', newString: 'new content' }]
			}));
			assert.strictEqual(result.success, true);
			assert.strictEqual(readFile(dir, 'newfile.txt'), 'new content');
		});

		test('handles cancellation', async () => {
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-cancel', { replacements: [{ filePath: 'x.txt', oldString: 'a', newString: 'b' }] }, CancellationToken.Cancelled));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Cancellation'));
		});

		test('respects ignore rules', async () => {
			writeFile(dir, 'ignored.txt', 'content');
			const alwaysIgnore = { ...neverIgnoreService, isIgnored: async () => true };
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, alwaysIgnore, logService);
			const result = await executor(makeInput('call-1', {
				replacements: [{ filePath: dir + '/ignored.txt', oldString: 'content', newString: 'new' }]
			}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('ignored'));
		});

		test('returns fileEdits on success', async () => {
			writeFile(dir, 'test.txt', 'old');
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {
				replacements: [{ filePath: dir + '/test.txt', oldString: 'old', newString: 'new' }]
			}));
			assert.ok(result.fileEdits);
			assert.strictEqual(result.fileEdits.length, 1);
			assert.strictEqual(result.fileEdits[0].operation, 'update');
		});

		test('output contains structured error info', async () => {
			writeFile(dir, 'test.txt', 'same\nsame');
			const executor = createMultiReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {
				replacements: [{ filePath: dir + '/test.txt', oldString: 'same', newString: 'different' }]
			}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('MultipleMatches') || result.content.includes('Multiple'));
		});
	});
});
