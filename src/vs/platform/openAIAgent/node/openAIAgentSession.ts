/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { AgentSignal, IAgentActionSignal } from '../../agentHost/common/agentService.js';
import { ActionType, type SessionAction } from '../../agentHost/common/state/sessionActions.js';
import { ResponsePartKind, ToolCallConfirmationReason, ToolResultContentType, type ToolResultContent } from '../../agentHost/common/state/sessionState.js';
import { OpenAIApiClient, type IOpenAIAgentConfig, type OpenAIChatMessage } from './openAIApiClient.js';
import { getAllToolMetas, createTool, type RegisteredTool, type ToolExecutor, type ToolMeta, type ToolFileEdit } from './tools/toolRegistry.js';

// ---- session options --------------------------------------------------------

export type OpenAIAgentMode = 'interactive' | 'plan';

export interface IOpenAIAgentSessionOptions {
	readonly config: IOpenAIAgentConfig;
	readonly sessionUri: URI;
	readonly onDidSessionProgress: Emitter<AgentSignal>;
	/** Tool executors returned from the factory. */
	readonly toolFactory: ToolExecutorFactory;
	/** Whether destructive tools are auto-approved. */
	readonly autoApprove: boolean;
	/** Current session mode. */
	readonly mode: OpenAIAgentMode;
	/** Absolute filesystem path of the working directory (workspace root). */
	readonly workingDirFsPath?: string;
}

export type ToolExecutorFactory = (meta: ToolMeta) => ToolExecutor;

// ---- agent session ----------------------------------------------------------

export class OpenAIAgentSession extends Disposable {
	readonly sessionUri: URI;
	private readonly _apiClient: OpenAIApiClient;
	private readonly _autoApprove: boolean;
	private readonly _mode: OpenAIAgentMode;
	private readonly _workingDirFsPath: string | undefined;
	private readonly _onDidSessionProgress: Emitter<AgentSignal>;
	private readonly _tools: Map<string, RegisteredTool> = new Map();
	private readonly _messages: OpenAIChatMessage[] = [];
	private _turnId = '';
	private _currentMarkdownPartId = '';
	private _currentReasoningPartId = '';
	private _aborted = false;

	/** Pending permission requests awaiting user decision. */
	private readonly _pendingPermissions = new Map<string, DeferredPromise<boolean>>();

	// ---- Copilot-aligned loop state (mirrors ToolCallingLoop) ----
	private static readonly MAX_AUTOPILOT_RETRIES = 3;
	private static readonly MAX_AUTOPILOT_ITERATIONS = 5;
	private static readonly TASK_COMPLETE_TOOL_NAME = 'task_complete';
	private static readonly DEFAULT_TOOL_CALL_LIMIT = 15;
	private static readonly HARD_TOOL_CALL_CAP = 200;

	private _autopilotRetryCount = 0;
	private _autopilotIterationCount = 0;
	private _taskCompleted = false;
	private _autopilotStopHookActive = false;
	private _lastRoundHadToolCalls = false;

	constructor(options: IOpenAIAgentSessionOptions, @ILogService private readonly _logService: ILogService) {
		super();
		this.sessionUri = options.sessionUri;
		this._apiClient = new OpenAIApiClient(options.config, this._logService);
		this._autoApprove = options.autoApprove;
		this._mode = options.mode;
		this._workingDirFsPath = options.workingDirFsPath;
		this._onDidSessionProgress = options.onDidSessionProgress;

		this._logService.info(`[OpenAIAgentSession] Constructed: mode=${options.mode}, autoApprove=${options.autoApprove}, tools=${getAllToolMetas().map(t => t.name).join(',')}`);

		// Register built-in tools
		for (const meta of getAllToolMetas()) {
			this._tools.set(meta.name, createTool(meta, options.toolFactory(meta)));
		}
		this._logService.info(`[OpenAIAgentSession] ${this._tools.size} tools registered`);
	}

	private _getSystemPrompt(): string {
		const basePrompt = this._apiClient.systemPrompt || (
			this._mode === 'plan'
				? 'You are an AI coding assistant. Plan mode: you do NOT make changes. Research thoroughly and produce a detailed plan. Call task_complete when done.'
				: 'You are an AI coding assistant. You have access to tools for reading, writing, searching, and executing commands. Always read files before editing them. Call task_complete when done.'
		);

		// Inject working directory context so the LLM knows the project root
		// (mirrors Copilot's WorkspaceFoldersHint mechanism).
		let prompt = basePrompt;
		if (this._workingDirFsPath) {
			prompt += `\n\nI am working in a workspace with the following folder:\n- ${this._workingDirFsPath}\n\nUse this path as the base when listing directories, reading files, or running commands related to the project. Always use absolute paths.`;
		}

		// Inject turnEditedDocuments context so the LLM knows what files have
		// already been edited in this turn (matching Copilot's IBuildPromptContext).
		if (this._turnEditedDocuments.size > 0) {
			const files = [...this._turnEditedDocuments].join('\n');
			prompt += `\n\nFiles already edited in this turn:\n${files}\n\nWhen editing these files, you do NOT need to re-read them — use the edit tools directly.`;
		}

		return prompt;
	}

	/** Replace the tool executor for a given tool name. */
	setToolExecutor(name: string, executor: ToolExecutor): void {
		const existing = this._tools.get(name);
		if (existing) {
			this._tools.set(name, createTool(existing.meta, executor));
		}
	}

	/**
	 * Send a user message and run the tool-calling loop.
	 *
	 * This is the main entry point. It initializes state, builds the
	 * conversation, then delegates to {@link _runLoop} (which mirrors
	 * Copilot's ToolCallingLoop._runLoop).
	 */
	async send(prompt: string, turnId: string, token: CancellationToken): Promise<void> {
		this._logService.info(`[OpenAIAgentSession] send() called: turnId=${turnId}, prompt="${prompt.substring(0, 80)}", historySize=${this._messages.length}`);

		this._turnId = turnId;
		this._aborted = false;
		this._currentMarkdownPartId = '';
		this._currentReasoningPartId = '';
		this._toolProgressStarted.clear();
		this._lastInvocationMessage.clear();
		this._lastDeltaEmitTime.clear();
		this._turnEditedDocuments.clear();
		this._autopilotRetryCount = 0;
		this._autopilotIterationCount = 0;
		this._taskCompleted = false;
		this._autopilotStopHookActive = false;
		this._lastRoundHadToolCalls = false;

		// Build initial messages (system + history + user)
		if (this._messages.length === 0) {
			const systemMsg = this._getSystemPrompt();
			this._logService.info(`[OpenAIAgentSession] Injecting system prompt (${systemMsg.length} chars)`);
			this._messages.push({ role: 'system', content: systemMsg });
		}
		this._messages.push({ role: 'user', content: prompt });

		// NOTE: Do NOT emit SessionTurnStarted — the client/protocol handler
		// already creates the turn. Emitting a duplicate causes the response
		// parts to land in mismatched turns and garbles the UI.

		try {
			await this._runLoop(token);
			this._logService.info(`[OpenAIAgentSession] send() complete: turnId=${turnId}, totalMessages=${this._messages.length}`);
			this._emitTurnComplete(turnId);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[OpenAIAgentSession] send() FAILED: ${errMsg}`, err);
			this._emitSessionError(turnId, errMsg);
		}
	}

	// ====================================================================
	// Copilot-aligned _runLoop: mirrors ToolCallingLoop._runLoop()
	// ====================================================================

	/**
	 * Main tool-calling loop, mirroring Copilot's ToolCallingLoop._runLoop().
	 *
	 * Conceptually identical to the Copilot while(true) at toolCallingLoop.ts:933:
	 *
	 *   while (true) {
	 *       1. Tool call limit check (with autopilot graduated increase)
	 *       2. Cancellation / yield check
	 *       3. Run one LLM round via _runOne()
	 *       4. If no tool calls or error → auto-retry → stop hook → autopilot check → break
	 *       5. Check task_complete → break
	 *       6. Increment round
	 *   }
	 */
	private async _runLoop(token: CancellationToken): Promise<void> {
		let round = 0;
		let stopHookActive = false;
		let stopHookReason: string | undefined;
		let effectiveToolCallLimit = OpenAIAgentSession.DEFAULT_TOOL_CALL_LIMIT;

		while (true) {
			// -- 1. TOOL CALL LIMIT CHECK (mirrors Copilot line 935-945) --
			if (this._lastRoundHadToolCalls && round >= effectiveToolCallLimit) {
				if (this._autoApprove && effectiveToolCallLimit < OpenAIAgentSession.HARD_TOOL_CALL_CAP) {
					// Autopilot: silently increase the limit and continue (Copilot line 939-941)
					effectiveToolCallLimit = Math.min(
						Math.round(effectiveToolCallLimit * 3 / 2),
						OpenAIAgentSession.HARD_TOOL_CALL_CAP
					);
					this._logService.info(`[OpenAIAgentSession] Autopilot: extending tool call limit to ${effectiveToolCallLimit}`);
				} else {
					// Hit limit — break (Copilot hits confirmation dialog, we just break)
					this._logService.warn(`[OpenAIAgentSession] Hit tool call limit (${effectiveToolCallLimit}), stopping`);
					break;
				}
			}

			// -- 2. CANCELLATION CHECK --
			if (this._aborted || token.isCancellationRequested) {
				this._logService.info(`[OpenAIAgentSession] Aborted/cancelled at round ${round}`);
				break;
			}

			try {
				// -- 3. RUN ONE LLM ROUND (mirrors Copilot's runOne() concept) --
				const result = await this._runOne(token, stopHookReason);
				stopHookReason = undefined; // consume after use (Copilot line 1041-1042)
				this._lastRoundHadToolCalls = result.toolCalls.length > 0;

				// If the model produced productive tool calls after being nudged,
				// reset the autopilot stop hook flag (Copilot line 975-978)
				if (this._autopilotStopHookActive &&
					result.toolCalls.length > 0 &&
					!result.toolCalls.some(tc => tc.name === OpenAIAgentSession.TASK_COMPLETE_TOOL_NAME)) {
					this._autopilotStopHookActive = false;
					this._autopilotIterationCount = 0;
				}

				// -- 4. NO TOOL CALLS OR ERROR (mirrors Copilot line 979-1069) --
				if (result.toolCalls.length === 0) {
					// If cancelled, break immediately (Copilot line 981-983)
					if (this._aborted || token.isCancellationRequested) {
						break;
					}

					// Auto-retry on transient errors (Copilot line 985-1001)
					if (result.error && this._shouldAutoRetry(result.error)) {
						this._autopilotRetryCount++;
						this._logService.info(
							`[OpenAIAgentSession] Auto-retrying on error (attempt ${this._autopilotRetryCount}/${OpenAIAgentSession.MAX_AUTOPILOT_RETRIES}): ${result.error}`
						);
						continue;
					}

					// Execute stop hook (Copilot line 1005-1050)
					// Simplified: Agent Host doesn't have IChatHookService, but we
					// provide the same decision loop so subclasses can override.
					if (result.error) {
						const hookResult = await this._executeStopHook(stopHookActive);
						if (hookResult.shouldContinue && hookResult.reasons?.length) {
							stopHookReason = hookResult.reasons.join('; ');
							stopHookActive = true;
							continue;
						}
					}

					// Autopilot internal check: model should call task_complete (Copilot line 1052-1069)
					if (this._autoApprove && !result.error) {
						const autopilotReason = this._shouldAutopilotContinue(result.responseContent);
						if (autopilotReason) {
							this._logService.info('[OpenAIAgentSession] Autopilot internal stop hook: continuing');
							stopHookReason = autopilotReason;
							this._autopilotStopHookActive = true;
							continue;
						}
					}
					// Surface persistent errors to the user before stopping.
					// Without this, auth failures and other unrecoverable errors
					// are silently swallowed and the UI shows a blank response.
					if (result.error) {
						const errMsg = `⚠️ **Error**: ${result.error}`;
						this._logService.warn(`[OpenAIAgentSession] Surfacing error to frontend: ${result.error}`);
						this._emitMarkdownDelta(errMsg);
					}

					// Normal stop (Copilot line 1068: break)
					break;
				}

				// -- 5. EXECUTE TOOL CALLS (moved to _executeToolCalls for clarity) --
				await this._executeToolCalls(result.toolCalls, token);

				// -- 6. TASK COMPLETE CHECK (Copilot lines 389, 975) --
				const hasTaskComplete = result.toolCalls.some(tc => tc.name === OpenAIAgentSession.TASK_COMPLETE_TOOL_NAME);
				if (hasTaskComplete) {
					this._taskCompleted = true;
					this._logService.info('[OpenAIAgentSession] task_complete called, stopping loop');
					break;
				}

				round++;

			} catch (e) {
				// Cancellation during a round: break gracefully (Copilot line 1072-1074)
				if (this._isCancellationError(e) && round > 0) {
					this._logService.info('[OpenAIAgentSession] Cancellation caught mid-round, breaking');
					break;
				}
				throw e;
			}
		}

		this._logService.info(`[OpenAIAgentSession] _runLoop complete: rounds=${round}, totalMessages=${this._messages.length}`);
	}

	// ====================================================================
	// _runOne: mirrors ToolCallingLoop.runOne()
	// ====================================================================

	/**
	 * Run a single iteration of the tool-calling loop.
	 *
	 * Mirrors Copilot's ToolCallingLoop.runOne() at toolCallingLoop.ts:1199.
	 * Builds prompt → calls LLM → streams response → returns tool calls.
	 */
	private async _runOne(
		token: CancellationToken,
		stopHookReason?: string
	): Promise<{ toolCalls: { id: string; name: string; arguments: string }[]; error?: string; responseContent?: string }> {
		const tools = this._getAvailableTools();
		const toolDefs = tools.map(t => t.toOpenAI());

		const _runOneStart = Date.now();
		this._logService.info(`[OpenAIAgentSession] _runOne: messages=${this._messages.length}, tools=${tools.map(t => t.meta.name).join(',')}`);

		// Build messages for this round.
		// If a stop hook reason is present, inject it as a user message so the
		// model knows why it should continue (mirrors Copilot line 312-318).
		const roundMessages = [...this._messages];
		if (stopHookReason) {
			roundMessages.push({
				role: 'user' as const,
				content: `Please continue. Reason: ${stopHookReason}`,
			});
		}

		// Stream the LLM response
		let content = '';
		const roundToolCalls: { id: string; name: string; arguments: string }[] = [];
		let reasoning = '';
		let streamError: string | undefined;

		try {
			const events = this._apiClient.streamChat(roundMessages, toolDefs, token);
			for await (const event of events) {
				if (this._aborted || token.isCancellationRequested) {
					break;
				}
				switch (event.type) {
					case 'reasoning':
						reasoning += event.content;
						this._emitReasoningDelta(event.content);
						break;
					case 'delta':
						content += event.content;
						this._emitMarkdownDelta(event.content);
						break;
					case 'toolCallProgress':
						this._emitToolCallProgress(event.id, event.name, event.arguments, event.partialInput);
						break;
					case 'toolCallDelta':
						roundToolCalls.push(event);
						this._logService.info(`[OpenAIAgentSession] toolCallDelta: ${event.name}(${event.id.substring(0, 8)})`);
						this._emitToolCallStart(event.id, event.name, event.arguments);
						break;
					case 'finish':
						this._logService.trace(`[OpenAIAgentSession] API round finished: finishReason=${event.finishReason}, toolCalls=${roundToolCalls.length}, usage=${JSON.stringify(event.usage)}`);
						if (event.usage) {
							this._emitAction({
								type: ActionType.SessionUsage,
								turnId: this._turnId,
								usage: {
									inputTokens: event.usage.prompt_tokens,
									outputTokens: event.usage.completion_tokens,
									cacheReadTokens: event.usage.prompt_cache_hit_tokens,
									_meta: {
										cacheHitTokens: event.usage.prompt_cache_hit_tokens,
										cacheMissTokens: event.usage.prompt_cache_miss_tokens,
									},
								},
							});
						}
						break;
				}
			}
		} catch (err) {
			streamError = err instanceof Error ? err.message : String(err);
			this._logService.error(`[OpenAIAgentSession] API stream error: ${streamError}`);
			// Don't rethrow — let the loop decide whether to retry (Copilot line 988-1001)
		}

		const _runOneElapsed = Date.now() - _runOneStart;
		this._logService.info(`[OpenAIAgentSession] _runOne done: ${_runOneElapsed}ms, toolCalls=${roundToolCalls.length}, reasoningLen=${reasoning.length}, contentLen=${content.length}${streamError ? `, error=${streamError}` : ''}`);

		if (this._aborted || token.isCancellationRequested) {
			return { toolCalls: [] };
		}

		// Append assistant message to conversation
		const assistantMsg: OpenAIChatMessage = { role: 'assistant', content };
		if (reasoning) { assistantMsg.reasoning_content = reasoning; }
		if (roundToolCalls.length > 0) {
			assistantMsg.tool_calls = roundToolCalls.map(tc => ({
				id: tc.id,
				type: 'function' as const,
				function: { name: tc.name, arguments: tc.arguments },
			}));
		}
		this._messages.push(assistantMsg);

		if (streamError) {
			return { toolCalls: [], error: streamError, responseContent: content };
		}

		return { toolCalls: roundToolCalls, responseContent: content };
	}

	// ====================================================================
	// _executeToolCalls
	// ====================================================================

	/**
	 * Execute the tool calls from a single round and push results back into
	 * the conversation.
	 */
	private async _executeToolCalls(
		toolCalls: { id: string; name: string; arguments: string }[],
		token: CancellationToken
	): Promise<void> {
		this._logService.info(`[OpenAIAgentSession] Executing ${toolCalls.length} tool calls`);

		for (const tc of toolCalls) {
			if (this._aborted || token.isCancellationRequested) {
				break;
			}

			this._logService.info(`[OpenAIAgentSession] Tool call: ${tc.name}(${tc.id.substring(0, 8)})`);
			const toolStartTime = Date.now();

			const tool = this._tools.get(tc.name);
			if (!tool) {
				this._logService.warn(`[OpenAIAgentSession] Unknown tool: ${tc.name}`);
				this._emitToolCallComplete(tc.id, tc.name, false);
				this._messages.push({
					role: 'tool',
					content: `Error: Unknown tool '${tc.name}'`,
					tool_call_id: tc.id,
					name: tc.name,
				});
				continue;
			}

			// Parse parameters
			let params: Record<string, unknown>;
			try {
				params = JSON.parse(tc.arguments || '{}');
			} catch {
				this._logService.warn(`[OpenAIAgentSession] Invalid params for ${tc.name}`);
				this._emitToolCallComplete(tc.id, tc.name, false);
				this._messages.push({
					role: 'tool',
					content: `Error: Invalid JSON parameters: ${tc.arguments}`,
					tool_call_id: tc.id,
					name: tc.name,
				});
				continue;
			}

			// Permission check for destructive tools
			if (tool.meta.isDestructive && !this._autoApprove) {
				this._logService.info(`[OpenAIAgentSession] Denying destructive tool ${tc.name}`);
				this._emitToolCallComplete(tc.id, tc.name, false);
				this._messages.push({
					role: 'tool',
					content: 'User denied permission to execute this tool.',
					tool_call_id: tc.id,
					name: tc.name,
				});
				continue;
			}

			// Execute
			try {
				this._logService.info(`[OpenAIAgentSession] Executing ${tc.name}...`);
				const result = await tool.executor({ toolCallId: tc.id, name: tc.name, parameters: params, cancellationToken: token });
				const toolElapsed = Date.now() - toolStartTime;
				this._logService.info(`[OpenAIAgentSession] ${tc.name} done in ${toolElapsed}ms (success=${result.success}, resultLen=${result.content.length})`);

				// Track edited documents (matching Copilot's turnEditedDocuments)
				if (result.fileEdits) {
					for (const fe of result.fileEdits) {
						this._turnEditedDocuments.add(fe.filePath);
					}
				}

				this._emitToolCallComplete(tc.id, tc.name, result.success, result.content, result.fileEdits, params);
				this._messages.push({
					role: 'tool',
					content: result.content,
					tool_call_id: tc.id,
					name: tc.name,
				});
			} catch (err) {
				const toolElapsed = Date.now() - toolStartTime;
				const errMsg = err instanceof Error ? err.message : String(err);
				this._logService.error(`[OpenAIAgentSession] ${tc.name} FAILED after ${toolElapsed}ms: ${errMsg}`);
				this._emitToolCallComplete(tc.id, tc.name, false, undefined, undefined, params);
				this._messages.push({
					role: 'tool',
					content: `Error: ${errMsg}`,
					tool_call_id: tc.id,
					name: tc.name,
				});
			}
		}
	}

	// ====================================================================
	// Copilot-aligned helper methods
	// ====================================================================

	/**
	 * Whether to auto-retry after a transient error.
	 * Mirrors Copilot's ToolCallingLoop.shouldAutoRetry().
	 */
	private _shouldAutoRetry(error: string): boolean {
		if (!this._autoApprove) {
			return false;
		}
		if (this._autopilotRetryCount >= OpenAIAgentSession.MAX_AUTOPILOT_RETRIES) {
			return false;
		}
		// Don't retry rate-limited or cancellation errors (Copilot line 995-999)
		const lower = error.toLowerCase();
		if (lower.includes('rate limit') || lower.includes('quota') || lower.includes('cancel')) {
			return false;
		}
		return true;
	}

	/**
	 * Autopilot stop hook — the model needs to call task_complete to signal
	 * it's done. Returns a continuation message or undefined to let the loop
	 * stop.
	 *
	 * Mirrors Copilot's ToolCallingLoop.shouldAutopilotContinue().
	 *
	 * @param lastResponseContent - The text content of the last assistant response,
	 *   if any. When the model produces a substantive text-only response with no
	 *   tool calls, we treat it as a final summary and let the loop stop (Copilot
	 *   line 397-401).
	 */
	private _shouldAutopilotContinue(lastResponseContent?: string): string | undefined {
		if (this._taskCompleted) {
			this._logService.info('[OpenAIAgentSession] Autopilot: task_complete was called, stopping');
			return undefined;
		}

		// If the model produced a substantive text response with no tool calls, treat it
		// as a final summary and let the loop stop. Nudging in this case typically just
		// wastes a turn (Copilot line 397-401).
		if (lastResponseContent !== undefined && lastResponseContent.trim().length > 0) {
			this._logService.info('[OpenAIAgentSession] Autopilot: model produced a text-only response, treating as done');
			return undefined;
		}

		// If we repeatedly nudged without progress, stop (Copilot line 404)
		if (this._autopilotIterationCount >= OpenAIAgentSession.MAX_AUTOPILOT_ITERATIONS) {
			this._logService.info(`[OpenAIAgentSession] Autopilot: hit max iterations (${OpenAIAgentSession.MAX_AUTOPILOT_ITERATIONS}), stopping`);
			return undefined;
		}

		// If a prior nudge produced no tool calls, stop (Copilot line 412-415)
		if (this._autopilotStopHookActive) {
			this._logService.info('[OpenAIAgentSession] Autopilot: prior nudge produced no tool calls, stopping');
			return undefined;
		}

		this._autopilotIterationCount++;
		return 'You have not yet marked the task as complete using the task_complete tool. ' +
			'You must call task_complete when done — whether the task involved code changes, answering a question, or any other interaction.\n\n' +
			'Do NOT repeat or restate your previous response. Pick up where you left off.\n\n' +
			'If you were planning, stop planning and start implementing. ' +
			'You are not done until you have fully completed the task.\n\n' +
			'IMPORTANT: Do NOT call task_complete if:\n' +
			'- You have open questions or ambiguities — make good decisions and keep working\n' +
			'- You encountered an error — try to resolve it or find an alternative approach\n' +
			'- There are remaining steps — complete them first\n\n' +
			'When you ARE done, first provide a brief text summary of what was accomplished, then call task_complete. ' +
			'Both the summary message and the tool call are required.\n\n' +
			'Keep working autonomously until the task is truly finished, then call task_complete.';
	}

	/**
	 * Execute the stop hook. Simplified version of Copilot's executeStopHook /
	 * executeSubagentStopHook — Agent Host doesn't have IChatHookService,
	 * so this is a base implementation that subclasses can override.
	 *
	 * Returns { shouldContinue: false } by default, meaning the loop stops
	 * normally. Override to add custom stop-hook logic.
	 */
	protected async _executeStopHook(stopHookActive: boolean): Promise<{ shouldContinue: boolean; reasons?: string[] }> {
		return { shouldContinue: false };
	}

	/**
	 * Check whether an error is a cancellation error.
	 * Mirrors Copilot's isCancellationError() check.
	 */
	private _isCancellationError(e: unknown): boolean {
		if (e instanceof Error) {
			return e.name === 'Canceled' || e.name === 'CancellationError';
		}
		return false;
	}

	abort(): void {
		this._logService.info(`[OpenAIAgentSession] abort() called: turnId=${this._turnId}, pendingPermissions=${this._pendingPermissions.size}`);
		this._aborted = true;
		for (const [, d] of this._pendingPermissions) { d.complete(false); }
		this._pendingPermissions.clear();
	}

	/** Resolve a pending permission request. */
	resolvePermission(requestId: string, approved: boolean): void {
		this._logService.info(`[OpenAIAgentSession] resolvePermission: requestId=${requestId}, approved=${approved}, pendingBefore=${this._pendingPermissions.size}`);
		const entry = this._pendingPermissions.get(requestId);
		if (entry) {
			this._pendingPermissions.delete(requestId);
			entry.complete(approved);
			this._logService.info(`[OpenAIAgentSession] Permission resolved: ${approved ? 'approved' : 'denied'}`);
		} else {
			this._logService.warn(`[OpenAIAgentSession] Permission request not found: ${requestId}`);
		}
	}

	getMessages(): OpenAIChatMessage[] {
		this._logService.trace(`[OpenAIAgentSession] getMessages: returning ${this._messages.length} messages`);
		return this._messages;
	}

	// ---- AHP event emission --------------------------------------------------

	private _emitAction(action: SessionAction): void {
		this._logService.trace(`[OpenAIAgentSession] emitAction: type=${action.type}, turnId=${this._turnId}`);
		const signal: IAgentActionSignal = {
			kind: 'action',
			session: this.sessionUri,
			action,
		};
		this._onDidSessionProgress.fire(signal);
	}

	private _emitMarkdownDelta(content: string): void {
		if (!this._currentMarkdownPartId) {
			this._currentMarkdownPartId = generateUuid();
			this._emitAction({
				type: ActionType.SessionResponsePart,
				turnId: this._turnId,
				part: { kind: ResponsePartKind.Markdown, id: this._currentMarkdownPartId, content },
			});
			return;
		}
		this._emitAction({
			type: ActionType.SessionDelta,
			turnId: this._turnId,
			partId: this._currentMarkdownPartId,
			content,
		});
	}

	private _emitReasoningDelta(content: string): void {
		if (!this._currentReasoningPartId) {
			this._currentReasoningPartId = generateUuid();
			this._emitAction({
				type: ActionType.SessionResponsePart,
				turnId: this._turnId,
				part: { kind: ResponsePartKind.Reasoning, id: this._currentReasoningPartId, content },
			});
			return;
		}
		this._emitAction({
			type: ActionType.SessionReasoning,
			turnId: this._turnId,
			partId: this._currentReasoningPartId,
			content,
		});
	}

	private _emitToolCallStart(toolCallId: string, toolName: string, toolArgs?: string, partialInput?: Record<string, unknown>): void {
		const toolMeta = OpenAIAgentSession.TOOL_META.get(toolName);
		const displayName = toolMeta?.displayName ?? toolName;
		const meta: Record<string, unknown> = {};
		if (toolMeta?.toolKind) {
			meta.toolKind = toolMeta.toolKind;
		}
		// For subagent: extract description and agentName from tool args
		if (toolMeta?.toolKind === 'subagent' && partialInput) {
			const desc = partialInput.description as string | undefined;
			const agentName = partialInput.agentName as string | undefined;
			if (desc) { meta.subagentDescription = desc; }
			if (agentName) { meta.subagentAgentName = agentName; }
		}

		// Avoid duplicate Start — progress may have already emitted it
		if (!this._toolProgressStarted.has(toolCallId)) {
			this._logService.info(`[OpenAIAgentSession] emit Start: ${toolName}(${toolCallId.substring(0, 8)}) meta=${JSON.stringify(meta)}`);
			this._emitAction({
				type: ActionType.SessionToolCallStart,
				turnId: this._turnId, toolCallId, toolName,
				displayName,
				_meta: Object.keys(meta).length > 0 ? meta : undefined,
			});
		}
		// Auto-confirm the tool call (parameters are complete) — transitions
		// streaming → running so the session layer can execute.
		this._logService.info(`[OpenAIAgentSession] emit Ready: ${toolName}(${toolCallId.substring(0, 8)})`);
		this._emitAction({
			type: ActionType.SessionToolCallReady,
			turnId: this._turnId, toolCallId,
			invocationMessage: `Running ${displayName}...`,
			toolInput: toolArgs ?? '',
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
	}

	/** Track which toolCallIds have already been started via _emitToolCallProgress. */
	private readonly _toolProgressStarted = new Set<string>();

	/** Track last emitted invocationMessage per toolCallId to avoid redundant Delta events. */
	private readonly _lastInvocationMessage = new Map<string, string | undefined>();

	/** Track last emission time (ms) per toolCallId for throttling Delta events during streaming. */
	private readonly _lastDeltaEmitTime = new Map<string, number>();
	/** Minimum interval between Delta emissions for the same toolCallId (ms). */
	private static readonly _DELTA_THROTTLE_MS = 150;

	/** Track files edited in the current turn (→ turnEditedDocuments, matching Copilot). */
	private _turnEditedDocuments = new Set<string>();

	/**
	 * Per-tool metadata for enriching protocol actions.
	 * Maps internal tool names → display name + optional toolKind hint.
	 */
	private static readonly TOOL_META: ReadonlyMap<string, { displayName: string; toolKind?: 'terminal' | 'subagent' | 'search' }> = new Map([
		['runSubagent', { displayName: 'Run Subagent', toolKind: 'subagent' }],
		['run_in_terminal', { displayName: 'Run in Terminal', toolKind: 'terminal' }],
		['send_to_terminal', { displayName: 'Send to Terminal', toolKind: 'terminal' }],
		['grep_search', { displayName: 'Search', toolKind: 'search' }],
		['file_search', { displayName: 'Find File', toolKind: 'search' }],
		['semantic_search', { displayName: 'Semantic Search', toolKind: 'search' }],
		['list_dir', { displayName: 'List Directory' }],
		['read_file', { displayName: 'Read File' }],
		['create_file', { displayName: 'Create File' }],
		['edit_file', { displayName: 'Edit File' }],
		['replace_string_in_file', { displayName: 'Edit File' }],
		['multi_replace_string_in_file', { displayName: 'Apply Multiple Edits' }],
		['apply_patch', { displayName: 'Apply Patch' }],
		['fetch_webpage', { displayName: 'Fetch Web Page' }],
		['view_image', { displayName: 'View Image' }],
		['get_errors', { displayName: 'Check Errors' }],
		['task_complete', { displayName: 'Complete Task' }],
		['create_and_run_task', { displayName: 'Create and Run Task' }],
		['run_task', { displayName: 'Run Task' }],
		['get_task_output', { displayName: 'Get Task Output' }],
		['get_terminal_output', { displayName: 'Get Terminal Output' }],
		['kill_terminal', { displayName: 'Kill Terminal' }],
		['vscode_askQuestions', { displayName: 'Ask Questions' }],
		['memory', { displayName: 'Memory' }],
		['session_store_sql', { displayName: 'Query Session Store' }],
		['runTests', { displayName: 'Run Tests' }],
		['testFailure', { displayName: 'Check Test Failures' }],
	]);

	/**
	 * Emit progressive tool call parameter updates as the model streams them.
	 *
	 * Aligned with VS Code LM API's `progress.updateToolInvocation()` + `handleToolStream()`:
	 * - First sight of a toolCallId: emit `SessionToolCallStart` (→ streaming state)
	 * - Then emit `SessionToolCallDelta` with the raw JSON delta + progressive invocationMessage
	 * - `SessionToolCallReady` is emitted later (at finish_reason) to transition streaming → running
	 */
	private _emitToolCallProgress(toolCallId: string, toolName: string, argsDelta: string, partialInput: Record<string, unknown>): void {
		// First sight of this tool call ID: emit Start to enter streaming state
		if (!this._toolProgressStarted.has(toolCallId)) {
			this._toolProgressStarted.add(toolCallId);

			const toolMeta = OpenAIAgentSession.TOOL_META.get(toolName);
			const displayName = toolMeta?.displayName ?? toolName;
			const meta: Record<string, unknown> = {};
			if (toolMeta?.toolKind) {
				meta.toolKind = toolMeta.toolKind;
			}
			if (toolMeta?.toolKind === 'subagent' && partialInput) {
				const desc = partialInput.description as string | undefined;
				const agentName = partialInput.agentName as string | undefined;
				if (desc) { meta.subagentDescription = desc; }
				if (agentName) { meta.subagentAgentName = agentName; }
			}

			this._logService.info(`[OpenAIAgentSession] emit Start (from progress): ${toolName}(${toolCallId.substring(0, 8)}) partial=${JSON.stringify(partialInput)}`);
			this._emitAction({
				type: ActionType.SessionToolCallStart,
				turnId: this._turnId, toolCallId, toolName,
				displayName,
				_meta: Object.keys(meta).length > 0 ? meta : undefined,
			});
		}

		// Compute progressive invocationMessage (Copilot's handleToolStream pattern)
		let invocationMessage: string | undefined;
		if (toolName === 'create_file') {
			const filePath = partialInput.filePath;
			const content = partialInput.content as string | undefined;
			if (filePath && content !== undefined) {
				const lineCount = content.split('\n').length;
				invocationMessage = `Creating ${filePath} (${lineCount} lines)`;
			} else if (content !== undefined) {
				const lineCount = content.split('\n').length;
				invocationMessage = `Creating file (${lineCount} lines)`;
			} else if (filePath) {
				invocationMessage = `Creating ${filePath}`;
			}
		} else if (toolName === 'replace_string_in_file') {
			const filePath = partialInput.filePath;
			const oldString = partialInput.oldString as string | undefined;
			const newString = partialInput.newString as string | undefined;
			if (filePath) {
				const oldLineCount = oldString !== undefined ? (oldString.split('\n').length) : undefined;
				const newLineCount = newString !== undefined ? (newString.split('\n').length) : undefined;
				if (oldLineCount !== undefined && newLineCount !== undefined) {
					invocationMessage = `Replacing ${oldLineCount} lines with ${newLineCount} lines in ${filePath}`;
				} else if (oldLineCount !== undefined) {
					invocationMessage = `Replacing ${oldLineCount} lines in ${filePath}`;
				} else {
					invocationMessage = `Editing ${filePath}`;
				}
			} else {
				invocationMessage = 'Editing file';
			}
		} else if (toolName === 'multi_replace_string_in_file') {
			const replacements = partialInput.replacements as Array<Record<string, unknown>> | undefined;
			if (replacements) {
				const count = replacements.length;
				const filePaths = replacements
					.map(r => r.filePath as string)
					.filter(Boolean)
					.filter((v, i, a) => a.indexOf(v) === i); // unique
				invocationMessage = `Applying ${count} replacement(s) in ${filePaths.length > 0 ? filePaths.join(', ') : 'files'}`;
			} else {
				invocationMessage = 'Applying multiple replacements';
			}
		} else if (toolName === 'apply_patch') {
			const input = partialInput.input as string | undefined;
			if (input) {
				const lineCount = input.split('\n').length;
				invocationMessage = `Applying patch (${lineCount} lines)`;
			} else {
				invocationMessage = 'Applying patch';
			}
		} else if (toolName === 'runSubagent') {
			const description = partialInput.description as string | undefined;
			const agentName = partialInput.agentName as string | undefined;
			if (description && agentName) {
				invocationMessage = `Running ${agentName} agent: ${description}`;
			} else if (description) {
				invocationMessage = `Running subagent: ${description}`;
			} else if (agentName) {
				invocationMessage = `Running ${agentName} agent...`;
			} else {
				invocationMessage = 'Running subagent...';
			}
		} else if (toolName === 'grep_search' || toolName === 'file_search' || toolName === 'semantic_search') {
			const query = partialInput.query as string | undefined;
			if (query) {
				invocationMessage = `Searching: ${query.substring(0, 60)}${query.length > 60 ? '...' : ''}`;
			} else {
				invocationMessage = 'Searching...';
			}
		} else if (toolName === 'fetch_webpage') {
			const urls = partialInput.urls as string[] | undefined;
			if (urls && urls.length > 0) {
				invocationMessage = `Fetching ${urls.length} page(s)`;
			} else {
				const url = partialInput.url as string | undefined;
				if (url) {
					invocationMessage = `Fetching ${url.substring(0, 60)}`;
				} else {
					invocationMessage = 'Fetching web page...';
				}
			}
		} else if (toolName === 'create_and_run_task' || toolName === 'run_task') {
			const label = partialInput.label as string | undefined;
			if (label) {
				invocationMessage = `Running task: ${label}`;
			} else {
				invocationMessage = 'Running task...';
			}
		} else if (toolName === 'edit_file') {
			const filePath = partialInput.filePath as string | undefined;
			if (filePath) {
				invocationMessage = `Editing ${filePath}`;
			} else {
				invocationMessage = 'Editing file...';
			}
		} else if (toolName === 'read_file') {
			const filePath = partialInput.filePath as string | undefined;
			if (filePath) {
				invocationMessage = `Reading ${filePath}`;
			} else {
				invocationMessage = 'Reading file...';
			}
		} else if (toolName === 'list_dir') {
			const path = partialInput.path as string | undefined;
			if (path) {
				invocationMessage = `Listing ${path}`;
			} else {
				invocationMessage = 'Listing directory...';
			}
		} else if (toolName === 'run_in_terminal') {
			const command = partialInput.command as string | undefined;
			if (command) {
				invocationMessage = `Running: ${command.substring(0, 60)}${command.length > 60 ? '...' : ''}`;
			} else {
				invocationMessage = 'Running in terminal...';
			}
		} else if (toolName === 'get_errors') {
			invocationMessage = 'Checking for errors...';
		} else if (toolName === 'vscode_askQuestions') {
			const questions = partialInput.questions as Array<Record<string, unknown>> | undefined;
			if (questions && questions.length > 0) {
				const count = questions.length;
				const first = questions[0].question as string | undefined;
				invocationMessage = first
					? `Asking ${count} question(s): ${first.substring(0, 50)}`
					: `Asking ${count} question(s)`;
			} else {
				invocationMessage = 'Asking questions...';
			}
		} else if (toolName === 'memory') {
			const command = partialInput.command as string | undefined;
			if (command) {
				invocationMessage = `Memory: ${command}`;
			} else {
				invocationMessage = 'Accessing memory...';
			}
		} else if (toolName === 'session_store_sql') {
			const description = partialInput.description as string | undefined;
			if (description) {
				invocationMessage = `Query: ${description}`;
			} else {
				invocationMessage = 'Querying session store...';
			}
		} else if (toolName === 'view_image') {
			const filePath = partialInput.filePath as string | undefined;
			if (filePath) {
				invocationMessage = `Viewing ${filePath}`;
			} else {
				invocationMessage = 'Viewing image...';
			}
		} else if (toolName === 'send_to_terminal') {
			const command = partialInput.command as string | undefined;
			if (command) {
				invocationMessage = `Sending: ${command.substring(0, 60)}`;
			} else {
				invocationMessage = 'Sending to terminal...';
			}
		} else if (toolName === 'kill_terminal') {
			invocationMessage = 'Killing terminal...';
		} else if (toolName === 'get_terminal_output') {
			invocationMessage = 'Getting terminal output...';
		} else if (toolName === 'get_task_output') {
			invocationMessage = 'Getting task output...';
		} else if (toolName === 'runTests') {
			invocationMessage = 'Running tests...';
		} else if (toolName === 'testFailure') {
			invocationMessage = 'Checking test failures...';
		} else if (
			toolName === 'task_complete' ||
			toolName === 'search_workspace_symbols' ||
			toolName === 'get_changed_files'
		) {
			// Generic fallback — use description from partialInput if available
			const desc = partialInput.description as string | undefined;
			if (desc) {
				invocationMessage = desc;
			}
		}

		// Default fallback for any tool: show description if present
		if (!invocationMessage) {
			const desc = partialInput.description as string | undefined;
			if (desc) {
				invocationMessage = desc;
			}
		}

		// Dedup: skip if invocationMessage hasn't changed since last emit for this toolCallId
		const lastMsg = this._lastInvocationMessage.get(toolCallId);
		if (invocationMessage === lastMsg) {
			return;
		}
		this._lastInvocationMessage.set(toolCallId, invocationMessage);

		// Throttle: skip if we emitted for this toolCallId less than 150ms ago,
		// to avoid flooding the client with character-by-character Delta events
		// (most notable for long `run_in_terminal` commands being streamed).
		const now = Date.now();
		const lastEmit = this._lastDeltaEmitTime.get(toolCallId);
		if (lastEmit !== undefined && (now - lastEmit) < OpenAIAgentSession._DELTA_THROTTLE_MS) {
			return;
		}
		this._lastDeltaEmitTime.set(toolCallId, now);

		this._logService.info(`[OpenAIAgentSession] emit Delta: ${toolName}(${toolCallId.substring(0, 8)}) msg=${invocationMessage ?? '(none)'}`);
		this._emitAction({
			type: ActionType.SessionToolCallDelta,
			turnId: this._turnId, toolCallId,
			content: argsDelta,
			invocationMessage,
		});
	}

	private _emitToolCallComplete(toolCallId: string, toolName: string, success: boolean, resultText?: string, fileEdits?: ToolFileEdit[], toolArgs?: Record<string, unknown>): void {
		this._logService.info(`[OpenAIAgentSession] emit Complete: id=${toolCallId.substring(0, 8)} tool=${toolName} success=${success} resultLen=${resultText?.length ?? 0} fileEdits=${fileEdits?.length ?? 0}`);

		// Generate rich pastTenseMessage based on tool type, result, and input args
		const pastTenseMessage = (() => {
			if (!success) { return 'Failed'; }
			switch (toolName) {
				case 'grep_search':
				case 'file_search':
				case 'semantic_search': {
					const query = toolArgs?.query as string | undefined;
					const resultLines = resultText ? resultText.trim().split('\n').filter(l => l.length > 0).length : 0;
					if (query) {
						return resultLines > 0
							? `Searched for "${query.substring(0, 60)}" — ${resultLines} result(s)`
							: `Searched for "${query.substring(0, 60)}" — no results`;
					}
					return resultLines > 0 ? `Found ${resultLines} result(s)` : 'No results found';
				}
				case 'runSubagent': {
					const description = toolArgs?.description as string | undefined;
					const agentName = toolArgs?.agentName as string | undefined;
					const prefix = agentName ? `${agentName}: ` : '';
					if (description) {
						return `${prefix}${description}`;
					}
					return resultText ? resultText.substring(0, 80) : 'Subagent completed';
				}
				case 'list_dir': {
					const path = toolArgs?.path as string | undefined;
					const entries = resultText ? resultText.trim().split('\n').filter(l => l.length > 0).length : 0;
					const pathSuffix = path ? ` ${path}` : '';
					return `Listed directory${pathSuffix} (${entries} entries)`;
				}
				case 'read_file': {
					const filePath = toolArgs?.filePath as string | undefined;
					if (filePath) {
						const fileName = filePath.split('/').pop() || filePath;
						const startLine = toolArgs?.startLine as number | undefined;
						const endLine = toolArgs?.endLine as number | undefined;
						if (startLine !== undefined && endLine !== undefined) {
							return `Read ${fileName}, lines ${startLine} to ${endLine}`;
						}
						return `Read ${fileName}`;
					}
					return 'File read';
				}
				case 'run_in_terminal': {
					const command = toolArgs?.command as string | undefined;
					if (command) {
						return `Ran: ${command.substring(0, 60)}${command.length > 60 ? '...' : ''}`;
					}
					return 'Command executed';
				}
				case 'send_to_terminal': {
					const cmd = toolArgs?.command as string | undefined;
					if (cmd) {
						return `Sent: ${cmd.substring(0, 60)}${cmd.length > 60 ? '...' : ''}`;
					}
					return 'Sent to terminal';
				}
				case 'create_file': {
					const filePath = toolArgs?.filePath as string | undefined;
					if (filePath) {
						return `Created ${filePath.split('/').pop() || filePath}`;
					}
					return 'File created';
				}
				case 'fetch_webpage': {
					const urls = toolArgs?.urls as string[] | undefined;
					if (urls && urls.length > 0) {
						return `Fetched ${urls.length} page(s)`;
					}
					return 'Fetched web page';
				}
				default:
					return 'Completed';
			}
		})();

		const content: ToolResultContent[] = [];
		if (resultText) {
			content.push({ type: ToolResultContentType.Text, text: resultText });
		}
		if (fileEdits) {
			for (const fe of fileEdits) {
				const uriStr = this._makeSessionUri(fe.filePath);
				const item: ToolResultContent = {
					type: ToolResultContentType.FileEdit,
					before: fe.beforeContent !== undefined ? { uri: uriStr, content: { uri: uriStr, sizeHint: fe.beforeContent.length } } : undefined,
					after: fe.afterContent !== undefined ? { uri: uriStr, content: { uri: uriStr, sizeHint: fe.afterContent.length } } : undefined,
					diff: fe.linesAdded !== undefined || fe.linesRemoved !== undefined
						? { added: fe.linesAdded, removed: fe.linesRemoved }
						: undefined,
				};
				content.push(item);
			}
		}

		this._emitAction({
			type: ActionType.SessionToolCallComplete,
			turnId: this._turnId, toolCallId,
			result: {
				success,
				pastTenseMessage,
				content: content.length > 0 ? content : undefined,
			},
		});
	}

	/** Build a session-scoped URI for a file path, for use in protocol FileEdit content refs. */
	private _makeSessionUri(filePath: string): string {
		return `file://${filePath.startsWith('/') ? '' : '/'}${filePath}`;
	}

	private _emitTurnComplete(turnId: string): void {
		this._emitAction({
			type: ActionType.SessionTurnComplete,
			turnId,
		});
	}

	private _emitSessionError(turnId: string, message: string): void {
		this._emitAction({
			type: ActionType.SessionError,
			turnId,
			error: {
				errorType: 'OpenAIAgentError',
				message,
			},
		});
	}

	/** Filter tools based on the current mode. */
	private _getAvailableTools(): RegisteredTool[] {
		if (this._mode === 'plan') {
			// Plan mode: only read/search tools, no destructive tools
			return [...this._tools.values()].filter(
				t => !t.meta.isDestructive && t.meta.name !== 'task_complete'
			);
		}
		// Interactive mode: all tools
		return [...this._tools.values()];
	}
}
