/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import { type IAgentHostFileSystemService, FileType } from '../services/agentHostFileSystemService.js';
import { type IAgentHostPathService } from '../services/agentHostPathService.js';
import type { AgentHostWorkingDirectory } from '../services/agentHostWorkingDirectory.js';

/**
 * List the contents of a directory.
 *
 * Returns names of children — those ending in "/" are folders.
 * Aligned with Copilot's `ListDirTool`.
 */
export const TOOL_LIST_DIR = defineTool({
	name: ToolName.ListDirectory,
	description:
		'List the contents of a directory. Returns names of children — those ending in "/" are folders.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'The absolute path to the directory to list.' },
		},
		required: ['path'],
	},
	isDestructive: false,
	toolKind: 'read',
});

// ---- handler (tool executor) ------------------------------------------------

export function createListDirExecutor(
	fsService: IAgentHostFileSystemService,
	pathService: IAgentHostPathService,
	logService: ILogService,
	workingDirectory?: AgentHostWorkingDirectory,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		try {
			const token = input.cancellationToken;

			// Copilot-matching: check cancellation before I/O
			if (token?.isCancellationRequested) {
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const dirPath = input.parameters.path as string;
			logService.trace(`[ListDirTool] list_dir: path=${dirPath}`);

			// Resolve path through the path service (handles Windows, schemes, etc.)
			const dirUri = pathService.resolveFilePath(dirPath);
			if (!dirUri) {
				logService.warn(`[ListDirTool] step=resolve_path FAILED: cannot resolve "${dirPath}"`);
				return {
					toolCallId: input.toolCallId,
					content: `Cannot resolve path: "${dirPath}". Provide an absolute file path.`,
					success: false,
				};
			}
			logService.trace(`[ListDirTool] resolvedUri=${dirUri.fsPath}`);

			// Copilot-matching: check cancellation before I/O
			if (token?.isCancellationRequested) {
				logService.warn(`[ListDirTool] cancelled after path resolution`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			logService.trace(`[ListDirTool] step=readDirectory, uri=${dirUri.fsPath}`);
			const results = await fsService.readDirectory(dirUri);
			logService.trace(`[ListDirTool] step=readDirectory done: ${results.length} entries`);

			// Copilot-matching: check cancellation after I/O
			if (token?.isCancellationRequested) {
				logService.warn(`[ListDirTool] cancelled after readDirectory`);
				return { toolCallId: input.toolCallId, content: 'Cancellation requested', success: false };
			}

			const elapsed = Date.now() - startTime;
			logService.info(`[ListDirTool] >>> done: ${results.length} entries in ${elapsed}ms`);

			if (results.length === 0) {
				logService.info(`[ListDirTool] folder is empty`);
				return { toolCallId: input.toolCallId, content: 'Folder is empty', success: true };
			}

			const entries = results
				.map(([name, type]) => type === FileType.Directory ? `${name}/` : name)
				.join('\n');
			logService.trace(`[ListDirTool] >>> success: ${entries.length} chars`);
			return { toolCallId: input.toolCallId, content: entries, success: true };
		} catch (err) {
			const elapsed = Date.now() - startTime;
			logService.error(`[ListDirTool] >>> ERROR after ${elapsed}ms: ${err}`);
			return { toolCallId: input.toolCallId, content: `Error listing directory: ${err}`, success: false };
		}
	};
}
