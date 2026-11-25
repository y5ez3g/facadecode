/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The legacy cutover journeys (ARCHITECTURE-1.4, VERIFICATION-5.2): the released legacy pair installed in an isolated profile, two
// agents with distinct sessions started there and the first pinned, then the candidate pair installed over it and the window reloaded
// into it. Each variant judges one clause of the cutover rule from outside the editor - the fake CLIs' processes, the Facade root's
// Framework daemon and its agent records - and a driver beside the installed packages (cutoverDriver.ts) runs the steps:
//
//   exited       the legacy agents' processes ended before the update: the saved Pin is recovered once, by its exact session,
//                without an action, and the unpinned session is not resumed
//   live         the legacy agents still run: nothing is recovered until the cutover's one action; accepting it ends both original
//                processes, then the Pin is recovered once by its exact session
//   uncertain    the legacy execution owner cannot confirm the stop (its ptyd is suspended): accepting leaves recovery pending
//   two-windows  as `exited`, with a second window of the same workspace in its own profile: still exactly one recovery
//   prior-owner  the released build's window stays open and keeps its live agents; a second profile opens the workspace on the
//                candidate and the person accepts the offer there: nothing stops or recovers while the old window owns the runs;
//                once that window ends them, the Pin is recovered once by its exact session
//
// FACADE_IT_RELEASED names the folder of the released legacy pair (0.1.5), FACADE_IT_CURRENT the candidate pair's.
// The cutover's action is the native warning notification's button (ARCHITECTURE-1.4): the runner reads the notification from the
// window's DOM through its own DevTools port and accepts it as a person does - VS Code's `notification.acceptPrimaryAction` when it is
// the only notification, else a click on its button. The product has no test command for it.

import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentInfo, DaemonHelloResult } from '../../base/frameworkProtocol';
import type { FrameworkPin } from '../../core/ports';
import { Workbench, freePort } from './cdpInput';
import { EDITOR_FLAGS, editorProfile, endEditors, frameworkCall, frameworkListens, helloInFramework, newRepository } from './editors';
import { installLocalVsixes, runEditorCli } from './vsixInstall';

export const CUTOVER_VARIANTS = ['exited', 'live', 'uncertain', 'two-windows', 'prior-owner'] as const;
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
type LegacyAgent = { readonly alias: string; readonly run: string; readonly name: string; readonly session: string };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
	readonly runs: readonly { readonly run: string; readonly owner: string; readonly pid: number; readonly approved: boolean; readonly stop?: string }[];
	readonly snapshots: { readonly [owner: string]: readonly { readonly id: string }[] };
	readonly unrecognizedPins?: { readonly [owner: string]: readonly unknown[] };
};

function journal(facade: string): Journal | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(facade, 'extension', 'legacy-cutover.json'), 'utf8')) as Journal;
	} catch {
		return undefined;
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
 * The recovered Pin as the workspace roster saved it (ARCHITECTURE-6.2): the one roster of the workspace, holding exactly the original
 * Pin, of the legacy session and with the confirmed identity of `agent` on this machine, and its import settled. A released legacy Pin
 * has no machine or agent until its exact native session is resumed on Framework, so a session-only or guessed identity fails here.
 */
async function savedRecoveredPin(facade: string, agent: AgentInfo, original: { readonly id: string; readonly session: string }) {
	const hello = await helloInFramework(facade);
	assert.ok('result' in hello, JSON.stringify(hello));
	const machine = (hello.result as DaemonHelloResult).machine_id;
	const workspaces = path.join(facade, 'extension', 'workspaces');
	const read = () => fs.readdirSync(workspaces).map(key => ({ key, file: path.join(workspaces, key, 'orchestrator-workspace.json') })).filter(({ file }) => fs.existsSync(file))
		.map(({ key, file }) => ({ key, pins: (JSON.parse(fs.readFileSync(file, 'utf8')) as { readonly pins?: readonly FrameworkPin[] }).pins ?? [] }));
	type Progress = { readonly version: number; readonly pending: readonly unknown[]; readonly attempts: readonly unknown[]; readonly unrecognized: readonly unknown[] };
	const settled = (key: string) => {
		const progress = legacyPinProgress(facade)[key] as Progress | undefined;
		return !!progress && progress.pending.length === 0 && progress.attempts.length === 0;
	};
	const end = Date.now() + 30_000;
	let rosters = read();
	while (!(rosters.length === 1 && rosters[0].pins.some(pin => pin.agent === agent.reference.agent_id) && settled(rosters[0].key)) && Date.now() < end) {
		await pause(250);
		rosters = read();
	}
	assert.strictEqual(rosters.length, 1, `one workspace roster: ${JSON.stringify(rosters)}`);
	assert.deepStrictEqual(rosters[0].pins.map(pin => pin.id), [original.id], `exactly the original Pin, once: ${JSON.stringify(rosters[0].pins)}`);
	const [pin] = rosters[0].pins;
	assert.deepStrictEqual([pin.machine_id, pin.agent, pin.conversation?.sessionId], [machine, agent.reference.agent_id, original.session],
		'the saved Pin has the confirmed Framework identity of the agent resumed from its exact session');
	const progress = legacyPinProgress(facade)[rosters[0].key] as Progress | undefined;
	assert.ok(progress, 'the verified legacy source was imported');
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
	// VS Code's own command for a notification's primary action, which the driver runs when the offer is the only notification
	const accept = 'notification.acceptPrimaryAction';
	const port = await freePort();

	const folder = path.join(root, 'cutover');
	newRepository(folder);
	const facade = path.join(home, 'cutover');
	const out = path.join(root, 'cutover.jsonl');
	const driver = path.join(root, 'driver-cutover');
	const profiles = [editorProfile(root, 'cut'), ...variant === 'two-windows' || variant === 'prior-owner' ? [editorProfile(root, 'cut2')] : []];
	// The window on the candidate whose notifications the runner reads and accepts
	const actor = variant === 'prior-owner' ? 'second' : 'primary';
	for (const dir of [facade, driver, ...profiles.map(profile => path.join(profile.user, 'User'))]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	// The released build reads its CLIs from the editor's settings; the candidate from Facade's settings file. `facade.framework` is
	// retired by the cutover (ARCHITECTURE-1.4): no profile sets it.
	const userSettings = Object.fromEntries(Object.entries({ ...context.settings, ...context.legacyCliSettings }).filter(([name]) => name !== 'facade.framework'));
	for (const profile of profiles) {
		fs.writeFileSync(path.join(profile.user, 'User', 'settings.json'), JSON.stringify(userSettings));
	}
	context.facadeSettings(facade);
	fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'cutover-driver', publisher: 'facade-it', version: '0.0.0', engines: { vscode: '^1.105.0' }, activationEvents: ['onStartupFinished'], main: './extension.js' }));
	fs.copyFileSync(path.join(__dirname, 'cutoverDriver.js'), path.join(driver, 'extension.js'));
	for (const file of fs.readdirSync(root).filter(each => each.startsWith(`${path.basename(record)}.`))) {
		fs.rmSync(path.join(root, file));
	}
	const envFor = (profile: ReturnType<typeof editorProfile>, role: 'primary' | 'second') => ({
		...process.env, ...profile.env, FACADE_HOME: facade, FACADE_IT_RECORD: record, FACADE_IT_CUTOVER: out, FACADE_IT_CUTOVER_ROLE: role,
		CLAUDE_CONFIG_DIR: context.claudeConfig, FACADE_IT_CUTOVER_COMMAND: accept, FACADE_IT_CLAUDE_TRANSCRIPT: '1'
	});
	const [primary] = profiles;
	assert.strictEqual((await runEditorCli(executable, primary, ['--list-extensions'], envFor(primary, 'primary'), 30_000)).trim(), '', 'the editor profile has no installed extensions');
	await installLocalVsixes(executable, primary, prior.files, envFor(primary, 'primary'), 60_000);

	const editors: ReturnType<typeof spawn>[] = [];
	let editorOutput = '';
	const open = (profile: ReturnType<typeof editorProfile>, role: 'primary' | 'second') => {
		const editor = spawn(executable, [folder, '--new-window', ...profile.args, `--extensionDevelopmentPath=${driver}`,
			...role === actor ? [`--remote-debugging-port=${port}`, '--locale=en'] : ['--locale=en'], ...EDITOR_FLAGS],
			{ stdio: ['ignore', 'pipe', 'pipe'], env: envFor(profile, role) });
		const append = (chunk: unknown) => { editorOutput = (editorOutput + String(chunk)).slice(-16_000); };
		editor.stdout?.on('data', append);
		editor.stderr?.on('data', append);
		editors.push(editor);
	};
	const lines = (): Line[] => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Line) : [];
	const phase = async (name: string, role = 'primary', ms = 180_000): Promise<Line> => {
		const end = Date.now() + ms;
		for (;;) {
			const failed = lines().find(line => line.phase === 'error');
			if (failed) { throw new Error(`The cutover driver failed: ${String(failed.message)}: ${JSON.stringify(lines())}`); }
			const line = lines().find(each => each.phase === name && (each.role ?? 'primary') === role);
			if (line) { return line; }
			if (Date.now() > end) { throw new Error(`Timed out waiting for the cutover's ${role} ${name}: ${JSON.stringify(lines())}`); }
			await pause(250);
		}
	};
	/** Framework agents of this root holding `session`, as they are when `settle` ms have passed with the count unchanged. */
	const holding = async (session: string) => (await frameworkAgents(facade)).filter(agent => agent.session === session);
	const recoveredOnce = async (session: string, ms = 120_000) => {
		const end = Date.now() + ms;
		while ((await holding(session)).length === 0 && Date.now() < end) { await pause(500); }
		// A second window or a repeated round would add another within a few seconds: settle before counting
		await pause(10_000);
		return holding(session);
	};
	const suspended: number[] = [];
	let pids: number[] = [];
	const evidence: { [key: string]: unknown } = { variant, prior: prior.version, candidate: candidate.version };
	/** The run's launches with `session` in their arguments since `since`, from the fake CLIs' append-only log. */
	const launchesOf = (session: string, since: number) => (fs.existsSync(`${record}.launches`) ? fs.readFileSync(`${record}.launches`, 'utf8') : '')
		.split('\n').filter(Boolean).map(line => JSON.parse(line) as { at: number; agent: string; pid: number; args: string[] })
		.filter(launch => launch.at >= since && launch.args.includes(session));
	const recoveredExactly = async (pinned: LegacyAgent, unpinned: LegacyAgent, pinId: string, since: number) => {
		const recovered = await recoveredOnce(pinned.session);
		evidence.recovered = recovered;
		assert.strictEqual(recovered.length, 1, `the saved Pin was recovered exactly once: ${JSON.stringify(recovered)}`);
		assert.strictEqual(recovered[0].process, 'running');
		assert.ok(recovered[0].pid && !pids.includes(recovered[0].pid), 'the Pin was recovered in a new process');
		const launches = launchesOf(pinned.session, since);
		evidence.launches = launches;
		assert.deepStrictEqual(launches.map(launch => launch.pid), [recovered[0].pid], 'one CLI launch resumed the original session, the recovered process');
		assert.deepStrictEqual([await holding(unpinned.session), launchesOf(unpinned.session, since)], [[], []], 'the unpinned session was not resumed');
		const saved = await savedRecoveredPin(facade, recovered[0], { id: pinId, session: pinned.session });
		assert.deepStrictEqual([recovered[0].name, saved.pin.name], [pinned.name, pinned.name], 'the fresh resume preserves the saved name');
		evidence.savedPin = saved;
	};
	/** Reads the cutover offer in the actor window's DOM and accepts it as a person does (ARCHITECTURE-1.4). */
	const acceptOffer = async () => {
		const offerBy = Date.now() + 90_000;
		let seen: Notice[] = [];
		let offer: Notice | undefined;
		let listed = false;
		while (!offer && Date.now() < offerBy) {
			seen = await notices(port).catch(() => []);
			offer = seen.find(notice => OFFER.test(notice.message));
			// A toast the window hid stays in the notification center
			if (!offer && !listed) { fs.writeFileSync(`${out}.${actor}.showlist`, ''); listed = true; }
			if (!offer) { await pause(500); }
		}
		evidence.notices = seen;
		assert.ok(offer, `the cutover offer is shown: ${JSON.stringify(seen)}`);
		const [, runs, pins] = OFFER.exec(offer.message)!;
		assert.deepStrictEqual([Number(runs), Number(pins)], [2, 1], `the offer counts the two legacy runs and the one saved Pin: ${offer.message}`);
		assert.deepStrictEqual(offer.buttons, [ACTION], 'the offer has its one action');
		if (seen.length === 1) {
			fs.writeFileSync(`${out}.${actor}.accept`, '');
			const accepted = await phase('accepted', actor);
			assert.ok(accepted.registered && !accepted.failed, `VS Code's ${accept} ran: ${JSON.stringify(accepted)}`);
			evidence.accepted = { by: accept };
		} else {
			assert.ok(await clickOffer(port), 'the offer\'s button was clicked');
			evidence.accepted = { by: 'click', among: seen.length };
		}
	};
	/** The journal once accepting the offer approved its runs - or emptied it, when the stops were already verified. */
	const approvedJournal = async () => {
		const approvedBy = Date.now() + 30_000;
		for (;;) {
			const now = journal(facade);
			if (!now || now.runs.length === 0 || now.runs.some(row => row.approved)) { return now ?? { version: 1, runs: [], snapshots: {} }; }
			if (Date.now() > approvedBy) { return now; }
			await pause(25);
		}
	};
	try {
		open(primary, 'primary');
		const started = await phase('started') as Line & { agents: LegacyAgent[]; version: string; saved: { key: string; pins: { id: string }[] } };
		assert.strictEqual(started.version, prior.version, 'the released legacy build started the agents');
		const [pinned, unpinned] = started.agents;
		assert.ok(pinned && unpinned && pinned.session !== unpinned.session, 'two distinct legacy sessions');
		const pinId = started.saved.pins[0].id;
		pids = started.agents.map(agent => Number(fs.readFileSync(`${record}.${agent.alias}`, 'utf8').trim()));
		assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0 && alive(pid)), 'both legacy fake CLIs run');
		evidence.legacy = { agents: started.agents, pids, saved: started.saved };
		// The released build's CLI kept its conversations where Claude Code keeps them: the session store Framework resumes from
		const transcripts = started.agents.map(agent => path.join(context.claudeConfig, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'), `${agent.session}.jsonl`));
		assert.ok(transcripts.every(file => fs.existsSync(file)), `the legacy sessions are in the Claude session store: ${JSON.stringify(transcripts)}`);

		if (variant === 'exited' || variant === 'two-windows') {
			// A confirmed prior exit: the agents' own processes end, as a CLI the person quit does
			for (const pid of pids) { process.kill(pid, 'SIGTERM'); }
			const end = Date.now() + 20_000;
			while (pids.some(alive) && Date.now() < end) { await pause(200); }
			assert.ok(!pids.some(alive), 'the legacy fake CLIs exited before the update');
			await pause(3_000);
		}
		if (variant === 'uncertain') {
			// The legacy CLIs keep running on the stop's hangup; ptyd would end them with SIGKILL after its grace unless suspended
			for (const agent of started.agents) { fs.writeFileSync(`${record}.quirks.${agent.alias}`, JSON.stringify({ keepOnHangup: true })); }
		}

		if (variant !== 'prior-owner') {
			await installLocalVsixes(executable, primary, candidate.files, envFor(primary, 'primary'), 60_000);
		}
		if (profiles[1]) {
			await installLocalVsixes(executable, profiles[1], candidate.files, envFor(profiles[1], 'second'), 60_000);
		}
		const upgradedAt = Date.now();
		if (variant === 'prior-owner') {
			// The released build's window stays as it is; only the second profile opens the workspace on the candidate
			open(profiles[1], 'second');
		} else {
			fs.writeFileSync(`${out}.reload`, '');
			if (variant === 'two-windows') { open(profiles[1], 'second'); }
			const updated = await phase('updated');
			assert.strictEqual(updated.version, candidate.version, 'the window reloaded into the candidate');
		}
		if (profiles[1]) {
			assert.strictEqual((await phase('second-active', 'second')).version, candidate.version);
		}

		if (variant === 'exited' || variant === 'two-windows') {
			await recoveredExactly(pinned, unpinned, pinId, upgradedAt);
			// A confirmed prior exit needs no action: no offer in the toasts or the notification center
			fs.writeFileSync(`${out}.${actor}.showlist`, '');
			await pause(2_000);
			const shown = await notices(port);
			evidence.notices = shown;
			assert.deepStrictEqual(shown.filter(notice => OFFER.test(notice.message)), [], 'no cutover offer after a confirmed prior exit');
		} else if (variant === 'prior-owner') {
			await pause(15_000);
			assert.ok(pids.every(alive), 'the old window\'s live runs are not stopped before the action is accepted');
			assert.deepStrictEqual(await holding(pinned.session), [], 'no Pin is recovered before the action is accepted');
			await acceptOffer();
			// The old window still owns its runs: they must exit there, and nothing is recovered meanwhile
			const approved = await approvedJournal();
			await pause(20_000);
			const waiting = journal(facade);
			evidence.journalApproved = approved;
			evidence.ownerHeld = { journal: waiting, pids: pids.map(pid => ({ pid, alive: alive(pid) })), holding: await holding(pinned.session) };
			assert.ok(approved && approved.runs.length === 2 && approved.runs.every(row => row.approved), 'accepting the offer approved both journaled runs');
			assert.deepStrictEqual(Object.values(waiting?.snapshots ?? {}).flat().map(pin => pin.id), [pinId], 'the journal keeps the one original Pin');
			assert.ok(pids.every(alive), 'runs another window owns keep running until they exit there');
			assert.deepStrictEqual([await holding(pinned.session), launchesOf(pinned.session, upgradedAt)], [[], []], 'nothing is recovered while the old window owns the runs');
			// The person ends them in the window that owns them
			fs.writeFileSync(`${out}.primary.stop`, '');
			evidence.ownerStopped = await phase('stopped');
			const end = Date.now() + 60_000;
			while (pids.some(alive) && Date.now() < end) { await pause(250); }
			assert.ok(!pids.some(alive), 'the old window ended both original legacy processes');
			await recoveredExactly(pinned, unpinned, pinId, upgradedAt);
		} else {
			// Live legacy runs: nothing moves until the person accepts the one action
			await pause(15_000);
			assert.ok(pids.every(alive), 'the live legacy runs are not stopped before the action is accepted');
			assert.deepStrictEqual(await holding(pinned.session), [], 'no Pin is recovered before the action is accepted');
			const before = journal(facade);
			evidence.journalBefore = before;
			assert.ok(before, 'the cutover journal is written before the offer is accepted');
			assert.deepStrictEqual(before.runs.map(row => [row.pid, row.approved]).sort(), pids.map(pid => [pid, false]).sort(), 'the journal names the two exact legacy processes, not approved');
			await acceptOffer();
			if (variant === 'live') {
				// Approval is journaled before the stops; verified rows then leave the journal
				const approved = await approvedJournal();
				evidence.journalApproved = approved;
				assert.ok(approved && approved.runs.every(row => row.approved), 'accepting the offer approved the journaled runs');
				if (approved.runs.length) {
					assert.deepStrictEqual(Object.values(approved.snapshots).flat().map(pin => pin.id), [pinId], 'the approved journal keeps the one original Pin');
				}
				const end = Date.now() + 60_000;
				while (pids.some(alive) && Date.now() < end) { await pause(250); }
				assert.ok(!pids.some(alive), 'accepting the cutover ended both original legacy processes');
				await recoveredExactly(pinned, unpinned, pinId, upgradedAt);
			} else {
				// Suspend the verified fixture ptyd once a stop is sent, before its SIGKILL grace: the stop stays unconfirmed
				const requestedBy = Date.now() + 30_000;
				let requested: Journal | undefined;
				while (!requested && Date.now() < requestedBy) {
					const now = journal(facade);
					if (now?.runs.some(row => row.stop === 'requested')) { requested = now; } else { await pause(20); }
				}
				const owners = legacyOwners(facade);
				for (const pid of owners) { process.kill(pid, 'SIGSTOP'); suspended.push(pid); }
				evidence.journalRequested = requested;
				evidence.suspendedOwners = owners;
				assert.ok(requested, 'the accepted cutover sent a stop to a legacy run');
				assert.ok(owners.length > 0, 'the legacy execution owner was running to be suspended');
				await pause(30_000);
				const after = journal(facade);
				evidence.pending = { pids: pids.map(pid => ({ pid, alive: alive(pid) })), holding: await holding(pinned.session), journal: after,
					progress: legacyPinProgress(facade), launches: launchesOf(pinned.session, upgradedAt) };
				assert.ok(alive(pids[0]) && alive(pids[1]), 'the unconfirmed legacy runs were not reported ended');
				assert.ok(after && after.runs.length === 2 && after.runs.every(row => row.approved), 'the approved runs stay in the journal while their stops are unconfirmed');
				assert.deepStrictEqual(Object.values(after.snapshots).flat().map(pin => pin.id), [pinId], 'the journal keeps the one original Pin');
				assert.ok(after.runs.some(row => row.stop === 'requested'), 'an unresolved stop stays requested');
				assert.deepStrictEqual([await holding(pinned.session), launchesOf(pinned.session, upgradedAt)], [[], []], 'an uncertain stop leaves the Pin recovery pending');
			}
		}
		console.log(`  ✔ legacy cutover (${variant}) from ${prior.version} to ${candidate.version}: ${JSON.stringify(evidence)}`);
	} catch (error) {
		console.error(`Cutover evidence so far: ${JSON.stringify(evidence)}\nDriver lines: ${JSON.stringify(lines())}\nEditor output:\n${editorOutput}`);
		throw error;
	} finally {
		for (const pid of suspended) { try { process.kill(pid, 'SIGCONT'); } catch { /* ended */ } }
		// The legacy fake CLIs a failed variant left: by their recorded process IDs, never by a pattern
		for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* ended */ } }
		try {
			await endEditors(editors);
		} finally {
			for (const profile of profiles) { endMatching(profile.env.VSCODE_PORTABLE); }
			endMatching(path.join(facade, 'extension', 'ptyd'));
			await context.cleanUpFramework(facade);
		}
	}
}
