/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TOOL_LIST_DIR, createListDirExecutor } from '../../../node/tools/listDirTool.js';
import { AgentHostFileSystemService, FileType } from '../../../node/services/agentHostFileSystemService.js';
import { AgentHostPathService } from '../../../node/services/agentHostPathService.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';
import type { IFileService, FileSystemProviderCapabilities, IFileSystemProviderRegistrationEvent, IFileSystemProviderCapabilitiesChangeEvent, IFileSystemProviderActivationEvent, IFileSystemProvider, FileChangesEvent, FileOperationEvent, IResolveMetadataFileOptions, IResolveFileOptions, IFileStatWithMetadata, IFileStat, IFileStatResult } from '../../../../files/common/files.js';

// ---- minimal IFileService stub (AgentHostFileSystemService's readDirectory
//      uses fs.promises directly, but the constructor requires IFileService) ---

const stubFileService: IFileService = {
	_serviceBrand: undefined,
	onDidChangeFileSystemProviderRegistrations: Event.None,
	onDidChangeFileSystemProviderCapabilities: Event.None,
	onWillActivateFileSystemProvider: Event.None,
	onDidFilesChange: Event.None,
	onDidRunOperation: Event.None,
	registerProvider: (_scheme: string, _provider: IFileSystemProvider): IDisposable => ({ dispose: () => { } }),
	getProvider: (_scheme: string) => undefined,
	activateProvider: async () => { },
	canHandleResource: async () => false,
	hasProvider: () => false,
	hasCapability: () => false,
	listCapabilities: () => [],
	resolve: (_resource: URI, _options?: IResolveFileOptions | IResolveMetadataFileOptions): Promise<IFileStat | IFileStatWithMetadata> => { throw new Error('not implemented'); },
	resolveAll: (_toResolve: { resource: URI; options?: IResolveFileOptions | IResolveMetadataFileOptions }[]): Promise<IFileStatResult[]> => { throw new Error('not implemented'); },
	stat: async () => { throw new Error('not implemented'); },
	readFile: async () => { throw new Error('not implemented'); },
	writeFile: async () => { throw new Error('not implemented'); },
	createFile: async () => { throw new Error('not implemented'); },
	createFolder: async () => { throw new Error('not implemented'); },
	move: async () => { throw new Error('not implemented'); },
	copy: async () => { throw new Error('not implemented'); },
	del: async () => { throw new Error('not implemented'); },
	watch: () => { throw new Error('not implemented'); },
	dispose: () => { },
};

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'list_dir', parameters: params, cancellationToken };
}

const logService = new NullLogService();

/** Shared real service instances (stateless for read-only ops). */
const realFsService = new AgentHostFileSystemService(stubFileService, logService);
const realPathService = new AgentHostPathService(logService);

// ---- tests -----------------------------------------------------------------

suite('ListDirTool', () => {

	suite('Tool definition', () => {

		test('has correct name', () => {
			assert.strictEqual(TOOL_LIST_DIR.name, 'list_dir');
		});

		test('has description', () => {
			assert.ok(TOOL_LIST_DIR.description.length > 0);
		});

		test('is not destructive', () => {
			assert.strictEqual(TOOL_LIST_DIR.isDestructive, false);
		});

		test('has read toolKind', () => {
			assert.strictEqual(TOOL_LIST_DIR.toolKind, 'read');
		});

		test('requires path parameter', () => {
			const params = TOOL_LIST_DIR.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.path);
			const required = params.required as string[];
			assert.ok(required.includes('path'));
		});
	});

	suite('Input validation', () => {

		test('rejects missing path', async () => {
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-1', {}));
			assert.strictEqual(result.success, false);
			// The executor passes undefined to pathService.resolveFilePath,
			// which throws TypeError caught by the executor's catch handler.
			assert.ok(result.content.toLowerCase().includes('error'), `Expected error, got: ${result.content}`);
		});

		test('rejects relative path', async () => {
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-2', { path: 'relative/path' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.toLowerCase().includes('absolute') || result.content.toLowerCase().includes('path'));
		});

		test('returns cancellation when token is already cancelled', async () => {
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-cancel', {
				path: '/tmp',
			}, CancellationToken.Cancelled));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Cancellation requested'));
		});

		test('rejects empty path string', async () => {
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-empty', { path: '' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.toLowerCase().includes('path'));
		});
	});

	suite('Directory listing (real filesystem)', () => {

		const TOOLS_DIR = '/Users/whisper/Downloads/project/vscode/src/vs/platform/openAIAgent/node/tools';

		test('lists files in tools folder', async () => {
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-ls-1', {
				path: TOOLS_DIR,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('listDirTool.ts'), 'Expected listDirTool.ts');
			assert.ok(result.content.includes('toolRegistry.ts'), 'Expected toolRegistry.ts');
		});

		test('appends / to directory entries at project root', async () => {
			const ROOT = '/Users/whisper/Downloads/project/vscode';
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-ls-2', {
				path: ROOT,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('src/'), 'Expected src/ directory with trailing slash');
			assert.ok(result.content.includes('package.json'), 'Expected package.json');
		});

		test('src directory lists vs/ as a subfolder', async () => {
			const SRC = '/Users/whisper/Downloads/project/vscode/src';
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-ls-3', {
				path: SRC,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('vs/'), 'Expected vs/ directory with trailing slash');
		});

		test('non-existent directory returns error', async () => {
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-ls-4', {
				path: '/tmp/__nonexistent_vscode_test_dir_xyz__',
			}));
			assert.strictEqual(result.success, false);
		});

		test('file path instead of directory returns error', async () => {
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-ls-5', {
				path: '/Users/whisper/Downloads/project/vscode/package.json',
			}));
			// reading a file as directory should fail
			assert.strictEqual(result.success, false);
		});
	});

	suite('Edge cases (temp directories)', () => {

		test('empty directory returns "Folder is empty"', async () => {
			const tmpDir = '/tmp/vscode_list_dir_test_' + Date.now() + '_' + Math.random();
			await fs.promises.mkdir(tmpDir, { recursive: true });
			try {
				const executor = createListDirExecutor(realFsService, realPathService, logService);
				const result = await executor(makeInput('call-edge-1', {
					path: tmpDir,
				}));
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.content, 'Folder is empty');
			} finally {
				await fs.promises.rmdir(tmpDir).catch(() => { });
			}
		});

		test('directory with single file returns that file', async () => {
			const tmpDir = '/tmp/vscode_list_dir_test_' + Date.now() + '_' + Math.random();
			await fs.promises.mkdir(tmpDir, { recursive: true });
			await fs.promises.writeFile(tmpDir + '/hello.txt', 'test content');
			try {
				const executor = createListDirExecutor(realFsService, realPathService, logService);
				const result = await executor(makeInput('call-edge-2', {
					path: tmpDir,
				}));
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.content, 'hello.txt');
			} finally {
				await fs.promises.rm(tmpDir + '/hello.txt').catch(() => { });
				await fs.promises.rmdir(tmpDir).catch(() => { });
			}
		});

		test('lists file from URI path (file:// scheme)', async () => {
			const executor = createListDirExecutor(realFsService, realPathService, logService);
			const result = await executor(makeInput('call-edge-3', {
				path: 'file:///Users/whisper/Downloads/project/vscode/src/vs/platform/openAIAgent/node/tools',
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('listDirTool.ts'), 'Expected listDirTool.ts via file:// URI');
		});
	});
});
