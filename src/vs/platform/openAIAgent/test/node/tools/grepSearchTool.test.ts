/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execSync } from 'node:child_process';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TOOL_GREP_SEARCH, buildRgArgs, createGrepSearchExecutor } from '../../../node/tools/grepSearchTool.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'grep_search', parameters: params, cancellationToken };
}

/**
 * Full path to the ripgrep binary bundled with @vscode/ripgrep-universal.
 */
const RG_BIN = '/Users/whisper/Downloads/project/vscode/node_modules/@vscode/ripgrep-universal/bin/darwin-arm64/rg';

/**
 * A known file in the project that we search in integration tests.
 * Using a direct file path (no glob) avoids Node.js v24 spawn + cwd hangs.
 */
const TOOL_SOURCE = 'src/vs/platform/openAIAgent/node/tools/grepSearchTool.ts';

/**
 * Run ripgrep via execSync (shell) with the given args, pattern, and file paths.
 * The pattern is quoted to prevent shell interpretation of special chars (|, &, etc.).
 * Returns { stdout, exitCode }.
 */
function rgExec(args: string[], pattern: string, ...files: string[]): { stdout: string; exitCode: number } {
	// Single-quote the pattern to protect against shell expansion (|, &, $, etc.)
	const quotedPattern = `'${pattern.replace(/'/g, "'\\''")}'`;
	const cmd = [RG_BIN, ...args, '--', quotedPattern, ...files].join(' ');
	try {
		const stdout = execSync(cmd, {
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

suite('GrepSearchTool', () => {

	suite('Tool definition', () => {

		test('has correct name', () => {
			assert.strictEqual(TOOL_GREP_SEARCH.name, 'grep_search');
		});

		test('has description', () => {
			assert.ok(TOOL_GREP_SEARCH.description.length > 0);
		});

		test('is not destructive', () => {
			assert.strictEqual(TOOL_GREP_SEARCH.isDestructive, false);
		});

		test('has search toolKind', () => {
			assert.strictEqual(TOOL_GREP_SEARCH.toolKind, 'search');
		});

		test('requires query parameter', () => {
			const params = TOOL_GREP_SEARCH.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.query);
			const required = params.required as string[];
			assert.ok(required.includes('query'));
		});

		test('has all expected parameters', () => {
			const params = TOOL_GREP_SEARCH.parameters as Record<string, unknown>;
			const props = params.properties as Record<string, unknown>;
			assert.ok(props.query);
			assert.ok(props.isRegexp);
			assert.ok(props.includePattern);
			assert.ok(props.maxResults);
			assert.ok(props.includeIgnoredFiles);
		});
	});

	suite('Input validation', () => {

		const logService = new NullLogService();

		test('rejects unsupported pattern property', async () => {
			const executor = createGrepSearchExecutor(undefined as any, logService);
			const result = await executor(makeInput('call-1', { pattern: 'foo' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('pattern'));
			assert.ok(result.content.includes('query'));
		});

		test('rejects missing query', async () => {
			const executor = createGrepSearchExecutor(undefined as any, logService);
			const result = await executor(makeInput('call-2', {}));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('query is required'));
		});

		test('rejects empty query string', async () => {
			const executor = createGrepSearchExecutor(undefined as any, logService);
			const result = await executor(makeInput('call-3', { query: '' }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('query is required'));
		});

		test('rejects non-string query', async () => {
			const executor = createGrepSearchExecutor(undefined as any, logService);
			const result = await executor(makeInput('call-4', { query: 42 }));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('query is required'));
		});
	});

	suite('Cancellation', () => {

		const logService = new NullLogService();

		test('returns cancellation when token is already cancelled (no rg spawn)', async () => {
			const executor = createGrepSearchExecutor(undefined as any, logService);
			const result = await executor(makeInput('call-cancel', {
				query: 'anything',
			}, CancellationToken.Cancelled));
			assert.strictEqual(result.success, false);
			assert.ok(result.content.includes('Cancellation requested'));
		});
	});

	suite('buildRgArgs', () => {

		test('adds --fixed-strings when isRegexp is false', () => {
			const args = buildRgArgs('foo', { isRegExp: false, maxResults: 10, includeIgnoredFiles: false });
			assert.ok(args.includes('--fixed-strings'));
			assert.ok(args.includes('foo'));
			assert.ok(!args.includes('--no-ignore'));
		});

		test('omits --fixed-strings when isRegexp is true', () => {
			const args = buildRgArgs('foo', { isRegExp: true, maxResults: 10, includeIgnoredFiles: false });
			assert.ok(!args.includes('--fixed-strings'));
		});

		test('includes --no-ignore when includeIgnoredFiles is true', () => {
			const args = buildRgArgs('foo', { isRegExp: true, maxResults: 10, includeIgnoredFiles: true });
			assert.ok(args.includes('--no-ignore'));
		});

		test('adds --glob when includePattern is provided', () => {
			const args = buildRgArgs('foo', { isRegExp: true, maxResults: 10, includePattern: '**/*.ts', includeIgnoredFiles: false });
			const globIdx = args.indexOf('--glob');
			assert.ok(globIdx >= 0);
			assert.strictEqual(args[globIdx + 1], '**/*.ts');
		});

		test('always includes --line-number --color=never --no-heading', () => {
			const args = buildRgArgs('x', { isRegExp: true, maxResults: 5, includeIgnoredFiles: false });
			assert.ok(args.includes('--line-number'));
			assert.ok(args.includes('--color=never'));
			assert.ok(args.includes('--no-heading'));
		});
	});

	suite('Ripgrep integration (via execSync)', () => {

		test('literal search finds results in tool source file', () => {
			const { stdout, exitCode } = rgExec(
				['--line-number', '--max-count=5', '--fixed-strings'],
				'grep_search',
				TOOL_SOURCE,
			);
			assert.strictEqual(exitCode, 0);
			assert.ok(stdout.includes('grep_search'), `Expected 'grep_search' in output`);
		});

		test('regex search with alternation works', () => {
			const { stdout, exitCode } = rgExec(
				['--line-number', '--max-count=10'],
				'function|class',
				TOOL_SOURCE,
			);
			assert.strictEqual(exitCode, 0);
			// Should match lines containing 'function' or 'class'
			assert.ok(stdout.length > 10, `Expected output, got: "${stdout.substring(0, 100)}"`);
		});

		test('--max-count limits results per file', () => {
			const { stdout, exitCode } = rgExec(
				['--line-number', '--max-count=1', '--fixed-strings'],
				'function',
				TOOL_SOURCE,
			);
			assert.strictEqual(exitCode, 0);
			const lines = stdout.trim().split('\n').filter(Boolean);
			assert.ok(lines.length <= 1, `Expected ≤1 lines, got ${lines.length}`);
		});

		test('no match exits with code 1 and empty stdout', () => {
			const { stdout, exitCode } = rgExec(
				['--line-number', '--max-count=5', '--fixed-strings'],
				'XYZZY_NOTHING_SHOULD_MATCH_THIS_PATTERN',
				TOOL_SOURCE,
			);
			assert.strictEqual(exitCode, 1);
			assert.strictEqual(stdout.trim(), '');
		});

		test('regex mode by default (without --fixed-strings)', () => {
			// 'grep_search' as a regex should match literally (no special chars)
			const { stdout, exitCode } = rgExec(
				['--line-number', '--max-count=5'],
				'grep_search',
				TOOL_SOURCE,
			);
			assert.strictEqual(exitCode, 0);
			assert.ok(stdout.includes('grep_search'));
		});
	});
});
