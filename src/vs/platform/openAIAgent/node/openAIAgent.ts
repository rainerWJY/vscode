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
		// Use the client-prescribed session URI if provided (eager-create flow),
		// otherwise generate a new one.
		const sessionUri = config?.session ?? AgentSession.uri(AGENT_ID, generateUuid());

		this._logService.info(`[OpenAIAgent] Creating session: ${sessionUri.toString()} (provisional=${config?.session ? 'false' : 'false'})`);

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
		const resolvedTurnId = turnId ?? generateUuid();
		this._logService.info(`[OpenAIAgent] sendMessage start: sid=${sid.substring(0, 8)}, prompt="${prompt.substring(0, 100)}", turnId=${resolvedTurnId}`);

		const apiKey = process.env['OPENAI_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '';
		this._logService.info(`[OpenAIAgent] API config: baseUrl=https://api.deepseek.com/v1, model=deepseek-chat, keyPresent=${!!apiKey}`);

		try {
			let entry = this._sessions.get(sid);
			if (!entry) {
				this._logService.info(`[OpenAIAgent] No cached session, creating new OpenAIAgentSession`);
				const options: IOpenAIAgentSessionOptions = {
					config: {
						baseUrl: 'https://api.deepseek.com/v1',
						apiKey,
						model: 'deepseek-chat',
						systemPrompt: SYSTEM_PROMPT_INTERACTIVE,
					},
					sessionUri: session,
					onDidSessionProgress: this._onDidSessionProgress,
					toolFactory: this._createToolFactory(session),
					autoApprove: true,
					mode: 'interactive',
				};
				entry = this._register(new OpenAIAgentSession(options, this._logService));
				this._sessions.set(sid, entry);
				this._logService.info(`[OpenAIAgent] Session created and cached: sid=${sid.substring(0, 8)}`);
			} else {
				this._logService.info(`[OpenAIAgent] Using cached session: sid=${sid.substring(0, 8)}`);
			}

			this._logService.info(`[OpenAIAgent] Calling entry.send()...`);
			await entry.send(prompt, resolvedTurnId, CancellationToken.None);
			this._logService.info(`[OpenAIAgent] entry.send() completed successfully`);
		} catch (err) {
			this._logService.error(`[OpenAIAgent] sendMessage FAILED: ${err instanceof Error ? err.message : String(err)}`, err);
			throw err;
		}
	}

	async disposeSession(session: URI): Promise<void> {
		const sid = AgentSession.id(session);
		this._logService.info(`[OpenAIAgent] disposeSession: sid=${sid.substring(0, 8)}`);
		const entry = this._sessions.get(sid);
		if (entry) {
			entry.abort();
			this._sessions.deleteAndDispose(sid);
			this._logService.info(`[OpenAIAgent] Session disposed: sid=${sid.substring(0, 8)}`);
		}
	}

	async abortSession(session: URI): Promise<void> {
		const sid = AgentSession.id(session);
		this._logService.info(`[OpenAIAgent] abortSession: sid=${sid.substring(0, 8)}`);
		const entry = this._sessions.get(sid);
		if (entry) {
			entry.abort();
			this._logService.info(`[OpenAIAgent] Session aborted: sid=${sid.substring(0, 8)}`);
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

	listSessions(): Promise<IAgentSessionMetadata[]> {
		const results: IAgentSessionMetadata[] = [];
		for (const [sid] of this._sessions) {
			results.push({
				session: AgentSession.uri(AGENT_ID, sid),
				startTime: Date.now(),
				modifiedTime: Date.now(),
				summary: 'OpenAI Agent Session',
			});
		}
		this._logService.info(`[OpenAIAgent] listSessions: returning ${results.length} sessions`);
		return Promise.resolve(results);
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
		const sessionCount = this._sessions.size;
		this._logService.info(`[OpenAIAgent] shutdown(): aborting ${sessionCount} session(s)...`);
		for (const [, session] of this._sessions) {
			session.abort();
		}
		this._sessions.clearAndDisposeAll();
		this._logService.info(`[OpenAIAgent] shutdown() complete`);
	}

	// ---- Tool Factory --------------------------------------------------------

	private _createToolFactory(_sessionUri: URI): ToolExecutorFactory {
		const fileService = this._fileService;

		return (meta: ToolMeta): ((input: ToolInput) => Promise<ToolOutput>) => {
			const executor = this._createExecutor(meta, fileService);
			return async (input) => {
				const startTime = Date.now();
				this._logService.trace(`[OpenAIAgent] Tool executor invoked: name=${meta.name}, toolCallId=${input.toolCallId.substring(0, 8)}, params=${JSON.stringify(input.parameters).substring(0, 200)}`);
				try {
					const result = await executor(input);
					const elapsed = Date.now() - startTime;
					this._logService.trace(`[OpenAIAgent] Tool executor done: name=${meta.name} in ${elapsed}ms, success=${result.success}, contentLen=${result.content.length}`);
					return result;
				} catch (err) {
					const elapsed = Date.now() - startTime;
					this._logService.error(`[OpenAIAgent] Tool executor threw: name=${meta.name} after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
					return { toolCallId: input.toolCallId, content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false };
				}
			};
		};
	}

	private _createExecutor(meta: ToolMeta, fileService: IFileService): (input: ToolInput) => Promise<ToolOutput> {
		switch (meta.name) {
			case 'read_file': return async (input) => {
				try {
					const filePath = input.parameters.filePath as string;
					const startLine = (input.parameters.startLine as number | undefined) ?? 1;
					const endLine = input.parameters.endLine as number | undefined;
					this._logService.trace(`[OpenAIAgent] read_file: path=${filePath}, lines=${startLine}-${endLine ?? 'end'}`);
					const fileUri = URI.file(filePath);
					const content = await fileService.readFile(fileUri);
					const text = content.value.toString();
					const lines = text.split('\n');
					const s = Math.max(1, startLine) - 1;
					const e = endLine ? Math.min(lines.length, endLine) : lines.length;
					const selected = lines.slice(s, e).join('\n');
					return { toolCallId: input.toolCallId, content: selected, success: true };
				} catch (err) {
					this._logService.error(`[OpenAIAgent] read_file ERROR: ${err}`);
					return { toolCallId: input.toolCallId, content: `Error reading file: ${err}`, success: false };
				}
			};

			case 'write_file': return async (input) => {
				try {
					const filePath = input.parameters.filePath as string;
					const content = input.parameters.content as string;
					this._logService.info(`[OpenAIAgent] write_file: path=${filePath}, contentLen=${content.length}`);
					const fileUri = URI.file(filePath);
					await fileService.writeFile(fileUri, VSBuffer.fromString(content));
					return { toolCallId: input.toolCallId, content: `File written: ${filePath}`, success: true };
				} catch (err) {
					this._logService.error(`[OpenAIAgent] write_file ERROR: ${err}`);
					return { toolCallId: input.toolCallId, content: `Error writing file: ${err}`, success: false };
				}
			};

			case 'list_dir': return async (input) => {
				try {
					const dirPath = input.parameters.path as string;
					this._logService.trace(`[OpenAIAgent] list_dir: path=${dirPath}`);
					const dirUri = URI.file(dirPath);
					const stat = await fileService.resolve(dirUri);
					if (!stat.children) {
						return { toolCallId: input.toolCallId, content: 'Empty directory', success: true };
					}
					const entries = stat.children.map(c => c.isDirectory ? `${c.name}/` : c.name).join('\n');
					return { toolCallId: input.toolCallId, content: entries, success: true };
				} catch (err) {
					this._logService.error(`[OpenAIAgent] list_dir ERROR: ${err}`);
					return { toolCallId: input.toolCallId, content: `Error listing directory: ${err}`, success: false };
				}
			};

			case 'search': return async (input) => {
				try {
					const query = input.parameters.query as string;
					this._logService.trace(`[OpenAIAgent] search: query=${query}`);
					const { patternSync } = await this._loadGlob();
					const files = patternSync(query, { cwd: '/' });
					const result = files.slice(0, 200).join('\n') || 'No files found';
					return { toolCallId: input.toolCallId, content: result, success: true };
				} catch (err) {
					this._logService.error(`[OpenAIAgent] search ERROR: ${err}`);
					return { toolCallId: input.toolCallId, content: `Error searching: ${err}`, success: false };
				}
			};

			case 'grep': return async (input) => {
				try {
					const query = input.parameters.query as string;
					const includePattern = input.parameters.includePattern as string | undefined;
					this._logService.trace(`[OpenAIAgent] grep: query=${query}, pattern=${includePattern ?? '*'}`);

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
				} catch (err) {
					this._logService.error(`[OpenAIAgent] grep ERROR: ${err}`);
					return { toolCallId: input.toolCallId, content: 'grep not available', success: false };
				}
			};

			case 'bash': return async (input) => {
				try {
					const command = input.parameters.command as string;
					this._logService.info(`[OpenAIAgent] bash: command="${command.substring(0, 200)}"`);
					const { execSync } = await import('node:child_process');
					const output = execSync(command, {
						timeout: 30_000,
						maxBuffer: 1024 * 1024,
						encoding: 'utf-8',
					});
					const outStr = output || '(no output)';
					this._logService.info(`[OpenAIAgent] bash done: exit=0, outputLen=${outStr.length}`);
					return { toolCallId: input.toolCallId, content: outStr, success: true };
				} catch (err) {
					const stderr = typeof err === 'object' && err !== null ? (err as Record<string, unknown>).stderr : undefined;
					const errMsg = typeof stderr === 'string' ? stderr : (err instanceof Error ? err.message : String(err));
					this._logService.error(`[OpenAIAgent] bash ERROR: ${errMsg.substring(0, 300)}`);
					return { toolCallId: input.toolCallId, content: `Command failed: ${errMsg}`, success: false };
				}
			};

			case 'web_search': return async (input) => {
				this._logService.warn(`[OpenAIAgent] web_search called but not configured: query="${(input.parameters.query as string || '').substring(0, 100)}"`);
				// Placeholder — would call a search API
				return { toolCallId: input.toolCallId, content: 'Web search not configured. Please install a search API or use other tools.', success: false };
			};

			case 'task_complete': return async (input) => {
				this._logService.info(`[OpenAIAgent] task_complete: ${input.parameters.summary || 'Done'}`);
				return { toolCallId: input.toolCallId, content: `Task completed: ${input.parameters.summary || 'Done'}`, success: true };
			};

			default:
				this._logService.warn(`[OpenAIAgent] Unknown tool called: ${meta.name}`);
				return async (input) => ({
					toolCallId: input.toolCallId,
					content: `Unknown tool: ${meta.name}`,
					success: false,
				});
		}
	}

	private async _loadGlob(): Promise<{ patternSync: (pattern: string, opts: Record<string, unknown>) => string[] }> {
		try {
			const globModule = await import('glob');
			this._logService.trace(`[OpenAIAgent] glob loaded successfully`);
			return { patternSync: (pattern, opts) => globModule.sync(pattern, opts) };
		} catch (err) {
			this._logService.warn(`[OpenAIAgent] glob import failed, search tool disabled: ${err instanceof Error ? err.message : String(err)}`);
			return { patternSync: () => [] };
		}
	}

	// ---- helpers -------------------------------------------------------------

}
