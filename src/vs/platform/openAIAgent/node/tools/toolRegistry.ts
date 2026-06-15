/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OpenAIToolDef } from '../openAIApiClient.js';
import { CancellationToken } from '../../../base/common/cancellation.js';

// ---- types ------------------------------------------------------------------

/** Metadata describing a tool's runtime characteristics. */
export interface ToolMeta {
	/** Function name exposed to the LLM. */
	readonly name: string;
	/** Human-readable description. */
	readonly description: string;
	/** JSON Schema for the tool's parameters. */
	readonly parameters: Record<string, unknown>;
	/** `true` when the tool modifies the workspace (needs user confirmation). */
	readonly isDestructive: boolean;
	/** Kind tag used by the AHP protocol (e.g. 'edit', 'shell'). */
	readonly toolKind: 'edit' | 'shell' | 'search' | 'read' | 'task' | 'other';
}

/**
 * A tool execution request.
 */
export interface ToolInput {
	readonly toolCallId: string;
	readonly name: string;
	readonly parameters: Record<string, unknown>;
	/** Optional cancellation token. Tools may check this to abort long operations. */
	readonly cancellationToken?: CancellationToken;
}

/**
 * Result of a tool execution.
 */
export interface ToolOutput {
	readonly toolCallId: string;
	readonly content: string;
	readonly success: boolean;
}

/**
 * Function signature for tool execution callbacks.
 */
export type ToolExecutor = (input: ToolInput) => Promise<ToolOutput>;

/**
 * A registered tool with its metadata and executor function.
 */
export interface RegisteredTool {
	readonly meta: ToolMeta;
	readonly executor: ToolExecutor;
	/** Convert to OpenAI tool definition format. */
	toOpenAI(): OpenAIToolDef;
}

// ---- registry ---------------------------------------------------------------

type ToolDefinition = {
	meta: ToolMeta;
};

const _toolRegistry = new Map<string, ToolDefinition>();

/**
 * Define a tool and add it to the registry.
 * Returns the ToolMeta for use in {@link createTool}.
 */
export function defineTool(meta: ToolMeta): ToolMeta {
	_toolRegistry.set(meta.name, { meta });
	return meta;
}

/**
 * Get all registered tool metas.
 */
export function getAllToolMetas(): readonly ToolMeta[] {
	return Array.from(_toolRegistry.values()).map(d => d.meta);
}

/**
 * Look up a tool's meta by name.
 */
export function getToolMeta(name: string): ToolMeta | undefined {
	return _toolRegistry.get(name)?.meta;
}

// ---- factory ----------------------------------------------------------------

/**
 * Creates a {@link RegisteredTool} from a meta definition and executor.
 */
export function createTool(meta: ToolMeta, executor: ToolExecutor): RegisteredTool {
	return {
		meta,
		executor,
		toOpenAI(): OpenAIToolDef {
			return {
				type: 'function',
				function: {
					name: meta.name,
					description: meta.description,
					parameters: meta.parameters,
				},
			};
		},
	};
}
