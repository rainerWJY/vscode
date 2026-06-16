/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * File editing utilities for the agent host.
 *
 * Ported from Copilot's `editFileToolUtils.tsx` — provides the same 4-tier
 * string matching engine (`findAndReplaceOne`) without VS Code editor
 * dependencies (no `TextEdit`, `Position`, `WorkspaceEdit`, etc.).
 *
 * Matching strategies (same as Copilot):
 * 1. **Exact** — fastest path, direct indexOf
 * 2. **Whitespace-flexible** — trim lines before comparing
 * 3. **Fuzzy** — regex-based per-line matching with trailing whitespace allowance
 * 4. **Similarity** — Levenshtein-based sliding window (95% threshold default)
 */

// ---- types ------------------------------------------------------------------

interface EditPosition {
	start: number;
	end: number;
	text: string;
}

interface MatchResultCommon {
	type: string;
	text: string;
	editPosition: EditPosition[];
	suggestion?: string;
}

type MatchResult = MatchResultCommon & (
	| { text: string; type: 'none'; suggestion?: string }
	| { text: string; type: 'exact' }
	| { text: string; type: 'fuzzy' }
	| { text: string; type: 'whitespace' }
	| { text: string; type: 'similarity'; suggestion: string; similarity: number }
	| { text: string; type: 'multiple'; suggestion: string; matchPositions: number[]; strategy: 'exact' | 'fuzzy' | 'whitespace' }
);

// ---- error types (matching Copilot's EditError hierarchy) -------------------

export class EditError extends Error {
	constructor(message: string, public readonly kindForTelemetry: string) {
		super(message);
	}
}

export class NoMatchError extends EditError {
	constructor(message: string) {
		super(message, 'noMatchFound');
	}
}

export class MultipleMatchesError extends EditError {
	constructor(message: string) {
		super(message, 'multipleMatchesFound');
	}
}

export class NoChangeError extends EditError {
	constructor(message: string) {
		super(message, 'noChange');
	}
}

// ---- 4-tier matching engine -------------------------------------------------

/**
 * Port of Copilot's `findAndReplaceOne` with the same 4-tier matching strategy.
 *
 * @param text The source text to search in
 * @param oldStr The string to find and replace
 * @param newStr The replacement string
 * @param eol The end-of-line sequence to use
 * @returns MatchResult with replaced text and match info
 */
export function findAndReplaceOne(
	text: string,
	oldStr: string,
	newStr: string,
	eol: string,
): MatchResult {
	// Strategy 1: Exact match (fastest)
	const exactResult = tryExactMatch(text, oldStr, newStr);
	if (exactResult.type !== 'none') {
		return exactResult;
	}

	// Strategy 2: Whitespace-flexible
	const whitespaceResult = tryWhitespaceFlexibleMatch(text, oldStr, newStr, eol);
	if (whitespaceResult.type !== 'none') {
		return whitespaceResult;
	}

	// Strategy 3: Line-by-line fuzzy
	const fuzzyResult = tryFuzzyMatch(text, oldStr, newStr, eol);
	if (fuzzyResult.type !== 'none') {
		return fuzzyResult;
	}

	// Strategy 4: Similarity-based (last resort)
	const similarityResult = trySimilarityMatch(text, oldStr, newStr, eol);
	if (similarityResult.type !== 'none') {
		return similarityResult;
	}

	return {
		text,
		type: 'none',
		editPosition: [],
		suggestion: 'Try making your search string more specific or checking for whitespace/formatting differences.',
	};
}

// ---- Strategy 1: Exact ------------------------------------------------------

function tryExactMatch(text: string, oldStr: string, newStr: string): MatchResult {
	const matchPositions: number[] = [];
	for (let searchIdx = 0; ;) {
		const idx = text.indexOf(oldStr, searchIdx);
		if (idx === -1) { break; }
		matchPositions.push(idx);
		searchIdx = idx + oldStr.length;
	}

	if (matchPositions.length === 0) {
		return { text, editPosition: [], type: 'none' };
	}

	const identical = getIdenticalChars(oldStr, newStr);
	const editPosition = matchPositions.map(idx => ({
		start: idx + identical.leading,
		end: idx + oldStr.length - identical.trailing,
		text: newStr.slice(identical.leading, newStr.length - identical.trailing),
	}));

	if (matchPositions.length > 1) {
		return {
			text,
			type: 'multiple',
			editPosition,
			strategy: 'exact' as const,
			matchPositions,
			suggestion: 'Multiple exact matches found. Make your search string more specific.',
		};
	}

	const firstIdx = matchPositions[0];
	const replaced = text.slice(0, firstIdx) + newStr + text.slice(firstIdx + oldStr.length);
	return { text: replaced, type: 'exact', editPosition };
}

// ---- Strategy 2: Whitespace-flexible ----------------------------------------

function tryWhitespaceFlexibleMatch(text: string, oldStr: string, newStr: string, eol: string): MatchResult {
	const haystack = text.split(eol).map(line => line.trim());
	const oldLines = oldStr.trim().split(eol);
	const needle = oldLines.map(line => line.trim());
	needle.push(''); // trailing newline marker

	const matchedLines: number[] = [];
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		if (haystack.slice(i, i + needle.length).join('\n') === needle.join('\n')) {
			matchedLines.push(i);
			i += needle.length - 1;
		}
	}

	if (matchedLines.length === 0) {
		return { text, editPosition: [], type: 'none', suggestion: 'No whitespace-flexible match found.' };
	}

	const newLines = newStr.trim().split(eol);
	const identical = getIndenticalLines(oldLines, newLines);
	const allLines = text.split(eol);

	// Build offset tracking manually (equivalent to OffsetLineColumnConverter)
	const lineToOffset = buildLineOffsetMap(allLines, eol);

	if (matchedLines.length > 1) {
		return {
			text,
			type: 'multiple',
			editPosition: [],
			matchPositions: matchedLines.map(l => lineToOffset[l + identical.leading]),
			suggestion: 'Multiple matches found with flexible whitespace. Make your search string more unique.',
			strategy: 'whitespace' as const,
		};
	}

	const matchLine = matchedLines[0];
	const startLine = matchLine + identical.leading;
	const endLine = matchLine + oldLines.length - identical.trailing;
	const startIdx = lineToOffset[startLine];
	const endIdx = lineToOffset[endLine] - eol.length; // -1 eol

	const minimizedNewStr = newLines.slice(identical.leading, newLines.length - identical.trailing).join(eol);
	const replaced = text.slice(0, startIdx) + minimizedNewStr + text.slice(endIdx);

	return {
		text: replaced,
		editPosition: [{ start: startIdx, end: endIdx, text: minimizedNewStr }],
		type: 'whitespace',
	};
}

// ---- Strategy 3: Fuzzy ------------------------------------------------------

function tryFuzzyMatch(text: string, oldStr: string, newStr: string, eol: string): MatchResult {
	const hasTrailingLF = oldStr.endsWith(eol);
	const searchStr = hasTrailingLF ? oldStr.slice(0, -eol.length) : oldStr;
	const oldLines = searchStr.split(eol);

	const pattern = oldLines
		.map((line, i) => {
			const escaped = escapeRegex(line);
			return i < oldLines.length - 1 || hasTrailingLF
				? `${escaped}[ \\t]*\\r?\\n`
				: `${escaped}[ \\t]*`;
		})
		.join('');
	const regex = new RegExp(pattern, 'g');

	const matches = Array.from(text.matchAll(regex));
	if (matches.length === 0) {
		return { text, editPosition: [], type: 'none', suggestion: 'No fuzzy match found.' };
	}

	if (matches.length > 1) {
		return {
			text,
			type: 'multiple',
			editPosition: [],
			suggestion: 'Multiple fuzzy matches found. Try including more context in your search string.',
			strategy: 'fuzzy' as const,
			matchPositions: matches.map(m => m.index || 0),
		};
	}

	const match = matches[0];
	const startIdx = match.index || 0;
	const endIdx = startIdx + match[0].length;
	const replaced = text.slice(0, startIdx) + newStr + text.slice(endIdx);

	return {
		text: replaced,
		type: 'fuzzy',
		editPosition: [{ start: startIdx, end: endIdx, text: newStr }],
	};
}

// ---- Strategy 4: Similarity -------------------------------------------------

let defaultSimilaryMatchThreshold = 0.95;

export function setSimilarityMatchThresholdForTests(threshold: number): number {
	const old = defaultSimilaryMatchThreshold;
	defaultSimilaryMatchThreshold = threshold;
	return old;
}

function trySimilarityMatch(text: string, oldStr: string, newStr: string, eol: string, threshold: number = defaultSimilaryMatchThreshold): MatchResult {
	if (oldStr.length > 1000 || oldStr.split(eol).length > 20) {
		return { text, editPosition: [], type: 'none' };
	}

	const lines = text.split(eol);
	const oldLines = oldStr.split(eol);

	if (lines.length > 1000) {
		return { text, editPosition: [], type: 'none' };
	}

	const newLines = newStr.split(eol);
	const identical = getIndenticalLines(oldLines, newLines);

	let bestMatch = { startLine: -1, startOffset: 0, oldLength: 0, similarity: 0 };
	let startOffset = 0;

	for (let i = 0; i <= lines.length - oldLines.length; i++) {
		let totalSimilarity = 0;
		let oldLength = 0;
		let startOffsetIdenticalIncr = 0;
		let endOffsetIdenticalIncr = 0;

		for (let j = 0; j < oldLines.length; j++) {
			const similarity = calculateSimilarity(oldLines[j], lines[i + j]);
			totalSimilarity += similarity;
			oldLength += lines[i + j].length;

			if (j < identical.leading) {
				startOffsetIdenticalIncr += lines[i + j].length + eol.length;
			}
			if (j >= oldLines.length - identical.trailing) {
				endOffsetIdenticalIncr += lines[i + j].length + eol.length;
			}
		}

		const avgSimilarity = totalSimilarity / oldLines.length;
		if (avgSimilarity > threshold && avgSimilarity > bestMatch.similarity) {
			bestMatch = {
				startLine: i + identical.leading,
				startOffset: startOffset + startOffsetIdenticalIncr,
				similarity: avgSimilarity,
				oldLength: oldLength + (oldLines.length - 1) * eol.length - startOffsetIdenticalIncr - endOffsetIdenticalIncr,
			};
		}

		startOffset += lines[i].length + eol.length;
	}

	if (bestMatch.startLine === -1) {
		return { text, editPosition: [], type: 'none' };
	}

	const newStrMinimized = newLines.slice(identical.leading, newLines.length - identical.trailing).join(eol);
	const afterIdx = bestMatch.startLine - identical.leading + oldLines.length - identical.trailing;

	const newText = [
		...lines.slice(0, bestMatch.startLine),
		...newLines.slice(identical.leading, newLines.length - identical.trailing),
		...lines.slice(afterIdx),
	].join(eol);

	return {
		text: newText,
		type: 'similarity',
		editPosition: [{
			start: bestMatch.startOffset,
			end: bestMatch.startOffset + bestMatch.oldLength,
			text: newStrMinimized,
		}],
		similarity: bestMatch.similarity,
		suggestion: `Used similarity matching (${(bestMatch.similarity * 100).toFixed(1)}% similar). Verify the replacement.`,
	};
}

// ---- helper functions -------------------------------------------------------

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function calculateSimilarity(str1: string, str2: string): number {
	if (str1 === str2) { return 1.0; }
	if (str1.length === 0 || str2.length === 0) { return 0.0; }

	const matrix: number[][] = [];
	for (let i = 0; i <= str1.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= str2.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= str1.length; i++) {
		for (let j = 1; j <= str2.length; j++) {
			const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,
				matrix[i][j - 1] + 1,
				matrix[i - 1][j - 1] + cost,
			);
		}
	}

	const distance = matrix[str1.length][str2.length];
	const maxLength = Math.max(str1.length, str2.length);
	return 1 - distance / maxLength;
}

function getIndenticalLines(a: string[], b: string[]): { leading: number; trailing: number } {
	let leading = 0;
	while (leading < a.length && leading < b.length && a[leading] === b[leading]) {
		leading++;
	}
	let trailing = 0;
	while (trailing + leading < a.length && trailing + leading < b.length &&
		a[a.length - 1 - trailing] === b[b.length - 1 - trailing]) {
		trailing++;
	}
	return { leading, trailing };
}

function getIdenticalChars(oldString: string, newString: string): { leading: number; trailing: number } {
	let leading = 0;
	while (leading < oldString.length && leading < newString.length && oldString[leading] === newString[leading]) {
		leading++;
	}
	let trailing = 0;
	while (trailing + leading < oldString.length && trailing + leading < newString.length &&
		oldString[oldString.length - trailing - 1] === newString[newString.length - trailing - 1]) {
		trailing++;
	}
	return { leading, trailing };
}

/** Build a line→offset map (equivalent to OffsetLineColumnConverter for whitespace matching). */
function buildLineOffsetMap(lines: string[], eol: string): number[] {
	const offsets: number[] = [0];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		offset += lines[i].length + eol.length;
		offsets.push(offset);
	}
	return offsets;
}

/**
 * Strips a leading `filepath:` marker comment that the model may have prefixed
 * to the oldString/newString.
 *
 * Models sometimes output:
 * ```
 * // filepath: src/index.js
 * const x = 1;
 * ```
 * instead of just `const x = 1;`.
 *
 * Aligned with Copilot's `removeLeadingFilepathComment()` in
 * `extensions/copilot/src/util/common/markdown.ts`.
 *
 * Checks for the `filepath:` marker with common single-line comment syntaxes:
 * `//`, `#`, `--`, `;`, `<!--`.
 */
export function removeLeadingFilepathComment(codeblock: string): string {
	const firstLineEnd = codeblock.indexOf('\n');
	if (firstLineEnd === -1) {
		return codeblock;
	}

	const firstLine = codeblock.substring(0, firstLineEnd);
	const rest = codeblock.substring(firstLineEnd + 1);

	// Match `filepath:` marker with common comment syntaxes
	//   // filepath: src/index.js
	//   # filepath: path/to/file.py
	//   -- filepath: src/lib.rs
	//   ; filepath: src/core.clj
	//   <!-- filepath: src/component.html
	const filepathMarkerRE = /^(?:\/\/|#|--|;|<!--)\s+filepath:\s+\S+\s*(?:-->)?\s*$/;
	if (filepathMarkerRE.test(firstLine)) {
		return rest;
	}

	return codeblock;
}

// ---- applyEdit: high-level file editing function ----------------------------

export interface ApplyEditResult {
	updatedFile: string;
	success: boolean;
	errorMessage?: string;
	matchType?: string;
	suggestion?: string;
}

/**
 * Apply a string replacement to a file's content.
 * Uses the same 4-tier matching and edge-case handling as Copilot's `applyEdit`.
 *
 * Aligned with `extensions/copilot/src/extension/tools/node/editFileToolUtils.tsx`.
 *
 * Edge cases (matching Copilot):
 * 1. Empty file + empty oldString → set content
 * 2. oldString is empty + file has content → **error** (Copilot rejects overwriting via empty oldString)
 * 3. newString is empty + exact match fails → try with trailing newline (Copilot fallback)
 * 4. After replacement, if content unchanged → NoChangeError
 * 5. EOL normalization: oldString/newString converted to file's EOL
 *
 * @param originalContent The full text content of the file
 * @param oldString The string to find
 * @param newString The replacement string
 * @returns ApplyEditResult with the updated content
 */
export function applyStringEdit(
	originalContent: string,
	oldString: string,
	newString: string,
): ApplyEditResult {
	const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';

	// Normalize EOL to match the document (matching Copilot's applyEdit)
	oldString = oldString.replace(/\r?\n/g, eol);
	newString = newString.replace(/\r?\n/g, eol);

	// Case 1: Empty file + empty oldString — set content (matching Copilot)
	if (!originalContent.trim() && !oldString.trim()) {
		return { updatedFile: newString, success: true, matchType: 'exact' };
	}

	// Case 2: oldString is empty but file has content — error (matching Copilot)
	if (!oldString && originalContent.trim()) {
		return {
			updatedFile: originalContent,
			success: false,
			errorMessage: 'File already exists. Please provide a non-empty oldString for replacement.',
		};
	}

	// Case 3: oldString is empty and file is empty — set content
	if (!oldString && !originalContent.trim()) {
		return { updatedFile: newString, success: true, matchType: 'exact' };
	}

	// Case 4: Normal replacement via 4-tier matching engine
	const result = findAndReplaceOne(originalContent, oldString, newString, eol);

	if (result.type === 'none') {
		// Copilot fallback: when newString is empty and oldString doesn't end with eol,
		// try matching oldString + eol (the file may have a trailing newline)
		if (newString === '' && !oldString.endsWith(eol) && originalContent.includes(oldString + eol)) {
			const updatedFile = originalContent.replace(oldString + eol, '');
			return { updatedFile, success: true, matchType: 'exact' };
		}
		return {
			updatedFile: originalContent,
			success: false,
			errorMessage: `Could not find matching text to replace. ${result.suggestion || 'The string to replace must match exactly.'}`,
		};
	}

	if (result.type === 'multiple') {
		return {
			updatedFile: originalContent,
			success: false,
			errorMessage: `Multiple matches found for the text to replace. ${result.suggestion || 'Please provide a more specific string.'}`,
		};
	}

	// Case 5: After replacement, check for no-change (matching Copilot's NoChangeError)
	if (result.text === originalContent) {
		return {
			updatedFile: originalContent,
			success: false,
			errorMessage: 'Original and edited file match exactly. Failed to apply edit. Use the read_file tool to re-read the file and determine the correct edit.',
		};
	}

	return { updatedFile: result.text, success: true, matchType: result.type, suggestion: result.suggestion };
}

/**
 * Normalize EOL characters in the given content to match the target EOL.
 */
export function normalizeEol(content: string, targetEol: string): string {
	return content.replace(/\r?\n/g, targetEol);
}
