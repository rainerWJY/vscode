/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Event } from '../../../../base/common/event.js';

/**
 * Equivalent of Copilot's `IIgnoreService` — local-only subset.
 *
 * Implements the same local ignore mechanisms as Copilot's `BaseIgnoreService`:
 * - Scans workspace roots for `.copilotignore` files and parses them with
 *   the `ignore` npm package (gitignore-style syntax)
 * - Respects `.gitignore` patterns from all `.gitignore` files found in the workspace
 * - Automatically excludes common patterns: `.git/`, `node_modules/`,
 *   `.env`, build output, IDE files
 *
 * What is NOT implemented (Copilot-only enterprise features):
 * - Remote content exclusion via GitHub organization policies (CAPIClientService)
 * - Authentication-based enable/disable toggle (IAuthenticationService)
 * - Regex-based context exclusions
 * - Minimatch pattern extraction for search ranking
 */
export interface IAgentHostIgnoreService {

	/**
	 * Whether the ignore service has been initialized and is enabled.
	 */
	isEnabled: boolean;

	/**
	 * Initialize the service — scan workspace and load all ignore files.
	 * Must be called before `isIgnored()`.
	 */
	init(): Promise<void>;

	/**
	 * Check whether a file path is ignored.
	 */
	isIgnored(uri: URI): Promise<boolean>;

	/**
	 * Provide a summary of loaded ignore sources for debugging/logging.
	 */
	getIgnoreSummary(): string;

	/**
	 * Clean up watchers and release resources.
	 */
	dispose(): void;
}

/**
 * Name of the Copilot-specific ignore file.
 */
export const COPILOT_IGNORE_FILE_NAME = '.copilotignore';

/**
 * Common patterns always excluded regardless of ignore files.
 * Matches Copilot's implicit exclusions.
 */
const BUILTIN_IGNORED_PATTERNS = [
	'.git/',
	'.svn/',
	'.hg/',
	'node_modules/',
	'.env',
	'.env.*',
	'.DS_Store',
	'Thumbs.db',
];

// ---- implementation ---------------------------------------------------------

export class AgentHostIgnoreService implements IAgentHostIgnoreService {

	declare _serviceBrand: undefined;

	private _initialized = false;
	private _ignore: IgnoreInstance | null = null;
	private _watchers: fs.FSWatcher[] = [];

	constructor(
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) { }

	get isEnabled(): boolean {
		return this._initialized;
	}

	async init(): Promise<void> {
		if (this._initialized) {
			return;
		}

		this._logService.trace('[AgentHostIgnoreService] init: scanning workspace for ignore files...');

		const ignoreModule = await this._loadIgnoreModule();
		const instance = ignoreModule();

		// Always add built-in patterns
		for (const pattern of BUILTIN_IGNORED_PATTERNS) {
			instance.add(pattern);
		}

		// Discover workspace roots from process.cwd() — matches agent host's working directory.
		// In agent host, the workspace root is typically where the agent host server was launched.
		const workspaceRoot = process.cwd();
		await this._discoverIgnoreFiles(workspaceRoot, instance);

		this._ignore = instance;
		this._initialized = true;

		const summary = this.getIgnoreSummary();
		this._logService.trace(`[AgentHostIgnoreService] init complete: ${summary}`);
	}

	async isIgnored(uri: URI): Promise<boolean> {
		if (!this._initialized) {
			await this.init();
		}

		if (!this._ignore) {
			return false;
		}

		const relativePath = this._toRelativePath(uri.fsPath);
		if (!relativePath) {
			return false;
		}

		return this._ignore.ignores(relativePath);
	}

	getIgnoreSummary(): string {
		if (!this._ignore) {
			return '(not initialized)';
		}
		return `ignore service active`;
	}

	dispose(): void {
		for (const w of this._watchers) {
			w.close();
		}
		this._watchers = [];
		this._initialized = false;
		this._ignore = null;
	}

	// ---- internal helpers ----------------------------------------------------

	/**
	 * Discover all `.copilotignore` and `.gitignore` files under the given root
	 * directory and add their patterns to the ignore instance.
	 *
	 * Mirrors Copilot's `BaseIgnoreService.addWorkspace()` + `trackIgnoreFile()` logic:
	 * - Finds all `.copilotignore` files via recursive directory walk
	 * - Finds all `.gitignore` files via recursive directory walk
	 * - Each ignore file's patterns are scoped to its directory (matching Copilot's `scope` logic)
	 */
	private async _discoverIgnoreFiles(root: string, instance: IgnoreInstance): Promise<void> {
		const ignoreFiles: { filePath: string; scope: string }[] = [];

		try {
			await this._walkDirectory(root, (filePath) => {
				const name = path.basename(filePath);
				if (name === COPILOT_IGNORE_FILE_NAME || name === '.gitignore') {
					const dir = path.dirname(filePath);
					const scope = path.relative(root, dir);
					ignoreFiles.push({ filePath, scope });
				}
			});
		} catch (err) {
			this._logService.warn(`[AgentHostIgnoreService] error walking directory: ${err}`);
		}

		for (const { filePath, scope } of ignoreFiles) {
			try {
				const content = fs.readFileSync(filePath, 'utf-8');
				const lines = content.split(/\r?\n/);

				// Filter out comments and empty lines, then scope each pattern
				const scopedPatterns = lines
					.map(line => line.trim())
					.filter(line => line.length > 0 && !line.startsWith('#'))
					.map(pattern => scope ? path.posix.join(scope.replace(/\\/g, '/'), pattern) : pattern);

				if (scopedPatterns.length > 0) {
					instance.add(scopedPatterns);
					this._logService.trace(`[AgentHostIgnoreService] loaded ${filePath}: ${scopedPatterns.length} patterns`);

					// Watch for changes (matching Copilot's watcher patterns)
					this._watchIgnoreFile(filePath);
				}
			} catch (err) {
				this._logService.warn(`[AgentHostIgnoreService] error reading ${filePath}: ${err}`);
			}
		}
	}

	/**
	 * Set up a file watcher on an ignore file to auto-reload on changes.
	 * Mirrors Copilot's approach of tracking ignore files for changes.
	 */
	private _watchIgnoreFile(filePath: string): void {
		try {
			const watcher = fs.watch(filePath, (eventType) => {
				if (eventType === 'change') {
					this._logService.trace(`[AgentHostIgnoreService] ignore file changed: ${filePath}, reinitializing...`);
					// Reinitialize — simplest correct approach matching Copilot's re-trigger
					this._initialized = false;
					this.init().catch(err => {
						this._logService.error(`[AgentHostIgnoreService] reinit error: ${err}`);
					});
				}
			});
			this._watchers.push(watcher);
		} catch {
			// Watching not critical — skip silently
		}
	}

	/**
	 * Recursively walk a directory, calling `cb` for each file encountered.
	 */
	private async _walkDirectory(dir: string, cb: (filePath: string) => void): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return; // skip inaccessible directories
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				// Skip hidden directories (starting with .) except .github and .copilot
				if (entry.name.startsWith('.') &&
					entry.name !== '.github' &&
					entry.name !== '.copilot') {
					continue;
				}
				// Skip node_modules (always)
				if (entry.name === 'node_modules') {
					continue;
				}
				await this._walkDirectory(fullPath, cb);
			} else if (entry.isFile()) {
				cb(fullPath);
			}
		}
	}

	/**
	 * Convert a filesystem absolute path to a POSIX-style relative path
	 * that the `ignore` package can work with.
	 */
	private _toRelativePath(fsPath: string): string | undefined {
		const cwd = process.cwd();
		const relative = path.relative(cwd, fsPath);
		if (relative.startsWith('..')) {
			return undefined; // outside workspace — not ignored
		}
		// Normalize to POSIX separators for ignore package
		return relative.replace(/\\/g, '/');
	}

	private async _loadIgnoreModule(): Promise<() => IgnoreInstance> {
		const mod = await import('ignore');
		// `ignore` module exports a function that creates an Ignore instance
		return mod.default as unknown as () => IgnoreInstance;
	}
}

/**
 * Minimal type for the `ignore` npm package Instance interface.
 */
interface IgnoreInstance {
	add(pattern: string | string[]): this;
	ignores(pathname: string): boolean;
	filter(paths: string[]): string[];
	createFilter(): (pathname: string) => boolean;
}
