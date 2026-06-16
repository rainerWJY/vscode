/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import type { IAgentHostPathService } from '../services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../services/agentHostIgnoreService.js';

/**
 * Creates a new file — rejects if the file already exists.
 *
 * Aligned with Copilot's `CreateFileTool` (`extensions/copilot/src/extension/tools/node/createFileTool.tsx`).
 *
 * Key alignment features:
 * - Input validation (filePath + content required)
 * - File-exists check: rejects with message suggesting edit tool
 * - Path resolution via `IAgentHostPathService`
 * - Content validation (non-empty)
 * - Cancellation checks before/after I/O
 * - Comprehensive logging
 *
 * What is NOT implemented (architecture constraints):
 * - Notebook support (no INotebookService in agent host)
 * - prepareInvocation with diff preview (no UI)
 * - handleToolStream (no streaming protocol)
 * - resolveInput (no IBuildPromptContext)
 * - removeLeadingFilepathComment (not needed — model sends raw content)
 * - CodeBlockProcessor (not needed)
 * - Telemetry / l10n (not available in agent host)
 */
export const TOOL_CREATE_FILE = defineTool({
	name: ToolName.CreateFile,
	description:
		'Create a new file. Provide the full intended content of the file. This tool will fail if the file already exists — use edit tools to modify existing files.',
	parameters: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'The absolute path to the file to create.' },
			content: { type: 'string', description: 'The full content to write to the file.' },
		},
		required: ['filePath', 'content'],
	},
	isDestructive: true,
	toolKind: 'edit',
});

// ---- handler (tool executor) ------------------------------------------------

export function createCreateFileExecutor(
	fileService: IFileService,
	pathService: IAgentHostPathService,
	ignoreService: IAgentHostIgnoreService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		logService.info(`[CreateFileTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}, filePath=${input.parameters.filePath}, contentLen=${(input.parameters.content as string)?.length ?? 0}`);

		try {
			const token = input.cancellationToken;

			// Copilot-matching: check cancellation before any work
			if (token?.isCancellationRequested) {
				logService.warn(`[CreateFileTool] cancelled before any work`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const filePath = input.parameters.filePath as string;
			const content = input.parameters.content as string;

			// ---- Step 1: Input validation (matching Copilot) ----
			if (!filePath || !content) {
				logService.warn(`[CreateFileTool] step=validate FAILED: filePath="${filePath}", content=${content ? 'provided' : 'missing/empty'}`);
				return {
					toolCallId: input.toolCallId,
					content: 'Invalid input: filePath and non-empty content are required.',
					success: false,
				};
			}

			logService.info(`[CreateFileTool] step=validate: filePath="${filePath}", contentLen=${content.length}`);

			// ---- Step 2: Resolve path (matching Copilot's resolveToolInputPath) ----
			logService.info(`[CreateFileTool] step=resolve_path: "${filePath}"`);
			const fileUri = pathService.resolveFilePath(filePath);
			if (!fileUri) {
				logService.warn(`[CreateFileTool] step=resolve_path FAILED: cannot resolve "${filePath}"`);
				return {
					toolCallId: input.toolCallId,
					content: `Invalid file path: ${filePath}. Be sure to use an absolute path.`,
					success: false,
				};
			}
			logService.info(`[CreateFileTool] step=resolve_path done: uri=${fileUri.fsPath}`);

			// Copilot-matching: check cancellation before I/O
			if (token?.isCancellationRequested) {
				logService.warn(`[CreateFileTool] cancelled after path resolution`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 3: Check ignore rules ----
			logService.info(`[CreateFileTool] step=ignore_check: uri=${fileUri.fsPath}`);
			if (await ignoreService.isIgnored(fileUri)) {
				logService.warn(`[CreateFileTool] step=ignore_check BLOCKED: ${fileUri.fsPath}`);
				return {
					toolCallId: input.toolCallId,
					content: `File '${filePath}' is configured to be ignored and cannot be created.`,
					success: false,
				};
			}
			logService.info(`[CreateFileTool] step=ignore_check PASS`);

			// ---- Step 4: File exists check (matching Copilot's fileExists) ----
			logService.info(`[CreateFileTool] step=stat: uri=${fileUri.fsPath}`);
			const fileExists = await fileExistsCheck(fileService, fileUri);
			logService.info(`[CreateFileTool] step=stat done: exists=${fileExists}`);

			if (fileExists) {
				logService.warn(`[CreateFileTool] step=stat FAILED: file already exists: ${fileUri.fsPath}`);
				return {
					toolCallId: input.toolCallId,
					content: `File already exists: ${filePath}. This tool only creates new files. Use the edit tools to modify existing files.`,
					success: false,
				};
			}

			// Copilot-matching: check cancellation before write
			if (token?.isCancellationRequested) {
				logService.warn(`[CreateFileTool] cancelled before write`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			// ---- Step 5: Write file ----
			logService.info(`[CreateFileTool] step=write: uri=${fileUri.fsPath}, contentLen=${content.length}`);
			await fileService.writeFile(fileUri, VSBuffer.fromString(content));
			logService.info(`[CreateFileTool] step=write done`);

			// Copilot-matching: check cancellation after write
			if (token?.isCancellationRequested) {
				logService.warn(`[CreateFileTool] cancelled after write`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const elapsed = Date.now() - startTime;
			const lineCount = content.split('\n').length;
			logService.info(`[CreateFileTool] >>> done: ${lineCount} lines, ${content.length} chars in ${elapsed}ms`);
			return {
				toolCallId: input.toolCallId,
				content: `File written: ${pathService.getFilePath(fileUri)} (${lineCount} lines, ${content.length} characters)`,
				success: true,
				fileEdits: [{ filePath: pathService.getFilePath(fileUri), operation: 'add', linesAdded: lineCount }],
			};

		} catch (err) {
			const elapsed = Date.now() - startTime;
			const errMsg = err instanceof Error ? err.message : String(err);
			logService.error(`[CreateFileTool] >>> ERROR after ${elapsed}ms: ${errMsg}`);
			return { toolCallId: input.toolCallId, content: `Error writing file: ${errMsg}`, success: false };
		}
	};
}

/**
 * Check whether a file exists using IFileService.stat().
 * Matches Copilot's fileExists() helper in createFileTool.tsx.
 */
async function fileExistsCheck(fileService: IFileService, uri: URI): Promise<boolean> {
	try {
		await fileService.stat(uri);
		return true;
	} catch {
		return false;
	}
}
