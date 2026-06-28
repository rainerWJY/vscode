/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import { ILogService } from '../../log/common/log.js';

// ---- types ------------------------------------------------------------------

/**
 * Configuration for a single model tier.
 * Each tier maps a frontend label (name) to a concrete API endpoint.
 */
export interface TierConfig {
	/** Tier identifier used internally (e.g. 'best', 'medium', 'fastest'). */
	readonly id: string;
	/** Human-readable tier name shown in the model picker (e.g. 'best', 'medium', 'fastest'). */
	readonly name: string;
	/** Optional description shown in the picker. */
	readonly description?: string;
	/** Model ID sent in the API request (e.g. 'gemini-2.0-pro-exp-02-05'). */
	readonly model: string;
	/** API base URL for this tier. */
	readonly baseUrl: string;
	/** API key for this tier. */
	readonly apiKey: string;
	/** Whether the model supports vision. */
	readonly supportsVision?: boolean;
	/** Maximum output tokens for this model (maps to API's max_tokens). */
	readonly maxTokens?: number;
}

/**
 * Top-level structure of the agent-host config file.
 */
export interface AgentHostConfigFile {
	/** Ordered list of model tiers. */
	readonly tiers: TierConfig[];
}

// ---- default config path ----------------------------------------------------

/**
 * Default config path: project root (process.cwd()).
 * Override via OPENAI_AGENT_CONFIG env var for custom locations.
 */
const DEFAULT_CONFIG_PATH = path.join(process.cwd(), '.openai-agent-config.json');

// ---- loader -----------------------------------------------------------------

let _cachedConfig: AgentHostConfigFile | undefined;

/**
 * Load the agent-host config file from disk.
 *
 * Searches:
 *   1. `OPENAI_AGENT_CONFIG` env var (explicit path)
 *   2. `~/.openai-agent-config.json` (default)
 *
 * Returns the parsed config, or `undefined` if neither exists.
 * Results are cached after first load.
 */
export function loadAgentHostConfig(logService?: ILogService): AgentHostConfigFile | undefined {
	if (_cachedConfig) {
		return _cachedConfig;
	}

	const configPath = process.env['OPENAI_AGENT_CONFIG'] || DEFAULT_CONFIG_PATH;

	try {
		if (!fs.existsSync(configPath)) {
			logService?.info(`[AgentTierConfig] No config file found at ${configPath}`);
			return undefined;
		}
		const raw = fs.readFileSync(configPath, 'utf-8');
		const parsed = JSON.parse(raw) as AgentHostConfigFile;

		// Basic validation
		if (!Array.isArray(parsed.tiers) || parsed.tiers.length === 0) {
			logService?.warn(`[AgentTierConfig] Config file at ${configPath} has no tiers array`);
			return undefined;
		}
		for (const tier of parsed.tiers) {
			if (!tier.id || !tier.name || !tier.model || !tier.baseUrl || !tier.apiKey) {
				logService?.warn(`[AgentTierConfig] Tier ${tier.id ?? '(unnamed)'} is missing required fields`);
				return undefined;
			}
		}

		_cachedConfig = parsed;
		logService?.info(`[AgentTierConfig] Loaded ${parsed.tiers.length} tiers from ${configPath}`);
		return parsed;
	} catch (err) {
		logService?.error(`[AgentTierConfig] Failed to load config from ${configPath}: ${err}`);
		return undefined;
	}
}

/**
 * Reload the config file (clears cache). Useful after config changes.
 */
export function reloadAgentHostConfig(): void {
	_cachedConfig = undefined;
}

/**
 * Build an `IAgentModelInfo[]` from tier configs for forward-compatibility.
 * Each tier becomes one model entry shown in the UI model picker.
 */
export function buildTierModelInfos(config: AgentHostConfigFile, providerId: string) {
	return config.tiers.map(tier => ({
		provider: providerId,
		id: tier.id,
		name: tier.name,
		supportsVision: tier.supportsVision ?? false,
	}));
}

/**
 * Resolve a tier id to its full configuration.
 */
export function resolveTierById(config: AgentHostConfigFile, tierId: string): TierConfig | undefined {
	return config.tiers.find(t => t.id === tierId);
}
