/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import type { IAgentHostPathService } from '../services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../services/agentHostIgnoreService.js';

/**
 * `edit_file` — replaces the entire content of an existing file, or creates a new file.
 *
 * Aligned with Copilot's `EditFileTool` (`insertEditTool.tsx`).
 *
 * Key alignment features:
 * - Same parameters: filePath + code (full new content) + explanation
 * - Creates the file if it doesn't exist (matching Copilot's internal tool behavior)
 * - Reports before/after content for diff rendering
 * - Path safety validation (null byte check)
 * - Content exclusion via ignore service
 *
 * Key differences:
 * - No `prepareInvocation` / `handleToolStream` (no UI streaming)
 * - No diagnostic tracking (no ILanguageDiagnosticsService in agent host)
 * - No healing (no LLM round-trip for fixing broken edits)
 * - No notebook support
 */
export const TOOL_EDIT_FILE = defineTool({
	name: ToolName.EditFile,
	description:
		'Edit the contents of a file. Provide the full intended content of the file. ' +
		'Use this to make targeted changes to existing files by replacing the entire file content. ' +
		'If the file does not exist, it will be created with the provided content.',
	parameters: {
		type: 'object',
		properties: {
			explanation: { type: 'string', description: 'A brief explanation of what the edit does.' },
			filePath: { type: 'string', description: 'The absolute path to the file to edit.' },
			code: { type: 'string', description: 'The full new content of the file.' },
		},
		required: ['filePath', 'code'],
	},
	isDestructive: true,
	toolKind: 'edit',
});

export function createEditFileExecutor(
	fileService: IFileService,
	pathService: IAgentHostPathService,
	ignoreService: IAgentHostIgnoreService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		const toolCallPrefix = input.toolCallId.substring(0, 8);
		logService.info(`[EditFileTool][${toolCallPrefix}] <<< invoked: filePath=${input.parameters.filePath}, codeLen=${(input.parameters.code as string)?.length ?? 0}`);

		try {
			const token = input.cancellationToken;
			const filePath = input.parameters.filePath as string;
			const code = input.parameters.code as string;

			// ---- Validate input ----
			if (!filePath || code === undefined) {
				logService.warn(`[EditFileTool][${toolCallPrefix}] step=validate FAILED: filePath=${!!filePath}, code=${code !== undefined}`);
				return {
					toolCallId: input.toolCallId,
					content: 'Invalid input: filePath and code are required.',
					success: false,
				};
			}

			if (token?.isCancellationRequested) {
				logService.info(`[EditFileTool][${toolCallPrefix}] cancelled`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Path safety check (matching Copilot's assertPathIsSafe, cross-platform subset) ----
			if (filePath.includes('\0')) {
				logService.warn(`[EditFileTool][${toolCallPrefix}] step=safety FAILED: null bytes in path`);
				return {
					toolCallId: input.toolCallId,
					content: `Invalid file path: path contains null bytes.`,
					success: false,
				};
			}

			// ---- Resolve path ----
			const fileUri = pathService.resolveFilePath(filePath);
			if (!fileUri) {
				logService.warn(`[EditFileTool][${toolCallPrefix}] step=resolve FAILED: invalid path='${filePath}'`);
				return {
					toolCallId: input.toolCallId,
					content: `Invalid file path: ${filePath}. Be sure to use an absolute path.`,
					success: false,
				};
			}

			if (token?.isCancellationRequested) {
				logService.info(`[EditFileTool][${toolCallPrefix}] cancelled after path resolve`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Check ignore rules ----
			if (await ignoreService.isIgnored(fileUri)) {
				logService.warn(`[EditFileTool][${toolCallPrefix}] step=ignore BLOCKED: '${filePath}'`);
				return {
					toolCallId: input.toolCallId,
					content: `File '${filePath}' is configured to be ignored and cannot be edited.`,
					success: false,
				};
			}

			const filePathStr = pathService.getFilePath(fileUri);
			const newLines = code.split('\n');
			logService.info(`[EditFileTool][${toolCallPrefix}] step=input: file='${filePathStr}', new=${newLines.length} lines, ${code.length} chars`);

			// ---- Check if file exists (Copilot's internal tool handles create + overwrite) ----
			let fileExists = false;
			try {
				await fileService.stat(fileUri);
				fileExists = true;
			} catch {
				fileExists = false;
			}

			if (!fileExists) {
				// ---- Create new file (matching Copilot's behavior) ----
				if (token?.isCancellationRequested) {
					logService.info(`[EditFileTool][${toolCallPrefix}] cancelled before create`);
					return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
				}
				await fileService.createFile(fileUri, VSBuffer.fromString(code));
				const elapsed = Date.now() - startTime;
				logService.info(`[EditFileTool][${toolCallPrefix}] >>> created: file='${filePathStr}', ${newLines.length} lines, ${code.length} chars in ${elapsed}ms`);
				return {
					toolCallId: input.toolCallId,
					content: `[Edit: create] Created file: ${filePathStr} (${newLines.length} lines, ${code.length} chars)`,
					success: true,
					fileEdits: [{
						filePath: filePathStr,
						operation: 'add',
						afterContent: code,
						linesAdded: newLines.length,
					}],
				};
			}

			if (token?.isCancellationRequested) {
				logService.info(`[EditFileTool][${toolCallPrefix}] cancelled before read`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Read old content (for diff/reporting) ----
			const oldContent = (await fileService.readFile(fileUri)).toString();
			const oldLines = oldContent.split('\n');
			logService.info(`[EditFileTool][${toolCallPrefix}] step=read: file='${filePathStr}', ${oldLines.length} lines, ${oldContent.length} chars`);

			if (oldContent === code) {
				logService.info(`[EditFileTool][${toolCallPrefix}] step=write SKIPPED: no change`);
				return {
					toolCallId: input.toolCallId,
					content: `[Edit: no change] ${filePathStr}`,
					success: true,
				};
			}

			// ---- Write full new content ----
			await fileService.writeFile(fileUri, VSBuffer.fromString(code));

			const elapsed = Date.now() - startTime;
			logService.info(`[EditFileTool][${toolCallPrefix}] >>> done: file='${filePathStr}', ${oldLines.length}→${newLines.length} lines, ${oldContent.length}→${code.length} chars in ${elapsed}ms`);

			return {
				toolCallId: input.toolCallId,
				content: `[Edit: update] Replaced entire file content: ${filePathStr} (${oldLines.length} → ${newLines.length} lines, ${oldContent.length} → ${code.length} chars)`,
				success: true,
				fileEdits: [{
					filePath: filePathStr,
					operation: 'update',
					beforeContent: oldContent,
					afterContent: code,
					linesAdded: newLines.length - oldLines.length,
					linesRemoved: oldLines.length - newLines.length,
				}],
			};

		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[EditFileTool][${toolCallPrefix}] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error editing file: ${errMsg}`, success: false };
		}
	};
}
