/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from './toolRegistry.js';
import { ToolName } from './toolNames.js';

/**
 * Fetch the content of web pages.
 *
 * Aligned with Copilot's `fetch_webpage` tool — takes an array of URLs
 * and an optional query to narrow results.
 */
export const TOOL_FETCH_WEBPAGE = defineTool({
	name: ToolName.FetchWebPage,
	description:
		'Fetch the content of one or more web pages by URL. Provide an optional query to narrow down what content to look for on the page. Useful when you need to look up documentation, APIs, or current information from specific web pages.',
	parameters: {
		type: 'object',
		properties: {
			urls: { type: 'array', items: { type: 'string' }, description: 'The URLs of the web pages to fetch.' },
			query: { type: 'string', description: 'Optional search query to narrow down the content to look for on the page.' },
		},
		required: ['urls'],
	},
	isDestructive: false,
	toolKind: 'search',
});
