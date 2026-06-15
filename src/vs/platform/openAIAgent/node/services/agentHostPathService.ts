/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { isWindows } from '../../../../base/common/platform.js';
import { hasDriveLetter } from '../../../../base/common/extpath.js';
import { Schemas } from '../../../../base/common/network.js';

/**
 * Equivalent of Copilot's `IPromptPathRepresentationService`.
 *
 * Converts between file path strings (from LLM tool calls) and URIs,
 * handling Windows vs POSIX paths, scheme-based URIs, and path normalization.
 *
 * All paths are 1-indexed and line-number-aware (like the rest of the tool system).
 */
export interface IAgentHostPathService {

	/**
	 * Converts a file path string (from an LLM tool call) to a URI.
	 * Handles:
	 *  - POSIX absolute paths (`/foo/bar.ts`)
	 *  - Windows absolute paths (`C:\foo\bar.ts`)
	 *  - Windows double-escaped backslashes (`C:\\foo\\bar.ts`)
	 *  - URI strings (`file:///foo/bar.ts`, `vscode-remote://...`)
	 *  - Relative paths (rejected — returns `undefined`)
	 *
	 * @returns A valid URI, or `undefined` if the path cannot be resolved.
	 */
	resolveFilePath(filePath: string): URI | undefined;

	/**
	 * Converts a URI back to a human-friendly path string for display in tool
	 * output or error messages. For `file` and `vscode-remote` schemes, returns
	 * the filesystem path (`fsPath`); for other schemes, returns the full URI.
	 */
	getFilePath(uri: URI): string;

	/**
	 * Returns an example filepath string for a given POSIX relative path,
	 * adjusted to the current platform (e.g. adds drive letter on Windows).
	 */
	getExampleFilePath(relativeFilePath: string): string;
}

export class AgentHostPathService implements IAgentHostPathService {

	declare _serviceBrand: undefined;

	resolveFilePath(filePath: string): URI | undefined {
		// Always check for POSIX-like absolute paths, and also for platform-like
		// (i.e. Windows) absolute paths in case the model generates them.
		const isPosixPath = filePath.startsWith('/');
		const isWindowsPath = isWindows && (hasDriveLetter(filePath) || filePath.startsWith('\\'));

		if (isPosixPath || isWindowsPath) {
			// Some models double-escape backslashes, which causes problems down the line.
			// Remove repeated backslashes from windows path (but preserve UNC paths)
			if (isWindowsPath) {
				const isUncPath = filePath.startsWith('\\\\');
				filePath = filePath.replace(/\\+/g, '\\');
				if (isUncPath) {
					filePath = '\\' + filePath;
				}
			}

			return URI.file(filePath);
		}

		// Check if it looks like a URI with a scheme
		if (/\w[\w\d+.-]*:\S/.test(filePath)) {
			try {
				return URI.parse(filePath);
			} catch {
				return undefined;
			}
		}

		return undefined;
	}

	getFilePath(uri: URI): string {
		if (uri.scheme === Schemas.file || uri.scheme === Schemas.vscodeRemote) {
			return uri.fsPath;
		}
		return uri.toString();
	}

	getExampleFilePath(relativeFilePath: string): string {
		if (isWindows) {
			return this.getFilePath(URI.parse(`file:///C:${relativeFilePath}`));
		}
		return this.getFilePath(URI.parse(`file://${relativeFilePath}`));
	}
}
