/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tryParsePartialJson } from '../../node/openAIApiClient.js';

// ==============================================================================
// Suite: tryParsePartialJson
// ==============================================================================

suite('tryParsePartialJson', () => {

	// ---- fully-formed JSON ------------------------------------------------

	test('should parse fully-formed JSON object', () => {
		const result = tryParsePartialJson(JSON.stringify({ filePath: '/a/b.ts', content: 'hello' }));
		assert.deepStrictEqual(result, { filePath: '/a/b.ts', content: 'hello' });
	});

	test('should return undefined for empty string', () => {
		assert.strictEqual(tryParsePartialJson(''), undefined);
	});

	test('should return undefined for null/undefined', () => {
		assert.strictEqual(tryParsePartialJson(undefined as any), undefined);
		assert.strictEqual(tryParsePartialJson(null as any), undefined);
	});

	// ---- incrementally streaming tool-call arguments ----------------------

	test('should parse partial object with first key complete', () => {
		const result = tryParsePartialJson(`{"filePath":"/a/b.ts"`);
		assert.ok(result);
		assert.strictEqual(result!.filePath, '/a/b.ts');
	});

	test('should parse partial object with two keys', () => {
		const result = tryParsePartialJson(`{"filePath":"/a/b.ts","content":"hel`);
		assert.ok(result);
		assert.strictEqual(result!.filePath, '/a/b.ts');
		assert.strictEqual(result!.content, 'hel');
	});

	test('should parse complete two-key object', () => {
		const result = tryParsePartialJson(`{"filePath":"/a/b.ts","content":"hello world"`);
		assert.ok(result);
		assert.strictEqual(result!.filePath, '/a/b.ts');
		assert.strictEqual(result!.content, 'hello world');
	});

	test('should handle nested partial objects', () => {
		const result = tryParsePartialJson(`{"replacements":[{"filePath":"/a.ts","oldString":"foo"`);
		assert.ok(result);
		assert.ok(Array.isArray(result!.replacements));
		assert.strictEqual(result!.replacements[0].filePath, '/a.ts');
		assert.strictEqual(result!.replacements[0].oldString, 'foo');
	});

	test('should handle numeric values', () => {
		const result = tryParsePartialJson(`{"maxResults":10,"query":"test`);
		assert.ok(result);
		assert.strictEqual(result!.maxResults, 10);
		assert.strictEqual(result!.query, 'test');
	});

	test('should handle boolean values', () => {
		const result = tryParsePartialJson(`{"isRegexp":true,"include`);
		assert.ok(result);
		assert.strictEqual(result!.isRegexp, true);
	});

	test('should handle null value', () => {
		const result = tryParsePartialJson(`{"something":null,"other`);
		assert.ok(result);
		assert.strictEqual(result!.something, null);
	});

	// ---- edge cases ------------------------------------------------------

	test('should handle trailing escaped backslash', () => {
		const result = tryParsePartialJson(`{"content":"hello\\\\`);
		assert.ok(result);
		assert.strictEqual(result!.content, 'hello\\');
	});

	test('should handle single-quoted strings', () => {
		const result = tryParsePartialJson(`{'filePath':'/a/b.ts','content':'hello`);
		assert.ok(result);
		assert.strictEqual(result!.filePath, '/a/b.ts');
		assert.strictEqual(result!.content, 'hello');
	});

	test('should return undefined for plain text (not JSON)', () => {
		assert.strictEqual(tryParsePartialJson('Hello world'), undefined);
	});

	test('should return undefined for non-object JSON (string)', () => {
		assert.strictEqual(tryParsePartialJson('"just a string"'), undefined);
	});

	test('should return undefined for non-object JSON (array)', () => {
		assert.strictEqual(tryParsePartialJson('[1,2,3]'), undefined);
	});

	// ---- DeepSeek real-world chunk patterns ------------------------------

	test('DeepSeek first chunk: id and tool index only', () => {
		const result = tryParsePartialJson(`{"id":"call_abc123","type":"function","index":0`);
		assert.ok(result);
		assert.strictEqual(result!.id, 'call_abc123');
		assert.strictEqual(result!.index, 0);
	});

	test('DeepSeek mid-stream: arguments streaming in', () => {
		const result = tryParsePartialJson('{"filePath":"/Users/test/src/main.ts","prompt":"Search in the codebase for classes related"');
		assert.ok(result);
		assert.strictEqual(result!.filePath, '/Users/test/src/main.ts');
		assert.ok((result!.prompt as string).startsWith('Search in the codebase'));
	});
});
