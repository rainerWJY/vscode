/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OpenAIToolDef } from './openAIApiClient.js';

// ---- tool definitions -------------------------------------------------------

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

// ---- built-in tool definitions ----------------------------------------------

export const TOOL_READ_FILE: ToolMeta = {
	name: 'read_file',
	description:
		'Read the contents of a file. You can specify an offset and limit (especially handy for long files), but it\'s recommended to read the whole file by not providing these parameters.',
	parameters: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'The absolute path to the file to read.' },
			startLine: { type: 'number', description: 'The line number to start reading from, 1-based.' },
			endLine: { type: 'number', description: 'The inclusive line number to end reading at, 1-based.' },
		},
		required: ['filePath'],
	},
	isDestructive: false,
	toolKind: 'read',
};

export const TOOL_WRITE_FILE: ToolMeta = {
	name: 'write_file',
	description:
		'Writes a file to the local filesystem. This tool will overwrite the existing file if there is one at the provided path. Always provide the full intended content of the file.',
	parameters: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'The absolute path to the file to write.' },
			content: { type: 'string', description: 'The content to write to the file.' },
		},
		required: ['filePath', 'content'],
	},
	isDestructive: true,
	toolKind: 'edit',
};

export const TOOL_LIST_DIR: ToolMeta = {
	name: 'list_dir',
	description:
		'List the contents of a directory. Returns names of children — those ending in "/" are folders.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'The absolute path to the directory to list.' },
		},
		required: ['path'],
	},
	isDestructive: false,
	toolKind: 'read',
};

export const TOOL_SEARCH: ToolMeta = {
	name: 'search',
	description:
		'Search for files in the workspace by glob pattern. Use **/*.{js,ts} to match all js/ts files, src/** to match all files under src.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Glob pattern to search for files.' },
		},
		required: ['query'],
	},
	isDestructive: false,
	toolKind: 'search',
};

export const TOOL_GREP: ToolMeta = {
	name: 'grep',
	description:
		'Do a fast text search in the workspace. Use regex patterns with alternation (|) or character classes to search for multiple potential words at once.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The text or regex pattern to search for.' },
			includePattern: { type: 'string', description: 'Limit search to files matching this glob pattern.' },
		},
		required: ['query'],
	},
	isDestructive: false,
	toolKind: 'search',
};

export const TOOL_BASH: ToolMeta = {
	name: 'bash',
	description:
		'Execute a bash command in the terminal. Long-running commands will time out. Avoid commands that require user interaction.',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'The command to execute.' },
			description: { type: 'string', description: 'A brief description of what the command does.' },
		},
		required: ['command'],
	},
	isDestructive: true,
	toolKind: 'shell',
};

export const TOOL_TASK_COMPLETE: ToolMeta = {
	name: 'task_complete',
	description:
		'Signal that the task is fully complete. Call this when you have finished all work — whether it involved code changes, answering a question, or any other interaction. Provide a brief summary of what was accomplished.',
	parameters: {
		type: 'object',
		properties: {
			summary: { type: 'string', description: 'A brief summary of what was accomplished.' },
		},
		required: ['summary'],
	},
	isDestructive: false,
	toolKind: 'task',
};

export const TOOL_WEB_SEARCH: ToolMeta = {
	name: 'web_search',
	description:
		'Search the web for current information. Useful when you need to look up documentation, APIs, or recent information.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The search query.' },
		},
		required: ['query'],
	},
	isDestructive: false,
	toolKind: 'search',
};

/** All built-in tool definitions (ordered by likelihood of use). */
export const BUILTIN_TOOL_METAS: readonly ToolMeta[] = [
	TOOL_READ_FILE,
	TOOL_LIST_DIR,
	TOOL_GREP,
	TOOL_SEARCH,
	TOOL_WRITE_FILE,
	TOOL_BASH,
	TOOL_WEB_SEARCH,
	TOOL_TASK_COMPLETE,
];

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
