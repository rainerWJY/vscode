/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Get compile or lint errors in files or across the workspace.
 *
 * Aligned with Copilot's `get_errors` tool — takes an array of file paths
 * and optional ranges. Empty array returns no errors; absence returns all.
 */
export const TOOL_GET_ERRORS = defineTool({
	name: ToolName.GetErrors,
	description:
		'Get compile or lint errors in one or more specific files, or across all files if omitted. Useful for diagnosing build failures and type errors.',
	parameters: {
		type: 'object',
		properties: {
			filePaths: { type: 'array', items: { type: 'string' }, description: 'Optional: absolute paths of specific files to check. Empty array returns no errors; if omitted, returns all errors.' },
		},
		required: [],
	},
	isDestructive: false,
	toolKind: 'search',
});
