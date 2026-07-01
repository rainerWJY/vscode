/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../base/common/observable.js';
import { URI } from '../../../base/common/uri.js';
import { joinPath } from '../../../base/common/resources.js';
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
	type UserMessage,
} from '../../agentHost/common/state/sessionState.js';
import { ResponsePartKind, TurnState } from '../../agentHost/common/state/protocol/channels-session/state.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { ISyncedCustomization } from '../../agentHost/common/agentPluginManager.js';
import type { ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../agentHost/common/state/protocol/commands.js';
import {
	OpenAIAgentSession,
	type IOpenAIAgentSessionOptions,
	type OpenAIAgentMode,
	type ToolExecutorFactory,
} from './openAIAgentSession.js';
import type { ToolMeta, ToolOutput, ToolInput } from './tools/toolRegistry.js';
import { AgentHostFileSystemService, type IAgentHostFileSystemService } from './services/agentHostFileSystemService.js';
import { AgentHostPathService, type IAgentHostPathService } from './services/agentHostPathService.js';
import { AgentHostIgnoreService, type IAgentHostIgnoreService } from './services/agentHostIgnoreService.js';
import { AgentHostInstructionsService, type IAgentHostInstructionsService } from './services/agentHostInstructionsService.js';
import { AgentHostWorkingDirectory } from './services/agentHostWorkingDirectory.js';
import { TerminalManager } from './services/agentHostTerminalManager.js';

import { createReadFileExecutor } from './tools/readFileTool.js';
import { createListDirExecutor } from './tools/listDirTool.js';
import { createCreateFileExecutor } from './tools/createFileTool.js';
import { createGrepSearchExecutor } from './tools/grepSearchTool.js';
import { createFileSearchExecutor } from './tools/fileSearchTool.js';
import { createRunInTerminalExecutor } from './tools/runInTerminalTool.js';
import { createSendToTerminalExecutor } from './tools/sendToTerminalTool.js';
import { createKillTerminalExecutor } from './tools/killTerminalTool.js';
import { createFetchWebPageExecutor } from './tools/fetchWebPageTool.js';
import { createViewImageExecutor } from './tools/viewImageTool.js';
import { createGetErrorsExecutor } from './tools/getErrorsTool.js';
import { createSemanticSearchExecutor } from './tools/semanticSearchTool.js';
import { createTaskCompleteExecutor } from './tools/taskCompleteTool.js';
import { createCreateAndRunTaskExecutor } from './tools/createAndRunTaskTool.js';
import { createRunTaskExecutor } from './tools/runTaskTool.js';
import { createGetTaskOutputExecutor } from './tools/getTaskOutputTool.js';
import { createGetTerminalOutputExecutor } from './tools/getTerminalOutputTool.js';
import { createEditFileExecutor } from './tools/editFileTool.js';
import { createReplaceStringExecutor } from './tools/replaceStringTool.js';
import { createMultiReplaceStringExecutor } from './tools/multiReplaceStringTool.js';
import { createApplyPatchExecutor } from './tools/applyPatchTool.js';
import { createRunSubagentExecutor } from './tools/runSubagentTool.js';
import { AgentRegistry, HookRegistry, type IAgentConfig } from './agentTypes.js';
import { loadAgentHostConfig, buildTierModelInfos, resolveTierById, type AgentHostConfigFile } from './agentTierConfig.js';

// ---- Built-in agent configs ------------------------------------------------

/**
 * Read-only tools suitable for exploration / research agents.
 * Mirrors Copilot's `DEFAULT_READ_TOOLS` adapted to our tool names.
 */
const READ_ONLY_TOOLS: readonly string[] = [
	'read_file',
	'list_dir',
	'grep_search',
	'file_search',
	'semantic_search',
	'fetch_webpage',
	'view_image',
	'get_errors',
	'get_terminal_output',
	'testFailure',
	'memory',
	'session_store_sql',
	'vscode_askQuestions',
	'runSubagent',
];

/**
 * Body / system prompt for the built-in Explore agent.
 * Adapted from Copilot extension's `ExploreAgentProvider.buildAgentBody()`.
 */
const EXPLORE_AGENT_BODY = `You are an exploration agent specialized in rapid codebase analysis and answering questions efficiently.

## Search Strategy

- Go **broad to narrow**:
	1. Start with file_search or semantic_search to discover relevant areas
	2. Narrow with grep_search (regex) for specific symbols or patterns
	3. Read files only when you know the path or need full context
- Pay attention to provided agent instructions/rules/skills as they apply to areas of the codebase to better understand architecture and best practices.

## Speed Principles

**Bias for speed** \u2014 return findings as quickly as possible:
- Parallelize independent tool calls (multiple greps, multiple reads)
- Stop searching once you have sufficient context
- Make targeted searches, not exhaustive sweeps

## Output

Report findings directly as a message. Include:
- Specific functions, types, or patterns that can be reused
- Analogous existing features that serve as implementation templates
- Clear answers to what was asked, not comprehensive overviews

Remember: Your goal is searching efficiently through MAXIMUM PARALLELISM to report concise and clear answers.`;

/**
 * Built-in Explore agent config.
 *
 * A read-only code research subagent that autonomously digs through codebases
 * using multiple search strategies. Mirrors Copilot's Explore agent.
 */
const EXPLORE_AGENT_CONFIG: IAgentConfig = {
	name: 'Explore',
	description: 'Fast read-only codebase exploration and Q&A subagent. Prefer over manually chaining multiple search and file-reading operations to avoid cluttering the main conversation. Safe to call in parallel. Specify thoroughness: quick, medium, or thorough.',
	tools: READ_ONLY_TOOLS,
	body: EXPLORE_AGENT_BODY,
	agentOnly: true,
};
import { SYSTEM_PROMPT_INTERACTIVE, SYSTEM_PROMPT_ASK } from './openAIAgentPrompts.js';

// ---- env var helpers --------------------------------------------------------

/** Read the LLM API base URL from env, default to DeepSeek. */
function _getBaseUrl(): string {
	return process.env['LLM_BASE_URL'] ?? 'https://api.deepseek.com/v1';
}

/** Read the LLM model name from env, default to deepseek-chat. */
function _getModel(): string {
	return process.env['LLM_MODEL'] ?? 'deepseek-chat';
}

/** Read the API key from env (checked in priority order). */
function _getApiKey(): string {
	return process.env['LLM_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '';
}

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
		mode: {
			type: 'string',
			title: 'Agent Mode',
			description: 'How the agent should operate.',
			enum: ['interactive', 'ask'],
			enumLabels: ['Agent', 'Ask'],
			default: 'interactive',
		},
	},
};

// ---- tier-based models -----------------------------------------------------

/** Fallback model info when no config file is present. */
const FALLBACK_MODELS: IAgentModelInfo[] = [
	{
		provider: 'openai-agent',
		id: 'medium',
		name: 'medium',
		supportsVision: false,
	},
];

/**
 * Load models from the agent-host config file.
 * Falls back to a single "medium" tier if no config file found.
 */
function loadTierModels(): { models: IAgentModelInfo[]; config: unknown } {
	const config = loadAgentHostConfig();
	if (config && config.tiers.length > 0) {
		return {
			models: buildTierModelInfos(config, 'openai-agent'),
			config,
		};
	}
	return { models: FALLBACK_MODELS, config: undefined };
}

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

	private readonly _models = observableValue<readonly IAgentModelInfo[]>('openai-models', FALLBACK_MODELS);
	readonly models: IObservable<readonly IAgentModelInfo[]> = this._models;

	/** The parsed tier config (from config file), or undefined if not loaded. */
	private _tierConfig: AgentHostConfigFile | undefined;

	private readonly _sessions = this._register(new DisposableMap<string, OpenAIAgentSession>());

	/** Maps session URI string → AgentHostWorkingDirectory for tools. */
	private readonly _sessionWorkingDirs = new Map<string, AgentHostWorkingDirectory>();

	/** Maps session URI string → resolved config values (mode, etc.). */
	private readonly _sessionConfigValues = new Map<string, Record<string, unknown>>();

	/** Maps toolCallId → deferred for pending client tool calls. */
	private readonly _pendingClientToolCalls = new Map<string, DeferredPromise<ToolOutput>>();

	/**
	 * Directory URI for persisted session data, or `undefined` until first use.
	 * Created under the OS temp directory (`~openai-agent-sessions/`).
	 */
	private _sessionDataDir: URI | undefined;

	// Subagent nesting management (prevents infinite recursion)
	private static readonly MAX_SUBAGENT_NESTING_DEPTH = 5;
	/**
	 * Active subagent stack depth per "root session URI".
	 * The root parent has depth 0; each run_subagent call increases depth by 1.
	 * When depth >= MAX_SUBAGENT_NESTING_DEPTH, further run_subagent calls fail.
	 */
	private readonly _subagentDepth = new Map<string, number>();

	/**
	 * Registry of named agents (e.g. "Explore") for subagent dispatch.
	 * Mirrors Copilot's `IPromptsService.getCustomAgents()`.
	 */
	readonly agentRegistry = new AgentRegistry();

	/**
	 * Registry of subagent lifecycle hooks.
	 * Mirrors Copilot's `IChatHookService` — allows SubagentStart/SubagentStop
	 * hooks to provide context and gate subagent lifecycle.
	 */
	readonly hookRegistry = new HookRegistry();

	/**
	 * Configurable cost-tier multiplier limit.
	 * When set (> 0), subagents can only use models whose multiplier is
	 * at most this value. Setting to 0 disables the check.
	 * Reads from env `SUBAGENT_MAX_COST_MULTIPLIER` (default: 1.0).
	 */
	private readonly _maxCostMultiplier: number;

	// ---- Agent Host services (simplified equivalents of Copilot's services) ---
	private readonly _pathService: IAgentHostPathService;
	private readonly _fileSystemService: IAgentHostFileSystemService;
	private readonly _ignoreService: IAgentHostIgnoreService;
	private readonly _instructionsService: IAgentHostInstructionsService;
	private readonly _terminalManager: TerminalManager;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._pathService = new AgentHostPathService(this._logService);
		this._fileSystemService = new AgentHostFileSystemService(this._fileService, this._logService);
		this._ignoreService = new AgentHostIgnoreService(this._fileService, this._logService);
		this._instructionsService = new AgentHostInstructionsService(this._fileSystemService, this._logService);
		this._terminalManager = this._register(new TerminalManager(this._logService));
		this._maxCostMultiplier = parseFloat(process.env['SUBAGENT_MAX_COST_MULTIPLIER'] ?? '1.0');

		// Load tier config from file
		const { models, config } = loadTierModels();
		this._tierConfig = config as AgentHostConfigFile | undefined;
		this._models.set(models, undefined);
		if (this._tierConfig) {
			this._logService.info(`[OpenAIAgent] Loaded ${models.length} model tiers from config`);
		} else {
			this._logService.info(`[OpenAIAgent] No tier config found, using fallback single model`);
		}

		this._logService.info(`[OpenAIAgent] Initialized: maxCostMultiplier=${this._maxCostMultiplier}`);

		// Register built-in named agents
		this._registerBuiltinAgents();

		// Pre-warm services that require async initialization
		this._ignoreService.init().catch(err => this._logService.error('[OpenAIAgent] ignore service init failed', err));
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
		const sessionUri = config?.session ?? AgentSession.uri(AGENT_ID, generateUuid());
		const sessionUriStr = sessionUri.toString();
		const sid = AgentSession.id(sessionUri);

		// If already materialized via sendMessage, return non-provisional
		if (this._sessions.has(sid)) {
			this._logService.info(`[OpenAIAgent] createSession: already materialized, reusing ${sessionUriStr.substring(0, 48)}...`);
			return { session: sessionUri };
		}

		this._logService.info(`[OpenAIAgent] createSession: ${sessionUriStr.substring(0, 48)}... (provisional)`);

		// Store config values so sendMessage() can read them
		if (config?.config) {
			this._sessionConfigValues.set(sessionUriStr, { ...config.config });
		}

		// Store working directory for tools
		if (config?.workingDirectory) {
			this._sessionWorkingDirs.set(sessionUriStr, new AgentHostWorkingDirectory(config.workingDirectory));
			this._terminalManager.setCwd(sessionUriStr, config.workingDirectory.fsPath);
			this._logService.info(`[OpenAIAgent] createSession: storing workingDir=${config.workingDirectory.fsPath} for ${sessionUriStr}`);
		} else {
			this._sessionWorkingDirs.set(sessionUriStr, new AgentHostWorkingDirectory(undefined));
		}

		// Return provisional=true to defer sessionAdded notification until
		// the first sendMessage fires onDidMaterializeSession. This avoids
		// a race where the eagerly-created session shows up in the client
		// cache before _waitForNewSession checks existingKeys.
		return {
			session: sessionUri,
			provisional: true,
		};
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		const config: Record<string, unknown> = {};

		// Default model: first tier (fastest) if config exists, else env
		let defaultModel = _getModel();
		if (this._tierConfig && this._tierConfig.tiers.length > 0) {
			defaultModel = this._tierConfig.tiers[0].id;
		}

		// Merge user-provided values over defaults
		const defaults: Record<string, unknown> = {
			mode: 'agent',
			baseUrl: _getBaseUrl(),
			model: defaultModel,
		};
		for (const [key, defaultValue] of Object.entries(defaults)) {
			config[key] = params.config?.[key] ?? defaultValue;
		}

		return { schema: OPENAI_AGENT_CONFIG_SCHEMA, values: config };
	}

	async sessionConfigCompletions(params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const sid = AgentSession.id(session);
		try {
			const data = await this._loadSessionData(sid);
			if (!data) {
				this._logService.info(`[OpenAIAgent] getSessionMessages: no persisted data for sid=${sid.substring(0, 8)}`);
				return [];
			}
			return this._reconstructTurns(data.messages);
		} catch (err) {
			this._logService.warn(`[OpenAIAgent] getSessionMessages: read error for sid=${sid.substring(0, 8)}: ${err}`);
			return [];
		}
	}

	getSessionMetadata?(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const sid = AgentSession.id(session);
		return this._getSessionMetadata(sid);
	}

	private async _getSessionMetadata(sid: string): Promise<IAgentSessionMetadata | undefined> {
		try {
			const data = await this._loadSessionData(sid);
			if (!data) {
				// Session known to the client (from IndexedDB cache) but not yet
				// persisted on disk — e.g. sessions created before persistence was
				// implemented, or sessions whose data was cleaned. Return a default
				// entry so the user can open it (with empty history) rather than
				// getting AHP_SESSION_NOT_FOUND.
				return {
					session: AgentSession.uri(AGENT_ID, sid),
					startTime: Date.now(),
					modifiedTime: Date.now(),
					summary: 'OpenAI Agent Session',
				};
			}
			const summary = data.messages.length > 1
				? (data.messages[1]?.content ?? '').substring(0, 80)
				: 'OpenAI Agent Session';
			// Restore workingDirectory from persisted data
			const workingDirectory = data.workingDirectory ? URI.parse(data.workingDirectory) : undefined;
			return {
				session: AgentSession.uri(AGENT_ID, sid),
				startTime: data.createdTime,
				modifiedTime: data.modifiedTime,
				summary,
				workingDirectory,
			};
		} catch {
			return undefined;
		}
	}

	async sendMessage(session: URI, prompt: string, _attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sid = AgentSession.id(session);
		const resolvedTurnId = turnId ?? generateUuid();
		this._logService.info(`[OpenAIAgent] sendMessage start: sid=${sid.substring(0, 8)}, prompt="${prompt.substring(0, 100)}", turnId=${resolvedTurnId}`);

		const sessionKey = session.toString();
		const sessionConfig = this._sessionConfigValues.get(sessionKey);

		// Resolve API config: first try tier config (from user's model picker selection),
		// fall back to env vars.
		let apiKey: string;
		let baseUrl: string;
		let model: string;
		let maxTokens: number | undefined;
		const selectedTierId = sessionConfig?.model as string | undefined;
		if (selectedTierId && this._tierConfig) {
			const tier = resolveTierById(this._tierConfig, selectedTierId);
			if (tier) {
				apiKey = tier.apiKey;
				baseUrl = tier.baseUrl;
				model = tier.model;
				maxTokens = tier.maxTokens;
				this._logService.info(`[OpenAIAgent] Resolved tier "${selectedTierId}": model=${model}, baseUrl=${baseUrl}, maxTokens=${maxTokens ?? '(default)'}`);
			} else {
				apiKey = _getApiKey();
				baseUrl = _getBaseUrl();
				model = _getModel();
				this._logService.warn(`[OpenAIAgent] Unknown tier "${selectedTierId}", falling back to env`);
			}
		} else if (this._tierConfig && this._tierConfig.tiers.length > 0) {
			// Auto = first tier (fastest)
			const first = this._tierConfig.tiers[0];
			apiKey = first.apiKey;
			baseUrl = first.baseUrl;
			model = first.model;
			maxTokens = first.maxTokens;
			this._logService.info(`[OpenAIAgent] Auto → first tier "${first.id}": model=${model}, maxTokens=${maxTokens ?? '(default)'}`);
		} else {
			apiKey = _getApiKey();
			baseUrl = _getBaseUrl();
			model = _getModel();
			this._logService.info(`[OpenAIAgent] No config file, using env: model=${model}`);
		}

		// Read mode from session config (set via resolveSessionConfig → mode picker)
		const rawMode = (sessionConfig?.mode as string) || 'interactive';

		// Map UI mode → session mode + system prompt
		let sessionMode: OpenAIAgentMode;
		let systemPrompt: string;
		switch (rawMode) {
			case 'ask':
				sessionMode = 'ask';
				systemPrompt = SYSTEM_PROMPT_ASK;
				break;
			default: // 'agent'
				sessionMode = 'interactive';
				systemPrompt = SYSTEM_PROMPT_INTERACTIVE;
				break;
		}

		this._logService.info(`[OpenAIAgent] Mode=${rawMode} → sessionMode=${sessionMode}`);

		// Get or create the session
		let entry = this._sessions.get(sid);
		if (!entry) {
			this._logService.info(`[OpenAIAgent] No cached session, creating new OpenAIAgentSession`);
			const sessionWorkingDir = this._sessionWorkingDirs.get(session.toString());
			const options: IOpenAIAgentSessionOptions = {
				config: {
					baseUrl,
					apiKey,
					model,
					systemPrompt,
					maxTokens,
				},
				sessionUri: session,
				onDidSessionProgress: this._onDidSessionProgress,
				toolFactory: this._createToolFactory(session),
				autoApprove: true,
				mode: sessionMode,
				workingDirFsPath: sessionWorkingDir?.fsPath,
			};
			entry = this._register(new OpenAIAgentSession(options, this._logService));
			this._sessions.set(sid, entry);
			this._logService.info(`[OpenAIAgent] Session created and cached: sid=${sid.substring(0, 8)}`);

			// Materialize the session: fire onDidMaterializeSession so the
			// agent service emits the deferred sessionAdded notification.
			// This follows the same pattern as CopilotAgent and ClaudeAgent:
			// createSession returns provisional:true, and the notification
			// is deferred until the first sendMessage.
			const wd = sessionWorkingDir?.fsPath ? URI.file(sessionWorkingDir.fsPath) : undefined;
			this._onDidMaterializeSession.fire({ session, workingDirectory: wd, project: undefined });
		} else {
			this._logService.info(`[OpenAIAgent] Using cached session: sid=${sid.substring(0, 8)}`);
		}

		this._logService.info(`[OpenAIAgent] Calling entry.send()...`);
		let sendError: Error | undefined;
		try {
			await entry.send(prompt, resolvedTurnId, CancellationToken.None);
			this._logService.info(`[OpenAIAgent] entry.send() completed successfully`);
		} catch (err) {
			sendError = err instanceof Error ? err : new Error(String(err));
			this._logService.error(`[OpenAIAgent] sendMessage FAILED: ${sendError.message}`, err);
		}

		// Always persist session data — even on send failure, partial state is better than none.
		try {
			await this._persistSessionData(sid, entry.getMessages());
		} catch (persistErr) {
			this._logService.warn(`[OpenAIAgent] Session data persist failed (non-fatal): ${persistErr}`);
		}

		if (sendError) { throw sendError; }
	}

	async disposeSession(session: URI): Promise<void> {
		const sid = AgentSession.id(session);
		this._logService.info(`[OpenAIAgent] disposeSession: sid=${sid.substring(0, 8)}`);
		this._sessionWorkingDirs.delete(session.toString());
		this._terminalManager.disposeSession(session.toString());
		const entry = this._sessions.get(sid);
		if (entry) {
			// Persist final messages before disposal
			try {
				await this._persistSessionData(sid, entry.getMessages());
			} catch (persistErr) {
				this._logService.warn(`[OpenAIAgent] Final persist failed (non-fatal): ${persistErr}`);
			}
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
		const sessionKey = session.toString();
		this._logService.info(`[OpenAIAgent] changeModel: tierId=${model.id} for ${sessionKey}`);

		// Store the selected tier id in session config so sendMessage() can resolve it
		const existing = this._sessionConfigValues.get(sessionKey) ?? {};
		existing.model = model.id;
		this._sessionConfigValues.set(sessionKey, existing);

		// If the session already exists, update its API client config on next send
		const sid = AgentSession.id(session);
		const entry = this._sessions.get(sid);
		if (entry && this._tierConfig) {
			const tier = resolveTierById(this._tierConfig, model.id);
			if (tier) {
				// Reconfigure the existing session's API client for next send
				entry.setApiConfig({
					baseUrl: tier.baseUrl,
					apiKey: tier.apiKey,
					model: tier.model,
				});
				this._logService.info(`[OpenAIAgent] changeModel: updated live session to tier ${model.id} → model=${tier.model}`);
			}
		}

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
		return this._listPersistedSessions();
	}

	private async _listPersistedSessions(): Promise<IAgentSessionMetadata[]> {
		const results: IAgentSessionMetadata[] = [];

		// Include in-memory sessions first (active sendMessage sessions)
		for (const [sid] of this._sessions) {
			const sessionUri = AgentSession.uri(AGENT_ID, sid);
			const sessionUriStr = sessionUri.toString();
			const workingDirEntry = this._sessionWorkingDirs.get(sessionUriStr);
			const workingDirectory = workingDirEntry?.fsPath ? URI.file(workingDirEntry.fsPath) : undefined;
			results.push({
				session: sessionUri,
				startTime: Date.now(),
				modifiedTime: Date.now(),
				summary: 'OpenAI Agent Session',
				workingDirectory,
			});
		}

		// Scan persisted session files
		try {
			const dir = await this._getSessionDataDir();
			const files = await this._fileService.resolve(dir);
			if (files.children) {
				for (const child of files.children) {
					if (child.name.endsWith('.json') && child.isDirectory === false) {
						const sid = child.name.slice(0, -5); // strip .json
						// Skip if already in-memory
						if (this._sessions.has(sid)) { continue; }
						const meta = await this._getSessionMetadata(sid);
						if (meta) { results.push(meta); }
					}
				}
			}
		} catch (err) {
			// Data dir doesn't exist yet — that's fine
			this._logService.trace(`[OpenAIAgent] listSessions: no session data dir (yet)`);
		}

		this._logService.info(`[OpenAIAgent] listSessions: returning ${results.length} sessions (${this._sessions.size} in-memory + ${results.length - this._sessions.size} persisted)`);
		return results.sort((a, b) => b.modifiedTime - a.modifiedTime);
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
		this._logService.info(`[OpenAIAgent] shutdown(): persisting ${sessionCount} session(s)...`);

		// Persist all sessions before shutdown
		const persistPromises: Promise<void>[] = [];
		for (const [sid, session] of this._sessions) {
			persistPromises.push(
				this._persistSessionData(sid, session.getMessages()).catch(err =>
					this._logService.warn(`[OpenAIAgent] shutdown persist failed for ${sid.substring(0, 8)}: ${err}`)
				)
			);
		}
		await Promise.all(persistPromises);

		this._logService.info(`[OpenAIAgent] shutdown(): aborting ${sessionCount} session(s)...`);
		for (const [, session] of this._sessions) {
			session.abort();
		}
		this._sessions.clearAndDisposeAll();
		this._logService.info(`[OpenAIAgent] shutdown() complete`);
	}

	// ---- Tool Factory --------------------------------------------------------

	private _createToolFactory(sessionUri: URI): ToolExecutorFactory {
		const fileService = this._fileService;

		return (meta: ToolMeta): ((input: ToolInput) => Promise<ToolOutput>) => {
			const executor = this._createExecutor(meta, fileService, sessionUri);
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

	private _createExecutor(meta: ToolMeta, fileService: IFileService, sessionUri: URI): (input: ToolInput) => Promise<ToolOutput> {
		// Look up the working directory that was set at session creation time.
		const workingDir = this._sessionWorkingDirs.get(sessionUri.toString());

		const sessionUriStr = sessionUri.toString();

		switch (meta.name) {
			case 'read_file': return createReadFileExecutor(
				this._fileSystemService,
				this._pathService,
				this._ignoreService,
				this._instructionsService,
				this._logService,
				workingDir,
			);
			case 'list_dir': return createListDirExecutor(this._fileSystemService, this._pathService, this._logService, workingDir);
			case 'create_file': return createCreateFileExecutor(fileService, this._pathService, this._ignoreService, this._logService);
			case 'grep_search': return createGrepSearchExecutor(this._pathService, this._logService, workingDir);
			case 'file_search': return createFileSearchExecutor(this._logService, workingDir, this._ignoreService);
			case 'run_in_terminal': return createRunInTerminalExecutor(this._logService, this._terminalManager, sessionUriStr);
			case 'send_to_terminal': return createSendToTerminalExecutor(this._logService, this._terminalManager, sessionUriStr);
			case 'kill_terminal': return createKillTerminalExecutor(this._logService, this._terminalManager, sessionUriStr);
			case 'fetch_webpage': return createFetchWebPageExecutor(this._logService);
			case 'view_image': return createViewImageExecutor(fileService, this._logService);
			case 'get_errors': return createGetErrorsExecutor(this._logService);
			case 'semantic_search': return createSemanticSearchExecutor(this._logService);
			case 'task_complete': return createTaskCompleteExecutor(this._logService);
			case 'create_and_run_task': return createCreateAndRunTaskExecutor(fileService, this._logService, this._terminalManager, sessionUriStr);
			case 'run_task': return createRunTaskExecutor(this._logService);
			case 'get_task_output': return createGetTaskOutputExecutor(this._logService, this._terminalManager, sessionUriStr);
			case 'get_terminal_output': return createGetTerminalOutputExecutor(this._logService, this._terminalManager, sessionUriStr);
			case 'edit_file': return createEditFileExecutor(fileService, this._pathService, this._ignoreService, this._logService);
			case 'replace_string_in_file': return createReplaceStringExecutor(fileService, this._pathService, this._ignoreService, this._logService);
			case 'multi_replace_string_in_file': return createMultiReplaceStringExecutor(fileService, this._pathService, this._ignoreService, this._logService);
			case 'apply_patch': return createApplyPatchExecutor(fileService, this._pathService, this._ignoreService, this._logService);
			case 'runSubagent': return createRunSubagentExecutor(
				this._logService,
				(prompt, description, model, agentName, toolCallId) =>
					this._runSubagent(prompt, description, model, agentName, toolCallId, sessionUri),
			);
			default:
				this._logService.warn(`[OpenAIAgent] Unknown tool called: ${meta.name}`);
				return async (input) => ({
					toolCallId: input.toolCallId,
					content: `Unknown tool: ${meta.name}`,
					success: false,
				});
		}
	}

	/**
	 * Register built-in agents that are always available for subagent dispatch.
	 */
	private _registerBuiltinAgents(): void {
		// Register "Explore" — read-only code research subagent
		this.agentRegistry.register(EXPLORE_AGENT_CONFIG);

		// Legacy alias: models may still call it "Research" (the old name)
		this.agentRegistry.register({
			...EXPLORE_AGENT_CONFIG,
			name: 'Research',
		});

		this._logService.info(
			`[OpenAIAgent] Registered ${this.agentRegistry.getAll().length} built-in agents: ` +
			`[${this.agentRegistry.getAll().map(a => a.name).join(', ')}]`
		);
	}

	// ====================================================================
	// Session persistence — stores OpenAIChatMessage[] to disk for history
	// restore across page refreshes and agent host restarts.
	// ====================================================================

	/**
	 * Lazily initializes and returns the session data directory URI.
	 * Creates the directory on first call.
	 */
	private async _getSessionDataDir(): Promise<URI> {
		if (!this._sessionDataDir) {
			this._sessionDataDir = this._initSessionDataDir();
		}
		try {
			await this._fileService.createFolder(this._sessionDataDir);
		} catch {
			// Already exists — fine
		}
		return this._sessionDataDir;
	}

	private _initSessionDataDir(): URI {
		return joinPath(URI.file(os.tmpdir()), '.openai-agent-sessions');
	}

	/**
	 * Returns the file URI for a session's persisted data.
	 */
	private _getSessionFilePath(sid: string): URI {
		const dir = this._sessionDataDir ?? this._initSessionDataDir();
		return joinPath(dir, `${sid}.json`);
	}

	/**
	 * Persist session messages to a JSON file on disk.
	 */
	private async _persistSessionData(sid: string, messages: readonly { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[]): Promise<void> {
		const fileUri = this._getSessionFilePath(sid);
		await this._getSessionDataDir(); // ensure dir exists

		// Preserve original createdTime from existing persisted data
		let createdTime: number;
		try {
			const existing = await this._loadSessionData(sid);
			createdTime = existing?.createdTime ?? Date.now();
		} catch {
			createdTime = Date.now();
		}

		// Look up the working directory from the in-memory map
		const sessionUri = AgentSession.uri(AGENT_ID, sid).toString();
		const workingDir = this._sessionWorkingDirs.get(sessionUri);

		const data = JSON.stringify({
			createdTime,
			modifiedTime: Date.now(),
			messages,
			...(workingDir?.fsPath ? { workingDirectory: workingDir.fsPath } : {}),
		}, null, 2);

		await this._fileService.writeFile(fileUri, VSBuffer.fromString(data));
		this._logService.trace(`[OpenAIAgent] Persisted ${messages.length} messages for sid=${sid.substring(0, 8)}`);
	}

	/**
	 * Load session data from disk.
	 */
	private async _loadSessionData(sid: string): Promise<{ createdTime: number; modifiedTime: number; workingDirectory?: string; messages: { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }[] } | undefined> {
		const fileUri = this._getSessionFilePath(sid);
		this._logService.trace(`[OpenAIAgent] _loadSessionData: sid=${sid.substring(0, 8)}, fileUri=${fileUri.toString()}`);
		try {
			const fileContent = await this._fileService.readFile(fileUri);
			const text = fileContent.value.toString();
			const parsed = JSON.parse(text);
			this._logService.trace(`[OpenAIAgent] _loadSessionData: loaded ${parsed.messages?.length ?? 0} messages for sid=${sid.substring(0, 8)}`);
			return parsed;
		} catch (err) {
			this._logService.warn(`[OpenAIAgent] _loadSessionData FAILED for sid=${sid.substring(0, 8)} uri=${fileUri.toString()}: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	/**
	 * Convert stored OpenAIChatMessage[] to Turn[] for the session restore API.
	 * Pairs each user message with its subsequent assistant response.
	 */
	private _reconstructTurns(
		messages: readonly { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string; reasoning_content?: string; name?: string }[]
	): Turn[] {
		const turns: Turn[] = [];
		let turnIndex = 0;

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (msg.role !== 'user') { continue; }

			const userText = msg.content ?? '';
			const userMsg: UserMessage = { text: userText };

			// Find the next assistant message (skip tool/system messages)
			let assistantContent = '';
			let reasoningContent = '';
			for (let j = i + 1; j < messages.length; j++) {
				const next = messages[j];
				if (next.role === 'assistant') {
					assistantContent = next.content ?? '';
					reasoningContent = next.reasoning_content ?? '';
					break;
				}
				if (next.role === 'user') { break; }
			}

			const responseParts: Turn['responseParts'] = [];
			if (reasoningContent) {
				responseParts.push({
					kind: ResponsePartKind.Reasoning,
					id: `reasoning-${turnIndex}`,
					content: reasoningContent,
				});
			}
			if (assistantContent) {
				responseParts.push({
					kind: ResponsePartKind.Markdown,
					id: `part-${turnIndex}`,
					content: assistantContent,
				});
			}

			turns.push({
				id: `turn-${turnIndex}`,
				userMessage: userMsg,
				responseParts,
				usage: undefined,
				state: TurnState.Complete,
			});

			turnIndex++;
		}

		return turns;
	}

	/**
	 * Spawn a sub-agent session to run a task autonomously.
	 *
	 * When `agentName` is provided, looks up the named agent from the
	 * {@link agentRegistry} and applies its tool whitelist, instructions,
	 * and model overrides — mirroring Copilot's `runSubagent` tool.
	 *
	 * Emits {@link IAgentSubagentStartedSignal} and
	 * {@link IAgentSubagentCompletedSignal} lifecycle signals, and pipes
	 * all subagent progress to the parent session via `parentToolCallId`,
	 * enabling real-time progress streaming and edit visibility.
	 */
	private async _runSubagent(
		prompt: string,
		description: string,
		modelOverride: string | undefined,
		agentName: string | undefined,
		toolCallId: string,
		parentSession: URI,
	): Promise<string> {
		const subId = generateUuid();
		const subSessionUri = URI.from({ scheme: 'agent', path: `subagent-${subId}` });
		const parentSessionStr = parentSession.toString();

		// -- 1. Nesting depth check --
		const rootKey = parentSessionStr;
		const currentDepth = this._subagentDepth.get(rootKey) ?? 0;
		if (currentDepth >= OpenAIAgent.MAX_SUBAGENT_NESTING_DEPTH) {
			throw new Error(
				`Subagent nesting depth limit (${OpenAIAgent.MAX_SUBAGENT_NESTING_DEPTH}) exceeded. ` +
				'Cannot launch further subagents. Complete the current task or use tools directly.'
			);
		}
		this._subagentDepth.set(rootKey, currentDepth + 1);

		// -- 2. Resolve API config from parent session's tier --
		let apiKey: string;
		let baseUrl: string;
		let maxTokens: number | undefined;
		const parentSessionConfig = this._sessionConfigValues.get(parentSessionStr);
		const parentTierId = parentSessionConfig?.model as string | undefined;
		if (parentTierId && this._tierConfig) {
			const tier = resolveTierById(this._tierConfig, parentTierId);
			if (tier) {
				apiKey = tier.apiKey;
				baseUrl = tier.baseUrl;
				maxTokens = tier.maxTokens;
			} else {
				apiKey = _getApiKey();
				baseUrl = _getBaseUrl();
			}
		} else if (this._tierConfig && this._tierConfig.tiers.length > 0) {
			// Auto = first tier (fastest)
			const first = this._tierConfig.tiers[0];
			apiKey = first.apiKey;
			baseUrl = first.baseUrl;
			maxTokens = first.maxTokens;
		} else {
			apiKey = _getApiKey();
			baseUrl = _getBaseUrl();
		}

		// -- 3. Agent lookup --
		let agentConfig: IAgentConfig | undefined;
		if (agentName) {
			agentConfig = this.agentRegistry.get(agentName);
			if (!agentConfig) {
				throw new Error(
					`Requested agent '${agentName}' not found. ` +
					`Available: [${this.agentRegistry.getAll().map(a => a.name).join(', ')}]. ` +
					'Omit agentName to use the default agent.'
				);
			}
		}

		// -- 4. Model resolution --
		// Priority: explicit override → agent config → parent tier model → env
		const resolvedModel = modelOverride ?? agentConfig?.model ?? (parentTierId && this._tierConfig ? resolveTierById(this._tierConfig, parentTierId)?.model : undefined) ?? _getModel();

		// -- 5. Cost-tier check --
		if (this._maxCostMultiplier > 0 && resolvedModel !== 'deepseek-chat') {
			this._logService.info(
				`[OpenAIAgent] Subagent model="${resolvedModel}" (maxCostMultiplier=${this._maxCostMultiplier})`
			);
		}

		// -- 6. Agent instructions --
		const systemPrompt = agentConfig?.body
			? `${agentConfig.body}\n\n${SYSTEM_PROMPT_INTERACTIVE}`
			: SYSTEM_PROMPT_INTERACTIVE;

		// -- 7. Debug log label --
		const debugLabel = agentName
			? `runSubagent-${agentName}-${subId.substring(0, 8)}`
			: `runSubagent-default-${subId.substring(0, 8)}`;

		this._logService.info(
			`[OpenAIAgent] _runSubagent: id=${subId.substring(0, 8)}, ` +
			`agentName=${agentName ?? '(none)'}, description="${description}", ` +
			`model=${resolvedModel}, depth=${currentDepth + 1}, ` +
			`promptLen=${prompt.length}, debugLabel=${debugLabel}`
		);

		if (agentConfig?.tools?.length) {
			this._logService.info(
				`[OpenAIAgent] Agent '${agentName}' tool whitelist: [${agentConfig.tools.join(', ')}]`
			);
		}

		// -- 8. Tool whitelist filtering --
		const allowedTools = agentConfig?.tools?.length
			? new Set(agentConfig.tools)
			: null;

		function createFilteredToolFactory(
			parent: OpenAIAgent,
			allowed: Set<string> | null,
			aName: string | undefined,
			uri: URI,
			fs: IFileService,
		): ToolExecutorFactory {
			return (meta) => {
				if (allowed && !allowed.has(meta.name)) {
					return async (input) => ({
						toolCallId: input.toolCallId,
						content: `Tool '${meta.name}' is not available for agent '${aName ?? '(default)'}'. ` +
							`Allowed tools: [${[...allowed].join(', ')}]`,
						success: false,
					});
				}
				const executor = parent._createExecutor(meta, fs, uri);
				return async (input) => {
					try {
						return await executor(input);
					} catch (err) {
						return {
							toolCallId: input.toolCallId,
							content: `Error executing '${meta.name}': ${err instanceof Error ? err.message : String(err)}`,
							success: false,
						};
					}
				};
			};
		}

		// -- 8. SubagentStart hook (mirrors Copilot's SubagentStart hook) --
		let hookAdditionalContext: string | undefined;
		const startHook = this.hookRegistry.get(agentName ?? '*');
		if (startHook?.subagentStart) {
			try {
				const hookResult = await startHook.subagentStart({
					agentId: toolCallId,
					agentType: agentName ?? '(default)',
				});
				hookAdditionalContext = hookResult?.additionalContext;
				if (hookAdditionalContext) {
					this._logService.info(
						`[OpenAIAgent] SubagentStart hook provided context for ${agentName ?? '(default)'}`
					);
				}
			} catch (err) {
				this._logService.error(
					`[OpenAIAgent] SubagentStart hook error for ${agentName ?? '(default)'}: ${err}`
				);
			}
		}

		// -- 9. Append hook context to system prompt --
		const finalSystemPrompt = hookAdditionalContext
			? `${systemPrompt}\n\n${hookAdditionalContext}`
			: systemPrompt;

		// -- 10. Subagent lifecycle: emit "started" signal --
		this._onDidSessionProgress.fire({
			kind: 'subagent_started',
			session: parentSession,
			toolCallId,
			agentName: agentName ?? '(default)',
			agentDisplayName: agentConfig?.description ?? agentName ?? 'Subagent',
			agentDescription: agentConfig?.description,
		});

		// -- 11. Inherit parent mode for subagent --
		const parentConfig = this._sessionConfigValues.get(parentSessionStr);
		const parentModeValue = (parentConfig?.mode as string) || 'interactive';
		let subagentMode: OpenAIAgentMode;
		switch (parentModeValue) {
			case 'ask':
				subagentMode = 'ask';
				break;
			default: // 'interactive'
				subagentMode = 'interactive';
				break;
		}

		this._logService.info(
			`[OpenAIAgent] Subagent inheriting parent mode: ${parentModeValue} → ${subagentMode}`
		);

		// -- 12. Create subagent session --
		const subEmitter = new Emitter<AgentSignal>();

		// Pipe subagent progress to the parent session's progress stream.
		// The AHP host uses `parentToolCallId` to route these events to the
		// correct subagent child session, enabling real-time streaming of
		// markdown, reasoning, tool calls, and file edits.
		subEmitter.event((signal) => {
			if (signal.kind === 'action') {
				this._onDidSessionProgress.fire({
					kind: 'action',
					session: parentSession,
					action: signal.action,
					parentToolCallId: toolCallId,
				});
			}
		});

		const options: IOpenAIAgentSessionOptions = {
			config: {
				baseUrl,
				apiKey,
				model: resolvedModel,
				systemPrompt: finalSystemPrompt,
				maxTokens,
			},
			sessionUri: subSessionUri,
			onDidSessionProgress: subEmitter,
			toolFactory: createFilteredToolFactory(this, allowedTools, agentName, subSessionUri, this._fileService),
			autoApprove: true,
			mode: subagentMode,
		};

		const session = new OpenAIAgentSession(options, this._logService);
		const subSessionStart = Date.now();
		try {
			await session.send(prompt, subId, CancellationToken.None);

			const subSessionElapsed = Date.now() - subSessionStart;
			const messages = session.getMessages();
			this._logService.info(
				`[OpenAIAgent] Subagent session done: id=${subId.substring(0, 8)}, ` +
				`agentName=${agentName ?? '(none)'}, mode=${subagentMode}, messages=${messages.length}, ` +
				`duration=${subSessionElapsed}ms, toolsAllowed=${allowedTools?.size ?? 'all'}`
			);

			// Extract the final assistant message as the result
			const resultParts: string[] = [];
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (msg.role === 'assistant' && msg.content) {
					resultParts.unshift(msg.content);
					break;
				}
			}

			const result = resultParts.join('\n').trim() || 'Subagent completed with no output.';
			this._logService.info(
				`[OpenAIAgent] _runSubagent done: id=${subId.substring(0, 8)}, ` +
				`agentName=${agentName ?? '(none)'}, resultLen=${result.length}`
			);
			return result;
		} finally {
			// -- SubagentStop hook (mirrors Copilot's SubagentStop hook) --
			const stopHook = this.hookRegistry.get(agentName ?? '*');
			if (stopHook?.subagentStop) {
				try {
					const stopResult = await stopHook.subagentStop({
						agentId: toolCallId,
						agentType: agentName ?? '(default)',
					});
					if (stopResult.shouldContinue) {
						this._logService.info(
							`[OpenAIAgent] SubagentStop hook blocked stop for ${agentName ?? '(default)'}: ` +
							`${stopResult.reasons?.join('; ')}`
						);
					}
				} catch (err) {
					this._logService.error(
						`[OpenAIAgent] SubagentStop hook error for ${agentName ?? '(default)'}: ${err}`
					);
				}
			}

			// Emit "completed" signal so the host tears down the child session
			this._onDidSessionProgress.fire({
				kind: 'subagent_completed',
				session: parentSession,
				toolCallId,
			});

			// Restore nesting depth
			const afterDepth = (this._subagentDepth.get(rootKey) ?? 1) - 1;
			if (afterDepth <= 0) {
				this._subagentDepth.delete(rootKey);
			} else {
				this._subagentDepth.set(rootKey, afterDepth);
			}
			session.dispose();
		}
	}

	// ---- helpers -------------------------------------------------------------

}
