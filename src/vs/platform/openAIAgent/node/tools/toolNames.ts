/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool names aligned with VS Code Copilot's ToolName enum.
 *
 * Each value is the string the LLM sees in the function-calling API.
 * These match Copilot's naming conventions for maximum compatibility
 * when models are trained on Copilot tool-call patterns.
 */
export const ToolName = {
	// File operations
	ReadFile: 'read_file',
	ListDirectory: 'list_dir',
	CreateFile: 'create_file',
	ViewImage: 'view_image',

	// Edit operations (aligned with Copilot's editing tools)
	EditFile: 'edit_file',
	ReplaceString: 'replace_string_in_file',
	MultiReplaceString: 'multi_replace_string_in_file',
	ApplyPatch: 'apply_patch',

	// Search
	FindTextInFiles: 'grep_search',
	FindFiles: 'file_search',
	SemanticSearch: 'semantic_search',
	SearchWorkspaceSymbols: 'search_workspace_symbols',

	// Shell / terminal
	RunInTerminal: 'run_in_terminal',
	SendToTerminal: 'send_to_terminal',
	GetTerminalOutput: 'get_terminal_output',
	KillTerminal: 'kill_terminal',

	// Web
	FetchWebPage: 'fetch_webpage',

	// Diagnostics
	GetErrors: 'get_errors',
	GetScmChanges: 'get_changed_files',

	// Memory & session
	Memory: 'memory',
	SessionStoreSql: 'session_store_sql',

	// Task lifecycle
	TaskComplete: 'task_complete',

	// Task management
	CoreRunTask: 'run_task',
	CoreCreateAndRunTask: 'create_and_run_task',
	CoreGetTaskOutput: 'get_task_output',

	// Meta tools
	CoreAskQuestions: 'vscode_askQuestions',
	CoreRunTest: 'runTests',
	CoreTestFailure: 'testFailure',
} as const;

export type ToolName = (typeof ToolName)[keyof typeof ToolName];
