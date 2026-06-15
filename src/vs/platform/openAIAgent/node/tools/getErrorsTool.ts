/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { defineTool, type ToolExecutor, type ToolInput, type ToolOutput } from './toolRegistry.js';
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

// ---- handler (tool executor) ------------------------------------------------

export function createGetErrorsExecutor(
	logService: ILogService,
): ToolExecutor {
	return async (input: ToolInput): Promise<ToolOutput> => {
		const startTime = Date.now();
		const filePaths = input.parameters.filePaths as string[] | undefined;
		logService.info(`[GetErrorsTool] <<< invoked: toolCallId=${input.toolCallId.substring(0, 8)}`);
		logService.info(`[GetErrorsTool] step=parse_params: filePaths=${filePaths ? `[${filePaths.length} items]` : '(all files)'}`);

		// Placeholder — would query the language service for diagnostics
		const elapsed = Date.now() - startTime;
		logService.warn(`[GetErrorsTool] step=execute FAILED after ${elapsed}ms: not implemented`);
		return { toolCallId: input.toolCallId, content: 'Get errors not yet implemented', success: false };
	};
}
