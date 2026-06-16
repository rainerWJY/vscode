/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../log/common/log.js';
import type { ChildProcess } from 'node:child_process';

// ---- types ------------------------------------------------------------------

export interface IManagedProcess {
	readonly termId: string;
	readonly command: string;
	readonly startTime: number;
	exitCode: number | undefined;
	isRunning: boolean;
	getOutput(): string;
	kill(signal?: NodeJS.Signals): boolean;
}

export interface ISyncResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface IAsyncResult {
	termId: string;
}

export interface IOutputResult {
	output: string;
	exitCode: number | undefined;
	isRunning: boolean;
	inputDetected: boolean;
}

// ---- ManagedProcess impl (wraps a spawned child process) ---------------------

class ManagedProcessImpl implements IManagedProcess {
	readonly termId: string;
	readonly command: string;
	readonly startTime: number;
	exitCode: number | undefined;

	private readonly _stdoutChunks: string[] = [];
	private readonly _stderrChunks: string[] = [];
	private readonly _process: ChildProcess;
	private _killed = false;

	constructor(
		termId: string,
		command: string,
		process: ChildProcess,
	) {
		this.termId = termId;
		this.command = command;
		this.startTime = Date.now();
		this._process = process;

		// Collect stdout
		if (process.stdout) {
			process.stdout.on('data', (chunk: Buffer) => {
				this._stdoutChunks.push(chunk.toString());
				this._checkForInputPrompt();
			});
		}

		// Collect stderr
		if (process.stderr) {
			process.stderr.on('data', (chunk: Buffer) => {
				this._stderrChunks.push(chunk.toString());
				this._checkForInputPrompt();
			});
		}

		// Track exit
		process.on('exit', (code) => {
			this.exitCode = code ?? undefined;
		});

		process.on('close', (code) => {
			this.exitCode = code ?? undefined;
		});

		// Handle error (e.g., spawn failed)
		process.on('error', () => {
			this.exitCode = 1;
		});
	}

	// ---- stdin / input support (for interactive prompts) --------------------

	/**
	 * Send text to the process's stdin. Appends a newline.
	 * Returns true if the text was written, false if stdin is not available.
	 */
	sendInput(text: string): boolean {
		if (!this._process.stdin || !this.isRunning) {
			return false;
		}
		try {
			this._process.stdin.write(text + '\n');
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Send just an Enter (newline) to the process's stdin.
	 */
	sendEnter(): boolean {
		if (!this._process.stdin || !this.isRunning) {
			return false;
		}
		try {
			this._process.stdin.write('\n');
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * True if the process is running and its most recent output suggests
	 * it may be waiting for interactive input.
	 */
	get isWaitingForInput(): boolean {
		if (!this.isRunning) {
			return false;
		}
		return this._inputDetected;
	}

	// ---- input prompt detection (aligned with Copilot's OutputMonitor) ------

	private _inputDetected = false;

	/**
	 * Check the last line(s) of output for patterns that suggest the process
	 * is waiting for interactive input. Mirrors Copilot's
	 * `detectsHighConfidenceInputPattern` and `detectsLikelyInputRequiredPattern`.
	 */
	private _checkForInputPrompt(): void {
		if (this._inputDetected) {
			return; // already flagged
		}

		const output = this.getOutput();
		const lines = output.split('\n');
		const lastLine = lines[lines.length - 1]?.trimEnd() ?? '';

		if (this._detectsHighConfidenceInputPattern(lastLine) ||
			this._detectsLikelyInputRequiredPattern(lastLine)) {
			this._inputDetected = true;
		}
	}

	/**
	 * High-confidence patterns — these reliably indicate a prompt.
	 */
	private _detectsHighConfidenceInputPattern(line: string): boolean {
		return [
			// PowerShell-style multi-option ending in whitespace
			/\s*(?:\[[^\]]\][^\[]*)+(?:\(default is\s+"[^"]+"\):)?\s+$/,
			// Bracketed yes/no: (y/n), [Y/n], (yes/no)
			/(?:\(|\[)\s*(?:y(?:es)?\s*\/\s*n(?:o)?|n(?:o)?\s*\/\s*y(?:es)?)\s*(?:\]|\))\s+$/i,
			// "Continue? (y/n)" style
			/[?:]\s*(?:\(|\[)?\s*y(?:es)?\s*\/\s*n(?:o)?\s*(?:\]|\))?\s+$/i,
			// (y) with trailing space
			/\(y\) +$/i,
			// Parenthesized default: "name: (test) "
			/:\s+\([^)]*\) +$/,
			// (END) pager
			/\(END\)$/,
			// Password prompt
			/password(?: for [^:]+)?:\s*$/i,
			// Press any key
			/press a(?:ny)? key/i,
			// Interactive prompt libs like inquirer: "? Pick a color ›"
			/^(?:\s|\x1b\[[0-9;]*m)*\?.*[›❯▸▶]\s*$/,
		].some(e => e.test(line));
	}

	/**
	 * Broader patterns — line ends with ':' or '?' + space.
	 */
	private _detectsLikelyInputRequiredPattern(line: string): boolean {
		if (this._detectsHighConfidenceInputPattern(line)) {
			return true;
		}
		return [
			/: +$/,
			/\? *(?:\([a-z\s]+\))? +$/i,
		].some(e => e.test(line));
	}

	get isRunning(): boolean {
		return this.exitCode === undefined && !this._killed && this._process.exitCode === null && !this._process.killed;
	}

	getOutput(): string {
		const stdout = this._stdoutChunks.join('');
		const stderr = this._stderrChunks.join('');
		const parts: string[] = [];
		if (stdout.trim().length > 0) {
			parts.push(stdout);
		}
		if (stderr.trim().length > 0) {
			parts.push(stderr);
		}
		return parts.join('\n');
	}

	kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		if (!this.isRunning) {
			return false;
		}
		this._killed = true;
		try {
			this._process.kill(signal);
			return true;
		} catch {
			return false;
		}
	}

	/** Force-kill the process group (like Copilot's terminal disposal). */
	forceKill(): void {
		this._killed = true;
		try {
			this._process.kill('SIGKILL');
		} catch {
			// ignore
		}
	}
}

// ---- TerminalManager --------------------------------------------------------

/**
 * Manages terminal processes for the agent host.
 *
 * Provides:
 * - **Sync execution** via `execSync()` with persistent cwd tracking
 * - **Async execution** via `spawn()` with UUID-based process tracking
 * - **Output retrieval** for background processes (used by `get_terminal_output`)
 * - **CWD tracking** — parses `cd` from commands to maintain persistent
 *   working directory across invocations (matches Copilot's terminal session reuse)
 *
 * Lifecycle is scoped to sessions: each session URI gets its own cwd and
 * background process pool. Cleanup happens on `disposeSession()` or
 * `dispose()`.
 */
export class TerminalManager extends Disposable {
	private readonly _backgroundProcesses = new Map<string, Map<string, ManagedProcessImpl>>();
	private readonly _sessionCwds = new Map<string, string>();
	private readonly _onProcessExit = this._register(new Emitter<{ sessionUri: string; termId: string; exitCode: number | undefined }>());
	readonly onProcessExit: Event<{ sessionUri: string; termId: string; exitCode: number | undefined }> = this._onProcessExit.event;

	constructor(private readonly _logService: ILogService) {
		super();
	}

	// ---- sync execution -----------------------------------------------------

	/**
	 * Execute a command synchronously using the session's tracked cwd.
	 * Returns stdout, stderr, and exit code.
	 */
	async execSync(
		sessionUri: string,
		command: string,
		timeout: number,
	): Promise<ISyncResult> {
		const cwd = this.getCwd(sessionUri);
		this._logService.info(`[TerminalManager] execSync: session=${sessionUri.substring(0, 12)}, command="${command.substring(0, 200)}", cwd="${cwd}", timeout=${timeout}`);

		const { execSync } = await import('node:child_process');
		try {
			const output = execSync(command, {
				timeout,
				maxBuffer: 10 * 1024 * 1024,
				encoding: 'utf-8' as const,
				shell: process.env.SHELL || '/bin/sh',
				cwd,
			}) as string;

			this._logService.info(`[TerminalManager] execSync done: exit=0, outputLen=${(output || '').length}`);

			// CWD tracking: parse cd from the command
			this._updateCwd(sessionUri, command);

			return { stdout: output || '', stderr: '', exitCode: 0 };
		} catch (err) {
			const execError = err as Record<string, unknown>;
			const stderr = typeof execError?.stderr === 'string' ? execError.stderr : '';
			const stdout = typeof execError?.stdout === 'string' ? execError.stdout : '';
			const exitCode = typeof execError?.status === 'number' ? execError.status
				: typeof execError?.status === 'string' ? parseInt(execError.status as string) : 1;

			this._logService.info(`[TerminalManager] execSync done: exit=${exitCode}, stdoutLen=${stdout.length}, stderrLen=${stderr.length}`);

			// Still track cwd even on error (the cd may have succeeded before the error)
			this._updateCwd(sessionUri, command);

			return { stdout, stderr, exitCode };
		}
	}

	// ---- async execution ----------------------------------------------------

	/**
	 * Execute a command asynchronously by spawning a child process.
	 * Returns a `termId` that can be used with `getOutput()` or `kill()`.
	 */
	async execAsync(
		sessionUri: string,
		command: string,
	): Promise<IAsyncResult> {
		const cwd = this.getCwd(sessionUri);
		const termId = generateUuid();
		this._logService.info(`[TerminalManager] execAsync: session=${sessionUri.substring(0, 12)}, termId=${termId.substring(0, 8)}, command="${command.substring(0, 200)}", cwd="${cwd}"`);

		const { spawn } = await import('node:child_process');

		// Spawn a shell to run the command (detached for independent lifecycle)
		const child = spawn(command, [], {
			shell: true,
			cwd,
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const managed = new ManagedProcessImpl(termId, command, child);
		this._getSessionProcesses(sessionUri).set(termId, managed);

		// Track exit for event emission
		child.on('exit', (code) => {
			this._logService.info(`[TerminalManager] async process exit: termId=${termId.substring(0, 8)}, exitCode=${code}`);
			this._onProcessExit.fire({ sessionUri, termId, exitCode: code ?? undefined });
		});

		// Track cwd
		this._updateCwd(sessionUri, command);

		this._logService.info(`[TerminalManager] execAsync spawned: pid=${child.pid}, termId=${termId.substring(0, 8)}`);

		return { termId };
	}

	// ---- output retrieval ---------------------------------------------------

	/**
	 * Get the current output and status of a background process.
	 */
	getOutput(sessionUri: string, termId: string): IOutputResult {
		const processes = this._backgroundProcesses.get(sessionUri);
		if (!processes) {
			this._logService.warn(`[TerminalManager] getOutput: unknown session`);
			return { output: '', exitCode: undefined, isRunning: false, inputDetected: false };
		}

		const proc = processes.get(termId);
		if (!proc) {
			this._logService.warn(`[TerminalManager] getOutput: unknown termId=${termId.substring(0, 8)}`);
			return { output: '', exitCode: undefined, isRunning: false, inputDetected: false };
		}

		const output = proc.getOutput();
		this._logService.info(`[TerminalManager] getOutput: termId=${termId.substring(0, 8)}, outputLen=${output.length}, isRunning=${proc.isRunning}, exitCode=${proc.exitCode}, inputDetected=${proc.isWaitingForInput}`);

		return {
			output,
			exitCode: proc.exitCode,
			isRunning: proc.isRunning,
			inputDetected: proc.isWaitingForInput,
		};
	}

	// ---- stdin / input support (for interactive prompts) --------------------

	/**
	 * Send text to a background process's stdin.
	 */
	sendInput(sessionUri: string, termId: string, text: string): boolean {
		const proc = this._getProcess(sessionUri, termId);
		if (!proc) {
			this._logService.warn(`[TerminalManager] sendInput: unknown termId=${termId.substring(0, 8)}`);
			return false;
		}
		this._logService.info(`[TerminalManager] sendInput: termId=${termId.substring(0, 8)}, text="${text.substring(0, 100)}"`);
		return proc.sendInput(text);
	}

	/**
	 * Check if a background process appears to be waiting for input.
	 */
	isWaitingForInput(sessionUri: string, termId: string): boolean {
		const proc = this._getProcess(sessionUri, termId);
		if (!proc) {
			return false;
		}
		return proc.isWaitingForInput;
	}

	// ---- process management -------------------------------------------------

	/**
	 * Kill a background process by termId.
	 */
	kill(sessionUri: string, termId: string, signal?: NodeJS.Signals): boolean {
		const processes = this._backgroundProcesses.get(sessionUri);
		if (!processes) {
			return false;
		}

		const proc = processes.get(termId);
		if (!proc) {
			this._logService.warn(`[TerminalManager] kill: unknown termId=${termId.substring(0, 8)}`);
			return false;
		}

		this._logService.info(`[TerminalManager] kill: termId=${termId.substring(0, 8)}, signal=${signal ?? 'SIGTERM'}`);
		const result = proc.kill(signal);
		processes.delete(termId);
		return result;
	}

	/**
	 * List all active (running) background process termIds for a session.
	 */
	listActive(sessionUri: string): IManagedProcess[] {
		const processes = this._backgroundProcesses.get(sessionUri);
		if (!processes) {
			return [];
		}
		return [...processes.values()].filter(p => p.isRunning);
	}

	// ---- CWD tracking -------------------------------------------------------

	/**
	 * Get the tracked working directory for a session.
	 * Defaults to `process.cwd()` if not yet set.
	 */
	getCwd(sessionUri: string): string {
		return this._sessionCwds.get(sessionUri) ?? process.cwd();
	}

	/**
	 * Explicitly set the cwd for a session (used during session creation).
	 */
	setCwd(sessionUri: string, cwd: string): void {
		this._logService.info(`[TerminalManager] setCwd: session=${sessionUri.substring(0, 12)}, cwd="${cwd}"`);
		this._sessionCwds.set(sessionUri, cwd);
	}

	/**
	 * Parse `cd <path>` or `pushd <path>` from a command and update the
	 * tracked cwd for the session. Handles:
	 * - `cd /absolute/path && command`
	 * - `cd relative/path && command`
	 * - `pushd /absolute/path`
	 * - `cd /absolute/path; command`
	 * - `cd /absolute/path`
	 */
	private _updateCwd(sessionUri: string, command: string): void {
		const cdMatch = command.match(/^\s*(?:cd|pushd)\s+(\S+)/);
		if (!cdMatch) {
			return;
		}

		const rawPath = cdMatch[1].replace(/^["']|["']$/g, ''); // Strip quotes
		let newCwd: string;
		if (rawPath.startsWith('/') || rawPath.startsWith('~')) {
			// Absolute path or home
			newCwd = rawPath.startsWith('~')
				? (process.env.HOME || '/') + rawPath.slice(1)
				: rawPath;
		} else {
			// Relative — resolve against current cwd
			const path = require('path');
			newCwd = path.resolve(this.getCwd(sessionUri), rawPath);
		}

		this._logService.trace(`[TerminalManager] updateCwd: session=${sessionUri.substring(0, 12)}, "${rawPath}" → "${newCwd}"`);
		this._sessionCwds.set(sessionUri, newCwd);
	}

	// ---- session lifecycle --------------------------------------------------

	/**
	 * Dispose all background processes for a session and clear cwd tracking.
	 */
	disposeSession(sessionUri: string): void {
		this._logService.info(`[TerminalManager] disposeSession: session=${sessionUri.substring(0, 12)}`);

		const processes = this._backgroundProcesses.get(sessionUri);
		if (processes) {
			for (const [, proc] of processes) {
				proc.forceKill();
			}
			this._backgroundProcesses.delete(sessionUri);
		}

		this._sessionCwds.delete(sessionUri);
	}

	override dispose(): void {
		this._logService.info(`[TerminalManager] dispose: cleaning up all sessions`);

		for (const [uri, processes] of this._backgroundProcesses) {
			for (const [, proc] of processes) {
				proc.forceKill();
			}
			this._backgroundProcesses.delete(uri);
		}

		this._sessionCwds.clear();
		super.dispose();
	}

	// ---- helpers ------------------------------------------------------------

	private _getSessionProcesses(sessionUri: string): Map<string, ManagedProcessImpl> {
		let processes = this._backgroundProcesses.get(sessionUri);
		if (!processes) {
			processes = new Map();
			this._backgroundProcesses.set(sessionUri, processes);
		}
		return processes;
	}

	private _getProcess(sessionUri: string, termId: string): ManagedProcessImpl | undefined {
		const processes = this._backgroundProcesses.get(sessionUri);
		if (!processes) {
			return undefined;
		}
		return processes.get(termId);
	}
}
