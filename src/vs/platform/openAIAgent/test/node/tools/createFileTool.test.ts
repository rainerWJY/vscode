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
import { TOOL_CREATE_FILE, createCreateFileExecutor } from '../../../node/tools/createFileTool.js';
import { AgentHostPathService } from '../../../node/services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../../../node/services/agentHostIgnoreService.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'create_file', parameters: params, cancellationToken };
}

const logService = new NullLogService();
const realPathService = new AgentHostPathService(logService);

/** Mock ignore service: nothing is ignored. */
const neverIgnoreService: IAgentHostIgnoreService = {
	isEnabled: true,
	init: async () => { },
	isIgnored: async (_uri: URI) => false,
	getIgnoreSummary: () => 'mock: nothing ignored',
	dispose: () => { },
};

/** Mock ignore service: everything is ignored. */
const alwaysIgnoreService: IAgentHostIgnoreService = {
	isEnabled: true,
	init: async () => { },
	isIgnored: async (_uri: URI) => true,
	getIgnoreSummary: () => 'mock: everything ignored',
	dispose: () => { },
};

/**
 * A minimal IFileService-like object backed by real fs.promises I/O.
 * Not declared as `implements IFileService` because that interface is extremely
 * large; we pass it to the executor with `as any`.
 */
class TestFileService {
	constructor() { }

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

	async writeFile(uri: URI, buffer: VSBuffer) {
		await fs.promises.mkdir(uri.fsPath.substring(0, uri.fsPath.lastIndexOf('/')), { recursive: true });
		await fs.promises.writeFile(uri.fsPath, buffer.buffer, 'utf-8');
		return this.stat(uri);
	}
}

// ---- temp directory helpers -------------------------------------------------

function initTempDir(): string {
	const dir = '/tmp/vscode_createfile_test_' + Date.now() + '_' + Math.random().toString(36).slice(2);
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

// ---- per-suite state (managed via setup/teardown hooks) ---------------------

/**
 * Helper: wraps a suite with temp-dir beforeEach/afterEach using
 * TDD-style `setup`/`teardown` globals (the VS Code test runner uses
 * the Mocha TDD interface: suite/test/setup/teardown).
 *
 * Returns an object with `dir` and `svc` that tests inside the callback
 * can use. Example:
 *
 *   withTempDir((ctx) => {
 *       suite('my suite', () => {
 *           test('example', () => {
 *               // ctx.dir, ctx.svc available
 *           });
 *       });
 *   });
 */
function withTempDir(fn: (ctx: { dir: string; svc: TestFileService }) => void): void {
	const ctx = {} as { dir: string; svc: TestFileService };
	setup(() => {
		ctx.dir = initTempDir();
		ctx.svc = new TestFileService();
	});
	teardown(() => {
		cleanTempDir(ctx.dir);
	});
	fn(ctx);
}

// ---- tests -----------------------------------------------------------------

suite('CreateFileTool', () => {

	suite('Tool definition', () => {

		test('has correct name', () => {
			assert.strictEqual(TOOL_CREATE_FILE.name, 'create_file');
		});

		test('has description', () => {
			assert.ok(TOOL_CREATE_FILE.description.length > 0);
		});

		test('is destructive', () => {
			assert.strictEqual(TOOL_CREATE_FILE.isDestructive, true);
		});

		test('has edit toolKind', () => {
			assert.strictEqual(TOOL_CREATE_FILE.toolKind, 'edit');
		});

		test('requires filePath and content parameters', () => {
			const params = TOOL_CREATE_FILE.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.filePath);
			assert.ok(props.content);
			const required = params.required as string[];
			assert.ok(required.includes('filePath'));
			assert.ok(required.includes('content'));
		});
	});

	withTempDir((ctx) => {
		suite('Input validation', () => {

			test('rejects missing filePath', async () => {
				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-1', { content: 'hello' }));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('filePath'));
			});

			test('rejects missing content', async () => {
				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-2', { filePath: '/tmp/some-file.ts' }));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('content'));
			});

			test('rejects empty content', async () => {
				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-3', { filePath: '/tmp/some-file.ts', content: '' }));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('content'));
			});

			test('rejects relative path', async () => {
				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-4', { filePath: 'relative/path.ts', content: 'some content' }));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('absolute path'));
			});
		});
	});

	withTempDir((ctx) => {
		suite('Cancellation', () => {

			test('returns cancellation when token is already cancelled', async () => {
				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-cancel', {
					filePath: '/tmp/any-file.ts',
					content: 'hello',
				}, CancellationToken.Cancelled));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('Cancellation requested'));
			});
		});
	});

	withTempDir((ctx) => {
		suite('File existence checks', () => {

			test('rejects when file already exists', async () => {
				const existingFile = ctx.dir + '/existing.ts';
				await fs.promises.writeFile(existingFile, 'existing content', 'utf-8');

				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-exists', {
					filePath: existingFile,
					content: 'new content',
				}));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('already exists'));
				assert.ok(result.content.includes('edit tool'));
			});
		});
	});

	withTempDir((ctx) => {
		suite('Ignore service filtering', () => {

			test('rejects when file is ignored', async () => {
				const ignoredFile = ctx.dir + '/ignored.ts';
				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, alwaysIgnoreService, logService);
				const result = await executor(makeInput('call-ignored', {
					filePath: ignoredFile,
					content: 'some content',
				}));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('ignored'));
			});
		});
	});

	withTempDir((ctx) => {
		suite('File creation (real filesystem)', () => {

			test('creates a new file successfully', async () => {
				const filePath = ctx.dir + '/hello.ts';
				const fileContent = 'console.log("hello world");\n';

				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-create-1', {
					filePath,
					content: fileContent,
				}));

				assert.strictEqual(result.success, true);
				assert.ok(result.content.includes('File written'));
				assert.ok(result.content.includes('hello.ts'));


				// Verify the file was actually written
				const written = await fs.promises.readFile(filePath, 'utf-8');
				assert.strictEqual(written, fileContent);
			});

			test('creates file with multi-line content', async () => {
				const filePath = ctx.dir + '/multiline.ts';
				const fileContent = [
					'// hello',
					'function greet() {',
					'  return "hello";',
					'}',
				].join('\n');

				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-create-2', {
					filePath,
					content: fileContent,
				}));

				assert.strictEqual(result.success, true);
				assert.ok(result.content.includes('4 lines'));


				const written = await fs.promises.readFile(filePath, 'utf-8');
				assert.strictEqual(written, fileContent);
			});

			test('creates file in a subdirectory', async () => {
				const subDir = ctx.dir + '/nested/deep/dir';
				const filePath = subDir + '/new-file.ts';
				const content = 'export const x = 1;';

				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-create-3', {
					filePath,
					content,
				}));

				assert.strictEqual(result.success, true);

				// Verify the directory and file were created
				const stat = await fs.promises.stat(filePath);
				assert.ok(stat.isFile());
				const written = await fs.promises.readFile(filePath, 'utf-8');
				assert.strictEqual(written, content);
			});

			test('creates file with empty lines content', async () => {
				const filePath = ctx.dir + '/empty-lines.ts';
				const content = '\n\n\n';

				const executor = createCreateFileExecutor(ctx.svc as any, realPathService, neverIgnoreService, logService);
				const result = await executor(makeInput('call-create-4', {
					filePath,
					content,
				}));

				assert.strictEqual(result.success, true);

				const written = await fs.promises.readFile(filePath, 'utf-8');
				assert.strictEqual(written, content);
			});
		});
	});
});
