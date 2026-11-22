/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFile, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import type { AgentInfo, DaemonHelloResult, InspectResult } from '../../base/coreProtocol';
import { isProcessRunning } from '../../base/system';
import type { RustPin } from '../../core/ports';
import { freePort, Workbench } from './cdpInput';
import { callInCore, coreCall, coreListens, detachedStartReference, endEditors, helloInCore, normalizeDriveLetter, until } from './editors';
import type { AttachView, SavedPin, WindowAction, WindowAnswer, WindowReady, WindowView } from './rustMultiWindowDriver';
import type { RunningAgent } from './rustWindowDriver';

/** The workspace driver and its helpers beside either copy of the extension. */
export function multiWindowDriverFiles(directory = __dirname): Readonly<Record<string, string>> {
	const source = (file: string) => fs.readFileSync(path.join(directory, file), 'utf8');
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
		const receive = async <Result>(file: string, acceptCleanExit = false): Promise<Result> => {
			try {
				const answer = await until(file, () => {
					const exited = acceptCleanExit && (editor.exitCode !== null || editor.signalCode !== null);
					const text = files.read(file);
					if (text) { return JSON.parse(text) as WindowAnswer; }
					// Remote-SSH can disconnect the workspace host before deactivate writes the close answer.
					if (exited) {
						assert.strictEqual(editor.exitCode, 0, `VS Code ${profile} did not exit cleanly`);
						return { result: true };
					}
					return undefined;
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
			const acceptCleanExit = action.kind === 'close' && editor.exitCode === null && editor.signalCode === null;
			files.write(`${request}.request`, JSON.stringify(action));
			return receive<Result>(`${request}.answer`, acceptCleanExit);
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

/** An expired agent with a missing session and a deliberately unpinned agent on the same real reopen. */
export async function missingSessionUnpin(open: OpenWindow, folder: string, env: NodeJS.ProcessEnv): Promise<void> {
	const home = env.FACADE_HOME!;
	const first = await open(folder, 'pins');
	assert.strictEqual(normalizeDriveLetter(first.ready.home), normalizeDriveLetter(home));
	assert.ok(first.ready.machineId && first.ready.remote === null, 'the local window observed the real Core machine');
	const missing = await first.act<RunningAgent>({ kind: 'start' });
	const unpinned = await first.act<RunningAgent>({ kind: 'start' });
	assert.notStrictEqual(missing.session, unpinned.session);
	const transcript = (agent: RunningAgent) =>
		path.join(env.CLAUDE_CONFIG_DIR!, 'projects', agent.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${agent.session}.jsonl`);
	const validSession = fs.readFileSync(transcript(unpinned), 'utf8');
	assert.ok(fs.existsSync(transcript(missing)));
	await first.act({ kind: 'pin', agent: missing.id });
	await first.act({ kind: 'pin', agent: unpinned.id });
	const { file, pin } = await first.act<SavedPin>({ kind: 'saved-pin', agent: missing.id });
	assert.deepStrictEqual([pin.machine_id, pin.conversation.sessionId], [first.ready.machineId, missing.session]);
	const pins = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as { pins: RustPin[] }).pins.map(each => each.agent).sort();
	assert.deepStrictEqual(pins(), [missing.id, unpinned.id].sort());
	await first.act({ kind: 'stop', agent: missing.id });
	await first.act({ kind: 'stop', agent: unpinned.id });
	await first.act({ kind: 'unpin', agent: unpinned.id });
	assert.deepStrictEqual(pins(), [missing.id], 'only the other Pin remains on disk before reopening');
	await first.close();
	await until('the isolated Core daemon to idle out before aging the fixture', () => !coreListens(home) || undefined, 45_000);

	// Change only the stopped fixture's timestamp while its own daemon is down. Core writes the expiry record on startup.
	const { DatabaseSync } = await import('node:sqlite');
	const db = new DatabaseSync(path.join(home, 'core', 'facade.db'));
	try {
		const aged = db.prepare('UPDATE agents SET exit_at = ? WHERE agent_id = ? AND session = ? AND pid = ? AND exit_at IS NOT NULL')
			.run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), missing.id, missing.session, missing.pid);
		assert.strictEqual(aged.changes, 1);
	} finally {
		db.close();
	}
	fs.unlinkSync(transcript(missing));

	const recordDir = path.dirname(env.FACADE_IT_RECORD!);
	const prefix = path.basename(env.FACADE_IT_RECORD!) + '.starts.#';
	const launches = () => Object.fromEntries(fs.readdirSync(recordDir).filter(name => name.startsWith(prefix)).map(name => {
		const pidList = fs.readFileSync(path.join(recordDir, name), 'utf8').trim();
		return [name.slice(prefix.length), pidList.split(/\r?\n/u).map(Number)];
	}));
	const original = { [missing.id]: [missing.pid], [unpinned.id]: [unpinned.pid] };
	assert.deepStrictEqual(launches(), original);

	const reopened = await open(folder, 'pins');
	assert.strictEqual(reopened.ready.machineId, first.ready.machineId);
	const removed = await callInCore(home, 'agent.inspect', { target: { machine_id: pin.machine_id, agent_id: missing.id } });
	assert.ok('error' in removed, JSON.stringify(removed));
	assert.deepStrictEqual([removed.error.data.reason, removed.error.data.details?.record_removal], ['not_found', 'expired']);
	const notice = `Removed the Pin for ${pin.name} because its saved session is gone.`;
	const workbench = await reopened.workbench();
	try {
		await reopened.act({ kind: 'show-notifications' });
		const containsNotice = `Array.from(document.querySelectorAll('.notification-list-item-message'))
			.some(node => node.textContent?.trim() === ${JSON.stringify(notice)})`;
		await until('the missing-session notice in the real workbench', async () =>
			await workbench.cdp.evaluate<boolean>(containsNotice) || undefined);
	} finally {
		workbench.cdp.close();
	}
	assert.deepStrictEqual(pins(), [], 'the confirmed-missing session clears its Pin');
	const view = await reopened.act<WindowView>({ kind: 'snapshot' });
	assert.deepStrictEqual(view.cards.map(card => [card.id, card.running, card.pinned]), [[unpinned.id, false, false]]);
	assert.strictEqual(view.terminals, 0);
	const { agent } = await reopened.act<InspectResult>({ kind: 'inspect', agent: unpinned.id });
	assert.deepStrictEqual([agent.process, agent.session], ['ended', unpinned.session]);
	assert.strictEqual(fs.readFileSync(transcript(unpinned), 'utf8'), validSession, 'the intentionally unpinned session remains available');
	assert.deepStrictEqual((await coreCall(home, 'agent.list', {})).agents, []);
	await reopened.close();
	assert.deepStrictEqual(launches(), original, 'neither the missing nor the deliberately unpinned session launched');
	console.log('  ✔ Missing session removed its Pin and showed the workbench notice. Unpin prevented a second launch. ' +
		JSON.stringify({ home, expired: missing.id, unpinned: unpinned.id, notice, launches: original }));
}

/** Go to Agent attaches to a Shell run that survives closing the VS Code window. */
export async function shellHandoff(open: OpenWindow, folder: string, facade: string, env: NodeJS.ProcessEnv): Promise<void> {
	const run = (...args: string[]) => execFileSync(facade, args, { cwd: folder, env, encoding: 'utf8', timeout: 20_000 });
	const home = env.FACADE_HOME!;
	const name = 'shell-ada';
	const prompt = 'Review the isolated Shell handoff';
	const branch = 'shell-handoff-worktree';
	const worktree = path.join(`${folder}.worktrees`, branch);
	const [started, location, ...extra] = run('start', '-d', '--name', name, '--worktree', branch, 'codex', '--', prompt).trimEnd().split(/\r?\n/u);
	const address = detachedStartReference(started, name);
	assert.ok(location?.startsWith('Worktree: '));
	assert.deepStrictEqual([normalizeDriveLetter(location.slice('Worktree: '.length)), extra], [normalizeDriveLetter(worktree), []]);
	const inspect = async () => (await coreCall(home, 'agent.inspect', { target: address })).agent;
	const before = await inspect();
	assert.ok(before.pid && before.process === 'running');
	assert.strictEqual(before.address, address);
	assert.strictEqual(normalizeDriveLetter(fs.realpathSync(before.cwd)), normalizeDriveLetter(fs.realpathSync(worktree)));
	assert.strictEqual(execFileSync('git', ['branch', '--show-current'], { cwd: worktree, encoding: 'utf8' }).trim(), branch);
	const launchFile = `${env.FACADE_IT_RECORD}.args.#${before.reference.agent_id}`;
	const launch = await until('the Shell start argv at the fake CLI', () => fs.existsSync(launchFile)
		? JSON.parse(fs.readFileSync(launchFile, 'utf8')) as { readonly args: string[]; readonly cwd: string }
		: undefined);
	assert.strictEqual(normalizeDriveLetter(fs.realpathSync(launch.cwd)), normalizeDriveLetter(fs.realpathSync(worktree)));
	assert.deepStrictEqual(launch.args.filter(arg => arg === '--' || arg === prompt), ['--', prompt], 'the two Shell arguments each arrive once');
	assert.deepStrictEqual(launch.args.slice(-2), ['--', prompt], 'the prompt follows its separator at the end of argv');
	const window = await open(folder, 'sh');
	assert.strictEqual(await window.act<boolean>({ kind: 'window-component' }), false);
	const status = run('status');
	const settingsFile = /^Settings {2,}([^\r\n]+)$/mu.exec(status)?.[1];
	assert.ok(settingsFile, status);
	assert.strictEqual(settingsFile, (await coreCall(home, 'daemon.status', {})).settings_file);
	assert.ok(path.isAbsolute(settingsFile ?? ''), 'status gives the absolute settings file');
	assert.strictEqual(normalizeDriveLetter(settingsFile), normalizeDriveLetter(path.join(home, 'facade.json')));
	await window.act({ kind: 'settings-path', file: settingsFile });
	const marker = 'typed in the isolated editor';
	await window.act({ kind: 'open-shell-agent', name, address, text: marker });
	await window.close();
	const after = await inspect();
	assert.strictEqual(after.address, address);
	assert.strictEqual(after.pid, before.pid);
	assert.strictEqual(after.cwd, before.cwd);
	assert.strictEqual(after.process, 'running');

	execFileSync(process.execPath, [path.join(__dirname, 'shellAttachFixture.js'), facade, address, marker], { cwd: folder, env, timeout: 65_000 });
	assert.strictEqual((await inspect()).pid, before.pid);
	console.log('  ✔ Shell start, Go to Agent and Shell Attach used the same terminal after closing VS Code');

	const session = await until('the fake CLI to report its session', async () => (await inspect()).session);
	const startLog = `${env.FACADE_IT_RECORD}.starts.#${before.reference.agent_id}`;
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
		const core = await callInCore(env.FACADE_HOME!, 'agent.inspect', { target: address }).catch(error => String(error));
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
		assert.deepStrictEqual(saved.members, [before.reference]);
		assert.strictEqual(saved.pins.length, 1, 'the workspace saves one Pin');
		assert.strictEqual(saved.pins[0].machine_id, before.reference.machine_id);
		assert.strictEqual(saved.pins[0].agent, before.reference.agent_id);
	};
	checkSavedPin();
	const restored = await inspect();
	assert.strictEqual(restored.address, address);
	assert.strictEqual(restored.process, 'running');
	assert.strictEqual(restored.session, session);
	assert.notStrictEqual(restored.pid, before.pid);
	assert.deepStrictEqual(starts().slice(priorStarts), [restored.pid], 'reopening started the saved Pin once');
	await restoredPeer.act({ kind: 'hide-shell-agent', name });
	await until('the hidden card, tab, workspace member and Pin to go', async () => {
		const views = await Promise.all([restoredWindow, restoredPeer].map(window => window.act<WindowView>({ kind: 'snapshot' })));
		const saved = roster();
		return views.every(view => !view.cards.some(card => card.name === name) && view.terminals === 0)
			&& saved.members.length === 0 && saved.pins.length === 0 || undefined;
	});
	assert.strictEqual((await inspect()).pid, restored.pid, 'Hide leaves the resumed agent running');
	await restoredWindow.act({ kind: 'open-shell-agent', name, address, text: 'reopened before removal' });
	await restoredWindow.act({ kind: 'shell-pin', name, set: true });
	checkSavedPin();
	await Promise.all([restoredWindow.close(), restoredPeer.close()]);
	console.log('  ✔ Both windows shared the Pin, reopened one original session, and hid the card while it kept running');

	const reference = before.reference;
	assert.deepStrictEqual(await coreCall(home, 'agent.remove', { target: reference }), { reference, address });
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

/** Complete the prerelease editor's import and reopen its workspace storage on API v1. */
export async function coldCutoverJourney(
	open: OpenWindow, folder: string, env: NodeJS.ProcessEnv,
	prerelease: string, current: string, selectV1: () => void
): Promise<void> {
	const run = (program: string, ...args: string[]) =>
		execFileSync(program, args, { cwd: folder, env, encoding: 'utf8', timeout: 30_000 });
	const home = env.FACADE_HOME!;
	const name = 'cold-cutover';
	const marker = 'typed before API v1 cold cutover';
	const address = detachedStartReference(run(prerelease, 'start', '-d', '--name', name, 'qa-fake'), name);
	const initial = await open(folder, 'cold');
	assert.ok(initial.ready.machineId);
	const agent = address.split('@')[0];
	await initial.act({ kind: 'open-shell-agent', name, address, text: marker });
	await initial.act({ kind: 'shell-pin', name, set: true });
	const { file, pin } = await initial.act<SavedPin>({ kind: 'saved-pin', agent });
	assert.strictEqual(pin.machine_id, initial.ready.machineId);
	const reference = { machine_id: pin.machine_id, agent_id: pin.agent };
	const roster = () => JSON.parse(fs.readFileSync(file, 'utf8')) as {
		readonly imported: boolean; readonly importedPins: boolean; readonly legacyWorkspaceKey?: string;
		readonly members: readonly typeof reference[]; readonly pins: readonly RustPin[];
	};
	assert.deepStrictEqual(roster().members, [reference]);
	await initial.close();

	// Seed the old Pin file from the actual Pin. The editor's existing URI ledger binds its key.
	const legacy = path.join(path.dirname(file), 'workspace-state.json');
	assert.ok(!fs.existsSync(legacy), legacy);
	fs.renameSync(file, `${file}.fixture-preimage`);
	fs.writeFileSync(legacy, JSON.stringify({ 'facade.pins': [pin] }));
	const imported = await open(folder, 'cold');
	const ready = await until('the prerelease editor to finish import', () => {
		if (!fs.existsSync(file)) { return undefined; }
		const saved = roster();
		return saved.imported && saved.importedPins ? saved : undefined;
	});
	assert.strictEqual(ready.legacyWorkspaceKey, path.basename(path.dirname(file)));
	assert.deepStrictEqual(ready.members, [reference]);
	await imported.close();
	const lock = (service: string) =>
		JSON.parse(fs.readFileSync(path.join(home, 'core', `${service}.lock`), 'utf8')) as { pid: number; birth: string };
	const old = { daemon: lock('daemon'), keeper: lock('keeper') };
	run(prerelease, 'stop', address);
	await until('both prerelease services to exit', () =>
		Object.values(old).every(service => !isProcessRunning(service.pid)) || undefined, 55_000);

	const beforeCutover = roster();
	assert.deepStrictEqual(beforeCutover.members, [reference]);
	run(current, 'list', '--local');
	assert.deepStrictEqual(roster(), beforeCutover);
	assert.notDeepStrictEqual(lock('daemon'), old.daemon);
	assert.notDeepStrictEqual(lock('keeper'), old.keeper);
	const { agent: finished } = await coreCall(home, 'agent.inspect', { target: reference });
	assert.deepStrictEqual(finished.reference, reference);
	assert.strictEqual(finished.process, 'ended');
	const history = run(current, 'screen', address, '--lines', '120');
	assert.ok(history.includes(marker), history);

	const { locations } = await coreCall(home, 'location.list', { scope: { kind: 'local' }, folders: [pin.cwd] });
	const workspaceLocation = locations.find(location => normalizeDriveLetter(location.path) === normalizeDriveLetter(pin.cwd));
	assert.ok(workspaceLocation, 'the saved Pin has a registered location for its cwd');
	// Pin recovery can run before the location catalog is ready and use the same Agent's cwd key.
	const locationKeys = [workspaceLocation.location_id, `${pin.machine_id}:${pin.cwd}`];
	const expectPin = (pins: readonly RustPin[]) => {
		assert.strictEqual(pins.length, 1);
		const [restored] = pins;
		assert.ok(locationKeys.includes(restored.location), restored.location);
		assert.deepStrictEqual(restored, { ...pin, location: restored.location });
	};
	expectPin([pin]);
	expectPin(ready.pins);
	expectPin(beforeCutover.pins);
	selectV1();
	const reopened = await open(folder, 'cold');
	assert.strictEqual(reopened.ready.machineId, pin.machine_id);
	await reopened.act({ kind: 'shell-pin', name });
	const saved = await reopened.act<SavedPin>({ kind: 'saved-pin', agent });
	assert.strictEqual(saved.file, file);
	assert.deepStrictEqual(roster().members, [reference]);
	expectPin([saved.pin]);
	await reopened.close();
	console.log(`  ✔ Prerelease import and API v1 cold cutover kept the workspace member, finished transcript and Pin ${pin.id}. Daemon ${JSON.stringify(old.daemon)} and keeper ${JSON.stringify(old.keeper)} exited before restart.`);
}

/** Exercise simultaneous product viewers on the same native fake CLI. */
export async function sharedAttachJourney(open: OpenWindow, folder: string, facade: string, env: NodeJS.ProcessEnv, replacement?: string): Promise<void> {
	const run = (program: string, ...args: string[]) =>
		execFileSync(program, args, { cwd: folder, env, encoding: 'utf8', timeout: 30_000 });
	const home = env.FACADE_HOME!;
	const name = 'shell-attach';
	const address = detachedStartReference(run(facade, 'start', '-d', '--name', name, 'qa-fake'), name);
	const inspect = async () => (await coreCall(home, 'agent.inspect', { target: address })).agent;
	const before = await inspect();
	assert.ok(before.pid && before.process === 'running', JSON.stringify(before));
	const window = await open(folder, 'attach');
	const marker = 'typed in the editor';
	await window.act({ kind: 'open-shell-agent', name, address, text: marker });
	if (replacement) {
		const version = (program: string) => /^facade (\d+\.\d+\.\d+)$/u.exec(run(program, '--version').trim())?.[1];
		const old = version(facade);
		const next = version(replacement);
		assert.ok(old && next && old !== next, 'Select two different numeric package versions.');
		const lock = (service: 'daemon' | 'keeper') =>
			JSON.parse(fs.readFileSync(path.join(home, 'core', `${service}.lock`), 'utf8')) as { pid: number; birth: string };
		const accepted = async () => {
			const hello = await helloInCore(home);
			assert.ok('result' in hello, JSON.stringify(hello));
			const ready = hello.result as DaemonHelloResult;
			assert.ok(ready.api_version === 1 && ready.topics.includes('attach') && ready.ops.includes('attach.resize'), JSON.stringify(hello));
			return ready;
		};
		const daemon = lock('daemon');
		const keeper = lock('keeper');
		assert.strictEqual((await accepted()).build.split('+')[0], old);
		const retained = 'input after v1 daemon takeover';
		run(replacement, 'type', address, retained, '--enter');
		assert.strictEqual((await accepted()).build.split('+')[0], next);
		const changed = lock('daemon');
		assert.notStrictEqual(changed.pid, daemon.pid);
		assert.notStrictEqual(changed.birth, daemon.birth);
		assert.deepStrictEqual(lock('keeper'), keeper);
		assert.strictEqual((await inspect()).pid, before.pid);
		await window.act<AttachView>({ kind: 'shell-attach-view', text: retained });
		console.log(`  ✔ The existing VS Code Attach recovered across v1 builds ${old} → ${next}. Daemon ${JSON.stringify(daemon)} → ${JSON.stringify(changed)}, keeper ${JSON.stringify(keeper)}, CLI PID ${before.pid}`);
	}
	await sharedShellAttach(window, folder, replacement ?? facade, env, address, marker);
	const old = await open(folder, 'old-engine');
	assert.strictEqual(old.ready.machineId, null);
	const view = await old.act<WindowView>({ kind: 'snapshot' });
	assert.ok(!view.cards.some(card => card.name === name), JSON.stringify(view));
	assert.strictEqual(view.terminals, 0);
	await old.close();
	console.log('  ✔ The separately profiled old engine left the Core agent and terminal alone');
	await window.close();
	const after = await inspect();
	assert.strictEqual(after.pid, before.pid);
	assert.strictEqual(after.process, 'running');
	run(replacement ?? facade, 'stop', address);
}

/** RULES-6.3. Real Shell and VS Code views apply a shared grid and keep their own capacity. */
async function sharedShellAttach(window: DrivenWindow, folder: string, facade: string, env: NodeJS.ProcessEnv, address: string, editorText: string): Promise<void> {
	const initial = await window.act<AttachView>({ kind: 'shell-attach-view' });
	assert.deepStrictEqual(initial.grid, initial.capacity);
	const small = { columns: Math.floor(initial.capacity.columns / 2), rows: Math.floor(initial.capacity.rows / 2) };
	assert.ok(small.columns >= 10 && small.rows >= 6, JSON.stringify(initial));
	const control = `${env.FACADE_IT_RECORD}.attach`;
	const shellText = 'typed in the Shell';
	const shell = new Promise<Error | undefined>(resolve => {
		execFile(process.execPath, [
			path.join(__dirname, 'shellAttachFixture.js'), facade, address, editorText,
			control, String(small.columns), String(small.rows), shellText
		], { cwd: folder, env, timeout: 120_000 }, (error, _out, stderr) =>
			resolve(error ? new Error(`${error.message}\n${stderr}`) : undefined));
	});
	let resized: AttachView;
	try {
		await until('the smaller Shell Attach to echo its input', () => fs.existsSync(`${control}.ready`) || undefined);
		const shared = await window.act<AttachView>({ kind: 'shell-attach-view', grid: small, text: shellText });
		assert.deepStrictEqual(shared.capacity, initial.capacity);
		resized = await window.act<AttachView>({ kind: 'shell-attach-view', grid: small, resize: true });
		assert.ok(resized.capacity.columns > small.columns && resized.capacity.rows > small.rows, JSON.stringify(resized));
	} finally {
		fs.writeFileSync(`${control}.detach`, '1');
		const failure = await shell;
		if (failure) { throw failure; }
	}
	const grown = await window.act<AttachView>({ kind: 'shell-attach-view', grid: resized.capacity });
	assert.deepStrictEqual(grown.grid, grown.capacity);
	console.log('  ✔ Shell and VS Code shared a grid, echoed live input and grew after detach');
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
		(await window.act<InspectResult>({ kind: 'inspect', agent })).viewers.length === count || undefined);
}

/** Go to Agent shares the same run. Both workspaces keep their Pin when it stops and restore one process. */
export async function rustMultiWindow(open: OpenWindow, journey: WindowJourney): Promise<void> {
	const { folder, peer, home, remote } = journey;
	let machineId: string | undefined;
	const start = async (place: string, profile: string) => {
		const window = await open(place, profile);
		assert.ok(window.ready.machineId);
		machineId ??= window.ready.machineId;
		assert.deepStrictEqual({
			folder: normalizeDriveLetter(window.ready.folder), home: normalizeDriveLetter(window.ready.home),
			remote: window.ready.remote, machineId: window.ready.machineId
		}, { folder: normalizeDriveLetter(place), remote, home: normalizeDriveLetter(home), machineId });
		return window;
	};

	const first = await start(folder, 'a');
	if (journey.remote === null) {
		assert.ok(await first.act<boolean>({ kind: 'terminal-owner' }), 'the local Window Component owns this VS Code session');
	}
	const screen = 'Shared agent screen';
	const before = await first.act<RunningAgent>({ kind: 'start', screen });
	await expectAgent(first, before.id, false);
	const other = await start(peer, 'b');
	assert.deepStrictEqual((await other.act<WindowView>({ kind: 'snapshot' })).cards, [], 'an independent workspace starts without the agent');
	assertSameRun(await other.act<RunningAgent>({ kind: 'adopt', agent: before.id }), before);
	await expectAgent(other, before.id, false);
	await expectViews(first, before.id, 2);

	const sender = await other.act<RunningAgent>({ kind: 'start' });
	await other.act({ kind: 'send', to: before.id, text: 'Message from the other workspace' });
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
	const agent = await source.act<AgentInfo>({ kind: 'worktree', branch });
	const parts = agent.cwd.split(/[\\/]/u);
	assert.deepStrictEqual(parts.slice(-2), [source.ready.folder.split(/[\\/]/u).at(-1) + '.worktrees', branch]);
	assert.deepStrictEqual((await source.act<WindowView>({ kind: 'snapshot' })).cards, [], 'a Shell start leaves the workspace unchanged');

	const adopted = await peer.act<RunningAgent>({ kind: 'adopt', agent: agent.reference.agent_id });
	assert.strictEqual(adopted.pid, agent.pid);
	assert.strictEqual(normalizeDriveLetter(adopted.cwd), normalizeDriveLetter(agent.cwd));
	// Windows holds the worktree directory open until the process using it exits.
	const cwdLocksWorktree = source.ready.platform === 'win32';
	if (!cwdLocksWorktree) { await source.act({ kind: 'delete-worktree', folder: agent.cwd }); }
	const kept = await peer.act<RunningAgent>({ kind: 'running', agent: agent.reference.agent_id });
	assertSameRun(kept, adopted, 'the peer holds the original worktree agent');
	await peer.act({ kind: 'remove', agent: agent.reference.agent_id });
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
