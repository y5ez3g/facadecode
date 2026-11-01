/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Terminal } from '@xterm/headless';
import type { SpawnParams } from '../ptyd/protocol';
import type { RunListener } from '../ptyd/run';
import { withModules } from './withModules';

/** A run on a stand-in for node-pty: the test writes its output and ends it, and sees what it is asked to do. */
function runOf(cols = 80) {
	const params: SpawnParams = { run: 'r1', owner: 'w1', file: 'unused', args: [], cwd: '/', env: {}, cols, rows: 24, meta: {} };
	let output!: (data: string) => void;
	let end!: (exit: { exitCode: number; signal?: number }) => void;
	const calls: string[] = [];
	const pty = {
		pid: 1,
		onData: (listener: typeof output) => { output = listener; },
		onExit: (listener: typeof end) => { end = listener; },
		write() { }, resize() { },
		kill: (signal?: string) => calls.push(`kill ${signal ?? ''}`.trim()),
		pause: () => calls.push('pause'),
		resume: () => calls.push('resume')
	};
	const load = withModules({ 'node-pty': { spawn: () => pty } });
	const module = load<typeof import('../ptyd/run')>(require.resolve('../ptyd/run'));
	return { module, run: new module.Run(params), output: (data: string) => output(data), end: (exitCode: number, signal?: number) => end({ exitCode, ...(signal ? { signal } : {}) }), calls };
}

/** What a terminal shows once `pieces` are written to it. */
async function drawn(pieces: readonly string[]) {
	const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	try {
		for (const piece of pieces) {
			terminal.write(piece);
		}
		await new Promise<void>(resolve => terminal.write('', resolve));
		const buffer = terminal.buffer.active;
		return { lines: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.translateToString(true)), x: buffer.cursorX, y: buffer.cursorY };
	} finally {
		terminal.dispose();
	}
}

suite('ptyd: a run\'s screen and its numbered output meet once (ARCHITECTURE-2.3)', () => {

	for (const [name, before, after] of [
		['plain output', 'previous line\r\n', 'new line'],
		['relative cursor movement', 'abc', '\x1b[1D!'],
		['an alternate-screen transition', 'normal', '\x1b[?1049hframe\x1b[?1049l\r\nback']
	]) {
		test(`${name} arriving while the screen is taken is numbered after it and is outside it`, async () => {
			const { run, output } = runOf();
			try {
				output(before);
				const stream: { seq: number; data: string }[] = [];
				const listener: RunListener = { output: (seq, data) => stream.push({ seq, data }), title() { }, status() { }, exit() { } };
				run.listen(listener);
				const taking = run.snapshot();
				output(after);
				const { screen, seq } = await taking;
				assert.deepStrictEqual([seq, stream], [1, [{ seq: 2, data: after }]]);
				assert.deepStrictEqual(await drawn([screen]), await drawn([before]));
				assert.deepStrictEqual(await drawn([screen, ...stream.filter(each => each.seq > seq).map(each => each.data)]), await drawn([before, after]));
			} finally {
				run.dispose();
			}
		});
	}

	test('its exit is told once what it wrote last is drawn, with a Ctrl+C typed just before as evidence', async () => {
		const { run, output, end } = runOf();
		const told: unknown[] = [];
		run.listen({ output() { }, title() { }, status() { }, exit: exit => told.push(exit) });
		try {
			run.write('\x03');
			output('bye');
			end(130);
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.deepStrictEqual([told, run.hasExited], [[{ exitCode: 130, ctrlC: true }], true]);
			assert.ok((await run.snapshot()).screen.includes('bye'));
		} finally {
			run.dispose();
		}
	});

	test('a pid that is no process group is never signalled as one: the stand-in\'s own kill is used', async () => {
		const { run, calls } = runOf();
		assert.strictEqual(await run.terminate(0), 'unconfirmed');
		// Windows has no signals or process groups: node-pty's kill ends the console's processes there, once - a second reaches a
		// console already freed
		assert.deepStrictEqual(calls, process.platform === 'win32' ? ['kill'] : ['kill SIGHUP', 'kill SIGKILL']);
		run.dispose();
	});
});

suite('ptyd: a Windows console let go once its program ended (ARCHITECTURE-2.4)', () => {

	test('node-pty\'s console pipes and the worker reading its output are closed; a backend without them is left as it is', () => {
		const { module, run } = runOf();
		run.dispose();
		const calls: string[] = [];
		module.releaseConsole({
			_agent: {
				_conoutSocketWorker: { dispose: () => calls.push('worker') },
				_outSocket: { destroy: () => calls.push('out') },
				_inSocket: { destroy: () => calls.push('in') }
			}
		});
		assert.deepStrictEqual(calls, ['worker', 'out', 'in']);
		assert.doesNotThrow(() => {
			module.releaseConsole({});
			module.releaseConsole({ _agent: {} });
		});
	});
});

suite('ptyd: bounded scrollback and buffers (ARCHITECTURE-2.4)', () => {

	test('the scrollback keeps 10,000 lines, fewer where its cells would pass 8 MiB at the width', () => {
		const { module, run } = runOf();
		run.dispose();
		assert.deepStrictEqual([40, 80, 120, 300].map(module.scrollbackRows), [10_000, 8738, 5825, 2330]);
	});

	test('a run with more than the bound written keeps its newest lines and lets earlier ones go', async () => {
		const { run, output } = runOf(120);
		try {
			output(Array.from({ length: 7_000 }, (_, i) => `line ${i}`).join('\r\n'));
			const { screen } = await run.snapshot();
			assert.deepStrictEqual([screen.includes('line 6999'), screen.includes('line 10\r\n')], [true, false]);
		} finally {
			run.dispose();
		}
	});

	test('output waiting to be drawn past 8 MiB pauses the process, which goes on once it is drawn', async function () {
		this.timeout(20_000);
		const { run, output, calls } = runOf();
		try {
			output('x'.repeat(9 * 1024 * 1024));
			assert.deepStrictEqual(calls, ['pause']);
			await run.snapshot();
			assert.deepStrictEqual(calls, ['pause', 'resume']);
		} finally {
			run.dispose();
		}
	});
});
