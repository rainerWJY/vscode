/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/**
 * Equivalent of Copilot's `IFileSystemService`.
 *
 * Wraps the platform-level `IFileService` with safety features:
 * - 5 MB file size limit (configurable, matching Copilot's `FS_READ_MAX_FILE_SIZE`)
 * - Binary file detection by scanning for null bytes
 * - Proper error messages for oversized files
 */
export interface IAgentHostFileSystemService {

	/**
	 * Read file contents as raw bytes. Throws if the file exceeds the size limit
	 * (unless `disableLimit` is explicitly set).
	 */
	readFile(uri: URI, disableLimit?: boolean): Promise<Uint8Array>;

	/**
	 * Read file contents as a UTF-8 string. Throws if the file exceeds the size limit.
	 */
	readFileAsString(uri: URI): Promise<string>;

	/**
	 * Get file metadata (type, size, modification time).
	 */
	stat(uri: URI): Promise<{ readonly size: number; readonly mtime: number }>;

	/**
	 * Write content to a file (creates parent directories as needed).
	 */
	writeFile(uri: URI, content: Uint8Array): Promise<void>;

	/**
	 * Check whether a byte buffer appears to be binary (contains null bytes).
	 * Matches Copilot's heuristic for binary file detection.
	 */
	isBinary(content: Uint8Array): boolean;

	/**
	 * Assert that a file does not exceed the maximum readable size.
	 * Throws with a descriptive message if violated.
	 */
	assertReadFileSizeLimit(uri: URI): Promise<void>;
}

/** Maximum file size the tool will read: 5 MB (matching Copilot's `FS_READ_MAX_FILE_SIZE`). */
export const AGENT_HOST_READ_MAX_FILE_SIZE = 1024 * 1024 * 5;

export class AgentHostFileSystemService implements IAgentHostFileSystemService {

	declare _serviceBrand: undefined;

	constructor(
		private readonly _fileService: IFileService,
	) { }

	async readFile(uri: URI, disableLimit?: boolean): Promise<Uint8Array> {
		await this.assertReadFileSizeLimit(uri);
		const content = await this._fileService.readFile(uri);
		return content.value.buffer;
	}

	async readFileAsString(uri: URI): Promise<string> {
		const content = await this.readFile(uri);
		return new TextDecoder().decode(content);
	}

	async stat(uri: URI): Promise<{ readonly size: number; readonly mtime: number }> {
		const fileStat = await this._fileService.stat(uri);
		return { size: fileStat.size, mtime: fileStat.mtime };
	}

	async writeFile(uri: URI, content: Uint8Array): Promise<void> {
		await this._fileService.writeFile(uri, VSBuffer.wrap(content));
	}

	/**
	 * Heuristic binary detection: scan the first 8 KB for null bytes (Uint8 === 0).
	 * Copilot uses the same approach in `fileSystemService.ts`.
	 */
	isBinary(content: Uint8Array): boolean {
		const scanLen = Math.min(content.length, 8192);
		for (let i = 0; i < scanLen; i++) {
			if (content[i] === 0) {
				return true;
			}
		}
		return false;
	}

	async assertReadFileSizeLimit(uri: URI): Promise<void> {
		const fileStat = await this._fileService.stat(uri);
		if (fileStat.size > AGENT_HOST_READ_MAX_FILE_SIZE) {
			const sizeMB = Math.round(fileStat.size / (1024 * 1024));
			const maxMB = Math.round(AGENT_HOST_READ_MAX_FILE_SIZE / (1024 * 1024));
			throw new Error(
				`[AgentHostFileSystemService] ${uri.toString()} EXCEEDS max file size. ` +
				`FAILED to read ${sizeMB}MB > ${maxMB}MB`,
			);
		}
	}
}
