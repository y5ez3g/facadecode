/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'node:test';
import { caseIds, coverage, leadingIds, testTitles } from '../facade/acceptance.ts';

suite('facade acceptance ids', () => {

	test('a case is an acceptance table row whose first cell is its id', () => {
		const markdown = [
			'| ID | Level | Setup and action | Required observation |',
			'| --- | --- | --- | --- |',
			'| WS-01 | U, I | Start | Opens |',
			'| WTA-12 | U | Branch names | One folder name |',
			'| ID-03 | H | Look | Seen |',
			'Prose that mentions | WS-99 | in passing is not a case.',
			'| W3.1 | an invariant, not a case |'
		].join('\n');
		assert.deepStrictEqual(caseIds(markdown), ['WS-01', 'WTA-12', 'ID-03']);
	});

	test('the titles of suites and tests, in any quote', () => {
		const source = [
			`suite('Workspace bar', () => {`,
			`	test("WS-17 a hidden file is saved", () => { });`,
			'	test(`WTA-20 only included files`, async () => { });',
			`	test.skip('WS-03 skipped still holds its place', () => { });`,
			`	test('it\\'s escaped', () => { });`,
			`	const title = 'WS-04 not a test';`,
			`});`
		].join('\n');
		assert.deepStrictEqual(testTitles(source), ['Workspace bar', 'WS-17 a hidden file is saved', 'WTA-20 only included files', 'WS-03 skipped still holds its place', `it\\'s escaped`]);
	});

	test('a title holds the ids it begins with, and only those', () => {
		assert.deepStrictEqual(leadingIds('WS-17 a hidden file is saved'), ['WS-17']);
		assert.deepStrictEqual(leadingIds('WS-17 WS-59 Save All includes hidden editors'), ['WS-17', 'WS-59']);
		assert.deepStrictEqual(leadingIds('WS-17, WTA-22: both'), ['WS-17', 'WTA-22']);
		assert.deepStrictEqual(leadingIds('ID-02'), ['ID-02']);
		assert.deepStrictEqual(leadingIds('saves WS-17 later in the title'), []);
		assert.deepStrictEqual(leadingIds('WS-17abc is not an id'), []);
	});

	test('a case is held by a test, by a manual procedure, or by nothing; a name no spec has is reported', () => {
		const result = coverage(['WS-01', 'WS-02', 'WS-03'], [
			{ path: 'a.test.ts', source: `test('WS-01 opens', () => { }); test('WS-77 a typo', () => { });` }
		], { 'WS-02': 'look at it in four themes', 'ID-99': 'gone' });
		assert.deepStrictEqual(result.held.get('WS-01'), ['a.test.ts: WS-01 opens']);
		assert.strictEqual(result.manual.get('WS-02'), 'look at it in four themes');
		assert.deepStrictEqual(result.missing, ['WS-03']);
		assert.deepStrictEqual(result.unknown, ['ID-99', 'WS-77']);
	});
});
