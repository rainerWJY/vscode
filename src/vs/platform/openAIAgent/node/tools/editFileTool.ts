/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
import { ToolName } from './toolNames.js';
import type { IAgentHostPathService } from '../services/agentHostPathService.js';
import type { IAgentHostIgnoreService } from '../services/agentHostIgnoreService.js';

export const TOOL_EDIT_FILE = defineTool({
	name: ToolName.EditFile,
	description:
		'Edit the contents of a file. Provide the full intended content of the file. ' +
		'Use this to make targeted changes to existing files by replacing the entire file content. ' +
		'This tool will fail if the file does not exist — use create_file to create new files.',
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
	_fileService: IFileService,
	_pathService: IAgentHostPathService,
	_ignoreService: IAgentHostIgnoreService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		logService.info(`[EditFileTool] Not supported yet: toolCallId=${input.toolCallId.substring(0, 8)}`);
		return {
			toolCallId: input.toolCallId,
			content: 'Not supported yet. Use replace_string_in_file or multi_replace_string_in_file instead.',
			success: false,
		};
	};
}
