/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * Equivalent of Copilot's `WorkingDirectory`.
 *
 * Encapsulates the session's working directory with utility methods
 * for path scoping. Unlike Copilot's version, this does not depend
 * on `IWorkspaceService` — the agent host runs in a standalone
 * Node.js process with a single working directory (or none), not a
 * multi-root workspace.
 *
 * Copilot reference:
 * `extensions/copilot/src/platform/workspace/common/workingDirectory.ts`
 *
 * Tools use this class to:
 * - Check if a file path is within the working directory
 * - Scope search patterns to the working directory
 * - Determine if files are "external" (require confirmation)
 */
export class AgentHostWorkingDirectory {

	constructor(
		private readonly _uri: URI | undefined,
	) { }

	/** The working directory URI, or `undefined` if not set. */
	get uri(): URI | undefined {
		return this._uri;
	}

	/** The filesystem path of the working directory, or `undefined`. */
	get fsPath(): string | undefined {
		return this._uri?.fsPath;
	}

	/** Whether an explicit working directory has been set. */
	get hasExplicitWorkingDirectory(): boolean {
		return !!this._uri;
	}

	/**
	 * Returns the working directory URI if the given resource is within it,
	 * or `undefined` if no working directory is set or the resource is outside.
	 *
	 * Matching Copilot's `getFolder(resource)`:
	 * When a working directory is set, only checks against it.
	 */
	getFolder(resource: URI): URI | undefined {
		if (!this._uri) {
			return undefined;
		}
		// Check if the resource is equal to or a child of the working directory
		const resourcePath = resource.fsPath;
		const wdPath = this._uri.fsPath;
		if (resourcePath === wdPath || resourcePath.startsWith(wdPath + '/') || resourcePath.startsWith(wdPath + '\\')) {
			return this._uri;
		}
		return undefined;
	}

	/**
	 * Returns the display name for the working directory (its basename).
	 */
	getFolderName(): string {
		if (!this._uri) {
			return '';
		}
		const path = this._uri.fsPath;
		const separator = path.includes('\\') ? '\\' : '/';
		return path.split(separator).filter(Boolean).pop() ?? path;
	}

	/**
	 * Returns the working directory path as a ripgrep-compatible `cwd` value.
	 * Falls back to `'/'` when no working directory is set (search entire filesystem).
	 */
	getSearchCwd(): string {
		return this._uri?.fsPath ?? '/';
	}

	/* Normalize a glob pattern, scoping it to the working directory when appropriate. */
	normalizeGlob(pattern: string | undefined): string | undefined {
		if (!pattern) {
			return undefined;
		}

		if (pattern === '**') {
			return undefined;
		}

		let result = pattern;
		if (!result.startsWith('**/') && !result.startsWith('/') && !result.includes(':')) {
			result = `**/${result}`;
		}
		if (result.endsWith('/')) {
			result = `${result}**`;
		}

		return result;
	}
}
