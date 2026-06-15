/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Event, Emitter } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';

// ---- FileType (copied from vscode.d.ts, matches Copilot's fileTypes.ts) -------

export enum FileType {
	Unknown = 0,
	File = 1,
	Directory = 2,
	SymbolicLink = 64,
}

export interface FileStat {
	readonly type: FileType;
	readonly ctime: number;
	readonly mtime: number;
	readonly size: number;
}

export interface FileSystemWatcher extends IDisposable {
	readonly ignoreCreateEvents: boolean;
	readonly ignoreChangeEvents: boolean;
	readonly ignoreDeleteEvents: boolean;
	readonly onDidCreate: Event<URI>;
	readonly onDidChange: Event<URI>;
	readonly onDidDelete: Event<URI>;
}

export interface RelativePattern {
	readonly base: string;
	readonly pattern: string;
	readonly baseUri: URI;
}

// ---- service interface, matching Copilot's IFileSystemService ----------------

/**
 * Full equivalent of Copilot's `IFileSystemService`.
 *
 * Wraps the platform-level `IFileService` with safety features:
 * - 5 MB file size limit (matching Copilot's `FS_READ_MAX_FILE_SIZE`)
 * - Binary file detection by scanning for null bytes
 * - Proper error messages for oversized files
 *
 * Provides the same full API surface as Copilot's interface:
 * stat, readDirectory, createDirectory, readFile, writeFile, delete,
 * rename, copy, isWritableFileSystem, createFileSystemWatcher.
 */
export interface IAgentHostFileSystemService {

	readonly _serviceBrand: undefined;

	stat(uri: URI): Promise<FileStat>;

	readDirectory(uri: URI): Promise<[string, FileType][]>;

	createDirectory(uri: URI): Promise<void>;

	/**
	 * @param disableLimit Disable the file size limit. USE WITH CAUTION.
	 */
	readFile(uri: URI, disableLimit?: boolean): Promise<Uint8Array>;

	writeFile(uri: URI, content: Uint8Array): Promise<void>;

	delete(uri: URI, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;

	rename(oldURI: URI, newURI: URI, options?: { overwrite?: boolean }): Promise<void>;

	copy(source: URI, destination: URI, options?: { overwrite?: boolean }): Promise<void>;

	isWritableFileSystem(scheme: string): boolean | undefined;

	createFileSystemWatcher(glob: string | RelativePattern): FileSystemWatcher;

	// ---- convenience methods (our addition, not in Copilot) -------------------

	readFileAsString(uri: URI): Promise<string>;

	isBinary(content: Uint8Array): boolean;

	assertReadFileSizeLimit(uri: URI): Promise<void>;
}

/** Maximum file size the tool will read: 5 MB (matching Copilot's `FS_READ_MAX_FILE_SIZE`). */
export const AGENT_HOST_READ_MAX_FILE_SIZE = 1024 * 1024 * 5;

// ---- implementation ---------------------------------------------------------

export class AgentHostFileSystemService implements IAgentHostFileSystemService {

	declare _serviceBrand: undefined;

	constructor(
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) { }

	async stat(uri: URI): Promise<FileStat> {
		this._logService.trace(`[AgentHostFileSystemService] stat: ${uri.fsPath}`);
		const nativeStat = await fs.promises.stat(uri.fsPath);
		return {
			type: nativeStat.isFile() ? FileType.File : FileType.Directory,
			ctime: nativeStat.ctimeMs,
			mtime: nativeStat.mtimeMs,
			size: nativeStat.size,
		};
	}

	async readDirectory(uri: URI): Promise<[string, FileType][]> {
		this._logService.trace(`[AgentHostFileSystemService] readDirectory: ${uri.fsPath}`);
		this._assertFileUri(uri);
		const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
		const result: [string, FileType][] = [];
		for (const entry of entries) {
			result.push([entry.name, entry.isFile() ? FileType.File : FileType.Directory]);
		}
		return result;
	}

	async createDirectory(uri: URI): Promise<void> {
		this._logService.trace(`[AgentHostFileSystemService] createDirectory: ${uri.fsPath}`);
		await fs.promises.mkdir(uri.fsPath, { recursive: true });
	}

	async readFile(uri: URI, disableLimit?: boolean): Promise<Uint8Array> {
		this._logService.trace(`[AgentHostFileSystemService] readFile: ${uri.fsPath}`);
		if (!disableLimit) {
			await this.assertReadFileSizeLimit(uri);
		}
		return fs.promises.readFile(uri.fsPath);
	}

	async readFileAsString(uri: URI): Promise<string> {
		this._logService.trace(`[AgentHostFileSystemService] readFileAsString: ${uri.fsPath}`);
		const content = await this.readFile(uri);
		return new TextDecoder().decode(content);
	}

	async writeFile(uri: URI, content: Uint8Array): Promise<void> {
		this._logService.trace(`[AgentHostFileSystemService] writeFile: ${uri.fsPath} (${content.length} bytes)`);
		await fs.promises.mkdir(URI.joinPath(uri, '..').fsPath, { recursive: true });
		return fs.promises.writeFile(uri.fsPath, content);
	}

	async delete(uri: URI, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
		this._logService.trace(`[AgentHostFileSystemService] delete: ${uri.fsPath} (recursive=${!!options?.recursive})`);
		return fs.promises.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true });
	}

	async rename(oldURI: URI, newURI: URI, options?: { overwrite?: boolean }): Promise<void> {
		this._logService.trace(`[AgentHostFileSystemService] rename: ${oldURI.fsPath} → ${newURI.fsPath}`);
		this._assertFileUri(oldURI);
		this._assertFileUri(newURI);
		if (!options?.overwrite) {
			try {
				await fs.promises.access(newURI.fsPath, fs.constants.F_OK);
				return; // target exists, don't overwrite
			} catch {
				// target doesn't exist — proceed
			}
		}
		return fs.promises.rename(oldURI.fsPath, newURI.fsPath);
	}

	async copy(source: URI, destination: URI, options?: { overwrite?: boolean }): Promise<void> {
		this._logService.trace(`[AgentHostFileSystemService] copy: ${source.fsPath} → ${destination.fsPath}`);
		this._assertFileUri(source);
		this._assertFileUri(destination);
		const copyConstant = options?.overwrite ? fs.constants.COPYFILE_FICLONE : fs.constants.COPYFILE_EXCL;
		return fs.promises.copyFile(source.fsPath, destination.fsPath, copyConstant);
	}

	isWritableFileSystem(scheme: string): boolean | undefined {
		// file:// is always writable via fs.promises
		if (scheme === 'file') {
			return true;
		}
		return this._fileService.hasProvider(URI.from({ scheme }));
	}

	createFileSystemWatcher(glob: string | RelativePattern): FileSystemWatcher {
		const basePath = typeof glob === 'string' ? process.cwd() : (glob as RelativePattern).baseUri.fsPath;
		const pattern = typeof glob === 'string' ? glob : (glob as RelativePattern).pattern;

		// Normalize the glob pattern to a directory to watch.
		// Use the base path for directory watching — fs.watch is recursive
		// on macOS, non-recursive on Linux/Windows.
		let watchPath = basePath;
		if (pattern.startsWith('**/')) {
			watchPath = basePath; // watch whole tree
		} else {
			// Extract the directory portion of the pattern
			const dir = pattern.replace(/\/?[^/]*$/, '');
			if (dir) {
				watchPath = path.join(basePath, dir);
			}
		}

		const emitter = new Emitter<URI>();
		let watcher: fs.FSWatcher | null = null;

		try {
			watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
				if (!filename) {
					return;
				}

				const changedUri = URI.file(path.join(watchPath, filename.toString()));

				switch (eventType) {
					case 'rename':
						emitter.fire(changedUri);
						emitter.fire(changedUri);
						break;
					case 'change':
						emitter.fire(changedUri);
						break;
				}
			});
		} catch {
			// Fall back to no-op watcher if fs.watch fails
		}

		return new class implements FileSystemWatcher {
			ignoreCreateEvents = false;
			ignoreChangeEvents = false;
			ignoreDeleteEvents = false;
			onDidCreate = emitter.event;
			onDidChange = emitter.event;
			onDidDelete = emitter.event;
			dispose(): void {
				emitter.dispose();
				if (watcher) {
					watcher.close();
				}
			}
		};
	}

	/**
	 * Heuristic binary detection: scan the first 8 KB for null bytes (uint8 === 0).
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
		const stat = await fs.promises.stat(uri.fsPath);
		if (stat.size > AGENT_HOST_READ_MAX_FILE_SIZE) {
			const sizeMB = Math.round(stat.size / (1024 * 1024));
			const maxMB = Math.round(AGENT_HOST_READ_MAX_FILE_SIZE / (1024 * 1024));
			const msg = `[AgentHostFileSystemService] ${uri.toString()} EXCEEDS max file size. FAILED to read ${sizeMB}MB > ${maxMB}MB`;
			this._logService.warn(msg);
			throw new Error(msg);
		}
	}

	private _assertFileUri(uri: URI): void {
		if (uri.scheme !== 'file') {
			throw new Error(`[AgentHostFileSystemService] Unsupported scheme: ${uri.scheme}. Only 'file' scheme is supported for this operation.`);
		}
	}
}
