/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
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
