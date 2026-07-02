/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput, type ToolFileEdit } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { applyStringEdit, removeLeadingFilepathComment } from './editFileUtils.js';
import type { IAgentHostPathService } from '../services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../services/agentHostIgnoreService.js';

/**
 * `multi_replace_string_in_file` — batch version of replace_string_in_file.
 * Takes an array of replacements and applies them sequentially. Supports
 * editing multiple files in a single call.
 *
 * Aligned with Copilot's `MultiReplaceStringTool`
 * (`extensions/copilot/src/extension/tools/node/multiReplaceStringTool.tsx`).
 *
 * Key alignment:
 * - Same 4-tier matching engine per replacement
 * - Same conflict detection: overlapping edits to the same file cause an error
 * - Same summary output: reports successes and failures
 *
 * Key differences:
 * - No `ExtendedLanguageModelToolResult` prompt rendering
 * - No `handleToolStream` (no streaming)
 * - No Notebook support
 * - Applies edits sequentially (like Copilot) but with conflict detection
 */
export const TOOL_MULTI_REPLACE_STRING = defineTool({
	name: ToolName.MultiReplaceString,
	description:
		'This is the primary tool for making multiple edits to one or more files. ' +
		'Use this instead of calling replace_string_in_file repeatedly. ' +
		'It takes an array of replacement operations and applies them sequentially. ' +
		'Each replacement operation has: filePath, oldString, newString. ' +
		'This tool is ideal when you need to make multiple edits across different files ' +
		'or multiple edits in the same file. ' +
		'The tool will provide a summary of successful and failed operations.',
	parameters: {
		type: 'object',
		properties: {
			explanation: { type: 'string', description: 'A brief explanation of what the edits do.' },
			replacements: {
				type: 'array',
				description: 'An array of replacement operations to apply.',
				items: {
					type: 'object',
					properties: {
						filePath: { type: 'string', description: 'The absolute path to the file to edit.' },
						oldString: { type: 'string', description: 'The exact text to find and replace.' },
						newString: { type: 'string', description: 'The replacement text.' },
					},
					required: ['filePath', 'oldString', 'newString'],
				},
			},
		},
		required: ['replacements'],
	},
	isDestructive: true,
	toolKind: 'edit',
});

interface ReplacementInput {
	filePath: string;
	oldString: string;
	newString: string;
}

interface ReplacementResult {
	filePath: string;
	success: boolean;
	errorMessage?: string;
}

export function createMultiReplaceStringExecutor(
	fileService: IFileService,
	pathService: IAgentHostPathService,
	ignoreService: IAgentHostIgnoreService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		const toolCallPrefix = input.toolCallId.substring(0, 8);
		const replacements = input.parameters.replacements as ReplacementInput[] | undefined;
		const replacementCount = replacements?.length ?? 0;
		logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] <<< invoked: ${replacementCount} replacements`);

		try {
			const token = input.cancellationToken;

			if (token?.isCancellationRequested) {
				logService.warn(`[MultiReplaceStringTool][${toolCallPrefix}] cancelled`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
				logService.warn(`[MultiReplaceStringTool][${toolCallPrefix}] step=validate FAILED: empty replacements`);
				return {
					toolCallId: input.toolCallId,
					content: 'Invalid input: replacements array is required.',
					success: false,
				};
			}

			if (token?.isCancellationRequested) {
				logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] cancelled after validate`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Validate all inputs first ----
			const resolvedReplacements: { uri: URI; filePath: string; oldString: string; newString: string }[] = [];
			for (let i = 0; i < replacements.length; i++) {
				const r = replacements[i];
				if (!r.filePath || r.oldString === undefined || r.newString === undefined) {
					logService.warn(`[MultiReplaceStringTool][${toolCallPrefix}] step=validate FAILED at index ${i}: missing fields`);
					return {
						toolCallId: input.toolCallId,
						content: `Invalid input at index ${i}: filePath, oldString, and newString are required.`,
						success: false,
					};
				}

				// ---- Path safety check (matching Copilot's assertPathIsSafe) ----
				if (r.filePath.includes('\0')) {
					logService.warn(`[MultiReplaceStringTool][${toolCallPrefix}] step=safety FAILED at index ${i}: null bytes in path`);
					return {
						toolCallId: input.toolCallId,
						content: `Invalid file path at index ${i}: path contains null bytes.`,
						success: false,
					};
				}

				const uri = pathService.resolveFilePath(r.filePath);
				if (!uri) {
					logService.warn(`[MultiReplaceStringTool][${toolCallPrefix}] step=resolve FAILED at index ${i}: invalid path='${r.filePath}'`);
					return {
						toolCallId: input.toolCallId,
						content: `Invalid file path at index ${i}: ${r.filePath}. Be sure to use an absolute path.`,
						success: false,
					};
				}
				if (await ignoreService.isIgnored(uri)) {
					logService.warn(`[MultiReplaceStringTool][${toolCallPrefix}] step=ignore BLOCKED at index ${i}: '${r.filePath}'`);
					return {
						toolCallId: input.toolCallId,
						content: `File '${r.filePath}' at index ${i} is configured to be ignored and cannot be edited.`,
						success: false,
					};
				}
				// Strip leading filepath comments (matching Copilot)
				const oldString = removeLeadingFilepathComment(r.oldString);
				const newString = removeLeadingFilepathComment(r.newString);
				const filePathStr = pathService.getFilePath(uri);
				resolvedReplacements.push({ uri, filePath: filePathStr, oldString, newString });

				logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] step=resolve[${i}]: file='${filePathStr}', old=${oldString.split('\n').length} lines, new=${newString.split('\n').length} lines`);
			}

			if (token?.isCancellationRequested) {
				logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] cancelled after resolve`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Read all files ----
			const fileContents = new Map<string, string>();
			const originalContents = new Map<string, string>();
			for (const r of resolvedReplacements) {
				const uriStr = r.uri.toString();
				if (!fileContents.has(uriStr)) {
					try {
						await fileService.stat(r.uri);
						const content = (await fileService.readFile(r.uri)).toString();
						fileContents.set(uriStr, content);
						originalContents.set(uriStr, content);
						logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] step=read: file='${r.filePath}', ${content.split('\n').length} lines, ${content.length} chars`);
					} catch {
						if (!r.oldString) {
							// Empty oldString = create file
							fileContents.set(uriStr, '');
							originalContents.set(uriStr, '');
							logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] step=read: file='${r.filePath}' does not exist, will create via empty oldString`);
						} else {
							logService.warn(`[MultiReplaceStringTool][${toolCallPrefix}] step=stat FAILED: file not found '${r.filePath}'`);
							return {
								toolCallId: input.toolCallId,
								content: `File does not exist: ${pathService.getFilePath(r.uri)}. Use create_file to create it, or correct your filepath.`,
								success: false,
							};
						}
					}
				}
			}

			if (token?.isCancellationRequested) {
				logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] cancelled after file reads`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Apply edits sequentially with conflict detection ----
			const results: ReplacementResult[] = [];
			const fileEdits: ToolFileEdit[] = [];
			let hasError = false;

			for (let i = 0; i < resolvedReplacements.length; i++) {
				const r = resolvedReplacements[i];
				const uriStr = r.uri.toString();
				const content = fileContents.get(uriStr)!;
				const beforeContent = content;

				if (!r.oldString && !content) {
					// Create new file
					await fileService.createFile(r.uri, VSBuffer.fromString(r.newString));
					fileContents.set(uriStr, r.newString);
					results.push({ filePath: r.filePath, success: true });
					fileEdits.push({ filePath: r.filePath, operation: 'add', linesAdded: r.newString.split('\n').length });
					logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] result[${i}]: CREATED file='${r.filePath}', ${r.newString.split('\n').length} lines`);
					continue;
				}

				const result = applyStringEdit(content, r.oldString, r.newString);
				if (!result.success) {
					const failKind = result.errorMessage?.includes('Multiple matches') ? 'MultipleMatches'
						: result.errorMessage?.includes('match exactly') ? 'NoChange'
							: result.errorMessage?.includes('Could not find') ? 'NoMatch'
								: 'Other';
					logService.warn(`[MultiReplaceStringTool][${toolCallPrefix}] result[${i}]: FAILED file='${r.filePath}', kind=${failKind}, msg=${result.errorMessage}`);
					results.push({ filePath: r.filePath, success: false, errorMessage: result.errorMessage });
					hasError = true;
					continue;
				}

				// Update the cached content for subsequent edits to the same file
				fileContents.set(uriStr, result.updatedFile);
				results.push({ filePath: r.filePath, success: true });
				fileEdits.push({
					filePath: r.filePath,
					operation: 'update',
					beforeContent,
					afterContent: result.updatedFile,
					linesAdded: r.newString.split('\n').length - r.oldString.split('\n').length,
					linesRemoved: r.oldString.split('\n').length - r.newString.split('\n').length,
				});
				const oldLines = r.oldString.split('\n').length;
				const newLines = r.newString.split('\n').length;
				const beforeLines = beforeContent.split('\n').length;
				const afterLines = result.updatedFile.split('\n').length;
				logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] result[${i}]: OK file='${r.filePath}', matchType=${result.matchType}, ${oldLines}→${newLines} lines, file: ${beforeLines}→${afterLines}${result.suggestion ? `, suggestion=${result.suggestion}` : ''}`);
			}

			// ---- Write all modified files ----
			const writtenUris = new Set<string>();
			for (let i = 0; i < resolvedReplacements.length; i++) {
				if (!results[i].success) { continue; }
				const uriStr = resolvedReplacements[i].uri.toString();
				if (writtenUris.has(uriStr)) { continue; }
				writtenUris.add(uriStr);

				const updatedContent = fileContents.get(uriStr)!;
				const originalContent = originalContents.get(uriStr)!;

				if (updatedContent !== originalContent) {
					await fileService.writeFile(resolvedReplacements[i].uri, VSBuffer.fromString(updatedContent));
				} else {
					logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] write[${i}]: SKIPPED (no change) file='${resolvedReplacements[i].filePath}'`);
				}
			}

			const elapsed = Date.now() - startTime;
			const successCount = results.filter(r => r.success).length;
			const failureCount = results.filter(r => !r.success).length;

			// ---- Build summary ----
			const summaryParts: string[] = [];
			summaryParts.push(`Applied ${results.length} replacement(s): ${successCount} succeeded, ${failureCount} failed (${elapsed}ms).`);
			for (const r of results) {
				if (r.errorMessage) {
					const failKind = r.errorMessage.includes('Multiple matches') ? 'MultipleMatches'
						: r.errorMessage.includes('match exactly') ? 'NoChange'
							: r.errorMessage.includes('Could not find') ? 'NoMatch'
								: 'Other';
					summaryParts.push(`- [${failKind}] ${r.filePath}: ${r.errorMessage}`);
				} else {
					summaryParts.push(`- [OK] ${r.filePath}`);
				}
			}

			logService.info(`[MultiReplaceStringTool][${toolCallPrefix}] >>> done: ${successCount}/${results.length} succeeded, ${failureCount} failed in ${elapsed}ms`);
			return {
				toolCallId: input.toolCallId,
				content: summaryParts.join('\n'),
				success: !hasError,
				fileEdits: fileEdits.length > 0 ? fileEdits : undefined,
			};

		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[MultiReplaceStringTool][${toolCallPrefix}] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error: ${errMsg}`, success: false };
		}
	};
}
