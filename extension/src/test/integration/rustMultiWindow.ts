/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import type { V3AgentInfo, V3InspectResult } from '../../base/coreProtocol';
import { isProcessRunning } from '../../base/system';
import type { RustPin } from '../../core/ports';
import { freePort, Workbench } from './cdpInput';
import { callInCore, endEditors, normalizeDriveLetter, until } from './editors';
import type { SavedPin, WindowAction, WindowAnswer, WindowReady, WindowView } from './rustMultiWindowDriver';
import type { RunningAgent } from './rustWindowDriver';

/** The workspace driver and its helpers beside either copy of the extension. */
export function multiWindowDriverFiles(): Readonly<Record<string, string>> {
	const source = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf8');
	return {
		'package.json': JSON.stringify({
			name: 'rust-multi-window-driver', publisher: 'facade-it', version: '0.0.0',
			engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], extensionKind: ['workspace'], main: './extension.js'
		}),
		'extension.js': source('rustMultiWindowDriver.js'),
		'rustWindowDriver.js': source('rustWindowDriver.js'),
		'resumePickerFixture.js': source('resumePickerFixture.js'),
		'editors.js': source('editors.js')
	};
}

interface WindowFiles {
	/** A path under the run's root, also writable by the workspace driver. */
	readonly prefix: string;
	read(file: string): string;
	write(file: string, text: string): void;
}

interface DrivenWindow {
	readonly ready: WindowReady;
	act<Result>(action: WindowAction): Promise<Result>;
	close(): Promise<void>;
	workbench(): Promise<Workbench>;
}

type OpenWindow = (folder: string, profile: string) => Promise<DrivenWindow>;
type StartEditor = (folder: string, profile: string, control: string, port: number) => ChildProcess;

/** Start each window with its own profile and mailbox and reap exactly the editors the journey started. */
export async function withRustWindows(files: WindowFiles, start: StartEditor, journey: (open: OpenWindow) => Promise<void>): Promise<void> {
	const editors: ChildProcess[] = [];
	let opened = 0;
	const open: OpenWindow = async (folder, profile) => {
		const control = `${files.prefix}-${++opened}`;
		const port = await freePort();
		const editor = start(folder, profile, control, port);
		editors.push(editor);
		let output = '';
		const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-16_000); };
		editor.stdout?.on('data', capture);
		editor.stderr?.on('data', capture);
		editor.on('error', capture);
		const receive = async <Result>(file: string): Promise<Result> => {
			try {
				const answer = await until(file, () => {
					const text = files.read(file);
					return text ? JSON.parse(text) as WindowAnswer : undefined;
				}, 120_000);
				if ('error' in answer) { throw new Error(answer.error); }
				return answer.result as Result;
			} catch (error) {
				console.error(`Editor output for ${profile}:\n${output}`);
				const pinRestore = files.read(`${control}.pin-restore.log`);
				if (pinRestore) { console.error(`Pin restore for ${profile}:\n${pinRestore}`); }
				throw error;
			}
		};
		const ready = await receive<WindowReady>(`${control}.ready`);
		let sent = 0;
		const act = <Result>(action: WindowAction) => {
			const request = `${control}.${++sent}`;
			files.write(`${request}.request`, JSON.stringify(action));
			return receive<Result>(`${request}.answer`);
		};
		return {
			ready, act,
			workbench: () => Workbench.connect(port, path.basename(folder)),
			close: async () => {
				await act<boolean>({ kind: 'close' });
				if (process.platform !== 'win32') {
					await endEditors([editor]);
					return;
				}
				// The driver's reply comes during shutdown. Let VS Code finish saving its editor layout before reopening.
				try {
					await until(`the VS Code process for ${profile} to exit`, () =>
						editor.exitCode !== null || editor.signalCode !== null || undefined, 20_000);
				} finally {
					console.log(`  VS Code ${profile} after Close Window has exit code ${editor.exitCode} and signal ${editor.signalCode ?? 'none'}`);
				}
				assert.strictEqual(editor.exitCode, 0, `VS Code ${profile} did not exit cleanly`);
			}
		};
	};
	try {
		await journey(open);
	} finally {
		await endEditors(editors);
	}
}

async function expectAgent(window: DrivenWindow, id: string, pinned: boolean): Promise<void> {
	let last: WindowView | undefined;
	try {
		await until(`${id}'s ${pinned ? 'pinned ' : ''}card and terminal in ${window.ready.folder}`, async () => {
			last = await window.act<WindowView>({ kind: 'snapshot' });
			const { cards, terminals } = last;
			return cards.length === 1 && cards[0].id === id && cards[0].pinned === pinned && cards[0].column !== null
				&& terminals === 1 && cards[0].running || undefined;
		});
	} catch (error) {
		console.error(`Last window state in ${window.ready.folder}:`, JSON.stringify(last));
		throw error;
	}
}

/** Go to Agent attaches to a Shell run that survives closing the VS Code window. */
export async function shellHandoff(open: OpenWindow, folder: string, facade: string, env: NodeJS.ProcessEnv): Promise<void> {
	const run = (...args: string[]) => execFileSync(facade, args, { cwd: folder, env, encoding: 'utf8', timeout: 20_000 });
	const name = 'shell-ada';
	const address = run('start', '-d', '--name', name, 'codex').trim();
	assert.match(address, /^a\d+@[^\s]+$/u);
	const inspect = async () => {
		const reply = await callInCore(env.FACADE_HOME!, 'agent.inspect', { agent: address }, [3, 3]);
		assert.ok(!reply.error, JSON.stringify(reply.error));
		return (reply.result as V3InspectResult).agent;
	};
	const before = await inspect();
	assert.ok(before.pid && before.process === 'running');
	const window = await open(folder, 'sh');
	assert.strictEqual(await window.act<boolean>({ kind: 'window-component' }), false);
	const { settings_file: settingsFile } = JSON.parse(run('status', '--json')) as { settings_file: string };
	assert.ok(path.isAbsolute(settingsFile ?? ''), 'status gives the absolute settings file');
	assert.strictEqual(normalizeDriveLetter(settingsFile), normalizeDriveLetter(path.join(env.FACADE_HOME!, 'facade.json')));
	await window.act({ kind: 'settings-path', file: settingsFile });
	const marker = 'typed in the isolated editor';
	await window.act({ kind: 'open-shell-agent', name, address, text: marker });
	await window.close();
	const after = await inspect();
	assert.strictEqual(after.address, address);
	assert.strictEqual(after.pid, before.pid);
	assert.strictEqual(after.process, 'running');

	execFileSync(process.execPath, [path.join(__dirname, 'shellAttachFixture.js'), facade, address, marker], { cwd: folder, env, timeout: 65_000 });
	assert.strictEqual((await inspect()).pid, before.pid);
	console.log('  ✔ Shell start, Go to Agent and Shell Attach used the same terminal after closing VS Code');

	const session = await until('the fake CLI to report its session', async () => (await inspect()).session);
	const startLog = `${env.FACADE_IT_RECORD}.starts.#${before.agent_id}`;
	const starts = () => fs.readFileSync(startLog, 'utf8').trim().split(/\r?\n/u).map(Number);
	const priorStarts = starts().length;
	const pinWindow = await open(folder, 'sh');
	const peerWindow = await open(folder, 'sh2');
	const cardIn = async (window: DrivenWindow) =>
		(await window.act<WindowView>({ kind: 'snapshot' })).cards.find(card => card.name === name);
	await until('the other window to see the same workspace card', () => cardIn(peerWindow));
	await pinWindow.act({ kind: 'shell-pin', name, set: true });
	await until('Pin to be visible in the other window', async () => (await cardIn(peerWindow))?.pinned || undefined);
	await Promise.all([pinWindow.close(), peerWindow.close()]);
	// Pin recovery groups live extension hosts. Let both hosts exit before the next opening.
	await until('both closed windows to release their extension hosts', () =>
		[pinWindow, peerWindow].every(window => !isProcessRunning(window.ready.hostPid)) || undefined);
	run('stop', address);
	await until('the pinned agent to stop', async () => (await inspect()).process === 'ended' || undefined);
	const [restoredWindow, restoredPeer] = await Promise.all([open(folder, 'sh'), open(folder, 'sh2')]);
	const workspaces = path.join(env.FACADE_HOME!, 'extension', 'workspaces');
	const files = fs.readdirSync(workspaces).map(key => path.join(workspaces, key, 'orchestrator-workspace.json'))
		.filter(file => fs.existsSync(file));
	assert.strictEqual(files.length, 1, 'two windows use one workspace roster');
	const restoredPins = await Promise.allSettled([restoredWindow, restoredPeer].map(window => window.act({ kind: 'shell-pin', name })));
	const failure = restoredPins.find(each => each.status === 'rejected');
	if (failure) {
		const core = await callInCore(env.FACADE_HOME!, 'agent.inspect', { agent: address }, [3, 3]).catch(error => String(error));
		const directory = path.dirname(files[0]);
		const recovery = fs.readdirSync(directory).filter(file => file.startsWith('orchestrator-pin-restore')).map(file => {
			try { return [file, fs.readFileSync(path.join(directory, file), 'utf8')]; }
			catch (error) { return [file, String(error)]; }
		});
		console.error('Shell Pin recovery', JSON.stringify({ core, recovery, windows: restoredPins.map(each => each.status === 'rejected' ? String(each.reason) : 'opened') }));
		throw failure.reason;
	}
	const roster = () => JSON.parse(fs.readFileSync(files[0], 'utf8')) as {
		members: readonly { machine_id: string; agent_id: string }[];
		pins: readonly { machine_id: string; agent: string }[];
	};
	const checkSavedPin = () => {
		const saved = roster();
		assert.deepStrictEqual(saved.members, [{ machine_id: before.machine_id, agent_id: before.agent_id }]);
		assert.strictEqual(saved.pins.length, 1, 'the workspace saves one Pin');
		assert.strictEqual(saved.pins[0].machine_id, before.machine_id);
		assert.strictEqual(saved.pins[0].agent, before.agent_id);
	};
	checkSavedPin();
	const restored = await inspect();
	assert.strictEqual(restored.address, address);
	assert.strictEqual(restored.process, 'running');
	assert.strictEqual(restored.session, session);
	assert.notStrictEqual(restored.pid, before.pid);
	assert.deepStrictEqual(starts().slice(priorStarts), [restored.pid], 'reopening started the saved Pin once');
	await restoredPeer.act({ kind: 'hide-shell-agent', name });
	await until('the hidden card to leave both windows', async () =>
		!await cardIn(restoredWindow) && !await cardIn(restoredPeer) || undefined);
	assert.strictEqual((await inspect()).pid, restored.pid, 'Hide leaves the resumed agent running');
	await restoredWindow.act({ kind: 'open-shell-agent', name, address, text: 'reopened before removal' });
	await restoredWindow.act({ kind: 'shell-pin', name, set: true });
	checkSavedPin();
	await Promise.all([restoredWindow.close(), restoredPeer.close()]);
	console.log('  ✔ Both windows shared the Pin, reopened one original session, and hid the card while it kept running');

	run('rm', address);
	const afterRemove = await open(folder, 'sh');
	await until('explicit removal to clear the saved workspace member and Pin', () => {
		const saved = roster();
		return saved.members.length === 0 && saved.pins.length === 0 || undefined;
	});
	assert.strictEqual(await cardIn(afterRemove), undefined);
	assert.deepStrictEqual(starts().slice(priorStarts), [restored.pid], 'an explicit removal cannot reopen the saved session');
	await afterRemove.close();
	console.log('  ✔ Explicit removal cleared the saved member and Pin on reopen');
}

interface WindowJourney {
	readonly home: string;
	readonly remote: string | null;
	readonly folder: string;
	readonly peer: string;
	readonly shared: string;
	readonly files: WindowFiles;
}

function assertSameRun(actual: RunningAgent, expected: RunningAgent, message?: string): void {
	assert.deepStrictEqual(
		{ ...actual, cwd: normalizeDriveLetter(actual.cwd) },
		{ ...expected, cwd: normalizeDriveLetter(expected.cwd) },
		message
	);
}

async function expectViews(window: DrivenWindow, agent: string, count: number): Promise<void> {
	await until(`${agent} to have ${count} terminal views`, async () =>
		(await window.act<V3InspectResult>({ kind: 'inspect', agent })).viewers.length === count || undefined);
}

/** Go to Agent shares the same run. Both workspaces keep their Pin when it stops and restore one process. */
export async function rustMultiWindow(open: OpenWindow, journey: WindowJourney): Promise<void> {
	const { folder, peer, home, remote } = journey;
	let machineId: string | undefined;
	const start = async (place: string, profile: string) => {
		const window = await open(place, profile);
		machineId ??= window.ready.machineId;
		assert.deepStrictEqual({
			folder: normalizeDriveLetter(window.ready.folder), home: normalizeDriveLetter(window.ready.home),
			remote: window.ready.remote, machineId: window.ready.machineId
		}, { folder: normalizeDriveLetter(place), remote, home: normalizeDriveLetter(home), machineId });
		return window;
	};

	const first = await start(folder, 'a');
	const screen = 'Shared agent screen';
	const before = await first.act<RunningAgent>({ kind: 'start', screen });
	await expectAgent(first, before.id, false);
	const other = await start(peer, 'b');
	assert.deepStrictEqual((await other.act<WindowView>({ kind: 'snapshot' })).cards, [], 'an independent workspace starts without the agent');
	assertSameRun(await other.act<RunningAgent>({ kind: 'adopt', agent: before.id }), before);
	await expectAgent(other, before.id, false);
	await expectViews(first, before.id, 2);

	const sender = await other.act<RunningAgent>({ kind: 'start' });
	await other.act({ kind: 'send', agent: sender.id, to: before.id, text: 'Message from the other workspace' });
	await other.act({ kind: 'remove', agent: sender.id });
	await first.act({ kind: 'pin', agent: before.id });
	await other.act({ kind: 'pin', agent: before.id });
	await first.close();
	await expectViews(other, before.id, 1);
	await expectAgent(other, before.id, true);
	assertSameRun(await other.act<RunningAgent>({ kind: 'running', agent: before.id, screen }), before);
	const firstBack = await start(folder, 'a');
	await expectAgent(firstBack, before.id, true);
	await expectViews(other, before.id, 2);
	assertSameRun(await firstBack.act<RunningAgent>({ kind: 'running', agent: before.id, screen }), before);
	console.log('  ✔ Go to Agent shares the process and screen. Each workspace attaches and detaches its own view');

	await firstBack.act({ kind: 'stop', agent: before.id });
	await other.act({ kind: 'wait-for-exit', pid: before.pid });
	await until('both workspaces to retain the stopped agent and its Pin', async () => {
		const views = await Promise.all([firstBack, other].map(window => window.act<WindowView>({ kind: 'snapshot' })));
		return views.every(view => view.terminals === 0 && view.cards.length === 1 &&
			view.cards[0].id === before.id && view.cards[0].pinned && !view.cards[0].running) || undefined;
	});
	await Promise.all([firstBack.close(), other.close()]);
	const restored = await Promise.all([start(folder, 'a'), start(peer, 'b')]);
	await Promise.all(restored.map(window => expectAgent(window, before.id, true)));
	const [left, right] = await Promise.all(restored.map(window => window.act<RunningAgent>({ kind: 'running', agent: before.id })));
	assertSameRun(left, right, 'both workspaces restore the same process');
	assertSameRun({ ...left, pid: before.pid }, before, 'the resume kept the number, session and cwd');
	assert.notStrictEqual(left.pid, before.pid, 'the original process ended before the resume');
	console.log('  ✔ Both Pins restore the same stopped agent with its original session');

	await restored[0].act({ kind: 'remove', agent: before.id });
	await worktreeLifetime(restored[0], restored[1]);
	await Promise.all(restored.map(window => window.close()));
	await sameWorkspace(start, journey);
}

async function worktreeLifetime(source: DrivenWindow, peer: DrivenWindow): Promise<void> {
	const branch = 'agent-in-worktree';
	const agent = await source.act<V3AgentInfo>({ kind: 'worktree', branch });
	const parts = agent.cwd.split(/[\\/]/u);
	assert.deepStrictEqual(parts.slice(-2), [source.ready.folder.split(/[\\/]/u).at(-1) + '.worktrees', branch]);
	assert.deepStrictEqual((await source.act<WindowView>({ kind: 'snapshot' })).cards, [], 'a Shell start leaves the workspace unchanged');

	const adopted = await peer.act<RunningAgent>({ kind: 'adopt', agent: agent.agent_id });
	assert.strictEqual(adopted.pid, agent.pid);
	assert.strictEqual(normalizeDriveLetter(adopted.cwd), normalizeDriveLetter(agent.cwd));
	// Windows holds the worktree directory open until the process using it exits.
	const cwdLocksWorktree = source.ready.platform === 'win32';
	if (!cwdLocksWorktree) { await source.act({ kind: 'delete-worktree', folder: agent.cwd }); }
	const kept = await peer.act<RunningAgent>({ kind: 'running', agent: agent.agent_id });
	assertSameRun(kept, adopted, 'the peer holds the original worktree agent');
	await peer.act({ kind: 'remove', agent: agent.agent_id });
	await peer.act({ kind: 'wait-for-exit', pid: adopted.pid });
	if (cwdLocksWorktree) { await source.act({ kind: 'delete-worktree', folder: agent.cwd }); }
	console.log('  ✔ The peer attaches to the original worktree process, and Git removes its directory');
}

async function sameWorkspace(open: OpenWindow, journey: WindowJourney): Promise<void> {
	const folder = journey.shared;
	const left = await open(folder, 'c');
	const right = await open(folder, 'd');
	// The first terminal opens in a split whose narrow grid can wrap a longer marker.
	const agentLeft = await left.act<RunningAgent>({ kind: 'start', screen: 'First window', secondGroup: true });
	const agentRight = await right.act<RunningAgent>({ kind: 'start', screen: 'Second window' });
	const pinned = [agentLeft.id, agentRight.id].sort();
	for (const [window, local] of [[left, agentLeft], [right, agentRight]] as const) {
		await until('both cards with one local terminal in each window', async () => {
			const { cards, terminals } = await window.act<WindowView>({ kind: 'snapshot' });
			return isDeepStrictEqual(cards.map(card => card.id).sort(), pinned) && terminals === 1 &&
				cards.find(card => card.id === local.id)?.column !== null || undefined;
		});
	}
	await left.act({ kind: 'pin', agent: agentLeft.id });
	await right.act({ kind: 'pin', agent: agentRight.id });
	const { file } = await right.act<SavedPin>({ kind: 'saved-pin', agent: agentRight.id });
	const saved = JSON.parse(journey.files.read(file)) as { readonly pins: RustPin[] };
	const pinOrder = saved.pins.map(pin => pin.agent);
	assert.deepStrictEqual([...pinOrder].sort(), pinned, 'both Pin changes are saved in the same workspace');
	assert.ok(saved.pins.every(pin => pin.machine_id === left.ready.machineId));
	await left.act({ kind: 'filter' });

	const presentation = async (window: DrivenWindow, id: string) => {
		const snapshot = await window.act<WindowView>({ kind: 'snapshot' });
		return { column: snapshot.cards.find(each => each.id === id)?.column, filter: snapshot.filter };
	};
	const before = await Promise.all([presentation(left, agentLeft.id), presentation(right, agentRight.id)]);
	assert.strictEqual(before[0].filter?.kind, 'location');
	assert.strictEqual(before[1].filter, undefined);
	assert.deepStrictEqual(before.map(each => each.column), [2, 1]);

	await Promise.all([left.close(), right.close()]);
	const firstBack = await open(folder, 'c');
	const secondBack = await open(folder, 'd');
	for (const window of [firstBack, secondBack]) {
		await until('both Pins in the reopened workspace', async () => {
			const snapshot = await window.act<WindowView>({ kind: 'snapshot' });
			const shown = snapshot.cards.filter(card => card.pinned && card.column !== null).map(card => card.id).sort();
			return isDeepStrictEqual(shown, pinned) || undefined;
		});
	}
	const filters = await Promise.all([presentation(firstBack, agentLeft.id), presentation(secondBack, agentRight.id)]);
	assert.deepStrictEqual(filters.map(each => each.filter), before.map(each => each.filter));
	await expectViews(firstBack, agentLeft.id, 2);
	await expectViews(secondBack, agentRight.id, 2);
	console.log('  ✔ Two windows persist both Pins and keep their filters separate');
}
