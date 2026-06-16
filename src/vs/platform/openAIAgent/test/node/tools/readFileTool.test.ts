/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../../base/common/map.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TOOL_READ_FILE, createReadFileExecutor } from '../../../node/tools/readFileTool.js';
import { AgentHostFileSystemService } from '../../../node/services/agentHostFileSystemService.js';
import { AgentHostPathService } from '../../../node/services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../../../node/services/agentHostIgnoreService.js';
import type { IAgentHostInstructionsService } from '../../../node/services/agentHostInstructionsService.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'read_file', parameters: params, cancellationToken };
}

// ---- minimal IFileService stub (AgentHostFileSystemService's readFile uses
//      fs.promises directly, but the constructor requires IFileService) -------

const stubFileService = {
	_serviceBrand: undefined,
	onDidChangeFileSystemProviderRegistrations: Event.None,
	onDidChangeFileSystemProviderCapabilities: Event.None,
	onWillActivateFileSystemProvider: Event.None,
	onDidFilesChange: Event.None,
	onDidRunOperation: Event.None,
	registerProvider: (_scheme: string, _provider: any): IDisposable => ({ dispose: () => { } }),
	getProvider: (_scheme: string) => undefined,
	activateProvider: async () => { },
	canHandleResource: async () => false,
	hasProvider: () => false,
	hasCapability: () => false,
	listCapabilities: () => [],
	resolve: async () => { throw new Error('not implemented'); },
	resolveAll: async () => { throw new Error('not implemented'); },
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

// ---- mock services ----------------------------------------------------------

const logService = new NullLogService();
const realFsService = new AgentHostFileSystemService(stubFileService as any, logService);
const realPathService = new AgentHostPathService(logService);

/** Mock ignore service: nothing is ignored */
const neverIgnoreService: IAgentHostIgnoreService = {
	isEnabled: true,
	init: async () => { },
	isIgnored: async (_uri: URI) => false,
	getIgnoreSummary: () => 'mock: nothing ignored',
	dispose: () => { },
};

/** Mock instructions service: no skill info */
const noSkillInstructionsService: IAgentHostInstructionsService = {
	_serviceBrand: undefined,
	fetchInstructionsFromSetting: async () => [],
	fetchInstructionsFromFile: async () => undefined,
	getAgentInstructions: async () => [],
	parseInstructionIndexFile: () => ({
		instructions: new ResourceSet(),
		skills: new ResourceSet(),
		skillFolders: new ResourceSet(),
		agents: new Set<string>(),
	}),
	isExternalInstructionsFile: async () => false,
	isExternalInstructionsFolder: () => false,
	isSkillFile: () => false,
	isSkillMdFile: () => false,
	getSkillDirectory: () => undefined,
	getSkillName: () => undefined,
	getSkillInfo: () => undefined,
	getExtensionSkillInfo: () => undefined,
	refreshExtensionPromptFiles: async () => { },
	isAgentFile: () => false,
};

// ---- test data directory ---------------------------------------------------

const TEST_DATA_DIR = '/tmp/vscode_readfile_test_' + Date.now();

async function setupTestData(): Promise<void> {
	await fs.promises.mkdir(TEST_DATA_DIR, { recursive: true });

	// 5-line file (like Copilot's file.ts)
	await fs.promises.writeFile(TEST_DATA_DIR + '/file.ts', 'line 1\nline 2\n\nline 4\nline 5');

	// Empty file
	await fs.promises.writeFile(TEST_DATA_DIR + '/empty.ts', '');

	// Whitespace-only file
	await fs.promises.writeFile(TEST_DATA_DIR + '/whitespace.ts', ' \t\n');

	// Single-line file
	await fs.promises.writeFile(TEST_DATA_DIR + '/single.ts', 'single line');

	// Large file: 3000 lines (exceeds MAX_LINES_PER_READ = 2000)
	const largeContent = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
	await fs.promises.writeFile(TEST_DATA_DIR + '/large.ts', largeContent);

	// Long lines file: lines with 2500 chars each
	const longLine = 'x'.repeat(2500);
	const longLinesContent = `normal line\n${longLine}\nanother normal line\n${longLine}`;
	await fs.promises.writeFile(TEST_DATA_DIR + '/longlines.ts', longLinesContent);

	// Binary file: write some raw bytes including null byte
	const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
	await fs.promises.writeFile(TEST_DATA_DIR + '/binary.bin', binaryContent);
}

async function teardownTestData(): Promise<void> {
	await fs.promises.rm(TEST_DATA_DIR, { recursive: true, force: true });
}

// ---- tests -----------------------------------------------------------------

suite('ReadFileTool', () => {

	let testDir: string;

	suiteSetup(async () => {
		await setupTestData();
		testDir = TEST_DATA_DIR;
	});

	suiteTeardown(async () => {
		await teardownTestData();
	});

	suite('Tool definition', () => {

		test('has correct name', () => {
			assert.strictEqual(TOOL_READ_FILE.name, 'read_file');
		});

		test('has description', () => {
			assert.ok(TOOL_READ_FILE.description.length > 0);
		});

		test('is not destructive', () => {
			assert.strictEqual(TOOL_READ_FILE.isDestructive, false);
		});

		test('has read toolKind', () => {
			assert.strictEqual(TOOL_READ_FILE.toolKind, 'read');
		});

		test('requires filePath parameter', () => {
			const params = TOOL_READ_FILE.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.filePath);
			const required = params.required as string[];
			assert.ok(required.includes('filePath'));
		});

		test('has all optional parameters', () => {
			const params = TOOL_READ_FILE.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.offset);
			assert.ok(props.limit);
			assert.ok(props.startLine);
			assert.ok(props.endLine);
		});
	});

	suite('Input validation', () => {

		test('rejects missing filePath', async () => {
			const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);
			const result = await executor(makeInput('call-1', {}));
			assert.strictEqual(result.success, false);
		});

		test('rejects relative path', async () => {
			const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);
			const result = await executor(makeInput('call-2', { filePath: 'relative/path.ts' }));
			assert.strictEqual(result.success, false);
		});

		test('returns cancellation when token is already cancelled', async () => {
			const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);
			const result = await executor(makeInput('call-cancel', {
				filePath: testDir + '/file.ts',
			}, CancellationToken.Cancelled));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Cancellation requested'));
		});
	});

	suite('V1 parameters (startLine/endLine)', () => {

		const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);

		test('read simple file', async () => {
			const result = await executor(makeInput('call-v1-1', {
				filePath: testDir + '/file.ts',
				startLine: 2,
				endLine: 6,
			}));
			assert.strictEqual(result.success, true);
			// Should contain lines 2-5 (endLine is inclusive)
			assert.ok(result.content.includes('line 2'));
			assert.ok(result.content.includes('line 4'));
			assert.ok(result.content.includes('line 5'));
		});

		test('read empty file returns empty file message', async () => {
			const result = await executor(makeInput('call-v1-2', {
				filePath: testDir + '/empty.ts',
				startLine: 2,
				endLine: 6,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('empty'));
		});

		test('read whitespace file returns whitespace message', async () => {
			const result = await executor(makeInput('call-v1-3', {
				filePath: testDir + '/whitespace.ts',
				startLine: 2,
				endLine: 6,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('whitespace'));
		});
	});

	suite('V2 parameters (offset/limit)', () => {

		const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);

		test('read simple file with offset and limit', async () => {
			const result = await executor(makeInput('call-v2-1', {
				filePath: testDir + '/file.ts',
				offset: 2,
				limit: 4,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('line 2'));
			assert.ok(result.content.includes('line 4'));
			assert.ok(result.content.includes('line 5'));
		});

		test('read simple file with only offset', async () => {
			const result = await executor(makeInput('call-v2-2', {
				filePath: testDir + '/file.ts',
				offset: 3,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('line 4'));
			assert.ok(result.content.includes('line 5'));
		});

		test('read simple file without offset or limit reads entire file', async () => {
			const result = await executor(makeInput('call-v2-3', {
				filePath: testDir + '/file.ts',
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('line 1'));
			assert.ok(result.content.includes('line 5'));
		});

		test('read empty file with V2 returns empty message', async () => {
			const result = await executor(makeInput('call-v2-4', {
				filePath: testDir + '/empty.ts',
				offset: 1,
				limit: 4,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('empty'));
		});

		test('read whitespace file with V2 returns whitespace message', async () => {
			const result = await executor(makeInput('call-v2-5', {
				filePath: testDir + '/whitespace.ts',
				offset: 1,
				limit: 2,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('whitespace'));
		});
	});

	suite('Truncation', () => {

		const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);

		test('read file with limit larger than MAX_LINES_PER_READ (2000) truncates', async () => {
			const result = await executor(makeInput('call-trunc-1', {
				filePath: testDir + '/large.ts',
				offset: 1,
				limit: 3000,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('line 1'));
			assert.ok(result.content.includes('line 2000'));
			assert.ok(result.content.includes('truncated at line 2000'));
			assert.ok(!result.content.includes('line 2001'));
		});

		test('long lines are truncated with [truncated] notice', async () => {
			const result = await executor(makeInput('call-trunc-2', {
				filePath: testDir + '/longlines.ts',
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('normal line'));
			assert.ok(result.content.includes('[truncated]'));
			assert.ok(result.content.includes('truncated at 2000 characters'));
			// Truncated lines should be shorter than the original 2500
			const lines = result.content.split('\n');
			for (const l of lines) {
				if (l.includes('xxxxx')) {
					assert.ok(l.length < 2500, `Truncated line should be < 2500 chars, got ${l.length}`);
				}
			}
		});
	});

	suite('Offset bounds checking', () => {

		const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);

		test('offset beyond file line count throws error', async () => {
			const result = await executor(makeInput('call-bound-1', {
				filePath: testDir + '/file.ts',
				offset: 535,
			}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Invalid offset') || result.content.includes('5 lines'));
		});

		test('offset beyond single-line file throws error with singular "line"', async () => {
			const result = await executor(makeInput('call-bound-2', {
				filePath: testDir + '/single.ts',
				offset: 2,
			}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('1 line'));
		});

		test('offset exactly at line count succeeds', async () => {
			const result = await executor(makeInput('call-bound-3', {
				filePath: testDir + '/file.ts',
				offset: 5,
				limit: 1,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('line 5'));
		});

		test('offset 0 clamps to line 1', async () => {
			const result = await executor(makeInput('call-bound-4', {
				filePath: testDir + '/file.ts',
				offset: 0,
				limit: 2,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('line 1'));
		});

		test('read with limit of 1 returns single line', async () => {
			const result = await executor(makeInput('call-bound-5', {
				filePath: testDir + '/file.ts',
				offset: 2,
				limit: 1,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('line 2'));
			assert.ok(!result.content.includes('line 3'));
		});
	});

	suite('Binary file', () => {

		const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);

		test('binary file returns hexdump', async () => {
			const result = await executor(makeInput('call-bin-1', {
				filePath: testDir + '/binary.bin',
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('Binary file'));
			assert.ok(result.content.includes('00 01 02'));
			assert.ok(result.content.includes('Hello'));
		});

		test('binary file with byte range', async () => {
			const result = await executor(makeInput('call-bin-2', {
				filePath: testDir + '/binary.bin',
				offset: 3,
				limit: 5,
			}));
			assert.strictEqual(result.success, true);
			assert.ok(result.content.includes('Binary file'));
			// Should show bytes 3-7 (offset=3, limit=5 → bytes 3-7)
			assert.ok(result.content.includes('Hello'));
		});
	});

	suite('Error handling', () => {

		const executor = createReadFileExecutor(realFsService, realPathService, neverIgnoreService, noSkillInstructionsService, logService);

		test('non-existent file returns error', async () => {
			const result = await executor(makeInput('call-err-1', {
				filePath: '/tmp/__nonexistent_file_xyz__',
			}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.toLowerCase().includes('error') || result.content.includes('ENOENT'));
		});

		test('image file returns suggestion to use view_image', async () => {
			const imgPath = testDir + '/test.png';
			// Create a minimal valid PNG
			const minimalPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
			await fs.promises.writeFile(imgPath, minimalPng);
			try {
				const result = await executor(makeInput('call-err-2', {
					filePath: imgPath,
				}));
				assert.strictEqual(result.success, false);
				assert.ok(result.content.includes('view_image'));
			} finally {
				await fs.promises.rm(imgPath).catch(() => { });
			}
		});
	});
});
