/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentListEntry, InspectResult } from '../../base/coreProtocol';
import { endEditors, normalizeDriveLetter, until } from './editors';
import type { Step } from './rustWindowDriver';

type Closed = Extract<Step, { readonly phase: 'closed' }>;

/** The workspace-side driver, installed beside the tested extension on this computer or the SSH host. */
export function lifetimeDriverFiles(): Readonly<Record<string, string>> {
	return {
		'package.json': JSON.stringify({ name: 'window-lifetime-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], extensionKind: ['workspace'], main: './extension.js' }),
		'extension.js': fs.readFileSync(path.join(__dirname, 'rustWindowDriver.js'), 'utf8'),
		'editors.js': fs.readFileSync(path.join(__dirname, 'editors.js'), 'utf8')
	};
}

/** The closed window's process and transcript survive the former window-dependent timeout. */
export async function checkClosedAgent(
	step: Extract<Closed, { readonly after: 'reload' }>,
	screen: (agent: string) => string,
	list: () => Promise<AgentListEntry[]>,
	inspect: (agent: string) => Promise<InspectResult>,
	remote = false
): Promise<void> {
	await until('the closed window to detach from the agent', async () => (await inspect(step.before.id)).viewers.length === 0 || undefined);
	console.log('    The closed editor detached its terminal.');
	await new Promise(resolve => setTimeout(resolve, remote ? 305_000 : 95_000));
	const agents = await list();
	const { agent, viewers } = await inspect(step.before.id);
	assert.deepStrictEqual(agents.map(each => each.address), [agent.address]);
	assert.deepStrictEqual([agent.pid, agent.process, agent.session, viewers], [step.before.pid, 'running', step.before.session, []]);
	assert.strictEqual(normalizeDriveLetter(agent.cwd), normalizeDriveLetter(step.before.cwd));
	assert.ok(screen(step.before.id).includes(step.screenText), 'the closed window’s screen still holds its transcript');
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
