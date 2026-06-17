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
import { TOOL_REPLACE_STRING, createReplaceStringExecutor } from '../../../node/tools/replaceStringTool.js';
import { AgentHostPathService } from '../../../node/services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../../../node/services/agentHostIgnoreService.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'replace_string_in_file', parameters: params, cancellationToken };
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
	const dir = '/tmp/vscode_replstr_test_' + Date.now() + '_' + Math.random().toString(36).slice(2);
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

suite('ReplaceStringTool', () => {

	test('has correct name', () => {
		assert.strictEqual(TOOL_REPLACE_STRING.name, 'replace_string_in_file');
	});

	test('has description', () => {
		assert.ok(TOOL_REPLACE_STRING.description.length > 0);
	});

	test('is destructive', () => {
		assert.strictEqual(TOOL_REPLACE_STRING.isDestructive, true);
	});

	test('has edit toolKind', () => {
		assert.strictEqual(TOOL_REPLACE_STRING.toolKind, 'edit');
	});

	test('requires filePath, oldString, newString', () => {
		const meta = TOOL_REPLACE_STRING;
		const required = meta.parameters.required as string[];
		assert.ok(required.includes('filePath'));
		assert.ok(required.includes('oldString'));
		assert.ok(required.includes('newString'));
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

		test('validates required parameters', async () => {
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('required'));
		});

		test('rejects invalid file path', async () => {
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: 'relative/path.txt', oldString: 'old', newString: 'new' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Invalid file path') || result.content.includes('absolute path'));
		});

		test('rejects non-existent file', async () => {
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/nonexistent.txt', oldString: 'old', newString: 'new' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('does not exist'));
		});

		test('creates new file when oldString is empty and file does not exist', async () => {
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/newfile.txt', oldString: '', newString: 'hello world' }));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('created') || result.content.includes('Created'));
			assert.strictEqual(readFile(dir, 'newfile.txt'), 'hello world');
			assert.ok(result.fileEdits);
			assert.strictEqual(result.fileEdits[0].operation, 'add');
		});

		test('performs basic replacement', async () => {
			writeFile(dir, 'test.txt', 'this is an oldString!');
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/test.txt', oldString: 'oldString', newString: 'newString' }));
			assert.strictEqual(result.success, true);
			assert.strictEqual(readFile(dir, 'test.txt'), 'this is an newString!');
			assert.ok(result.fileEdits);
			assert.strictEqual(result.fileEdits[0].operation, 'update');
		});

		test('performs multiline replacement', async () => {
			writeFile(dir, 'test.txt', 'line1\nline2\nline3');
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/test.txt', oldString: 'line1\nline2', newString: 'new1\nnew2' }));
			assert.strictEqual(result.success, true);
			assert.strictEqual(readFile(dir, 'test.txt'), 'new1\nnew2\nline3');
		});

		test('reports no-match error', async () => {
			writeFile(dir, 'test.txt', 'some text here');
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/test.txt', oldString: 'nonexistent', newString: 'replacement' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('[Error: NoMatch]') || result.content.includes('Could not find'));
		});

		test('reports multiple-matches error', async () => {
			writeFile(dir, 'test.txt', 'same\nsame\nother');
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/test.txt', oldString: 'same', newString: 'different' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('[Error: MultipleMatches]') || result.content.includes('Multiple'));
		});

		test('handles cancellation', async () => {
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-cancel', { filePath: dir + '/test.txt', oldString: 'old', newString: 'new' }, CancellationToken.Cancelled));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Cancellation'));
		});

		test('respects ignore rules', async () => {
			writeFile(dir, 'ignored.txt', 'content');
			const alwaysIgnore = { ...neverIgnoreService, isIgnored: async () => true };
			const executor = createReplaceStringExecutor(svc as any, realPathService, alwaysIgnore, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/ignored.txt', oldString: 'content', newString: 'new' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('ignored'));
		});

		test('output contains structured info for LLM', async () => {
			writeFile(dir, 'test.txt', 'old content here');
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/test.txt', oldString: 'old content here', newString: 'new content here' }));
			assert.strictEqual(result.success, true);
			// Should contain diff summary
			assert.ok(result.content.includes('[Edit: update]') || result.content.includes('Replaced'));
			assert.ok(result.content.includes('exact match') || result.content.includes('match'));
		});

		test('returns fileEdits on success', async () => {
			writeFile(dir, 'test.txt', 'old content');
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { filePath: dir + '/test.txt', oldString: 'old', newString: 'new' }));
			assert.ok(result.fileEdits);
			assert.strictEqual(result.fileEdits.length, 1);
			assert.strictEqual(result.fileEdits[0].operation, 'update');
			assert.ok(result.fileEdits[0].beforeContent);
			assert.ok(result.fileEdits[0].afterContent);
		});

		test('strips leading filepath comment from oldString', async () => {
			writeFile(dir, 'test.ts', 'const x = 1;');
			const executor = createReplaceStringExecutor(svc as any, realPathService, neverIgnoreService, logService);
			// Model adds // filepath: test.ts prefix to oldString + newString
			const result = await executor(makeInput('call-1', {
				filePath: dir + '/test.ts',
				oldString: '// filepath: test.ts\nconst x = 1;',
				newString: '// filepath: test.ts\nconst x = 2;',
			}));
			assert.strictEqual(result.success, true);
			assert.strictEqual(readFile(dir, 'test.ts'), 'const x = 2;');
		});
	});
});
