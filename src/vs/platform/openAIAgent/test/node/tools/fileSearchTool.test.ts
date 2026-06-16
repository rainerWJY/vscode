/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execSync } from 'node:child_process';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentHostWorkingDirectory } from '../../../node/services/agentHostWorkingDirectory.js';
import { TOOL_FILE_SEARCH, createFileSearchExecutor, inputGlobToPattern, formatQueryLabel, RelativePattern } from '../../../node/tools/fileSearchTool.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'file_search', parameters: params, cancellationToken };
}

const logService = new NullLogService();

/**
 * Full path to the ripgrep binary bundled with @vscode/ripgrep-universal.
 */
const RG_BIN = '/Users/whisper/Downloads/project/vscode/node_modules/@vscode/ripgrep-universal/bin/darwin-arm64/rg';

/**
 * A known source file in the project to search for in integration tests.
 */
const TOOL_SOURCE_DIR = '/Users/whisper/Downloads/project/vscode/src/vs/platform/openAIAgent/node/tools';

/**
 * A known file path for use in absolute-path tests.
 */
const KNOWN_FILE_GLOB = '**/fileSearchTool.ts';

/**
 * Run ripgrep --files via execSync (shell) with the given args and glob pattern.
 * Returns { stdout, exitCode }.
 */
function rgExecFiles(globs: string[]): { stdout: string; exitCode: number } {
	const args = ['--files', '--no-require-git', '--follow', '--no-config'];
	for (const g of globs) {
		args.push('--glob', g);
	}
	const cmd = [RG_BIN, ...args].join(' ');
	try {
		const stdout = execSync(cmd, {
			cwd: TOOL_SOURCE_DIR,
			encoding: 'utf-8',
			timeout: 10_000,
			shell: process.env.SHELL || '/bin/sh',
			maxBuffer: 1024 * 1024,
		}) as string;
		return { stdout, exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: err.stdout || '',
			exitCode: err.status ?? 1,
		};
	}
}

// ---- tests -----------------------------------------------------------------

suite('FileSearchTool', () => {

	suite('Tool definition', () => {

		test('has correct name', () => {
			assert.strictEqual(TOOL_FILE_SEARCH.name, 'file_search');
		});

		test('has description', () => {
			assert.ok(TOOL_FILE_SEARCH.description.length > 0);
		});

		test('is not destructive', () => {
			assert.strictEqual(TOOL_FILE_SEARCH.isDestructive, false);
		});

		test('has search toolKind', () => {
			assert.strictEqual(TOOL_FILE_SEARCH.toolKind, 'search');
		});

		test('requires query parameter', () => {
			const params = TOOL_FILE_SEARCH.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.query);
			const required = params.required as string[];
			assert.ok(required.includes('query'));
		});

		test('has optional maxResults parameter', () => {
			const params = TOOL_FILE_SEARCH.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.maxResults);
		});
	});

	suite('Input validation', () => {

		test('rejects unsupported path property', async () => {
			const executor = createFileSearchExecutor(logService);
			const result = await executor(makeInput('call-1', { path: '/some/path' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('path'));
			assert.ok(result.content.includes('query'));
		});

		test('rejects missing query', async () => {
			const executor = createFileSearchExecutor(logService);
			const result = await executor(makeInput('call-2', {}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('query'));
		});

		test('rejects empty query string', async () => {
			const executor = createFileSearchExecutor(logService);
			const result = await executor(makeInput('call-3', { query: '' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('query'));
		});

		test('rejects non-string query', async () => {
			const executor = createFileSearchExecutor(logService);
			const result = await executor(makeInput('call-4', { query: 42 }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('query'));
		});
	});

	suite('Cancellation', () => {

		test('returns cancellation when token is already cancelled (no rg spawn)', async () => {
			const executor = createFileSearchExecutor(logService);
			const result = await executor(makeInput('call-cancel', {
				query: 'anything',
			}, CancellationToken.Cancelled));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Cancellation requested'));
		});
	});

	suite('inputGlobToPattern', () => {

		suite('No working directory', () => {

			test('simple query returns single string pattern', () => {
				const result = inputGlobToPattern('test/**/*.ts', undefined);
				assert.strictEqual(result.patterns.length, 1);
				assert.strictEqual(result.patterns[0], 'test/**/*.ts');
				assert.strictEqual(result.folderName, undefined);
				assert.strictEqual(result.folderRelativePattern, undefined);
			});

			test('absolute path without working directory stays string', () => {
				const result = inputGlobToPattern('/absolute/path/src/**', undefined);
				assert.strictEqual(result.patterns.length, 1);
				assert.strictEqual(result.patterns[0], '/absolute/path/src/**');
			});

			test('simple file name query', () => {
				const result = inputGlobToPattern('main.ts', undefined);
				assert.strictEqual(result.patterns.length, 1);
				assert.strictEqual(result.patterns[0], 'main.ts');
			});

			test('gpt-4.1 model adds extra pattern without working directory', () => {
				const result = inputGlobToPattern('src', undefined, 'gpt-4.1');
				assert.strictEqual(result.patterns.length, 2);
				assert.strictEqual(result.patterns[0], 'src');
				assert.strictEqual(result.patterns[1], 'src/**');
			});

			test('gpt-4.1 model does not duplicate when pattern already ends with /**', () => {
				const result = inputGlobToPattern('src/**', undefined, 'gpt-4.1');
				assert.strictEqual(result.patterns.length, 1);
				assert.strictEqual(result.patterns[0], 'src/**');
			});

			test('gpt-4.1 does not affect non-gpt-4.1 models', () => {
				const result = inputGlobToPattern('src/**', undefined, 'gpt-4o');
				assert.strictEqual(result.patterns.length, 1);
				assert.strictEqual(result.patterns[0], 'src/**');
			});
		});

		suite('With explicit working directory (agents window)', () => {

			const WORKSPACE = '/test/workspace';
			const wd = new AgentHostWorkingDirectory(URI.file(WORKSPACE));

			test('simple query scoped to working directory as RelativePattern', () => {
				const result = inputGlobToPattern('*.ts', wd);
				assert.strictEqual(result.patterns.length, 1);
				assert.ok(result.patterns[0] instanceof RelativePattern);
				const rp = result.patterns[0] as RelativePattern;
				assert.strictEqual(rp.pattern, '*.ts');
				assert.strictEqual(rp.baseUri.fsPath, WORKSPACE);
			});

			test('non-folder-name query also scoped (no multi-root detection with explicit wd)', () => {
				const result = inputGlobToPattern('other-folder/src/**', wd);
				assert.strictEqual(result.patterns.length, 1);
				assert.ok(result.patterns[0] instanceof RelativePattern);
				const rp = result.patterns[0] as RelativePattern;
				assert.strictEqual(rp.pattern, 'other-folder/src/**');
				assert.strictEqual(rp.baseUri.fsPath, WORKSPACE);
				// No folder name parsing with explicit wd
				assert.strictEqual(result.folderName, undefined);
				assert.strictEqual(result.folderRelativePattern, undefined);
			});

			test('pattern with wildcard in prefix scoped as RelativePattern', () => {
				const result = inputGlobToPattern('src-*/test', wd);
				assert.strictEqual(result.patterns.length, 1);
				assert.ok(result.patterns[0] instanceof RelativePattern);
				const rp = result.patterns[0] as RelativePattern;
				assert.strictEqual(rp.pattern, 'src-*/test');
				assert.strictEqual(rp.baseUri.fsPath, WORKSPACE);
			});

			test('absolute path within working directory returns RelativePattern', () => {
				const result = inputGlobToPattern(WORKSPACE + '/src/file.ts', wd);
				assert.strictEqual(result.patterns.length, 1);
				assert.ok(result.patterns[0] instanceof RelativePattern);
				const rp = result.patterns[0] as RelativePattern;
				assert.strictEqual(rp.pattern, 'src/file.ts');
				assert.strictEqual(rp.baseUri.fsPath, WORKSPACE);
			});

			test('absolute path outside working directory also scoped to wd', () => {
				// With explicit working directory, ALL string patterns are scoped
				const result = inputGlobToPattern('/other/path/file.ts', wd);
				assert.strictEqual(result.patterns.length, 1);
				assert.ok(result.patterns[0] instanceof RelativePattern);
				const rp = result.patterns[0] as RelativePattern;
				assert.strictEqual(rp.pattern, '/other/path/file.ts');
				assert.strictEqual(rp.baseUri.fsPath, WORKSPACE);
			});

			test('gpt-4.1 with simple query adds extra RelativePattern', () => {
				const result = inputGlobToPattern('src', wd, 'gpt-4.1');
				assert.strictEqual(result.patterns.length, 2);
				assert.ok(result.patterns[0] instanceof RelativePattern);
				assert.ok(result.patterns[1] instanceof RelativePattern);
				const rp0 = result.patterns[0] as RelativePattern;
				const rp1 = result.patterns[1] as RelativePattern;
				assert.strictEqual(rp0.pattern, 'src');
				assert.strictEqual(rp1.pattern, 'src/**');
			});

			test('gpt-4.1 does not duplicate when RelativePattern already ends with /**', () => {
				const result = inputGlobToPattern('src/**', wd, 'gpt-4.1');
				assert.strictEqual(result.patterns.length, 1);
				assert.ok(result.patterns[0] instanceof RelativePattern);
				const rp = result.patterns[0] as RelativePattern;
				assert.strictEqual(rp.pattern, 'src/**');
			});
		});

		suite('Working directory without fsPath', () => {

			test('handles undefined fsPath gracefully', () => {
				const wd = new AgentHostWorkingDirectory(undefined);
				const result = inputGlobToPattern('test/**/*.ts', wd);
				assert.strictEqual(result.patterns.length, 1);
				assert.strictEqual(result.patterns[0], 'test/**/*.ts');
			});
		});
	});

	suite('formatQueryLabel', () => {

		test('without folder returns raw query', () => {
			const result = formatQueryLabel({ patterns: ['src/**'], folderName: undefined, folderRelativePattern: undefined }, 'src/**');
			assert.strictEqual(result, '`src/**`');
		});

		test('with folder name and specific pattern shows both', () => {
			const result = formatQueryLabel({ patterns: [], folderName: 'myproject', folderRelativePattern: 'src/**' }, 'myproject/src/**');
			assert.strictEqual(result, '`myproject` · `src/**`');
		});

		test('with folder name but no specific pattern shows folder only', () => {
			const result = formatQueryLabel({ patterns: [], folderName: 'myproject', folderRelativePattern: undefined }, 'myproject');
			assert.strictEqual(result, '`myproject`');
		});

		test('with folder name and pattern ** shows folder only', () => {
			const result = formatQueryLabel({ patterns: [], folderName: 'myproject', folderRelativePattern: '**' }, 'myproject');
			assert.strictEqual(result, '`myproject`');
		});

		test('with empty folder name falls through to raw query', () => {
			const result = formatQueryLabel({ patterns: [], folderName: undefined, folderRelativePattern: undefined }, 'some/glob/**');
			assert.strictEqual(result, '`some/glob/**`');
		});
	});

	suite('Ripgrep integration (via execSync)', () => {

		test('rg --files with glob finds matching file', () => {
			const { stdout, exitCode } = rgExecFiles([KNOWN_FILE_GLOB]);
			assert.strictEqual(exitCode, 0);
			assert.ok(stdout.includes('fileSearchTool.ts'), `Expected fileSearchTool.ts in output, got: ${stdout.substring(0, 200)}`);
		});

		test('rg --files with restrictive glob returns no matches', () => {
			const { stdout, exitCode } = rgExecFiles(['**/XYZZY_NONEXISTENT_FILE_*.ts']);
			assert.strictEqual(exitCode, 1);
			assert.strictEqual(stdout.trim(), '');
		});

		test('rg --files with multiple globs returns union of matches', () => {
			const { stdout, exitCode } = rgExecFiles(['**/fileSearchTool.ts', '**/grepSearchTool.ts']);
			assert.strictEqual(exitCode, 0);
			assert.ok(stdout.includes('fileSearchTool.ts'));
			assert.ok(stdout.includes('grepSearchTool.ts'));
		});

		test('rg --files with simple file name pattern', () => {
			const { stdout, exitCode } = rgExecFiles(['**/*.ts']);
			assert.strictEqual(exitCode, 0);
			const lines = stdout.trim().split('\n').filter(Boolean);
			assert.ok(lines.length > 0, 'Expected at least one .ts file');
		});

		test('rg --files respects nested glob pattern', () => {
			const { stdout, exitCode } = rgExecFiles(['**/toolRegistry.ts']);
			assert.strictEqual(exitCode, 0);
			assert.ok(stdout.includes('toolRegistry.ts'));
		});
	});
});
