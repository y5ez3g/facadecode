/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { IWindowsPtyForkOptions } from 'node-pty';
import { withModules } from './withModules';

interface SpawnCall {
	readonly file: string;
	readonly args: readonly string[];
	readonly options: IWindowsPtyForkOptions;
}

function withRun(platform: NodeJS.Platform, spawn: (call: SpawnCall) => void, check: (create: () => void) => void): void {
	const pty = { spawn: (file: string, args: readonly string[], options: IWindowsPtyForkOptions) => {
		spawn({ file, args, options });
		return { pid: 1, onData() {}, onExit() {}, kill() {} };
	} };
	const { Run } = withModules({ 'node-pty': pty })<typeof import('../ptyd/run')>(require.resolve('../ptyd/run'));
	const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
	try {
		Object.defineProperty(process, 'platform', { value: platform });
		check(() => {
			const run = new Run({ run: 'test', owner: 'test', file: 'agent.exe', args: ['--test'], cwd: 'work', env: { TEST: 'value' }, cols: 80, rows: 24, meta: {} });
			run.dispose();
		});
	} finally { Object.defineProperty(process, 'platform', original); }
}

suite('ptyd native spawn options (ARCHITECTURE-1.2)', () => {
	test('Windows runs select the bundled ConPTY DLL that can deliver OSC input replies', () => {
		const calls: SpawnCall[] = [];
		withRun('win32', call => { calls.push(call); }, create => create());
		assert.deepStrictEqual(calls.map(call => call.options.useConptyDll), [true]);
	});

	test('a missing bundled DLL falls back to the system console and later runs use that console directly', () => {
		const calls: SpawnCall[] = [];
		withRun('win32', call => {
			calls.push(call);
			if (call.options.useConptyDll) {
				throw new Error('Cannot find conpty.dll at C:\\editor\\node-pty\\build\\Release\\conpty\\conpty.dll');
			}
		}, create => { create(); create(); });
		assert.deepStrictEqual(calls.map(call => call.options.useConptyDll), [true, false, false]);
		for (const call of calls) {
			assert.deepStrictEqual(call, {
				file: 'agent.exe', args: ['--test'],
				options: { useConptyDll: call.options.useConptyDll, name: 'xterm-256color', cols: 80, rows: 24, cwd: 'work', env: { TEST: 'value' } }
			});
		}
	});

	test('an executable failure is returned unchanged without retrying or disabling the bundled DLL', () => {
		const error = new Error('Cannot create process (error code: 2)');
		const calls: SpawnCall[] = [];
		withRun('win32', call => {
			calls.push(call);
			if (calls.length === 1) { throw error; }
		}, create => {
			assert.throws(create, thrown => thrown === error);
			assert.strictEqual(calls.length, 1);
			create();
		});
		assert.deepStrictEqual(calls.map(call => call.options.useConptyDll), [true, true]);
	});

	test('a failed system-console fallback is returned unchanged and is not retried', () => {
		const error = new Error('Cannot create process (error code: 2)');
		const calls: SpawnCall[] = [];
		withRun('win32', call => {
			calls.push(call);
			throw call.options.useConptyDll ? new Error('Cannot find conpty.dll at C:\\editor\\conpty\\conpty.dll') : error;
		}, create => assert.throws(create, thrown => thrown === error));
		assert.deepStrictEqual(calls.map(call => call.options.useConptyDll), [true, false]);
	});

	for (const platform of ['darwin', 'linux'] as const) {
		test(`${platform} omits the Windows-only option and never retries a spawn error`, () => {
			const error = new Error('Cannot find conpty.dll at /unexpected');
			const calls: SpawnCall[] = [];
			withRun(platform, call => {
				calls.push(call);
				if (calls.length === 2) { throw error; }
			}, create => {
				create();
				assert.throws(create, thrown => thrown === error);
			});
			assert.strictEqual(calls.length, 2);
			assert.ok(calls.every(call => !Object.hasOwn(call.options, 'useConptyDll')));
		});
	}
});

suite('ptyd: a Windows console is ended once (LIFECYCLE-4.2)', () => {
	test('a console node-pty never made ready - which queues its kill until then - is ended through its agent at once, and once', () => {
		const counts = { agent: 0, queued: 0, released: 0 };
		const console = (ready: boolean) => ({
			pid: ready ? 4242 : 0, _isReady: ready,
			_agent: { kill: () => counts.agent++, _conoutSocketWorker: { dispose: () => counts.released++ } },
			onData() {}, onExit() {}, kill: () => counts.queued++, resize() {}, write() {}
		});
		const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
		try {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			for (const ready of [false, true]) {
				const { Run } = withModules({ 'node-pty': { spawn: () => console(ready) } })<typeof import('../ptyd/run')>(require.resolve('../ptyd/run'));
				const run = new Run({ run: 'test', owner: 'test', file: 'agent.exe', args: [], cwd: 'work', env: {}, cols: 80, rows: 24, meta: {} });
				run.dispose();
				run.dispose();
			}
			// Never ready: its agent ends it and lets go of its pipes; ready: node-pty's own kill, as ever - each once
			assert.deepStrictEqual(counts, { agent: 1, queued: 1, released: 1 });
		} finally {
			Object.defineProperty(process, 'platform', original);
		}
	});

	test('terminate past its grace, a resize and the run forgotten end its console once: node-pty\'s second kill reaches a console already freed', async () => {
		let kills = 0;
		let resizes = 0;
		let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
		const pty = { spawn: () => ({ pid: 4242, onData() {}, onExit(listener: typeof exit) { exit = listener; }, kill() { kills++; }, resize() { resizes++; }, write() {} }) };
		const { Run } = withModules({ 'node-pty': pty })<typeof import('../ptyd/run')>(require.resolve('../ptyd/run'));
		const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
		try {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			const run = new Run({ run: 'test', owner: 'test', file: 'agent.exe', args: [], cwd: 'work', env: {}, cols: 80, rows: 24, meta: {} });
			// Its end comes only after the grace, as node-pty's kill there first lists the console's processes
			setTimeout(() => exit!({ exitCode: 1 }), 200);
			const ending = run.terminate(50);
			run.resize(100, 30);
			assert.strictEqual(await ending, 'terminated');
			run.dispose();
			assert.deepStrictEqual([kills, resizes], [1, 0]);
		} finally {
			Object.defineProperty(process, 'platform', original);
		}
	});
});

suite('ptyd: a run counts as started once its program has a PID (ARCHITECTURE-2.3)', () => {
	/** A Run on a stand-in console that starts its program `startAfter` ms after the spawn, or reports an exit then instead. */
	function delayed(outcome: { readonly pid?: number; readonly exitCode?: number }) {
		const pty = { pid: 0, onData() {}, exit: undefined as ((event: { exitCode: number }) => void) | undefined, onExit(listener: (event: { exitCode: number }) => void) { this.exit = listener; }, kill() {}, write() {}, resize() {} };
		const { Run } = withModules({ 'node-pty': { spawn: () => pty } })<typeof import('../ptyd/run')>(require.resolve('../ptyd/run'));
		const run = new Run({ run: 'test', owner: 'test', file: 'agent.exe', args: [], cwd: 'work', env: {}, cols: 80, rows: 24, meta: {} });
		setTimeout(() => outcome.pid !== undefined ? pty.pid = outcome.pid : pty.exit!({ exitCode: outcome.exitCode! }), 60);
		return run;
	}

	test('a program started after the spawn - as node-pty 1.2 starts a Windows console\'s - is started once its PID is there', async () => {
		const run = delayed({ pid: 4242 });
		assert.strictEqual(run.info(false).pid, 0);
		await run.started();
		assert.strictEqual(run.info(false).pid, 4242);
		run.dispose();
	});

	test('a program that ends before it has a PID never started: Windows\' error is said as node-pty said it when it threw', async () => {
		const run = delayed({ exitCode: 2 });
		await assert.rejects(run.started(), /^Error: Cannot create process \(error code: 2\)$/);
		run.dispose();
	});
});
