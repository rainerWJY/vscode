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
import { ResponsePartKind, ToolCallConfirmationReason } from '../../agentHost/common/state/sessionState.js';
import { OpenAIApiClient, type IOpenAIAgentConfig, type OpenAIChatMessage } from './openAIApiClient.js';
import { getAllToolMetas, createTool, type RegisteredTool, type ToolExecutor, type ToolMeta } from './tools/toolRegistry.js';

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
}

export type ToolExecutorFactory = (meta: ToolMeta) => ToolExecutor;

// ---- agent session ----------------------------------------------------------

export class OpenAIAgentSession extends Disposable {
	readonly sessionUri: URI;
	private readonly _apiClient: OpenAIApiClient;
	private readonly _autoApprove: boolean;
	private readonly _mode: OpenAIAgentMode;
	private readonly _onDidSessionProgress: Emitter<AgentSignal>;
	private readonly _tools: Map<string, RegisteredTool> = new Map();
	private readonly _messages: OpenAIChatMessage[] = [];
	private _turnId = '';
	private _currentMarkdownPartId = '';
	private _currentReasoningPartId = '';
	private _aborted = false;

	/** Pending permission requests awaiting user decision. */
	private readonly _pendingPermissions = new Map<string, DeferredPromise<boolean>>();

	constructor(options: IOpenAIAgentSessionOptions, @ILogService private readonly _logService: ILogService) {
		super();
		this.sessionUri = options.sessionUri;
		this._apiClient = new OpenAIApiClient(options.config, this._logService);
		this._autoApprove = options.autoApprove;
		this._mode = options.mode;
		this._onDidSessionProgress = options.onDidSessionProgress;

		this._logService.info(`[OpenAIAgentSession] Constructed: mode=${options.mode}, autoApprove=${options.autoApprove}, tools=${getAllToolMetas().map(t => t.name).join(',')}`);

		// Register built-in tools
		for (const meta of getAllToolMetas()) {
			this._tools.set(meta.name, createTool(meta, options.toolFactory(meta)));
		}
		this._logService.info(`[OpenAIAgentSession] ${this._tools.size} tools registered`);
	}

	private _getSystemPrompt(): string {
		return this._apiClient.systemPrompt || (
			this._mode === 'plan'
				? 'You are an AI coding assistant. Plan mode: you do NOT make changes. Research thoroughly and produce a detailed plan. Call task_complete when done.'
				: 'You are an AI coding assistant. You have access to tools for reading, writing, searching, and executing commands. Always read files before editing them. Call task_complete when done.'
		);
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
	 * This is the main entry point. It builds the conversation, streams
	 * the model response with tool calls, executes tools, feeds results
	 * back, and repeats until the model signals completion.
	 */
	async send(prompt: string, turnId: string, token: CancellationToken): Promise<void> {
		this._logService.info(`[OpenAIAgentSession] send() called: turnId=${turnId}, prompt="${prompt.substring(0, 80)}", historySize=${this._messages.length}`);
		this._logService.info(`[OpenAIAgentSession] Message history summary: ${this._messages.map(m => `${m.role}(${(m.content ?? '').length}c${m.tool_calls ? `+${m.tool_calls.length}tc` : ''})`).join(' → ')}`);

		this._turnId = turnId;
		this._aborted = false;
		this._currentMarkdownPartId = '';
		this._currentReasoningPartId = '';

		// Build initial messages (system + history + user)
		if (this._messages.length === 0) {
			const systemMsg = this._getSystemPrompt();
			this._logService.info(`[OpenAIAgentSession] Injecting system prompt (${systemMsg.length} chars)`);
			this._messages.push({ role: 'system', content: systemMsg });
		}
		this._messages.push({ role: 'user', content: prompt });

		const tools = this._getAvailableTools();
		const toolDefs = tools.map(t => t.toOpenAI());
		this._logService.info(`[OpenAIAgentSession] Available tools: ${tools.map(t => t.meta.name).join(', ')}, total ${this._messages.length} messages`);

		// NOTE: Do NOT emit SessionTurnStarted — the client/protocol handler
		// already creates the turn. Emitting a duplicate causes the response
		// parts to land in mismatched turns and garbles the UI.

		try {
			let round = 0;
			const maxRounds = this._apiClient.maxToolCallRounds;

			while (round < maxRounds && !this._aborted) {
				if (token.isCancellationRequested) {
					this._logService.info(`[OpenAIAgentSession] Cancelled at round ${round}`);
					break;
				}

				const msgSummary = this._messages.map(m => `${m.role}(${(m.content ?? '').length}c${m.tool_calls ? `+${m.tool_calls.length}tc` : ''}${m.tool_call_id ? ` tc=${m.tool_call_id.substring(0, 8)}` : ''})`).join(' → ');
				this._logService.info(`[OpenAIAgentSession] Round ${round + 1}/${maxRounds} — calling API (${this._messages.length} messages) [${msgSummary}]`);
				this._logService.info(`[OpenAIAgentSession] Tools available to API: ${toolDefs.map(t => t.function.name).join(', ')}`);
				const roundStartTime = Date.now();

				// Stream the model response
				let content = '';
				const roundToolCalls: { id: string; name: string; arguments: string }[] = [];
				let reasoning = '';

				try {
					const events = this._apiClient.streamChat(this._messages, toolDefs, token);
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
								this._emitMarkdownDelta(content);
								break;
							case 'toolCallDelta':
								roundToolCalls.push(event);
								this._emitToolCallStart(event.id, event.name);
								break;
							case 'finish':
								this._logService.info(`[OpenAIAgentSession] API round ${round + 1} finished: finishReason=${event.finishReason}, contentLen=${content.length}, toolCalls=${roundToolCalls.length}, reasoningLen=${reasoning.length}, usage=${JSON.stringify(event.usage)}`);
								break;
						}
					}
				} catch (err) {
					this._logService.error(`[OpenAIAgentSession] API stream error: ${err}`, err);
					throw err;
				}

				const roundElapsed = Date.now() - roundStartTime;
				this._logService.info(`[OpenAIAgentSession] Round ${round + 1} API streaming done in ${roundElapsed}ms: content=${content.length}c, reasoning=${reasoning.length}c, toolCalls=${roundToolCalls.length}`);

				if (this._aborted || token.isCancellationRequested) {
					break;
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

				// No tool calls — conversation is complete
				if (roundToolCalls.length === 0) {
					this._logService.info(`[OpenAIAgentSession] No tool calls in round ${round + 1}, turn complete`);
					break;
				}

				this._logService.info(`[OpenAIAgentSession] Executing ${roundToolCalls.length} tool calls: ${roundToolCalls.map(tc => `${tc.name}(${(tc.arguments ?? '').substring(0, 60)})`).join(', ')}`);

				// Execute tool calls
				for (const tc of roundToolCalls) {
					if (this._aborted || token.isCancellationRequested) {
						break;
					}

					this._logService.info(`[OpenAIAgentSession] Tool call start: ${tc.name}(${tc.id}) args=${(tc.arguments ?? '').substring(0, 120)}`);
					const toolStartTime = Date.now();

					const tool = this._tools.get(tc.name);
					if (!tool) {
						this._logService.warn(`[OpenAIAgentSession] Unknown tool: ${tc.name}`);
						this._emitToolCallComplete(tc.id, false);
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
						this._logService.warn(`[OpenAIAgentSession] Invalid params for ${tc.name}: ${tc.arguments.substring(0, 100)}`);
						this._emitToolCallComplete(tc.id, false);
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
						this._logService.info(`[OpenAIAgentSession] Denying destructive tool ${tc.name} (autoApprove=false)`);
						this._emitToolCallComplete(tc.id, false);
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
						const result = await tool.executor({ toolCallId: tc.id, name: tc.name, parameters: params });
						const toolElapsed = Date.now() - toolStartTime;
						const resultPreview = result.content.substring(0, 200);
						this._logService.info(`[OpenAIAgentSession] ${tc.name} done in ${toolElapsed}ms (success=${result.success}, resultLen=${result.content.length}): ${resultPreview}`);
						this._emitToolCallComplete(tc.id, result.success);
						this._messages.push({
							role: 'tool',
							content: result.content,
							tool_call_id: tc.id,
							name: tc.name,
						});
						this._logService.trace(`[OpenAIAgentSession] Tool result pushed: role=tool, tc=${tc.id.substring(0, 8)}, contentLen=${result.content.length}`);
					} catch (err) {
						const toolElapsed = Date.now() - toolStartTime;
						const errMsg = err instanceof Error ? err.message : String(err);
						this._logService.error(`[OpenAIAgentSession] ${tc.name} FAILED after ${toolElapsed}ms: ${errMsg}`);
						if (err instanceof Error && err.stack) {
							this._logService.trace(`[OpenAIAgentSession] ${tc.name} error stack: ${err.stack.split('\n').slice(0, 5).join('\n')}`);
						}
						this._emitToolCallComplete(tc.id, false);
						this._messages.push({
							role: 'tool',
							content: `Error: ${errMsg}`,
							tool_call_id: tc.id,
							name: tc.name,
						});
					}
				}

				round++;
				if (round >= maxRounds) {
					this._logService.warn(`[OpenAIAgentSession] Hit max tool-call rounds (${maxRounds}), stopping.`);
					break;
				}
			}

			this._logService.info(`[OpenAIAgentSession] send() complete: turnId=${turnId}, totalMessages=${this._messages.length}`);
			this._emitTurnComplete(turnId);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[OpenAIAgentSession] send() FAILED: ${errMsg}`, err);
			this._emitSessionError(turnId, errMsg);
		}
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
			type: ActionType.SessionResponsePart,
			turnId: this._turnId,
			part: { kind: ResponsePartKind.Markdown, id: this._currentMarkdownPartId, content },
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

	private _emitToolCallStart(toolCallId: string, toolName: string): void {
		this._emitAction({
			type: ActionType.SessionToolCallStart,
			turnId: this._turnId, toolCallId, toolName,
			displayName: toolName,
		});
		// Mark tool as auto-confirmed immediately
		this._emitAction({
			type: ActionType.SessionToolCallReady,
			turnId: this._turnId, toolCallId,
			invocationMessage: `Running ${toolName}...`,
			toolInput: '',
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
	}

	private _emitToolCallComplete(toolCallId: string, success: boolean): void {
		this._emitAction({
			type: ActionType.SessionToolCallComplete,
			turnId: this._turnId, toolCallId,
			result: { success, pastTenseMessage: success ? 'Completed' : 'Failed' },
		});
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
