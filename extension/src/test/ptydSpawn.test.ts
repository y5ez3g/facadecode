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
