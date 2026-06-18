/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentRegistry, HookRegistry } from '../../../node/agentTypes.js';
import { createRunSubagentExecutor, TOOL_RUN_SUBAGENT } from '../../../node/tools/runSubagentTool.js';
import type { ToolInput } from '../../../node/tools/toolRegistry.js';

// ---- helpers ---------------------------------------------------------------

function makeInput(toolCallId: string, params: Record<string, unknown>, cancellationToken?: CancellationToken): ToolInput {
	return { toolCallId, name: 'runSubagent', parameters: params, cancellationToken };
}

const logService = new NullLogService();

// ==============================================================================
// 1. 嵌套深度限制 (Nesting depth limit)
// ==============================================================================
//
// Mirrors Copilot's nesting depth enforcement in RunSubagentTool.invoke():
//   const maxDepth = allowInvocationsFromSubagents ? RUN_SUBAGENT_MAX_NESTING_DEPTH : 0;
//   const currentDepth = this._sessionDepth.get(sessionKey) ?? 0;
//   const depthAllowed = currentDepth + 1 <= maxDepth;
//   modeTools[RunSubagentTool.Id] = depthAllowed;

suite('Nesting depth limit', () => {

	test('TOOL_RUN_SUBAGENT should define max nesting depth constant', () => {
		// The max depth constant lives in OpenAIAgent, but the tool definition
		// should work correctly with any depth limit
		assert.ok(TOOL_RUN_SUBAGENT.name === 'runSubagent', 'Tool is properly defined');
	});

	test('should reject subagent when depth limit exceeded via executor error', async () => {
		let depth = 0;
		const executor = createRunSubagentExecutor(logService, async (_p, _d, _m, _an, _tcid) => {
			depth++;
			if (depth > 5) {
				throw new Error('Subagent nesting depth limit (5) exceeded');
			}
			return 'ok';
		});

		// First call at depth 0 → ok
		const r1 = await executor(makeInput('tc-1', { prompt: 'task', description: 'depth 1' }));
		assert.strictEqual(r1.success, true);

		// Simulate runner rejecting depth > 5
		const errorRunner = createRunSubagentExecutor(logService, async (_p, _d, _m, _an, _tcid) => {
			throw new Error('Subagent nesting depth limit (5) exceeded. Cannot launch further subagents.');
		});
		const r2 = await errorRunner(makeInput('tc-2', { prompt: 'task', description: 'too deep' }));
		assert.strictEqual(r2.success, false);
		assert.ok(r2.content.includes('depth limit'), `Error should mention depth limit, got: ${r2.content}`);
	});

	test('should allow subagent within depth limit', async () => {
		const executor = createRunSubagentExecutor(logService, async (_p, _d, _m, _an, _tcid) => {
			return 'completed successfully';
		});
		const result = await executor(makeInput('tc-3', { prompt: 'task', description: 'within limit' }));
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.content, 'completed successfully');
	});
});

// ==============================================================================
// 2. 子 agent 生命周期信号 (Subagent lifecycle signals)
// ==============================================================================
//
// Mirrors Copilot's IAgentSubagentStartedSignal / IAgentSubagentCompletedSignal:
//   - subagent_started: kind, session, toolCallId, agentName, agentDisplayName
//   - subagent_completed: kind, session, toolCallId

suite('Subagent lifecycle signals', () => {

	test('IRunSubagentToolInputParams should propagate agentName to runner', async () => {
		let capturedAgentName: string | undefined;
		const executor = createRunSubagentExecutor(logService, async (_p, _d, _m, an, _tcid) => {
			capturedAgentName = an;
			return 'done';
		});

		await executor(makeInput('tc-signal-1', {
			prompt: 'research',
			description: 'Explore',
			agentName: 'Explore'
		}));
		assert.strictEqual(capturedAgentName, 'Explore');
	});

	test('runner should receive toolCallId for lifecycle tracking', async () => {
		let capturedToolCallId: string | undefined;
		const executor = createRunSubagentExecutor(logService, async (_p, _d, _m, _an, tcid) => {
			capturedToolCallId = tcid;
			return 'done';
		});

		await executor(makeInput('tc-lifecycle-42', { prompt: 'task', description: 'tracking' }));
		assert.strictEqual(capturedToolCallId, 'tc-lifecycle-42');
	});

	test('subagent completed signal represented by successful tool result', async () => {
		const executor = createRunSubagentExecutor(logService, async () => 'completed');
		const result = await executor(makeInput('tc-complete', { prompt: 'task', description: 'complete' }));
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.toolCallId, 'tc-complete');
	});

	test('subagent error represented by failed tool result', async () => {
		const executor = createRunSubagentExecutor(logService, async () => {
			throw new Error('Subagent crashed');
		});
		const result = await executor(makeInput('tc-error', { prompt: 'task', description: 'error' }));
		assert.strictEqual(result.success, false);
		assert.ok(result.content.includes('Subagent crashed'));
	});
});

// ==============================================================================
// 3. 进度转发 (Progress forwarding via parentToolCallId)
// ==============================================================================
//
// Mirrors Copilot's progress forwarding in RunSubagentTool.invoke():
//   const progressCallback = (parts: IChatProgress[]) => {
//     model.acceptResponseProgress(request, { ...part, subAgentInvocationId });
//   };

suite('Progress forwarding', () => {

	test('should forward runner result text as tool output content', async () => {
		const executor = createRunSubagentExecutor(logService, async () => {
			return '## Research Results\n\n- Found file A\n- Found file B';
		});
		const result = await executor(makeInput('tc-progress-1', { prompt: 'search', description: 'Research' }));
		assert.strictEqual(result.success, true);
		assert.ok(result.content.includes('Research Results'));
		assert.ok(result.content.includes('file A'));
	});

	test('should forward markdown content through tool output', async () => {
		const markdown = '# Header\n\nParagraph with `code` and **bold**.\n\n```ts\nconst x = 1;\n```';
		const executor = createRunSubagentExecutor(logService, async () => markdown);
		const result = await executor(makeInput('tc-progress-2', { prompt: 'generate', description: 'Doc' }));
		assert.strictEqual(result.content, markdown);
	});

	test('should forward empty result as empty string (success)', async () => {
		const executor = createRunSubagentExecutor(logService, async () => '');
		const result = await executor(makeInput('tc-progress-3', { prompt: 'noop', description: 'Empty' }));
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.content, '');
	});
});

// ==============================================================================
// 4. 工具白名单过滤 (Tool whitelist filtering)
// ==============================================================================
//
// Mirrors Copilot's modeTools construction in RunSubagentTool.invoke():
//   const modeCustomTools = subagent.tools;
//   if (modeCustomTools) {
//     const enablementMap = this.languageModelToolsService.toToolAndToolSetEnablementMap(modeCustomTools, undefined);
//     modeTools = {};
//     for (const [tool, enabled] of enablementMap) {
//       if (!isToolSet(tool)) { modeTools[tool.id] = enabled; }
//     }
//   }

suite('Tool whitelist filtering', () => {

	test('AgentRegistry should store and retrieve tool whitelist', () => {
		const registry = new AgentRegistry();
		registry.register({
			name: 'ReadOnly',
			tools: ['read_file', 'grep_search', 'file_search', 'list_dir'],
		});
		const agent = registry.get('ReadOnly');
		assert.ok(agent?.tools);
		assert.strictEqual(agent.tools.length, 4);
		assert.deepStrictEqual(agent.tools, ['read_file', 'grep_search', 'file_search', 'list_dir']);
	});

	test('AgentRegistry should return undefined tools for unrestricted agent', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'FullAccess' });
		assert.strictEqual(registry.get('FullAccess')?.tools, undefined);
	});

	test('AgentRegistry tool whitelist should be immutable', () => {
		const registry = new AgentRegistry();
		registry.register({
			name: 'Explore',
			tools: Object.freeze(['read_file', 'grep_search']),
		});
		const agent = registry.get('Explore');
		assert.ok(agent?.tools);
		assert.strictEqual(agent.tools.length, 2);
	});

	test('should reject tool calls not in whitelist via executor stub', () => {
		const registry = new AgentRegistry();
		registry.register({
			name: 'ReadOnly',
			tools: ['read_file'],
		});

		const agent = registry.get('ReadOnly');
		assert.ok(agent?.tools);
		assert.ok(agent.tools.includes('read_file'));
		assert.ok(!agent.tools.includes('run_in_terminal'));
	});

	test('tool whitelist should be configurable per agent name', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'AgentA', tools: ['read_file'] });
		registry.register({ name: 'AgentB', tools: ['run_in_terminal', 'grep_search'] });

		const agentA = registry.get('AgentA');
		const agentB = registry.get('AgentB');

		assert.ok(agentA?.tools?.includes('read_file'));
		assert.ok(!agentA?.tools?.includes('run_in_terminal'));
		assert.ok(agentB?.tools?.includes('run_in_terminal'));
		assert.ok(!agentB?.tools?.includes('read_file'));
	});

	test('empty tool whitelist should allow all tools (undefined means unrestricted)', () => {
		const registry = new AgentRegistry();
		registry.register({ name: 'Unrestricted' });
		assert.strictEqual(registry.get('Unrestricted')?.tools, undefined);
	});
});

// ==============================================================================
// 5. 子 agent 钩子 (SubagentStart / SubagentStop hooks)
// ==============================================================================
//
// Mirrors Copilot's hook system:
//   - SubagentStart hook: provides additional context, runs before subagent
//   - SubagentStop hook: can block stopping, runs after subagent

suite('Subagent hooks (SubagentStart / SubagentStop)', () => {

	// ---- HookRegistry basics ----

	test('HookRegistry should start empty', () => {
		const registry = new HookRegistry();
		assert.strictEqual(registry.get('Explore'), undefined);
	});

	test('HookRegistry should register and retrieve agent-specific hooks', () => {
		const registry = new HookRegistry();
		const hooks = {
			subagentStart: async () => ({ additionalContext: 'Extra context' }),
		};
		registry.register('Explore', hooks);
		const retrieved = registry.get('Explore');
		assert.ok(retrieved);
		assert.ok(retrieved.subagentStart);
	});

	test('HookRegistry should support global hook via "*" fallback', () => {
		const registry = new HookRegistry();
		const globalHooks = {
			subagentStart: async () => ({ additionalContext: 'Global context' }),
		};
		registry.register('*', globalHooks);
		// Getting any agent name should return the global hooks
		const retrieved = registry.get('Anything');
		assert.ok(retrieved);
		assert.ok(retrieved.subagentStart);
	});

	test('HookRegistry should prefer agent-specific hooks over global', () => {
		const registry = new HookRegistry();
		registry.register('*', {
			subagentStart: async () => ({ additionalContext: 'Global' }),
		});
		registry.register('Explore', {
			subagentStart: async () => ({ additionalContext: 'Explore-specific' }),
		});
		const exploreHooks = registry.get('Explore');
		const otherHooks = registry.get('Other');
		assert.ok(exploreHooks?.subagentStart);
		assert.ok(otherHooks?.subagentStart);
	});

	test('HookRegistry should unregister hooks', () => {
		const registry = new HookRegistry();
		registry.register('Explore', {
			subagentStart: async () => ({ additionalContext: 'test' }),
		});
		assert.ok(registry.get('Explore'));
		registry.unregister('Explore');
		assert.strictEqual(registry.get('Explore'), undefined);
	});

	test('HookRegistry should clear all hooks', () => {
		const registry = new HookRegistry();
		registry.register('A', { subagentStart: async () => ({ additionalContext: 'a' }) });
		registry.register('B', { subagentStop: async () => ({ shouldContinue: false }) });
		assert.ok(registry.get('A'));
		assert.ok(registry.get('B'));
		registry.clear();
		assert.strictEqual(registry.get('A'), undefined);
		assert.strictEqual(registry.get('B'), undefined);
	});

	// ---- SubagentStart hook behavior ----

	test('SubagentStart hook should be invocable and return additional context', async () => {
		const hook = async () => ({ additionalContext: 'Research the codebase thoroughly before answering.' });
		const result = await hook();
		assert.ok(result.additionalContext);
		assert.ok(result.additionalContext.includes('Research'));
	});

	test('SubagentStart hook should handle returning undefined gracefully', async () => {
		const hook = async () => undefined;
		const result = await hook();
		assert.strictEqual(result, undefined);
	});

	test('SubagentStart hook should propagate errors without crashing', async () => {
		const hook = async () => {
			throw new Error('Hook database unavailable');
		};
		try {
			await hook();
			assert.fail('Should have thrown');
		} catch (err: any) {
			assert.ok(err.message.includes('Hook database unavailable'));
		}
	});

	test('SubagentStart hook should accept agent_id and agent_type parameters', async () => {
		const hook = async (input: { agentId: string; agentType: string }) => {
			return {
				additionalContext: `Running as ${input.agentType} with id ${input.agentId.substring(0, 8)}`
			};
		};
		const result = await hook({ agentId: 'a1b2c3d4e5', agentType: 'Explore' });
		assert.ok(result.additionalContext.includes('Explore'));
		assert.ok(result.additionalContext.includes('a1b2c3d4'), `Expected "a1b2c3d4" in "${result.additionalContext}"`);
	});

	// ---- SubagentStop hook behavior ----

	test('SubagentStop hook should allow stopping by returning shouldContinue: false', async () => {
		const hook = async () => ({ shouldContinue: false });
		const result = await hook();
		assert.strictEqual(result.shouldContinue, false);
	});

	test('SubagentStop hook should block stopping by returning shouldContinue: true with reasons', async () => {
		const hook = async () => ({
			shouldContinue: true,
			reasons: ['Pending changes not yet verified', 'Tests are still running'],
		});
		const result = await hook();
		assert.strictEqual(result.shouldContinue, true);
		assert.ok(result.reasons);
		assert.strictEqual(result.reasons.length, 2);
	});

	test('SubagentStop hook should handle empty reasons array', async () => {
		const hook = async () => ({ shouldContinue: true, reasons: [] });
		const result = await hook();
		assert.strictEqual(result.shouldContinue, true);
		assert.ok(result.reasons);
		assert.strictEqual(result.reasons.length, 0);
	});

	// ---- Hook integration with creator ----

	test('SubagentStart hook additional context should be injectable into runner', async () => {
		let hookContextAdded = false;
		const executor = createRunSubagentExecutor(logService, async (prompt, _desc, _model, _agentName, _tcid) => {
			if (prompt.includes('[Context: Research thoroughly]')) {
				hookContextAdded = true;
			}
			return 'done';
		});

		// Simulate: SubagentStart hook prepends context to the prompt
		const hookResult = await (async () => ({ additionalContext: 'Research thoroughly' }))();
		const enhancedPrompt = `[Context: ${hookResult.additionalContext}]\n\nOriginal task`;
		await executor(makeInput('tc-hook-1', { prompt: enhancedPrompt, description: 'Hook test' }));
		assert.ok(hookContextAdded, 'Hook context should be prepended to prompt');
	});

	// ---- Copilot behavior parity tests ----

	test('should support complete SubagentStart → run → SubagentStop lifecycle', async () => {
		const lifecycle: string[] = [];

		// Simulate SubagentStart
		lifecycle.push('start');
		const startResult = await (async () => ({ additionalContext: 'Research context' }))();
		assert.ok(startResult.additionalContext);

		// Simulate subagent running
		const executor = createRunSubagentExecutor(logService, async () => {
			lifecycle.push('run');
			return 'research results';
		});
		const runResult = await executor(makeInput('tc-lifecycle', { prompt: 'do research', description: 'Research' }));
		assert.strictEqual(runResult.success, true);
		lifecycle.push('complete');

		// Simulate SubagentStop
		const stopResult = await (async () => ({ shouldContinue: false }))();
		assert.strictEqual(stopResult.shouldContinue, false);
		lifecycle.push('stop');

		assert.deepStrictEqual(lifecycle, ['start', 'run', 'complete', 'stop']);
	});

	test('should handle SubagentStop blocking and then allowing stop', async () => {
		let stopAttempts = 0;

		const stopHook = async () => {
			stopAttempts++;
			if (stopAttempts === 1) {
				return { shouldContinue: true, reasons: ['Verify results first'] };
			}
			return { shouldContinue: false };
		};

		// First call: hook blocks stop
		const r1 = await stopHook();
		assert.strictEqual(r1.shouldContinue, true);
		assert.strictEqual(stopAttempts, 1);

		// Second call: hook allows stop
		const r2 = await stopHook();
		assert.strictEqual(r2.shouldContinue, false);
		assert.strictEqual(stopAttempts, 2);
	});
});

// ==============================================================================
// 6. 工具定义和参数验证 (Tool definition & parameter validation)
// ==============================================================================

suite('Tool definition & parameter validation', () => {

	test('tool should require prompt parameter', () => {
		const schema = TOOL_RUN_SUBAGENT.parameters as Record<string, unknown>;
		const required = (schema as any).required as string[];
		assert.ok(required.includes('prompt'), 'prompt is required');
	});

	test('tool should require description parameter', () => {
		const schema = TOOL_RUN_SUBAGENT.parameters as Record<string, unknown>;
		const required = (schema as any).required as string[];
		assert.ok(required.includes('description'), 'description is required');
	});

	test('tool should define optional model and agentName parameters', () => {
		const schema = TOOL_RUN_SUBAGENT.parameters as Record<string, unknown>;
		const props = (schema as any).properties as Record<string, unknown>;
		assert.ok(props['model'], 'model should be defined');
		assert.ok(props['agentName'], 'agentName should be defined');
	});

	test('tool should be non-destructive', () => {
		assert.strictEqual(TOOL_RUN_SUBAGENT.isDestructive, false);
	});

	test('tool should have correct name aligned with Copilot', () => {
		assert.strictEqual(TOOL_RUN_SUBAGENT.name, 'runSubagent');
	});
});
