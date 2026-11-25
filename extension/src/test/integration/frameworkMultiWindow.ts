/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFile, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'readline';
import { isDeepStrictEqual } from 'util';
import type { AgentInfo, AgentRef, DaemonHelloResult, HelloParams, HelloResult, InspectResult } from '../../base/frameworkProtocol';
import { isProcessRunning } from '../../base/system';
import type { OwnerClaim } from '../../base/ownership';
import { ptydRecords, recordedPtyds } from '../../base/ptydRegistry';
import { PtydClient } from '../../host/execution/ptydClient';
import { isCurrentOwner, writeAsOwner } from '../../record/ownership';
import type { Pin, FrameworkPin } from '../../core/ports';
import { freePort, Workbench } from './cdpInput';
import { callInFramework, frameworkCall, frameworkListens, frameworkSocket, detachedStartReference, endEditors, helloInFramework, normalizeDriveLetter, until } from './editors';
import type { AttachView, SavedPin, WindowAction, WindowAnswer, WindowReady, WindowView } from './frameworkMultiWindowDriver';
import type { RunningAgent } from './frameworkWindowDriver';

/** The workspace driver and its helpers beside the extension. */
export function multiWindowDriverFiles(): Readonly<Record<string, string>> {
	const source = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf8');
	return {
		'package.json': JSON.stringify({
			name: 'framework-multi-window-driver', publisher: 'facade-it', version: '0.0.0',
			engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], extensionKind: ['workspace'], main: './extension.js'
		}),
		'extension.js': source('frameworkMultiWindowDriver.js'),
		'frameworkWindowDriver.js': source('frameworkWindowDriver.js'),
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
	close(options?: { readonly waitForExit: boolean }): Promise<void>;
	workbench(): Promise<Workbench>;
}

type OpenWindow = (folder: string, profile: string) => Promise<DrivenWindow>;
type StartEditor = (folder: string, profile: string, control: string, port: number) => ChildProcess;

/** Start each window with its own profile and mailbox and reap exactly the editors the journey started. */
export async function withFrameworkWindows(files: WindowFiles, start: StartEditor, journey: (open: OpenWindow) => Promise<void>): Promise<void> {
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
			close: async (options) => {
				await act<boolean>({ kind: 'close', quit: options?.waitForExit });
				if (process.platform !== 'win32' && !options?.waitForExit) {
					await endEditors([editor]);
					return;
				}
				// The driver's reply comes during shutdown. Wait for VS Code to flush its profile before reopening.
				try {
					await until(`the VS Code process for ${profile} to exit`, () =>
						editor.exitCode !== null || editor.signalCode !== null || undefined, 20_000);
				} finally {
					console.log(`  VS Code ${profile} after shutdown has exit code ${editor.exitCode} and signal ${editor.signalCode ?? 'none'}`);
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

/** Two actual legacy implementation windows replace the active claim for one workspace and keep both original agents. */
export async function staleOwner(open: OpenWindow, folder: string, env: NodeJS.ProcessEnv): Promise<void> {
	const home = path.join(env.FACADE_HOME!, 'extension');
	const claim = () => {
		const directory = path.join(home, 'claims');
		const files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
		assert.strictEqual(files.length, 1, 'exactly this fixture workspace has a claim');
		return JSON.parse(fs.readFileSync(path.join(directory, files[0]), 'utf8')) as OwnerClaim;
	};
	const first = await open(folder, 'legacy');
	assert.strictEqual(first.ready.machineId, null, 'the legacy implementation owns the agents');
	const start = () => first.act<{ runId: string; alias: string }>({ kind: 'start-fallback' });
	const agents = [await start(), await start()] as const;
	const runs = [agents[0].runId, agents[1].runId] as const;
	assert.notStrictEqual(runs[0], runs[1]);
	for (const run of runs) { await first.act({ kind: 'pin-owned', run }); }
	const oldPage = await first.act<string>({ kind: 'panel-generation' });
	const previous = claim();
	const stateFile = path.join(home, 'workspaces', previous.owner, 'workspace-state.json');
	const savedPins = (): readonly string[] => {
		const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { readonly 'facade.pins'?: readonly Pick<Pin, 'id'>[] };
		return (state['facade.pins'] ?? []).map(pin => pin.id);
	};
	const services = recordedPtyds(ptydRecords(path.join(home, 'ptyd')));
	assert.strictEqual(services.length, 1, 'the two actual fake CLIs use one legacy supervisor');
	const service = services[0];
	const ptyd = await PtydClient.connect(service.socket, '', path.join(home, 'ptyd', 'unused.log'), { start: false, protocol: service.protocol });
	const list = () => ptyd.request('list', { owner: previous.owner });
	const snapshot = async () => (await list()).map(row => ({
		run: row.run, pid: row.pid, cwd: row.cwd, startedAt: row.startedAt, exited: row.exited, name: row.meta.name
	})).sort((a, b) => a.run.localeCompare(b.run));
	try {
		const original = await snapshot();
		assert.deepStrictEqual(original.map(row => row.run), [...runs].sort((a, b) => a.localeCompare(b)));
		for (const agent of agents) {
			const recorded = Number(fs.readFileSync(`${env.FACADE_IT_RECORD}.${agent.alias}`, 'utf8').trim());
			assert.ok(recorded > 0 && isProcessRunning(recorded));
			assert.strictEqual(original.find(row => row.run === agent.runId)?.pid, recorded);
		}
		const pins = await until('both runs’ durable Pins', async () => {
			const saved = savedPins();
			const live = await list();
			const linked = runs.map(run => live.find(row => row.run === run)?.meta.pin);
			return saved.length === runs.length && new Set(linked).size === runs.length
				&& linked.every(id => typeof id === 'string' && saved.includes(id)) ? saved : undefined;
		});
		await first.close({ waitForExit: true });
		assert.deepStrictEqual(savedPins(), pins, 'the predecessor saved both exact Pins through normal shutdown');
		console.log(`  ✔ Both original Pins survived the predecessor’s clean exit (${pins.join(', ')})`);
		const successor = await open(folder, 'new');
		assert.strictEqual(successor.ready.machineId, null);
		assert.notStrictEqual(successor.ready.hostPid, first.ready.hostPid);
		const current = claim();
		assert.strictEqual(current.owner, previous.owner);
		assert.strictEqual(current.generation, previous.generation + 1);
		assert.notStrictEqual(current.token, previous.token);
		assert.strictEqual(isCurrentOwner(current, home), true);
		const before = fs.readFileSync(stateFile);
		assert.strictEqual(writeAsOwner(previous, home, () => assert.fail('a stale writer reached the current workspace record')), false);
		assert.deepStrictEqual(fs.readFileSync(stateFile), before);
		await assert.rejects(ptyd.request('claim', previous), /ownership was transferred or expired/i);
		for (const run of runs) {
			await assert.rejects(ptyd.request('input', { run, data: 'unexpected stale input' }), /ownership was transferred or expired/i);
			await assert.rejects(ptyd.request('terminate', { run, graceMs: 0 }), /ownership was transferred or expired/i);
		}
		const replay = await successor.act<{ page: string; refusedActions: number }>({ kind: 'stale-owner', previous, current, page: oldPage, runs });
		assert.deepStrictEqual(await snapshot(), original, 'both exact fake CLI processes survived stale effects');
		assert.strictEqual(replay.refusedActions, 2);
		console.log(`  ✔ Stale claim ${previous.generation} lost to ${current.generation}; stale page ${oldPage} changed neither run; current page ${replay.page} unpinned only ${runs[0]}; original fake PIDs ${original.map(row => row.pid).join(', ')}`);
		for (const runId of runs) { await successor.act({ kind: 'stop-fallback', runId }); }
		await successor.close();
	} finally { ptyd.dispose(); }
}

async function expectListed(window: DrivenWindow, id: string): Promise<void> {
	await until(`${id}'s running card with no terminal in ${window.ready.folder}`, async () => {
		const { cards, terminals } = await window.act<WindowView>({ kind: 'snapshot' });
		return terminals === 0 && cards.some(card => card.id === id && card.running && !card.pinned && card.column === null) || undefined;
	});
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
	assert.ok(first.ready.machineId && first.ready.remote === null, 'the local window observed the real Framework machine');
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
	const pins = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as { pins: FrameworkPin[] }).pins.map(each => each.agent).sort();
	assert.deepStrictEqual(pins(), [missing.id, unpinned.id].sort());
	await first.act({ kind: 'stop', agent: missing.id });
	await first.act({ kind: 'stop', agent: unpinned.id });
	await first.act({ kind: 'unpin', agent: unpinned.id });
	assert.deepStrictEqual(pins(), [missing.id], 'only the other Pin remains on disk before reopening');
	await first.close();
	await until('the isolated Framework daemon to idle out before aging the fixture', () => !frameworkListens(home) || undefined, 45_000);

	// Change only the stopped fixture's timestamp while its own daemon is down. Framework writes the expiry record on startup.
	const { DatabaseSync } = await import('node:sqlite');
	const db = new DatabaseSync(path.join(home, 'framework', 'facade.db'));
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
	const removed = await callInFramework(home, 'agent.inspect', { target: { machine_id: pin.machine_id, agent_id: missing.id } });
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
	assert.deepStrictEqual((await frameworkCall(home, 'agent.list', {})).agents, []);
	await reopened.close();
	assert.deepStrictEqual(launches(), original, 'neither the missing nor the deliberately unpinned session launched');
	console.log('  ✔ Missing session removed its Pin and showed the workbench notice. Unpin prevented a second launch. ' +
		JSON.stringify({ home, expired: missing.id, unpinned: unpinned.id, notice, launches: original }));
}

/** A present but unlaunchable staged Framework falls back to one usable legacy implementation panel. */
export async function activationFailure(open: OpenWindow, folder: string, env: NodeJS.ProcessEnv, faultProgram: string): Promise<void> {
	const home = env.FACADE_HOME!;
	const record = env.FACADE_IT_RECORD!;
	const launches = () => fs.readdirSync(path.dirname(record)).filter(file => file.startsWith(`${path.basename(record)}.starts.`));
	const window = await open(folder, 'fault');
	assert.strictEqual(normalizeDriveLetter(window.ready.home), normalizeDriveLetter(home));
	assert.deepStrictEqual([window.ready.remote, window.ready.machineId], [null, null]);
	assert.ok(!frameworkListens(home), 'there is no Framework daemon for this fixture');
	assert.deepStrictEqual(await window.act<WindowView>({ kind: 'snapshot' }), { cards: [], terminals: 0 });
	assert.deepStrictEqual(launches(), [], 'activation did not launch an agent');
	const warningStart = `The legacy implementation is active on ${os.hostname()}. Could not connect to the Orchestrator. Could not run ${faultProgram}: `;
	const warningEnd = 'Fix the problem, set facade.framework to `auto`, and reload the window to try Facade Code Framework again.';
	const workbench = await window.workbench();
	let warning: string;
	try {
		await window.act({ kind: 'show-notifications' });
		const warningText = `Array.from(document.querySelectorAll('.notification-list-item-message'))
			.map(node => node.textContent?.trim()).find(text => text?.startsWith(${JSON.stringify(warningStart)})
				&& text.endsWith(${JSON.stringify(warningEnd)}))`;
		warning = await until('the startup warning naming the failed Framework executable and recovery', async () =>
			await workbench.cdp.evaluate<string | undefined>(warningText));
	} finally {
		workbench.cdp.close();
	}
	const agent = await window.act<{ runId: string; alias: string; name: string }>({ kind: 'start-fallback' });
	const launchFile = `${record}.starts.${agent.alias}`;
	const pids = () => fs.readFileSync(launchFile, 'utf8').trim().split(/\r?\n/u).map(Number);
	const pid = await until('the legacy implementation fake CLI PID', () => fs.existsSync(launchFile) ? pids()[0] || undefined : undefined);
	assert.ok(isProcessRunning(pid), 'the fake CLI is alive');
	const view = await window.act<WindowView>({ kind: 'snapshot' });
	assert.deepStrictEqual(view.cards.map(card => [card.id, card.name]), [[agent.alias, agent.name]]);
	assert.strictEqual(view.terminals, 1);
	assert.ok(!frameworkListens(home));
	await window.act({ kind: 'stop-fallback', runId: agent.runId });
	await until('the one legacy implementation fake CLI to stop', () => !isProcessRunning(pid) || undefined);
	await window.close();
	assert.deepStrictEqual(launches(), [path.basename(launchFile)]);
	assert.deepStrictEqual(pids(), [pid], 'the one requested legacy run launched exactly one process');
	assert.ok(!frameworkListens(home));
	console.log('  ✔ Framework startup failed visibly. The legacy panel served one requested agent and its process stopped. ' +
		JSON.stringify({ home, warning, before: 0, after: { alias: agent.alias, pids: pids() }, cliStopped: true }));
}

/** An incompatible hello refuses activation, including the actual Facade webview and commands. */
export async function incompatibleActivation(open: OpenWindow, folder: string, env: NodeJS.ProcessEnv): Promise<void> {
	const home = env.FACADE_HOME!;
	const endpoint = frameworkSocket(home);
	if (process.platform !== 'win32') { fs.mkdirSync(path.dirname(endpoint), { mode: 0o700, recursive: true }); }
	assert.ok(!frameworkListens(home), 'the fixture home has no daemon');
	const incompatible: HelloResult = {
		api_version: 999, build: 'incompatible-editor-fixture', machine_id: '98367538-470c-4f4e-8503-f2bd9b9339ba',
		pid: process.pid, agent_count: 0, ops: [], topics: []
	};
	const requests: { id: number; method: string; params: HelloParams }[] = [];
	const connections = new Set<net.Socket>();
	const failures: Error[] = [];
	const server = net.createServer(socket => {
		connections.add(socket);
		socket.on('close', () => connections.delete(socket));
		socket.on('error', error => failures.push(error));
		createInterface({ input: socket }).on('line', line => {
			try {
				const request = JSON.parse(line) as (typeof requests)[number];
				requests.push(request);
				if (request.method === 'hello') {
					socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: incompatible }) + '\n');
				}
			} catch (error) {
				failures.push(error as Error);
			}
		});
	});
	const closeServer = () => {
		for (const connection of connections) { connection.destroy(); }
		return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	};
	const terminate = () => void closeServer().then(
		() => process.exit(143),
		error => { console.error(error); process.exit(1); },
	);
	process.once('SIGTERM', terminate);
	const reason = 'Facade Code Framework did not select an offered daemon API version.';
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(endpoint, resolve);
		});
		const window = await open(folder, 'reject');
		assert.deepStrictEqual([normalizeDriveLetter(window.ready.home), window.ready.remote, window.ready.machineId],
			[normalizeDriveLetter(home), null, null]);
		await window.act({ kind: 'show-failure-panel' });
		const workbench = await window.workbench();
		try {
			const facadeFrame = `Array.from(document.querySelectorAll('iframe.webview')).find(frame => frame.getClientRects().length
				&& getComputedStyle(frame).visibility === 'visible' && new URL(frame.src).searchParams.get('extensionId') === 'facade.facadecode')?.src`;
			const viewUrl = await until('the visible Facade webview frame', () => workbench.cdp.evaluate<string | undefined>(facadeFrame));
			const target = await until('the Facade webview target in this isolated workbench', async () => {
				const listed = await workbench.cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
				return listed.targetInfos.find(each => each.type === 'iframe' && each.url === viewUrl);
			});
			const { sessionId } = await workbench.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
			try {
				await until('the exact activation error rendered inside the Facade panel', async () => {
					const body = await workbench.cdp.evaluate<string | undefined>(
						"document.querySelector('#active-frame')?.contentDocument?.body?.innerText.trim()", sessionId);
					return body === reason ? body : undefined;
				});
			} finally {
				await workbench.cdp.send('Target.detachFromTarget', { sessionId });
			}
			await window.act({ kind: 'request-refused-agent' });
			await window.act({ kind: 'show-notifications' });
			await until('the activation error notification after New Agent', async () => {
				const notices = await workbench.cdp.evaluate<string[]>(
					"Array.from(document.querySelectorAll('.notification-list-item-message')).map(node => node.textContent?.trim() ?? '')");
				assert.ok(!notices.some(text => text.startsWith('The legacy implementation is active on ')));
				return notices.includes(reason) || undefined;
			});
		} finally {
			workbench.cdp.close();
		}
		await window.close();
		assert.deepStrictEqual(failures, []);
		assert.deepStrictEqual(requests.map(request => request.method), ['hello']);
		const offered = requests[0].params;
		assert.deepStrictEqual([offered.kind, offered.api_versions], ['ide', [1]]);
		assert.ok(fs.existsSync(path.join(home, 'framework', 'bin', process.platform === 'win32' ? 'facade.exe' : 'facade')),
			'the startup selects the launcher before the editor sends hello');
		assert.ok(!fs.existsSync(path.join(home, 'framework', 'facade.db')) && !fs.existsSync(path.join(home, 'extension', 'ptyd')));
		const record = env.FACADE_IT_RECORD!;
		assert.deepStrictEqual(fs.readdirSync(path.dirname(record)).filter(file => file.startsWith(`${path.basename(record)}.starts.`)), []);
		console.log('  ✔ The incompatible hello was refused by the real Facade panel and New Agent. ' +
			JSON.stringify({ home, endpoint, offered: offered.api_versions, selected: incompatible.api_version, panel: reason,
				newAgent: 'refused', fallback: false, launches: 0 }));
	} finally {
		process.removeListener('SIGTERM', terminate);
		if (server.listening) { await closeServer(); }
	}
	assert.ok(!frameworkListens(home), 'the private endpoint was removed');
}

/** A Shell run appears in the open VS Code window and survives closing it. */
export async function shellHandoff(open: OpenWindow, folder: string, facade: string, env: NodeJS.ProcessEnv): Promise<void> {
	const run = (...args: string[]) => execFileSync(facade, args, { cwd: folder, env, encoding: 'utf8', timeout: 20_000 });
	const home = env.FACADE_HOME!;
	const name = 'shell-ada';
	const prompt = 'Review the isolated Shell handoff';
	const branch = 'shell-handoff-worktree';
	const worktree = path.join(`${folder}.worktrees`, branch);
	const window = await open(folder, 'sh');
	assert.deepStrictEqual((await window.act<WindowView>({ kind: 'snapshot' })).cards, []);
	const [started, location, ...extra] = run('start', '-d', '--name', name, '--worktree', branch, 'codex', '--', prompt).trimEnd().split(/\r?\n/u);
	const address = detachedStartReference(started, name);
	assert.ok(location?.startsWith('Worktree: '));
	assert.deepStrictEqual([normalizeDriveLetter(location.slice('Worktree: '.length)), extra], [normalizeDriveLetter(worktree), []]);
	const inspect = async () => (await frameworkCall(home, 'agent.inspect', { target: address })).agent;
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
	await expectListed(window, before.reference.agent_id);
	assert.strictEqual(await window.act<boolean>({ kind: 'window-component' }), false);
	const status = run('status');
	const settingsFile = /^Settings {2,}([^\r\n]+)$/mu.exec(status)?.[1];
	assert.ok(settingsFile, status);
	assert.strictEqual(settingsFile, (await frameworkCall(home, 'daemon.status', {})).settings_file);
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
	console.log('  ✔ Shell start appeared automatically and the card and Shell opened the same live terminal');

	const session = await until('the fake CLI to report its session', async () => (await inspect()).session);
	const startLog = `${env.FACADE_IT_RECORD}.starts.#${before.reference.agent_id}`;
	const starts = () => fs.readFileSync(startLog, 'utf8').trim().split(/\r?\n/u).map(Number);
	const launchPids = starts();
	const priorStarts = launchPids.length;
	// The fresh profile has never had this run's native tab.
	const pinWindow = await open(folder, 'sh2');
	const peerWindow = await open(folder, 'sh');
	const cardIn = async (window: DrivenWindow) =>
		(await window.act<WindowView>({ kind: 'snapshot' })).cards.find(card => card.name === name);
	await until('the other window to see the same workspace card', () => cardIn(peerWindow));
	await pinWindow.act({ kind: 'shell-pin', name, set: true, verifyOpen: address });
	assert.deepStrictEqual(starts(), launchPids, 'Open Terminal did not launch a second fake CLI');
	console.log('  ✔ Open Terminal attached the exact Framework run with a new native tab and the original PID');
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
		const framework = await callInFramework(env.FACADE_HOME!, 'agent.inspect', { target: address }).catch(error => String(error));
		const directory = path.dirname(files[0]);
		const recovery = fs.readdirSync(directory).filter(file => file.startsWith('orchestrator-pin-restore')).map(file => {
			try { return [file, fs.readFileSync(path.join(directory, file), 'utf8')]; }
			catch (error) { return [file, String(error)]; }
		});
		console.error('Shell Pin recovery', JSON.stringify({ framework, recovery, windows: restoredPins.map(each => each.status === 'rejected' ? String(each.reason) : 'opened') }));
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
	await restoredPeer.act({ kind: 'close-shell-view', name });
	await until('closing the view to keep the card and Pin', async () => {
		const peer = await restoredPeer.act<WindowView>({ kind: 'snapshot' });
		return peer.terminals === 0 && peer.cards.some(card => card.name === name && card.pinned && card.running) || undefined;
	});
	checkSavedPin();
	assert.strictEqual((await inspect()).pid, restored.pid, 'closing the view leaves the resumed agent running');
	await restoredPeer.act({ kind: 'open-shell-agent', name, address, text: 'reopened before removal' });
	await Promise.all([restoredWindow.close(), restoredPeer.close()]);
	console.log('  ✔ Both windows shared the Pin, reopened one original session, and closing its tab kept the card and Pin');

	const reference = before.reference;
	assert.deepStrictEqual(await frameworkCall(home, 'agent.remove', { target: reference }), { reference, address });
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

/** Exercise simultaneous product viewers on the same native fake CLI. */
export async function sharedAttachJourney(open: OpenWindow, folder: string, facade: string, env: NodeJS.ProcessEnv, replacement?: string): Promise<void> {
	const run = (program: string, ...args: string[]) =>
		execFileSync(program, args, { cwd: folder, env, encoding: 'utf8', timeout: 30_000 });
	const home = env.FACADE_HOME!;
	const name = 'shell-attach';
	const address = detachedStartReference(run(facade, 'start', '-d', '--name', name, 'qa-fake'), name);
	const inspect = async () => (await frameworkCall(home, 'agent.inspect', { target: address })).agent;
	const before = await inspect();
	assert.ok(before.pid && before.process === 'running', JSON.stringify(before));
	const window = await open(folder, 'attach');
	const marker = 'typed in the editor';
	await window.act({ kind: 'open-shell-agent', name, address, text: marker });
	if (replacement) {
		const version = (program: string) => /^facade (\d+\.\d+\.\d+)(?:\+\S+)?$/u.exec(run(program, '--version').trim())?.[1];
		const old = version(facade);
		const next = version(replacement);
		assert.ok(old && next && old !== next, 'Select two different numeric package versions.');
		const lock = (service: 'daemon' | 'keeper') =>
			JSON.parse(fs.readFileSync(path.join(home, 'framework', `${service}.lock`), 'utf8')) as { pid: number; birth: string };
		const accepted = async () => {
			const hello = await helloInFramework(home);
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

/** Both workspaces list the same run, open their own views and restore one process from their Pins. */
export async function frameworkMultiWindow(open: OpenWindow, journey: WindowJourney): Promise<void> {
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
	await expectListed(other, before.id);
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
	console.log('  ✔ Both windows list the same agent and open their own views of its process and screen');

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

	if (remote === null) {
		await removeAndResume(restored, home, left);
	} else {
		await restored[0].act({ kind: 'remove', agent: before.id });
	}
	await worktreeLifetime(restored[0], restored[1]);
	await Promise.all(restored.map(window => window.close()));
	await sameWorkspace(start, journey);
}

/** Remove running and stopped workspace members, preserving their native session (RULES-6.2, 6.3). */
async function removeAndResume(windows: readonly DrivenWindow[], home: string, live: RunningAgent): Promise<void> {
	const source = windows[0];
	const machine = source.ready.machineId;
	assert.ok(machine);
	const reference = (id: string): AgentRef => ({ machine_id: machine, agent_id: id });
	const workspaces = path.join(home, 'extension', 'workspaces');
	const savedPins = (id: string) => fs.readdirSync(workspaces).filter(key => {
		const file = path.join(workspaces, key, 'orchestrator-workspace.json');
		if (!fs.existsSync(file)) { return false; }
		const { pins } = JSON.parse(fs.readFileSync(file, 'utf8')) as { readonly pins: readonly FrameworkPin[] };
		return pins.some(pin => pin.machine_id === machine && pin.agent === id);
	});
	const assertRemoved = async (id: string) => {
		await until(`${id}'s cards, native tabs and saved Pins to clear`, async () => {
			const views = await Promise.all(windows.map(window => window.act<WindowView>({ kind: 'snapshot' })));
			return views.every(view => view.cards.length === 0 && view.terminals === 0) && savedPins(id).length === 0 || undefined;
		});
		const reply = await callInFramework(home, 'agent.inspect', { target: reference(id) });
		assert.ok('error' in reply, JSON.stringify(reply));
		assert.deepStrictEqual([reply.error.data.reason, reply.error.data.details?.record_removal], ['not_found', 'removed']);
	};
	const findSaved = () => until('the exact native session to be discoverable in this workspace', async () => {
		const { items } = await frameworkCall(home, 'agent.resume_list', {
			folder: source.ready.folder, scope: { kind: 'local' }, folder_scope: 'cwd'
		});
		return items.find(item => item.target.kind === 'session' && item.session === live.session
			&& item.machine_id === machine && normalizeDriveLetter(item.folder) === normalizeDriveLetter(live.cwd));
	});

	await until('both running-agent Pins to be saved', () => savedPins(live.id).length === 2 || undefined);
	await source.act({ kind: 'remove', agent: live.id });
	await source.act({ kind: 'wait-for-exit', pid: live.pid });
	await assertRemoved(live.id);
	const saved = await findSaved();
	const resumed = await source.act<RunningAgent>({ kind: 'resume-saved', cli: saved.cli, session: saved.session });
	assert.notStrictEqual(resumed.id, live.id, 'Resume Agent gives the saved session a fresh identity');
	assert.deepStrictEqual([resumed.session, normalizeDriveLetter(resumed.cwd)], [live.session, normalizeDriveLetter(live.cwd)]);
	await source.act({ kind: 'pin', agent: resumed.id });
	await expectAgent(source, resumed.id, true);
	await until('the resumed agent Pin to be saved', () => savedPins(resumed.id).length === 1 || undefined);
	await source.act({ kind: 'stop', agent: resumed.id });
	await source.act({ kind: 'wait-for-exit', pid: resumed.pid });
	const stopped = await source.act<WindowView>({ kind: 'snapshot' });
	assert.deepStrictEqual(stopped.cards.map(card => [card.id, card.pinned, card.running]), [[resumed.id, true, false]]);
	assert.strictEqual(stopped.terminals, 0, 'Stop detached the tab');
	assert.strictEqual(savedPins(resumed.id).length, 1, 'Stop retained the saved Pin');
	await source.act({ kind: 'remove', agent: resumed.id });
	await assertRemoved(resumed.id);
	await findSaved();
	console.log('  ✔ Remove cleared running and stopped cards, native tabs and saved Pins, and Resume kept the native session under a new identity');
}

async function worktreeLifetime(source: DrivenWindow, peer: DrivenWindow): Promise<void> {
	const branch = 'agent-in-worktree';
	const agent = await source.act<AgentInfo>({ kind: 'worktree', branch });
	const parts = agent.cwd.split(/[\\/]/u);
	assert.deepStrictEqual(parts.slice(-2), [source.ready.folder.split(/[\\/]/u).at(-1) + '.worktrees', branch]);
	await expectListed(source, agent.reference.agent_id);

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
	const saved = JSON.parse(journey.files.read(file)) as { readonly pins: FrameworkPin[] };
	const pinOrder = saved.pins.map(pin => pin.agent);
	assert.deepStrictEqual([...pinOrder].sort(), pinned, 'both Pin changes are saved in the same workspace');
	assert.ok(saved.pins.every(pin => pin.machine_id === left.ready.machineId));
	await left.act({ kind: 'filter' });

	const presentation = async (window: DrivenWindow, id: string) => {
		const snapshot = await window.act<WindowView>({ kind: 'snapshot' });
		return { column: snapshot.cards.find(each => each.id === id)?.column, filter: snapshot.filter };
	};
	const before = await Promise.all([presentation(left, agentLeft.id), presentation(right, agentRight.id)]);
	assert.strictEqual(before[0].filter?.kind, 'agents');
	assert.strictEqual(before[1].filter, undefined);
	assert.deepStrictEqual(before.map(each => each.column), [2, 1]);

	await Promise.all([left.close({ waitForExit: true }), right.close({ waitForExit: true })]);
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
