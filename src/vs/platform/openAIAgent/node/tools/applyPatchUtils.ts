/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Simplified apply_patch parser for the agent host.
 *
 * Supports the same patch format as Copilot's `apply_patch` tool:
 * ```
 * *** Begin Patch
 *
 * *** Add File: <path>
 * + content line 1
 * + content line 2
 *
 * *** Update File: <path>
 * @@ optional context
 * - old line
 * + new line
 *
 * *** Delete File: <path>
 *
 * *** End Patch
 * ```
 *
 * The format is based on OpenAI Codex's `apply_patch.py`.
 * This is a simpler implementation that handles the core format without
 * the full fuzzy-matching heuristics of Copilot's parser.
 */

// ---- constants (same as Copilot's parseApplyPatch.ts) -----------------------

export const PATCH_PREFIX = '*** Begin Patch\n';
export const PATCH_SUFFIX = '\n*** End Patch';
export const ADD_FILE_PREFIX = '*** Add File: ';
export const DELETE_FILE_PREFIX = '*** Delete File: ';
export const UPDATE_FILE_PREFIX = '*** Update File: ';
export const MOVE_FILE_TO_PREFIX = '*** Move to: ';
export const HUNK_ADD_LINE_PREFIX = '+';
export const HUNK_DELETE_LINE_PREFIX = '-';
const CHUNK_DELIMITER = '@@';

// ---- types (same as Copilot's parser.ts) ------------------------------------

export enum ActionType {
	ADD = 'add',
	DELETE = 'delete',
	UPDATE = 'update',
}

export interface FileChange {
	type: ActionType;
	oldContent?: string | null;
	newContent?: string | null;
	movePath?: string | null;
}

export interface Commit {
	changes: Record<string, FileChange>;
}

// ---- format detection -------------------------------------------------------

/**
 * Check if text starts with a valid patch envelope.
 */
export function isPatchFormat(text: string): boolean {
	return text.startsWith(PATCH_PREFIX) && text.includes(PATCH_SUFFIX);
}

// ---- parser -----------------------------------------------------------------

/**
 * Parses a patch text into a Commit object that can be applied.
 *
 * @param patchText The full patch text including Begin/End Patch markers.
 * @param existingFiles Optional map of existing file paths → their content.
 *                      Used to verify that Update/Delete targets exist.
 * @returns Commit with changes to apply.
 * @throws Error if the patch is malformed.
 */
export function parsePatch(
	patchText: string,
	existingFiles?: ReadonlyMap<string, string>,
): Commit {
	if (!patchText.startsWith(PATCH_PREFIX)) {
		throw new Error('Patch must start with "*** Begin Patch"');
	}

	const suffixIdx = patchText.indexOf(PATCH_SUFFIX);
	if (suffixIdx === -1) {
		throw new Error('Patch must end with "*** End Patch"');
	}

	const body = patchText.slice(PATCH_PREFIX.length, suffixIdx);
	const lines = body.split('\n');
	const changes: Record<string, FileChange> = {};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		if (line.trim() === '' || line === PATCH_SUFFIX.trim()) {
			i++;
			continue;
		}

		if (line.startsWith(UPDATE_FILE_PREFIX)) {
			const filePath = line.slice(UPDATE_FILE_PREFIX.length).trim();
			i++;

			// Check for optional "Move to"
			let movePath: string | undefined;
			if (i < lines.length && lines[i].startsWith(MOVE_FILE_TO_PREFIX)) {
				movePath = lines[i].slice(MOVE_FILE_TO_PREFIX.length).trim();
				i++;
			}

			if (existingFiles && !existingFiles.has(filePath)) {
				throw new Error(`Update File Error: File not found: ${filePath}`);
			}

			const { delLines, insLines } = parseHunks(lines, i);
			i = skipToNextSection(lines, i);

			const oldContent = existingFiles?.get(filePath);
			const newContent = oldContent
				? applyPatchToFile(oldContent, delLines, insLines)
				: insLines.join('\n');

			changes[filePath] = {
				type: ActionType.UPDATE,
				oldContent,
				newContent,
				movePath: movePath || undefined,
			};
			continue;
		}

		if (line.startsWith(ADD_FILE_PREFIX)) {
			const filePath = line.slice(ADD_FILE_PREFIX.length).trim();
			i++;

			if (existingFiles?.has(filePath)) {
				throw new Error(`Add File Error: File already exists: ${filePath}`);
			}

			const contentLines: string[] = [];
			while (i < lines.length) {
				const l = lines[i].trim();
				if (l === '' || l.startsWith('***') || l.startsWith(CHUNK_DELIMITER)) {
					break;
				}
				if (l.startsWith(HUNK_ADD_LINE_PREFIX)) {
					contentLines.push(l.slice(1));
				}
				i++;
			}

			changes[filePath] = {
				type: ActionType.ADD,
				newContent: contentLines.join('\n'),
			};
			continue;
		}

		if (line.startsWith(DELETE_FILE_PREFIX)) {
			const filePath = line.slice(DELETE_FILE_PREFIX.length).trim();
			i++;

			if (existingFiles && !existingFiles.has(filePath)) {
				throw new Error(`Delete File Error: File not found: ${filePath}`);
			}

			changes[filePath] = {
				type: ActionType.DELETE,
				oldContent: existingFiles?.get(filePath),
			};
			continue;
		}

		// Skip unknown lines
		i++;
	}

	return { changes };
}

// ---- hunk parsing -----------------------------------------------------------

interface HunkResult {
	delLines: string[];
	insLines: string[];
}

function parseHunks(lines: string[], startIdx: number): HunkResult {
	const delLines: string[] = [];
	const insLines: string[] = [];
	let i = startIdx;

	while (i < lines.length) {
		const line = lines[i].trim();

		// Stop at next section
		if (line.startsWith('***') || line === PATCH_SUFFIX.trim()) {
			break;
		}

		if (line === '' || line.startsWith(CHUNK_DELIMITER)) {
			i++;
			continue;
		}

		if (line.startsWith(HUNK_DELETE_LINE_PREFIX)) {
			delLines.push(line.slice(1));
			i++;
			continue;
		}

		if (line.startsWith(HUNK_ADD_LINE_PREFIX)) {
			insLines.push(line.slice(1));
			i++;
			continue;
		}

		// Context line (no prefix or space prefix) — skip
		i++;
	}

	return { delLines, insLines };
}

function skipToNextSection(lines: string[], startIdx: number): number {
	let i = startIdx;
	while (i < lines.length) {
		const line = lines[i].trim();
		if (line.startsWith('***') || line === PATCH_SUFFIX.trim()) {
			return i;
		}
		i++;
	}
	return i;
}

// ---- applying changes to a file content ------------------------------------

/**
 * Apply deletion and insertion lines to a file's content.
 *
 * For each pair of delete/insert hunks, removes the matching deletion lines
 * from the file content and inserts the replacement lines at that position.
 *
 * This is simplified compared to Copilot's full fuzzy-context matching:
 * - Finds exact matches of the deletion block in the file
 * - Replaces them with the insertion block
 * - Supports multi-hunk patches (multiple @@ sections)
 */
function applyPatchToFile(
	fileContent: string,
	delLines: string[],
	insLines: string[],
): string {
	if (delLines.length === 0 && insLines.length === 0) {
		return fileContent;
	}

	const eol = fileContent.includes('\r\n') ? '\r\n' : '\n';
	const fileLines = fileContent.split(/\r?\n/);
	let resultLines = [...fileLines];

	// If there are no deletion lines, append at end
	if (delLines.length === 0) {
		if (insLines.length > 0) {
			resultLines.push(...insLines);
		}
		return resultLines.join(eol);
	}

	// Try to find the deletion block in the file
	const delBlock = delLines.join('\n');

	// Strategy 1: Exact block match
	let matchIdx = -1;
	for (let i = 0; i <= fileLines.length - delLines.length; i++) {
		const block = fileLines.slice(i, i + delLines.length).join('\n');
		if (block === delBlock) {
			matchIdx = i;
			break;
		}
	}

	// Strategy 2: Whitespace-flexible line match
	if (matchIdx === -1) {
		const trimmedDelLines = delLines.map(l => l.trim());
		for (let i = 0; i <= fileLines.length - delLines.length; i++) {
			const block = fileLines.slice(i, i + delLines.length).map(l => l.trim());
			if (block.join('\n') === trimmedDelLines.join('\n')) {
				matchIdx = i;
				break;
			}
		}
	}

	if (matchIdx === -1) {
		throw new Error(`Could not find context in file to apply patch. The file may have changed since the patch was generated.`);
	}

	resultLines = [
		...fileLines.slice(0, matchIdx),
		...insLines,
		...fileLines.slice(matchIdx + delLines.length),
	];

	return resultLines.join(eol);
}

// ---- assemble changes from modified files -----------------------------------

/**
 * Convenience: given old content map and new content map, return a Commit.
 * Mirrors Copilot's `assemble_changes()`.
 */
export function assembleChanges(
	orig: Record<string, string | null>,
	updatedFiles: Record<string, string | null>,
): Commit {
	const changes: Record<string, FileChange> = {};
	for (const [path, newContent] of Object.entries(updatedFiles)) {
		const oldContent = orig[path];
		if (oldContent === newContent) {
			continue;
		}
		if (oldContent !== undefined && newContent !== undefined) {
			changes[path] = { type: ActionType.UPDATE, oldContent, newContent };
		} else if (newContent !== undefined) {
			changes[path] = { type: ActionType.ADD, newContent };
		} else if (oldContent !== undefined) {
			changes[path] = { type: ActionType.DELETE, oldContent };
		}
	}
	return { changes };
}
