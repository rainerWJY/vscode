/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { NullLogService } from '../../../../log/common/log.js';
import { TOOL_RUN_SUBAGENT, createRunSubagentExecutor, type ISubagentRunner } from '../../../node/tools/runSubagentTool.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'runSubagent', parameters: params, cancellationToken };
}

const logService = new NullLogService();

/**
 * Creates a mock subagent runner that returns a predefined result.
 */
function mockRunner(result: string): ISubagentRunner {
	return async (_prompt, _description, _model, _agentName, _toolCallId) => result;
}

/**
 * Creates a mock subagent runner that captures its arguments for later inspection.
 */
function capturingRunner(): { runner: ISubagentRunner; calls: Array<{ prompt: string; description: string; model: string | undefined; agentName: string | undefined; toolCallId: string }> } {
	const calls: Array<{ prompt: string; description: string; model: string | undefined; agentName: string | undefined; toolCallId: string }> = [];
	const runner: ISubagentRunner = async (prompt, description, model, agentName, toolCallId) => {
		calls.push({ prompt, description, model, agentName, toolCallId });
		return `result for: ${description}`;
	};
	return { runner, calls };
}

/**
 * Creates a mock subagent runner that throws an error.
 */
function errorRunner(errorMessage: string): ISubagentRunner {
	return async (_prompt, _description, _model, _agentName, _toolCallId) => {
		throw new Error(errorMessage);
	};
}

// ==============================================================================
// Suite: Tool definition
// ==============================================================================

suite('TOOL_RUN_SUBAGENT definition', () => {

	test('should have the correct tool name', () => {
		assert.strictEqual(TOOL_RUN_SUBAGENT.name, 'runSubagent');
	});

	test('should not be destructive', () => {
		assert.strictEqual(TOOL_RUN_SUBAGENT.isDestructive, false);
	});

	test('should have toolKind "other"', () => {
		assert.strictEqual(TOOL_RUN_SUBAGENT.toolKind, 'other');
	});

	test('should require "prompt" and "description" parameters', () => {
		const schema = TOOL_RUN_SUBAGENT.parameters as Record<string, unknown>;
		const required = (schema as any).required as string[];
		assert.ok(required.includes('prompt'), '"prompt" should be required');
		assert.ok(required.includes('description'), '"description" should be required');
	});

	test('should define optional "model" and "agentName" parameters', () => {
		const schema = TOOL_RUN_SUBAGENT.parameters as Record<string, unknown>;
		const props = (schema as any).properties as Record<string, unknown>;
		assert.ok(props['model'], '"model" parameter should be defined');
		assert.ok(props['agentName'], '"agentName" parameter should be defined');
	});

	test('should not require "model" or "agentName"', () => {
		const schema = TOOL_RUN_SUBAGENT.parameters as Record<string, unknown>;
		const required = (schema as any).required as string[];
		assert.ok(!required.includes('model'), '"model" should NOT be required');
		assert.ok(!required.includes('agentName'), '"agentName" should NOT be required');
	});
});

// ==============================================================================
// Suite: createRunSubagentExecutor
// ==============================================================================

suite('createRunSubagentExecutor', () => {

	test('should return success with the runner result', async () => {
		const executor = createRunSubagentExecutor(logService, mockRunner('exploration complete'));
		const result = await executor(makeInput('tc-1', { prompt: 'Find all files', description: 'Explore codebase' }));
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.content, 'exploration complete');
	});

	test('should propagate toolCallId to output', async () => {
		const executor = createRunSubagentExecutor(logService, mockRunner('done'));
		const result = await executor(makeInput('tc-42', { prompt: 'test', description: 'Test' }));
		assert.strictEqual(result.toolCallId, 'tc-42');
	});

	test('should return error when prompt is empty', async () => {
		const executor = createRunSubagentExecutor(logService, mockRunner('should not run'));
		const result = await executor(makeInput('tc-2', { prompt: '', description: 'Test' }));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('prompt'), 'Error should mention missing prompt');
	});

	test('should return error when prompt is missing', async () => {
		const executor = createRunSubagentExecutor(logService, mockRunner('should not run'));
		const result = await executor(makeInput('tc-3', { description: 'Test' }));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('prompt'), 'Error should mention missing prompt');
	});

	test('should return error when runner throws', async () => {
		const executor = createRunSubagentExecutor(logService, errorRunner('Something went wrong'));
		const result = await executor(makeInput('tc-4', { prompt: 'Find files', description: 'Search' }));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('Something went wrong'));
	});

	test('should pass prompt, description, and toolCallId to the runner', async () => {
		const { runner, calls } = capturingRunner();
		const executor = createRunSubagentExecutor(logService, runner);
		await executor(makeInput('tc-5', { prompt: 'Search for X', description: 'Research' }));
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].prompt, 'Search for X');
		assert.strictEqual(calls[0].description, 'Research');
		assert.strictEqual(calls[0].toolCallId, 'tc-5');
	});

	test('should pass model parameter when provided', async () => {
		const { runner, calls } = capturingRunner();
		const executor = createRunSubagentExecutor(logService, runner);
		await executor(makeInput('tc-6', {
			prompt: 'Search for X',
			description: 'Research',
			model: 'deepseek-chat'
		}));
		assert.strictEqual(calls[0].model, 'deepseek-chat');
	});

	test('should pass model as undefined when not provided', async () => {
		const { runner, calls } = capturingRunner();
		const executor = createRunSubagentExecutor(logService, runner);
		await executor(makeInput('tc-7', { prompt: 'Search for X', description: 'Research' }));
		assert.strictEqual(calls[0].model, undefined);
	});

	test('should pass agentName when provided', async () => {
		const { runner, calls } = capturingRunner();
		const executor = createRunSubagentExecutor(logService, runner);
		await executor(makeInput('tc-8', {
			prompt: 'Research',
			description: 'Explore',
			agentName: 'Explore'
		}));
		assert.strictEqual(calls[0].agentName, 'Explore');
	});

	test('should pass agentName as undefined when not provided', async () => {
		const { runner, calls } = capturingRunner();
		const executor = createRunSubagentExecutor(logService, runner);
		await executor(makeInput('tc-9', { prompt: 'Research', description: 'Explore' }));
		assert.strictEqual(calls[0].agentName, undefined);
	});

	test('should handle runner returning an empty string', async () => {
		const executor = createRunSubagentExecutor(logService, mockRunner(''));
		const result = await executor(makeInput('tc-10', { prompt: 'Do nothing', description: 'No-op' }));
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.content, '');
	});

	test('should handle very long prompt', async () => {
		const longPrompt = 'A'.repeat(10000);
		const executor = createRunSubagentExecutor(logService, mockRunner('long result'));
		const result = await executor(makeInput('tc-11', { prompt: longPrompt, description: 'Long test' }));
		assert.strictEqual(result.success, true);
	});

	test('should handle multiple concurrent invocations', async () => {
		const { runner, calls } = capturingRunner();
		const executor = createRunSubagentExecutor(logService, runner);
		const results = await Promise.all([
			executor(makeInput('tc-a', { prompt: 'Task A', description: 'Task A' })),
			executor(makeInput('tc-b', { prompt: 'Task B', description: 'Task B' })),
			executor(makeInput('tc-c', { prompt: 'Task C', description: 'Task C' })),
		]);
		assert.strictEqual(results.length, 3);
		assert.ok(results.every(r => r.success));
		assert.strictEqual(calls.length, 3);
		const toolCallIds = calls.map(c => c.toolCallId);
		assert.strictEqual(new Set(toolCallIds).size, 3, 'Each invocation should have a unique toolCallId');
	});

	test('should return the runner result as content', async () => {
		const executor = createRunSubagentExecutor(logService, mockRunner('## Results\n- File 1\n- File 2'));
		const result = await executor(makeInput('tc-12', { prompt: 'Find files', description: 'Search' }));
		assert.strictEqual(result.content, '## Results\n- File 1\n- File 2');
	});

	test('should forward non-Error throws as error messages', async () => {
		const executor = createRunSubagentExecutor(logService, async () => { throw 'string error'; });
		const result = await executor(makeInput('tc-13', { prompt: 'test', description: 'Test' }));
		assert.strictEqual(result.success, false);
	});
});

// ==============================================================================
// Suite: Tool registration and name matching
// ==============================================================================

suite('runSubagent tool naming', () => {

	test('should export the tool name matching ToolName.CoreRunSubagent', () => {
		assert.strictEqual(TOOL_RUN_SUBAGENT.name, 'runSubagent');
	});

	test('should be usable with ISubagentRunner type', () => {
		const runner: ISubagentRunner = async (prompt, _description, _model, _agentName, _toolCallId) => {
			return `Ran: ${prompt}`;
		};
		const executor = createRunSubagentExecutor(logService, runner);
		assert.ok(typeof executor === 'function');
	});
});
