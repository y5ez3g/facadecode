/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** What a compiled file requires at run time: its `require('…')` calls, type-only imports gone. */
function required(file: string): string[] {
	const text = fs.readFileSync(file, 'utf8');
	return [...new Set([...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]))].sort();
}

suite('Integration drivers: staged in a test window (VERIFICATION)', () => {
	const dir = path.join(__dirname, 'integration');

	test('staged drivers load using only editor APIs, Node built-ins and helpers copied beside them', () => {
		const allowed = ['fs', 'path', 'vscode'];
		const drivers: Readonly<Record<string, readonly string[]>> = {
			'conversionDriver.js': [...allowed, './editors'],
			'editors.js': ['assert', 'child_process', 'crypto', 'fs', 'net', 'path', 'readline'],
			'pinsDriver.js': allowed,
			'updateDriver.js': allowed,
			'focusProbeDriver.js': [...allowed, './cdpInput'],
			'cdpInput.js': ['crypto', 'http', 'net']
		};
		const wrong = Object.entries(drivers).flatMap(([file, may]) => required(path.join(dir, file)).filter(module => !may.includes(module)).map(module => `${file}: ${module}`));
		assert.deepStrictEqual(wrong, []);
	});
});
