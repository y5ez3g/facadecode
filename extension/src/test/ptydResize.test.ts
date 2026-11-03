/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { withModules } from './withModules';

suite('ptyd: cursor and draft survive viewport reflow (ARCHITECTURE-2.4)', () => {
	for (const draft of ['', 'keep this draft']) {
		test(`narrowing then restoring a terminal preserves ${draft ? 'the existing draft' : 'the empty input position'}`, async () => {
			let output!: (data: string) => void;
			const pty = { pid: 1, onData: (listener: typeof output) => { output = listener; }, onExit() {}, kill() {}, resize() {}, write() {}, pause() {}, resume() {} };
			const { Run } = withModules({ 'node-pty': { spawn: () => pty } })<typeof import('../ptyd/run')>(require.resolve('../ptyd/run'));
			const run = new Run({ run: 'resize', owner: 'test', file: 'fixture', args: [], env: {}, cwd: '/unused', cols: 20, rows: 10, meta: {} });
			try {
				// A normal-buffer input frame, as Muse draws it. Reflow of the full-width rule above moves its cursor.
				output(`\x1b[2;1H${'─'.repeat(20)}\x1b[3;1H❯ ${draft}\x1b[4;1H${'─'.repeat(20)}\x1b[5;1H  model · high\x1b[3;${3 + draft.length}H`);
				const before = await run.read(50);
				const input = await run.inspect('muse-frame');
				assert.strictEqual(input.state, draft ? 'draft' : 'usable');
				for (let n = 0; n < 3; n++) {
					run.resize(18, 10);
					run.resize(20, 10);
					assert.deepStrictEqual((await run.read(50)).text, before.text);
					assert.deepStrictEqual(await run.inspect('muse-frame'), input, 'no cursor drift and no draft mistaken for empty input');
				}
			} finally { run.dispose(); }
		});
	}
});
