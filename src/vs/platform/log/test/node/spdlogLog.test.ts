/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { timeout } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import product from '../../../product/common/product.js';
import { logHeader } from '../../../product/common/releaseVersion.js';
import { LogLevel } from '../../common/log.js';
import { SpdLogLogger } from '../../node/spdlogLog.js';

suite('SpdLogLogger', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ID-09 a log opens with which build wrote it, whatever its level; output that is not a log does not', async () => {
		const folder = getRandomTestPath(tmpdir(), 'vsctests', 'spdlogLog');
		await fs.mkdir(folder, { recursive: true });
		const log = new SpdLogLogger('facade-test-log', join(folder, 'main.log'), false, false, LogLevel.Warning);
		const output = new SpdLogLogger('facade-test-output', join(folder, 'tasks.log'), false, true, LogLevel.Info);

		try {
			log.info('below the level');
			log.warn('at the level');
			output.info('output');

			// the lines as written, without their times
			const linesOf = async (name: string, count: number) => {
				for (let attempt = 0; attempt < 100; attempt++) {
					const text = await fs.readFile(join(folder, name), 'utf8').catch(() => '');
					const lines = text.split(/\r?\n/).filter(line => !!line);
					if (lines.length >= count) {
						return lines.map(line => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /, ''));
					}
					await timeout(20);
				}
				return [];
			};

			assert.deepStrictEqual({
				log: await linesOf('main.log', 2),
				output: await linesOf('tasks.log', 1)
			}, {
				log: [`[info] ${logHeader(product)}`, '[warning] at the level'],
				output: ['output']
			});
		} finally {
			log.dispose();
			output.dispose();
			await fs.rm(folder, { recursive: true, force: true }).catch(() => { /* the logger's thread may still hold the file */ });
		}
	});
});
