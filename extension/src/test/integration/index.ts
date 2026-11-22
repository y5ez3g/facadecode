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
	const expected = process.env.FACADE_IT_EXPECT_TEST;
	return new Promise((resolve, reject) => {
		const passed: { name: string; engine: unknown }[] = [];
		const runner = mocha.run(failures => {
			if (failures) {
				reject(new Error(String(failures) + ' integration tests failed.'));
				return;
			}
			if (expected) {
				const observed = passed[0];
				if (passed.length !== 1 || observed.name !== expected || runner.stats?.pending) {
					reject(new Error('Expected exactly one observed passing test: ' + expected));
					return;
				}
				if (!observed.engine || observed.engine !== process.env.FACADE_IT_ENGINE) {
					reject(new Error('The acceptance test did not observe the selected engine.'));
					return;
				}
				console.log('Facade acceptance test ' + JSON.stringify(observed));
			}
			resolve();
		});
		if (expected) {
			runner.on('pass', test => passed.push({ name: test.fullTitle(), engine: test.ctx?.acceptanceEngine }));
		}
	});
}
