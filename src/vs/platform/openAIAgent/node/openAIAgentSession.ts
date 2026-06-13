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
import { BUILTIN_TOOL_METAS, createTool, type RegisteredTool, type ToolExecutor, type ToolMeta } from './openAIAgentTools.js';

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
		this._apiClient = new OpenAIApiClient(options.config);
		this._autoApprove = options.autoApprove;
		this._mode = options.mode;
		this._onDidSessionProgress = options.onDidSessionProgress;

		// Register built-in tools
		for (const meta of BUILTIN_TOOL_METAS) {
			this._tools.set(meta.name, createTool(meta, options.toolFactory(meta)));
		}

		this._register(this);
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
		this._turnId = turnId;
		this._aborted = false;
		this._currentMarkdownPartId = '';
		this._currentReasoningPartId = '';

		// Build initial messages (system + history + user)
		if (this._messages.length === 0) {
			this._messages.push({ role: 'system', content: this._getSystemPrompt() });
		}
		this._messages.push({ role: 'user', content: prompt });

		const tools = this._getAvailableTools();
		const toolDefs = tools.map(t => t.toOpenAI());

		try {
			let round = 0;
			const maxRounds = this._apiClient.maxToolCallRounds;

			while (round < maxRounds && !this._aborted) {
				if (token.isCancellationRequested) {
					break;
				}

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
								this._emitMarkdownDelta(event.content);
								break;
							case 'toolCallDelta':
								roundToolCalls.push(event);
								this._emitToolCallStart(event.id, event.name);
								break;
							case 'finish':
								this._logService.trace(`[OpenAIAgent] Turn ${round} finished: ${event.finishReason}, usage=${JSON.stringify(event.usage)}`);
								break;
						}
					}
				} catch (err) {
					this._logService.error(`[OpenAIAgent] API stream error: ${err}`);
					throw err;
				}

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
					break;
				}

				// Execute tool calls
				for (const tc of roundToolCalls) {
					if (this._aborted || token.isCancellationRequested) {
						break;
					}

					const tool = this._tools.get(tc.name);
					if (!tool) {
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
						const result = await tool.executor({ toolCallId: tc.id, name: tc.name, parameters: params });
						this._emitToolCallComplete(tc.id, result.success);
						this._messages.push({
							role: 'tool',
							content: result.content,
							tool_call_id: tc.id,
							name: tc.name,
						});
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
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
					this._logService.warn(`[OpenAIAgent] Hit max tool-call rounds (${maxRounds}), stopping.`);
					break;
				}
			}

			this._emitTurnComplete(turnId);
		} catch (err) {
			this._logService.error(`[OpenAIAgent] Session error: ${err}`);
			this._emitSessionError(turnId, err instanceof Error ? err.message : String(err));
		}
	}

	abort(): void {
		this._aborted = true;
		for (const [, d] of this._pendingPermissions) { d.complete(false); }
		this._pendingPermissions.clear();
	}

	/** Resolve a pending permission request. */
	resolvePermission(requestId: string, approved: boolean): void {
		const entry = this._pendingPermissions.get(requestId);
		if (entry) { this._pendingPermissions.delete(requestId); entry.complete(approved); }
	}

	getMessages(): OpenAIChatMessage[] {
		return this._messages;
	}

	// ---- AHP event emission --------------------------------------------------

	private _emitAction(action: SessionAction): void {
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
