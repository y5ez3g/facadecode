/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ActivityReport, ExitReport, LaunchPlan, PairFacts, RunId, RunMeta } from '../core/ports';
import type { AgentExecution } from '../host/execution/agentExecution';
import { EarlierPtyds, PtydClient, PtydGone, PtydLost, PtydNotSent, ptydSocketPath, within } from '../host/execution/ptydClient';
import { EARLIER_PROTOCOLS, lineReader, type Method, type Requests } from '../ptyd/protocol';
import { PtydServer } from '../ptyd/server';
import { programEnv } from './ptydPlace';
import { nextOwnerClaim } from '../record/ownership';
import { TestEmitter, withModules } from './withModules';

/** A terminal as the stand-in editor makes it: what it was created with, and what was done to it. */
interface FakeTerminal {
	/** Its tab's title, as VS Code tells it to the terminal before the tab changes. */
	name: string;
	readonly options: vscode.ExtensionTerminalOptions;
	readonly written: string[];
	/** Every name its pseudoterminal said. */
	readonly names: string[];
	/** What its pseudoterminal said since it opened that the editor does not show yet: VS Code shows each, in order, a round trip later. */
	readonly pending: string[];
	/** Its editor tab. */
	readonly tab: { readonly input: unknown; readonly isPinned: boolean; readonly isActive: boolean; label: string };
	opened: boolean;
	shown: (boolean | undefined)[];
	disposed: boolean;
	exitStatus?: { readonly reason: number; readonly code: undefined };
	show(preserveFocus?: boolean): void;
	dispose(): void;
}

const EXIT_REASON = { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 };

suite('The execution port: an agent\'s terminal and its process held by ptyd (ARCHITECTURE-2.3, LIFECYCLE-1.5, 2.2, 3.1)', function () {
	this.timeout(20_000);
	let home: string;
	let server: PtydServer;
	let terminals: FakeTerminal[];
	let activeChanged: TestEmitter<unknown>;
	let closed: TestEmitter<unknown>;
	let configChanged: TestEmitter<{ affectsConfiguration(section: string): boolean }>;
	let config: { [key: string]: unknown };
	/** The editor's tabs as the test has them: the active tab, its changes, and the commands run on the active editor. */
	let tabsChanged: TestEmitter<{ opened: unknown[]; closed: unknown[]; changed: unknown[] }>;
	let groupsChanged: TestEmitter<undefined>;
	let visibleTabs: unknown[] | undefined;
	let activeTab: unknown;
	let activeTerminal: unknown;
	let commands: string[];
	class TabInputTerminal { }
	class TabInputText { constructor(readonly uri: unknown) { } }
	let Execution: typeof AgentExecution;
	let connectGate: Promise<void> | undefined;
	let loseSpawnReply: boolean;
	let failConnectAfterLostSpawn: number;
	let failedConnects: number;
	let failTerminateOnce: boolean;
	let failForgetOnce: boolean;
	/** How many reaches of a ptyd of an earlier protocol fail next, as one not taking a connection now would. */
	let failEarlierClients: number;
	class FlakyEarlierPtyds extends EarlierPtyds {
		override async client(protocol: number): Promise<PtydClient> {
			if (failEarlierClients > 0) {
				failEarlierClients--;
				throw new PtydNotSent('injected: the ptyd of an earlier protocol took no connection now');
			}
			return super.client(protocol);
		}
	}
	let spawns: number;
	/** Each connection to ptyd the ports made, in order. */
	let connections: PtydClient[];
	/** How long an attach's answer is held back while the run's events go on; and whether the next attach loses its connection. */
	let delayAttach: number;
	let loseAttach: boolean;
	/** Where the next listing's answer waits, once had, until opened: what the run says meanwhile reaches the window first. */
	let listGate: { entered(): void; readonly open: Promise<void> } | undefined;
	const ports: AgentExecution[] = [];
	const extraClients: PtydClient[] = [];

	setup(async () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-exec-'));
		server = new PtydServer(ptydSocketPath(home));
		assert.strictEqual(await server.listen(), true);
		terminals = [];
		activeChanged = new TestEmitter();
		closed = new TestEmitter();
		configChanged = new TestEmitter();
		config = { 'terminal.integrated.tabs.separator': ' | ' };
		tabsChanged = new TestEmitter();
		groupsChanged = new TestEmitter();
		visibleTabs = undefined;
		activeTab = undefined;
		activeTerminal = undefined;
		commands = [];
		connectGate = undefined;
		loseSpawnReply = false;
		failConnectAfterLostSpawn = 0;
		failedConnects = 0;
		failTerminateOnce = false;
		failForgetOnce = false;
		failEarlierClients = 0;
		spawns = 0;
		connections = [];
		delayAttach = 0;
		loseAttach = false;
		listGate = undefined;
		const vscodeApi = {
			TabInputTerminal,
			TabInputText,
			commands: { executeCommand: async (command: string) => {
				commands.push(command);
				if (activeTab && (command === 'workbench.action.pinEditor' || command === 'workbench.action.unpinEditor')) {
					Object.assign(activeTab, { isPinned: command === 'workbench.action.pinEditor' });
					tabsChanged.fire({ opened: [], closed: [], changed: [activeTab] });
				}
			} },
			EventEmitter: TestEmitter,
			ThemeIcon: class { constructor(readonly id: string) { } },
			Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: path.posix.join(base.path, ...parts) }) },
			ViewColumn: { Active: -1 },
			TerminalExitReason: EXIT_REASON,
			l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])) },
			workspace: {
				getConfiguration: () => ({ get: (key: string) => config[key] }),
				onDidChangeConfiguration: configChanged.event
			},
			window: {
				get activeTerminal() { return activeTerminal; },
				tabGroups: { onDidChangeTabs: tabsChanged.event, onDidChangeTabGroups: groupsChanged.event,
					get all() { return [{ tabs: visibleTabs ?? terminals.filter(terminal => !terminal.disposed).map(terminal => terminal.tab) }]; },
					get activeTabGroup() { return { activeTab }; } },
				onDidChangeActiveTerminal: activeChanged.event,
				onDidCloseTerminal: closed.event,
				createTerminal: (options: vscode.ExtensionTerminalOptions) => {
					const terminal: FakeTerminal = {
						name: options.name, options, written: [], names: [], pending: [], opened: false, shown: [], disposed: false,
						tab: { input: new TabInputTerminal(), isPinned: false, isActive: false, label: options.name },
						show(preserveFocus) { this.shown.push(preserveFocus); },
						dispose() { this.disposed = true; }
					};
					options.pty.onDidWrite(data => terminal.written.push(data));
					options.pty.onDidChangeName?.(name => {
						terminal.names.push(name);
						// VS Code hears a pseudoterminal's names from its open on
						if (terminal.opened) {
							terminal.pending.push(name);
						}
					});
					terminals.push(terminal);
					return terminal;
				}
			}
		};
		const connect = async (...args: Parameters<typeof PtydClient.connect>) => {
			await connectGate;
			if (failConnectAfterLostSpawn && spawns) {
				failConnectAfterLostSpawn--;
				failedConnects++;
				throw new Error('injected reconnect failure');
			}
			const real = await PtydClient.connect(...args);
			connections.push(real);
			return {
				request: async <M extends Method>(method: M, params: Requests[M]['params']): Promise<Requests[M]['result']> => {
					if (method === 'spawn') { spawns++; }
					if (method === 'terminate' && failTerminateOnce) {
						failTerminateOnce = false;
						throw new PtydNotSent('injected request that did not arrive');
					}
					if (method === 'forget' && failForgetOnce) {
						failForgetOnce = false;
						throw new PtydNotSent('injected forget that did not arrive');
					}
					if (method === 'attach' && loseAttach) {
						loseAttach = false;
						const closed = new Promise<void>(resolve => real.onDidClose(resolve));
						real.dispose();
						await closed;
						throw new PtydLost('injected loss of the connection as it reattached');
					}
					const result = await real.request(method, params);
					if (method === 'list' && listGate) {
						const gate = listGate;
						listGate = undefined;
						gate.entered();
						await gate.open;
					}
					if (method === 'attach' && delayAttach) {
						// The answer is late; what the run writes meanwhile reaches the window before it, as it can on a busy host
						await new Promise(resolve => setTimeout(resolve, delayAttach));
					}
					if (method === 'spawn' && loseSpawnReply) {
						loseSpawnReply = false;
						const closed = new Promise<void>(resolve => real.onDidClose(resolve));
						real.dispose();
						await closed;
						throw new PtydLost('injected lost spawn reply');
					}
					return result;
				},
				onRunEvent: (...args: Parameters<PtydClient['onRunEvent']>) => real.onRunEvent(...args),
				onDidClose: (...args: Parameters<PtydClient['onDidClose']>) => real.onDidClose(...args),
				onDidLoseOwner: (...args: Parameters<PtydClient['onDidLoseOwner']>) => real.onDidLoseOwner(...args),
				onCall: (...args: Parameters<PtydClient['onCall']>) => real.onCall(...args),
				dispose: () => real.dispose(), get isClosed() { return real.isClosed; }
			};
		};
		Execution = withModules({ vscode: vscodeApi, './ptydClient': { PtydClient: { connect, join: PtydClient.join.bind(PtydClient) }, PtydGone, PtydLost, PtydNotSent, EarlierPtyds: FlakyEarlierPtyds, ptydSocketPath, within } })<typeof import('../host/execution/agentExecution')>(require.resolve('../host/execution/agentExecution')).AgentExecution;
	});

	teardown(() => {
		ports.splice(0).forEach(port => port.dispose());
		extraClients.splice(0).forEach(client => client.dispose());
		server.close();
		fs.rmSync(home, { recursive: true, force: true });
	});

	/** A window's execution port; `startupMs`, how long its runs are still starting while their CLIs show no activity. */
	const portOf = (startupMs?: number) => {
		const port = new Execution({ owner: 'workspace-1', ptydScript: '/nonexistent/ptyd.js', home, media: { path: '/ext/media' } as unknown as vscode.Uri, log: () => undefined, ...startupMs !== undefined ? { startupMs } : {} });
		ports.push(port);
		return port;
	};
	const facts = (run: RunId, more: Partial<PairFacts> = {}): PairFacts => ({ run, name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude', cwd: os.tmpdir(), ...more });
	const meta = (_run: RunId): RunMeta => ({
		alias: '#a1', name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: 'loc-1', cwd: os.tmpdir(),
		environment: 'local', yolo: true, createdAt: 1
	});
	const plan = (script: string): LaunchPlan => ({
		cli: 'claude', displayName: 'Claude Code', command: 'claude', executable: process.execPath, args: ['-e', script],
		env: programEnv(), cwd: os.tmpdir(),
		tools: { state: 'not_injected' }, input: { capability: { state: 'unavailable', reason: 'no input reader in this test' } }
	});
	const until = async <T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 8_000): Promise<T> => {
		const deadline = Date.now() + ms;
		for (; ;) {
			const value = await check();
			if (value !== undefined && value !== false) {
				return value;
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for ${what}.`);
			}
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};
	const screenOf = (terminal: FakeTerminal) => terminal.written.join('');
	const open = (terminal: FakeTerminal) => {
		terminal.opened = true;
		terminal.options.pty.open({ columns: 80, rows: 24 });
	};
	/**
	 * The tab of `terminal` titled `title` - by the editor or by the person - as VS Code 1.143.1 does it: the terminal's name first, then
	 * the tab's change; the same title again changes nothing.
	 */
	const titled = (terminal: FakeTerminal, title: string) => {
		if (terminal.name !== title) {
			terminal.name = terminal.tab.label = title;
			tabsChanged.fire({ opened: [], closed: [], changed: [terminal.tab] });
		}
	};
	/** The editor shows what `terminal`'s pseudoterminal said, in order, dropping line breaks and tabs as VS Code does. */
	const shows = (terminal: FakeTerminal) => {
		for (const name of terminal.pending.splice(0)) {
			titled(terminal, name.replace(/[\n\r\t]/g, ''));
		}
	};
	/** The editor names the tab by the name its terminal was created with, as VS Code does once a pseudoterminal's process is ready. */
	const resets = (terminal: FakeTerminal) => titled(terminal, terminal.options.name);
	/** A CLI that echoes what it is typed and reports itself as a status-reporting CLI does. */
	const ECHO = `process.stdin.setRawMode(true); process.stdout.write('ready\\r\\n'); process.stdin.on('data', d => { const s = d.toString(); if (s === 'q') process.exit(3); process.stdout.write('got ' + s + '\\r\\n'); }); setInterval(() => {}, 1000);`;

	test('Pin waits for its exact active tab, never focuses a background terminal, and survives a kept tab reopening', async () => {
		const port = portOf();
		const changes: unknown[] = [];
		port.onDidPinTab(change => changes.push(change));
		port.openPair(facts('run-1'), { reveal: false });
		const first = terminals[0];
		open(first);
		tabsChanged.fire({ opened: [first.tab], closed: [], changed: [] });
		port.pinTab('run-1', true);
		assert.deepStrictEqual([commands, first.shown], [[], []]);
		activeTab = first.tab; activeTerminal = first;
		activeChanged.fire(first);
		tabsChanged.fire({ opened: [], closed: [], changed: [Object.assign(first.tab, { isActive: true })] });
		await until('the exact tab pinned', () => first.tab.isPinned);
		await Promise.resolve();
		assert.deepStrictEqual(commands, ['workbench.action.pinEditor']);
		assert.deepStrictEqual(changes, [], 'programmatic synchronization does not become another human Pin');
		Object.assign(first.tab, { isPinned: false });
		tabsChanged.fire({ opened: [], closed: [], changed: [first.tab] });
		assert.deepStrictEqual(changes, [{ run: 'run-1', pinned: false }]);
		port.pinTab('run-1', true);
		await Promise.resolve();
		closed.fire(first);
		port.reopen('run-1');
		const next = terminals[1];
		open(next);
		activeTab = next.tab; activeTerminal = next;
		activeChanged.fire(next);
		tabsChanged.fire({ opened: [Object.assign(next.tab, { isActive: true })], closed: [], changed: [] });
		await until('the reopened tab pinned', () => next.tab.isPinned);
	});

	test('a rebuilt tab-group model replaces stale objects; Pin follows only the exactly correlated terminal, including duplicate names', async () => {
		const port = portOf();
		port.openPair(facts('run-1'), { reveal: false });
		const first = terminals[0]; open(first);
		tabsChanged.fire({ opened: [first.tab], closed: [], changed: [] });
		port.openPair(facts('run-2'), { reveal: false });
		const second = terminals[1]; open(second);
		tabsChanged.fire({ opened: [second.tab], closed: [], changed: [] });
		activeTab = first.tab; activeTerminal = first;
		activeChanged.fire(first);
		port.pinTab('run-1', true);
		await until('the original tab pinned', () => first.tab.isPinned);
		await Promise.resolve();
		const replacement = { ...first.tab, isActive: true }, other = { ...second.tab };
		visibleTabs = [replacement, other]; activeTab = replacement;
		groupsChanged.fire(undefined);
		port.pinTab('run-1', false);
		await until('the replacement tab unpinned', () => !replacement.isPinned);
		assert.strictEqual(first.tab.isPinned, true, 'the obsolete object is never used as the command target');
		port.pinTab('run-2', true);
		assert.deepStrictEqual([other.isPinned, first.shown, second.shown], [false, [], []]);
		// The other equal-name tab is correlated only when that terminal actually becomes active.
		activeTab = other; activeTerminal = second;
		activeChanged.fire(second);
		tabsChanged.fire({ opened: [], closed: [], changed: [Object.assign(other, { isActive: true })] });
		await until('the second exact tab pinned', () => other.isPinned);
		assert.strictEqual(replacement.isPinned, false);
	});

	test('a pair is one editor terminal from acceptance on, with the agent\'s name and its CLI\'s logo; Facade\'s lines show before any process, and the process starts in that same terminal', async () => {
		const port = portOf();
		port.openPair(facts('run-1'), { reveal: true });
		port.openPair(facts('run-2', { cli: 'other', displayName: 'Other' }), { reveal: false });
		assert.deepStrictEqual(terminals.map(each => [each.name, each.options.location, each.options.isTransient]), [
			['Ada', { viewColumn: -1, preserveFocus: false }, true],
			['Ada', { viewColumn: -1, preserveFocus: true }, true]
		]);
		assert.deepStrictEqual(terminals[0].options.iconPath, { light: { path: '/ext/media/agents/claude.svg' }, dark: { path: '/ext/media/agents/claude.svg' } });
		assert.strictEqual((terminals[1].options.iconPath as { id: string }).id, 'terminal');
		port.note('run-1', 'Starting Claude Code…');
		open(terminals[0]);
		assert.ok(screenOf(terminals[0]).includes('\x1b[2mStarting Claude Code…\x1b[0m'));
		const started = await port.spawn('run-1', plan(ECHO), meta('run-1'));
		assert.ok(started.pid > 1);
		await until('its output', () => screenOf(terminals[0]).includes('ready'));
		terminals[0].options.pty.handleInput!('hi');
		await until('its answer', () => screenOf(terminals[0]).includes('got hi'));
		assert.strictEqual(terminals.length, 2, 'no second terminal');
		assert.strictEqual(screenOf(terminals[0]).split('ready').length - 1, 1, 'its output once');
	});

	test('what the CLI reports reaches the core as activity, and its title the tab after the native separator; until its first report its run is still starting (CLIS-2.3, D81)', async () => {
		const port = portOf();
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-3'), { reveal: false });
		open(terminals[0]);
		const title = Buffer.from('Fixing tests').toString('base64');
		await port.spawn('run-3', plan(`process.stdin.setRawMode(true); process.stdout.write('\\x1b]0;\\u2733 Claude Code\\x07\\x1b]7501;?\\x1b\\\\'); process.stdin.on('data', d => { if (d.toString().includes('7501;?:')) process.stdout.write('\\x1b]7501;state=working:title=${title}\\x1b\\\\'); }); setInterval(() => {}, 1000);`), meta('run-3'));
		assert.deepStrictEqual(reports[0], { run: 'run-3', activity: 'unknown', reporting: false, awaitingActivity: true });
		await until('its report', () => reports.some(report => report.activity === 'working'));
		assert.deepStrictEqual(reports[reports.length - 1], { run: 'run-3', activity: 'working', reporting: true, title: 'Fixing tests' });
		// Its probe answered, it was still starting until it reported: never unknown with a reason meanwhile
		assert.ok(reports.slice(0, -1).every(report => report.awaitingActivity && !report.reason), JSON.stringify(reports));
		assert.strictEqual(terminals[0].names[terminals[0].names.length - 1], 'Ada | Fixing tests');
		port.rename('run-3', 'Grace');
		assert.strictEqual(terminals[0].names[terminals[0].names.length - 1], 'Grace | Fixing tests');
	});

	test('a listing answered before what the run said since is no newer than that: a reconcile never puts back an older status (CLIS-2.3, UX-5.2)', async function () {
		this.timeout(20_000);
		const port = portOf();
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-46'), { reveal: false });
		open(terminals[0]);
		// Working once its probe is answered, idle at a key
		await port.spawn('run-46', plan(`process.stdin.setRawMode(true); process.stdout.write('\\x1b]7501;?\\x1b\\\\'); process.stdin.on('data', d => process.stdout.write(d.toString().includes('7501;?:') ? '\\x1b]7501;state=working\\x1b\\\\' : '\\x1b]7501;state=idle\\x1b\\\\')); setInterval(() => {}, 1000);`), meta('run-46'));
		await until('working', () => reports.some(report => report.activity === 'working'));
		let entered!: () => void;
		let release!: () => void;
		const asked = new Promise<void>(resolve => { entered = resolve; });
		listGate = { entered, open: new Promise<void>(resolve => { release = resolve; }) };
		// A reconcile's listing has its answer - working - and waits; meanwhile the run goes idle
		await asked;
		terminals[0].options.pty.handleInput!('x');
		await until('idle', () => reports[reports.length - 1]?.activity === 'not_working');
		release();
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepStrictEqual(reports.slice(reports.findIndex(report => report.activity === 'not_working')).map(report => report.activity), ['not_working']);
		assert.strictEqual(await port.terminate('run-46'), 'terminated');
	});

	/** A CLI that says it is ready and then nothing, taking no part in the protocol. */
	const QUIET = `process.stdout.write('ready\\r\\n'); setInterval(() => {}, 1000);`;

	test('a run whose CLI shows no activity is still starting until its bound from its process start, then unknown with why; a reloaded window counts from that start, not its own (CLIS-2.3, D81)', async function () {
		this.timeout(30_000);
		const BOUND = 2_000;
		const first = portOf(BOUND);
		const reports: ActivityReport[] = [];
		first.onDidReport(report => reports.push(report));
		first.openPair(facts('run-40'), { reveal: false });
		open(terminals[0]);
		const before = performance.now();
		await first.spawn('run-40', plan(QUIET), meta('run-40'));
		assert.deepStrictEqual(reports, [{ run: 'run-40', activity: 'unknown', reporting: false, awaitingActivity: true }]);
		/** The window `from` reloads: the next one claims the run again, and what it tells of it. */
		const reload = async (from: AgentExecution) => {
			ports.splice(ports.indexOf(from), 1);
			from.dispose();
			const next = portOf(BOUND);
			const told: ActivityReport[] = [];
			next.onDidReport(report => told.push(report));
			const live = await until('the run to be unclaimed', async () => {
				const runs = await next.live();
				return runs.length === 1 && !runs[0].claimedElsewhere && runs;
			});
			const count = terminals.length;
			const attaching = next.attach(live[0], facts('run-40'));
			await until('its restored terminal', () => terminals.length > count);
			open(terminals[terminals.length - 1]);
			await attaching;
			return { next, told };
		};
		// Reloaded within its bound: still starting, until the bound from its process start passes
		const { next, told } = await reload(first);
		assert.deepStrictEqual(told, [{ run: 'run-40', activity: 'unknown', reporting: false, awaitingActivity: true }]);
		const over = await until('its startup over', () => told.find(report => !report.awaitingActivity), 6_000);
		assert.ok(performance.now() - before >= BOUND - 50, 'not before its bound');
		assert.deepStrictEqual(over, { run: 'run-40', activity: 'unknown', reporting: false, reason: 'The CLI has not reported its activity' });
		// Reloaded past it: unknown at once, its startup not begun again
		const last = await reload(next);
		assert.deepStrictEqual(last.told, [{ run: 'run-40', activity: 'unknown', reporting: false, reason: 'The CLI has not reported its activity' }]);
		assert.strictEqual(await last.next.terminate('run-40'), 'terminated');
	});

	test('a CLI that asked whether its terminal takes reports and has not reported since is still starting until its bound, then waited for with why (CLIS-2.3, D81)', async function () {
		this.timeout(20_000);
		// A bound its program asks well within: Node takes a second or two to start in a Windows console
		const port = portOf(4_000);
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-41'), { reveal: false });
		open(terminals[0]);
		await port.spawn('run-41', plan(`process.stdin.setRawMode(true); process.stdout.write('\\x1b]7501;?\\x1b\\\\'); setInterval(() => {}, 1000);`), meta('run-41'));
		await until('its probe answered', () => reports.some(report => report.reporting));
		const over = await until('its startup over', () => reports.find(report => !report.awaitingActivity), 10_000);
		assert.deepStrictEqual(over, { run: 'run-41', activity: 'unknown', reporting: true, reason: 'Waiting for the CLI\'s first activity report' }, JSON.stringify(reports));
		assert.ok(reports.slice(0, -1).every(report => report.awaitingActivity), JSON.stringify(reports));
		assert.strictEqual(reports.at(-2)?.reporting, true);
	});

	test('a run whose CLI showed its activity - its screen read, here - is not starting again as its CLI then asks whether its terminal takes reports and has not reported yet (CLIS-2.3, D81)', async () => {
		const port = portOf(10_000);
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-43', { cli: 'muse', displayName: 'Muse Code', command: 'muse' }), { reveal: false });
		open(terminals[0]);
		const idle = `── Voice input (Alt+V to start) ${'─'.repeat(30)}\r\n❯\r\n${'─'.repeat(60)}\r\n  muse-spark-1.3 · minimal · /work`;
		const script = `process.stdin.setRawMode(true); process.stdout.write('\\x1b[2J\\x1b[H' + ${JSON.stringify(idle)}); setTimeout(() => process.stdout.write('\\x1b]7501;?\\x1b\\\\'), 800); setInterval(() => {}, 1000);`;
		await port.spawn('run-43', { ...plan(script), cli: 'muse', displayName: 'Muse Code', command: 'muse', screenStatus: 'muse' }, meta('run-43'));
		await until('its screen read', () => reports.some(report => report.activity === 'not_working'));
		const asked = await until('its probe told', () => reports.find(report => report.reporting && report.activity === 'unknown'), 5_000);
		assert.deepStrictEqual(asked, { run: 'run-43', activity: 'unknown', reporting: true, reason: 'Waiting for the CLI\'s first activity report' });
		assert.strictEqual(await port.terminate('run-43'), 'terminated');
	});

	test('a run started in a new worktree is read by the folder it runs in there: a CLI title naming that folder alone is no title (CLIS-2.3)', async function () {
		this.timeout(15_000);
		const port = portOf();
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-wt-'));
		try {
			// Accepted in its source folder; the worktree made, it starts in the worktree's
			port.openPair(facts('run-47', { cli: 'pi', displayName: 'Pi', command: 'pi', cwd: os.tmpdir() }), { reveal: false });
			open(terminals[0]);
			await port.spawn('run-47', { ...plan(`process.stdout.write('\\x1b]0;π - ${path.basename(worktree)}\\x07ready\\r\\n'); setInterval(() => {}, 1000);`), cli: 'pi', displayName: 'Pi', command: 'pi', cwd: worktree }, meta('run-47'));
			await until('its screen', () => screenOf(terminals[0]).includes('ready'));
			await new Promise(resolve => setTimeout(resolve, 300));
			assert.deepStrictEqual(reports.filter(report => report.title !== undefined), []);
			assert.strictEqual(await port.terminate('run-47'), 'terminated');
		} finally {
			fs.rmSync(worktree, { recursive: true, force: true });
		}
	});

	/** A CLI that says a numbered line every 20 ms, from 1 on. */
	const COUNTING = `let n = 0; setInterval(() => process.stdout.write('line ' + (++n) + '\\r\\n'), 20);`;
	/** The numbers of `text`'s lines, in the order written. */
	const numbersIn = (text: string) => [...text.matchAll(/line (\d+)/g)].map(match => Number(match[1]));
	/** The window `from` reloads: the next one finds the run and claims it again, its terminal opened; what it tells and shows. */
	const reloadWith = async (from: AgentExecution, run: RunId) => {
		ports.splice(ports.indexOf(from), 1);
		from.dispose();
		const next = portOf();
		const told: ActivityReport[] = [];
		next.onDidReport(report => told.push(report));
		const live = await until('the run to be unclaimed', async () => {
			const runs = await next.live();
			return runs.length === 1 && !runs[0].claimedElsewhere && runs;
		});
		const count = terminals.length;
		const attaching = next.attach(live[0], facts(run));
		await until('its restored terminal', () => terminals.length > count);
		const terminal = terminals[terminals.length - 1];
		open(terminal);
		await attaching;
		return { next, told, terminal, live: live[0] };
	};

	test('what a run writes while a reloaded window claims it, before the answer with its screen, is drawn after that screen: no line lost (ARCHITECTURE-2.3, LIFECYCLE-3.5)', async function () {
		this.timeout(20_000);
		const first = portOf();
		first.openPair(facts('run-44'), { reveal: false });
		open(terminals[0]);
		await first.spawn('run-44', plan(COUNTING), meta('run-44'));
		await until('its first lines', () => numbersIn(screenOf(terminals[0])).length > 5);
		delayAttach = 400;
		const { next, terminal } = await reloadWith(first, 'run-44');
		delayAttach = 0;
		await new Promise(resolve => setTimeout(resolve, 600));
		const numbers = numbersIn(screenOf(terminal));
		const gaps = numbers.slice(1).filter((each, index) => each !== numbers[index] + 1);
		assert.ok(numbers.length > 20, JSON.stringify(numbers));
		assert.deepStrictEqual(gaps, [], `lines lost or repeated: ${JSON.stringify(numbers)}`);
		assert.strictEqual(await next.terminate('run-44'), 'terminated');
	});

	test('a reloaded window whose connection goes as it claims a run keeps the agent, told as lost, and claims it again once connected: never forgotten for a moment (RULES-4.1, LIFECYCLE-3.5)', async function () {
		this.timeout(20_000);
		const first = portOf();
		first.openPair(facts('run-45'), { reveal: false });
		open(terminals[0]);
		await first.spawn('run-45', plan(QUIET), meta('run-45'));
		await until('its screen', () => screenOf(terminals[0]).includes('ready'));
		loseAttach = true;
		const { next, told, terminal } = await reloadWith(first, 'run-45');
		assert.strictEqual(told[0]?.disconnected, true, JSON.stringify(told));
		await until('the run claimed again', () => told.some(report => !report.disconnected), 10_000);
		await until('its screen drawn again', () => screenOf(terminal).includes('ready'), 10_000);
		assert.strictEqual(await next.terminate('run-45'), 'terminated');
	});

	test('a run that ends after a reloaded window lists it, before the window claims it, is told ended once the window shows it: its card does not stay running (RULES-3.3)', async function () {
		this.timeout(20_000);
		const first = portOf();
		first.openPair(facts('run-46'), { reveal: false });
		open(terminals[0]);
		await first.spawn('run-46', plan(`process.stdout.write('ready\\r\\n'); setTimeout(() => process.exit(5), 3000);`), meta('run-46'));
		await until('its screen', () => screenOf(terminals[0]).includes('ready'));
		ports.splice(ports.indexOf(first), 1);
		first.dispose();
		const next = portOf();
		const exits: ExitReport[] = [];
		next.onDidExit(exit => exits.push(exit));
		const listed = await until('the run listed, still running', async () => {
			const runs = await next.live();
			return runs.length === 1 && !runs[0].exited && runs;
		});
		await until('the run ended, unclaimed', async () => (await next.live())[0]?.exited, 10_000);
		const count = terminals.length;
		const attaching = next.attach(listed[0], facts('run-46'));
		await until('its restored terminal', () => terminals.length > count);
		open(terminals[terminals.length - 1]);
		await attaching;
		assert.deepStrictEqual(exits, [], 'told once the core has shown it');
		await until('its end told', () => exits.length > 0);
		assert.deepStrictEqual(exits, [{ run: 'run-46', code: 5, interruptVerified: false }]);
		assert.ok(screenOf(terminals[terminals.length - 1]).includes('[Agent process exited with code 5]'));
	});

	test('a run whose reattach failed, or that went to another window, has its conversation watched by this window no more (CLIS-2.4)', async function () {
		this.timeout(20_000);
		const first = portOf();
		const identified: string[] = [];
		first.onDidIdentify(({ run }) => identified.push(run));
		first.openPair(facts('run-47'), { reveal: false });
		open(terminals[0]);
		await first.spawn('run-47', { ...plan(QUIET), exactResume: true }, { ...meta('run-47'), exactResume: true });
		await until('its screen', () => screenOf(terminals[0]).includes('ready'));
		// Another window of the workspace takes it over: the first watches its conversation no more
		const next = portOf();
		const nextIdentified: string[] = [];
		next.onDidIdentify(({ run }) => nextIdentified.push(run));
		const listed = await until('the run listed', async () => {
			const runs = await next.live();
			return runs.length === 1 && runs;
		});
		// Its reattach fails - the run went as it was listed - and the second watches it no more either
		assert.strictEqual(await next.terminate('run-47'), 'terminated');
		await assert.rejects(next.attach(listed[0], facts('run-47')));
		fs.mkdirSync(path.join(home, 'runs'), { recursive: true });
		fs.writeFileSync(path.join(home, 'runs', 'run-47.session.json'), JSON.stringify({ session_id: '12345678-1234-4234-8234-123456789abc' }));
		await new Promise(resolve => setTimeout(resolve, 1_500));
		assert.deepStrictEqual([identified, nextIdentified], [[], []]);
	});

	test('a window that shows no run connects again when its connection goes: its claim, which ptyd would let expire, is kept (RULES-4.1, D75)', async function () {
		this.timeout(20_000);
		const port = portOf();
		assert.deepStrictEqual(await port.live(), []);
		assert.strictEqual(connections.length, 1);
		connections[0].dispose();
		await until('a new connection', () => connections.length === 2, 10_000);
		assert.ok(!connections[1].isClosed);
	});

	test('a run whose startup ends while the connection to ptyd is lost is still told as lost - a rename meanwhile tells nothing more; claimed again, it is told past its startup (CLIS-2.3, RULES-3.1)', async function () {
		this.timeout(20_000);
		const port = portOf(400);
		const heard: { readonly report: ActivityReport; readonly connections: number }[] = [];
		port.onDidReport(report => heard.push({ report, connections: connections.length }));
		port.openPair(facts('run-42'), { reveal: false });
		open(terminals[0]);
		await port.spawn('run-42', plan(QUIET), meta('run-42'));
		assert.strictEqual(connections.length, 1);
		// The connection goes while its run is starting, ptyd keeping the run; the port connects again a second later
		connections[0].dispose();
		await until('the loss told', () => heard.some(each => each.report.disconnected));
		port.rename('run-42', 'Grace');
		const back = await until('the run claimed again', () => heard.find(each => !each.report.disconnected && heard.indexOf(each) > heard.findIndex(lost => lost.report.disconnected)), 10_000);
		assert.deepStrictEqual(back, { report: { run: 'run-42', activity: 'unknown', reporting: false, reason: 'The CLI has not reported its activity' }, connections: 2 });
		assert.strictEqual(await port.terminate('run-42'), 'terminated');
	});

	/** A CLI that titles its terminal "Fixing tests" and says it is ready, then retitles it with whatever it is typed. */
	const TITLED = `process.stdin.setRawMode(true); process.stdout.write('\\x1b]0;Fixing tests\\x07ready\\r\\n'); process.stdin.on('data', d => process.stdout.write('\\x1b]0;' + d.toString() + '\\x07')); setInterval(() => {}, 1000);`;
	/** The core's part, as AgentService does it: a label renames the agent and its tab, including an empty string. */
	const renamesOf = (port: AgentExecution) => {
		const renames: { run: RunId; name: string }[] = [];
		port.onDidRenameTab(rename => {
			renames.push(rename);
			port.rename(rename.run, rename.name.trim());
		});
		return renames;
	};
	/** A new agent whose CLI titled its tab, as the editor shows it: `<name> | Fixing tests`. */
	const agentTitled = async (port: AgentExecution, run: RunId, name = 'Ada') => {
		port.openPair(facts(run, { name }), { reveal: false });
		const terminal = terminals[terminals.length - 1];
		open(terminal);
		await port.spawn(run, plan(TITLED), meta(run));
		await until('the CLI title said', () => terminal.pending.includes(`${name} | Fixing tests`));
		await until('its screen', () => screenOf(terminal).includes('ready'));
		shows(terminal);
		assert.strictEqual(terminal.name, `${name} | Fixing tests`);
		return terminal;
	};

	test('a person\'s rename of an agent\'s tab, read from its own terminal, renames the agent; its tab then has the new name and the CLI title (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-r');
		titled(terminal, 'Grace Hopper');
		assert.deepStrictEqual([renames, terminal.pending], [[{ run: 'run-r', name: 'Grace Hopper' }], ['Grace Hopper | Fixing tests']]);
		shows(terminal);
		assert.deepStrictEqual([renames.length, terminal.name], [1, 'Grace Hopper | Fixing tests'], 'its own name shown is no rename');
	});

	test('a person renaming a tab back to the name it had - after naming it with the separator and CLI title kept - renames the agent back: a name the tab already showed is no echo (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-x4');
		titled(terminal, 'Bob | Fixing tests');
		shows(terminal);
		titled(terminal, 'Ada | Fixing tests');
		assert.deepStrictEqual(renames.map(each => each.name), ['Bob', 'Ada']);
	});

	test('a person who kept the separator and CLI title renaming the tab - the ones it showed then, though the CLI retitled it since - names the agent by what is before them (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-s');
		titled(terminal, 'Lin | Fixing tests');
		shows(terminal);
		// The CLI retitles its tab twice; the editor shows each name late, in order: none is a rename
		terminal.options.pty.handleInput!('Writing docs');
		await until('the new title said', () => terminal.pending.includes('Lin | Writing docs'));
		terminal.options.pty.handleInput!('Reading');
		await until('the next title said', () => terminal.pending.includes('Lin | Reading'));
		shows(terminal);
		// The person renames it from what the tab showed before the last retitle
		titled(terminal, 'Kim | Writing docs');
		shows(terminal);
		assert.deepStrictEqual([renames, terminal.name], [[{ run: 'run-s', name: 'Lin' }, { run: 'run-s', name: 'Kim' }], 'Kim | Reading']);
	});

	test('a tab accepts human and an empty label, preserving its CLI title (LIFECYCLE-2.1, 2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-i');
		for (const typed of ['human', '   ', '@Human | Fixing tests', ' Ada ']) {
			titled(terminal, typed);
			shows(terminal);
			assert.strictEqual(terminal.name, `${typed.replace(/ \| Fixing tests$/, '').trim()} | Fixing tests`, typed);
		}
		assert.deepStrictEqual(renames.map(each => each.name), ['human', '   ', '@Human', ' Ada ']);
	});

	test('the editor naming a tab by the name its terminal was created with - once it opens, and again as it is relaunched - is no rename: the tab gets its name back at once; after the agent was renamed, a person naming the tab so renames it (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		// A run shown again after a reload: its CLI title is known as its terminal opens
		port.openPair(facts('run-t'), { reveal: false });
		const terminal = terminals[0];
		await port.spawn('run-t', plan(TITLED), meta('run-t'));
		await until('the CLI title known', () => terminal.names.includes('Ada | Fixing tests'));
		open(terminal);
		await until('its screen', () => screenOf(terminal).includes('ready'));
		shows(terminal);
		resets(terminal);
		assert.deepStrictEqual([renames, terminal.pending], [[], ['Ada | Fixing tests']]);
		shows(terminal);
		// Relaunched, VS Code closes and opens the same pseudoterminal again, then names the tab by the name it was created with
		terminal.options.pty.close();
		open(terminal);
		shows(terminal);
		resets(terminal);
		shows(terminal);
		assert.deepStrictEqual([renames, terminal.name], [[], 'Ada | Fixing tests']);
		port.rename('run-t', 'Grace');
		shows(terminal);
		titled(terminal, 'Ada');
		shows(terminal);
		assert.deepStrictEqual([renames, terminal.name], [[{ run: 'run-t', name: 'Ada' }], 'Ada | Fixing tests']);
	});

	test('two agents of one name and title: a person\'s rename of either tab renames that agent alone, by its own terminal (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const first = await agentTitled(port, 'run-a');
		const second = await agentTitled(port, 'run-b');
		assert.strictEqual(first.name, second.name);
		titled(second, 'Grace | Fixing tests');
		shows(second);
		titled(first, 'Lin');
		shows(first);
		assert.deepStrictEqual([renames, first.name, second.name], [[{ run: 'run-b', name: 'Grace' }, { run: 'run-a', name: 'Lin' }], 'Lin | Fixing tests', 'Grace | Fixing tests']);
	});

	test('a terminal renamed with no tab change to say so - moved into the panel, it has no tab - is found renamed as the runs are checked (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-p');
		terminal.name = 'Pan';
		await until('the rename found', () => renames.length > 0, 4_000);
		assert.deepStrictEqual(renames, [{ run: 'run-p', name: 'Pan' }]);
	});

	test('a lost connection to ptyd leaves each live run\'s activity unknown with why; a reconnect that fails is tried again until it is made (RULES-3.1, 3.2)', async function () {
		this.timeout(30_000);
		const port = portOf();
		const reports: ActivityReport[] = [];
		const exits: ExitReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.onDidExit(exit => exits.push(exit));
		port.openPair(facts('run-30'), { reveal: false });
		open(terminals[0]);
		const title = Buffer.from('Fixing tests').toString('base64');
		await port.spawn('run-30', plan(`process.stdin.setRawMode(true); process.stdout.write('\\x1b]7501;?\\x1b\\\\'); process.stdin.on('data', d => { if (d.toString().includes('7501;?:')) process.stdout.write('\\x1b]7501;state=working:title=${title}\\x1b\\\\'); }); setInterval(() => {}, 1000);`), meta('run-30'));
		await until('its report', () => reports.some(report => report.activity === 'working'));
		server.close();
		const lost = await until('the loss told', () => reports.find(report => report.activity === 'unknown' && /connection/.test(report.reason ?? '')));
		assert.deepStrictEqual(lost, { run: 'run-30', activity: 'unknown', reporting: true, reason: 'The connection to the agent\'s process was lost; reconnecting', disconnected: true, title: 'Fixing tests' });
		// ptyd stays away past the first try to connect again, which gives up; it comes back, and a later check claims the run again
		await new Promise(resolve => setTimeout(resolve, 7_000));
		assert.deepStrictEqual(exits, []);
		server = new PtydServer(ptydSocketPath(home));
		assert.strictEqual(await server.listen(), true);
		// The new ptyd does not hold it: it is gone, how is not known
		await until('the run found gone', () => exits.length === 1, 10_000);
		assert.deepStrictEqual(exits, [{ run: 'run-30', interruptVerified: false }]);
	});

	test('an exit is told once with its code, the pair kept to show how; the person\'s close of the tab is reported as their close, a window shutdown is not; activation is by exact identity', async () => {
		const port = portOf();
		const exits: ExitReport[] = [];
		const closes: RunId[] = [];
		const activations: (RunId | undefined)[] = [];
		port.onDidExit(exit => exits.push(exit));
		port.onDidClosePair!(run => closes.push(run));
		port.onDidActivate(run => activations.push(run));
		port.openPair(facts('run-4'), { reveal: false });
		open(terminals[0]);
		await port.spawn('run-4', plan(ECHO), meta('run-4'));
		await until('its output', () => screenOf(terminals[0]).includes('ready'));
		terminals[0].options.pty.handleInput!('q');
		await until('its exit', () => exits.length > 0);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.deepStrictEqual(exits, [{ run: 'run-4', code: 3, interruptVerified: false }]);
		assert.ok(screenOf(terminals[0]).includes("[Agent process exited with code 3]"));
		assert.strictEqual(await port.reveal('run-4', { preserveFocus: true }), true);
		assert.deepStrictEqual(terminals[0].shown, [true]);
		assert.strictEqual(await port.reveal('run-unknown', { preserveFocus: true }), false);
		activeChanged.fire(terminals[0]);
		activeChanged.fire({ name: 'Ada' });
		activeChanged.fire(undefined);
		assert.deepStrictEqual(activations, ['run-4', undefined, undefined]);
		closed.fire(Object.assign(terminals[0], { exitStatus: { reason: EXIT_REASON.Shutdown, code: undefined } }));
		assert.deepStrictEqual(closes, []);
		port.openPair(facts('run-5'), { reveal: false });
		closed.fire(Object.assign(terminals[1], { exitStatus: { reason: EXIT_REASON.User, code: undefined } }));
		assert.deepStrictEqual(closes, ['run-5']);
	});

	test('a run the person kept after closing its tab opens in a new tab - the same pseudoterminal, its screen drawn again - and so does revealing it (LIFECYCLE-3.1)', async () => {
		const port = portOf();
		const closes: RunId[] = [];
		port.onDidClosePair!(run => closes.push(run));
		port.openPair(facts('run-7'), { reveal: false });
		open(terminals[0]);
		await port.spawn('run-7', plan(ECHO), meta('run-7'));
		await until('its output', () => screenOf(terminals[0]).includes('ready'));
		closed.fire(Object.assign(terminals[0], { exitStatus: { reason: EXIT_REASON.User, code: undefined } }));
		assert.deepStrictEqual(closes, ['run-7']);
		port.reopen('run-7');
		assert.strictEqual(terminals.length, 2);
		assert.strictEqual(terminals[1].options.pty, terminals[0].options.pty);
		open(terminals[1]);
		await until('its screen drawn again in the new tab', () => screenOf(terminals[1]).includes('ready'));
		closed.fire(Object.assign(terminals[1], { exitStatus: { reason: EXIT_REASON.User, code: undefined } }));
		assert.strictEqual(await port.reveal('run-7', { preserveFocus: false }), true);
		assert.strictEqual(terminals.length, 3);
	});

	test('removing a pair disposes its terminal at once - no close of the person\'s - ends a live process in the background and lets ptyd forget the run; removing it again does nothing', async () => {
		const port = portOf();
		const closes: RunId[] = [];
		port.onDidClosePair!(run => closes.push(run));
		port.openPair(facts('run-6'), { reveal: false });
		open(terminals[0]);
		const { pid } = await port.spawn('run-6', plan(ECHO), meta('run-6'));
		port.removePair('run-6');
		port.removePair('run-6');
		assert.strictEqual(terminals[0].disposed, true);
		closed.fire(Object.assign(terminals[0], { exitStatus: { reason: EXIT_REASON.Extension, code: undefined } }));
		assert.deepStrictEqual(closes, []);
		assert.strictEqual(await port.terminate('run-6'), 'terminated');
		const observer = await PtydClient.connect(ptydSocketPath(home), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
		extraClients.push(observer);
		await until('ptyd to forget it', async () => (await observer.request('list', { owner: 'workspace-1' })).length === 0);
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
	});

	test('a pair closed while its CLI starts never leaves the process running', async () => {
		const port = portOf();
		port.openPair(facts('run-7'), { reveal: false });
		const starting = port.spawn('run-7', plan(ECHO), meta('run-7'));
		port.removePair('run-7');
		await assert.rejects(starting, /closed before its CLI started/);
		const observer = await PtydClient.connect(ptydSocketPath(home), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
		extraClients.push(observer);
		await until('ptyd to end and forget it', async () => (await observer.request('list', { owner: 'workspace-1' })).length === 0);
	});

	test('close while the initial handshake is pending sends no spawn and creates no file effect', async () => {
		let release!: () => void;
		connectGate = new Promise(resolve => release = resolve);
		const port = portOf();
		port.openPair(facts('closed-before-connect'), { reveal: false });
		const effect = path.join(home, 'should-not-exist');
		const starting = port.spawn('closed-before-connect', plan(`require('fs').writeFileSync(${JSON.stringify(effect)}, 'bad'); ${ECHO}`), meta('closed-before-connect'));
		port.removePair('closed-before-connect');
		release();
		await assert.rejects(starting, /closed before its CLI started/);
		assert.deepStrictEqual([spawns, fs.existsSync(effect)], [0, false]);
	});

	test('a lost spawn reply reattaches the same process without issuing another spawn', async () => {
		loseSpawnReply = true;
		const port = portOf();
		port.openPair(facts('lost-spawn'), { reveal: false });
		open(terminals[0]);
		const started = await port.spawn('lost-spawn', plan(ECHO), meta('lost-spawn'));
		await until('the recovered screen', () => screenOf(terminals[0]).includes('ready'));
		const [live] = await port.live();
		terminals[0].options.pty.handleInput!('after-loss');
		await until('input on the original process', () => screenOf(terminals[0]).includes('got after-loss'));
		assert.deepStrictEqual([spawns, live.pid, live.startedAt, terminals.length], [1, started.pid, started.startedAt, 1]);
	});

	test('an accepted start survives a lost reply plus repeated reconnect failure, without a false failed record or duplicate start', async () => {
		loseSpawnReply = true;
		failConnectAfterLostSpawn = 2;
		const port = portOf();
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('lost-then-unreachable'), { reveal: false });
		open(terminals[0]);
		const starting = port.spawn('lost-then-unreachable', plan(ECHO), meta('lost-then-unreachable'));
		await until('the disconnected state', () => reports.some(report => report.disconnected));
		const started = await starting;
		const [live] = await port.live();
		assert.deepStrictEqual([spawns, failedConnects, live.pid, live.startedAt, terminals.length, reports.at(-1)?.disconnected],
			[1, 2, started.pid, started.startedAt, 1, undefined]);
	});

	test('a close request that was not sent is reconciled without forgetting the still-running original', async () => {
		const port = portOf();
		port.openPair(facts('pending-close'), { reveal: false });
		open(terminals[0]);
		const started = await port.spawn('pending-close', plan(ECHO), meta('pending-close'));
		failTerminateOnce = true;
		port.removePair('pending-close');
		assert.strictEqual(await port.terminate('pending-close'), 'unconfirmed');
		const observer = await PtydClient.connect(ptydSocketPath(home), '/unused', '/unused');
		extraClients.push(observer);
		assert.strictEqual((await observer.request('list', { owner: 'workspace-1' }))[0].pid, started.pid);
		await until('the pending close to be reconciled', async () => (await observer.request('list', { owner: 'workspace-1' })).length === 0);
		await until('the process actually to exit', () => { try { process.kill(started.pid, 0); return false; } catch { return true; } });
	});

	test('a newer window takes over immediately without ending the previous process; reload and terminal Relaunch redraw its screen once', async () => {
		const first = portOf();
		first.openPair(facts('run-8'), { reveal: false });
		open(terminals[0]);
		await first.spawn('run-8', plan(`process.stdout.write('\\x1b]0;Reload title\\x07');${ECHO}`), meta('run-8'));
		await until('its output', () => screenOf(terminals[0]).includes('ready'));
		let transferred = 0;
		first.onDidLoseOwnership(() => transferred++);
		const other = portOf();
		assert.deepStrictEqual((await other.live()).map(run => [run.run, run.claimedElsewhere]), [['run-8', false]]);
		await until('the old UI to detach', () => transferred === 1 && terminals[0].disposed);
		assert.strictEqual(await first.terminate('run-8'), 'unconfirmed', 'a transferred UI cannot clean up its successor');
		// The window reloads: its extension host goes, and with it its connection
		ports.splice(ports.indexOf(first), 1);
		first.dispose();
		const reloaded = portOf();
		const live = await until('the run to be unclaimed', async () => {
			const runs = await reloaded.live();
			return runs.length === 1 && !runs[0].claimedElsewhere && runs;
		});
		assert.deepStrictEqual([live[0].meta, live[0].exited], [meta('run-8'), undefined]);
		const count = terminals.length;
		let attached = false;
		const attaching = reloaded.attach(live[0], facts('run-8')).then(() => { attached = true; });
		await until('the restored native terminal', () => terminals.length > count);
		const terminal = terminals[terminals.length - 1];
		assert.strictEqual(terminal.name, 'Ada | Reload title', 'a background tab has the restored title even before its pseudoterminal opens');
		assert.strictEqual(attached, false, 'restoring the next editor waits for this terminal to open');
		open(terminal);
		await attaching;
		await until('its screen', () => screenOf(terminal).includes('ready'));
		terminal.options.pty.handleInput!('back');
		await until('its answer', () => screenOf(terminal).includes('got back'));
		assert.strictEqual(screenOf(terminal).split('ready').length - 1, 1);
		// Native Relaunch clears the editor's screen and reopens this pseudoterminal, while its CLI keeps running.
		terminal.written.length = 0;
		terminal.options.pty.close();
		open(terminal);
		await until('the same live screen after terminal relaunch', () => screenOf(terminal).includes('got back'));
		assert.strictEqual(screenOf(terminal).split('ready').length - 1, 1);
		assert.strictEqual(await reloaded.terminate('run-8'), 'terminated');
	});

	/** A ptyd of an earlier protocol, holding a run its window started before that window reloaded into this build. */
	const earlierWith = async (run: RunId, protocol = EARLIER_PROTOCOLS[0], owner = 'workspace-1', extra: Partial<RunMeta> = {}): Promise<{ readonly server: PtydServer; readonly socket: string }> => {
		const socket = ptydSocketPath(home, protocol);
		const server = new PtydServer(socket, () => undefined, undefined, protocol);
		assert.strictEqual(await server.listen(), true);
		const before = (await PtydClient.join(socket, protocol))!;
		await before.request('claim', nextOwnerClaim(owner, home));
		await before.request('spawn', {
			run, owner, file: process.execPath, args: ['-e', ECHO], cwd: os.tmpdir(), env: programEnv(), cols: 80, rows: 24, meta: { ...meta(run), ...extra }
		});
		before.dispose();
		return { server, socket };
	};

	test('global discovery preserves another window\'s protocol-9 tool files and excludes its exact conversation without taking ownership', async () => {
		const prior = await earlierWith('prior-other-window', 9, 'other-workspace', { sessionId: 'exact-prior', cli: 'claude', environment: 'local' });
		try {
			const port = portOf();
			assert.ok((await port.allRunIds()).includes('prior-other-window'));
			assert.deepStrictEqual(await port.conversations(), [{ sessionId: 'exact-prior', cli: 'claude', environment: 'local' }]);
			assert.deepStrictEqual(await port.live(), [], 'no ownership of another window was taken');
		} finally { prior.server.close(); }
	});
	test('the running conversations leave out a run being closed: its process may still be ending, and its conversation is free to resume (LIFECYCLE-3.2, 3.5)', async () => {
		const port = portOf();
		port.openPair(facts('run-c'), { reveal: false });
		open(terminals[0]);
		await port.spawn('run-c', plan(ECHO), { ...meta('run-c'), sessionId: 'exact-closing' });
		assert.deepStrictEqual(await port.conversations(), [{ environment: 'local', cli: 'claude', sessionId: 'exact-closing' }]);
		// Let go of as a close lets go of it, before its process has ended
		const client = await (port as unknown as { session: { client(): Promise<PtydClient> } }).session.client();
		await client.request('forget', { run: 'run-c' });
		assert.deepStrictEqual(await port.conversations(), []);
	});

	test('a run in the ptyd of an earlier protocol - its window reloaded into this build - is listed, shown and operated through that ptyd: its screen, what is typed, its close; a new agent starts in this window\'s own (ARCHITECTURE-2.4, RULES-4.1, D86)', async function () {
		this.timeout(20_000);
		const protocol = EARLIER_PROTOCOLS[0];
		const earlier = await earlierWith('run-old');
		try {
			const port = portOf();
			const live = await port.live();
			assert.deepStrictEqual(live.map(run => [run.run, run.meta.name, run.claimedElsewhere]), [['run-old', 'Ada', false]]);
			const attaching = port.attach(live[0], facts('run-old'));
			const terminal = await until('its terminal', () => terminals[0]);
			open(terminal);
			await attaching;
			await until('its screen', () => screenOf(terminal).includes('ready'));
			terminal.options.pty.handleInput!('old');
			await until('its answer, through the earlier ptyd', () => screenOf(terminal).includes('got old'));
			// Protocol 8 has no MCP screen/input operations. They fail before sending, without targeting the newer ptyd.
			for (const ask of [
				() => port.readScreen('run-old', 20),
				() => port.typeText('run-old', 'do not send', true),
				() => port.pressKeys('run-old', ['Enter']),
				() => port.inspectInput('run-old', 'claude-frame')
			]) {
				await assert.rejects(ask, error => error instanceof PtydNotSent && /does not support MCP screen or input requests/.test(error.message));
			}
			// A new agent starts in this window's own ptyd alone
			port.openPair(facts('run-new'), { reveal: false });
			open(terminals[1]);
			await port.spawn('run-new', plan(ECHO), meta('run-new'));
			const own = await PtydClient.connect(ptydSocketPath(home), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
			const old = (await PtydClient.join(earlier.socket, protocol))!;
			extraClients.push(own, old);
			const runsOf = async (client: PtydClient) => (await client.request('list', { owner: 'workspace-1' })).map(run => run.run);
			assert.deepStrictEqual([await runsOf(own), await runsOf(old)], [['run-new'], ['run-old']]);
			// Closing it ends it there
			assert.strictEqual(await port.terminate('run-old'), 'terminated');
			assert.deepStrictEqual(await runsOf(old), []);
		} finally {
			earlier.server.close();
		}
	});

	test('the ptyd of an earlier protocol going takes the window\'s runs there with it: each is told ended, how not known, and its terminal says so - never left out (RULES-3.3, 4.1, D86)', async function () {
		this.timeout(20_000);
		const earlier = await earlierWith('run-gone');
		try {
			const port = portOf();
			const exits: ExitReport[] = [];
			port.onDidExit(exit => exits.push(exit));
			const [live] = await port.live();
			const attaching = port.attach(live, facts('run-gone'));
			const terminal = await until('its terminal', () => terminals[0]);
			open(terminal);
			await attaching;
			await until('its screen', () => screenOf(terminal).includes('ready'));
			// Its ptyd goes with the run, telling the window nothing more
			earlier.server.close();
			await until('its end told', () => exits.length === 1);
			assert.deepStrictEqual(exits, [{ run: 'run-gone', interruptVerified: false }]);
			await until('its terminal to say so', () => screenOf(terminal).includes('[Agent process disconnected; exit cause unknown]'));
		} finally {
			earlier.server.close();
		}
	});

	test('after its first restore, a run a ptyd lists that the window shows no pair of - its reattach failed, or its ptyd was found late - is told once a while, for the window to restore again (RULES-4.1, D86)', async function () {
		this.timeout(15_000);
		const first = portOf();
		first.openPair(facts('run-unshown'), { reveal: false });
		open(terminals[0]);
		await first.spawn('run-unshown', plan(ECHO), meta('run-unshown'));
		ports.splice(ports.indexOf(first), 1);
		first.dispose();
		const reloaded = portOf();
		await until('the run to be unclaimed', async () => (await reloaded.live()).some(run => run.run === 'run-unshown' && !run.claimedElsewhere));
		let found = 0;
		reloaded.onDidFindRuns(() => found++);
		// Its reattach failed: no pair shows it, and before the first restore is over nothing is told
		await new Promise(resolve => setTimeout(resolve, 2_500));
		assert.strictEqual(found, 0);
		await reloaded.finishRestore();
		await until('it to be told', () => found === 1, 6_000);
		await new Promise(resolve => setTimeout(resolve, 4_500));
		assert.strictEqual(found, 1, 'once a while, not at every check');
	});

	test('a run of an earlier protocol\'s ptyd that could not be reached as the window reattached it is told as lost, and claimed again at a later check once it can be: never left reconnecting (RULES-3.1, 4.1, D86)', async function () {
		this.timeout(20_000);
		const earlier = await earlierWith('run-late');
		try {
			const port = portOf();
			const reports: ActivityReport[] = [];
			port.onDidReport(report => reports.push(report));
			const [live] = await port.live();
			failEarlierClients = 1;
			const attaching = port.attach(live, facts('run-late'));
			const terminal = await until('its terminal', () => terminals[0]);
			open(terminal);
			await attaching;
			assert.ok(reports.some(report => report.run === 'run-late' && report.disconnected), 'told as lost');
			await until('its screen, claimed again', () => screenOf(terminal).includes('ready'), 10_000);
			terminal.options.pty.handleInput!('back');
			await until('its answer', () => screenOf(terminal).includes('got back'));
		} finally {
			earlier.server.close();
		}
	});

	test('a run its ptyd was not told to forget is told again at a later check: it does not stay listed for good, holding its ptyd (RULES-5.3)', async function () {
		this.timeout(15_000);
		const port = portOf();
		const exits: ExitReport[] = [];
		port.onDidExit(exit => exits.push(exit));
		port.openPair(facts('run-forget'), { reveal: false });
		open(terminals[0]);
		await port.spawn('run-forget', plan(ECHO), meta('run-forget'));
		await until('its output', () => screenOf(terminals[0]).includes('ready'));
		terminals[0].options.pty.handleInput!('q');
		await until('its exit', () => exits.length === 1);
		failForgetOnce = true;
		port.removePair('run-forget');
		const own = await PtydClient.connect(ptydSocketPath(home), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
		extraClients.push(own);
		const listed = async () => (await own.request('list', { owner: 'workspace-1' })).some(run => run.run === 'run-forget');
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.strictEqual(await listed(), true, 'not forgotten at first');
		await until('ptyd to forget it at a later check', async () => !await listed(), 8_000);
	});

	test('a ptyd of an earlier protocol that stops answering holds up no listing of the window\'s own runs: they are listed in bounded time, the others by a later restore (ARCHITECTURE-2.4, RULES-4.1)', async function () {
		this.timeout(15_000);
		const protocol = EARLIER_PROTOCOLS[0];
		// It answers as a ptyd of that protocol holding one run of this window, and then answers no listing more
		const sockets: net.Socket[] = [];
		let lists = 0;
		const hung = net.createServer(connection => {
			sockets.push(connection);
			connection.setEncoding('utf8');
			connection.on('data', lineReader(line => {
				const { id, method } = JSON.parse(line) as { readonly id: number; readonly method: string };
				const answer = (result: unknown) => connection.write(`${JSON.stringify({ id, result })}\n`);
				if (method === 'hello') {
					answer({ protocol, pid: 1 });
				} else if (method === 'claim') {
					answer(null);
				} else if (method === 'list' && lists++ === 0) {
					answer([{ run: 'run-hung', owner: 'workspace-1', pid: 1, cwd: os.tmpdir(), cols: 80, rows: 24, title: '', startedAt: 1, seq: 0, claimedElsewhere: false, meta: { ...meta('run-hung') } }]);
				}
			}, () => connection.destroy()));
		});
		await new Promise<void>(resolve => hung.listen(ptydSocketPath(home, protocol), resolve));
		try {
			const port = portOf();
			port.openPair(facts('run-own'), { reveal: false });
			open(terminals[0]);
			await port.spawn('run-own', plan(ECHO), meta('run-own'));
			const started = Date.now();
			const live = await port.live();
			assert.deepStrictEqual(live.map(run => run.run), ['run-own']);
			assert.ok(Date.now() - started < 6_000, `listed in ${Date.now() - started} ms`);
		} finally {
			sockets.forEach(socket => socket.destroy());
			await new Promise<void>(resolve => hung.close(() => resolve()));
		}
	});

	test('a pair made behind the person\'s work moves no selection as its terminal opens, and the tab it covered is shown again without focus (PANEL-2.1, LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const activations: (RunId | undefined)[] = [];
		port.onDidActivate(run => activations.push(run));
		const group = { viewColumn: 1, tabs: [] as unknown[] };
		const file = { input: new TabInputText({ path: '/work/app/a.ts' }), isPinned: false, isActive: true, isPreview: false, label: 'a.ts', group };
		group.tabs.push(file);
		activeTab = file;
		port.openPair(facts('run-20'), { reveal: false });
		const tab = { input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada', group };
		group.tabs.push(tab);
		activeTab = tab;
		tabsChanged.fire({ opened: [tab], closed: [], changed: [] });
		activeChanged.fire(terminals[0]);
		assert.deepStrictEqual(commands, [], 'the native terminal stays attached until xterm opens');
		open(terminals[0]);
		await Promise.resolve();
		assert.deepStrictEqual([activations, commands], [[], ['vscode.open']]);
		// Revealed, its terminal's activation is the person's
		await port.reveal('run-20', { preserveFocus: false });
		activeChanged.fire(terminals[0]);
		assert.deepStrictEqual(activations, ['run-20']);
		// Over another agent's terminal: that one is shown again, keeping focus where it is
		port.openPair(facts('run-21'), { reveal: false });
		open(terminals[1]);
		const next = { input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada', group };
		tabsChanged.fire({ opened: [next], closed: [], changed: [] });
		assert.deepStrictEqual(terminals[0].shown, [false, true]);
		// One made in front is told at once, and covers nothing it shows again
		port.openPair(facts('run-22'), { reveal: true });
		tabsChanged.fire({ opened: [{ input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada', group }], closed: [], changed: [] });
		activeChanged.fire(terminals[2]);
		assert.deepStrictEqual([activations, commands, terminals[1].shown], [['run-20', 'run-22'], ['vscode.open'], []]);
	});

	test('closing a background pair before xterm opens cancels its focus restoration and ignores disposal callbacks', async () => {
		const port = portOf();
		const closes: RunId[] = [];
		const renames: { readonly run: RunId; readonly name: string }[] = [];
		port.onDidClosePair(run => closes.push(run));
		port.onDidRenameTab(rename => renames.push(rename));
		const group = { viewColumn: 1, tabs: [] as unknown[] };
		const file = { input: new TabInputText({ path: '/work/a.ts' }), isActive: true, isPreview: false, group };
		group.tabs.push(file);
		activeTab = file;
		port.openPair(facts('run-background-close'), { reveal: false });
		const terminal = terminals[0];
		const tab = { input: new TabInputTerminal(), isActive: true, group };
		group.tabs.push(tab);
		activeTab = tab;
		tabsChanged.fire({ opened: [tab], closed: [], changed: [] });
		terminal.dispose = () => {
			terminal.disposed = true;
			terminal.exitStatus = { reason: EXIT_REASON.Extension, code: undefined };
			closed.fire(terminal);
		};
		port.removePair('run-background-close');
		// The deferred ready callback and a delayed native name event both arrive after the resource was removed.
		open(terminal);
		terminal.name = 'Late rename';
		tabsChanged.fire({ opened: [], closed: [], changed: [tab] });
		await Promise.resolve();
		assert.deepStrictEqual([terminal.disposed, commands, closes, renames], [true, [], [], []]);
		assert.strictEqual(await port.reveal('run-background-close', { preserveFocus: false }), false);
	});

	test('two pairs made behind the person\'s work at once, their tabs not told apart, still show again the file they covered (LIFECYCLE-2.2)', () => {
		const port = portOf();
		const group = { viewColumn: 1, tabs: [] as unknown[] };
		const file = { input: new TabInputText({ path: '/work/app/a.ts' }), isPinned: false, isActive: true, isPreview: false, label: 'a.ts', group };
		group.tabs.push(file);
		activeTab = file;
		port.openPair(facts('run-30'), { reveal: false });
		port.openPair(facts('run-31'), { reveal: false });
		terminals.forEach(open);
		const tabs = [{ input: new TabInputTerminal(), isPinned: false, isActive: false, label: 'Ada', group }, { input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada', group }];
		group.tabs.push(...tabs);
		tabsChanged.fire({ opened: tabs, closed: [], changed: [] });
		assert.deepStrictEqual(commands, ['vscode.open']);
	});

	test('a run\'s native tab is the one that opens as its terminal is created, or that becomes active with its terminal; a pair made behind it over that tab shows it again (LIFECYCLE-2.2)', () => {
		const port = portOf();
		// Two terminals created together whose tabs open together are ambiguous: neither is matched until it is active with its terminal
		port.openPair(facts('run-11'), { reveal: false });
		port.openPair(facts('run-12'), { reveal: false });
		const [tab11, tab12] = [{ input: new TabInputTerminal(), isPinned: false, isActive: false, label: 'Ada' }, { input: new TabInputTerminal(), isPinned: false, isActive: false, label: 'Ada' }];
		tabsChanged.fire({ opened: [tab11, tab12], closed: [], changed: [] });
		activeTab = tab12;
		tab12.isActive = true;
		activeTerminal = terminals[1];
		tabsChanged.fire({ opened: [], closed: [], changed: [tab12] });
		activeChanged.fire(terminals[1]);
		// Matched: a pair made behind the person's work over that tab shows its terminal again, without focus
		port.openPair(facts('run-13'), { reveal: false });
		open(terminals[2]);
		tabsChanged.fire({ opened: [{ input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada' }], closed: [], changed: [] });
		assert.deepStrictEqual([terminals[1].shown, terminals[0].shown, commands], [[true], [], []]);
	});
});
