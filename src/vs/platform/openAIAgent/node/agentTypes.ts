/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A lightweight agent configuration for the Agent Host.
 *
 * Mirrors Copilot's `ICustomAgent` interface without depending on the
 * full VS Code chat infrastructure. Used by {@code OpenAIAgent} to resolve
 * named subagents (e.g. "Explore").
 */
export interface IAgentConfig {
	/** Unique name used to reference this agent (e.g. "Explore"). */
	readonly name: string;

	/** Human-readable description. */
	readonly description?: string;

	/**
	 * Agent instructions / system prompt body.
	 * When set, the subagent session uses this instead of the default system prompt.
	 */
	readonly body?: string;

	/**
	 * Tool whitelist: only these tools are available to the agent.
	 * If undefined or empty, ALL registered tools are available.
	 * Tool names match the {@code ToolName} enum (e.g. "read_file", "grep_search").
	 */
	readonly tools?: readonly string[];

	/**
	 * Model override. A single model identifier (e.g. "deepseek-chat").
	 * When set, subagent uses this model instead of the parent's model.
	 */
	readonly model?: string;

	/** Whether the agent is user-invocable (shown in the agent picker). */
	readonly userInvocable?: boolean;

	/** Whether the agent can only be called by other agents (not users). */
	readonly agentOnly?: boolean;
}

/**
 * Registry of named agents for the Agent Host.
 * Agents are looked up by name when `runSubagent` is called with an `agentName`.
 */
export class AgentRegistry {
	private readonly _agents = new Map<string, IAgentConfig>();

	/**
	 * Register an agent config. Replaces any existing agent with the same name.
	 */
	register(config: IAgentConfig): void {
		this._agents.set(config.name, config);
	}

	/**
	 * Look up an agent by name.
	 * @returns the agent config, or undefined if not found.
	 */
	get(name: string): IAgentConfig | undefined {
		return this._agents.get(name);
	}

	/**
	 * Get all registered agents.
	 */
	getAll(): readonly IAgentConfig[] {
		return [...this._agents.values()];
	}

	/**
	 * Remove an agent by name.
	 */
	unregister(name: string): void {
		this._agents.delete(name);
	}

	/**
	 * Clear all registered agents.
	 */
	clear(): void {
		this._agents.clear();
	}
}
// ==============================================================================
// Hook system (mirrors Copilot's SubagentStart / SubagentStop hooks)
// ==============================================================================

/**
 * Input passed to a SubagentStart hook.
 */
export interface ISubagentStartHookInput {
	/** Unique invocation ID for the subagent. */
	readonly agentId: string;
	/** Agent type name (e.g. "Explore", "(default)"). */
	readonly agentType: string;
}

/**
 * Return value from a SubagentStart hook.
 * Additional context is appended to the subagent's system prompt.
 */
export interface ISubagentStartHookResult {
	readonly additionalContext?: string;
}

/**
 * Input passed to a SubagentStop hook.
 */
export interface ISubagentStopHookInput {
	readonly agentId: string;
	readonly agentType: string;
}

/**
 * Return value from a SubagentStop hook.
 * When `shouldContinue` is true, the subagent is NOT allowed to stop.
 */
export interface ISubagentStopHookResult {
	readonly shouldContinue: boolean;
	readonly reasons?: readonly string[];
}

/**
 * Collection of hooks for a single agent.
 */
export interface IAgentHooks {
	/** Called before the subagent starts. Can add context. */
	subagentStart?: (input: ISubagentStartHookInput) => Promise<ISubagentStartHookResult | undefined>;
	/** Called after the subagent stops. Can block stopping. */
	subagentStop?: (input: ISubagentStopHookInput) => Promise<ISubagentStopHookResult>;
}

/**
 * Registry for subagent lifecycle hooks.
 *
 * Mirrors Copilot's {@code IChatHookService} but simplified for the
 * Agent Host environment.
 */
export class HookRegistry {
	private readonly _hooks = new Map<string, IAgentHooks>();

	/**
	 * Register hooks for a named agent (or '*' for all agents).
	 */
	register(agentName: string, hooks: IAgentHooks): void {
		this._hooks.set(agentName, hooks);
	}

	/**
	 * Get hooks for a specific agent, optionally falling back to global hooks.
	 */
	get(agentName: string): IAgentHooks | undefined {
		return this._hooks.get(agentName) ?? this._hooks.get('*');
	}

	/**
	 * Remove hooks for an agent.
	 */
	unregister(agentName: string): void {
		this._hooks.delete(agentName);
	}

	/**
	 * Clear all registered hooks.
	 */
	clear(): void {
		this._hooks.clear();
	}
}