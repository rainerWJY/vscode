/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput, type ToolFileEdit } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { parsePatch, ActionType, type Commit } from './applyPatchUtils.js';
import type { IAgentHostPathService } from '../services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../services/agentHostIgnoreService.js';

/**
 * `apply_patch` — applies a structured patch text to make multiple file edits.
 *
 * Aligned with Copilot's `ApplyPatchTool` (`extensions/copilot/src/extension/tools/node/applyPatchTool.tsx`).
 *
 * The patch format (from OpenAI Codex's `apply_patch.py`):
 * ```
 * *** Begin Patch
 * *** Add File: <path>
 * + file content
 * *** Update File: <path>
 * @@ function context
 * - old code
 * + new code
 * *** Delete File: <path>
 * *** End Patch
 * ```
 *
 * Key differences from Copilot:
 * - Simplified context matching (exact match → whitespace-flexible match, no edit-distance fuzzy matching)
 * - No patch healing (no small-model round-trip for fixing broken patches)
 * - No `ExtendedLanguageModelToolResult` prompt rendering (returns plain text summary)
 * - No `IEditSurvivalTrackerService`
 * - No Notebook support
 */
export const TOOL_APPLY_PATCH = defineTool({
	name: ToolName.ApplyPatch,
	description:
		'Use the apply_patch tool to edit files. ' +
		'Your patch language is a stripped-down, file-oriented diff format. ' +
		'Format:\n' +
		'*** Begin Patch\n' +
		'*** Add File: <path>\n' +
		'+ content line 1\n' +
		'+ content line 2\n' +
		'*** Update File: <path>\n' +
		'@@ optional context line\n' +
		'- old code line\n' +
		'+ new code line\n' +
		'*** Delete File: <path>\n' +
		'*** End Patch\n' +
		'Supports creating, updating (with deletion lines as context), and deleting files. ' +
		'Also supports renaming with *** Move to: <new path> after an Update line.',
	parameters: {
		type: 'object',
		properties: {
			input: { type: 'string', description: 'The full patch text including *** Begin Patch and *** End Patch markers.' },
			explanation: { type: 'string', description: 'A brief explanation of what the patch does.' },
		},
		required: ['input'],
	},
	isDestructive: true,
	toolKind: 'edit',
});

export function createApplyPatchExecutor(
	fileService: IFileService,
	pathService: IAgentHostPathService,
	ignoreService: IAgentHostIgnoreService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.info(`[ApplyPatchTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}`);

		try {
			const token = input.cancellationToken;
			const patchText = input.parameters.input as string;

			if (token?.isCancellationRequested) {
				logService.warn(`[ApplyPatchTool] cancelled`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			if (!patchText) {
				return {
					toolCallId: input.toolCallId,
					content: 'Invalid input: patch text is required.',
					success: false,
				};
			}

			logService.info(`[ApplyPatchTool] patchLen=${patchText.length}`);

			// ---- Parse the patch ----
			let commit: Commit;
			try {
				commit = parsePatch(patchText);
			} catch (parseErr) {
				logService.warn(`[ApplyPatchTool] parse FAILED: ${parseErr}`);
				return {
					toolCallId: input.toolCallId,
					content: `Failed to parse patch: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
					success: false,
				};
			}

			const changeCount = Object.keys(commit.changes).length;
			if (changeCount === 0) {
				return {
					toolCallId: input.toolCallId,
					content: 'Patch parsed successfully but no changes were detected.',
					success: false,
				};
			}

			logService.info(`[ApplyPatchTool] parsed: ${changeCount} changes`);

			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Resolve paths and check ignores ----
			const resolvedChanges: Array<{
				filePath: string;
				uri: URI;
				change: Commit['changes'][string];
			}> = [];

			for (const [filePath, change] of Object.entries(commit.changes)) {
				const uri = pathService.resolveFilePath(filePath);
				if (!uri) {
					return {
						toolCallId: input.toolCallId,
						content: `Invalid file path in patch: ${filePath}. Be sure to use absolute paths.`,
						success: false,
					};
				}
				if (await ignoreService.isIgnored(uri)) {
					return {
						toolCallId: input.toolCallId,
						content: `File '${filePath}' is configured to be ignored and cannot be edited.`,
						success: false,
					};
				}
				resolvedChanges.push({ filePath, uri, change });
			}

			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Apply changes ----
			const results: string[] = [];
			const fileEdits: ToolFileEdit[] = [];
			let hasError = false;

			for (const { filePath, uri, change } of resolvedChanges) {
				try {
					switch (change.type) {
						case ActionType.ADD: {
							// Check file doesn't exist
							let exists = false;
							try {
								await fileService.stat(uri);
								exists = true;
							} catch { /* doesn't exist */ }
							if (exists) {
								results.push(`${filePath}: FAILED — File already exists.`);
								hasError = true;
								continue;
							}

							const content = change.newContent ?? '';
							await fileService.createFile(uri, VSBuffer.fromString(content));
							const lineCount = content.split('\n').length;
							results.push(`${filePath}: Created (${lineCount} lines, ${content.length} chars)`);
							fileEdits.push({ filePath, operation: 'add', linesAdded: lineCount });
							logService.info(`[ApplyPatchTool] created: ${filePath}`);
							break;
						}

						case ActionType.DELETE: {
							let exists = false;
							try {
								await fileService.stat(uri);
								exists = true;
							} catch { /* doesn't exist */ }
							if (!exists) {
								results.push(`${filePath}: FAILED — File does not exist.`);
								hasError = true;
								continue;
							}

							await fileService.del(uri, { recursive: false, useTrash: false });
							results.push(`${filePath}: Deleted`);
							fileEdits.push({ filePath, operation: 'delete' });
							logService.info(`[ApplyPatchTool] deleted: ${filePath}`);
							break;
						}

						case ActionType.UPDATE: {
							let exists = false;
							try {
								await fileService.stat(uri);
								exists = true;
							} catch { /* doesn't exist */ }
							if (!exists) {
								results.push(`${filePath}: FAILED — File does not exist.`);
								hasError = true;
								continue;
							}

							// Handle rename
							let targetUri = uri;
							if (change.movePath) {
								const moveUri = pathService.resolveFilePath(change.movePath);
								if (!moveUri) {
									results.push(`${filePath}: FAILED — Invalid move path: ${change.movePath}`);
									hasError = true;
									continue;
								}
								targetUri = moveUri;
							}

							const oldContent = (await fileService.readFile(uri)).toString();
							const newContent = change.newContent ?? oldContent;
							const oldLineCount = oldContent.split('\n').length;
							const newLineCount = newContent.split('\n').length;

							if (targetUri.toString() !== uri.toString()) {
								// Rename + update
								let targetExists = false;
								try {
									await fileService.stat(targetUri);
									targetExists = true;
								} catch { /* doesn't exist */ }
								if (targetExists) {
									await fileService.writeFile(targetUri, VSBuffer.fromString(newContent));
									await fileService.del(uri, { recursive: false, useTrash: false });
								} else {
									await fileService.createFile(targetUri, VSBuffer.fromString(newContent));
									await fileService.del(uri, { recursive: false, useTrash: false });
								}
								results.push(`${filePath} → ${change.movePath}: Updated and moved`);
								fileEdits.push({
									filePath: change.movePath || filePath,
									operation: 'move',
									beforeContent: oldContent,
									afterContent: newContent,
									movePath: change.movePath ?? undefined,
									linesAdded: newLineCount - oldLineCount,
									linesRemoved: oldLineCount - newLineCount,
								});
							} else {
								await fileService.writeFile(uri, VSBuffer.fromString(newContent));
								results.push(`${filePath}: Updated (${newLineCount} lines, ${newContent.length} chars)`);
								fileEdits.push({
									filePath,
									operation: 'update',
									beforeContent: oldContent,
									afterContent: newContent,
									linesAdded: newLineCount - oldLineCount,
									linesRemoved: oldLineCount - newLineCount,
								});
							}
							logService.info(`[ApplyPatchTool] updated: ${filePath}`);
							break;
						}
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					results.push(`${filePath}: ERROR — ${errMsg}`);
					hasError = true;
				}
			}

			const elapsed = Date.now() - startTime;
			const successCount = results.filter(r => !r.includes('FAILED') && !r.includes('ERROR')).length;
			logService.info(`[ApplyPatchTool] >>> done: ${successCount}/${changeCount} changes in ${elapsed}ms`);

			return {
				toolCallId: input.toolCallId,
				content: `Applied ${changeCount} change(s): ${successCount} succeeded\n${results.join('\n')}`,
				success: !hasError,
				fileEdits: fileEdits.length > 0 ? fileEdits : undefined,
			};

		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[ApplyPatchTool] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error: ${errMsg}`, success: false };
		}
	};
}
