/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Re-exports from the tools/ directory structure.
 *
 * @see tools/toolNames.ts — ToolName enum aligned to Copilot
 * @see tools/toolRegistry.ts — ToolMeta, RegisteredTool, defineTool, createTool
 * @see tools/registerAllTools.ts — barrel import of all tool modules
 */

// Ensure all tools are registered (side-effect imports)
import './tools/registerAllTools.js';

// Re-export all types and helpers
export {
	ToolMeta,
	ToolInput,
	ToolOutput,
	ToolExecutor,
	RegisteredTool,
	defineTool,
	getAllToolMetas,
	getToolMeta,
	createTool,
} from './tools/toolRegistry.js';

export { ToolName } from './tools/toolNames.js';

// Re-export individual tool definitions
export { TOOL_READ_FILE } from './tools/readFileTool.js';
export { TOOL_LIST_DIR } from './tools/listDirTool.js';
export { TOOL_GREP_SEARCH } from './tools/grepSearchTool.js';
export { TOOL_FILE_SEARCH } from './tools/fileSearchTool.js';
export { TOOL_CREATE_FILE } from './tools/createFileTool.js';
export { TOOL_RUN_IN_TERMINAL } from './tools/runInTerminalTool.js';
export { TOOL_SEND_TO_TERMINAL } from './tools/sendToTerminalTool.js';
export { TOOL_KILL_TERMINAL } from './tools/killTerminalTool.js';
export { TOOL_FETCH_WEBPAGE } from './tools/fetchWebPageTool.js';
export { TOOL_TASK_COMPLETE } from './tools/taskCompleteTool.js';
export { TOOL_VIEW_IMAGE } from './tools/viewImageTool.js';
export { TOOL_GET_ERRORS } from './tools/getErrorsTool.js';
export { TOOL_SEMANTIC_SEARCH } from './tools/semanticSearchTool.js';
