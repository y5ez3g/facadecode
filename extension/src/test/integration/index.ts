/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import Mocha from 'mocha';
import * as path from 'path';

/** The integration suite, as test-electron runs it inside VS Code's extension host. */
export async function run(): Promise<void> {
	// One part of the suite where FACADE_IT_GREP names it, for a quicker look; the whole of it otherwise
	const mocha = new Mocha({ ui: 'tdd', timeout: 60_000, color: true, ...(process.env.FACADE_IT_GREP ? { grep: process.env.FACADE_IT_GREP } : {}) });
	// In name order
	for (const file of fs.readdirSync(__dirname).filter(each => each.endsWith('.it.js')).sort()) {
		mocha.addFile(path.join(__dirname, file));
	}
	return new Promise((resolve, reject) => mocha.run(failures => failures ? reject(new Error(`${failures} integration tests failed.`)) : resolve()));
}
