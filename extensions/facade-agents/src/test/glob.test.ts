/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { compileGlob, normalizePath } from '../common/glob';

suite('glob', () => {

	test('matches the way a plan means its paths', () => {
		const cases: [string, string][] = [
			['src/agents', 'src/agents/claude.ts'],
			['src/agents', 'src/agents'],
			['src/agents', 'src/agentsX/claude.ts'],
			['src/agents/claude.ts', 'src/agents/claude.ts'],
			['src/*.ts', 'src/a.ts'],
			['src/*.ts', 'src/deep/a.ts'],
			['src/**/*.ts', 'src/a.ts'],
			['src/**/*.ts', 'src/deep/er/a.ts'],
			['**/package-lock.json', 'package-lock.json'],
			['**/package-lock.json', 'a/b/package-lock.json'],
			['test/**', 'test/x/y.txt'],
			['src/{a,b}.ts', 'src/b.ts'],
			['src/{a,b}.ts', 'src/c.ts'],
			['src/?.ts', 'src/a.ts'],
			['src/[ab].ts', 'src/c.ts']
		];
		assert.deepStrictEqual(cases.map(([pattern, file]) => `${pattern} ${compileGlob(pattern, false)(file) ? 'matches' : 'misses'} ${file}`), [
			'src/agents matches src/agents/claude.ts',
			'src/agents matches src/agents',
			'src/agents misses src/agentsX/claude.ts',
			'src/agents/claude.ts matches src/agents/claude.ts',
			'src/*.ts matches src/a.ts',
			'src/*.ts misses src/deep/a.ts',
			'src/**/*.ts matches src/a.ts',
			'src/**/*.ts matches src/deep/er/a.ts',
			'**/package-lock.json matches package-lock.json',
			'**/package-lock.json matches a/b/package-lock.json',
			'test/** matches test/x/y.txt',
			'src/{a,b}.ts matches src/b.ts',
			'src/{a,b}.ts misses src/c.ts',
			'src/?.ts matches src/a.ts',
			'src/[ab].ts misses src/c.ts'
		]);
	});

	test('normalizes separators and leading dots, and ignores case where asked', () => {
		assert.deepStrictEqual({
			normalized: normalizePath('.\\src\\\\a/'),
			insensitive: compileGlob('SRC/A.ts', true)('src/a.TS'),
			sensitive: compileGlob('SRC/A.ts', false)('src/a.TS')
		}, { normalized: 'src/a', insensitive: true, sensitive: false });
	});

	test('an unclosed brace is an error, not a silent miss', () => {
		assert.throws(() => compileGlob('src/{a,b.ts'), /Unclosed/);
	});
});
