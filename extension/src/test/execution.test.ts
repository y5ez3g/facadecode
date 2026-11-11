/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ptydBuild, ptydRecords, recordedPtyds, recordPtyd } from '../base/ptydRegistry';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ActivityReport, ExitReport, LaunchPlan, PairFacts, RunId, RunMeta } from '../core/ports';
import type { AgentExecution } from '../host/execution/agentExecution';
import { EarlierPtyds, otherPtyds, ownPtydSocket, PtydClient, PtydGone, PtydLost, PtydNotSent, ptydSocketPath, within } from '../host/execution/ptydClient';
import { lineReader } from '../base/lines';
import { EARLIER_PROTOCOLS, PTYD_PROTOCOL, type Method, type Requests } from '../ptyd/protocol';
import { PtydServer } from '../ptyd/server';
import { programEnv } from './ptydPlace';
import { nextOwnerClaim } from '../record/ownership';
import { TestEmitter, withModules } from './withModules';
import { unspun } from '../base/tabSpinner';

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

/** A tab and a group of the editor as a test models them (LIFECYCLE-3.4, 3.5). */
interface ModelTab { readonly input: unknown; label: string; isActive: boolean; isPinned: boolean; isPreview: boolean; readonly group: ModelGroup }
interface ModelGroup { readonly viewColumn: number; readonly tabs: ModelTab[]; activeTab: ModelTab | undefined; isActive: boolean; floating?: boolean }

suite('The execution port: an agent\'s terminal and its process held by ptyd (ARCHITECTURE-2.3, LIFECYCLE-1.5, 2.2, 3.1)', function () {
	this.timeout(20_000);
	let home: string;
	let server: PtydServer;
	let terminals: FakeTerminal[];
	let activeChanged: TestEmitter<unknown>;
	let closed: TestEmitter<unknown>;
	/** Terminals the editor opened that Facade did not: a copy of a tab's among them. */
	let openedTerminal: TestEmitter<unknown>;
	let configChanged: TestEmitter<{ affectsConfiguration(section: string): boolean }>;
	let config: { [key: string]: unknown };
	/** The editor's tabs as the test has them: the active tab, its changes, and the commands run on the active editor. */
	let tabsChanged: TestEmitter<{ opened: unknown[]; closed: unknown[]; changed: unknown[] }>;
	let groupsChanged: TestEmitter<undefined>;
	let visibleTabs: unknown[] | undefined;
	/** The ordinary terminals Facade made - a copy's in its place - with their options and a process ID the test settles. */
	let shells: { readonly options: vscode.TerminalOptions; readonly processId: Promise<number>; started(pid: number): void; disposed: boolean; dispose(): void }[] = [];
	let activeTab: unknown;
	let activeTerminal: unknown;
	/** The editor's groups where a test says them. */
	let visibleGroups: { viewColumn: number }[] | undefined;
	let commands: string[];
	/**
	 * The editor's groups as a test models them, for marks and fronts (LIFECYCLE-3.4, 3.5): each with its tabs and its front, one of
	 * them active; its focus commands, `vscode.open`, its own index commands and a terminal's show act on it. None unless a test
	 * makes one; `during` is what the person does as a command runs, and `made` a focus command for a group that is not there.
	 */
	let model: { groups: ModelGroup[]; before?: (command: string) => void; during?: (command: string) => void; made: string[]; showLag?: number } | undefined;
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
		override async client(socket: string): Promise<PtydClient> {
			if (failEarlierClients > 0) {
				failEarlierClients--;
				throw new PtydNotSent('injected: the ptyd of an earlier protocol took no connection now');
			}
			return super.client(socket);
		}
	}
	let spawns: number;
	/** Each connection to ptyd the ports made, in order. */
	let connections: PtydClient[];
	/** How long an attach's answer is held back while the run's events go on; and whether the next attach loses its connection. */
	let delayAttach: number;
	let loseAttach: boolean;
	/** Where the next listing's answer waits, once had, until opened: what the run says meanwhile reaches the window first. */
	let listGate: { entered(): void; readonly open: Promise<void>; readonly answer?: (runs: Requests['list']['result']) => Requests['list']['result'] } | undefined;
	/** The person's words for an English text, where a test gives them; its English else. */
	let translations: Record<string, string>;
	/** Each run's listener of its ptyd's events, as the window gave it: what a test tells it, it heard. */
	let runListeners: Map<string, (event: never) => void>;
	/** Where the next spawn's answer waits, once had, until opened; and each request's method in order. */
	let spawnGate: { entered(): void; readonly open: Promise<void> } | undefined;
	let requested: string[];
	const ports: AgentExecution[] = [];
	const extraClients: PtydClient[] = [];

	setup(async () => {
		shells = [];
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-exec-'));
		server = new PtydServer(ownPtydSocket(home, '/nonexistent/ptyd.js'));
		server.build = ptydBuild('/nonexistent/ptyd.js', '');
		assert.strictEqual(await server.listen(), true);
		terminals = [];
		activeChanged = new TestEmitter();
		closed = new TestEmitter();
		openedTerminal = new TestEmitter();
		configChanged = new TestEmitter();
		config = { 'terminal.integrated.tabs.separator': ' | ' };
		tabsChanged = new TestEmitter();
		groupsChanged = new TestEmitter();
		visibleTabs = undefined;
		activeTab = undefined;
		activeTerminal = undefined;
		visibleGroups = undefined;
		commands = [];
		model = undefined;
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
		spawnGate = undefined;
		requested = [];
		listGate = undefined;
		translations = {};
		runListeners = new Map();
		const vscodeApi = {
			TabInputTerminal,
			TabInputText,
			commands: { executeCommand: async (command: string, ...args: unknown[]) => {
				commands.push(command);
				if (model) {
					modelCommand(command, args);
					return;
				}
				if (activeTab && (command === 'workbench.action.pinEditor' || command === 'workbench.action.unpinEditor')) {
					Object.assign(activeTab, { isPinned: command === 'workbench.action.pinEditor' });
					tabsChanged.fire({ opened: [], closed: [], changed: [activeTab] });
				}
			} },
			EventEmitter: TestEmitter,
			ThemeIcon: class { constructor(readonly id: string) { } },
			ThemeColor: class { constructor(readonly id: string) { } },
			Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: path.posix.join(base.path, ...parts) }) },
			env: { language: 'en' },
			ViewColumn: { Active: -1 },
			TerminalExitReason: EXIT_REASON,
			l10n: { t: (text: string, ...args: unknown[]) => (translations[text] ?? text).replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])) },
			workspace: {
				getConfiguration: () => ({ get: (key: string) => config[key] }),
				onDidChangeConfiguration: configChanged.event
			},
			window: {
				get activeTerminal() { return activeTerminal; },
				tabGroups: { onDidChangeTabs: tabsChanged.event, onDidChangeTabGroups: groupsChanged.event,
					get all() { return model?.groups ?? visibleGroups ?? [{ tabs: visibleTabs ?? terminals.filter(terminal => !terminal.disposed).map(terminal => terminal.tab) }]; },
					get activeTabGroup() { return model ? model.groups.find(group => group.isActive) ?? { activeTab: undefined } : { activeTab }; } },
				onDidChangeActiveTerminal: activeChanged.event,
				activeColorTheme: { kind: 2 }, onDidChangeActiveColorTheme: () => ({ dispose() { } }),
				onDidCloseTerminal: closed.event,
				onDidOpenTerminal: openedTerminal.event,
				createTerminal: (options: vscode.ExtensionTerminalOptions) => {
					if (!('pty' in options)) {
						let started!: (pid: number) => void;
						const shell = { options: options as vscode.TerminalOptions, processId: new Promise<number>(resolve => { started = resolve; }), started, disposed: false, dispose() { this.disposed = true; } };
						shells.push(shell);
						return shell;
					}
					const terminal: FakeTerminal = {
						name: options.name, options, written: [], names: [], pending: [], opened: false, shown: [], disposed: false,
						tab: { input: new TabInputTerminal(), isPinned: false, isActive: false, label: options.name },
						show(preserveFocus) { this.shown.push(preserveFocus); if (model) { modelShow(this, preserveFocus === true); } },
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
					requested.push(method);
					if (method === 'spawn' && spawnGate) {
						// Its answer held, as ptyd's start line can hold it: the request itself went, in its turn on the connection
						const gate = spawnGate;
						spawnGate = undefined;
						const answered = real.request(method, params);
						gate.entered();
						await gate.open;
						return await answered;
					}
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
					let result = await real.request(method, params);
					if (method === 'list' && listGate) {
						const gate = listGate;
						listGate = undefined;
						gate.entered();
						await gate.open;
						result = gate.answer ? gate.answer(result as never) as never : result;
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
				onRunEvent: (...args: Parameters<PtydClient['onRunEvent']>) => { runListeners.set(args[0], args[1] as never); return real.onRunEvent(...args); },
				onDidClose: (...args: Parameters<PtydClient['onDidClose']>) => real.onDidClose(...args),
				onDidLoseOwner: (...args: Parameters<PtydClient['onDidLoseOwner']>) => real.onDidLoseOwner(...args),
				onCall: (...args: Parameters<PtydClient['onCall']>) => real.onCall(...args),
				dispose: () => real.dispose(), get isClosed() { return real.isClosed; }
			};
		};
		Execution = withModules({ vscode: vscodeApi, './ptydClient': { PtydClient: { connect, join: PtydClient.join.bind(PtydClient) }, PtydGone, PtydLost, PtydNotSent, EarlierPtyds: FlakyEarlierPtyds, otherPtyds, ownPtydSocket, ptydSocketPath, within } })<typeof import('../host/execution/agentExecution')>(require.resolve('../host/execution/agentExecution')).AgentExecution;
	});

	teardown(() => {
		ports.splice(0).forEach(port => port.dispose());
		extraClients.splice(0).forEach(client => client.dispose());
		server.close();
		fs.rmSync(home, { recursive: true, force: true });
	});

	/** A window's execution port; `startupMs`, how long its runs are still starting while their CLIs show no activity. */
	const portOf = (startupMs?: number, readBeforeEnterMs?: number) => {
		const port = new Execution({ owner: 'workspace-1', ptydScript: '/nonexistent/ptyd.js', home, media: { path: '/ext/media' } as unknown as vscode.Uri, log: () => undefined,
			...startupMs !== undefined ? { startupMs } : {}, ...readBeforeEnterMs !== undefined ? { readBeforeEnterMs } : {} });
		ports.push(port);
		return port;
	};
	const facts = (run: RunId, more: Partial<PairFacts> = {}): PairFacts => ({ run, name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude', cwd: os.tmpdir(), tab: { column: 1 }, ...more });
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
	 * A reattached run's tab, hidden as an unpinned agent's is after a reload, opened by the person from its card - the `at`th terminal -
	 * and VS Code's terminal opening: it draws the run's screen (LIFECYCLE-2.2, 3.5).
	 */
	const openedAgain = async (port: AgentExecution, run: RunId, at: number) => {
		await port.reveal(run, { preserveFocus: true });
		const terminal = await until(`${run}'s tab`, () => terminals[at]);
		open(terminal);
		return terminal;
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

	const FOCUS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map(nth => `workbench.action.focus${nth}EditorGroup`);
	/** `count` groups, the first active: the editor as a test models it. */
	const groupsOf = (count: number) => {
		model = { groups: Array.from({ length: count }, (_, index) => ({ viewColumn: index + 1, tabs: [], activeTab: undefined, isActive: index === 0 })), made: [] };
		return model.groups;
	};
	const groupAt = (column: number) => model!.groups.find(group => group.viewColumn === column)!;
	const activeGroup = () => model!.groups.find(group => group.isActive)!;
	/** `tab` in front of its group, as the editor tells it. */
	const toFront = (tab: ModelTab) => {
		const group = tab.group;
		if (group.activeTab === tab) {
			return;
		}
		if (group.activeTab) {
			group.activeTab.isActive = false;
		}
		group.activeTab = tab;
		tab.isActive = true;
		tabsChanged.fire({ opened: [], closed: [], changed: [tab] });
	};
	/** `column`'s group the active one with the focus: the active terminal its front's, where that is a terminal. */
	const activate = (column: number) => {
		for (const group of model!.groups) {
			group.isActive = group.viewColumn === column;
		}
		const terminal = terminals.find(each => each.tab === (groupAt(column).activeTab as unknown));
		if (terminal && activeTerminal !== terminal) {
			activeTerminal = terminal;
			activeChanged.fire(terminal);
		}
		groupsChanged.fire(undefined);
	};
	/** A file's tab in `column`'s group, in front there unless `front` says not. */
	const fileIn = (column: number, file: string, front = true) => {
		const group = groupAt(column);
		const tab: ModelTab = { input: new TabInputText(file), label: path.posix.basename(file), isActive: false, isPinned: false, isPreview: false, group };
		group.tabs.push(tab);
		tabsChanged.fire({ opened: [tab], closed: [], changed: [] });
		if (front) {
			toFront(tab);
		}
		return tab;
	};
	/** `terminal`'s tab opening in `column`'s group, in front there as the editor opens a tab. */
	const opensIn = (terminal: FakeTerminal, column: number) => {
		const group = groupAt(column);
		const tab = Object.assign(terminal.tab, { group, isPreview: false }) as unknown as ModelTab;
		group.tabs.push(tab);
		if (group.activeTab) {
			group.activeTab.isActive = false;
		}
		group.activeTab = tab;
		tab.isActive = true;
		tabsChanged.fire({ opened: [tab], closed: [], changed: [] });
		return tab;
	};
	const modelCommand = (command: string, args: unknown[]) => {
		model!.before?.(command);
		// The focus commands reach the main window's groups alone, in their order, as the probe saw; a floating window's none
		const columns = model!.groups.filter(group => !group.floating).map(group => group.viewColumn);
		const focus = FOCUS.indexOf(command);
		if (focus >= 0) {
			// The editor makes a group where none is: never asked of it
			if (focus >= columns.length) {
				model!.made.push(command);
			} else {
				activate(columns[focus]);
			}
		} else if (command === 'workbench.action.focusNextGroup' || command === 'workbench.action.focusPreviousGroup') {
			const index = columns.indexOf(activeGroup().viewColumn) + (command === 'workbench.action.focusNextGroup' ? 1 : -1);
			activate(columns[(index + columns.length) % columns.length]);
		} else if (command === 'vscode.open') {
			const [uri, options] = args as [unknown, vscode.TextDocumentShowOptions];
			const group = groupAt(options.viewColumn as number);
			const tab = group.tabs.find(each => (each.input as { readonly uri?: unknown }).uri === uri);
			if (tab) {
				toFront(tab);
			}
			// Its group the active one, with the focus or without, as the probe saw: the focus itself stays where it was without
			activate(group.viewColumn);
		} else if (/^workbench\.action\.openEditorAtIndex\d$/.test(command)) {
			const tab = activeGroup().tabs[Number(command.slice(-1)) - 1];
			if (tab) {
				toFront(tab);
			}
		} else if (command === 'workbench.action.pinEditor' || command === 'workbench.action.unpinEditor') {
			const tab = activeGroup().activeTab;
			if (tab) {
				tab.isPinned = command === 'workbench.action.pinEditor';
				tabsChanged.fire({ opened: [], closed: [], changed: [tab] });
			}
		}
		model!.during?.(command);
	};
	/** A terminal's show as the editor does it: its tab in front of its group and its terminal the active one; its group active with the focus. */
	const modelShow = (terminal: FakeTerminal, preserveFocus: boolean) => {
		const tab = terminal.tab as unknown as ModelTab;
		if (!tab.group) {
			return;
		}
		const reveal = () => {
			toFront(tab);
			if (!preserveFocus) {
				activate(tab.group.viewColumn);
			}
		};
		if (activeTerminal !== terminal) {
			activeTerminal = terminal;
			activeChanged.fire(terminal);
		}
		if (model?.showLag) {
			setTimeout(reveal, model.showLag);
		} else {
			reveal();
		}
	};

	test('ARCHITECTURE-2.2: finishRestore retires nothing; the activation\'s pinned sequence being over sends the retire, once it is told', async () => {
		const port = new Execution({ owner: 'workspace-1', ptydScript: '/nonexistent/ptyd.js', home, media: { path: '/ext/media' } as unknown as vscode.Uri, log: () => undefined,
			terminalOwner: { session: 'session-1', claim: { owner: 'workspace-1', generation: 1, token: 'token-1' }, remote: false } });
		ports.push(port);
		await port.finishRestore();
		const told = () => commands.filter(command => command === 'facade.window.terminals').length;
		const before = told();
		await port.pinnedSequenceOver();
		assert.deepStrictEqual([before, told()], [0, 1]);
	});

	test('a Pin marks its tab at once: in front of the active group where it is, the keys typed meanwhile its CLI\'s; behind, brought to the front for its mark, the keys meanwhile reaching no CLI, and the person\'s front given back (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(1);
		const file = fileIn(1, '/work/app/a.ts');
		port.openPair(facts('run-1'), { reveal: false });
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 1);
		// Made behind the person's work: the file it covered is in front again
		await until('the file in front again', () => file.isActive);
		await port.spawn('run-1', plan(ECHO), meta('run-1'));
		await until('its output', () => screenOf(agent).includes('ready'));
		commands.length = 0;
		model!.during = command => { if (command === 'workbench.action.pinEditor') { agent.options.pty.handleInput!('k'); } };
		port.pinTab('run-1', true);
		await until('its tab marked', () => agent.tab.isPinned);
		await until('the file in front again, its group active', () => file.isActive && activeGroup().viewColumn === 1 && commands.length === 2);
		// The file back by its place among the group's tabs, the editor's own command, which takes the focus back there
		assert.deepStrictEqual([commands, agent.shown], [['workbench.action.pinEditor', 'workbench.action.openEditorAtIndex1'], [true]]);
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.ok(!screenOf(agent).includes('got k'), 'a key typed while Facade held its tab in front reached no CLI');
		// In front with its terminal active: marked where it is, the keys typed meanwhile its CLI's
		modelShow(agent, false);
		commands.length = 0;
		model!.during = command => { if (command === 'workbench.action.unpinEditor') { agent.options.pty.handleInput!('j'); } };
		port.pinTab('run-1', false);
		await until('its tab unmarked', () => !agent.tab.isPinned);
		await until('the key typed meanwhile at its CLI', () => screenOf(agent).includes('got j'));
		assert.deepStrictEqual([commands, agent.shown], [['workbench.action.unpinEditor'], [true]]);
	});

	test('a card\'s Pin of a tab behind in another group shows it as a click on the card does - in front of its group, that group the active one with the focus - and marks it there, nothing borrowed or given back (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(2);
		const mine = fileIn(1, '/work/app/a.ts');
		port.openPair(facts('run-1', { tab: { column: 2 } }), { reveal: false });
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 2);
		const theirs = fileIn(2, '/work/app/b.ts');
		commands.length = 0;
		// The card's Pin: its tab shown as the card's click shows it, then its Pin
		await port.reveal('run-1', { preserveFocus: false });
		port.pinTab('run-1', true);
		await until('its tab marked', () => agent.tab.isPinned);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepStrictEqual([commands, agent.shown, agent.tab.isActive, theirs.isActive, mine.isActive, activeGroup().viewColumn],
			[['workbench.action.pinEditor'], [false], true, false, true, 2]);
	});

	test('a tab in a group past the eighth is marked at once: its group reached from the eighth one group at a time, each step checked, with no focus command for a group that is not there (LIFECYCLE-2.2, 3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(10);
		fileIn(1, '/work/app/a.ts');
		port.openPair(facts('run-1', { tab: { column: 10 } }), { reveal: false });
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 10);
		const tenth = fileIn(10, '/work/app/j.ts');
		// Another agent in front of the ninth group, which the steps pass through
		port.openPair(facts('run-9', { tab: { column: 9 } }), { reveal: false });
		const passed = terminals[1];
		open(passed);
		opensIn(passed, 9);
		await port.spawn('run-9', plan(ECHO), meta('run-9'));
		await until('its output', () => screenOf(passed).includes('ready'));
		model!.during = command => { if (command === 'workbench.action.focusNextGroup' && activeGroup().viewColumn === 9) { passed.options.pty.handleInput!('z'); } };
		commands.length = 0;
		port.pinTab('run-1', true);
		await until('its tab marked', () => agent.tab.isPinned);
		await until('the person\'s group active again', () => commands.includes('workbench.action.focusFirstEditorGroup'));
		assert.deepStrictEqual(commands.slice(0, 4), ['workbench.action.focusEighthEditorGroup', 'workbench.action.focusNextGroup', 'workbench.action.focusNextGroup', 'workbench.action.pinEditor']);
		assert.deepStrictEqual([tenth.isActive, activeGroup().viewColumn, model!.made], [true, 1, []]);
		// The key typed in the ninth group on the way reached no CLI; one typed after the mark does
		passed.options.pty.handleInput!('y');
		await until('the key typed after the mark at its CLI', () => screenOf(passed).includes('got y'));
		assert.ok(!screenOf(passed).includes('got z'), 'a key typed while Facade held the focus on the way reached no CLI');
	});

	test('the person bringing another tab to the front while a mark goes on keeps it: nothing is given back over it (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(3);
		fileIn(1, '/work/app/a.ts');
		const third = fileIn(3, '/work/app/c.ts');
		port.openPair(facts('run-1', { tab: { column: 2 } }), { reveal: false });
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 2);
		fileIn(2, '/work/app/b.ts');
		commands.length = 0;
		// As its mark goes on, the person goes to the third group
		model!.during = command => { if (command === 'workbench.action.pinEditor') { activate(3); } };
		port.pinTab('run-1', true);
		await until('its tab marked', () => agent.tab.isPinned);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepStrictEqual([commands, activeGroup().viewColumn, third.isActive], [['workbench.action.focusSecondEditorGroup', 'workbench.action.pinEditor'], 3, true]);
	});

	test('a reload\'s pinned tabs open one at a time in their turns, each in its recorded group, else the active one, in front there and marked before the next opens; nothing is given back - neither the person\'s file nor a group\'s front - and the last stays in front, its group the active one (LIFECYCLE-3.4, 3.5)', async () => {
		const port = portOf();
		groupsOf(2);
		const mine = fileIn(1, '/work/app/a.ts');
		const second = fileIn(2, '/work/app/b.ts');
		// Three pinned agents back, their tabs hidden until their turns: one recorded in group 1, one as group 2's front, one hidden
		port.openPair(facts('run-a', { tab: { column: 1 }, pinned: true }), { reveal: false, hidden: true });
		port.openPair(facts('run-b', { tab: { column: 2 }, pinned: true }), { reveal: false, hidden: true });
		port.openPair(facts('run-c', { tab: 'hidden', pinned: true }), { reveal: false, hidden: true });
		assert.strictEqual(terminals.length, 0);
		/** `run`'s turn: its tab opens where the editor puts it, the turn over once its terminal opened and its mark went on. */
		const turn = async (run: RunId, column: (asked: number) => number) => {
			let over = false;
			const count = terminals.length;
			const opening = port.openPinned(run).then(() => { over = true; });
			const terminal = await until(`${run}'s terminal`, () => terminals[count]);
			const asked = (terminal.options.location as { viewColumn: number }).viewColumn;
			await new Promise(resolve => setTimeout(resolve, 50));
			// The next waits for this terminal to open
			assert.strictEqual(over, false, `${run}'s turn ended before its terminal opened`);
			open(terminal);
			opensIn(terminal, column(asked));
			await opening;
			return { terminal, asked };
		};
		commands.length = 0;
		// In front of the active group as it opens: marked there, the person's file not brought back over it
		const a = await turn('run-a', asked => asked);
		assert.deepStrictEqual([a.asked, a.terminal.tab.isPinned, a.terminal.tab.isActive, mine.isActive, activeGroup().viewColumn], [1, true, true, false, 1]);
		// In front of its group, which the editor does not make the active one: that group made the active one for its mark, nothing given back
		const b = await turn('run-b', asked => asked);
		assert.deepStrictEqual([b.asked, b.terminal.tab.isPinned, b.terminal.tab.isActive, second.isActive, activeGroup().viewColumn], [2, true, true, false, 2]);
		// Its record hidden: in the active group, the one the last tab's mark made so
		const c = await turn('run-c', () => activeGroup().viewColumn);
		assert.deepStrictEqual([c.asked, c.terminal.tab.isPinned, c.terminal.tab.isActive, (c.terminal.tab as unknown as ModelTab).group.viewColumn, activeGroup().viewColumn], [-1, true, true, 2, 2]);
		await port.finishRestore();
		await new Promise(resolve => setTimeout(resolve, 300));
		// The marks' own commands alone: no front brought back, no group made the active one again, the last tab in front of the active group
		assert.deepStrictEqual(commands, ['workbench.action.pinEditor', 'workbench.action.focusSecondEditorGroup', 'workbench.action.pinEditor', 'workbench.action.pinEditor']);
		assert.deepStrictEqual([activeGroup().activeTab === (c.terminal.tab as unknown), groupAt(1).activeTab === (a.terminal.tab as unknown), mine.isActive, second.isActive, model!.made], [true, true, false, false, []]);
	});

	test('while a reload\'s or a restart\'s pinned tabs open in their turns no activation moves the panel\'s selection; once they are open it is on the last one opened, and where none opened it stays as it was (PANEL-2.1, LIFECYCLE-3.5)', async () => {
		const port = portOf();
		await port.finishRestore();
		const activations: (RunId | undefined)[] = [];
		port.onDidActivate(run => activations.push(run));
		groupsOf(2);
		fileIn(1, '/work/app/a.ts');
		fileIn(2, '/work/app/b.ts');
		port.openPair(facts('run-a', { tab: { column: 1 }, pinned: true }), { reveal: false, hidden: true });
		port.openPair(facts('run-b', { tab: { column: 2 }, pinned: true }), { reveal: false, hidden: true });
		const opensA = port.openPinned('run-a');
		const a = await until('the first terminal', () => terminals[0]);
		open(a);
		opensIn(a, 1);
		activeTerminal = a;
		activeChanged.fire(a);
		await opensA;
		const opensB = port.openPinned('run-b');
		const b = await until('the second terminal', () => terminals[1]);
		// Its tab opens at once, in front of group 2; its terminal opens - its xterm ready - well past the moment an opening's own
		// activation is told apart, the editor making it the active terminal meanwhile, its turn still on
		opensIn(b, 2);
		await new Promise(resolve => setTimeout(resolve, 2_100));
		activeTerminal = b;
		activeChanged.fire(b);
		open(b);
		await opensB;
		// The second's group made the active one for its mark: still no selection moved
		assert.deepStrictEqual([[a.tab.isPinned, b.tab.isPinned], activeGroup().viewColumn, activations], [[true, true], 2, []]);
		// Their tabs open: the selection on the last one opened
		port.pinnedOpened();
		assert.deepStrictEqual(activations, ['run-b']);
		// None opened since: the selection stays as it was
		port.pinnedOpened();
		assert.deepStrictEqual(activations, ['run-b']);
		// Past the turns, an agent's terminal the editor makes active moves it again
		activeTerminal = a;
		activeChanged.fire(a);
		assert.deepStrictEqual(activations, ['run-b', 'run-a']);
	});

	test('LIFECYCLE-3.4: whether a tab is open is what the editor has now, not its record: a pinned agent\'s before its turn and a hidden card\'s are not, though their records name a group; one opened in its turn or shown is, until Facade hides it', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(1);
		port.openPair(facts('run-turn', { tab: { column: 1 }, pinned: true }), { reveal: false, hidden: true });
		port.openPair(facts('run-uncertain', { tab: { column: 1 } }), { reveal: false, hidden: true });
		const before = [port.tabOpen('run-turn'), port.tabOpen('run-uncertain'), port.tabOpen('run-none')];
		const opening = port.openPinned('run-turn');
		const turn = await until('its terminal', () => terminals[0]);
		open(turn);
		opensIn(turn, 1);
		await opening;
		const opened = port.tabOpen('run-turn');
		port.hideTab('run-turn');
		assert.deepStrictEqual([before, opened, port.tabOpen('run-turn'), port.tabOpen('run-uncertain')], [[false, false, false], true, false, false]);
	});

	test('ARCHITECTURE-2.2, LIFECYCLE-3.5: a pinned tab whose terminal does not open within its wait is passed over - no mark, and no final selection on it; one the person already opened is not opened in a turn, nor taken for the last one opened', async () => {
		const port = new Execution({ owner: 'workspace-1', ptydScript: '/nonexistent/ptyd.js', home, media: { path: '/ext/media' } as unknown as vscode.Uri, log: () => undefined, openWaitMs: 100 });
		ports.push(port);
		await port.finishRestore();
		const activations: (RunId | undefined)[] = [];
		port.onDidActivate(run => activations.push(run));
		groupsOf(1);
		fileIn(1, '/work/app/a.ts');
		// Its tab opens in front, its terminal never: passed over once its wait is over
		port.openPair(facts('run-late', { tab: { column: 1 }, pinned: true }), { reveal: false, hidden: true });
		const opening = port.openPinned('run-late');
		const late = await until('its terminal', () => terminals[0]);
		opensIn(late, 1);
		await opening;
		const marked = late.tab.isPinned;
		port.pinnedOpened();
		const afterLate = [...activations];
		// One the person opened from its card before its turn: its turn opens nothing, and it is not the last one opened
		port.openPair(facts('run-open', { tab: { column: 1 }, pinned: true }), { reveal: true });
		const shown = await until('its terminal', () => terminals[1]);
		open(shown);
		opensIn(shown, 1);
		await new Promise(resolve => setTimeout(resolve, 50));
		const count = terminals.length;
		activations.length = 0;
		await port.openPinned('run-open');
		port.pinnedOpened();
		assert.deepStrictEqual([marked, afterLate, terminals.length - count, activations], [false, [], 0, []]);
	});

	test('a mark that does not take is not tried again on its tab\'s changes, only on another Pin or as the person brings its tab to the front anew (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(1);
		port.openPair(facts('run-1'), { reveal: true });
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 1);
		modelShow(agent, false);
		// The editor takes no mark on it, its spinner changing its tab meanwhile
		model!.during = command => { if (command === 'workbench.action.pinEditor') { Object.assign(agent.tab, { isPinned: false }); } };
		port.pinTab('run-1', true);
		for (let change = 0; change < 25; change++) {
			await new Promise(resolve => setTimeout(resolve, 100));
			tabsChanged.fire({ opened: [], closed: [], changed: [agent.tab] });
		}
		await new Promise(resolve => setTimeout(resolve, 700));
		assert.strictEqual(commands.filter(each => each === 'workbench.action.pinEditor').length, 1);
		// Another Pin asks anew
		port.pinTab('run-1', true);
		await new Promise(resolve => setTimeout(resolve, 700));
		assert.strictEqual(commands.filter(each => each === 'workbench.action.pinEditor').length, 2);
		// The person brings another tab to the front, then the agent's again: its mark goes on there
		model!.during = undefined;
		const file = fileIn(1, '/work/app/a.ts');
		await new Promise(resolve => setTimeout(resolve, 50));
		modelShow(agent, false);
		await until('its tab marked', () => agent.tab.isPinned && file.isActive === false);
	});

	test('a terminal the editor makes active before it shows its tab is not taken for the tab in front: the person\'s own shell there is never marked (LIFECYCLE-2.2, 3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(1);
		port.openPair(facts('run-1'), { reveal: false });
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 1);
		// The person's own shell in an editor tab, in front of the agent's
		const shell = { input: new TabInputTerminal(), label: 'zsh', isActive: false, isPinned: false, isPreview: false, group: groupAt(1) } as ModelTab;
		groupAt(1).tabs.push(shell);
		tabsChanged.fire({ opened: [shell], closed: [], changed: [] });
		toFront(shell);
		await new Promise(resolve => setTimeout(resolve, 50));
		// The editor's show sets the active terminal first and shows the tab 30 ms later
		model!.showLag = 30;
		commands.length = 0;
		port.pinTab('run-1', true);
		await until('its tab marked', () => agent.tab.isPinned);
		await until('the shell in front again', () => shell.isActive);
		assert.deepStrictEqual([shell.isPinned, commands.filter(each => each === 'workbench.action.pinEditor').length], [false, 1]);
	});

	test('a tab in a group no focus command reaches - a floating window\'s - is not stepped to in a loop: the focus comes back, and its mark goes on as the person brings it to the front (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		const groups = groupsOf(3);
		groups[2].floating = true;
		const mine = fileIn(1, '/work/app/a.ts');
		port.openPair(facts('run-1', { tab: { column: 3 } }), { reveal: false });
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 3);
		fileIn(3, '/work/app/c.ts');
		commands.length = 0;
		port.pinTab('run-1', true);
		await until('its step tried', () => commands.includes('workbench.action.focusThirdEditorGroup'));
		await new Promise(resolve => setTimeout(resolve, 1_500));
		for (let change = 0; change < 10; change++) {
			await new Promise(resolve => setTimeout(resolve, 100));
			tabsChanged.fire({ opened: [], closed: [], changed: [agent.tab] });
		}
		assert.deepStrictEqual([agent.tab.isPinned, mine.isActive, activeGroup().viewColumn, commands.filter(each => each === 'workbench.action.focusThirdEditorGroup').length, model!.made],
			[false, true, 1, 1, ['workbench.action.focusThirdEditorGroup']]);
		// The person goes to the floating window and brings the agent's tab to the front there
		activate(3);
		modelShow(agent, false);
		await until('its tab marked as it is', () => agent.tab.isPinned);
	});

	test('a reload\'s pinned tab opening in a group that is not the active one - the person gone to another meanwhile - is marked there, its group made the active one, and nothing is given back: the person\'s group and file stay behind (LIFECYCLE-3.4, 3.5)', async function () {
		this.timeout(20_000);
		const first = portOf();
		first.openPair(facts('run-p'), { reveal: false, hidden: true });
		await first.spawn('run-p', plan(ECHO), meta('run-p'));
		const second = portOf();
		const live = await second.live();
		groupsOf(2);
		fileIn(1, '/work/app/a.ts');
		const mine = fileIn(2, '/work/app/b.ts');
		// Reattached, its tab hidden: no terminal opens until its turn
		const at = terminals.length;
		await second.attach(live.find(each => each.run === 'run-p')!, facts('run-p', { tab: { column: 1 }, pinned: true }));
		assert.strictEqual(terminals.length, at, 'reattached with its tab hidden');
		const opening = second.openPinned('run-p');
		await until('its tab opening', () => terminals.length > at);
		const p = terminals[at];
		// The person goes to their file in group 2; its tab then opens in group 1, which does not become the active one
		activate(2);
		commands.length = 0;
		open(p);
		opensIn(p, 1);
		await opening;
		await second.finishRestore();
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepStrictEqual([p.tab.isPinned, p.tab.isActive, activeGroup().viewColumn, mine.isActive, commands], [true, true, 1, true, ['workbench.action.focusFirstEditorGroup', 'workbench.action.pinEditor']]);
	});

	test('a reload\'s pinned tab whose recorded group is gone - a floating window\'s, opened again only after Facade\'s tabs - opens in the last group, in front there and marked, the person\'s file there not shown again over it (LIFECYCLE-3.5)', async () => {
		const port = portOf();
		groupsOf(2);
		fileIn(1, '/work/app/a.ts');
		const mine = fileIn(2, '/work/app/b.ts');
		activate(2);
		// Recorded as the front of group 3, not open now
		port.openPair(facts('run-f', { tab: { column: 3 }, pinned: true }), { reveal: false, hidden: true });
		const opening = port.openPinned('run-f');
		const f = await until('its terminal', () => terminals[0]);
		assert.strictEqual((f.options.location as { viewColumn: number }).viewColumn, 2);
		open(f);
		opensIn(f, 2);
		await opening;
		await port.finishRestore();
		// What an opening covered would be shown again by now
		await new Promise(resolve => setTimeout(resolve, 400));
		assert.deepStrictEqual([f.tab.isActive, f.tab.isPinned, mine.isActive, activeGroup().viewColumn], [true, true, false, 2]);
	});

	test('a mark that lands on the person\'s file - brought to the front just as it went on - is undone at once, and nothing is given back over it (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(1);
		const file = fileIn(1, '/work/app/a.ts');
		port.openPair(facts('run-1'), { reveal: false });
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 1);
		await until('the file in front again', () => file.isActive);
		// As the editor's pin runs, the person brings their file to the front: the pin lands there
		model!.before = command => {
			if (command === 'workbench.action.pinEditor') {
				model!.before = undefined;
				toFront(file);
			}
		};
		commands.length = 0;
		port.pinTab('run-1', true);
		await until('the mark on the file undone', () => commands.includes('workbench.action.unpinEditor'));
		await new Promise(resolve => setTimeout(resolve, 300));
		// Nothing given back over the person's file, and no try again behind it
		assert.deepStrictEqual([file.isPinned, file.isActive, agent.tab.isPinned, commands.filter(each => each === 'workbench.action.pinEditor').length], [false, true, false, 1]);
		// The person brings the agent's tab to the front: its mark goes on there
		modelShow(agent, false);
		await until('its tab marked as it is', () => agent.tab.isPinned);
		assert.strictEqual(file.isPinned, false);
	});

	test('a Pin of an agent with no tab open opens its tab in front of the active group with the focus, as a click on its card does, and marks it there; an Unpin of one keeps it hidden (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(1);
		const file = fileIn(1, '/work/app/a.ts');
		port.openPair(facts('run-h', { tab: 'hidden' }), { reveal: false });
		port.openPair(facts('run-u', { tab: 'hidden' }), { reveal: false });
		assert.strictEqual(terminals.length, 0, 'hidden ones have their cards alone');
		// Unpinned while hidden: it stays hidden, nothing shown for it
		port.pinTab('run-u', false);
		assert.strictEqual(terminals.length, 0);
		// Pinned while hidden: its Pin saved, then its tab shown as the card's click shows it
		commands.length = 0;
		port.pinTab('run-h', true);
		await port.reveal('run-h', { preserveFocus: false });
		assert.strictEqual(terminals.length, 1, 'its tab opens for its Pin');
		const agent = terminals[0];
		open(agent);
		opensIn(agent, 1);
		await until('its tab marked', () => agent.tab.isPinned);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepStrictEqual([agent.tab.isActive, file.isActive, commands], [true, false, ['workbench.action.pinEditor']]);
	});

	test('a group closed into another, the editor rebuilding its tabs as new objects, binds no agent to a tab not its own: a Pin there is not changed (LIFECYCLE-2.2, 3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(2);
		// The person's own shell in front of group 1
		const shell = { input: new TabInputTerminal(), label: 'zsh', isActive: false, isPinned: false, isPreview: false, group: groupAt(1) } as ModelTab;
		groupAt(1).tabs.push(shell);
		tabsChanged.fire({ opened: [shell], closed: [], changed: [] });
		toFront(shell);
		// A pinned agent's tab in front of group 2, the active one, its terminal the active one
		port.openPair(facts('run-a', { tab: { column: 2 } }), { reveal: false });
		const a = terminals[0];
		open(a);
		opensIn(a, 2);
		activate(2);
		port.pinTab('run-a', true);
		await until('its tab marked', () => a.tab.isPinned);
		await new Promise(resolve => setTimeout(resolve, 300));
		const changes: unknown[] = [];
		port.onDidPinTab(change => changes.push(change));
		commands.length = 0;
		// Close Group: group 2's tab joins group 1, inactive, every tab a new object; the active terminal the shell's a moment later
		const one: ModelGroup = { viewColumn: 1, tabs: [], activeTab: undefined, isActive: true };
		const shellAgain = { ...shell, group: one, isActive: true } as ModelTab;
		const agentAgain = { ...(a.tab as unknown as ModelTab), group: one, isActive: false } as ModelTab;
		one.tabs.push(shellAgain, agentAgain);
		one.activeTab = shellAgain;
		model!.groups = [one];
		groupsChanged.fire(undefined);
		await new Promise(resolve => setTimeout(resolve, 50));
		activeTerminal = { name: 'zsh' };
		activeChanged.fire(activeTerminal);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepStrictEqual([changes, commands, shellAgain.isPinned, agentAgain.isPinned], [[], [], false, true]);
	});

	test('Pin marks its exact tab - never another, its terminal never focused for it - and a kept tab reopening takes its Pin (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
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
		// The mark's own moment over: a change of the mark from then on is the person's
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.deepStrictEqual([commands, first.shown.every(preserved => preserved === true)], [['workbench.action.pinEditor'], true]);
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
		await port.finishRestore();
		groupsOf(1);
		port.openPair(facts('run-1'), { reveal: true });
		const first = terminals[0];
		open(first);
		opensIn(first, 1);
		port.openPair(facts('run-2'), { reveal: true });
		const second = terminals[1];
		open(second);
		opensIn(second, 1);
		// The first in front, its terminal the active one, pinned
		modelShow(first, false);
		port.pinTab('run-1', true);
		await until('the original tab pinned', () => first.tab.isPinned);
		await new Promise(resolve => setTimeout(resolve, 150));
		// The editor rebuilds its tabs as new objects in place, the first still in front of the active group
		const one = groupAt(1);
		const replacement = { ...(first.tab as unknown as ModelTab), isActive: true } as ModelTab;
		const other = { ...(second.tab as unknown as ModelTab), isActive: false } as ModelTab;
		one.tabs.splice(0, one.tabs.length, replacement, other);
		one.activeTab = replacement;
		groupsChanged.fire(undefined);
		port.pinTab('run-1', false);
		await until('the replacement tab unpinned', () => !replacement.isPinned);
		assert.strictEqual(first.tab.isPinned, true, 'the obsolete object is never used as the command target');
		port.pinTab('run-2', true);
		await new Promise(resolve => setTimeout(resolve, 100));
		assert.deepStrictEqual([other.isPinned, second.shown], [false, []]);
		// The other equal-name tab is correlated only as it becomes active together with its terminal
		toFront(other);
		activeTerminal = second;
		activeChanged.fire(second);
		await until('the second exact tab pinned', () => other.isPinned);
		assert.strictEqual(replacement.isPinned, false);
	});

	test('a group closed into a later one, the editor rebuilding its tabs, binds no agent to a tab not its own: its group gone, its Pin is not changed (LIFECYCLE-2.2, 3.4)', async () => {
		const port = portOf();
		await port.finishRestore();
		groupsOf(2);
		// A pinned agent's tab in front of group 1, the active one; the person's own shell in front of group 2
		port.openPair(facts('run-a', { tab: { column: 1 } }), { reveal: true });
		const a = terminals[0];
		open(a);
		opensIn(a, 1);
		const shell = { input: new TabInputTerminal(), label: 'zsh', isActive: false, isPinned: false, isPreview: false, group: groupAt(2) } as ModelTab;
		groupAt(2).tabs.push(shell);
		tabsChanged.fire({ opened: [shell], closed: [], changed: [] });
		toFront(shell);
		modelShow(a, false);
		port.pinTab('run-a', true);
		await until('its tab marked', () => a.tab.isPinned);
		await new Promise(resolve => setTimeout(resolve, 300));
		const changes: unknown[] = [];
		port.onDidPinTab(change => changes.push(change));
		commands.length = 0;
		// Close Group on group 1: its tab joins group 2, now numbered 1, inactive, every tab a new object; the active terminal the shell's a moment later
		const merged: ModelGroup = { viewColumn: 1, tabs: [], activeTab: undefined, isActive: true };
		const shellAgain = { ...shell, group: merged, isActive: true } as ModelTab;
		const agentAgain = { ...(a.tab as unknown as ModelTab), group: merged, isActive: false } as ModelTab;
		merged.tabs.push(shellAgain, agentAgain);
		merged.activeTab = shellAgain;
		model!.groups = [merged];
		(groupsChanged as unknown as TestEmitter<unknown>).fire({ opened: [], closed: [{ viewColumn: 1 }], changed: [] });
		await new Promise(resolve => setTimeout(resolve, 50));
		activeTerminal = { name: 'zsh' };
		activeChanged.fire(activeTerminal);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.deepStrictEqual([changes, commands, shellAgain.isPinned, agentAgain.isPinned], [[], [], false, true]);
	});

	test('a tab shows the icon its CLI\'s entry names now - a robot for a built-in too - read as the tab opens (CONFIGURATION-2.4)', () => {
		const port = new Execution({ owner: 'workspace-1', ptydScript: '/nonexistent/ptyd.js', home, media: { path: '/ext/media' } as unknown as vscode.Uri, log: () => undefined,
			icon: cli => cli === 'other' ? 'facade-ocean' : 'facade-pearl' });
		ports.push(port);
		port.openPair(facts('run-1'), { reveal: false });
		port.openPair(facts('run-2', { cli: 'other', displayName: 'Other' }), { reveal: false });
		assert.deepStrictEqual(terminals.map(each => (each.options.iconPath as { id: string }).id), ['facade-robot-pearl', 'facade-robot-ocean']);
	});

	test('a pair is one editor terminal from acceptance on, with the agent\'s name and its CLI\'s logo - an added CLI\'s robot; Facade\'s lines show before any process, and the process starts in that same terminal (CONFIGURATION-2.4)', async () => {
		const port = portOf();
		port.openPair(facts('run-1'), { reveal: true });
		port.openPair(facts('run-2', { cli: 'other', displayName: 'Other' }), { reveal: false });
		assert.deepStrictEqual(terminals.map(each => [each.name, each.options.location, each.options.isTransient]), [
			['Ada', { viewColumn: -1, preserveFocus: false }, true],
			['Ada', { viewColumn: -1, preserveFocus: true }, true]
		]);
		assert.strictEqual((terminals[0].options.iconPath as { id: string }).id, 'facade-cli-claude');
		assert.strictEqual((terminals[1].options.iconPath as { id: string }).id, 'facade-robot-pearl');
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

	test('CLI activity reaches the core - its terminal\'s and its reports\' titles never - while the tab keeps only the agent name; until its first report its run is still starting (CLIS-2.3, LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-3'), { reveal: false });
		open(terminals[0]);
		const title = Buffer.from('Fixing tests').toString('base64');
		await port.spawn('run-3', plan(`process.stdin.setRawMode(true); process.stdout.write('\\x1b]0;\\u2733 Claude Code\\x07\\x1b]7501;?\\x1b\\\\'); process.stdin.on('data', d => { if (d.toString().includes('7501;?:')) process.stdout.write('\\x1b]7501;state=working:title=${title}\\x1b\\\\'); }); setInterval(() => {}, 1000);`), meta('run-3'));
		assert.deepStrictEqual(reports[0], { run: 'run-3', activity: 'unknown', reporting: false, awaitingActivity: true });
		await until('its report', () => reports.some(report => report.activity === 'working'));
		assert.deepStrictEqual(reports[reports.length - 1], { run: 'run-3', activity: 'working', observedAt: reports[reports.length - 1].observedAt, reporting: true });
		// Its probe answered, it was still starting until it reported: never unknown with a reason meanwhile
		assert.ok(reports.slice(0, -1).every(report => report.awaitingActivity && !report.reason), JSON.stringify(reports));
		// CLI titles never reach the tab: it says the agent's name alone (LIFECYCLE-2.2)
		assert.deepStrictEqual(terminals[0].names, ['Ada'], 'CLI reports never emit tab names');
		config['terminal.integrated.tabs.separator'] = ' / ';
		configChanged.fire({ affectsConfiguration: section => section === 'terminal.integrated.tabs.separator' });
		assert.deepStrictEqual(terminals[0].names, ['Ada'], 'tab separators no longer affect the name');
		// The spinner turns where its card's dot is green, as the core says (LIFECYCLE-2.2)
		port.spin('run-3', true);
		port.rename('run-3', 'Grace');
		port.spin('run-3', false);
		assert.ok(terminals[0].names.includes('⠋ Ada') && terminals[0].names.includes('⠋ Grace'), JSON.stringify(terminals[0].names));
		assert.strictEqual(terminals[0].names.at(-1), 'Grace');
	});

	test('RULES-3.2: a run whose Facade tools were injected is still starting after its CLI reports, until they connect or its bound passes; work that stops is told a second later', async () => {
		// A bound a slow runner's process start and first report fit in well, as its tools never connect here
		const port = portOf(6_000);
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-tools'), { reveal: false });
		open(terminals[0]);
		// It reports idle at once, works when typed to, and is idle again when typed to once more
		const program = `process.stdin.setRawMode(true); let n = 0; const say = state => process.stdout.write('\\x1b]7501;state=' + state + '\\x1b\\\\');
		process.stdout.write('\\x1b]7501;?\\x1b\\\\'); process.stdin.on('data', d => { if (d.toString().includes('7501;?:')) { say('idle'); } else { say(++n % 2 ? 'working' : 'idle'); } }); setInterval(() => {}, 1000);`;
		await port.spawn('run-tools', { ...plan(program), tools: { state: 'injected' } }, meta('run-tools'));
		await until('its idle report', () => reports.some(report => report.activity === 'not_working'));
		const idle = reports.find(report => report.activity === 'not_working')!;
		assert.strictEqual(idle.awaitingActivity, true, `its tools not connected yet, it is still starting: ${JSON.stringify(reports)}`);
		// Past its bound with its tools still not connected, it did not start properly
		const late = await until('its bound', () => reports.find(report => report.notReady), 12_000);
		assert.deepStrictEqual([late.activity, late.awaitingActivity], ['not_working', undefined]);
		terminals[0].options.pty.handleInput!('w');
		await until('its work', () => reports.at(-1)?.activity === 'working');
		const stopped = performance.now();
		terminals[0].options.pty.handleInput!('i');
		await until('its stop, told', () => reports.at(-1)?.activity === 'not_working', 4_000);
		assert.ok(performance.now() - stopped >= 900, `told ${Math.round(performance.now() - stopped)} ms after it stopped`);
	});

	test('PANEL-1.4: an Enter the person types over a draft goes in after the text typed before it, and once the CLI took the draft its text is told; an empty Enter, a line break in a paste or a run without an input reader tells nothing', async () => {
		// The reading before an Enter given time a slow runner needs: a reading that comes too late would tell nothing
		const port = portOf(undefined, 5_000);
		const submitted: { run: RunId; text: string }[] = [];
		port.onDidSubmit(each => submitted.push(each));
		port.openPair(facts('run-said'), { reveal: false });
		open(terminals[0]);
		// A CLI that draws Claude Code's input frame: its draft, the cursor after it, cleared by an Enter; what it got, in order, kept
		const program = `process.stdin.setRawMode(true); let draft = '', got = '';
		const draw = () => { const rule = '─'.repeat(process.stdout.columns || 80); process.stdout.write('\\x1b[?2026h\\x1b[H\\x1b[2J' + rule + '\\r\\n❯\\u00a0' + draft + '\\x1b7\\r\\n' + rule + '\\r\\n' + JSON.stringify(got) + '\\x1b8\\x1b[?2026l'); };
		process.stdin.on('data', data => { for (const c of data.toString()) { got += c; if (c === '\\r') { draft = ''; } else if (c === '\\x7f') { draft = draft.slice(0, -1); } else if (c >= ' ') { draft += c; } } draw(); });
		draw(); setInterval(() => {}, 1000);`;
		await port.spawn('run-said', { ...plan(program), input: { adapter: 'claude-frame', capability: { state: 'supported', reason: 'the test draws Claude Code\'s input frame' } } }, meta('run-said'));
		const pty = terminals[0].options.pty;
		const got = async () => (await port.readScreen('run-said', 10)).text.join('\n');
		await until('its empty input', async () => (await port.inspectInput('run-said', 'claude-frame')).state === 'usable');
		pty.handleInput!('fix the login bug');
		await until('its draft', async () => (await port.inspectInput('run-said', 'claude-frame')).state === 'draft');
		pty.handleInput!('\r');
		// Told once its input reads empty (CLIS-2.1): another draft typed before that would say nothing of it
		await until('the draft told', () => submitted.length > 0);
		pty.handleInput!('next');
		await until('what it got, in order', async () => (await got()).includes(JSON.stringify('fix the login bug\rnext')));
		pty.handleInput!('\x7f\x7f\x7f\x7f\r');
		pty.handleInput!('\x1b[200~one\rtwo\x1b[201~');
		await until('the paste drawn', async () => (await port.inspectInput('run-said', 'claude-frame')).draft?.includes('two'));
		await new Promise(resolve => setTimeout(resolve, 600));
		assert.deepStrictEqual(submitted, [{ run: 'run-said', text: 'fix the login bug' }]);
	});

	test('LIFECYCLE-2.2, UX-2.2: a busy tab\'s spinner is still with workbench.reduceMotion on and turns with it off; at auto it stays still until the panel\'s page says the system allows motion, then follows what it says', async () => {
		const port = portOf();
		port.openPair(facts('run-motion'), { reveal: false });
		open(terminals[0]);
		const turning = async () => {
			const before = terminals[0].names.length;
			await new Promise(resolve => setTimeout(resolve, 350));
			return terminals[0].names.length > before;
		};
		const setting = (value: string) => {
			config['reduceMotion'] = value;
			configChanged.fire({ affectsConfiguration: section => section === 'workbench.reduceMotion' });
		};
		config['reduceMotion'] = 'auto';
		port.spin('run-motion', true);
		const unreported = await turning();
		port.systemMotion(false);
		const allowed = await turning();
		port.systemMotion(true);
		const reduced = await turning();
		setting('off');
		const off = await turning();
		port.systemMotion(false);
		setting('on');
		const on = await turning();
		port.spin('run-motion', false);
		assert.deepStrictEqual({ unreported, allowed, reduced, off, on }, { unreported: false, allowed: true, reduced: false, off: true, on: false });
	});

	test('neither its terminal\'s titles (OSC 0/2) nor its reports\' reach the core, before or after reattachment: what it reports is its activity alone (CLIS-2.3)', async () => {
		const first = portOf();
		const reports: ActivityReport[] = [];
		first.onDidReport(report => reports.push(report));
		first.openPair(facts('run-title'), { reveal: false });
		open(terminals[0]);
		const plain = Buffer.from('Checking tests').toString('base64');
		const decorated = ['✳ Checking tests', '⠐ Checking tests', '✓ Checking tests | workspace', ''];
		// A report with a title of its own before the first terminal title and after every later one, then working at a key
		const program = `process.stdin.setRawMode(true); const titles = ${JSON.stringify(decorated)}; let i = 0;
		const status = state => process.stdout.write('\\x1b]7501;state=' + state + ':title=${plain}\\x1b\\\\');
		const title = () => process.stdout.write('\\x1b]2;' + titles[i] + '\\x1b\\\\');
		status('idle'); title(); process.stdin.on('data', () => { i++; title(); status(i % 2 ? 'working' : 'idle'); }); setInterval(() => {}, 1000);`;
		await first.spawn('run-title', plan(program), meta('run-title'));
		await until('its first report', () => reports.some(report => report.reporting));
		for (const [i] of decorated.slice(1).entries()) {
			terminals[0].options.pty.handleInput!('x');
			await until('its next report', () => reports.at(-1)?.activity === (i % 2 ? 'not_working' : 'working'));
		}
		first.dispose();
		ports.splice(ports.indexOf(first), 1);
		const next = portOf();
		const restored: ActivityReport[] = [];
		next.onDidReport(report => restored.push(report));
		const live = await until('the saved run to be unclaimed', async () => {
			const runs = await next.live();
			return runs.length === 1 && !runs[0].claimedElsewhere && runs[0];
		});
		await next.attach(live, facts('run-title'));
		assert.deepStrictEqual([...reports, ...restored].filter(report => 'title' in report), []);
		assert.ok(restored.length > 0, 'the reattached run is told again');
		assert.strictEqual(await next.terminate('run-title'), 'terminated');
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

	test('ARCHITECTURE-2.3: a title event of an earlier build\'s ptyd is not heard as the run\'s report: a listing answered meanwhile still puts its newer status', async function () {
		this.timeout(20_000);
		const port = portOf();
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-47'), { reveal: false });
		open(terminals[0]);
		await port.spawn('run-47', plan(`process.stdin.setRawMode(true); process.stdout.write('\\x1b]7501;?\\x1b\\\\'); process.stdin.on('data', d => { if (d.toString().includes('7501;?:')) process.stdout.write('\\x1b]7501;state=working\\x1b\\\\'); }); setInterval(() => {}, 1000);`), meta('run-47'));
		await until('working', () => reports.some(report => report.activity === 'working'));
		let entered!: () => void;
		let release!: () => void;
		const asked = new Promise<void>(resolve => { entered = resolve; });
		// The listing says the run went idle since, which the window did not hear
		listGate = { entered, open: new Promise<void>(resolve => { release = resolve; }),
			answer: runs => runs.map(run => run.run === 'run-47' && run.status ? { ...run, status: { ...run.status, state: 'idle' as const, at: run.status.at + 1 } } : run) };
		await asked;
		runListeners.get('run-47')!({ event: 'title', run: 'run-47', title: 'Fixing tests' } as never);
		release();
		await until('the listing\'s status', () => reports[reports.length - 1]?.activity === 'not_working', 5_000);
		assert.strictEqual(await port.terminate('run-47'), 'terminated');
	});

	test('UX-2.4, MCP-3.1: a CLI error without words of its own is reported in English for agents and in the person\'s words for the card; a CLI\'s own words are its own, for both', async function () {
		this.timeout(20_000);
		translations = { 'CLI reported an error': 'CLI hat einen Fehler gemeldet' };
		const port = portOf();
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-48'), { reveal: false });
		open(terminals[0]);
		const words = Buffer.from('Rate limited').toString('base64');
		await port.spawn('run-48', plan(`process.stdin.setRawMode(true); process.stdout.write('\\x1b]7501;?\\x1b\\\\'); process.stdin.on('data', d => process.stdout.write(d.toString().includes('7501;?:') ? '\\x1b]7501;state=error\\x1b\\\\' : '\\x1b]7501;state=error:msg=${words}\\x1b\\\\')); setInterval(() => {}, 1000);`), meta('run-48'));
		const bare = await until('its error', () => reports.find(report => report.error !== undefined));
		terminals[0].options.pty.handleInput!('x');
		const own = await until('its own words', () => reports.find(report => report.error === 'Rate limited'));
		assert.deepStrictEqual([[bare.error, bare.errorWords], [own.error, own.errorWords]], [['CLI reported an error', 'CLI hat einen Fehler gemeldet'], ['Rate limited', undefined]]);
		assert.strictEqual(await port.terminate('run-48'), 'terminated');
	});

	/** A CLI that says it is ready and then nothing, taking no part in the protocol. */
	const QUIET = `process.stdout.write('ready\\r\\n'); setInterval(() => {}, 1000);`;

	test('a run whose CLI shows no activity is still starting until its bound from its process start, then unknown with why; a reloaded window counts from that start, not its own (CLIS-2.3)', async function () {
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
			await next.attach(live[0], facts('run-40'));
			return { next, told };
		};
		// Reloaded within its bound: still starting, until the bound from its process start passes
		const { next, told } = await reload(first);
		assert.deepStrictEqual(told, [{ run: 'run-40', activity: 'unknown', reporting: false, awaitingActivity: true }]);
		const over = await until('its startup over', () => told.find(report => !report.awaitingActivity), 6_000);
		assert.ok(performance.now() - before >= BOUND - 50, 'not before its bound');
		assert.deepStrictEqual(over, { run: 'run-40', activity: 'unknown', reporting: false, notReady: true, reason: "CLI has not reported activity", unknown: 'not_reporting' });
		// Reloaded past it: unknown at once, its startup not begun again
		const last = await reload(next);
		assert.deepStrictEqual(last.told, [{ run: 'run-40', activity: 'unknown', reporting: false, notReady: true, reason: "CLI has not reported activity", unknown: 'not_reporting' }]);
		assert.strictEqual(await last.next.terminate('run-40'), 'terminated');
	});

	test('a CLI that asked whether its terminal takes reports and has not reported since is still starting until its bound, then waited for with why (CLIS-2.3)', async function () {
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
		assert.deepStrictEqual(over, { run: 'run-41', activity: 'unknown', observedAt: reports[reports.length - 1].observedAt, reporting: true, notReady: true, reason: "Waiting for first CLI activity report", unknown: 'waiting' }, JSON.stringify(reports));
		assert.ok(reports.slice(0, -1).every(report => report.awaitingActivity), JSON.stringify(reports));
		assert.strictEqual(reports.at(-2)?.reporting, true);
	});

	test('a run whose CLI showed its activity - its screen read, here - is not starting again as its CLI then asks whether its terminal takes reports and has not reported yet (CLIS-2.3)', async () => {
		const port = portOf(10_000);
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		port.openPair(facts('run-43', { cli: 'muse', displayName: 'Muse Code', command: 'muse' }), { reveal: false });
		open(terminals[0]);
		const idle = `  Muse Code 1.4.14\r\n── Voice input (Alt+V to start) ${'─'.repeat(30)}\r\n❯\r\n${'─'.repeat(60)}\r\n  muse-spark-1.3 · minimal · /work`;
		const script = `process.stdin.setRawMode(true); process.stdout.write('\\x1b[2J\\x1b[H' + ${JSON.stringify(idle)}); setTimeout(() => process.stdout.write('\\x1b]7501;?\\x1b\\\\'), 800); setInterval(() => {}, 1000);`;
		await port.spawn('run-43', { ...plan(script), cli: 'muse', displayName: 'Muse Code', command: 'muse', screenStatus: 'muse' }, meta('run-43'));
		await until('its screen read', () => reports.some(report => report.activity === 'not_working'));
		const asked = await until('its probe told', () => reports.find(report => report.reporting && report.activity === 'unknown'), 5_000);
		assert.deepStrictEqual(asked, { run: 'run-43', activity: 'unknown', observedAt: reports[reports.length - 1].observedAt, reporting: true, reason: "Waiting for first CLI activity report", unknown: 'waiting' });
		assert.strictEqual(await port.terminate('run-43'), 'terminated');
	});

	/** A CLI that says a numbered line every 20 ms, from 1 on. */
	const COUNTING = `let n = 0; setInterval(() => process.stdout.write('line ' + (++n) + '\\r\\n'), 20);`;
	/** The numbers of `text`'s lines, in the order written. */
	const numbersIn = (text: string) => [...text.matchAll(/line (\d+)/g)].map(match => Number(match[1]));
	/** The window `from` reloads: the next one finds the run and claims it again, its tab then opened by the person; what it tells and shows. */
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
		await next.attach(live[0], facts(run));
		const terminal = await openedAgain(next, run, count);
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
		await next.attach(listed[0], facts('run-46'));
		assert.deepStrictEqual(exits, [], 'told once the core has shown it');
		await until('its end told', () => exits.length > 0);
		assert.deepStrictEqual(exits, [{ run: 'run-46', code: 5, interruptVerified: false }]);
		// Its tab opened by the person: its screen drawn as it opens, the line of its end after it
		const terminal = await openedAgain(next, 'run-46', count);
		await until('its end said on its screen', () => screenOf(terminal).includes('[Agent process exited with code 5]'));
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

	test('a close its ptyd did not confirm is recorded: a reload before then ends the run and does not show it again (ARCHITECTURE-2.3, LIFECYCLE-3.1)', async function () {
		this.timeout(20_000);
		const first = portOf();
		first.openPair(facts('run-48'), { reveal: false });
		open(terminals[0]);
		await first.spawn('run-48', plan(QUIET), meta('run-48'));
		await until('its screen', () => screenOf(terminals[0]).includes('ready'));
		failTerminateOnce = true;
		first.removePair('run-48');
		assert.strictEqual(await first.terminate('run-48'), 'unconfirmed');
		// The window reloads before its next check would end the run
		ports.splice(ports.indexOf(first), 1);
		first.dispose();
		const next = portOf();
		assert.deepStrictEqual(await next.live(), [], 'a run the person closed is not shown again');
		await until('the run ended and forgotten', async () => !(await next.allRunIds()).includes('run-48') && (await next.live()).length === 0);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'workspaces', 'workspace-1', 'closing.json'), 'utf8')), [], 'its record goes once ptyd confirms it');
	});

	test('a window that shows no run connects again when its connection goes: its claim, which ptyd would let expire, is kept (RULES-4.1)', async function () {
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
		assert.deepStrictEqual(back, { report: { run: 'run-42', activity: 'unknown', reporting: false, notReady: true, reason: "CLI has not reported activity", unknown: 'not_reporting' }, connections: 2 });
		assert.strictEqual(await port.terminate('run-42'), 'terminated');
	});

	/** A CLI that titles its terminal "Fixing tests" and says it is ready, then retitles it with whatever it is typed, and says so. */
	const TITLED = `process.stdin.setRawMode(true); process.stdout.write('\\x1b]0;Fixing tests\\x07ready\\r\\n'); process.stdin.on('data', d => process.stdout.write('\\x1b]0;' + d.toString() + '\\x07titled ' + d.toString() + '\\r\\n')); setInterval(() => {}, 1000);`;
	/** The core's part, as AgentService does it: a label renames the agent and its tab, including an empty string. */
	const renamesOf = (port: AgentExecution) => {
		const renames: { run: RunId; name: string }[] = [];
		port.onDidRenameTab(rename => {
			renames.push(rename);
			port.rename(rename.run, rename.name.trim());
		});
		return renames;
	};
	/** A new agent whose CLI titles its terminal, which neither its tab nor the panel shows: the tab keeps the agent name. */
	const agentTitled = async (port: AgentExecution, run: RunId, name = 'Ada') => {
		port.openPair(facts(run, { name }), { reveal: false });
		const terminal = terminals[terminals.length - 1];
		open(terminal);
		await port.spawn(run, plan(TITLED), meta(run));
		// Its title came first, in the same write as what it says
		await until('its screen', () => screenOf(terminal).includes('ready'));
		shows(terminal);
		assert.strictEqual(unspun(terminal.name), name);
		return terminal;
	};

	test('a person\'s rename of an agent\'s tab, read from its own terminal, renames the agent; its tab then has only the new name (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-r');
		titled(terminal, 'Grace Hopper');
		assert.deepStrictEqual([renames, terminal.pending.map(unspun)], [[{ run: 'run-r', name: 'Grace Hopper' }], ['Grace Hopper']]);
		shows(terminal);
		assert.deepStrictEqual([renames.length, unspun(terminal.name)], [1, 'Grace Hopper'], 'its own name shown is no rename');
	});

	test('a person renaming a tab back to the name it had renames the agent back: a name the tab already showed is no echo (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-x4');
		titled(terminal, 'Bob');
		shows(terminal);
		titled(terminal, 'Ada');
		assert.deepStrictEqual(renames.map(each => each.name), ['Bob', 'Ada']);
	});

	test('native renames preserve title-like suffixes in full while the CLI\'s changing titles reach neither its tab nor a report, with no tab-name events (LIFECYCLE-2.2, CLIS-2.3)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const reports: ActivityReport[] = [];
		port.onDidReport(report => reports.push(report));
		const terminal = await agentTitled(port, 'run-s');
		titled(terminal, 'Lin | Fixing tests');
		shows(terminal);
		assert.strictEqual(unspun(terminal.name), 'Lin | Fixing tests', 'the former separator and current CLI title are literal name text');
		// The CLI changes its title twice, but the tab and the stored name stay stable.
		const names = [...terminal.names];
		terminal.options.pty.handleInput!('Writing docs');
		await until('the new title written', () => screenOf(terminal).includes('titled Writing docs'));
		terminal.options.pty.handleInput!('Reading');
		await until('the next title written', () => screenOf(terminal).includes('titled Reading'));
		assert.deepStrictEqual([terminal.names, reports.filter(report => 'title' in report)], [names, []]);
		assert.strictEqual(unspun(terminal.name), 'Lin | Fixing tests');
		titled(terminal, 'Kim | Writing docs');
		shows(terminal);
		assert.deepStrictEqual([renames, unspun(terminal.name)], [[{ run: 'run-s', name: 'Lin | Fixing tests' }, { run: 'run-s', name: 'Kim | Writing docs' }], 'Kim | Writing docs']);
	});

	test('a tab accepts human, empty and Unicode labels, keeping the whole entered name without a CLI title (LIFECYCLE-2.1, 2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-i');
		for (const typed of ['human', '   ', '@Human | Fixing tests', ' Ada ', '检查长名字与location协调 16 🧑🏽‍💻']) {
			titled(terminal, typed);
			shows(terminal);
			assert.strictEqual(unspun(terminal.name), typed.trim(), typed);
		}
		assert.deepStrictEqual(renames.map(each => each.name), ['human', '   ', '@Human | Fixing tests', ' Ada ', '检查长名字与location协调 16 🧑🏽‍💻']);
	});

	test('delayed programmatic name changes never become human renames; a later human rename back to an older name still works (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const terminal = await agentTitled(port, 'run-late');
		port.rename('run-late', 'Grace');
		port.rename('run-late', 'Lin');
		shows(terminal);
		assert.deepStrictEqual([renames, unspun(terminal.name)], [[], 'Lin']);
		titled(terminal, 'Grace');
		shows(terminal);
		assert.deepStrictEqual([renames, unspun(terminal.name)], [[{ run: 'run-late', name: 'Grace' }], 'Grace']);
	});

	test('the editor naming a tab by the name its terminal was created with - once it opens, and again as it is relaunched - is no rename: the tab gets its name back at once; after the agent was renamed, a person naming the tab so renames it (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		// The agent was renamed before its pseudoterminal opened; the native terminal still has its creation name.
		port.openPair(facts('run-t'), { reveal: false });
		const terminal = terminals[0];
		await port.spawn('run-t', plan(TITLED), meta('run-t'));
		port.rename('run-t', 'Grace');
		open(terminal);
		await until('its screen', () => screenOf(terminal).includes('ready'));
		shows(terminal);
		resets(terminal);
		assert.deepStrictEqual([renames, terminal.pending.map(unspun)], [[], ['Grace']]);
		shows(terminal);
		// Relaunched, VS Code closes and opens the same pseudoterminal again, then names the tab by the name it was created with
		terminal.options.pty.close();
		open(terminal);
		shows(terminal);
		resets(terminal);
		shows(terminal);
		assert.deepStrictEqual([renames, unspun(terminal.name)], [[], 'Grace']);
		port.rename('run-t', 'Lin');
		shows(terminal);
		titled(terminal, 'Ada');
		shows(terminal);
		assert.deepStrictEqual([renames, unspun(terminal.name)], [[{ run: 'run-t', name: 'Ada' }], 'Ada']);
	});

	test('two agents of one name and title: a person\'s rename of either tab renames that agent alone, by its own terminal (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames = renamesOf(port);
		const first = await agentTitled(port, 'run-a');
		const second = await agentTitled(port, 'run-b');
		assert.strictEqual(unspun(first.name), unspun(second.name));
		titled(second, 'Grace');
		shows(second);
		titled(first, 'Lin');
		shows(first);
		assert.deepStrictEqual([renames, unspun(first.name), unspun(second.name)], [[{ run: 'run-b', name: 'Grace' }, { run: 'run-a', name: 'Lin' }], 'Lin', 'Grace']);
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
		const lost = await until('the loss told', () => reports.find(report => report.activity === 'unknown' && /connection/i.test(report.reason ?? '')));
		assert.deepStrictEqual(lost, { run: 'run-30', activity: 'unknown', reporting: true, reason: "Connection to agent process lost; reconnecting", reasonWords: 'Connection lost · reconnecting', disconnected: true });
		// ptyd stays away past the first try to connect again, which gives up; it comes back, and a later check claims the run again
		await new Promise(resolve => setTimeout(resolve, 7_000));
		assert.deepStrictEqual(exits, []);
		server = new PtydServer(ownPtydSocket(home, '/nonexistent/ptyd.js'));
		server.build = ptydBuild('/nonexistent/ptyd.js', '');
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
		port.onDidClosePair!(({ run }) => closes.push(run));
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
		port.onDidClosePair!(({ run }) => closes.push(run));
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

	test('a hidden pair - an agent another agent starts - has no tab: its run starts and works at 120 by 30, and its tab opens, on its screen, as the person opens it (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		port.openPair(facts('run-hid'), { reveal: false, hidden: true });
		const { pid } = await port.spawn('run-hid', plan(`process.stdout.write('size ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n'); ${ECHO}`), meta('run-hid'));
		assert.ok(pid > 0);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.strictEqual(terminals.length, 0, 'no tab opened');
		assert.strictEqual(await port.reveal('run-hid', { preserveFocus: false }), true);
		assert.strictEqual(terminals.length, 1);
		open(terminals[0]);
		await until('its screen', () => screenOf(terminals[0]).includes('size 120x30'));
	});

	test('a group shows any number of agent tabs, pinned or not: one opened or moved in hides none, and an Unpin hides none either (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const closes: unknown[] = [];
		port.onDidClosePair!(close => closes.push(close));
		const first = { viewColumn: 1 }, second = { viewColumn: 2 };
		const shown = (index: number, group: { viewColumn: number }) => {
			const terminal = terminals[index];
			for (const other of terminals) { Object.assign(other.tab, { isActive: false }); }
			Object.assign(terminal.tab, { group, isActive: true });
			open(terminal);
			tabsChanged.fire({ opened: [terminal.tab], closed: [], changed: [] });
		};
		port.openPair(facts('run-a'), { reveal: true });
		shown(0, first);
		port.openPair(facts('run-b'), { reveal: true });
		shown(1, first);
		port.openPair(facts('run-c'), { reveal: true });
		port.pinTab('run-c', true);
		shown(2, first);
		port.openPair(facts('run-d'), { reveal: true });
		shown(3, second);
		// B moved into the second group: its tab closed there while its terminal stays open, and one opened in the other
		const moved = { input: new TabInputTerminal(), isPinned: false, isActive: true, group: second };
		tabsChanged.fire({ opened: [], closed: [terminals[1].tab], changed: [] });
		tabsChanged.fire({ opened: [moved], closed: [], changed: [] });
		port.pinTab('run-c', false);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual([terminals.map(each => each.disposed), closes], [[false, false, false, false], []]);
	});

	test('a repeated name shows its short ID on its tab, and a native rename takes that ID off what was typed - the tab\'s own, once - whatever the duplicates are by then (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const renames: unknown[] = [];
		port.onDidRenameTab(rename => renames.push(rename));
		port.openPair(facts('run-r'), { reveal: false });
		const tab = terminals[0];
		open(tab);
		const reset = (name: string) => { tab.name = name; tabsChanged.fire({ opened: [], closed: [], changed: [tab.tab] }); };
		reset(tab.options.name as string);
		port.tabLabel('run-r', '#a12', true);
		assert.strictEqual(tab.names.at(-1), 'Ada #a12');
		reset('Ada #a12');
		assert.deepStrictEqual(renames, [], 'its own title is no rename');
		for (const [typed, name] of [['auditor', 'auditor'], ['auditor #a12', 'auditor'], ['#a12', ''], ['auditor #a13', 'auditor #a13']] as const) {
			renames.length = 0;
			reset(typed);
			assert.deepStrictEqual(renames, [{ run: 'run-r', name }], typed);
			port.rename('run-r', 'Ada');
			reset(tab.names.at(-1)!);
		}
		port.tabLabel('run-r', '#a12', false);
		assert.strictEqual(tab.names.at(-1), 'Ada');
	});

	test('a reload reattaches each run with its tab hidden; a pinned agent\'s tab opens in its turn as its record says - in its group, the last one where that is gone, else the active one, hidden or kept by no record - and an unpinned one\'s stays hidden whatever its record (LIFECYCLE-3.5)', async function () {
		this.timeout(30_000);
		const first = portOf();
		const places: Record<string, Partial<PairFacts>> = {
			'in-2': { tab: { column: 2 }, pinned: true }, 'in-gone': { tab: { column: 5 }, pinned: true }, hid: { tab: 'hidden', pinned: true }, old: { tab: undefined, pinned: true },
			'open-2': { tab: { column: 2 } }, 'old-unpinned': { tab: undefined }
		};
		for (const run of Object.keys(places)) {
			first.openPair(facts(run), { reveal: false, hidden: true });
			await first.spawn(run, plan(ECHO), meta(run));
		}
		const second = portOf();
		const live = await second.live();
		groupsOf(2);
		const before = terminals.length;
		for (const run of Object.keys(places)) {
			await second.attach(live.find(each => each.run === run)!, facts(run, places[run]));
		}
		assert.strictEqual(terminals.length, before, 'no tab opens as the runs are reattached');
		// The pinned ones' turns, as the core gives them: each tab where its record says, the next once it opened and took its mark
		const opened: Record<string, unknown> = {};
		for (const run of Object.keys(places).filter(each => places[each].pinned)) {
			const at = terminals.length;
			const opening = second.openPinned(run);
			const terminal = await until(`${run}'s terminal`, () => terminals[at]);
			const asked = (terminal.options.location as { viewColumn: number }).viewColumn;
			open(terminal);
			opensIn(terminal, asked === -1 ? activeGroup().viewColumn : asked);
			opened[run] = asked;
			await opening;
		}
		await second.finishRestore();
		assert.deepStrictEqual([opened, terminals.length - before, terminals.slice(before).every(each => each.tab.isPinned)], [{ 'in-2': 2, 'in-gone': 2, hid: -1, old: -1 }, 4, true]);
	});

	test('a copy of an agent\'s tab - no shell or pseudoterminal of its own, the name its tab was opened under - becomes at once an ordinary terminal in its agent\'s folder, in the copy\'s group, the copy closing as that terminal is in front; each of several copies alike, a person\'s own shell untouched, and no agent starts (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		port.openPair(facts('run-c1', { cwd: path.join(os.tmpdir(), 'ada') }), { reveal: false });
		open(terminals[0]);
		port.openPair(facts('run-c2', { name: 'Bo' }), { reveal: false });
		open(terminals[1]);
		const spawned = spawns;
		const copyOf = (name: string, more: object = {}) => ({ name, creationOptions: { name, ...more }, disposed: false, dispose() { this.disposed = true; } });
		const tabIn = (viewColumn: number, isActive: boolean) => ({ input: new TabInputTerminal(), isActive, isPinned: false, group: { viewColumn } });
		// A split: the copy's tab in group 2, active with the copy's terminal
		const one = copyOf('Ada'), oneTab = tabIn(2, true);
		openedTerminal.fire(one);
		visibleTabs = [terminals[0].tab, terminals[1].tab, oneTab];
		tabsChanged.fire({ opened: [oneTab], closed: [], changed: [] });
		activeTab = oneTab; activeTerminal = one; activeChanged.fire(one);
		const shell = await until('the terminal in its place', () => shells[0]);
		assert.deepStrictEqual([shell.options.cwd, shell.options.location, shell.options.name, one.disposed], [path.join(os.tmpdir(), 'ada'), { viewColumn: 2, preserveFocus: false }, undefined, false]);
		// In front: the copy, which has no process, goes
		activeTerminal = shell; activeChanged.fire(shell as never);
		await until('the copy closed', () => one.disposed);
		// A person's own shell named like an agent is no copy; two copies at once each become a terminal, Bo's in Bo's folder
		const own = copyOf('Ada', { shellPath: '/bin/zsh' });
		openedTerminal.fire(own);
		const both = [copyOf('Ada'), copyOf('Bo')];
		for (const each of both) { openedTerminal.fire(each); }
		await until('both terminals', () => shells.length === 3 || undefined);
		shells[1].started(41);
		shells[2].started(42);
		await until('both copies closed', () => both.every(each => each.disposed) || undefined);
		assert.deepStrictEqual([own.disposed, shells.slice(1).map(each => each.options.cwd), spawns - spawned, terminals.length], [false, [path.join(os.tmpdir(), 'ada'), os.tmpdir()], 0, 2]);
	});

	test('an agent opened before and opened again behind the person\'s editor waits for this opening of its terminal, not its first: nothing spins, and the editor it covered shows again once it opens (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		port.openPair(facts('run-u1'), { reveal: false });
		open(terminals[0]);
		tabsChanged.fire({ opened: [terminals[0].tab], closed: [], changed: [] });
		port.hideTab!('run-u1');
		closed.fire(terminals[0]);
		// The person's file in front, then the agent's tab made anew behind it, opening active over it before its terminal opens
		const file = { input: { uri: 'file:///work/app/README.md' }, isActive: true, isPinned: false, isPreview: false, group: { viewColumn: 1, tabs: [] as unknown[] } };
		file.group.tabs.push(file);
		visibleGroups = [file.group];
		activeTab = file;
		port.reopen('run-u1');
		const again = terminals[1];
		const tab = { ...again.tab, isActive: true, group: file.group };
		file.group.tabs.push(tab);
		file.isActive = false;
		visibleTabs = [file, tab];
		tabsChanged.fire({ opened: [tab], closed: [], changed: [] });
		// While its terminal is not open yet, a timer still runs: nothing waits in a loop of its own
		const before = Date.now();
		await new Promise(resolve => setTimeout(resolve, 10));
		const took = Date.now() - before;
		assert.ok(took < 500, `a 10 ms timer ran after ${took} ms`);
		assert.ok(!commands.includes('vscode.open'), 'nothing is shown before its terminal opens');
		open(again);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.ok(commands.includes('vscode.open'), 'the covered editor is shown again once it opened');
	});

	test('a known tab whose group\'s number changes - an earlier group closed - is told in its group\'s new number, for a reload to bring it back there (LIFECYCLE-3.5)', async () => {
		const port = portOf();
		const places: { run: RunId; place: unknown }[] = [];
		port.onDidPlaceTab!(each => places.push(each));
		const groups = [{ viewColumn: 2 }, { viewColumn: 3 }];
		for (const [index, run] of [[0, 'run-n1'], [1, 'run-n2']] as const) {
			port.openPair(facts(run, { name: `Agent ${index}` }), { reveal: false });
			open(terminals[index]);
			Object.assign(terminals[index].tab, { group: groups[index] });
			tabsChanged.fire({ opened: [terminals[index].tab], closed: [], changed: [] });
		}
		places.length = 0;
		// Group 1 - a file's - closes: the others number themselves 1 and 2
		groups[0].viewColumn = 1; groups[1].viewColumn = 2;
		groupsChanged.fire(undefined);
		assert.deepStrictEqual(places.map(each => [each.run, typeof each.place === 'object' ? (each.place as { column: number }).column : each.place]), [['run-n1', 1], ['run-n2', 2]]);
	});

	test('where VS Code numbers its groups anew with new objects - a group closed or opened rebuilds its whole model - a tab is told by the groups that closed and opened, known or not (LIFECYCLE-3.5)', async () => {
		const port = portOf();
		const places: { run: RunId; place: unknown }[] = [];
		port.onDidPlaceTab!(each => places.push(each));
		for (const [index, run, column] of [[0, 'run-r1', 2], [1, 'run-r2', 3]] as const) {
			port.openPair(facts(run, { name: `Agent ${index}` }), { reveal: false });
			open(terminals[index]);
			Object.assign(terminals[index].tab, { group: { viewColumn: column } });
			tabsChanged.fire({ opened: [terminals[index].tab], closed: [], changed: [] });
		}
		const columns = () => places.map(each => [each.run, typeof each.place === 'object' ? (each.place as { column: number }).column : each.place]);
		// Group 1, a file's, closes: the model rebuilt, every tab a new object
		places.length = 0;
		visibleTabs = [{ input: new TabInputTerminal(), isActive: false, isPinned: false, group: { viewColumn: 1 } }, { input: new TabInputTerminal(), isActive: false, isPinned: false, group: { viewColumn: 2 } }];
		groupsChanged.fire({ opened: [], closed: [{ viewColumn: 1 }], changed: [] } as never);
		assert.deepStrictEqual(columns(), [['run-r1', 1], ['run-r2', 2]]);
		// A group opens at 2: the one there and after it move one on
		places.length = 0;
		groupsChanged.fire({ opened: [{ viewColumn: 2 }], closed: [], changed: [] } as never);
		assert.deepStrictEqual(columns(), [['run-r2', 3]]);
	});

	test('where groups join, every agent tab moved in stays, active or not, its agent going on (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		const place = (index: number, viewColumn: number, isActive: boolean) => Object.assign(terminals[index].tab, { group: { viewColumn }, isActive });
		const join = (index: number, isActive: boolean) => {
			const moved = { input: new TabInputTerminal(), isActive, isPinned: false, label: terminals[index].tab.label, group: { viewColumn: 1 } };
			tabsChanged.fire({ opened: [moved], closed: [terminals[index].tab], changed: [] });
			return moved;
		};
		for (const [index, run, column] of [[0, 'run-j1', 1], [1, 'run-j2', 2], [2, 'run-j3', 3]] as const) {
			port.openPair(facts(run, { name: `Agent ${index}` }), { reveal: false });
			open(terminals[index]);
			place(index, column, false);
			tabsChanged.fire({ opened: [terminals[index].tab], closed: [], changed: [] });
		}
		// Join All Groups from group 1: the agents moved in, inactive and active, all stay
		join(1, false);
		join(2, true);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual(terminals.slice(0, 3).map(each => each.disposed), [false, false, false]);
	});

	test('a mark changed on a tab Facade cannot tell wins once the tab is known where it came after the agent\'s last Pin or Unpin; else Facade\'s Pin stands and the mark follows (LIFECYCLE-3.4, J12)', async () => {
		const port = portOf();
		await port.finishRestore();
		const changes: unknown[] = [];
		port.onDidPinTab(change => changes.push(change));
		const tick = () => new Promise(resolve => setTimeout(resolve, 5));
		for (const [index, run] of [[0, 'run-m1'], [1, 'run-m2']] as const) {
			port.openPair(facts(run), { reveal: false });
			open(terminals[index]);
			tabsChanged.fire({ opened: [terminals[index].tab], closed: [], changed: [] });
		}
		// Both moved at once: neither tab can be told now
		const [first, second] = [0, 1].map(() => ({ input: new TabInputTerminal(), isPinned: false, isActive: false, group: { viewColumn: 2 } }));
		tabsChanged.fire({ opened: [first, second], closed: [terminals[0].tab, terminals[1].tab], changed: [] });
		// m1: Unpinned from its card, then pinned natively on its unknown tab - the later, the tab's, wins
		port.pinTab('run-m1', false);
		await tick();
		tabsChanged.fire({ opened: [], closed: [], changed: [Object.assign(first, { isPinned: true })] });
		// m2: pinned natively on its unknown tab, then Unpinned from its card - the card's, later, stands
		tabsChanged.fire({ opened: [], closed: [], changed: [Object.assign(second, { isPinned: true })] });
		await tick();
		port.pinTab('run-m2', false);
		const known = (index: number, tab: typeof first) => {
			activeTab = tab; activeTerminal = terminals[index];
			activeChanged.fire(terminals[index]);
			tabsChanged.fire({ opened: [], closed: [], changed: [Object.assign(tab, { isActive: true })] });
		};
		assert.deepStrictEqual(changes, [], 'nothing told while the tabs are unknown');
		known(0, first);
		known(1, second);
		assert.deepStrictEqual(changes, [{ run: 'run-m1', pinned: true }]);
		await until('the card\'s Unpin followed on the tab', () => commands.includes('workbench.action.unpinEditor'));
	});

	test('two native changes of an unknown tab\'s mark ending on the mark it showed are still the latest: newer than the card\'s Pin, they win (LIFECYCLE-3.4)', async () => {
		const port = portOf();
		const changes: unknown[] = [];
		port.onDidPinTab(change => changes.push(change));
		for (const [index, run] of [[0, 'run-p1'], [1, 'run-p2']] as const) {
			port.openPair(facts(run), { reveal: false });
			open(terminals[index]);
			tabsChanged.fire({ opened: [terminals[index].tab], closed: [], changed: [] });
		}
		// Pinned from its card, its mark to follow; then both tabs moved at once, neither told
		port.pinTab('run-p1', true);
		await new Promise(resolve => setTimeout(resolve, 5));
		const [first, second] = [0, 1].map(() => ({ input: new TabInputTerminal(), isPinned: false, isActive: false, group: { viewColumn: 2 } }));
		tabsChanged.fire({ opened: [first, second], closed: [terminals[0].tab, terminals[1].tab], changed: [] });
		// The person pins its tab natively, then unpins it: it ends as it was, the latest change the person's
		tabsChanged.fire({ opened: [], closed: [], changed: [Object.assign(first, { isPinned: true })] });
		tabsChanged.fire({ opened: [], closed: [], changed: [Object.assign(first, { isPinned: false })] });
		activeTab = first; activeTerminal = terminals[0];
		activeChanged.fire(terminals[0]);
		tabsChanged.fire({ opened: [], closed: [], changed: [Object.assign(first, { isActive: true })] });
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.deepStrictEqual([changes, commands.includes('workbench.action.pinEditor')], [[{ run: 'run-p1', pinned: false }], false]);
	});

	test('hiding a tab closes it with no close of the person\'s, the run going on; the person\'s close says whether the tab showed its pin mark (LIFECYCLE-2.2, 3.4)', async () => {
		const port = portOf();
		const closes: { readonly run: RunId; readonly marked: boolean }[] = [];
		port.onDidClosePair!(close => closes.push(close));
		port.openPair(facts('run-h'), { reveal: false });
		open(terminals[0]);
		await port.spawn('run-h', plan(ECHO), meta('run-h'));
		await until('its output', () => screenOf(terminals[0]).includes('ready'));
		assert.strictEqual(port.hideTab('run-h'), true);
		assert.strictEqual(terminals[0].disposed, true);
		closed.fire(Object.assign(terminals[0], { exitStatus: { reason: EXIT_REASON.Extension, code: undefined } }));
		assert.deepStrictEqual([closes, port.hideTab('run-h')], [[], false], 'hidden: nothing to hide again, nothing closed');
		assert.strictEqual(await port.reveal('run-h', { preserveFocus: false }), true);
		assert.strictEqual(terminals.length, 2);
		open(terminals[1]);
		await until('its screen drawn again', () => screenOf(terminals[1]).includes('ready'));
		// Its tab, pinned: the person's close says so
		const tab = { input: new TabInputTerminal(), isActive: true, isPinned: true, group: { viewColumn: 1, tabs: [] as unknown[] } };
		activeTerminal = terminals[1];
		activeChanged.fire(terminals[1]);
		tabsChanged.fire({ opened: [tab], closed: [], changed: [] });
		closed.fire(Object.assign(terminals[1], { exitStatus: { reason: EXIT_REASON.User, code: undefined } }));
		assert.deepStrictEqual(closes, [{ run: 'run-h', marked: true }]);
	});

	test('removing a pair disposes its terminal at once - no close of the person\'s - ends a live process in the background and lets ptyd forget the run; removing it again does nothing', async () => {
		const port = portOf();
		const closes: RunId[] = [];
		port.onDidClosePair!(({ run }) => closes.push(run));
		port.openPair(facts('run-6'), { reveal: false });
		open(terminals[0]);
		const { pid } = await port.spawn('run-6', plan(ECHO), meta('run-6'));
		port.removePair('run-6');
		port.removePair('run-6');
		assert.strictEqual(terminals[0].disposed, true);
		closed.fire(Object.assign(terminals[0], { exitStatus: { reason: EXIT_REASON.Extension, code: undefined } }));
		assert.deepStrictEqual(closes, []);
		assert.strictEqual(await port.terminate('run-6'), 'terminated');
		const observer = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
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
		const observer = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
		extraClients.push(observer);
		await until('ptyd to end and forget it', async () => (await observer.request('list', { owner: 'workspace-1' })).length === 0);
	});

	test('details that change while a run starts are kept with its process: before its spawn was sent they go after it, after it they go at once on the same connection (ARCHITECTURE-2.3)', async () => {
		let entered!: () => void, open!: () => void;
		const reached = new Promise<void>(resolve => entered = resolve);
		spawnGate = { entered, open: new Promise<void>(resolve => open = resolve) };
		const port = portOf();
		port.openPair(facts('run-meta'), { reveal: false });
		const starting = port.spawn('run-meta', plan(ECHO), meta('run-meta'));
		port.setMeta('run-meta', { ...meta('run-meta'), name: 'before' });
		await reached;
		port.setMeta('run-meta', { ...meta('run-meta'), name: 'renamed' });
		open();
		await starting;
		const observer = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
		extraClients.push(observer);
		const held = await until('ptyd to keep the details', async () => (await observer.request('list', { owner: 'workspace-1' })).find(each => each.run === 'run-meta' && each.meta.name === 'renamed'));
		// The change before the spawn was sent went with it (its meta the latest then); the one after reached the run it named
		assert.deepStrictEqual([held.meta.name, requested.filter(method => method === 'spawn' || method === 'setMeta')], ['renamed', ['spawn', 'setMeta']]);
	});

	test('a change of a run\'s details while its start waits for ptyd\'s connection goes with its spawn, which carries the latest (ARCHITECTURE-2.3)', async () => {
		const port = portOf();
		port.openPair(facts('run-early'), { reveal: false });
		// An earlier change, made before the start was asked for, is older than the details the start carries
		port.setMeta('run-early', { ...meta('run-early'), name: 'stale' });
		const starting = port.spawn('run-early', plan(ECHO), meta('run-early'));
		// While its start waits for the connection: a change of its tab, its second line, its name
		port.setMeta('run-early', { ...meta('run-early'), name: 'early' });
		await starting;
		const observer = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
		extraClients.push(observer);
		const held = await until('ptyd to hold it', async () => (await observer.request('list', { owner: 'workspace-1' })).find(each => each.run === 'run-early'));
		assert.deepStrictEqual([held.meta.name, requested.filter(method => method === 'spawn' || method === 'setMeta')], ['early', ['spawn']]);
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
		const observer = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/unused', '/unused');
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
		await reloaded.attach(live[0], facts('run-8', { pinned: true }));
		assert.strictEqual(terminals.length, count, 'reattached with its tab hidden until its turn');
		let opened = false;
		const opening = reloaded.openPinned('run-8').then(() => { opened = true; });
		await until('the restored native terminal', () => terminals.length > count);
		const terminal = terminals[terminals.length - 1];
		assert.strictEqual(unspun(terminal.name), 'Ada', 'a restored background tab has only the agent name even before its pseudoterminal opens');
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(opened, false, 'the next pinned tab waits for this terminal to open');
		open(terminal);
		await opening;
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

	test('a run in the ptyd of an earlier protocol - its window reloaded into this build - is listed, shown and operated through that ptyd: its screen, what is typed, its close; a new agent starts in this window\'s own (ARCHITECTURE-2.4, RULES-4.1)', async function () {
		this.timeout(20_000);
		const protocol = EARLIER_PROTOCOLS[0];
		const earlier = await earlierWith('run-old');
		try {
			const port = portOf();
			const live = await port.live();
			assert.deepStrictEqual(live.map(run => [run.run, run.meta.name, run.claimedElsewhere]), [['run-old', 'Ada', false]]);
			await port.attach(live[0], facts('run-old'));
			const terminal = await openedAgain(port, 'run-old', 0);
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
			const own = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
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

	/**
	 * A ptyd of this same protocol but another build - at the name builds used before they named their ptyds, as 0.0.4's did, or at
	 * `build`'s own name, recorded as it records itself - holding `run` where one is given (ARCHITECTURE-2.4).
	 */
	const otherBuildWith = async (run: RunId | undefined, build?: string): Promise<{ readonly server: PtydServer; readonly socket: string }> => {
		const socket = ptydSocketPath(home, PTYD_PROTOCOL, build);
		const server = new PtydServer(socket, () => undefined);
		server.build = build;
		assert.strictEqual(await server.listen(), true);
		if (build) {
			recordPtyd(ptydRecords(path.join(home, 'ptyd')), { protocol: PTYD_PROTOCOL, build, socket, pid: process.pid });
		}
		if (run) {
			const before = (await PtydClient.join(socket, PTYD_PROTOCOL))!;
			await before.request('claim', nextOwnerClaim('workspace-1', home));
			await before.request('spawn', {
				run, owner: 'workspace-1', file: process.execPath, args: ['-e', ECHO], cwd: os.tmpdir(), env: programEnv(), cols: 80, rows: 24, meta: { ...meta(run) }
			});
			before.dispose();
		}
		return { server, socket };
	};

	for (const [kind, build] of [['named no build, as 0.0.4\'s', undefined], ['another build that recorded itself', 'abcdef0123']] as const) {
		test(`ARCHITECTURE-2.4: a run in a ptyd of this protocol and ${kind} is shown and operated there; a new agent starts in this window's own ptyd alone`, async function () {
			this.timeout(20_000);
			const other = await otherBuildWith('run-kept', build);
			try {
				const port = portOf();
				const live = await port.live();
				assert.deepStrictEqual(live.map(run => [run.run, run.claimedElsewhere]), [['run-kept', false]]);
				await port.attach(live[0], facts('run-kept'));
				const terminal = await openedAgain(port, 'run-kept', 0);
				await until('its screen', () => screenOf(terminal).includes('ready'));
				terminal.options.pty.handleInput!('kept');
				await until('its answer, through the other build\'s ptyd', () => screenOf(terminal).includes('got kept'));
				assert.ok((await port.readScreen('run-kept', 20)).lines.some(line => line.includes('got kept')), 'its screen is read there');
				port.openPair(facts('run-new'), { reveal: false });
				open(terminals[1]);
				await port.spawn('run-new', plan(ECHO), meta('run-new'));
				const own = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
				const old = (await PtydClient.join(other.socket, PTYD_PROTOCOL))!;
				extraClients.push(own, old);
				const runsOf = async (client: PtydClient) => (await client.request('list', { owner: 'workspace-1' })).map(run => run.run);
				assert.deepStrictEqual([await runsOf(own), await runsOf(old)], [['run-new'], ['run-kept']]);
				assert.strictEqual(await port.terminate('run-kept'), 'terminated');
				assert.deepStrictEqual(await runsOf(old), []);
			} finally {
				other.server.close();
			}
		});
	}

	test('ARCHITECTURE-2.4: a ptyd of another build that holds none of this window\'s runs is not held, a new agent starting in this window\'s own; a record nothing listens at any more is taken out', async () => {
		const other = await otherBuildWith(undefined, 'abcdef0123');
		const records = ptydRecords(path.join(home, 'ptyd'));
		const staleSocket = ptydSocketPath(home, PTYD_PROTOCOL, '0123abcdef');
		recordPtyd(records, { protocol: PTYD_PROTOCOL, build: '0123abcdef', socket: staleSocket, pid: 999_999 });
		try {
			const port = portOf();
			assert.deepStrictEqual(await port.live(), []);
			assert.deepStrictEqual((port as unknown as { session: { earlierHeld: readonly unknown[] } }).session.earlierHeld, [], 'no other ptyd is held');
			assert.ok(!recordedPtyds(records).some(record => record.socket === staleSocket), 'the stale record is taken out');
			assert.ok(recordedPtyds(records).some(record => record.socket === other.socket), 'a live one stays');
			port.openPair(facts('run-new'), { reveal: false });
			open(terminals[0]);
			await port.spawn('run-new', plan(ECHO), meta('run-new'));
			const own = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
			const old = (await PtydClient.join(other.socket, PTYD_PROTOCOL))!;
			extraClients.push(own, old);
			const runsOf = async (client: PtydClient) => (await client.request('list', {})).map(run => run.run);
			assert.deepStrictEqual([await runsOf(own), await runsOf(old)], [['run-new'], []]);
		} finally {
			other.server.close();
		}
	});

	test('ARCHITECTURE-2.4, LIFECYCLE-3.2: each listing of every workspace\'s runs asks every other ptyd anew: a conversation an older window starts in its ptyd after it listed none is never offered to start twice', async function () {
		this.timeout(20_000);
		const protocol = EARLIER_PROTOCOLS.at(-1)!;
		const older = new PtydServer(ptydSocketPath(home, protocol), () => undefined, undefined, protocol);
		assert.strictEqual(await older.listen(), true);
		const recorded = await otherBuildWith(undefined, 'abcdef0123');
		const connections = new Map<string, number>();
		for (const [name, other] of [['older', older], ['recorded', recorded.server]] as const) {
			connections.set(name, 0);
			(other as unknown as { readonly server: net.Server }).server.on('connection', () => connections.set(name, connections.get(name)! + 1));
		}
		const asked = async <T>(discover: () => Promise<T>): Promise<[T, string[]]> => {
			const before = new Map(connections);
			const found = await discover();
			return [found, [...connections].filter(([name, count]) => count > before.get(name)!).map(([name]) => name).sort()];
		};
		try {
			const port = portOf();
			// This window's own search of the other ptyds for its runs is over: none of them holds any
			assert.deepStrictEqual(await port.live(), []);
			assert.deepStrictEqual(await asked(() => port.conversations()), [[], ['older', 'recorded']]);
			// A window of the older build, still open, starts a conversation in its own ptyd
			const window = (await PtydClient.join(ptydSocketPath(home, protocol), protocol))!;
			extraClients.push(window);
			await window.request('claim', nextOwnerClaim('workspace-3', home));
			await window.request('spawn', {
				run: 'run-later', owner: 'workspace-3', file: process.execPath, args: ['-e', ECHO], cwd: os.tmpdir(), env: programEnv(), cols: 80, rows: 24,
				meta: { ...meta('run-later'), sessionId: 'started-later', cli: 'claude', environment: 'local' }
			});
			assert.deepStrictEqual(await asked(() => port.conversations()), [[{ sessionId: 'started-later', cli: 'claude', environment: 'local' }], ['older', 'recorded']]);
			const [ids, listed] = await asked(() => port.allRunIds());
			assert.ok(ids.includes('run-later'));
			assert.deepStrictEqual(listed, ['older', 'recorded']);
		} finally {
			older.close();
			recorded.server.close();
		}
	});

	test('the ptyd of an earlier protocol going takes the window\'s runs there with it: each is told ended, how not known, and its terminal says so - never left out (RULES-3.3, 4.1)', async function () {
		this.timeout(20_000);
		const earlier = await earlierWith('run-gone');
		try {
			const port = portOf();
			const exits: ExitReport[] = [];
			port.onDidExit(exit => exits.push(exit));
			const [live] = await port.live();
			await port.attach(live, facts('run-gone'));
			const terminal = await openedAgain(port, 'run-gone', 0);
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

	test('after its first restore, a run a ptyd lists that the window shows no pair of - its reattach failed, or its ptyd was found late - is told once a while, for the window to restore again (RULES-4.1)', async function () {
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

	test('a run of an earlier protocol\'s ptyd that could not be reached as the window reattached it is told as lost, and claimed again at a later check once it can be: never left reconnecting (RULES-3.1, 4.1)', async function () {
		this.timeout(20_000);
		const earlier = await earlierWith('run-late');
		try {
			const port = portOf();
			const reports: ActivityReport[] = [];
			port.onDidReport(report => reports.push(report));
			const [live] = await port.live();
			failEarlierClients = 1;
			await port.attach(live, facts('run-late'));
			const terminal = await openedAgain(port, 'run-late', 0);
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
		const own = await PtydClient.connect(ownPtydSocket(home, '/nonexistent/ptyd.js'), '/nonexistent/ptyd.js', path.join(home, 'unused.log'));
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
		// Past the window's reload, whose tabs open one over another
		await port.finishRestore();
		const activations: (RunId | undefined)[] = [];
		port.onDidActivate(run => activations.push(run));
		const group = { viewColumn: 1, tabs: [] as unknown[] };
		visibleGroups = [group];
		const file = { input: new TabInputText({ path: '/work/app/a.ts' }), isPinned: false, isActive: true, isPreview: false, label: 'a.ts', group };
		group.tabs.push(file);
		activeTab = file;
		port.openPair(facts('run-20'), { reveal: false });
		const tab = { input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada', group };
		group.tabs.push(tab);
		file.isActive = false;
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
		tab.isActive = false;
		tabsChanged.fire({ opened: [next], closed: [], changed: [] });
		assert.deepStrictEqual(terminals[0].shown, [false, true]);
		// One made in front is told at once, and covers nothing it shows again
		port.openPair(facts('run-22'), { reveal: true });
		tabsChanged.fire({ opened: [{ input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada', group }], closed: [], changed: [] });
		activeChanged.fire(terminals[2]);
		// The reveal made its group the active one, as the person's next command acts on the active group's front tab (LIFECYCLE-2.2)
		assert.deepStrictEqual([activations, commands, terminals[1].shown], [['run-20', 'run-22'], ['vscode.open', 'workbench.action.focusFirstEditorGroup'], []]);
	});

	test('closing a background pair before xterm opens cancels its focus restoration and ignores disposal callbacks', async () => {
		const port = portOf();
		const closes: RunId[] = [];
		const renames: { readonly run: RunId; readonly name: string }[] = [];
		port.onDidClosePair(({ run }) => closes.push(run));
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
		visibleGroups = [group];
		const file = { input: new TabInputText({ path: '/work/app/a.ts' }), isPinned: false, isActive: true, isPreview: false, label: 'a.ts', group };
		group.tabs.push(file);
		activeTab = file;
		port.openPair(facts('run-30'), { reveal: false });
		port.openPair(facts('run-31'), { reveal: false });
		terminals.forEach(open);
		const tabs = [{ input: new TabInputTerminal(), isPinned: false, isActive: false, label: 'Ada', group }, { input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada', group }];
		group.tabs.push(...tabs);
		file.isActive = false;
		tabsChanged.fire({ opened: tabs, closed: [], changed: [] });
		assert.deepStrictEqual(commands, ['vscode.open']);
	});

	test('a run\'s native tab is the one that opens as its terminal is created, or that becomes active with its terminal; a pair made behind it over that tab shows it again (LIFECYCLE-2.2)', async () => {
		const port = portOf();
		// Past the window's reload, whose tabs open one over another
		await port.finishRestore();
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
		tab12.isActive = false;
		tabsChanged.fire({ opened: [{ input: new TabInputTerminal(), isPinned: false, isActive: true, label: 'Ada' }], closed: [], changed: [] });
		assert.deepStrictEqual([terminals[1].shown, terminals[0].shown, commands], [[true], [], []]);
	});
});
