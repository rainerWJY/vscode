/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * In-memory registry tracking task lifecycle across tools.
 *
 * Bridges `create_and_run_task`, `run_task`, and `get_task_output`:
 * - `create_and_run_task` registers background tasks with a `termId` from `TerminalManager.execAsync()`
 * - `run_task` registers finished tasks with their exit code
 * - `get_task_output` consults the registry to decide how to retrieve output
 *   (poll running process vs. re-execute)
 *
 * Scoped by `sessionUri` to isolate different agent sessions.
 */

// ---- types ------------------------------------------------------------------

export interface TaskRecord {
	/** Workspace folder path. */
	readonly workspaceFolder: string;
	/** Task label/ID from tasks.json. */
	readonly taskId: string;
	/** Human-readable label. */
	readonly label: string;
	/** Whether this task is a background/watch task. */
	readonly isBackground: boolean;
	/** For background tasks: the termId from TerminalManager.execAsync(). */
	readonly termId?: string;
	/** When the task was started (Date.now()). */
	readonly startTime: number;
	/** Exit code, set when the process finishes (undefined while running). */
	exitCode?: number;
}

// ---- storage ----------------------------------------------------------------

const _records = new Map<string, TaskRecord>();

function _key(sessionUri: string, workspaceFolder: string, taskId: string): string {
	return `${sessionUri}::${workspaceFolder}::${taskId}`;
}

// ---- public API -------------------------------------------------------------

export function registerTask(sessionUri: string, record: TaskRecord): void {
	_records.set(_key(sessionUri, record.workspaceFolder, record.taskId), record);
}

export function getTask(sessionUri: string, workspaceFolder: string, taskId: string): TaskRecord | undefined {
	return _records.get(_key(sessionUri, workspaceFolder, taskId));
}

export function unregisterTask(sessionUri: string, workspaceFolder: string, taskId: string): void {
	_records.delete(_key(sessionUri, workspaceFolder, taskId));
}

/** Clean up all records for a session (e.g. on session dispose). */
export function unregisterSession(sessionUri: string): void {
	for (const key of _records.keys()) {
		if (key.startsWith(sessionUri + '::')) {
			_records.delete(key);
		}
	}
}
