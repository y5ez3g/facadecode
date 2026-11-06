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

suite('Integration drivers: copied alone into a test window (VERIFICATION)', () => {
	const dir = path.join(__dirname, 'integration');

	test('the drivers copied alone as an extension\'s extension.js require only fs, path and vscode at run time - the focus probe\'s also its cdpInput, copied beside it - so they load where nothing of the extension is', () => {
		const allowed = ['fs', 'path', 'vscode'];
		const drivers: Readonly<Record<string, readonly string[]>> = {
			'conversionDriver.js': allowed,
			'pinsDriver.js': allowed,
			'updateDriver.js': allowed,
			'focusProbeDriver.js': [...allowed, './cdpInput'],
			'cdpInput.js': ['crypto', 'http']
		};
		const wrong = Object.entries(drivers).flatMap(([file, may]) => required(path.join(dir, file)).filter(module => !may.includes(module)).map(module => `${file}: ${module}`));
		assert.deepStrictEqual(wrong, []);
	});
});
