/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { findAndReplaceOne, applyStringEdit, removeLeadingFilepathComment, normalizeEol, setSimilarityMatchThresholdForTests } from '../../../node/tools/editFileUtils.js';

// ---- suite: findAndReplaceOne (matching engine) ----------------------------

suite('editFileUtils', () => {

	suite('findAndReplaceOne', () => {

		// --- exact match ---

		test('exact match - single occurrence', () => {
			const result = findAndReplaceOne('function hello() {\n\tconsole.log("world");\n}', 'console.log("world");', 'console.log("hello world");', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'function hello() {\n\tconsole.log("hello world");\n}');
		});

		test('exact match - with newlines', () => {
			const result = findAndReplaceOne('line1\nline2\nline3', 'line1\nline2', 'newline1\nnewline2', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'newline1\nnewline2\nline3');
		});

		test('multiple exact matches - returns multiple type', () => {
			const result = findAndReplaceOne('test\ntest\nother', 'test', 'replacement', '\n');
			assert.strictEqual(result.type, 'multiple');
		});

		// --- whitespace-flexible matching ---

		test('whitespace-flexible matching - trailing spaces', () => {
			const result = findAndReplaceOne('line1   \nline2\nline3', 'line1\nline2', 'newline1\nnewline2', '\n');
			assert.ok(result.type === 'whitespace' || result.type === 'fuzzy', `Expected whitespace or fuzzy, got ${result.type}`);
			assert.ok(result.text.includes('newline1'));
			assert.ok(result.text.includes('newline2'));
		});

		test('whitespace-flexible matching - different indentation with trailing empty line', () => {
			const text = 'function test() {\n  \tconsole.log("hello");\n\treturn true;\n\n}';
			const result = findAndReplaceOne(text, 'console.log("hello");\nreturn true;\n', 'console.log("updated");\nreturn false;\n', '\n');
			assert.ok(result.text.includes('console.log("updated");'));
			assert.ok(result.text.includes('return false;'));
		});

		// --- fuzzy matching ---

		test('fuzzy matching - trailing whitespace variations', () => {
			const result = findAndReplaceOne('if (condition) {\n\treturn true; \n}', 'if (condition) {\n\treturn true;\n}', 'if (condition) {\n\treturn false;\n}', '\n');
			assert.strictEqual(result.type, 'fuzzy');
			assert.ok(result.text.includes('return false;'));
		});

		test('fuzzy matching - allows trailing spaces on each line', () => {
			const result = findAndReplaceOne('line1   \nline2  \nline3', 'line1\nline2\nline3', 'new1\nnew2\nnew3', '\n');
			assert.ok(result.text.includes('new1'));
			assert.ok(result.text.includes('new2'));
		});

		// --- similarity matching ---

		test('similarity matching - highly similar content', () => {
			const text = 'function calculateTotal(items) {\n\tlet sum = 0;\n\tfor (let i = 0; i < items.length; i++) {\n\t\tsum += items[i].price;\n\t}\n\treturn sum;\n}';
			// Search with slight difference (missing 's' in 'items') to force similarity match
			const result = findAndReplaceOne(text, 'function calculateTotal(item) {\n\tlet sum = 0;\n\tfor (let i = 0; i < items.length; i++) {\n\t\tsum += items[i].price;\n\t}\n\treturn sum;\n}', 'function calculateTotal(items) {\n\treturn items.reduce((sum, item) => sum + item.price, 0);\n}', '\n');
			assert.ok(result.type === 'similarity' || result.type === 'exact' || result.type === 'fuzzy', `Expected match, got ${result.type}`);
		});

		test('similarity matching with small typos', () => {
			const text = 'const message = "Hello, World!";\nconsole.log(message);';
			const result = findAndReplaceOne(text, 'const mesage = "Hello, World!";\nconsole.log(message);', 'const greeting = "Hi there!";\nconsole.log(greeting);', '\n');
			assert.ok(result.type === 'similarity' || result.type === 'exact' || result.type === 'fuzzy');
		});

		// --- no match ---

		test('no match found', () => {
			const result = findAndReplaceOne('some text here', 'nonexistent', 'replacement', '\n');
			assert.strictEqual(result.type, 'none');
		});

		test('case sensitive matching', () => {
			const result = findAndReplaceOne('Hello World', 'hello world', 'Hi World', '\n');
			assert.strictEqual(result.type, 'none');
		});

		// --- edge cases ---

		test('special regex characters in search string', () => {
			const result = findAndReplaceOne('price is $10.99 (discount)', '$10.99 (discount)', '$9.99 (sale)', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'price is $9.99 (sale)');
		});

		test('unicode characters', () => {
			const result = findAndReplaceOne('Hello 世界! 🌍', '世界! 🌍', '世界! 🌎', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'Hello 世界! 🌎');
		});

		test('very long strings', () => {
			const longText = 'a'.repeat(1000) + 'middle' + 'b'.repeat(1000);
			const result = findAndReplaceOne(longText, 'middle', 'CENTER', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'a'.repeat(1000) + 'CENTER' + 'b'.repeat(1000));
		});

		test('single character replacement', () => {
			const result = findAndReplaceOne('hello unique', 'unique', 'special', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'hello special');
		});

		test('multiple single character matches', () => {
			const result = findAndReplaceOne('hello world', 'l', 'L', '\n');
			assert.strictEqual(result.type, 'multiple');
		});

		test('replacement with same length', () => {
			const result = findAndReplaceOne('old text here', 'old', 'new', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'new text here');
		});

		test('replacement with longer text', () => {
			const result = findAndReplaceOne('short', 'short', 'much longer text', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'much longer text');
		});

		test('beginning of file replacement', () => {
			const result = findAndReplaceOne('start of file\nrest of content', 'start of file', 'beginning', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'beginning\nrest of content');
		});

		test('end of file replacement', () => {
			const result = findAndReplaceOne('content here\nend of file', 'end of file', 'conclusion', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'content here\nconclusion');
		});

		test('tab character replacement', () => {
			const result = findAndReplaceOne('before\tafter', '\t', '    ', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'before    after');
		});

		test('multiple spaces preservation', () => {
			const result = findAndReplaceOne('word1     word2', 'word1     word2', 'word1 word2', '\n');
			assert.strictEqual(result.type, 'exact');
			assert.strictEqual(result.text, 'word1 word2');
		});

		test('similarity matching with custom threshold', () => {
			const prev = setSimilarityMatchThresholdForTests(0.6);
			try {
				const text = 'aaa\nbbb\nccc';
				const result = findAndReplaceOne(text, 'xxx\nyyy\nzzz', 'new1\nnew2\nnew3', '\n');
				assert.strictEqual(result.type, 'none'); // too dissimilar even at 60%
			} finally {
				setSimilarityMatchThresholdForTests(prev);
			}
		});

		test('empty oldString handled safely', () => {
			const result = findAndReplaceOne('content', '', 'new', '\n');
			assert.strictEqual(result.type, 'none');
		});
	});

	// ---- suite: applyStringEdit ------------------------------------------------

	suite('applyStringEdit', () => {

		test('simple verbatim replacement', () => {
			const result = applyStringEdit('this is an oldString!', 'oldString', 'newString');
			assert.ok(result.success);
			assert.strictEqual(result.updatedFile, 'this is an newString!');
		});

		test('empty file + empty oldString = set content', () => {
			const result = applyStringEdit('', '', 'new content');
			assert.ok(result.success);
			assert.strictEqual(result.updatedFile, 'new content');
		});

		test('empty oldString on existing file - returns error', () => {
			const result = applyStringEdit('existing content', '', 'new content');
			assert.strictEqual(result.success, false);
			assert.ok(result.errorMessage?.includes('already exists'));
		});

		test('delete text - empty new string', () => {
			const result = applyStringEdit('before\nto delete\nafter', 'to delete\n', '');
			assert.ok(result.success);
			assert.strictEqual(result.updatedFile, 'before\nafter');
		});

		test('no change - identical strings returns error', () => {
			const result = applyStringEdit('unchanged text', 'unchanged text', 'unchanged text');
			assert.strictEqual(result.success, false);
			assert.ok(result.errorMessage?.includes('match exactly'));
		});

		test('replace entire content', () => {
			const result = applyStringEdit('old content\nwith multiple lines', 'old content\nwith multiple lines', 'completely new content');
			assert.ok(result.success);
			assert.strictEqual(result.updatedFile, 'completely new content');
		});

		test('replace with multiline content', () => {
			const result = applyStringEdit('single line', 'single line', 'line1\nline2\nline3');
			assert.ok(result.success);
			assert.strictEqual(result.updatedFile, 'line1\nline2\nline3');
		});

		test('no match found', () => {
			const result = applyStringEdit('some text here', 'nonexistent', 'replacement');
			assert.strictEqual(result.success, false);
			assert.ok(result.errorMessage?.includes('Could not find'));
		});

		test('multiple matches found', () => {
			const result = applyStringEdit('same\nsame\nother', 'same', 'different');
			assert.strictEqual(result.success, false);
			assert.ok(result.errorMessage?.includes('Multiple'));
		});

		test('CRLF EOL normalization', () => {
			const result = applyStringEdit('line1\r\nline2\r\nline3', 'line1\nline2', 'new1\nnew2');
			assert.ok(result.success);
			assert.strictEqual(result.updatedFile, 'new1\r\nnew2\r\nline3');
		});

		test('trailing newline fallback for deletion', () => {
			// When oldString doesn't end with eol but file has it
			const result = applyStringEdit('foo\nbar', 'foo', '');
			assert.ok(result.success, `Expected success but got error: ${result.errorMessage}`);
			// The match may succeed via exact match (foo\n -> empty)
			assert.ok(result.updatedFile === 'bar' || result.updatedFile === '\nbar' || result.updatedFile === 'bar\n');
		});

		test('matchType reported correctly for exact match', () => {
			const result = applyStringEdit('hello world', 'world', 'there');
			assert.ok(result.success);
			assert.strictEqual(result.matchType, 'exact');
		});

		test('part of line replacement', () => {
			const result = applyStringEdit('const name = "old value";', '"old value"', '"new value"');
			assert.ok(result.success);
			assert.strictEqual(result.updatedFile, 'const name = "new value";');
		});

		test('empty file with empty replacement', () => {
			const result = applyStringEdit('', '', '');
			assert.ok(result.success);
			assert.strictEqual(result.updatedFile, '');
		});
	});

	// ---- suite: removeLeadingFilepathComment -----------------------------------

	suite('removeLeadingFilepathComment', () => {

		test('strips // filepath: marker', () => {
			const result = removeLeadingFilepathComment('// filepath: src/index.js\nconst x = 1;');
			assert.strictEqual(result, 'const x = 1;');
		});

		test('strips # filepath: marker', () => {
			const result = removeLeadingFilepathComment('# filepath: path/to/file.py\nimport os');
			assert.strictEqual(result, 'import os');
		});

		test('strips -- filepath: marker', () => {
			const result = removeLeadingFilepathComment('-- filepath: src/lib.rs\nfn main()');
			assert.strictEqual(result, 'fn main()');
		});

		test('strips ; filepath: marker', () => {
			const result = removeLeadingFilepathComment('; filepath: src/core.clj\n(defn foo [])');
			assert.strictEqual(result, '(defn foo [])');
		});

		test('strips <!-- filepath: marker -->', () => {
			const result = removeLeadingFilepathComment('<!-- filepath: src/component.html -->\n<html>');
			assert.strictEqual(result, '<html>');
		});

		test('does not strip plain comments without filepath:', () => {
			const code = '// just a comment\nconst x = 1;';
			const result = removeLeadingFilepathComment(code);
			assert.strictEqual(result, code);
		});

		test('does not strip if no filepath: marker', () => {
			const code = 'const x = 1;';
			const result = removeLeadingFilepathComment(code);
			assert.strictEqual(result, code);
		});

		test('handles single line without newline', () => {
			const code = 'const x = 1;';
			const result = removeLeadingFilepathComment(code);
			assert.strictEqual(result, code);
		});
	});

	// ---- suite: normalizeEol ---------------------------------------------------

	suite('normalizeEol', () => {

		test('converts CRLF to LF', () => {
			const result = normalizeEol('line1\r\nline2\r\nline3', '\n');
			assert.strictEqual(result, 'line1\nline2\nline3');
		});

		test('converts LF to CRLF', () => {
			const result = normalizeEol('line1\nline2\nline3', '\r\n');
			assert.strictEqual(result, 'line1\r\nline2\r\nline3');
		});

		test('preserves LF when target is LF', () => {
			const result = normalizeEol('line1\nline2', '\n');
			assert.strictEqual(result, 'line1\nline2');
		});

		test('handles mixed EOL', () => {
			const result = normalizeEol('line1\r\nline2\nline3', '\n');
			assert.strictEqual(result, 'line1\nline2\nline3');
		});
	});
});
