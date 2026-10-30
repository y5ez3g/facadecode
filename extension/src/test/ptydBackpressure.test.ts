/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { EventEmitter } from 'events';
import type * as net from 'net';
import * as path from 'path';
import { Terminal } from '@xterm/headless';
import type { RunEvent } from '../ptyd/protocol';
import { MOST_RUN_BUFFER, type Run } from '../ptyd/run';
import { MOST_WINDOW_BUFFER, PtydServer } from '../ptyd/server';
import { tempDir } from './util';
import { withModules } from './withModules';

/** A slow window: writes complete only when the test drains their callbacks. No operating-system socket is opened. */
class StalledSocket extends EventEmitter {
	writable = true;
	destroyed = false;
	readonly pending: (() => void)[] = [];
	setEncoding(): void { }
	write(_line: string, flushed: () => void): boolean {
		this.pending.push(flushed);
		return false;
	}
	destroy(): void {
		if (!this.destroyed) {
			this.destroyed = true;
			this.emit('close');
		}
	}
}

interface OutputConnection {
	output(run: Run, event: RunEvent, claimed: () => Iterable<Run>): void;
}

/** Exercises the real server connection with controlled socket completion and the same hold/release contract as a run. */
function windowOf(count: number) {
	const temp = tempDir('fc-byte-pressure-');
	const server = new PtydServer(path.join(temp.dir, 'unused.sock'));
	const socket = new StalledSocket();
	const internals = server as unknown as { connected(socket: net.Socket): void; connections: Set<OutputConnection> };
	internals.connected(socket as unknown as net.Socket);
	const connection = [...internals.connections][0];
	const runs = Array.from({ length: count }, () => ({
		holders: new Set<object>(),
		hold(holder: object) { this.holders.add(holder); },
		release(holder: object) { this.holders.delete(holder); }
	}));
	return {
		runs, socket,
		output: (index: number, data: string) => connection.output(runs[index] as unknown as Run,
			{ event: 'output', run: `r${index}`, seq: 1, data }, () => runs as unknown as Run[]),
		dispose: () => { server.close(); temp.remove(); }
	};
}

suite('ptyd: Unicode output pressure counts UTF-8 bytes (ARCHITECTURE-2.4)', () => {
	// Three MiB on the wire, although JavaScript's string length is only one MiB.
	const chunk = '雪'.repeat(1024 * 1024);
	assert.strictEqual(Buffer.byteLength(chunk), 3 * 1024 * 1024);

	test('one run pauses past eight MiB and resumes only after its pending bytes fall below half', () => {
		const window = windowOf(1);
		try {
			window.output(0, chunk);
			window.output(0, chunk);
			assert.strictEqual(window.runs[0].holders.size, 0);
			window.output(0, chunk);
			assert.ok(Buffer.byteLength(chunk) * 3 > MOST_RUN_BUFFER);
			assert.strictEqual(window.runs[0].holders.size, 1);
			window.socket.pending.shift()!();
			assert.strictEqual(window.runs[0].holders.size, 1, 'six MiB still wait');
			window.socket.pending.shift()!();
			assert.strictEqual(window.runs[0].holders.size, 0, 'three MiB remain');
		} finally { window.dispose(); }
	});

	test('many runs pause together past thirty-two MiB and resume only after the window falls below half', () => {
		const window = windowOf(12);
		try {
			for (let index = 0; index < 10; index++) {
				window.output(index, chunk);
			}
			assert.ok(window.runs.every(run => run.holders.size === 0), 'thirty MiB fit');
			window.output(10, chunk);
			window.output(11, chunk);
			assert.ok(Buffer.byteLength(chunk) * 12 > MOST_WINDOW_BUFFER);
			assert.ok(window.runs.every(run => run.holders.size === 1), 'each run is below eight MiB; the window pauses all of them');
			for (let index = 0; index < 6; index++) {
				window.socket.pending.shift()!();
			}
			assert.ok(window.runs.every(run => run.holders.size === 1), 'eighteen MiB still wait');
			window.socket.pending.shift()!();
			assert.ok(window.runs.every(run => run.holders.size === 0), 'fifteen MiB remain');
		} finally { window.dispose(); }
	});

	test('headless drawing uses the same byte thresholds and subtracts each completed write exactly', () => {
		const pending: (() => void)[] = [];
		const calls: string[] = [];
		let output!: (data: string) => void;
		class HeldTerminal extends Terminal {
			override write(_data: string | Uint8Array, callback?: () => void): void {
				if (callback) { pending.push(callback); }
			}
		}
		const pty = {
			pid: 1, onData: (listener: typeof output) => { output = listener; }, onExit() { }, write() { }, resize() { }, kill() { },
			pause: () => calls.push('pause'), resume: () => calls.push('resume')
		};
		const { Run } = withModules({ 'node-pty': { spawn: () => pty }, '@xterm/headless': { Terminal: HeldTerminal } })<typeof import('../ptyd/run')>(require.resolve('../ptyd/run'));
		const run = new Run({ run: 'r', owner: 'w', file: 'unused', args: [], cwd: '/', env: {}, cols: 80, rows: 24, meta: {} });
		try {
			output(chunk);
			output(chunk);
			assert.deepStrictEqual(calls, []);
			output(chunk);
			assert.deepStrictEqual(calls, ['pause']);
			pending.shift()!();
			assert.deepStrictEqual(calls, ['pause']);
			pending.shift()!();
			assert.deepStrictEqual(calls, ['pause', 'resume']);
			pending.shift()!();
			assert.deepStrictEqual(calls, ['pause', 'resume']);
		} finally { run.dispose(); }
	});
});
