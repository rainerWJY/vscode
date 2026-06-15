/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/**
 * Equivalent of Copilot's `IIgnoreService`.
 *
 * Checks whether a file should be excluded from tool access based on
 * its path matching common exclusion patterns (e.g. `.env`, `node_modules`).
 *
 * This is a simplified version — it uses minimatch-style patterns rather than
 * the full Copilot content-exclusion infrastructure (org policies, `.copilotignore`,
 * remote content exclusion, regex-based exclusion).
 */
export interface IAgentHostIgnoreService {

	/**
	 * Check whether a file is ignored (should not be read/listed by tools).
	 */
	isIgnored(uri: URI): Promise<boolean>;

	/**
	 * Check whether a file is ignored by looking at just the file name
	 * (e.g. `.env`, `.gitignore`). For simple checks that don't need stat.
	 */
	isFileNameIgnored(uri: URI): boolean;
}

/**
 * Default set of patterns that are excluded from tool access.
 * Files matching these patterns will return "access denied" to the LLM.
 *
 * Matches Copilot's common exclusion practices without the org-policy layer.
 */
const DEFAULT_IGNORED_PATTERNS: ReadonlyArray<string> = [
	// Sensitive config files
	'.env',
	'.env.*',
	'.npmrc',
	'.yarnrc',
	// Version control
	'.git/',
	'.gitignore',
	'.gitmodules',
	'.svn/',
	// Dependencies
	'node_modules/',
	'package-lock.json',
	'yarn.lock',
	'pnpm-lock.yaml',
	// Build output
	'dist/',
	'out/',
	'build/',
	'.next/',
	// IDE / editor
	'.vscode/',
	'.idea/',
	'*.swp',
	'*.swo',
	// OS files
	'.DS_Store',
	'Thumbs.db',
	// Copilot ignore (respected when present)
	'.copilotignore',
];

export class AgentHostIgnoreService implements IAgentHostIgnoreService {

	declare _serviceBrand: undefined;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) { }

	async isIgnored(uri: URI): Promise<boolean> {
		if (this.isFileNameIgnored(uri)) {
			this._logService.trace(`[AgentHostIgnoreService] ignoring file by name: ${uri.toString()}`);
			return true;
		}
		return false;
	}

	isFileNameIgnored(uri: URI): boolean {
		const pathStr = uri.fsPath;
		const name = uri.path.split('/').pop() ?? '';
		for (const pattern of DEFAULT_IGNORED_PATTERNS) {
			if (this._matchesPattern(pathStr, name, pattern)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Simple pattern matching. Supports:
	 * - Exact file name match (`.env`)
	 * - Wildcard file name match (`.env.*`)
	 * - Suffix directory match (`node_modules/`)
	 * - Wildcard suffix match (`*.swp`)
	 */
	private _matchesPattern(pathStr: string, name: string, pattern: string): boolean {
		// Directory patterns (ending with /) — check if path contains the directory
		if (pattern.endsWith('/')) {
			const dirPattern = pattern.slice(0, -1);
			return pathStr.includes(`/${dirPattern}/`) || pathStr.startsWith(`${dirPattern}/`) ||
				pathStr === dirPattern || pathStr.endsWith(`/${dirPattern}`);
		}

		// Wildcard suffix (e.g. *.swp)
		if (pattern.startsWith('*.')) {
			const suffix = pattern.slice(1); // e.g. '.swp'
			return name.endsWith(suffix);
		}

		// Wildcard prefix/suffix (e.g. .env.*)
		if (pattern.includes('*')) {
			const parts = pattern.split('*');
			if (parts.length === 2) {
				return name.startsWith(parts[0]) && name.endsWith(parts[1]);
			}
			return false;
		}

		// Exact match
		return name === pattern;
	}
}
