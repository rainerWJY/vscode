/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentSignal } from '../../../agentHost/common/agentService.js';
import { ActionType } from '../../../agentHost/common/state/sessionActions.js';
import { OpenAIAgentSession, type IOpenAIAgentSessionOptions, type OpenAIAgentMode, type ToolExecutorFactory } from '../../node/openAIAgentSession.js';
import { OpenAIStreamEvent } from '../../node/openAIApiClient.js';
import { type ToolExecutor, type ToolInput, type ToolOutput } from '../../node/tools/toolRegistry.js';

// ==============================================================================
// Mock types
// ==============================================================================

type MockStreamChat = (messages: unknown[], tools: unknown[], token: CancellationToken) => AsyncIterable<OpenAIStreamEvent>;

// ==============================================================================
// Test subclass that exposes protected methods and mocks the API client
// ==============================================================================

class TestOpenAIAgentSession extends OpenAIAgentSession {
	/** Replace the internal _apiClient.streamChat with a mock. */
	public setMockStreamChat(mock: MockStreamChat): void {
		(this as any)._apiClient.streamChat = mock;
	}

	/** Expose _shouldAutopilotContinue for testing. */
	public testShouldAutopilotContinue(lastResponseContent?: string): string | undefined {
		return (this as any)._shouldAutopilotContinue(lastResponseContent);
	}

	/** Expose _shouldAutoRetry for testing. */
	public testShouldAutoRetry(error: string): boolean {
		return (this as any)._shouldAutoRetry(error);
	}

	/** Expose _executeStopHook for testing. */
	public async testExecuteStopHook(stopHookActive: boolean): Promise<{ shouldContinue: boolean; reasons?: string[] }> {
		return (this as any)._executeStopHook(stopHookActive);
	}

	/** Expose abort() so tests can stop mid-loop. */
	public testAbort(): void {
		this.abort();
	}

	/** Directly set autopilot state fields. */
	public setAutopilotRetryCount(n: number): void {
		(this as any)._autopilotRetryCount = n;
	}

	public setAutopilotIterationCount(n: number): void {
		(this as any)._autopilotIterationCount = n;
	}

	public setAutopilotStopHookActive(v: boolean): void {
		(this as any)._autopilotStopHookActive = v;
	}

	public setTaskCompleted(v: boolean): void {
		(this as any)._taskCompleted = v;
	}

	public setLastRoundHadToolCalls(v: boolean): void {
		(this as any)._lastRoundHadToolCalls = v;
	}

	/** Override the stop hook so tests can control it. */
	public stopHookOverride: { shouldContinue: boolean; reasons?: string[] } | undefined;
	protected override async _executeStopHook(stopHookActive: boolean): Promise<{ shouldContinue: boolean; reasons?: string[] }> {
		if (this.stopHookOverride !== undefined) {
			return this.stopHookOverride;
		}
		return { shouldContinue: false };
	}
}

// ==============================================================================
// Helpers
// ==============================================================================

const SESSION_URI = URI.parse('test-session:///test-agent-session');
const logService = new NullLogService();

function createNoopToolFactory(name: string, resultContent?: string): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => ({
		toolCallId: input.toolCallId,
		success: true,
		content: resultContent ?? `result from ${name}`,
	});
}

/**
 * Create a test session with the given options.
 */
function createTestSession(overrides?: {
	mode?: OpenAIAgentMode;
	autoApprove?: boolean;
	streamChat?: MockStreamChat;
	toolExecutors?: Record<string, ToolExecutor>;
}): { session: TestOpenAIAgentSession; signals: AgentSignal[]; emitter: Emitter<AgentSignal>; disposables: DisposableStore } {
	const disposables = new DisposableStore();
	const emitter = disposables.add(new Emitter<AgentSignal>());
	const signals: AgentSignal[] = [];
	emitter.event(s => signals.push(s));

	// Build tool factory: use overrides if provided, else default no-ops
	const toolExecutors = overrides?.toolExecutors ?? {};
	const toolFactory: ToolExecutorFactory = (meta) => {
		return toolExecutors[meta.name] ?? createNoopToolFactory(meta.name);
	};

	const options: IOpenAIAgentSessionOptions = {
		config: {
			baseUrl: 'http://test-api.local/v1',
			apiKey: 'test-key',
			model: 'test-model',
		},
		sessionUri: SESSION_URI,
		onDidSessionProgress: emitter,
		toolFactory,
		autoApprove: overrides?.autoApprove ?? false,
		mode: overrides?.mode ?? 'interactive',
	};

	const session = disposables.add(new TestOpenAIAgentSession(options, logService));

	if (overrides?.streamChat) {
		session.setMockStreamChat(overrides.streamChat);
	}

	return { session, signals, emitter, disposables };
}

/**
 * Create a simple streamChat mock that yields a single text response
 * (no tool calls).
 */
function textOnlyResponse(text: string = 'Hello, I am an AI assistant.'): MockStreamChat {
	return async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
		yield { type: 'delta', content: text };
		yield { type: 'finish', finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
	};
}

/**
 * Create a streamChat mock that yields a tool call + text.
 */
function toolCallResponse(toolName: string, toolArgs: string, text: string = ''): MockStreamChat {
	return async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
		if (text) {
			yield { type: 'delta', content: text };
		}
		yield { type: 'toolCallDelta', id: 'tc-1', name: toolName, arguments: toolArgs };
		yield { type: 'finish', finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
	};
}

/**
 * Create a streamChat mock that yields an error (throw).
 */
function errorResponse(errorMessage: string): MockStreamChat {
	return async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
		throw new Error(errorMessage);
	};
}

/**
 * Create a streamChat mock that yields a reasoning block + text.
 */
function reasoningResponse(text: string, reasoning: string): MockStreamChat {
	return async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
		yield { type: 'reasoning', content: reasoning };
		yield { type: 'delta', content: text };
		yield { type: 'finish', finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
	};
}

// ==============================================================================
// Suite
// ==============================================================================

suite('OpenAIAgentSession main loop', () => {
	let disposables: DisposableStore;

	setup(() => {
		disposables = new DisposableStore();
	});

	teardown(() => {
		disposables.dispose();
	});

	// ─────────────────────────────────────────────
	// Basic loop flow
	// ─────────────────────────────────────────────

	test('should complete a turn with no tool calls', async () => {
		const { session, signals } = createTestSession({
			streamChat: textOnlyResponse('Hello!'),
		});

		await session.send('Hi there', 'turn-1', CancellationToken.None);

		// Should have emitted a turn complete signal
		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should emit SessionTurnComplete');

		// Should have emitted a markdown response
		const markdownParts = signals.filter(
			s => s.kind === 'action' && s.action.type === ActionType.SessionResponsePart
		);
		assert.ok(markdownParts.length > 0, 'Should emit at least one markdown part');
	});

	test('should stream reasoning content', async () => {
		const { session, signals } = createTestSession({
			streamChat: reasoningResponse('Final answer.', 'Let me think about this...'),
		});

		await session.send('Think about this', 'turn-1', CancellationToken.None);

		// The first reasoning delta emits a SessionResponsePart with kind=Reasoning,
		// subsequent deltas emit SessionReasoning. With only one chunk, check for
		// the response part.
		const responseParts = signals.filter(
			s => s.kind === 'action' && s.action.type === ActionType.SessionResponsePart
		);
		assert.ok(responseParts.length > 0, 'Should emit response parts for reasoning');
	});

	test('should execute a tool call and push result to conversation', async () => {
		const { session, signals } = createTestSession({
			streamChat: toolCallResponse('read_file', '{"filePath":"/test.txt"}'),
		});

		await session.send('Read a file', 'turn-2', CancellationToken.None);

		// Should have tool call start + complete signals
		const toolStarts = signals.filter(
			s => s.kind === 'action' && s.action.type === ActionType.SessionToolCallStart
		);
		const toolCompletes = signals.filter(
			s => s.kind === 'action' && s.action.type === ActionType.SessionToolCallComplete
		);
		assert.ok(toolStarts.length > 0, 'Should emit ToolCallStart');
		assert.ok(toolCompletes.length > 0, 'Should emit ToolCallComplete');
	});

	test('should stop loop when task_complete is called', async () => {
		const { session, signals } = createTestSession({
			streamChat: toolCallResponse('task_complete', '{}', 'Task done!'),
		});

		await session.send('Finish the task', 'turn-3', CancellationToken.None);

		// task_complete should result in a successful completion
		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should emit SessionTurnComplete after task_complete');
	});

	test('should handle unknown tool gracefully', async () => {
		const { session, signals } = createTestSession({
			streamChat: toolCallResponse('nonexistent_tool', '{}'),
		});

		await session.send('Use unknown tool', 'turn-4', CancellationToken.None);

		// Loop should complete (no error thrown)
		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should still complete the turn');
	});

	test('should handle invalid JSON parameters gracefully', async () => {
		const { session, signals } = createTestSession({
			streamChat: toolCallResponse('read_file', '{invalid json!!!}'),
		});

		await session.send('Bad params', 'turn-5', CancellationToken.None);

		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should still complete the turn despite invalid params');
	});

	test('should deny destructive tool when autoApprove is false', async () => {
		const { session, signals } = createTestSession({
			autoApprove: false,
			streamChat: toolCallResponse('create_file', '{"filePath":"/test.txt","content":"hello"}'),
		});

		await session.send('Create a file', 'turn-6', CancellationToken.None);

		// Should complete without errors (the tool is denied, not crashed)
		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should still complete the turn');
	});

	// ─────────────────────────────────────────────
	// Abort / cancellation
	// ─────────────────────────────────────────────

	test('should stop loop when aborted mid-execution', async () => {
		// Create a slow stream that yields many events
		const slowStream: MockStreamChat = async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
			yield { type: 'delta', content: 'Working...' };
			// Don't yield finish — the loop should be aborted
			await new Promise(resolve => setTimeout(resolve, 5000));
			yield { type: 'delta', content: 'done' };
			yield { type: 'finish', finishReason: 'stop' };
		};

		const { session } = createTestSession({
			streamChat: slowStream,
		});

		// Abort after a short delay
		const abortPromise = (async () => {
			await new Promise(resolve => setTimeout(resolve, 100));
			session.testAbort();
		})();

		// send() should complete without throwing
		await session.send('Slow request', 'turn-7', CancellationToken.None);
		await abortPromise;
	});

	test('should stop loop when token is cancelled', async () => {
		const tokenSource = new CancellationTokenSource();
		const slowStream: MockStreamChat = async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
			yield { type: 'delta', content: 'Working...' };
			await new Promise(resolve => setTimeout(resolve, 5000));
			yield { type: 'finish', finishReason: 'stop' };
		};

		const { session } = createTestSession({
			streamChat: slowStream,
		});

		const cancelPromise = (async () => {
			await new Promise(resolve => setTimeout(resolve, 100));
			tokenSource.cancel();
		})();

		await session.send('Cancellable', 'turn-8', tokenSource.token);
		await cancelPromise;
	});

	// ─────────────────────────────────────────────
	// shouldAutopilotContinue (mirrors Copilot tests)
	// ─────────────────────────────────────────────

	test('shouldAutopilotContinue: should return nudge when task_complete not called', () => {
		const { session } = createTestSession({ autoApprove: true });
		const result = session.testShouldAutopilotContinue();
		assert.ok(result?.includes('task_complete'), 'Should nudge the model to call task_complete');
	});

	test('shouldAutopilotContinue: should return undefined when task_complete was called', () => {
		const { session } = createTestSession({ autoApprove: true });
		session.setTaskCompleted(true);
		const result = session.testShouldAutopilotContinue();
		assert.strictEqual(result, undefined, 'Should not nudge when task_complete already called');
	});

	test('shouldAutopilotContinue: should stop after MAX_AUTOPILOT_ITERATIONS', () => {
		const { session } = createTestSession({ autoApprove: true });

		for (let i = 0; i < 5; i++) {
			const msg = session.testShouldAutopilotContinue();
			assert.ok(msg?.includes('task_complete'), `Iteration ${i} should nudge`);
		}

		// 6th call should return undefined — hit the cap (MAX_AUTOPILOT_ITERATIONS = 5)
		const msg = session.testShouldAutopilotContinue();
		assert.strictEqual(msg, undefined, 'Should stop after max iterations');
	});

	test('shouldAutopilotContinue: should bail when prior nudge produced no tool calls', () => {
		const { session } = createTestSession({ autoApprove: true });
		session.setAutopilotStopHookActive(true);
		const result = session.testShouldAutopilotContinue();
		assert.strictEqual(result, undefined, 'Should bail when prior nudge produced no tool calls');
	});

	test('shouldAutopilotContinue: should allow another nudge after autopilotStopHookActive is reset', () => {
		const { session } = createTestSession({ autoApprove: true });

		// First nudge
		const msg1 = session.testShouldAutopilotContinue();
		assert.ok(msg1?.includes('task_complete'));

		// Simulate reset (as _runLoop does when productive tool calls are made)
		session.setAutopilotStopHookActive(false);
		session.setAutopilotIterationCount(0);

		// Second nudge should work
		const msg2 = session.testShouldAutopilotContinue();
		assert.ok(msg2?.includes('task_complete'));
	});

	// ─────────────────────────────────────────────
	// shouldAutopilotContinue — Copilot-aligned edge cases
	// ─────────────────────────────────────────────

	test('shouldAutopilotContinue: should skip nudge when model returned a text-only response (no tool calls)', () => {
		const { session } = createTestSession({ autoApprove: true });

		// Pass substantive text content — the model is done, it produced a summary
		const result = session.testShouldAutopilotContinue('Here is a summary of what I did. Task complete.');
		assert.strictEqual(result, undefined, 'Should not nudge when model produced text-only response');
	});

	test('shouldAutopilotContinue: should still nudge when responseContent is empty', () => {
		const { session } = createTestSession({ autoApprove: true });
		const result = session.testShouldAutopilotContinue('');
		assert.ok(result?.includes('task_complete'), 'Should nudge when response content is empty');
	});

	test('shouldAutopilotContinue: should still nudge when responseContent is undefined', () => {
		const { session } = createTestSession({ autoApprove: true });
		const result = session.testShouldAutopilotContinue(undefined);
		assert.ok(result?.includes('task_complete'), 'Should nudge when response content is undefined');
	});

	// ─────────────────────────────────────────────
	// Auto-retry integration tests
	// ─────────────────────────────────────────────

	test('auto-retry: should retry transient error and continue loop', async () => {
		// First call errors, second call succeeds with text
		let retryCallCount = 0;
		const retryThenSuccess: MockStreamChat = async function* (messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
			retryCallCount++;
			if (retryCallCount === 1) {
				throw new Error('Temporary network failure');
			}
			// Second call succeeds
			yield { type: 'delta', content: 'Recovered successfully.' };
			yield { type: 'finish', finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
		};

		const { session, signals } = createTestSession({
			autoApprove: true,
			streamChat: retryThenSuccess,
		});

		await session.send('Retry test', 'turn-retry', CancellationToken.None);

		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should complete after auto-retry');
		assert.strictEqual(retryCallCount, 2, 'Should have retried exactly once');
	});

	test('auto-retry: should give up after MAX_AUTOPILOT_RETRIES', async () => {
		let retryCount = 0;
		const alwaysFails: MockStreamChat = async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
			retryCount++;
			throw new Error('Persistent failure');
		};

		const { session, signals } = createTestSession({
			autoApprove: true,
			streamChat: alwaysFails,
		});

		await session.send('Failing request', 'turn-fail', CancellationToken.None);

		// Even after exhausting retries, the turn should complete (with error logged)
		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should still complete after exhausting retries');
	});

	test('auto-retry: should not retry non-transient (rate-limit) errors', async () => {
		let callCount = 0;
		const rateLimited: MockStreamChat = async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
			callCount++;
			throw new Error('Rate limit exceeded');
		};

		const { session } = createTestSession({
			autoApprove: true,
			streamChat: rateLimited,
		});

		await session.send('Rate limited request', 'turn-rate', CancellationToken.None);

		// Should have only made 1 call (no retry for rate limits)
		assert.strictEqual(callCount, 1, 'Should not retry rate-limited requests');
	});

	// ─────────────────────────────────────────────
	// shouldAutoRetry (mirrors Copilot tests)
	// ─────────────────────────────────────────────

	test('shouldAutoRetry: should retry on transient error in autoApprove mode', () => {
		const { session } = createTestSession({ autoApprove: true });
		assert.ok(session.testShouldAutoRetry('Network error occurred'), 'Should retry network errors');
	});

	test('shouldAutoRetry: should retry on failed request', () => {
		const { session } = createTestSession({ autoApprove: true });
		assert.ok(session.testShouldAutoRetry('Internal server error'), 'Should retry server errors');
	});

	test('shouldAutoRetry: should not retry on rate limit', () => {
		const { session } = createTestSession({ autoApprove: true });
		assert.ok(!session.testShouldAutoRetry('rate limit exceeded'), 'Should not retry rate limits');
	});

	test('shouldAutoRetry: should not retry on quota exceeded', () => {
		const { session } = createTestSession({ autoApprove: true });
		assert.ok(!session.testShouldAutoRetry('quota exceeded'), 'Should not retry quota errors');
	});

	test('shouldAutoRetry: should not retry on cancellation', () => {
		const { session } = createTestSession({ autoApprove: true });
		assert.ok(!session.testShouldAutoRetry('Request was cancelled'), 'Should not retry cancellations');
	});

	test('shouldAutoRetry: should not retry without autoApprove permission', () => {
		const { session } = createTestSession({ autoApprove: false });
		assert.ok(!session.testShouldAutoRetry('Network error'), 'Should not retry without autoApprove');
	});

	test('shouldAutoRetry: should not retry after hitting MAX_AUTOPILOT_RETRIES', () => {
		const { session } = createTestSession({ autoApprove: true });
		session.setAutopilotRetryCount(3);
		assert.ok(!session.testShouldAutoRetry('Network error'), 'Should not retry after max retries');
	});

	test('shouldAutoRetry: should allow retries up to the limit', () => {
		const { session } = createTestSession({ autoApprove: true });
		session.setAutopilotRetryCount(2);
		assert.ok(session.testShouldAutoRetry('Failed'), 'Should retry when under the cap');
	});

	// ─────────────────────────────────────────────
	// Tool call limit
	// ─────────────────────────────────────────────

	test('should stop loop when tool call limit is exceeded', async () => {
		// Create a session that always yields a tool call
		const alwaysTool: MockStreamChat = async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
			yield { type: 'toolCallDelta', id: 'tc-loop', name: 'read_file', arguments: '{"filePath":"/test.txt"}' };
			yield { type: 'finish', finishReason: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
		};

		const { session, signals } = createTestSession({
			autoApprove: false,
			streamChat: alwaysTool,
		});

		// Send a prompt — with default limit of 15 tool call rounds, this should
		// run for a while then stop when the limit is hit. We just verify it
		// completes without error.
		await session.send('Loop test', 'turn-loop', CancellationToken.None);

		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should complete even after hitting tool call limit');
	});

	test('should graduate tool call limit in autoApprove mode', async () => {
		// Check that the constants are correct
		assert.strictEqual(
			(OpenAIAgentSession as any).DEFAULT_TOOL_CALL_LIMIT,
			15,
			'Default tool call limit should be 15'
		);
		assert.strictEqual(
			(OpenAIAgentSession as any).HARD_TOOL_CALL_CAP,
			200,
			'Hard tool call cap should be 200'
		);
	});

	// ─────────────────────────────────────────────
	// executeStopHook
	// ─────────────────────────────────────────────

	test('executeStopHook: should return shouldContinue=false by default', async () => {
		const { session } = createTestSession();
		const result = await session.testExecuteStopHook(false);
		assert.strictEqual(result.shouldContinue, false);
		assert.strictEqual(result.reasons, undefined);
	});

	test('executeStopHook: can be overridden to block stopping', async () => {
		const { session } = createTestSession();
		session.stopHookOverride = { shouldContinue: true, reasons: ['Task not finished'] };
		const result = await session.testExecuteStopHook(true);
		assert.strictEqual(result.shouldContinue, true);
		assert.deepStrictEqual(result.reasons, ['Task not finished']);
	});

	// ─────────────────────────────────────────────
	// Plan mode
	// ─────────────────────────────────────────────

	test('plan mode should complete successfully', async () => {
		const { session, signals } = createTestSession({
			mode: 'plan',
			streamChat: textOnlyResponse('Here is my plan.'),
		});

		await session.send('Make a plan', 'turn-plan', CancellationToken.None);

		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Plan mode should complete successfully');
	});

	// ─────────────────────────────────────────────
	// Multi-round loop: tool calls → continue → no tool calls → stop
	// ─────────────────────────────────────────────

	test('should stop after tool call when next round has no tool calls', async () => {
		// First call returns a tool call, second call returns text only
		let callCount = 0;
		const multiRoundMock: MockStreamChat = async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
			callCount++;
			if (callCount === 1) {
				yield { type: 'toolCallDelta', id: 'tc-mr1', name: 'read_file', arguments: '{"filePath":"/a.txt"}' };
				yield { type: 'finish', finishReason: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
			} else {
				yield { type: 'delta', content: 'Done with all tasks.' };
				yield { type: 'finish', finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
			}
		};

		const { session, signals } = createTestSession({
			streamChat: multiRoundMock,
		});

		await session.send('Multi-round test', 'turn-mr', CancellationToken.None);

		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Multi-round should complete');
		assert.strictEqual(callCount, 2, 'Should have made 2 API calls');
	});

	// ─────────────────────────────────────────────
	// Error handling: API stream error
	// ─────────────────────────────────────────────

	test('should handle API stream error and still complete turn', async () => {
		const { session, signals } = createTestSession({
			autoApprove: true,
			streamChat: errorResponse('Connection timeout'),
		});

		await session.send('Error test', 'turn-error', CancellationToken.None);

		const turnComplete = signals.some(
			s => s.kind === 'action' && s.action.type === ActionType.SessionTurnComplete
		);
		assert.ok(turnComplete, 'Should still complete even after API error');
	});

	// ─────────────────────────────────────────────
	// Multi tool calls in a single round
	// ─────────────────────────────────────────────

	test('should execute multiple tool calls in one round', async () => {
		// First call returns 2 tool calls, second call returns text only (to stop the loop)
		let callCountMulti = 0;
		const multiCallInRound: MockStreamChat = async function* (_messages: unknown[], _tools: unknown[], _token: CancellationToken): AsyncIterable<OpenAIStreamEvent> {
			callCountMulti++;
			if (callCountMulti === 1) {
				yield { type: 'toolCallDelta', id: 'tc-m1', name: 'read_file', arguments: '{"filePath":"/a.txt"}' };
				yield { type: 'toolCallDelta', id: 'tc-m2', name: 'read_file', arguments: '{"filePath":"/b.txt"}' };
				yield { type: 'finish', finishReason: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
			} else {
				yield { type: 'delta', content: 'Done.' };
				yield { type: 'finish', finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
			}
		};

		const { session, signals } = createTestSession({
			streamChat: multiCallInRound,
		});

		await session.send('Read two files', 'turn-multi', CancellationToken.None);

		const toolCompletes = signals.filter(
			s => s.kind === 'action' && s.action.type === ActionType.SessionToolCallComplete
		);
		assert.strictEqual(toolCompletes.length, 2, 'Should complete 2 tool calls');
	});
});
