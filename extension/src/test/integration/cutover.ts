/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The legacy cutover journeys (ARCHITECTURE-1.4, VERIFICATION-5.2): the released legacy pair installed in an isolated profile, two
// agents with distinct sessions started there and the first pinned, then the candidate pair installed over it. The runner observes
// the fake CLI PIDs, the Framework agent records and workspace Pins. A driver beside the installed packages runs the editor actions.
//
//   exited       the legacy agents' processes ended before the update: the saved Pin is recovered once, by its exact session,
//                without an action, and the unpinned session is not resumed
//   live         the legacy agents still run: nothing is recovered until the cutover's one action; accepting it ends both original
//                processes, then the Pin is recovered once by its exact session
//   uncertain    the legacy execution owner cannot confirm the stop (its ptyd is suspended): accepting leaves recovery pending
//   two-windows  as `exited`, with a second window of the same workspace in its own profile: still exactly one recovery
//   prior-owner  a second profile enters Framework after consent while the released window still owns its runs. The Pin recovers
//                once after the old window ends its own runs
//   separate-workspaces   two released windows in different workspaces on one Facade home each upgrade and recover their own Pin.
//                         The second window still sends terminal input to its original process after the first has switched
//
// FACADE_IT_RELEASED names the folder of the released legacy pair (0.1.5), FACADE_IT_CURRENT the candidate pair's.
// The runner clicks the native cutover notification's button through the isolated window's DevTools port (ARCHITECTURE-1.4).

import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentInfo, AgentRef, DaemonHelloResult } from '../../base/frameworkProtocol';
import type { FrameworkPin } from '../../core/ports';
import { Workbench, freePort } from './cdpInput';
import { EDITOR_FLAGS, editorProfile, endEditors, frameworkCall, frameworkListens, helloInFramework, newRepository, normalizeDriveLetter, until } from './editors';
import { installLocalVsixes, runEditorCli } from './vsixInstall';

export const CUTOVER_VARIANTS = ['exited', 'live', 'uncertain', 'two-windows', 'prior-owner', 'separate-workspaces'] as const;
export type CutoverVariant = typeof CUTOVER_VARIANTS[number];

/** What the runner gives a cutover journey: its isolated root and the suite's shared fixtures. */
export interface CutoverContext {
	readonly variant: CutoverVariant;
	readonly root: string;
	readonly home: string;
	readonly executable: string;
	readonly record: string;
	readonly claudeConfig: string;
	readonly released: string | undefined;
	readonly current: string | undefined;
	/** The editor settings of every profile: isolated terminals, nothing that stops a test. */
	readonly settings: { readonly [setting: string]: unknown };
	/** The earlier editor settings a released legacy build reads its CLIs from (CONFIGURATION-6.1). */
	readonly legacyCliSettings: { readonly [setting: string]: unknown };
	/** Writes Facade's settings file in `facade` with only Claude Code on, each built-in a fake CLI. */
	readonly facadeSettings: (facade: string) => void;
	readonly endMatching: (text: string) => void;
	readonly cleanUpFramework: (facade: string) => Promise<void>;
}

type Line = { readonly phase: string; readonly role?: string; readonly [key: string]: unknown };
type LegacyAgent = { readonly alias: string; readonly run: string; readonly name: string; readonly session: string; readonly cwd: string };
type LegacyStart = Line & {
	readonly agents: readonly LegacyAgent[];
	readonly saved: { readonly key: string; readonly pins: readonly { readonly id: string; readonly name: string }[] };
	readonly uri: string;
};
type LegacyWorkspace = LegacyStart & { readonly pids: readonly number[] };
type TestWindow = {
	readonly role: 'primary' | 'second';
	readonly profile: ReturnType<typeof editorProfile>;
	readonly folder: string;
	readonly port: number;
};
type Launch = {
	readonly at: number; readonly cwd: string; readonly pid: number; readonly agent: string; readonly args: readonly string[];
	readonly legacyPidsAlive?: readonly number[];
};

const alive = (pid: number) => {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const canonical = (folder: string) => normalizeDriveLetter(fs.realpathSync(folder));

/** The released or candidate pair in `dir`: exactly a window VSIX and this platform's facadecode VSIX of one version. */
function pair(dir: string, label: string): { files: string[]; version: string } {
	assert.ok(path.isAbsolute(dir) && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory(), `${label} is an absolute folder`);
	const files = fs.readdirSync(dir, { withFileTypes: true }).filter(file => file.name.endsWith('.vsix'));
	assert.ok(files.length === 2 && files.every(file => file.isFile()), `${dir} holds exactly two regular VSIX files`);
	const component = files.find(file => file.name.includes('-window-'))!;
	const main = files.find(file => !file.name.includes('-window-'))!;
	const version = /^facadecode-window-(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)\.vsix$/iu.exec(component?.name ?? '')?.[1];
	assert.ok(version && main?.name === ['facadecode', process.platform, process.arch, version].join('-') + '.vsix', `${dir} holds a matching native pair`);
	return { files: [path.join(dir, component.name), path.join(dir, main.name)], version };
}

/** The legacy execution owner's processes for the Facade root `facade`: its ptyd, by the path its command line names. */
function legacyOwners(facade: string): number[] {
	const found = spawnSync('pgrep', ['-f', path.join(facade, 'extension', 'ptyd')], { encoding: 'utf8' });
	return found.stdout.split('\n').filter(Boolean).map(Number).filter(pid => Number.isSafeInteger(pid) && pid !== process.pid);
}

/** This Facade root's managed Framework agents, each with its session and process as `agent.inspect` reports them. */
async function frameworkAgents(facade: string): Promise<AgentInfo[]> {
	if (!frameworkListens(facade)) { return []; }
	const hello = await helloInFramework(facade);
	if ('error' in hello) { return []; }
	const { agents } = await frameworkCall(facade, 'agent.list', { scope: { kind: 'local' } });
	return Promise.all(agents.filter(agent => agent.type === 'managed').map(async agent => (await frameworkCall(facade, 'agent.inspect', { target: agent.reference })).agent));
}

/** The cutover offer's text and action (ARCHITECTURE-1.4), as the candidate words them in English. */
const OFFER = /^Switch to Facade Code Framework\? This authorizes stopping (\d+) legacy agents and recovering (\d+) saved Pins\./u;
const ACTION = 'Switch and Resume Pins';

type Notice = { readonly message: string; readonly buttons: readonly string[] };

/** The notifications the window shows - its toasts, and the notification center's list when it is open - read from its DOM. */
async function notices(port: number): Promise<Notice[]> {
	const page = await Workbench.find(port, each => each.main, 30_000);
	try {
		return await page.cdp.evaluate<Notice[]>(`[...document.querySelectorAll('.notification-list-item')].map(item => ({
			message: (item.querySelector('.notification-list-item-message')?.textContent ?? '').trim(),
			buttons: [...item.querySelectorAll('.monaco-button')].map(button => (button.textContent ?? '').trim()).filter(Boolean)
		}))`);
	} finally {
		page.cdp.close();
	}
}

/** Clicks the offer's own button in the window's DOM, as a person does; answers whether there was one. */
async function clickOffer(port: number): Promise<boolean> {
	const page = await Workbench.find(port, each => each.main, 30_000);
	try {
		return await page.cdp.evaluate<boolean>(`(() => {
			const item = [...document.querySelectorAll('.notification-list-item')].find(each =>
				${OFFER.toString()}.test((each.querySelector('.notification-list-item-message')?.textContent ?? '').trim()));
			const button = item && [...item.querySelectorAll('.monaco-button')].find(each => (each.textContent ?? '').trim() === ${JSON.stringify(ACTION)});
			if (!button) { return false; }
			button.click();
			return true;
		})()`);
	} finally {
		page.cdp.close();
	}
}

/** The cutover journal (ARCHITECTURE-1.4) in the Facade root's extension folder: the legacy runs the offer covers and the saved Pins. */
type Journal = {
	readonly version: number;
	readonly runs: readonly {
		readonly run: string; readonly owner: string; readonly pid: number; readonly approved: boolean;
		readonly stop?: 'requested' | 'confirmed'; readonly nativeStop?: true;
	}[];
	readonly snapshots: { readonly [owner: string]: readonly { readonly id: string }[] };
	readonly recoveries?: Readonly<Record<string, { readonly reference?: AgentRef; readonly runs?: readonly string[] }>>;
};

function journal(facade: string): Journal | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(facade, 'extension', 'legacy-cutover.json'), 'utf8')) as Journal;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
		throw error;
	}
}

/** Each workspace's legacy Pin import progress (ARCHITECTURE-6.2), by its workspace key. */
function legacyPinProgress(facade: string): { [key: string]: unknown } {
	const workspaces = path.join(facade, 'extension', 'workspaces');
	return Object.fromEntries((fs.existsSync(workspaces) ? fs.readdirSync(workspaces) : [])
		.map(key => [key, path.join(workspaces, key, 'orchestrator-legacy-pins.json')] as const).filter(([, file]) => fs.existsSync(file))
		.map(([key, file]) => [key, JSON.parse(fs.readFileSync(file, 'utf8')) as unknown]));
}

/**
 * The recovered Pin as the workspace roster saved it (ARCHITECTURE-6.2): the roster for this owner, holding exactly the original
 * Pin, of the legacy session and with the confirmed identity of `agent` on this machine, and its import settled. A released legacy Pin
 * has no machine or agent until its exact native session is resumed on Framework, so a session-only or guessed identity fails here.
 */
async function savedRecoveredPin(facade: string, owner: string, agent: AgentInfo, original: { readonly id: string; readonly session: string }) {
	const hello = await helloInFramework(facade);
	assert.ok('result' in hello, JSON.stringify(hello));
	const machine = (hello.result as DaemonHelloResult).machine_id;
	const file = path.join(facade, 'extension', 'workspaces', owner, 'orchestrator-workspace.json');
	type Progress = { readonly version: number; readonly pending: readonly unknown[]; readonly attempts: readonly unknown[]; readonly unrecognized: readonly unknown[] };
	const { pins, progress } = await until(`the original Pin to settle in workspace ${owner}`, () => {
		const pins = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { readonly pins: readonly FrameworkPin[] }).pins : [];
		const progress = legacyPinProgress(facade)[owner] as Progress | undefined;
		return pins.some(pin => pin.agent === agent.reference.agent_id) && progress?.pending.length === 0 && progress.attempts.length === 0
			? { pins, progress } : undefined;
	});
	assert.deepStrictEqual(pins.map(pin => pin.id), [original.id], `exactly the original Pin, once: ${JSON.stringify(pins)}`);
	const [pin] = pins;
	assert.deepStrictEqual([pin.machine_id, pin.agent, pin.conversation?.sessionId], [machine, agent.reference.agent_id, original.session],
		'the saved Pin has the confirmed Framework identity of the agent resumed from its exact session');
	assert.deepStrictEqual([progress.pending, progress.attempts, progress.unrecognized], [[], [], []], `the legacy Pin import settled: ${JSON.stringify(progress)}`);
	return { pin, progress };
}

export async function legacyCutover(context: CutoverContext): Promise<void> {
	const { variant, root, home, executable, record, endMatching } = context;
	if (!context.released || !context.current) {
		throw new Error('A cutover journey needs FACADE_IT_RELEASED (the released legacy pair) and FACADE_IT_CURRENT (the candidate pair).');
	}
	const prior = pair(context.released, 'FACADE_IT_RELEASED');
	const candidate = pair(context.current, 'FACADE_IT_CURRENT');
	assert.strictEqual(prior.version, '0.1.5', 'the supported released legacy pair');
	assert.strictEqual(candidate.version, '0.1.6', 'the candidate pair under cutover verification');

	const folder = path.join(root, 'cutover');
	newRepository(folder);
	const window = async (role: TestWindow['role'], workspace: string): Promise<TestWindow> =>
		({ role, folder: workspace, profile: editorProfile(root, role === 'primary' ? 'cut' : 'cut2'), port: await freePort() });
	const primary = await window('primary', folder);
	const separated = variant === 'separate-workspaces';
	const peer = separated ? path.join(root, 'cutover-peer') : folder;
	if (separated) { newRepository(peer); }
	const second = separated || variant === 'two-windows' || variant === 'prior-owner' ? await window('second', peer) : undefined;
	const windows = second ? [primary, second] : [primary];
	const facade = path.join(home, 'cutover');
	const extensionHome = path.join(facade, 'extension');
	const out = path.join(root, 'cutover.jsonl');
	const driver = path.join(root, 'driver-cutover');
	fs.mkdirSync(driver, { recursive: true });
	context.facadeSettings(facade);
	fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'cutover-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], main: './extension.js' }));
	fs.copyFileSync(path.join(__dirname, 'cutoverDriver.js'), path.join(driver, 'extension.js'));
	for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
		fs.rmSync(path.join(root, file));
	}
	// The released build reads its CLIs from the editor settings. The candidate reads them from Facade's settings file.
	const userSettings = Object.fromEntries(Object.entries({ ...context.settings, ...context.legacyCliSettings }).filter(([name]) => name !== 'facade.framework'));
	const envFor = ({ profile, role }: TestWindow) => ({
		...process.env, ...profile.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, FACADE_IT_CUTOVER: out, FACADE_IT_CUTOVER_ROLE: role,
		CLAUDE_CONFIG_DIR: context.claudeConfig, FACADE_IT_CLAUDE_TRANSCRIPT: '1'
	});
	const install = (win: TestWindow, files: readonly string[]) => installLocalVsixes(executable, win.profile, files, envFor(win), 60_000);
	const request = (win: TestWindow, step: string, text = '') => fs.writeFileSync(`${out}.${win.role}.${step}`, text);

	const editors: ReturnType<typeof spawn>[] = [];
	let editorOutput = '';
	const open = (win: TestWindow) => {
		const editor = spawn(executable, [win.folder, '--new-window', ...win.profile.args, `--extensionDevelopmentPath=${driver}`,
			`--remote-debugging-port=${win.port}`, '--locale=en', ...EDITOR_FLAGS],
			{ stdio: ['ignore', 'pipe', 'pipe'], env: envFor(win) });
		const append = (chunk: unknown) => { editorOutput = (editorOutput + String(chunk)).slice(-16_000); };
		editor.stdout?.on('data', append);
		editor.stderr?.on('data', append);
		editors.push(editor);
	};
	const lines = (): Line[] => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Line) : [];
	const phase = (name: string, win: TestWindow) => until(`cutover ${win.role} ${name}`, () => {
		const seen = lines();
		const failed = seen.find(line => line.phase === 'error');
		if (failed) { throw new Error(`The cutover driver failed: ${String(failed.message)} (${failed.role})`); }
		return seen.find(each => each.phase === name && each.role === win.role);
	}, 90_000);
	const launches = (): Launch[] => fs.existsSync(`${record}.launches`)
		? fs.readFileSync(`${record}.launches`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Launch)
		: [];
	const pids: number[] = [];
	const suspended: number[] = [];
	const evidence: { [key: string]: unknown } = { variant, prior: prior.version, candidate: candidate.version, facade,
		windows: windows.map(({ role, folder, profile }) => ({ role, folder, user: profile.user })) };
	const assertInstalledPair = (win: TestWindow, phase: Line, version: string) => {
		assert.deepStrictEqual([phase.version, phase.component], [version, version]);
		for (const installed of [phase.mainPath, phase.componentPath]) {
			assert.strictEqual(typeof installed, 'string');
			assert.strictEqual(canonical(path.dirname(String(installed))), canonical(path.join(win.profile.env.VSCODE_PORTABLE, 'extensions')),
				'both packages activated from the exact isolated install');
		}
	};

	const launchedLegacy = async (win: TestWindow): Promise<LegacyWorkspace> => {
		open(win);
		const started = await phase('started', win) as LegacyStart;
		assertInstalledPair(win, started, prior.version);
		const [pinned, unpinned] = started.agents;
		assert.ok(pinned && unpinned && pinned.session !== unpinned.session, 'two distinct legacy sessions');
		const initialLaunches = launches();
		const startedPids = started.agents.map(agent => {
			assert.strictEqual(canonical(agent.cwd), canonical(win.folder), 'the published agent belongs to this folder');
			const matching = initialLaunches.filter(launch => launch.agent === agent.alias && canonical(launch.cwd) === canonical(win.folder));
			assert.strictEqual(matching.length, 1, 'the published alias has one fake CLI launch in this fixture folder');
			return matching[0].pid;
		});
		assert.ok(startedPids.every(pid => Number.isSafeInteger(pid) && pid > 0 && alive(pid)), 'both legacy fake CLIs run');
		assert.ok(startedPids.every(pid => !pids.includes(pid)), 'the original processes belong to one fixture each');
		pids.push(...startedPids);
		const result = { ...started, pids: startedPids };
		evidence[`legacy-${win.role}`] = result;
		const ledger = JSON.parse(fs.readFileSync(path.join(extensionHome, 'workspace-uris.json'), 'utf8')) as {
			readonly bindings: Readonly<Record<string, string>>;
			readonly owners: Readonly<Record<string, string>>;
		};
		const uri = process.platform === 'linux' ? started.uri : started.uri.toLowerCase();
		assert.deepStrictEqual([ledger.bindings[uri], ledger.owners[started.saved.key]], [started.saved.key, uri], 'the released URI ledger verifies the workspace owner');
		assert.strictEqual(started.saved.pins[0].name, pinned.name, 'the original Pin saves the running agent’s name');
		const transcripts = started.agents.map(agent => path.join(context.claudeConfig, 'projects', agent.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${agent.session}.jsonl`));
		assert.ok(transcripts.every(file => fs.existsSync(file)), `the legacy sessions are in the Claude session store: ${JSON.stringify(transcripts)}`);
		return result;
	};
	const waitExited = (workspace: LegacyWorkspace) =>
		until(`the original PIDs ${workspace.pids.join(', ')} to exit`, () => workspace.pids.every(pid => !alive(pid)) || undefined, 60_000);
	const candidateLoaded = async (win: TestWindow) => {
		const loaded = await phase('candidate-loaded', win);
		assertInstalledPair(win, loaded, candidate.version);
		return loaded;
	};
	const verifySettings = async (win: TestWindow, mode: 'framework' | 'pending') => {
		request(win, 'settings');
		const result = await phase('settings', win);
		evidence[`settings-${win.role}`] = result;
		if (mode === 'pending') {
			assert.strictEqual(result.opened, undefined, 'the pending command left the Settings file closed');
		} else {
			assert.strictEqual(normalizeDriveLetter(String(result.opened)), normalizeDriveLetter(path.join(facade, 'facade.json')),
				'this window opened the live Framework settings file');
		}
		return result;
	};
	const scoped = (workspace: LegacyWorkspace, snapshot = journal(facade)) =>
		snapshot?.runs.filter(row => row.owner === workspace.saved.key) ?? [];
	const assertExactRows = (workspace: LegacyWorkspace, rows: ReturnType<typeof scoped>, approved: boolean) => {
		assert.deepStrictEqual(rows.map(row => [row.run, row.pid, row.approved]).sort(),
			workspace.agents.map((agent, i) => [agent.run, workspace.pids[i], approved]).sort(),
			`the journal names only the exact ${workspace.role} cutover processes in this scope`);
	};
	const assertSnapshot = (workspace: LegacyWorkspace, snapshot: Journal) => {
		assert.deepStrictEqual(snapshot.snapshots[workspace.saved.key], workspace.saved.pins, 'approval froze the original Pin');
	};
	const managed = () => frameworkAgents(facade);
	const holding = async (session: string) => (await managed()).filter(agent => agent.session === session);
	const recoveredExactly = async (win: TestWindow, workspace: LegacyWorkspace, since: number, stillAlive: readonly number[] = []) => {
		const [pinned, unpinned] = workspace.agents;
		const original = workspace.saved.pins[0];
		await until(`Framework to hold ${pinned.session}`, async () => (await holding(pinned.session)).length > 0 || undefined, 90_000);
		const current = await holding(pinned.session);
		assert.strictEqual(current.length, 1, `one recovered agent for ${pinned.session}: ${JSON.stringify(current)}`);
		const [agent] = current;
		evidence[`recovery-${win.role}`] = { agent, launches: launches().slice(since) };
		assert.strictEqual(agent.process, 'running');
		assert.ok(agent.pid && !pids.includes(agent.pid), 'the Pin was recovered in a new process');
		assert.strictEqual(canonical(agent.cwd), canonical(win.folder));
		const saved = await savedRecoveredPin(facade, workspace.saved.key, agent, { id: original.id, session: pinned.session });
		assert.deepStrictEqual([agent.name, saved.pin.name], [original.name, original.name], 'the resumed agent and roster preserve the saved name');
		// Give another host or recovery round time to contend for the same Pin before reading the append-only log.
		await pause(4_000);
		assert.strictEqual((await holding(pinned.session)).length, 1, 'one Framework agent still holds the exact session');
		const newLaunches = launches().slice(since);
		const snapshot = journal(facade);
		evidence[`recovery-${win.role}`] = { agent, saved, launches: newLaunches, journal: snapshot };
		assert.deepStrictEqual(newLaunches.map(launch => launch.pid), [agent.pid], 'one new CLI launch across the Facade home');
		assert.deepStrictEqual(newLaunches[0].args.slice(0, 2), ['--resume', pinned.session], 'the launch resumed the exact pinned session');
		assert.deepStrictEqual(newLaunches[0].legacyPidsAlive, stillAlive, 'all original PIDs in the converting workspace had exited before CLI recovery');
		assert.deepStrictEqual(await holding(unpinned.session), [], 'the unpinned session stayed out of Framework');
		const conversions = Object.values(snapshot?.recoveries ?? {}).filter(recovery => recovery.reference?.agent_id === agent.reference.agent_id);
		assert.deepStrictEqual(conversions.map(recovery => recovery.reference), [agent.reference], 'the journal confirms one shared Framework reference');
		return agent;
	};
	const shownOffer = async (win: TestWindow) => {
		let listed = false;
		return until(`the native consent offer in ${win.role}`, async () => {
			const seen = await notices(win.port).catch(() => []);
			const offer = seen.find(notice => OFFER.test(notice.message));
			if (offer) { return { seen, offer }; }
			if (!listed) { request(win, 'showlist'); listed = true; }
			return undefined;
		}, 90_000);
	};
	const consent = async (win: TestWindow, workspace: LegacyWorkspace, since: number) => {
		const { seen, offer } = await shownOffer(win);
		evidence[`notices-${win.role}`] = seen;
		const [, runs, pins] = OFFER.exec(offer.message)!;
		assert.deepStrictEqual([Number(runs), Number(pins), offer.buttons], [2, 1, [ACTION]], 'the native offer covers two exact runs and one saved Pin');
		assert.ok(workspace.pids.every(alive), 'both original processes are live before consent');
		assert.deepStrictEqual(launches().slice(since), [], 'no CLI launched before consent');
		if (since === pids.length) {
			assert.strictEqual(frameworkListens(facade), false, 'Framework waited for the first workspace’s consent');
		}
		const before = journal(facade);
		evidence[`journal-before-${win.role}`] = before;
		assertExactRows(workspace, scoped(workspace, before), false);
		assert.ok(await clickOffer(win.port), 'the native cutover button was clicked');
		evidence[`accepted-${win.role}`] = ACTION;
		const approved = await until('approval for the current workspace', () => {
			const current = journal(facade);
			const rows = scoped(workspace, current);
			return rows.length === 2 && rows.every(row => row.approved) ? current : undefined;
		});
		evidence[`journal-approved-${win.role}`] = approved;
		assertExactRows(workspace, scoped(workspace, approved), true);
		assertSnapshot(workspace, approved);
	};
	const migrateLive = async (win: TestWindow, workspace: LegacyWorkspace, since: number, stillAlive: readonly number[] = []) => {
		await install(win, candidate.files);
		request(win, 'reload');
		const pendingHost = await candidateLoaded(win);
		await consent(win, workspace, since);
		await waitExited(workspace);
		const recovered = await recoveredExactly(win, workspace, since, stillAlive);
		const completed = scoped(workspace);
		assertExactRows(workspace, completed, true);
		assert.ok(completed.every(row => row.stop === 'confirmed' && row.nativeStop), 'both native stop results were durably confirmed');
		const readyHost = await verifySettings(win, 'framework');
		assert.notStrictEqual(readyHost.hostPid, pendingHost.hostPid, 'the editor reloaded after the native stops were confirmed');
		return recovered;
	};

	try {
		for (const win of windows) {
			fs.mkdirSync(path.join(win.profile.user, 'User'), { recursive: true });
			fs.writeFileSync(path.join(win.profile.user, 'User', 'settings.json'), JSON.stringify(userSettings));
			assert.strictEqual((await runEditorCli(executable, win.profile, ['--list-extensions'], envFor(win), 30_000)).trim(), '', 'the profile has no installed extensions');
		}
		await install(primary, prior.files);
		const original = await launchedLegacy(primary);
		let other: LegacyWorkspace | undefined;
		if (separated && second) {
			await install(second, prior.files);
			other = await launchedLegacy(second);
			assert.notStrictEqual(original.uri, other.uri);
			assert.notStrictEqual(original.saved.key, other.saved.key);
			assert.strictEqual(new Set([...original.agents, ...other.agents].map(agent => agent.session)).size, 4, 'the two published workspaces have distinct sessions');
			request(second, 'scope', original.agents[0].run);
			const foreign = await phase('foreign-run', second);
			assert.deepStrictEqual([foreign.version, foreign.run, foreign.opened], [prior.version, original.agents[0].run, false],
				'the released workspace rejects Open for a run owned by a different workspace');
			evidence.foreignRun = foreign;
		}
		const since = launches().length;
		assert.strictEqual(since, pids.length, 'each original CLI launched once');
		fs.writeFileSync(`${record}.legacy-pids`, JSON.stringify(pids));

		if (variant === 'live') {
			await migrateLive(primary, original, since);
		} else if (separated && second && other) {
			const a = await migrateLive(primary, original, since, other.pids);
			assert.ok(other.pids.every(alive), 'workspace B keeps both original PIDs after workspace A is serving Framework');
			const afterA = journal(facade);
			assert.ok(scoped(other, afterA).every(row => !row.approved && !row.nativeStop && !row.stop),
				'workspace A left workspace B outside its approval and stop scope');
			assert.strictEqual(afterA?.snapshots[other.saved.key], undefined, 'workspace B retains custody of its own saved Pin');
			const marker = 'workspace B still accepts input after workspace A upgraded';
			request(second, 'input', marker);
			const sent = await phase('input-sent', second);
			assert.deepStrictEqual([sent.version, sent.hostPid, sent.run], [prior.version, other.hostPid, other.agents[0].run],
				'workspace B submitted input in its original released window and exact run');
			const file = `${record}.received-pid.${other.pids[0]}`;
			await until('the original workspace B CLI to receive the submitted marker', () =>
				fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').includes(JSON.stringify(marker)) || undefined);
			evidence.peerInput = { ...sent, receivedByPid: other.pids[0], oldPids: other.pids.map(pid => ({ pid, alive: alive(pid) })) };
			const b = await migrateLive(second, other, since + 1);
			const [retained] = await holding(original.agents[0].session);
			assert.deepStrictEqual([retained?.reference, retained?.pid, retained?.name], [a.reference, a.pid, a.name], 'workspace A kept its original recovery through workspace B switching');
			assert.notDeepStrictEqual(b.reference, a.reference, 'the distinct sessions have separate Framework references');
			await savedRecoveredPin(facade, original.saved.key, a, { id: original.saved.pins[0].id, session: original.agents[0].session });
			assert.deepStrictEqual(launches().slice(since).map(launch => launch.pid), [a.pid, b.pid], 'one new CLI per restored Pin across both upgrades');
		} else if (variant === 'exited' || variant === 'two-windows') {
			for (const pid of original.pids) { process.kill(pid, 'SIGTERM'); }
			await waitExited(original);
			evidence.exitedBeforeUpdate = original.pids;
			await install(primary, candidate.files);
			if (second) { await install(second, candidate.files); }
			request(primary, 'reload');
			if (second) { open(second); }
			await candidateLoaded(primary);
			if (second) { await candidateLoaded(second); }
			await recoveredExactly(primary, original, since);
			for (const win of windows) {
				await verifySettings(win, 'framework');
				request(win, 'showlist');
				await pause(500);
				const seen = await notices(win.port);
				evidence[`notices-${win.role}`] = seen;
				assert.deepStrictEqual(seen.filter(notice => OFFER.test(notice.message)), [], 'confirmed prior exits needed no consent');
			}
		} else if (variant === 'prior-owner' && second) {
			await install(second, candidate.files);
			open(second);
			await candidateLoaded(second);
			await consent(second, original, since);
			await until('Framework to serve the candidate of the same workspace', () => frameworkListens(facade) || undefined, 60_000);
			await verifySettings(second, 'framework');
			const held = scoped(original);
			assert.ok(held.every(row => !row.stop && !row.nativeStop), 'no native stop was dispatched while the released window held custody');
			assert.ok(original.pids.every(alive), 'the released window still owns both original processes while Framework serves the candidate');
			assert.deepStrictEqual([await managed(), launches().slice(since)], [[], []], 'Pin recovery waited for the old window to release the exact session');
			evidence.ownerHeld = { rows: held, livePids: original.pids, frameworkAgents: [], launches: [] };
			request(primary, 'stop');
			const stopped = await phase('stopped', primary);
			assert.deepStrictEqual(stopped.runs, original.agents.map(agent => agent.run));
			evidence.ownerStopped = stopped;
			await waitExited(original);
			await recoveredExactly(second, original, since);
		} else {
			assert.strictEqual(variant, 'uncertain');
			for (const agent of original.agents) {
				fs.writeFileSync(`${record}.quirks.${agent.alias}`, JSON.stringify({ keepOnHangup: true }));
			}
			await install(primary, candidate.files);
			request(primary, 'reload');
			const pendingHost = await candidateLoaded(primary);
			await consent(primary, original, since);
			// The fake CLI attests a dispatched hangup. Suspend only this fixture's ptyd before it escalates that stop.
			const deadline = Date.now() + 30_000;
			let sent: Journal | undefined;
			while (!sent && Date.now() < deadline) {
				const current = journal(facade);
				if (scoped(original, current).some(row => row.stop === 'requested' && row.nativeStop)
					&& original.agents.some(agent => fs.existsSync(`${record}.hangups.${agent.alias}`))) {
					sent = current;
				} else {
					await pause(20);
				}
			}
			assert.ok(sent, 'the fixture received a native stop while its journal still marked it requested');
			const owners = legacyOwners(facade);
			assert.ok(owners.length > 0, 'the scoped execution owner is running');
			for (const pid of owners) { process.kill(pid, 'SIGSTOP'); suspended.push(pid); }
			evidence.requested = { journal: sent, suspendedOwners: owners };
			await pause(30_000);
			const after = journal(facade);
			const waiting = scoped(original, after);
			const settings = await verifySettings(primary, 'pending');
			request(primary, 'showlist');
			await pause(500);
			const seen = await notices(primary.port);
			evidence.pending = { pids: original.pids.map(pid => ({ pid, alive: alive(pid) })), journal: after, notices: seen,
				progress: legacyPinProgress(facade), launches: launches().slice(since), frameworkListens: frameworkListens(facade) };
			assert.strictEqual(settings.hostPid, pendingHost.hostPid, 'the candidate stayed in the host that presented consent');
			assert.ok(seen.some(notice => /^(Could not verify legacy agent processes|Waiting to confirm that \d+ legacy agent processes have exited)/u.test(notice.message)),
				'the settings action reported the pending stop in the native editor');
			assert.ok(original.pids.every(alive), 'both unconfirmed legacy processes are still live');
			assert.ok(after);
			assertExactRows(original, waiting, true);
			assertSnapshot(original, after);
			assert.ok(waiting.some(row => row.stop === 'requested' && row.nativeStop), 'the unresolved native stop stays requested');
			assert.strictEqual(frameworkListens(facade), false, 'the candidate remained pending without a Framework daemon');
			assert.deepStrictEqual(launches().slice(since), [], 'the candidate launched no replacement while exit was uncertain');
		}
		evidence.windowLoads = lines().filter(line => line.phase === 'candidate-loaded');
		console.log(`  ✔ legacy cutover (${variant}) from ${prior.version} to ${candidate.version}: ${JSON.stringify(evidence)}`);
	} catch (error) {
		const read = (file: string) => {
			try { return fs.readFileSync(file, 'utf8'); }
			catch (readError) { return String(readError); }
		};
		console.error(`Cutover evidence so far: ${JSON.stringify(evidence)}\nJournal: ${read(path.join(extensionHome, 'legacy-cutover.json'))}\nLaunches: ${read(`${record}.launches`)}\nDriver lines: ${read(out)}\nEditor output:\n${editorOutput}`);
		throw error;
	} finally {
		for (const pid of suspended) { try { process.kill(pid, 'SIGCONT'); } catch { /* ended */ } }
		// Cleanup targets only the fake CLIs recorded for this fixture and the processes of these profiles.
		for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
		try {
			await endEditors(editors);
		} finally {
			for (const win of windows) { endMatching(win.profile.env.VSCODE_PORTABLE); }
			endMatching(path.join(extensionHome, 'ptyd'));
			await context.cleanUpFramework(facade);
		}
	}
}
