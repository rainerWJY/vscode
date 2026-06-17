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
import { TOOL_APPLY_PATCH, createApplyPatchExecutor } from '../../../node/tools/applyPatchTool.js';
import { AgentHostPathService } from '../../../node/services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../../../node/services/agentHostIgnoreService.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'apply_patch', parameters: params, cancellationToken };
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
	async del(uri: URI) { await fs.promises.rm(uri.fsPath, { recursive: true, force: true }); }
}

function initTempDir(): string {
	const dir = '/tmp/vscode_applypatch_test_' + Date.now() + '_' + Math.random().toString(36).slice(2);
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

function makePatch(opts: { add?: string; delete?: string; update?: Record<string, { before: string; after: string; moveTo?: string }> }): string {
	const lines: string[] = ['*** Begin Patch'];
	if (opts.add) {
		lines.push(`*** Add File: ${opts.add}`);
		lines.push('+ content');
	}
	if (opts.delete) {
		lines.push(`*** Delete File: ${opts.delete}`);
	}
	if (opts.update) {
		for (const [path, change] of Object.entries(opts.update)) {
			lines.push(`*** Update File: ${path}`);
			if (change.moveTo) {
				lines.push(`*** Move to: ${change.moveTo}`);
			}
			if (change.before) {
				lines.push(`- ${change.before}`);
			}
			lines.push(`+ ${change.after}`);
		}
	}
	lines.push('*** End Patch');
	return lines.join('\n');
}

// ---- suite ----------------------------------------------------------------

suite('ApplyPatchTool', () => {

	test('has correct name', () => {
		assert.strictEqual(TOOL_APPLY_PATCH.name, 'apply_patch');
	});

	test('has description', () => {
		assert.ok(TOOL_APPLY_PATCH.description.length > 0);
	});

	test('is destructive', () => {
		assert.strictEqual(TOOL_APPLY_PATCH.isDestructive, true);
	});

	test('has edit toolKind', () => {
		assert.strictEqual(TOOL_APPLY_PATCH.toolKind, 'edit');
	});

	test('requires input parameter', () => {
		const meta = TOOL_APPLY_PATCH;
		const required = meta.parameters.required as string[];
		assert.ok(required.includes('input'));
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

		test('requires input parameter', async () => {
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', {}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('required'));
		});

		test('creates a file', async () => {
			const patch = makePatch({ add: dir + '/newfile.txt' });
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { input: patch }));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('Created'));
			assert.strictEqual(readFile(dir, 'newfile.txt'), ' content');
		});

		test('deletes a file', async () => {
			writeFile(dir, 'todelete.txt', 'content');
			const patch = makePatch({ delete: dir + '/todelete.txt' });
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { input: patch }));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('Deleted'));
			assert.strictEqual(fs.existsSync(dir + '/todelete.txt'), false);
		});

		test('updates a file', async () => {
			writeFile(dir, 'file.ts', 'old code');
			const patch = makePatch({ update: { [dir + '/file.ts']: { before: 'old code', after: 'new code' } } });
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { input: patch }));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('Updated'));
			assert.strictEqual(readFile(dir, 'file.ts'), ' new code');
		});

		test('moves a file', async () => {
			writeFile(dir, 'old.ts', 'content');
			const patch = makePatch({ update: { [dir + '/old.ts']: { before: 'content', after: 'content', moveTo: dir + '/new.ts' } } });
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { input: patch }));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('moved'));
			assert.strictEqual(fs.existsSync(dir + '/old.ts'), false);
			assert.strictEqual(readFile(dir, 'new.ts'), ' content');
		});

		test('performs add + update in a single patch', async () => {
			writeFile(dir, 'existing.ts', 'old');
			const patch = [
				'*** Begin Patch',
				'*** Add File: ' + dir + '/new.ts',
				'+ new content',
				'*** Update File: ' + dir + '/existing.ts',
				'- old',
				'+ updated',
				'*** End Patch',
			].join('\n');
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { input: patch }));
			assert.strictEqual(result.success, true);
			assert.strictEqual(readFile(dir, 'new.ts'), ' new content');
			assert.strictEqual(readFile(dir, 'existing.ts'), ' updated');
		});

		test('handles cancellation', async () => {
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-cancel', { input: '*** Begin Patch\n*** End Patch' }, CancellationToken.Cancelled));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Cancellation'));
		});

		test('respects ignore rules', async () => {
			writeFile(dir, 'ignored.txt', 'content');
			const patch = makePatch({ update: { [dir + '/ignored.txt']: { before: 'content', after: 'new' } } });
			const alwaysIgnore = { ...neverIgnoreService, isIgnored: async () => true };
			const executor = createApplyPatchExecutor(svc as any, realPathService, alwaysIgnore, logService);
			const result = await executor(makeInput('call-1', { input: patch }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('ignored'));
		});

		test('returns fileEdits on success', async () => {
			writeFile(dir, 'file.ts', 'old');
			const patch = makePatch({ update: { [dir + '/file.ts']: { before: 'old', after: 'new' } } });
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { input: patch }));
			assert.ok(result.fileEdits);
			assert.ok(result.fileEdits.length > 0);
		});

		test('reports invalid patch format', async () => {
			const executor = createApplyPatchExecutor(svc as any, realPathService, neverIgnoreService, logService);
			const result = await executor(makeInput('call-1', { input: 'not a valid patch' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Failed'));
		});
	});
});
