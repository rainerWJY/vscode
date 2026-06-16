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
		logService.info(`[ReplaceStringTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, filePath=${input.parameters.filePath}`);

		try {
			const token = input.cancellationToken;

			if (token?.isCancellationRequested) {
				logService.warn(`[ReplaceStringTool] cancelled`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const filePath = input.parameters.filePath as string;
			let oldString = input.parameters.oldString as string;
			let newString = input.parameters.newString as string;

			// ---- Validate input ----
			if (!filePath || oldString === undefined || newString === undefined) {
				logService.warn(`[ReplaceStringTool] step=validate FAILED`);
				return {
					toolCallId: input.toolCallId,
					content: 'Invalid input: filePath, oldString, and newString are required.',
					success: false,
				};
			}

			// ---- Resolve path ----
			const fileUri = pathService.resolveFilePath(filePath);
			if (!fileUri) {
				return {
					toolCallId: input.toolCallId,
					content: `Invalid file path: ${filePath}. Be sure to use an absolute path.`,
					success: false,
				};
			}

			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Check ignore rules ----
			if (await ignoreService.isIgnored(fileUri)) {
				return {
					toolCallId: input.toolCallId,
					content: `File '${filePath}' is configured to be ignored and cannot be edited.`,
					success: false,
				};
			}

			// ---- Strip leading filepath comment (matching Copilot) ----
			const filePathStr = pathService.getFilePath(fileUri);
			oldString = removeLeadingFilepathComment(oldString);
			newString = removeLeadingFilepathComment(newString);

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
				logService.info(`[ReplaceStringTool] >>> created new file via empty oldString`);
				return {
					toolCallId: input.toolCallId,
					content: `File created: ${filePathStr}`,
					success: true,
					fileEdits: [{ filePath: filePathStr, operation: 'add', linesAdded: newString.split('\n').length }],
				};
			}

			if (!fileExists) {
				return {
					toolCallId: input.toolCallId,
					content: `File does not exist: ${filePath}. Use the create_file tool to create it, or correct your filepath.`,
					success: false,
				};
			}

			// ---- Read file content ----
			const content = (await fileService.readFile(fileUri)).toString();

			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Apply the edit with 4-tier matching ----
			const result = applyStringEdit(content, oldString, newString);

			if (!result.success) {
				logService.warn(`[ReplaceStringTool] step=edit FAILED: ${result.errorMessage}`);
				// Embed failure info in the output so the LLM can react: type=NoMatch|MultipleMatches|NoChange
				const failKind = result.errorMessage?.includes('Multiple matches') ? 'MultipleMatches'
					: result.errorMessage?.includes('match exactly') ? 'NoChange'
						: result.errorMessage?.includes('Could not find') ? 'NoMatch'
							: 'Other';
				return {
					toolCallId: input.toolCallId,
					content: `[Error: ${failKind}] ${result.errorMessage}`,
					success: false,
				};
			}

			// ---- Write modified content ----
			await fileService.writeFile(fileUri, VSBuffer.fromString(result.updatedFile));

			const elapsed = Date.now() - startTime;
			const oldLineCount = oldString.split('\n').length;
			const newLineCount = newString.split('\n').length;
			logService.info(`[ReplaceStringTool] >>> done: matchType=${result.matchType}, ${oldLineCount}→${newLineCount} lines in ${elapsed}ms`);
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
			logService.error(`[ReplaceStringTool] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error editing file: ${errMsg}`, success: false };
		}
	};
}
