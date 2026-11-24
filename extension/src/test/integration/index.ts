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
	const selection = process.env.FACADE_IT_EXPECT_TESTS;
	const expected: unknown = selection ? JSON.parse(selection) : undefined;
	if (selection && (!Array.isArray(expected) || expected.length === 0
		|| !expected.every(name => typeof name === 'string' && name.length > 0)
		|| new Set(expected).size !== expected.length)) {
		throw new Error('Expected distinct full acceptance test titles.');
	}
	return new Promise((resolve, reject) => {
		const passed: { name: string; implementation: unknown }[] = [];
		const runner = mocha.run(failures => {
			if (failures) {
				reject(new Error(String(failures) + ' integration tests failed.'));
				return;
			}
			if (Array.isArray(expected)) {
				const observed = passed.map(test => test.name).sort();
				if (JSON.stringify(observed) !== JSON.stringify([...expected].sort()) || runner.stats?.pending) {
					reject(new Error('Expected exactly these observed passing tests: ' + selection));
					return;
				}
				if (passed.some(test => !test.implementation || test.implementation !== process.env.FACADE_IT_IMPLEMENTATION)) {
					reject(new Error('An acceptance test did not observe the selected implementation.'));
					return;
				}
				for (const test of passed) {
					console.log('Facade acceptance test ' + JSON.stringify(test));
				}
			}
			resolve();
		});
		if (Array.isArray(expected)) {
			runner.on('test', test => {
				if (test.ctx) { delete test.ctx.acceptanceImplementation; }
			});
			runner.on('pass', test => passed.push({ name: test.fullTitle(), implementation: test.ctx?.acceptanceImplementation }));
		}
	});
}
