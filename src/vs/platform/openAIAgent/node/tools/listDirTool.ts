/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * List the contents of a directory.
 *
 * Returns names of children — those ending in "/" are folders.
 * Aligned with Copilot's `list_dir` tool.
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
	fileService: IFileService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		try {
			const dirPath = input.parameters.path as string;
			logService.trace(`[ListDirTool] list_dir: path=${dirPath}`);
			const dirUri = URI.file(dirPath);
			const stat = await fileService.resolve(dirUri);
			if (!stat.children) {
				return { toolCallId: input.toolCallId, content: 'Empty directory', success: true };
			}
			const entries = stat.children.map(c => c.isDirectory ? `${c.name}/` : c.name).join('\n');
			return { toolCallId: input.toolCallId, content: entries, success: true };
		} catch (err) {
			logService.error(`[ListDirTool] list_dir ERROR: ${err}`);
			return { toolCallId: input.toolCallId, content: `Error listing directory: ${err}`, success: false };
		}
	};
}
