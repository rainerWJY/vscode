/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import type { IAgentHostFileSystemService } from '../services/agentHostFileSystemService.js';
import type { IAgentHostPathService } from '../services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../services/agentHostIgnoreService.js';
import type { IAgentHostInstructionsService } from '../services/agentHostInstructionsService.js';
import type { AgentHostWorkingDirectory } from '../services/agentHostWorkingDirectory.js';

// ---- supported image extensions (matches Copilot's getImageMimeType) ----------

const IMAGE_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico',
	'.webp', '.avif', '.tiff', '.tif', '.svg',
]);

// ---- schema (self-registers via defineTool) ---------------------------------

/**
 * Read the contents of a file.
 *
 * Supports two parameter styles aligned with Copilot's `read_file` tool:
 * - **V1 (legacy)**: `startLine` (1-based, inclusive) + `endLine` (1-based, inclusive)
 * - **V2 (modern)**: `offset` (1-based, optional) + `limit` (max lines, optional)
 *
 * Output is truncated at 2000 lines / 2000 chars-per-line (matching Copilot).
 * Binary files use byte offsets (offset/limit treated as start byte / length in bytes).
 */
export const TOOL_READ_FILE = defineTool({
	name: ToolName.ReadFile,
	description:
		'Read the contents of a file. ' +
		'Line numbers are 1-indexed. ' +
		'This tool will truncate its output at 2000 lines and may be called repeatedly with offset/limit or startLine/endLine parameters to read larger files in chunks. ' +
		'Binary files use offset/limit as byte offsets.',
	parameters: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: 'The absolute path of the file to read.',
			},
			/** V2: 1-based line number to start from (optional, defaults to 1). */
			offset: {
				type: 'number',
				description:
					'Optional: the 1-based line number to start reading from. Only use this if the file is too large to read at once. If not specified, the file will be read from the beginning.',
			},
			/** V2: maximum number of lines to read (optional). */
			limit: {
				type: 'number',
				description:
					'Optional: the maximum number of lines to read. Only use this together with `offset` if the file is too large to read at once.',
			},
			/** V1 (legacy): 1-based start line — alternative to `offset`. */
			startLine: {
				type: 'number',
				description:
					'The 1-based line number to start reading from. Alternative to `offset`. If provided, `endLine` must also be provided.',
			},
			/** V1 (legacy): 1-based inclusive end line — alternative to `limit`. */
			endLine: {
				type: 'number',
				description:
					'The inclusive 1-based line number to end reading at. Alternative to `limit`. Use together with `startLine`.',
			},
		},
		required: ['filePath'],
	},
	isDestructive: false,
	toolKind: 'read',
});

// ---- handler (tool executor) ------------------------------------------------

const MAX_LINES_PER_READ = 2000;
const MAX_LINE_LENGTH = 2000;

/**
 * Copilot-style V1/V2 parameter discrimination.
 * When `startLine` is undefined → V2 (offset/limit), otherwise → V1 (startLine/endLine).
 */
function isParamsV2(params: Record<string, unknown>): boolean {
	return params['startLine'] === undefined;
}

/**
 * Create a `read_file` tool executor.
 *
 * Mirrors Copilot's `ReadFileTool.invoke()` behavior:
 * - Supports V1 (`startLine`/`endLine`) and V2 (`offset`/`limit`) parameter styles
 * - 1-indexed line numbers (matching VS Code editor)
 * - `endLine` is **inclusive** (V1); `limit` is max lines (V2)
 * - Output capped at `MAX_LINES_PER_READ` lines, with truncation message
 * - Long lines (> `MAX_LINE_LENGTH` chars) get `[truncated]` suffix
 * - Out-of-bounds `offset` throws with a descriptive error
 * - `startLine`/`endLine` are swapped if reversed
 * - Binary files are detected and returned as hexdump
 * - Image files are rejected with a message suggesting `view_image`
 * - Empty and whitespace-only files get a descriptive message
 * - Skill/instruction files are noted in output metadata
 *
 * Uses platform-level services equivalent to Copilot's tool service layer:
 * - `IAgentHostFileSystemService` — file I/O with size limits and binary detection
 * - `IAgentHostPathService` — path resolution with Windows/POSIX handling
 * - `IAgentHostIgnoreService` — content exclusion (`.env`, `node_modules`, etc.)
 * - `IAgentHostInstructionsService` — skill/instruction file detection
 *
 * @param workingDirectory — Optional session working directory (Copilot uses
 *   `options.workingDirectory` to scope file access / external-file checks).
 */
export function createReadFileExecutor(
	fileSystemService: IAgentHostFileSystemService,
	pathService: IAgentHostPathService,
	ignoreService: IAgentHostIgnoreService,
	instructionsService: IAgentHostInstructionsService,
	logService: ILogService,
	workingDirectory?: AgentHostWorkingDirectory,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.info(`[ReadFileTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, filePath=${input.parameters.filePath}, workingDir=${workingDirectory?.fsPath ?? 'none'}`);
		try {
			const token = input.cancellationToken;

			// Copilot-matching: check cancellation before any work
			if (token?.isCancellationRequested) {
				logService.warn(`[ReadFileTool] cancelled before any work`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const filePath = input.parameters.filePath as string;
			logService.info(`[ReadFileTool] step=resolve_path, filePath="${filePath}", offset=${input.parameters.offset}, limit=${input.parameters.limit}, startLine=${input.parameters.startLine}, endLine=${input.parameters.endLine}`);

			// ---- Step 1: Resolve path -------------------------------------------
			const fileUri = pathService.resolveFilePath(filePath);
			logService.trace(`[ReadFileTool] resolvedUri=${fileUri?.toString() ?? 'null'}`);
			if (!fileUri) {
				logService.warn(`[ReadFileTool] step=resolve_path FAILED: cannot resolve "${filePath}"`);
				return {
					toolCallId: input.toolCallId,
					content: `Invalid input path: ${filePath}. Be sure to use an absolute path.`,
					success: false,
				};
			}

			// Copilot-matching: check cancellation before I/O
			if (token?.isCancellationRequested) {
				logService.warn(`[ReadFileTool] cancelled after path resolution`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 2: Check ignore rules -------------------------------------
			logService.trace(`[ReadFileTool] step=ignore_check, uri=${fileUri.fsPath}`);
			if (await ignoreService.isIgnored(fileUri)) {
				logService.warn(`[ReadFileTool] step=ignore_check IGNORED: ${fileUri.fsPath}`);
				return {
					toolCallId: input.toolCallId,
					content: `File '${filePath}' is configured to be ignored and cannot be read.`,
					success: false,
				};
			}
			logService.trace(`[ReadFileTool] step=ignore_check PASS`);

			// ---- Step 3: Image file rejection (matches Copilot) ------------------
			const ext = fileUri.path.substring(fileUri.path.lastIndexOf('.')).toLowerCase();
			if (IMAGE_EXTENSIONS.has(ext)) {
				logService.info(`[ReadFileTool] step=image_reject, ext=${ext}`);
				return {
					toolCallId: input.toolCallId,
					content: `Cannot read image files with ${ToolName.ReadFile}. Use ${ToolName.ViewImage} instead.`,
					success: false,
				};
			}

			// ---- Step 4: Read raw bytes for binary detection ---------------------
			logService.info(`[ReadFileTool] step=read_file, uri=${fileUri.fsPath}`);
			const rawBytes = await fileSystemService.readFile(fileUri);
			logService.info(`[ReadFileTool] step=read_file done: ${rawBytes.length} bytes`);

			// Copilot-matching: check cancellation after read
			if (token?.isCancellationRequested) {
				logService.warn(`[ReadFileTool] cancelled after readFile`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 5: Binary file → hexdump (matches Copilot) -----------------
			const isBinary = fileSystemService.isBinary(rawBytes);
			logService.info(`[ReadFileTool] step=binary_check, isBinary=${isBinary}`);
			if (isBinary) {
				logService.info(`[ReadFileTool] step=hexdump, file=${fileUri.fsPath}, size=${rawBytes.length} bytes`);

				// Parse byte range from V1/V2 params (Copilot uses startLine/endLine as byte offsets for binaries)
				let startByte: number | undefined;
				let endByte: number | undefined;
				if (isParamsV2(input.parameters)) {
					startByte = input.parameters.offset as number | undefined;
					if (startByte !== undefined && typeof input.parameters.limit === 'number') {
						endByte = startByte + (input.parameters.limit as number);
					}
					logService.trace(`[ReadFileTool] hexdump V2: offset=${startByte}, limit=${input.parameters.limit} → endByte=${endByte}`);
				} else {
					startByte = input.parameters.startLine as number | undefined;
					endByte = input.parameters.endLine as number | undefined;
					logService.trace(`[ReadFileTool] hexdump V1: startLine=${startByte}, endLine=${endByte}`);
				}

				const hexdump = _renderHexdump(rawBytes, startByte, endByte);
				return {
					toolCallId: input.toolCallId,
					content: hexdump,
					success: true,
				};
			}

			// ---- Step 6: Text processing ----------------------------------------
			const text = new TextDecoder().decode(rawBytes);
			const lines = text.split('\n');
			const lineCount = lines.length;

			// ---- Step 7: Empty / whitespace-only check (matches Copilot) --------
			if (text.length === 0) {
				logService.info(`[ReadFileTool] step=empty_file, file=${pathService.getFilePath(fileUri)}`);
				return {
					toolCallId: input.toolCallId,
					content: `(The file \`${pathService.getFilePath(fileUri)}\` exists, but is empty)`,
					success: true,
				};
			}
			if (text.trim().length === 0) {
				logService.info(`[ReadFileTool] step=whitespace_file, file=${pathService.getFilePath(fileUri)}`);
				return {
					toolCallId: input.toolCallId,
					content: `(The file \`${pathService.getFilePath(fileUri)}\` exists, but contains only whitespace)`,
					success: true,
				};
			}

			// ---- Step 8: Detect parameter style (matches Copilot) ----------------
			const v2 = isParamsV2(input.parameters);

			let start: number;
			let end: number;
			let truncated = false;

			if (v2) {
				const rawOffset = input.parameters.offset as number | undefined;
				const rawLimit = input.parameters.limit as number | undefined;

				// Out-of-bounds check before clamping (matches Copilot)
				if (rawOffset !== undefined && rawOffset > lineCount) {
					throw new Error(
						`Invalid offset ${rawOffset}: file only has ${lineCount} line${lineCount === 1 ? '' : 's'}. Line numbers are 1-indexed.`,
					);
				}

				const limit = Math.max(1, Math.min(rawLimit ?? Infinity, MAX_LINES_PER_READ - 1));
				start = Math.max(1, Math.min(rawOffset ?? 1, lineCount));
				end = Math.min(start + limit, lineCount);
				// Signal truncation when we applied a limit the model didn't request
				truncated = limit !== rawLimit && end < lineCount;
			} else {
				// V1: startLine (1-based, required) + endLine (1-based, inclusive)
				start = Math.max(1, Math.min(input.parameters.startLine as number, lineCount));
				end = Math.max(1, Math.min(input.parameters.endLine as number, lineCount));
			}

			// Swap if start > end (matches Copilot)
			if (start > end) {
				[start, end] = [end, start];
			}

			logService.trace(`[ReadFileTool] read_file: lines=${start}-${end}/${lineCount}, v2=${v2}, truncated=${truncated}`);

			// ---- Step 9: Build file header (matches Copilot's ReadFileResult) ----
			const skillInfo = await instructionsService.getSkillInfo(fileUri);
			const isSkillMd = instructionsService.isSkillMdFile(fileUri);

			logService.info(`[ReadFileTool] step=render, file=${pathService.getFilePath(fileUri)}, lines=${start}-${end}/${lineCount}, skill=${!!skillInfo}, truncated=${truncated}`);

			let fileHeader = '';
			if (skillInfo) {
				if (isSkillMd) {
					fileHeader = `File: \`${pathService.getFilePath(fileUri)}\` (skill: ${skillInfo.skillName}). Lines ${start} to ${end} (${lineCount} lines total):\n`;
				} else {
					fileHeader = `File: \`${pathService.getFilePath(fileUri)}\` (skill folder). Lines ${start} to ${end} (${lineCount} lines total):\n`;
				}
			} else if (end !== lineCount || truncated) {
				// Show file metadata when reading a subset (matches Copilot's useCodeFences logic)
				fileHeader = `File: \`${pathService.getFilePath(fileUri)}\`. Lines ${start} to ${end} (${lineCount} lines total):\n`;
			}

			// ---- Step 10: Extract and process lines ----------------------------
			const selected = lines.slice(start - 1, end);

			let hadLongLines = false;
			const processed = selected.map(line => {
				if (line.length > MAX_LINE_LENGTH) {
					hadLongLines = true;
					return line.substring(0, MAX_LINE_LENGTH) + ' [truncated]';
				}
				return line;
			});

			let contents = processed.join('\n');

			if (hadLongLines) {
				contents += `\n[One or more long lines were truncated at ${MAX_LINE_LENGTH} characters]\n`;
			}

			// ---- Step 11: Truncation hint (matches Copilot wording) -------------
			if (truncated) {
				contents += `\n[File content truncated at line ${end}. Use ${ToolName.ReadFile} with offset/limit parameters to view more.]\n`;
			}

			const result = fileHeader ? fileHeader + '\n' + contents : contents;

			const elapsed = Date.now() - startTime;
			logService.info(`[ReadFileTool] >>> success: ${result.length} chars, ${elapsed}ms`);
			return { toolCallId: input.toolCallId, content: result, success: true };
		} catch (err) {
			const elapsed = Date.now() - startTime;
			logService.error(`[ReadFileTool] >>> ERROR after ${elapsed}ms: ${err}`);
			return {
				toolCallId: input.toolCallId,
				content: `Error reading file: ${err}`,
				success: false,
			};
		}
	};
}

// ---- hexdump rendering (matches Copilot's BinaryFileHexdump pattern) ---------

/**
 * Render a hexdump of binary data.
 * Matches Copilot's output style: offset | hex bytes | ASCII representation.
 * Supports optional startByte/endByte for range selection.
 */
function _renderHexdump(data: Uint8Array, startByte?: number, endByte?: number): string {
	const totalBytes = data.length;
	const s = startByte !== undefined ? Math.max(0, Math.min(startByte, totalBytes)) : 0;
	const e = endByte !== undefined ? Math.min(endByte, totalBytes) : totalBytes;
	const slice = data.slice(s, e);
	const bytesPerLine = 16;

	const lines: string[] = [];
	lines.push(`Binary file (${totalBytes} bytes). Showing bytes ${s} to ${e}:\n`);

	for (let i = 0; i < slice.length; i += bytesPerLine) {
		const offset = s + i;
		const hexParts: string[] = [];
		const asciiParts: string[] = [];

		for (let j = 0; j < bytesPerLine; j++) {
			const idx = i + j;
			if (idx < slice.length) {
				const byte = slice[idx];
				hexParts.push(byte.toString(16).padStart(2, '0'));
				asciiParts.push(byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.');
			} else {
				hexParts.push('  ');
				asciiParts.push(' ');
			}

			if (j === 7) {
				hexParts.push(' '); // extra space in the middle
			}
		}

		const offsetStr = offset.toString(16).padStart(8, '0');
		lines.push(`${offsetStr}  ${hexParts.join(' ')}  |${asciiParts.join('')}|`);
	}

	return lines.join('\n');
}
