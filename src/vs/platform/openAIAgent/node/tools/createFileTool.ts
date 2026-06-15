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

/**
 * Creates a new file or overwrites an existing one.
 *
 * Aligned with Copilot's `create_file` tool — `content` is optional;
 * if omitted, the model may generate content through the prompt.
 */
export const TOOL_CREATE_FILE = defineTool({
	name: ToolName.CreateFile,
	description:
		'Create a new file or overwrite an existing one. Provide the full intended content of the file. This tool will overwrite the existing file if there is one at the provided path.',
	parameters: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'The absolute path to the file to create or overwrite.' },
			content: { type: 'string', description: 'The full content to write to the file. If omitted, the model may generate the content through other means.' },
		},
		required: ['filePath'],
	},
	isDestructive: true,
	toolKind: 'edit',
});

// ---- handler (tool executor) ------------------------------------------------

export function createCreateFileExecutor(
	fileService: IFileService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		try {
			const filePath = input.parameters.filePath as string;
			const content = input.parameters.content as string;
			logService.info(`[CreateFileTool] create_file: path=${filePath}, contentLen=${content.length}`);
			const fileUri = URI.file(filePath);
			await fileService.writeFile(fileUri, VSBuffer.fromString(content));
			return { toolCallId: input.toolCallId, content: `File written: ${filePath}`, success: true };
		} catch (err) {
			logService.error(`[CreateFileTool] create_file ERROR: ${err}`);
			return { toolCallId: input.toolCallId, content: `Error writing file: ${err}`, success: false };
		}
	};
}
