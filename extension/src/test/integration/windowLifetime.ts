/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { endEditors, until } from './editors';
import type { windowsInCore } from './editors';
import type { LegacyPinFixture, ListedAgent, Step } from './rustWindowDriver';

type Closed = Extract<Step, { readonly phase: 'closed' }>;

/** The workspace-side driver, installed beside the tested extension on this computer or the SSH host. */
export function lifetimeDriverFiles(): Readonly<Record<string, string>> {
	return {
		'package.json': JSON.stringify({ name: 'window-lifetime-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], extensionKind: ['workspace'], main: './extension.js' }),
		'extension.js': fs.readFileSync(path.join(__dirname, 'rustWindowDriver.js'), 'utf8'),
		'editors.js': fs.readFileSync(path.join(__dirname, 'editors.js'), 'utf8')
	};
}

/** The closed window's process and transcript can still be read using the core CLI. */
export function checkClosedAgent(step: Extract<Closed, { readonly after: 'reload' }>, call: (...args: string[]) => string): void {
	const agents = JSON.parse(call('list', '--json')) as ListedAgent[];
	assert.deepStrictEqual(agents.map(each => [each.agent_id, each.pid, each.process]), [[step.before.id, step.before.pid, 'running']], 'the closed window’s original agent is still running');
	assert.ok(call('screen', step.before.id, '--lines', '120').includes(step.screenText), 'the closed window’s screen still holds its transcript');
}

/** Emulate saved state from a version whose Pin had neither a home nor a core agent ID. */
export function seedLegacyPin(fixture: LegacyPinFixture): void {
	const key = 'facade.pins';
	const withLegacy = (text: string) => {
		const state = JSON.parse(text) as { readonly [key]: { readonly id: string }[] };
		assert.ok(state[key].some(pin => pin.id === fixture.pin.id), 'the fixture replaces a saved Pin');
		return JSON.stringify({ ...state, [key]: state[key].map(pin => pin.id === fixture.pin.id ? fixture.pin : pin) });
	};
	fs.writeFileSync(fixture.mirror, `${withLegacy(fs.readFileSync(fixture.mirror, 'utf8'))}\n`);
	const db = new DatabaseSync(fixture.database);
	try {
		const id = 'facade.facadecode';
		const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(id);
		assert.strictEqual(typeof row?.value, 'string', 'the editor saved the extension’s workspace state');
		db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(withLegacy(row!.value as string), id);
	} finally {
		db.close();
	}
}

/** The former daemon started its 90-second or five-minute timer at the last connection's departure. */
export async function afterOldWindowGrace(windowId: string, windows: () => ReturnType<typeof windowsInCore>, remote: boolean): Promise<void> {
	await until(`window ${windowId} to disconnect from core`, async () => (await windows()).some(window => window.window_id === windowId && !window.connected) || undefined);
	console.log(`    ${JSON.stringify({ phase: 'disconnected', windowId, connected: false })}`);
	await new Promise(resolve => setTimeout(resolve, remote ? 305_000 : 95_000));
}

/** Restart with the same workspace and profile after the driver has closed the current editor window. */
export async function windowLifetime(start: () => ChildProcess, read: () => string, whileClosed: (step: Closed) => Promise<void>): Promise<void> {
	const steps = () => read().trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Step);
	let editor: ChildProcess | undefined;
	let output = '';
	try {
		let seen = 0;
		for (;;) {
			editor = start();
			const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-16_000); };
			editor.stdout?.on('data', capture);
			editor.stderr?.on('data', capture);
			editor.on('error', capture);
			let end = Date.now() + 120_000;
			let step: Step | undefined;
			while (!step && Date.now() < end) {
				const pending = steps().slice(seen);
				for (const next of pending) { console.log(`    ${JSON.stringify(next)}`); }
				if (pending.length) { end = Date.now() + 120_000; }
				seen += pending.length;
				step = pending.find(next => next.phase === 'closed' || next.phase === 'done' || next.phase === 'error');
				if (!step) { await new Promise(resolve => setTimeout(resolve, 500)); }
			}
			if (step?.phase === 'done') { return; }
			assert.ok(step?.phase === 'closed', `Window lifetime failed: ${JSON.stringify(step ?? steps())}`);
			await endEditors([editor]);
			editor = undefined;
			await whileClosed(step);
		}
	} catch (error) {
		console.error(`Window lifetime editor output:\n${output}`);
		throw error;
	} finally {
		if (editor) { await endEditors([editor]); }
	}
}
