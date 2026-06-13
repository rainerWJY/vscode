/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import {
	AgentSession,
	AgentSignal,
	IAgent,
	IAgentCreateSessionConfig,
	IAgentCreateSessionResult,
	IAgentDescriptor,
	IAgentMaterializeSessionEvent,
	IAgentModelInfo,
	IAgentResolveSessionConfigParams,
	IAgentSessionConfigCompletionsParams,
	IAgentSessionMetadata,
} from '../../agentHost/common/agentService.js';
import {
	type ConfigSchema,
	type MessageAttachment,
	type ModelSelection,
	type ProtectedResourceMetadata,
	type ToolCallResult,
	type ToolDefinition,
} from '../../agentHost/common/state/protocol/state.js';
import {
	type ClientPluginCustomization,
	getToolOutputText,
	SessionInputResponseKind,
	type SessionInputAnswer,
	type Turn,
} from '../../agentHost/common/state/sessionState.js';
import { ISyncedCustomization } from '../../agentHost/common/agentPluginManager.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../agentHost/common/state/protocol/commands.js';
import {
	OpenAIAgentSession,
	type IOpenAIAgentSessionOptions,
	type ToolExecutorFactory,
} from './openAIAgentSession.js';
import type { ToolMeta, ToolOutput, ToolInput } from './openAIAgentTools.js';
import { SYSTEM_PROMPT_INTERACTIVE } from './openAIAgentPrompts.js';

// ---- config schema ----------------------------------------------------------

const OPENAI_AGENT_CONFIG_SCHEMA: ConfigSchema = {
	type: 'object',
	properties: {
		baseUrl: {
			type: 'string',
			title: 'API Base URL',
			description: 'The base URL of the OpenAI-compatible API (e.g. https://api.deepseek.com).',
			default: 'https://api.deepseek.com',
		},
		model: {
			type: 'string',
			title: 'Model',
			description: 'The model ID to use (e.g. deepseek-chat, gpt-4o, qwen-max).',
			default: 'deepseek-chat',
		},
	},
};

// ---- default models ---------------------------------------------------------

const DEFAULT_MODELS: IAgentModelInfo[] = [
	{
		provider: 'openai-agent',
		id: 'deepseek-chat',
		name: 'DeepSeek V3',
		supportsVision: false,
	},
	{
		provider: 'openai-agent',
		id: 'deepseek-reasoner',
		name: 'DeepSeek R1',
		supportsVision: false,
	},
	{
		provider: 'openai-agent',
		id: 'gpt-4o',
		name: 'GPT-4o',
		supportsVision: true,
	},
	{
		provider: 'openai-agent',
		id: 'gpt-4.1',
		name: 'GPT-4.1',
		supportsVision: true,
	},
	{
		provider: 'openai-agent',
		id: 'claude-sonnet-4-20250514',
		name: 'Claude Sonnet 4',
		supportsVision: true,
	},
	{
		provider: 'openai-agent',
		id: 'qwen-max',
		name: 'Qwen Max',
		supportsVision: false,
	},
	{
		provider: 'openai-agent',
		id: 'llama-3.1-405b',
		name: 'Llama 3.1 405B',
		supportsVision: false,
	},
];

// ---- constants -----------------------------------------------------------------

const AGENT_ID = 'openai-agent';
const AGENT_DISPLAY_NAME = 'OpenAI Compatible Agent';
const AGENT_DESCRIPTION = 'An agent powered by any OpenAI-compatible API (DeepSeek, Qwen, Llama, etc.).';

// ---- agent implementation ---------------------------------------------------

export class OpenAIAgent extends Disposable implements IAgent {
	readonly id = AGENT_ID;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	private readonly _onDidMaterializeSession = this._register(new Emitter<IAgentMaterializeSessionEvent>());
	readonly onDidMaterializeSession: Event<IAgentMaterializeSessionEvent> = this._onDidMaterializeSession.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>('openai-models', DEFAULT_MODELS);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	private readonly _sessions = this._register(new DisposableMap<string, OpenAIAgentSession>());

	/** Maps toolCallId → deferred for pending client tool calls. */
	private readonly _pendingClientToolCalls = new Map<string, DeferredPromise<ToolOutput>>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._logService.info('[OpenAIAgent] Initialized');
	}

	// ---- IAgent interface ----------------------------------------------------

	getDescriptor(): IAgentDescriptor {
		return {
			provider: AGENT_ID,
			displayName: AGENT_DISPLAY_NAME,
			description: AGENT_DESCRIPTION,
		};
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<IAgentCreateSessionResult> {
		const rawSessionId = generateUuid();
		const sessionUri = AgentSession.uri(AGENT_ID, rawSessionId);

		this._logService.info(`[OpenAIAgent] Creating session: ${sessionUri.toString()}`);

		return {
			session: sessionUri,
			provisional: false,
		};
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		return { schema: OPENAI_AGENT_CONFIG_SCHEMA, values: {} };
	}

	async sessionConfigCompletions(params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	getSessionMessages(session: URI): Promise<readonly Turn[]> {
		// Not implemented yet — would reconstruct turns from stored messages
		return Promise.resolve([]);
	}

	async sendMessage(session: URI, prompt: string, _attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sid = AgentSession.id(session);
		let entry = this._sessions.get(sid);
		if (!entry) {
			const options: IOpenAIAgentSessionOptions = {
				config: {
					baseUrl: 'https://api.deepseek.com/v1',
					apiKey: process.env['OPENAI_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '',
					model: 'deepseek-chat',
					systemPrompt: SYSTEM_PROMPT_INTERACTIVE,
				},
				sessionUri: session,
				onDidSessionProgress: this._onDidSessionProgress,
				toolFactory: this._createToolFactory(session),
				autoApprove: false,
				mode: 'interactive',
			};
			entry = this._register(new OpenAIAgentSession(options, this._logService));
			this._sessions.set(sid, entry);
		}
		await entry.send(prompt, turnId ?? generateUuid(), CancellationToken.None);
	}

	async disposeSession(session: URI): Promise<void> {
		const sid = AgentSession.id(session);
		const entry = this._sessions.get(sid);
		if (entry) {
			entry.abort();
			this._sessions.deleteAndDispose(sid);
		}
	}

	async abortSession(session: URI): Promise<void> {
		const entry = this._sessions.get(AgentSession.id(session));
		if (entry) {
			entry.abort();
		}
	}

	changeModel(session: URI, model: ModelSelection): Promise<void> {
		this._logService.info(`[OpenAIAgent] Model change requested to ${model.id} for ${session.toString()} (lazy — will apply on next message)`);
		return Promise.resolve();
	}

	respondToPermissionRequest(requestId: string, approved: boolean): void {
		for (const [, session] of this._sessions) {
			if (session) {
				session.resolvePermission(requestId, approved);
			}
		}
	}

	respondToUserInputRequest(_requestId: string, _response: SessionInputResponseKind, _answers?: Record<string, SessionInputAnswer>): void {
		// Not yet implemented
	}

	authenticate(_resource: string, _token: string): Promise<boolean> {
		return Promise.resolve(true);
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		const results: IAgentSessionMetadata[] = [];
		for (const [sid] of this._sessions) {
			results.push({
				session: AgentSession.uri(AGENT_ID, sid),
				startTime: Date.now(),
				modifiedTime: Date.now(),
				summary: 'OpenAI Agent Session',
			});
		}
		return results;
	}

	setClientTools(_session: URI, _clientId: string, _tools: ToolDefinition[]): void {
		// Not yet implemented — would register custom tools from the client
	}

	onClientToolCallComplete(_session: URI, toolCallId: string, _result: ToolCallResult): void {
		const deferred = this._pendingClientToolCalls.get(toolCallId);
		if (deferred) {
			this._pendingClientToolCalls.delete(toolCallId);
			deferred.complete({
				toolCallId,
				content: getToolOutputText(_result) ?? 'Client tool completed',
				success: true,
			});
		}
	}

	setCustomizationEnabled(_id: string, _enabled: boolean): void {
		// Not yet implemented
	}

	async setClientCustomizations(_session: URI, _clientId: string, _customizations: ClientPluginCustomization[]): Promise<ISyncedCustomization[]> {
		return [];
	}

	async shutdown(): Promise<void> {
		for (const [, session] of this._sessions) {
			session.abort();
		}
		this._sessions.clearAndDisposeAll();
	}

	// ---- Tool Factory --------------------------------------------------------

	private _createToolFactory(_sessionUri: URI): ToolExecutorFactory {
		const fileService = this._fileService;

		return (meta: ToolMeta): ((input: ToolInput) => Promise<ToolOutput>) => {
			switch (meta.name) {
				case 'read_file': return async (input) => {
					try {
						const filePath = input.parameters.filePath as string;
						const startLine = (input.parameters.startLine as number | undefined) ?? 1;
						const endLine = input.parameters.endLine as number | undefined;
						const fileUri = URI.file(filePath);
						const content = await fileService.readFile(fileUri);
						const text = content.value.toString();
						const lines = text.split('\n');
						const s = Math.max(1, startLine) - 1;
						const e = endLine ? Math.min(lines.length, endLine) : lines.length;
						const selected = lines.slice(s, e).join('\n');
						return { toolCallId: input.toolCallId, content: selected, success: true };
					} catch (err) {
						return { toolCallId: input.toolCallId, content: `Error reading file: ${err}`, success: false };
					}
				};

				case 'write_file': return async (input) => {
					try {
						const filePath = input.parameters.filePath as string;
						const content = input.parameters.content as string;
						const fileUri = URI.file(filePath);
						await fileService.writeFile(fileUri, VSBuffer.fromString(content));
						return { toolCallId: input.toolCallId, content: `File written: ${filePath}`, success: true };
					} catch (err) {
						return { toolCallId: input.toolCallId, content: `Error writing file: ${err}`, success: false };
					}
				};

				case 'list_dir': return async (input) => {
					try {
						const dirPath = input.parameters.path as string;
						const dirUri = URI.file(dirPath);
						const stat = await fileService.resolve(dirUri);
						if (!stat.children) {
							return { toolCallId: input.toolCallId, content: 'Empty directory', success: true };
						}
						const entries = stat.children.map(c => c.isDirectory ? `${c.name}/` : c.name).join('\n');
						return { toolCallId: input.toolCallId, content: entries, success: true };
					} catch (err) {
						return { toolCallId: input.toolCallId, content: `Error listing directory: ${err}`, success: false };
					}
				};

				case 'search': return async (input) => {
					try {
						const query = input.parameters.query as string;
						const { patternSync } = await this._loadGlob();
						const files = patternSync(query, { cwd: '/' });
						const result = files.slice(0, 200).join('\n') || 'No files found';
						return { toolCallId: input.toolCallId, content: result, success: true };
					} catch (err) {
						return { toolCallId: input.toolCallId, content: `Error searching: ${err}`, success: false };
					}
				};

				case 'grep': return async (input) => {
					try {
						const query = input.parameters.query as string;
						const includePattern = input.parameters.includePattern as string | undefined;

						// Use ripgrep if available
						const { execSync } = await import('node:child_process');
						const args = ['--line-number', '--color=never', '--max-count=50', '--no-heading'];
						if (includePattern) { args.push('--glob', includePattern); }
						args.push(query);

						try {
							const output = execSync(`rg ${args.map(a => `"${a}"`).join(' ')}`, {
								cwd: '/',
								timeout: 10_000,
								maxBuffer: 512 * 1024,
							});
							return { toolCallId: input.toolCallId, content: output.toString() || 'No matches found', success: true };
						} catch {
							return { toolCallId: input.toolCallId, content: 'No matches found', success: true };
						}
					} catch {
						return { toolCallId: input.toolCallId, content: 'grep not available', success: false };
					}
				};

				case 'bash': return async (input) => {
					try {
						const command = input.parameters.command as string;
						const { execSync } = await import('node:child_process');
						const output = execSync(command, {
							timeout: 30_000,
							maxBuffer: 1024 * 1024,
							encoding: 'utf-8',
						});
						return { toolCallId: input.toolCallId, content: output || '(no output)', success: true };
					} catch (err) {
						const stderr = typeof err === 'object' && err !== null ? (err as Record<string, unknown>).stderr : undefined;
						return { toolCallId: input.toolCallId, content: `Command failed: ${typeof stderr === 'string' ? stderr : (err instanceof Error ? err.message : String(err))}`, success: false };
					}
				};

				case 'web_search': return async (input) => {
					// Placeholder — would call a search API
					return { toolCallId: input.toolCallId, content: 'Web search not configured. Please install a search API or use other tools.', success: false };
				};

				case 'task_complete': return async (input) => {
					return { toolCallId: input.toolCallId, content: `Task completed: ${input.parameters.summary || 'Done'}`, success: true };
				};

				default:
					return async (input) => ({
						toolCallId: input.toolCallId,
						content: `Unknown tool: ${meta.name}`,
						success: false,
					});
			}
		};
	}

	private async _loadGlob(): Promise<{ patternSync: (pattern: string, opts: Record<string, unknown>) => string[] }> {
		try {
			const globModule = await import('glob');
			return { patternSync: (pattern, opts) => globModule.sync(pattern, opts) };
		} catch {
			return { patternSync: () => [] };
		}
	}

	// ---- helpers -------------------------------------------------------------

}
