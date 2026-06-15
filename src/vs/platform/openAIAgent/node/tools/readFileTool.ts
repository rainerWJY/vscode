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

// ---- schema (self-registers via defineTool) ---------------------------------

/**
 * Read the contents of a file.
 *
 * Supports two parameter styles aligned with Copilot's `read_file` tool:
 * - **V1 (legacy)**: `startLine` (1-based) + `endLine` (inclusive, 1-based)
 * - **V2 (modern)**: `offset` (1-based) + `limit` (max lines, optional)
 *
 * Output is truncated at 2000 lines / 2000 chars-per-line (matching Copilot).
 * Binary files use byte offsets.
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
 *
 * Uses platform-level services equivalent to Copilot's tool service layer:
 * - `IAgentHostFileSystemService` — file I/O with size limits and binary detection
 * - `IAgentHostPathService` — path resolution with Windows/POSIX handling
 * - `IAgentHostIgnoreService` — content exclusion (`.env`, `node_modules`, etc.)
 */
export function createReadFileExecutor(
	fileSystemService: IAgentHostFileSystemService,
	pathService: IAgentHostPathService,
	ignoreService: IAgentHostIgnoreService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		try {
			const filePath = input.parameters.filePath as string;
			logService.trace(`[ReadFileTool] read_file: path=${filePath}`);

			// Resolve path string → URI (handles Windows/POSIX/UNC)
			const fileUri = pathService.resolveFilePath(filePath);
			if (!fileUri) {
				return {
					toolCallId: input.toolCallId,
					content: `Invalid input path: ${filePath}. Be sure to use an absolute path.`,
					success: false,
				};
			}

			// Check if file is ignored (matches Copilot's assertFileNotContentExcluded)
			if (await ignoreService.isIgnored(fileUri)) {
				return {
					toolCallId: input.toolCallId,
					content: `File '${filePath}' is configured to be ignored and cannot be read.`,
					success: false,
				};
			}

			// Read file using the file system service (with size limits)
			const text = await fileSystemService.readFileAsString(fileUri);
			const lines = text.split('\n');
			const lineCount = lines.length;

			// Detect parameter style: V2 (offset/limit) vs V1 (startLine/endLine)
			const hasOffset = input.parameters['offset'] !== undefined;
			const hasLimit = input.parameters['limit'] !== undefined;
			const usingV2 = hasOffset || hasLimit;

			let start: number;
			let end: number;
			let truncated = false;

			if (usingV2) {
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
				// V1: startLine (1-based, required-style) + endLine (1-based, inclusive)
				start = Math.max(1, Math.min(input.parameters.startLine as number, lineCount));
				end = Math.max(1, Math.min(input.parameters.endLine as number, lineCount));
			}

			// Swap if start > end (matches Copilot)
			if (start > end) {
				[start, end] = [end, start];
			}

			logService.trace(`[ReadFileTool] read_file: lines=${start}-${end}/${lineCount}, v2=${usingV2}, truncated=${truncated}`);

			// Extract and process lines
			const selected = lines.slice(start - 1, end);

			// Truncate long lines (matches Copilot)
			const processed = selected.map(line =>
				line.length > MAX_LINE_LENGTH
					? line.substring(0, MAX_LINE_LENGTH) + '[truncated]'
					: line,
			);

			let result = processed.join('\n');

			// Append truncation hint when output was capped
			if (truncated) {
				result += `\n...(truncated at ${end} lines, file has ${lineCount} total lines. Use offset/limit to read more.)`;
			}

			return { toolCallId: input.toolCallId, content: result, success: true };
		} catch (err) {
			logService.error(`[ReadFileTool] read_file ERROR: ${err}`);
			return {
				toolCallId: input.toolCallId,
				content: `Error reading file: ${err}`,
				success: false,
			};
		}
	};
}
