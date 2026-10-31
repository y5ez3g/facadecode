/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ActivityReport, ExitReport, LaunchPlan, PairFacts, RunId, RunMeta } from '../core/ports';
import type { AgentExecution } from '../host/execution/agentExecution';
import { PtydClient, PtydLost, PtydNotSent, earlierRuns, ptydSocketPath } from '../host/execution/ptydClient';
import type { Method, Requests } from '../ptyd/protocol';
import { PtydServer } from '../ptyd/server';
import { programEnv } from './ptydPlace';
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
	let spawns: number;
	/** Each connection to ptyd the ports made, in order. */
	let connections: PtydClient[];
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
		activeTab = undefined;
		activeTerminal = undefined;
		commands = [];
		connectGate = undefined;
		loseSpawnReply = false;
		failConnectAfterLostSpawn = 0;
		failedConnects = 0;
		failTerminateOnce = false;
		spawns = 0;
		connections = [];
		const vscodeApi = {
			TabInputTerminal,
			TabInputText,
			commands: { executeCommand: async (command: string) => { commands.push(command); } },
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
				tabGroups: { onDidChangeTabs: tabsChanged.event, get activeTabGroup() { return { activeTab }; } },
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
					const result = await real.request(method, params);
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
		Execution = withModules({ vscode: vscodeApi, './ptydClient': { PtydClient: { connect }, PtydLost, PtydNotSent, earlierRuns, ptydSocketPath } })<typeof import('../host/execution/agentExecution')>(require.resolve('../host/execution/agentExecution')).AgentExecution;
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
