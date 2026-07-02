/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { applyStringEdit, removeLeadingFilepathComment } from './editFileUtils.js';
import type { IAgentHostPathService } from '../services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../services/agentHostIgnoreService.js';

/**
 * `replace_string_in_file` — finds an exact (or fuzzy) string in a file and
 * replaces it with a new string.
 *
 * Aligned with Copilot's `ReplaceStringTool` (`extensions/copilot/src/extension/tools/node/replaceStringTool.tsx`).
 *
 * Key alignment:
 * - Same 4-tier matching engine via `applyStringEdit`: exact → whitespace-flexible → fuzzy → similarity
 * - Same parameter schema (explanation, filePath, oldString, newString)
 * - Same error messages for missing files, no-match, multiple-match, and no-change
 *
 * Key differences:
 * - No `ExtendedLanguageModelToolResult` prompt rendering (returns plain text)
 * - No `prepareInvocation` / `handleToolStream` (no UI streaming)
 * - No `IBuildPromptContext` (no turn tracking)
 * - No `editToolLearningService`
 * - No `IEditSurvivalTrackerService`
 * - No Notebook support
 * - No `removeLeadingFilepathComment` feature
 */
export const TOOL_REPLACE_STRING = defineTool({
	name: ToolName.ReplaceString,
	description:
		'This is a tool for making edits in an existing file in the workspace. ' +
		'Provide the exact text to find (oldString) and the replacement text (newString). ' +
		'oldString must uniquely identify the single instance to change — include enough context ' +
		'(surrounding lines) to make it unique. ' +
		'This tool will fail if the file does not exist — use create_file to create new files. ' +
		'This tool supports creating new files if oldString is empty and the file does not exist.',
	parameters: {
		type: 'object',
		properties: {
			explanation: { type: 'string', description: 'A brief explanation of what the edit does.' },
			filePath: { type: 'string', description: 'The absolute path to the file to edit.' },
			oldString: { type: 'string', description: 'The exact text to find and replace. Include enough context to uniquely identify the location.' },
			newString: { type: 'string', description: 'The replacement text.' },
		},
		required: ['filePath', 'oldString', 'newString'],
	},
	isDestructive: true,
	toolKind: 'edit',
});

export function createReplaceStringExecutor(
	fileService: IFileService,
	pathService: IAgentHostPathService,
	ignoreService: IAgentHostIgnoreService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		const toolCallPrefix = input.toolCallId.substring(0, 8);
		logService.info(`[ReplaceStringTool] <<< invoked: toolCallId=${toolCallPrefix}, filePath=${input.parameters.filePath}`);

		try {
			const token = input.cancellationToken;

			if (token?.isCancellationRequested) {
				logService.warn(`[ReplaceStringTool][${toolCallPrefix}] cancelled`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const filePath = input.parameters.filePath as string;
			let oldString = input.parameters.oldString as string;
			let newString = input.parameters.newString as string;

			// ---- Validate input ----
			if (!filePath || oldString === undefined || newString === undefined) {
				logService.warn(`[ReplaceStringTool][${toolCallPrefix}] step=validate FAILED: filePath=${!!filePath}, oldString=${oldString !== undefined}, newString=${newString !== undefined}`);
				return {
					toolCallId: input.toolCallId,
					content: 'Invalid input: filePath, oldString, and newString are required.',
					success: false,
				};
			}

			// ---- Path safety check (matching Copilot's assertPathIsSafe) ----
			if (filePath.includes('\0')) {
				logService.warn(`[ReplaceStringTool][${toolCallPrefix}] step=safety FAILED: null bytes in path`);
				return {
					toolCallId: input.toolCallId,
					content: `Invalid file path: path contains null bytes.`,
					success: false,
				};
			}

			// ---- Resolve path ----
			const fileUri = pathService.resolveFilePath(filePath);
			if (!fileUri) {
				logService.warn(`[ReplaceStringTool][${toolCallPrefix}] step=resolve FAILED: invalid path='${filePath}'`);
				return {
					toolCallId: input.toolCallId,
					content: `Invalid file path: ${filePath}. Be sure to use an absolute path.`,
					success: false,
				};
			}

			if (token?.isCancellationRequested) {
				logService.info(`[ReplaceStringTool][${toolCallPrefix}] cancelled after path resolve`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Check ignore rules ----
			if (await ignoreService.isIgnored(fileUri)) {
				logService.warn(`[ReplaceStringTool][${toolCallPrefix}] step=ignore BLOCKED: filePath='${filePath}'`);
				return {
					toolCallId: input.toolCallId,
					content: `File '${filePath}' is configured to be ignored and cannot be edited.`,
					success: false,
				};
			}

			// ---- Strip leading filepath comment (matching Copilot) ----
			const filePathStr = pathService.getFilePath(fileUri);
			const oldStringRaw = oldString;
			const newStringRaw = newString;
			oldString = removeLeadingFilepathComment(oldString);
			newString = removeLeadingFilepathComment(newString);
			if (oldString !== oldStringRaw || newString !== newStringRaw) {
				logService.info(`[ReplaceStringTool][${toolCallPrefix}] step=stripFilepathComment: stripped ${oldStringRaw.length - oldString.length + newStringRaw.length - newString.length} chars`);
			}

			// ---- Snapshot oldString/newString info for debugging ----
			const oldLines = oldString.split('\n');
			const newLines = newString.split('\n');
			const oldPreview = oldLines.length <= 3 ? oldString.substring(0, 200) : oldLines.slice(0, 2).join('\\n') + '...' + oldLines.slice(-1)[0];
			const newPreview = newLines.length <= 3 ? newString.substring(0, 200) : newLines.slice(0, 2).join('\\n') + '...' + newLines.slice(-1)[0];
			logService.info(`[ReplaceStringTool][${toolCallPrefix}] step=input: file='${filePathStr}', old=${oldLines.length} lines, new=${newLines.length} lines`);

			// ---- New file creation case ----
			let fileExists = false;
			try {
				await fileService.stat(fileUri);
				fileExists = true;
			} catch {
				fileExists = false;
			}

			if (!fileExists && !oldString) {
				// Empty oldString + non-existing file = create new file (matching Copilot)
				await fileService.createFile(fileUri, VSBuffer.fromString(newString));
				const newCharLen = newString.length;
				logService.info(`[ReplaceStringTool][${toolCallPrefix}] >>> created new file via empty oldString: '${filePathStr}' (${newLines.length} lines, ${newCharLen} chars)`);
				return {
					toolCallId: input.toolCallId,
					content: `File created: ${filePathStr}`,
					success: true,
					fileEdits: [{ filePath: filePathStr, operation: 'add', linesAdded: newLines.length }],
				};
			}

			if (!fileExists) {
				logService.warn(`[ReplaceStringTool][${toolCallPrefix}] step=stat FAILED: file not found '${filePathStr}'`);
				return {
					toolCallId: input.toolCallId,
					content: `File does not exist: ${filePath}. Use the create_file tool to create it, or correct your filepath.`,
					success: false,
				};
			}

			// ---- Read file content ----
			const content = (await fileService.readFile(fileUri)).toString();
			const contentLines = content.split('\n');
			logService.info(`[ReplaceStringTool][${toolCallPrefix}] step=read: file='${filePathStr}', ${contentLines.length} lines, ${content.length} chars`);

			if (token?.isCancellationRequested) {
				logService.info(`[ReplaceStringTool][${toolCallPrefix}] cancelled after file read`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Apply the edit with 4-tier matching ----
			const result = applyStringEdit(content, oldString, newString);

			if (!result.success) {
				const failKind = result.errorMessage?.includes('Multiple matches') ? 'MultipleMatches'
					: result.errorMessage?.includes('match exactly') ? 'NoChange'
						: result.errorMessage?.includes('Could not find') ? 'NoMatch'
							: 'Other';
				logService.warn(`[ReplaceStringTool][${toolCallPrefix}] step=edit FAILED: kind=${failKind}, msg=${result.errorMessage}`);
				logService.info(`[ReplaceStringTool][${toolCallPrefix}] step=edit FAILED details: file='${filePathStr}', oldPreview='${oldPreview}', newPreview='${newPreview}'`);
				return {
					toolCallId: input.toolCallId,
					content: `[Error: ${failKind}] ${result.errorMessage}`,
					success: false,
				};
			}

			// ---- Write modified content ----
			await fileService.writeFile(fileUri, VSBuffer.fromString(result.updatedFile));

			const elapsed = Date.now() - startTime;
			const oldLineCount = oldLines.length;
			const newLineCount = newLines.length;
			const updatedLines = result.updatedFile.split('\n');
			logService.info(`[ReplaceStringTool][${toolCallPrefix}] >>> done: matchType=${result.matchType}, ${oldLineCount}→${newLineCount} lines, file: ${contentLines.length}→${updatedLines.length} lines, ${content.length}→${result.updatedFile.length} chars, ${elapsed}ms`);
			if (result.suggestion) {
				logService.info(`[ReplaceStringTool][${toolCallPrefix}] >>> match suggestion: ${result.suggestion}`);
			}
			// Return structured info so LLM knows the match strategy and what changed
			const diffSummary = result.matchType === 'exact' ? 'exact match'
				: result.matchType === 'whitespace' ? 'whitespace-flexible match'
					: result.matchType === 'fuzzy' ? 'fuzzy line match'
						: result.matchType === 'similarity' ? `similarity match (${result.suggestion ?? ''})`
							: 'unknown match';
			return {
				toolCallId: input.toolCallId,
				content: `[Edit: update] Replaced ${oldLineCount} lines with ${newLineCount} lines in ${filePathStr} (${diffSummary})`,
				success: true,
				fileEdits: [{
					filePath: filePathStr,
					operation: 'update',
					beforeContent: content,
					afterContent: result.updatedFile,
					linesAdded: newLineCount - oldLineCount,
					linesRemoved: oldLineCount - newLineCount,
				}],
			};

		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[ReplaceStringTool][${toolCallPrefix}] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error editing file: ${errMsg}`, success: false };
		}
	};
}
