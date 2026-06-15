/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Search the codebase using natural language.
 *
 * New tool — aligned with Copilot's `semantic_search` tool.
 * Uses embedding-based search to find relevant code by meaning, not just keywords.
 */
export const TOOL_SEMANTIC_SEARCH = defineTool({
	name: ToolName.SemanticSearch,
	description:
		'Search the codebase using natural language. Returns relevant code snippets based on semantic meaning rather than keyword matching. Useful when you need to find code related to a concept but are not sure of the exact function or variable names.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The natural language query describing what you are looking for.' },
		},
		required: ['query'],
	},
	isDestructive: false,
	toolKind: 'search',
});

// ---- handler (tool executor) ------------------------------------------------

export function createSemanticSearchExecutor(
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		logService.warn(`[SemanticSearchTool] semantic_search called but not yet implemented: query="${(input.parameters.query as string || '').substring(0, 100)}"`);
		// Placeholder — would call an embedding-based search service
		return { toolCallId: input.toolCallId, content: 'Semantic search not yet implemented', success: false };
	};
}
