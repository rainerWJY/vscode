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
 * View the contents of an image file.
 *
 * New tool — aligned with Copilot's `view_image` tool.
 * Allows the model to inspect images (screenshots, diagrams, etc.).
 */
export const TOOL_VIEW_IMAGE = defineTool({
	name: ToolName.ViewImage,
	description:
		'View the contents of an image file. Use this to inspect screenshots, diagrams, or other image files in the workspace.',
	parameters: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'The absolute path of the image file to view.' },
		},
		required: ['filePath'],
	},
	isDestructive: false,
	toolKind: 'read',
});

// ---- handler (tool executor) ------------------------------------------------

export function createViewImageExecutor(
	fileService: IFileService,
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		try {
			const filePath = input.parameters.filePath as string;
			logService.trace(`[ViewImageTool] view_image: path=${filePath}`);
			const fileUri = URI.file(filePath);
			const content = await fileService.readFile(fileUri);
			const text = content.value.toString();
			return { toolCallId: input.toolCallId, content: text, success: true };
		} catch (err) {
			logService.error(`[ViewImageTool] view_image ERROR: ${err}`);
			return { toolCallId: input.toolCallId, content: `Error reading image: ${err}`, success: false };
		}
	};
}
