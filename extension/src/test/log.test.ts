/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentLog, AGENTS_LOG } from '../record/log';
import { cutNextWriteShort, replaceFsFunction, tempDir } from './util';

suite('Diagnostic log retention does not interrupt activation or lose retained records', () => {

	const now = Date.parse('2026-10-29T12:00:00.000Z');
	const old = '2026-09-01T12:00:00.000Z old operation\n';
	const recent = '2026-10-28T12:00:00.000Z recent operation\n';

	test('pruning removes only dated old lines and new facts remain one line each', () => {
		const temp = tempDir('fc-log-');
		try {
			const file = path.join(temp.dir, AGENTS_LOG);
			fs.writeFileSync(file, old + recent + 'undated diagnostic\n');
			const log = new AgentLog(temp.dir, () => now);
			log.event('next\r\noperation');
			assert.strictEqual(fs.readFileSync(file, 'utf8'), recent + 'undated diagnostic\n2026-10-29T12:00:00.000Z next operation\n');
		} finally {
			temp.remove();
		}
	});

	test('a partial pruning write leaves the previous log intact and later appends still work', () => {
		const temp = tempDir('fc-log-');
		const file = path.join(temp.dir, AGENTS_LOG);
		fs.writeFileSync(file, old + recent);
		const restore = cutNextWriteShort();
		try {
			const log = new AgentLog(temp.dir, () => now);
			log.event('activation continued');
			assert.deepStrictEqual([fs.readFileSync(file, 'utf8'), fs.readdirSync(temp.dir)], [
				old + recent + '2026-10-29T12:00:00.000Z activation continued\n',
				[AGENTS_LOG]
			]);
		} finally {
			restore();
			temp.remove();
		}
	});

	test('a concurrent append during pruning is preserved instead of overwritten by the earlier read', () => {
		const temp = tempDir('fc-log-');
		const file = path.join(temp.dir, AGENTS_LOG);
		const concurrent = '2026-10-29T11:59:59.000Z another host\n';
		fs.writeFileSync(file, old + recent);
		const restore = replaceFsFunction('writeFileSync', original => (target, data, options) => {
			restore();
			fs.appendFileSync(file, concurrent);
			original(target, data, options);
		});
		try {
			new AgentLog(temp.dir, () => now);
			assert.deepStrictEqual([fs.readFileSync(file, 'utf8'), fs.readdirSync(temp.dir)], [old + recent + concurrent, [AGENTS_LOG]]);
		} finally {
			restore();
			temp.remove();
		}
	});
});
