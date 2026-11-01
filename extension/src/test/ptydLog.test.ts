/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KEPT_LOG_BYTES, logTo, MOST_LOG_BYTES } from '../ptyd/log';

suite('ptyd\'s log: dated lines in a file of bounded size, its oldest let go of first (ARCHITECTURE-3.3)', () => {

	const at = () => new Date(Date.UTC(2026, 10, 1));

	test('a log already past its bound keeps its newest whole lines as ptyd starts; one within it is kept whole', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ptyd-log-'));
		try {
			const file = path.join(dir, 'ptyd.log');
			const line = (n: number) => `2026-10-01T00:00:00.000Z line ${String(n).padStart(8, '0')} ${'x'.repeat(100)}\n`;
			const lines = Math.ceil(MOST_LOG_BYTES / line(0).length) + 10;
			fs.writeFileSync(file, Array.from({ length: lines }, (_, n) => line(n)).join(''));
			assert.ok(fs.statSync(file).size > MOST_LOG_BYTES);
			logTo(file, at)('ptyd 42 listening.');
			const kept = fs.readFileSync(file, 'utf8');
			assert.ok(Buffer.byteLength(kept) <= KEPT_LOG_BYTES + 100, String(Buffer.byteLength(kept)));
			// Whole lines alone, the newest of them, then what was said since
			assert.ok(kept.startsWith('2026-10-01T00:00:00.000Z line '), kept.slice(0, 60));
			assert.ok(kept.endsWith(`${line(lines - 1)}2026-11-01T00:00:00.000Z ptyd 42 listening.\n`));
			// Within its bound it is kept whole
			const small = path.join(dir, 'small.log');
			fs.writeFileSync(small, line(1));
			logTo(small, at)('next');
			assert.strictEqual(fs.readFileSync(small, 'utf8'), `${line(1)}2026-11-01T00:00:00.000Z next\n`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a ptyd that goes on logging past the bound lets go of its oldest lines as it goes; no file named, nothing is written', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ptyd-log-'));
		try {
			const file = path.join(dir, 'ptyd.log');
			const log = logTo(file, at);
			const message = `Uncaught: ${'y'.repeat(1_000)}`;
			for (let n = 0; n < Math.ceil(MOST_LOG_BYTES / 1_000) * 2; n++) {
				log(`${n} ${message}`);
				assert.ok(fs.statSync(file).size <= MOST_LOG_BYTES + 2_000);
			}
			assert.ok(fs.readFileSync(file, 'utf8').startsWith('2026-11-01T00:00:00.000Z '));
			logTo(undefined)('nowhere');
			assert.deepStrictEqual(fs.readdirSync(dir), ['ptyd.log']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
