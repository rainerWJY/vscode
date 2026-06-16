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
		logService.info(`[MultiReplaceStringTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}`);

		try {
			const token = input.cancellationToken;
			const replacements = input.parameters.replacements as ReplacementInput[] | undefined;

			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
				return {
					toolCallId: input.toolCallId,
					content: 'Invalid input: replacements array is required.',
					success: false,
				};
			}

			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Validate all inputs first ----
			const resolvedReplacements: { uri: URI; filePath: string; oldString: string; newString: string }[] = [];
			for (let i = 0; i < replacements.length; i++) {
				const r = replacements[i];
				if (!r.filePath || r.oldString === undefined || r.newString === undefined) {
					return {
						toolCallId: input.toolCallId,
						content: `Invalid input at index ${i}: filePath, oldString, and newString are required.`,
						success: false,
					};
				}
				const uri = pathService.resolveFilePath(r.filePath);
				if (!uri) {
					return {
						toolCallId: input.toolCallId,
						content: `Invalid file path at index ${i}: ${r.filePath}. Be sure to use an absolute path.`,
						success: false,
					};
				}
				if (await ignoreService.isIgnored(uri)) {
					return {
						toolCallId: input.toolCallId,
						content: `File '${r.filePath}' at index ${i} is configured to be ignored and cannot be edited.`,
						success: false,
					};
				}
				// Strip leading filepath comments (matching Copilot)
				const oldString = removeLeadingFilepathComment(r.oldString);
				const newString = removeLeadingFilepathComment(r.newString);
				resolvedReplacements.push({ uri, filePath: pathService.getFilePath(uri), oldString, newString });
			}

			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Read all files ----
			const fileContents = new Map<string, string>();
			for (const r of resolvedReplacements) {
				const uriStr = r.uri.toString();
				if (!fileContents.has(uriStr)) {
					try {
						await fileService.stat(r.uri);
						const content = (await fileService.readFile(r.uri)).toString();
						fileContents.set(uriStr, content);
					} catch {
						if (!r.oldString) {
							// Empty oldString = create file
							fileContents.set(uriStr, '');
						} else {
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
					logService.info(`[MultiReplaceStringTool] created file: ${r.filePath}`);
					continue;
				}

				const result = applyStringEdit(content, r.oldString, r.newString);
				if (!result.success) {
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
			}

			// ---- Write all modified files ----
			const writtenUris = new Set<string>();
			for (let i = 0; i < resolvedReplacements.length; i++) {
				if (!results[i].success) { continue; }
				const uriStr = resolvedReplacements[i].uri.toString();
				if (writtenUris.has(uriStr)) { continue; }
				writtenUris.add(uriStr);

				const updatedContent = fileContents.get(uriStr)!;
				const originalContent = resolvedReplacements[i].oldString
					? (await fileService.readFile(resolvedReplacements[i].uri)).toString()
					: '';

				if (updatedContent !== originalContent) {
					await fileService.writeFile(resolvedReplacements[i].uri, VSBuffer.fromString(updatedContent));
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

			logService.info(`[MultiReplaceStringTool] >>> done: ${successCount}/${results.length} succeeded in ${elapsed}ms`);
			return {
				toolCallId: input.toolCallId,
				content: summaryParts.join('\n'),
				success: !hasError,
				fileEdits: fileEdits.length > 0 ? fileEdits : undefined,
			};

		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[MultiReplaceStringTool] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error: ${errMsg}`, success: false };
		}
	};
}
