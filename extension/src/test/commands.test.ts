/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { CleanupResult, Location, RunChange, RunFacts } from '../core/ports';
import type { PanelState } from '../webview/protocol';
import { TestEmitter, withModules } from './withModules';

const LOCATION: Location = { id: 'loc-main', path: '/shop', uri: 'file:///shop', environment: 'local', label: 'main', folders: [{ index: 0, name: 'shop', uri: 'file:///shop', path: '/shop' }], kind: 'checkout', opened: true, git: 'ok', branch: 'main' };
const RUN = `run-${'3'.padStart(32, '0')}`;

/** The editor's Quick Pick as Continue Session drives it: what it shows, and whether it is up. */
class FakePick {
	title = '';
	placeholder = '';
	busy = false;
	value = '';
	matchOnDescription = false;
	matchOnDetail = false;
	items: readonly unknown[] = [];
	activeItems: readonly unknown[] = [];
	shown = false;
	private readonly hidden = new TestEmitter<void>();
	readonly onDidHide = this.hidden.event;
	readonly onDidAccept = new TestEmitter<void>().event;
	readonly onDidChangeValue = new TestEmitter<string>().event;
	readonly onDidChangeActive = new TestEmitter<readonly unknown[]>().event;
	readonly onDidTriggerItemButton = new TestEmitter<unknown>().event;
	show(): void { this.shown = true; }
	hide(): void {
		if (this.shown) {
			this.shown = false;
			this.hidden.fire();
		}
	}
	dispose(): void { /* nothing held */ }
}
const FACTS: RunFacts = {
	id: RUN, alias: '#a3', name: 'Ada Lovelace', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: LOCATION.id, cwd: '/shop', environment: 'local',
	yolo: true, createdAt: 1, lifecycle: 'running', phase: 'running', pid: 7, startedAt: 2, activity: 'working', reporting: true,
	root: RUN, origin: 'human', tools: 'not_injected'
};

suite('Commands: their targets and arguments (UX-3.1, 3.2, LIFECYCLE-2.1, 3.1)', () => {
	let handlers: Map<string, (arg?: unknown) => unknown>;
	let executed: unknown[][];
	let clipboard: string[];
	let errors: string[];
	let closed: string[];
	let dismissed: string[];
	let runs: Map<string, RunFacts>;
	let runsChanged: TestEmitter<RunChange>;
	let cleanup: CleanupResult | 'already_ended';
	let did: string[];
	let pinned: string[];
	let activate: TestEmitter<string | undefined>;
	/** The settings file saved, and how often the cards read their icons from it. */
	let settingsSaved: TestEmitter<void>;
	let iconReads: number;
	let disposables: { dispose(): void }[];
	/** What the locations' next read is; Quick Picks made; how many times the window's histories were opened. */
	let refreshing: Promise<void>;
	let pickers: FakePick[];
	let opened: number;
	let unpinned: string[];
	/** Pin and Unpin, in the order they were asked. */
	let order: string[];
	/** The panel's view provider, as the editor is given it, and what its page was posted. */
	let provider: { resolveWebviewView(view: unknown): void } | undefined;
	let posted: { readonly type: string;[key: string]: unknown }[];
	/** What is wrong with the settings file as a whole, as the CLIs read it. */
	let fileProblems: { readonly setting: string; readonly problem: string }[];
	const settle = () => new Promise(resolve => setImmediate(resolve));
	const run = (id: string, arg?: unknown) => handlers.get(id)!(arg);
	const openPanel = () => {
		const said = new TestEmitter<unknown>();
		provider!.resolveWebviewView({ visible: true, badge: undefined, description: undefined, onDidChangeVisibility: () => ({ dispose() { } }), onDidDispose: () => ({ dispose() { } }), show: () => undefined,
			webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (uri: { path: string }) => ({ toString: () => `webview:${uri.path}` }), onDidReceiveMessage: said.event, postMessage: async (message: { readonly type: string }) => { posted.push(message); return true; } } });
		return said;
	};

	setup(async () => {
		handlers = new Map(); executed = []; clipboard = []; errors = []; closed = []; dismissed = []; did = []; pinned = [];
		refreshing = Promise.resolve(); pickers = []; opened = 0; unpinned = []; order = []; provider = undefined; posted = [];
		cleanup = 'terminated';
		fileProblems = [];
		activate = new TestEmitter();
		const none = { dispose: () => undefined };
		const api = {
			Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }) },
			l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)])) },
			env: { language: 'en', remoteName: undefined, clipboard: { writeText: async (text: string) => void clipboard.push(text) } },
			commands: {
				registerCommand: (id: string, handler: (arg?: unknown) => unknown) => { handlers.set(id, handler); return none; },
				executeCommand: async (...args: unknown[]) => void executed.push(args)
			},
			window: {
				registerWebviewViewProvider: (_id: string, given: typeof provider) => { provider = given; return none; }, withProgress: async (_: unknown, task: () => Promise<unknown>) => task(),
				createQuickPick: () => { const pick = new FakePick(); pickers.push(pick); return pick; }
			},
			workspace: { onDidChangeConfiguration: () => none, getConfiguration: () => ({ get: () => undefined }) },
			ThemeIcon: class { constructor(readonly id: string) { } }
		};
		const { registerUi } = withModules({ vscode: api })<typeof import('../ui/commands/index')>(require.resolve('../ui/commands/index'));
		const changes = new TestEmitter<never>();
		runsChanged = new TestEmitter<RunChange>();
		settingsSaved = new TestEmitter<void>();
		iconReads = 0;
		runs = new Map([[RUN, FACTS]]);
		const close = async (id: string) => { closed.push(id); runs.delete(id); return cleanup; };
		disposables = registerUi({
			agents: {
				requested: () => undefined, started: async () => ({ state: 'running' }), warmedUp: async () => undefined, list: () => [...runs.values()], get: id => runs.get(id), onDidChange: runsChanged.event, resume: () => '', holding: () => undefined, refreshConversations: async () => {}, pin: id => { pinned.push(id); order.push(`pin ${id}`); }, unpin: id => { unpinned.push(id); order.push(`unpin ${id}`); }, pins: () => [], reorderPins: () => {}, restorePins: async () => {},
			launch: () => RUN,
				stop: close, dismiss: async id => { dismissed.push(id); runs.delete(id); }, close, rename: () => undefined
			},
			worktrees: { availability: async () => ({ available: false, reason: 'none' }), plan: async () => { throw new Error('none'); }, create: async () => { throw new Error('none'); }, remove: async () => { throw new Error('none'); } },
			conversations: { open: () => { opened++; return { next: async () => ({ entries: [], done: true }), dispose: () => undefined }; } },
			savedName: () => undefined,
			locations: {
				snapshot: () => ({ locations: [LOCATION], folders: LOCATION.folders, pending: false }), resolve: id => id === LOCATION.id ? LOCATION : undefined,
				refresh: () => refreshing, onDidChange: changes.event, onDidRemove: changes.event, removalOf: () => undefined
			},
			clis: { list: async () => ({ clis: [], problems: [] }), problems: () => fileProblems },
			history: { last: () => ({}), remember: () => undefined },
			execution: { reveal: async id => { did.push(`reveal ${id}`); return true; }, tabOpen: () => true, onDidActivate: activate.event },
			workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] } as never,
			extensionUri: { path: '/extension' } as never,
			log: { event: () => undefined },
			notifyError: text => errors.push(text),
			openSettings: async () => { did.push('open settings'); },
			icons: () => { iconReads++; return () => 'claude'; },
			settingsChanged: settingsSaved.event,
			ready: Promise.resolve()
		});
		await settle();
	});

	teardown(() => disposables.forEach(each => each.dispose()));

	test('CONFIGURATION-2.4: the settings file saved, the cards are drawn again and read their icons from it; nothing else draws them meanwhile', async () => {
		const before = iconReads;
		await settle();
		assert.strictEqual(iconReads, before, 'nothing draws the cards while nothing changes');
		settingsSaved.fire();
		await settle();
		assert.ok(iconReads > before, 'the save draws the cards again');
	});

	test('UX-3.1: from the Command Palette a command is about the selected run, kept as a file comes in front; a context-only command is about the card it was opened on alone', async () => {
		await run('facade.pinAgent');
		const nothingSelected = [...pinned];
		activate.fire(RUN);
		await settle();
		await run('facade.pinAgent');
		activate.fire(undefined);
		await settle();
		// The card stays selected as a file comes in front, and the palette's command is still about it
		await run('facade.pinAgent');
		run('facade.moveUp');
		assert.deepStrictEqual([nothingSelected, pinned], [[], [RUN, RUN]]);
	});

	test('LIFECYCLE-3.4: a Pin the person asks for - from its card, the Command Palette or a key - shows its tab as a click on the card does, its mark going on there', async () => {
		activate.fire(RUN);
		await settle();
		await run('facade.pinAgent');
		assert.deepStrictEqual([pinned, did], [[RUN], [`reveal ${RUN}`]]);
		await run('facade.pinAgent', { webview: 'facade.agents', webviewSection: 'agent', run_id: RUN, preventDefaultContextMenuItems: true });
		assert.deepStrictEqual([pinned, did], [[RUN, RUN], [`reveal ${RUN}`, `reveal ${RUN}`]]);
	});

	test('LIFECYCLE-3.4: a Pin of an agent with no tab open opens its tab; an Unpin of one keeps it hidden; a Pin that cannot be saved opens nothing', () => {
		const shown: string[] = [];
		const hidden: RunFacts = { ...FACTS, tab: 'hidden' };
		const state = { pinned: false };
		const agents = { get: () => hidden, pin: () => { state.pinned = true; }, unpin: () => { state.pinned = false; } };
		const vscode = { l10n: { t: (text: string) => text } };
		const { AgentActions } = withModules({ vscode })<typeof import('../ui/commands/agent')>(require.resolve('../ui/commands/agent'));
		const actions = new AgentActions({ agents: agents as never, model: { select: () => undefined } as never,
			execution: { reveal: async (run: string) => { shown.push(run); return true; }, tabOpen: () => false } as never, notifyError: () => undefined });
		// Its tab opens, as its Pin keeps it in the editor
		actions.pin(RUN, true);
		assert.deepStrictEqual([state.pinned, shown], [true, [RUN]]);
		// Unpinned: nothing opens for it
		actions.pin(RUN, false);
		assert.deepStrictEqual([state.pinned, shown], [false, [RUN]]);
		// An Unpin of one whose record names a group but whose tab is not open now - a pinned agent's before its turn, an uncertain
		// run's card - opens nothing either; one whose tab is open is shown, as the card's click shows it
		const placed: RunFacts = { ...FACTS, tab: { column: 1 } };
		let open = false;
		const waiting = new AgentActions({ agents: { get: () => placed, unpin: () => undefined } as never, model: { select: () => undefined } as never,
			execution: { reveal: async (run: string) => { shown.push(run); return true; }, tabOpen: () => open } as never, notifyError: () => undefined });
		waiting.pin(RUN, false);
		assert.deepStrictEqual(shown, [RUN]);
		open = true;
		waiting.pin(RUN, false);
		assert.deepStrictEqual(shown, [RUN, RUN]);
		shown.length = 1;
		// A Pin that cannot be saved opens nothing
		const refusing = new AgentActions({ agents: { get: () => hidden, pin: () => { throw new Error('disk full'); } } as never, model: { select: () => undefined } as never,
			execution: { reveal: async (run: string) => { shown.push(run); return true; }, tabOpen: () => false } as never, notifyError: () => undefined });
		refusing.pin(RUN, true);
		assert.deepStrictEqual(shown, [RUN]);
	});

	test('PANEL-2.2, 4.2: a card\'s menu names its exact run, including same-numbered agents on two machines', async () => {
		await run('facade.pinAgent', { run_id: `run-${'9'.padStart(32, '0')}` });
		await run('facade.pinAgent', { webview: 'facade.agents', webviewSection: 'agent', run_id: RUN, preventDefaultContextMenuItems: true });
		assert.deepStrictEqual(pinned, [RUN]);
		for (const bad of [{ run: RUN }, { run_id: 3 }, 'run', null]) {
			assert.throws(() => run('facade.stopAgent', bad), /run_id/, JSON.stringify(bad));
			assert.throws(() => run('facade.dismissAgent', bad), /run_id/, JSON.stringify(bad));
		}
		assert.throws(() => run('facade.revealAgent'), /run_id/);

		const registered = new Map<string, (arg?: unknown) => unknown>();
		const done: unknown[][] = [];
		const renames: unknown[] = [];
		const local = { ...FACTS, id: 'workstation/a3', alias: 'a3', address: 'a3@workstation', pinnable: true };
		const remote = { ...FACTS, id: 'devbox/a3', alias: 'a3', address: 'a3@0f12abcd', lifecycle: 'ended', pin: 'pin-remote' } satisfies RunFacts;
		const entries = new Map<string, RunFacts>([[local.id, local], [remote.id, remote]]);
		const api = {
			commands: { registerCommand: (id: string, handler: (arg?: unknown) => unknown) => {
				registered.set(id, handler);
				return { dispose: () => registered.delete(id) };
			} },
			l10n: { t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)])) },
			env: { clipboard: { writeText: async (text: string) => { done.push(['copy', text]); } } }
		};
		const { AgentActions, registerRustAgentCommands } = withModules({ vscode: api, '../pickers/stepping': {
			Flow: class { async text(options: unknown) { renames.push(options); return '  New name  '; } close() { } }
		} })<typeof import('../ui/commands/agent')>(require.resolve('../ui/commands/agent'));
		const registration = registerRustAgentCommands({
			agents: { get: id => entries.get(id) },
			model: { selectedAgent: () => ({ run: local.id, ended: false }) } as never,
			actions: {
				open: async id => { done.push(['open', id]); return true; },
				hide: async id => { done.push(['hide', id]); },
				stop: async id => { done.push(['stop', id]); },
				remove: async id => { done.push(['remove', id]); },
				setPinned: async (id, value) => { done.push(['pin', id, value]); },
				rename: async (id, name) => { done.push(['rename', id, name]); }
			},
			goToAgent: async () => { done.push(['go']); },
			notifyError: text => assert.fail(text)
		});
		const card = { webview: 'facade.agents', webviewSection: 'agent', run_id: remote.id, preventDefaultContextMenuItems: true };
		const invoke = (name: string, target?: unknown) => registered.get(`facade.${name}`)!(target);
		assert.strictEqual(await invoke('openTerminal', card), false);
		await invoke('stopAgent', card);
		await invoke('pinAgent', card);
		await invoke('hideAgent', { run_id: 'gone' });
		await assert.rejects(async () => invoke('deleteAgent', { run: remote.id }), /run_id/);
		assert.strictEqual(done.length, 0);
		assert.strictEqual(await invoke('openTerminal'), true);
		await invoke('hideAgent', card);
		await invoke('stopAgent');
		await invoke('deleteAgent', card);
		await invoke('pinAgent');
		await invoke('unpinAgent', card);
		await invoke('renameAgent', card);
		await invoke('copyAgentReference', card);
		await invoke('goToAgent');
		entries.set(remote.id, { ...remote, address: undefined, name: '' });
		await invoke('renameAgent', card);
		const legacy = new AgentActions({
			agents: { get: () => FACTS, rename: (id: string, name: string) => { done.push(['rename', id, name]); } } as never,
			model: {} as never, execution: {} as never, notifyError: text => assert.fail(text)
		});
		await legacy.rename(RUN);
		assert.deepStrictEqual(done, [
			['open', local.id], ['hide', remote.id], ['stop', local.id], ['remove', remote.id],
			['pin', local.id, true], ['pin', remote.id, false], ['rename', remote.id, 'New name'], ['copy', remote.address], ['go'],
			['rename', remote.id, 'New name'], ['rename', RUN, 'New name']
		]);
		assert.deepStrictEqual(renames, [
			{ title: 'Rename Agent', value: remote.name, placeholder: 'Leave blank to choose a name automatically', prompt: 'Rename a3@0f12abcd' },
			{ title: 'Rename Agent', value: '', placeholder: 'Leave blank to choose a name automatically' },
			{ title: 'Rename Agent', value: FACTS.name, placeholder: 'Leave blank for an unused name, or its ID', prompt: 'Rename @Ada Lovelace #a3' }
		]);
		assert.deepStrictEqual(['dismissAgent', 'moveUp', 'moveDown'].map(name => registered.has(`facade.${name}`)), [false, false, false]);
		registration.forEach(each => each.dispose());
	});

	test('LIFECYCLE-3.1: Stop Agent stops the exact run and tells the initiator about failures and unknown results', async () => {
		cleanup = 'failed';
		await run('facade.stopAgent', { run_id: RUN });
		assert.deepStrictEqual([closed, errors], [[RUN], ["Ada Lovelace's card and terminal were closed, but its process could not be stopped."]]);

		cleanup = 'unconfirmed';
		runs.set(RUN, FACTS);
		await run('facade.stopAgent', { run_id: RUN });
		assert.deepStrictEqual([closed, errors[1]], [[RUN, RUN], 'Could not stop Ada Lovelace: Stop unconfirmed · check process']);
	});

	test('LIFECYCLE-3.1: Dismiss Agent rechecks the exact card and accepts only a confirmed end', async () => {
		const target = { run_id: RUN };
		await run('facade.dismissAgent', target);
		runs.set(RUN, { ...FACTS, lifecycle: 'ended', endUnconfirmed: true });
		await run('facade.dismissAgent', target);
		assert.deepStrictEqual(dismissed, []);
		runs.set(RUN, { ...FACTS, lifecycle: 'ended' });
		await run('facade.dismissAgent', { run_id: 'gone' });
		await run('facade.dismissAgent', target);
		assert.deepStrictEqual([closed, dismissed], [[], [RUN]]);
	});

	test('LIFECYCLE-2.1: Go to Agent\'s copy button copies `@name #aN`, and `#aN` alone for an agent with an empty name', async () => {
		const copied: string[] = [];
		const vscode = { env: { clipboard: { writeText: async (text: string) => void copied.push(text) } } };
		const { AgentActions } = withModules({ vscode })<typeof import('../ui/commands/agent')>(require.resolve('../ui/commands/agent'));
		const unnamed: RunFacts = { ...FACTS, id: `run-${'4'.padStart(32, '0')}`, alias: '#a4', name: '' };
		const runs = new Map([[RUN, FACTS], [unnamed.id, unnamed]]);
		const actions = new AgentActions({ agents: { get: (id: string) => runs.get(id) } as never, model: {} as never, execution: {} as never, notifyError: () => undefined });
		await actions.copyReference(RUN);
		await actions.copyReference(unnamed.id);
		assert.deepStrictEqual(copied, ['@Ada Lovelace #a3', '#a4']);
	});

	test('UX-2.4: a Pin, Unpin, Stop or Dismiss refused for Facade\'s own reason says it in the person\'s words; one whose agent went meanwhile says nothing, and no run\'s ID', async () => {
		const notified: string[] = [];
		const vscode = { l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)])) } };
		const load = withModules({ vscode });
		const { AgentActions } = load<typeof import('../ui/commands/agent')>(require.resolve('../ui/commands/agent'));
		const { FacadeError, OWNERSHIP_LOST } = load<typeof import('../core/errors')>(require.resolve('../core/errors'));
		let refusal: Error = new FacadeError('INVALID', 'ownership_lost', 'Another window owns this workspace.', OWNERSHIP_LOST);
		const refuse = () => { throw refusal; };
		let facts = FACTS;
		const agents = { get: () => facts, pin: refuse, unpin: refuse, stop: async () => refuse(), dismiss: async () => refuse() };
		const actions = new AgentActions({ agents: agents as never, model: {} as never, execution: {} as never, notifyError: text => notified.push(text) });
		actions.pin(RUN, true);
		actions.pin(RUN, false);
		await actions.stop(RUN);
		facts = { ...FACTS, lifecycle: 'ended' };
		await actions.dismiss(RUN);
		refusal = new FacadeError('INVALID', 'unsupported', 'Ada Lovelace\'s CLI cannot resume this exact session, so it cannot be pinned.', { kind: 'pin_unsupported', values: [] });
		actions.pin(RUN, true);
		refusal = new FacadeError('NOT_FOUND', 'not_found', `No agent ${RUN} in this window.`);
		actions.pin(RUN, true);
		const owned = 'This workspace is owned by another window. Reload this window to take ownership.';
		const { reasonOf } = load<typeof import('../ui/presentation')>(require.resolve('../ui/presentation'));
		const { PlanError } = load<typeof import('../core/ports')>(require.resolve('../core/ports'));
		assert.deepStrictEqual([reasonOf(new PlanError('No CLI "gone" is configured; the built-ins are claude.', 'not_found', { kind: 'cli_not_configured', values: ['"gone"', '~/.facade/facade.json'] })), reasonOf(new Error('EACCES: permission denied'))],
			['No CLI "gone" is configured; add it to clis in ~/.facade/facade.json.', 'EACCES: permission denied'], 'a system error keeps its own words');
		assert.deepStrictEqual(notified, [
			`Could not pin Ada Lovelace: ${owned}`, `Could not unpin Ada Lovelace: ${owned}`, `Could not stop Ada Lovelace: ${owned}`, `Could not dismiss Ada Lovelace: ${owned}`,
			'Could not pin Ada Lovelace: Its CLI cannot resume this exact session, so it cannot be pinned.'
		]);
	});

	test('UX-3.1, PANEL-1.5: Show Agent Details from the Command Palette opens the selected card\'s details, the view focused first; with no card selected it does nothing', async () => {
		const said = openPanel();
		said.fire({ type: 'ready', page: '0'.repeat(31) + '1', reducedMotion: false });
		await settle();
		const focused = () => executed.filter(args => args[0] === 'facade.agents.focus').length;
		const details = () => posted.filter(message => message.type === 'details').map(message => message.run);
		await run('facade.showAgentDetails');
		const none = [focused(), details()];
		activate.fire(RUN);
		await settle();
		await run('facade.showAgentDetails');
		assert.deepStrictEqual([none, focused(), details()], [[0, []], 1, [RUN]]);
	});

	test('PANEL-1.3, 3.1: the card\'s Pin button\'s pin and unpin reach Pin and Unpin of its own run; a run gone answers gone, with nothing done', async () => {
		const said = openPanel();
		const page = '0'.repeat(31) + '1';
		said.fire({ type: 'ready', page, reducedMotion: false });
		await settle();
		for (const [what, target] of [['pin', RUN], ['unpin', RUN], ['pin', 'run-gone'], ['unpin', 'run-gone']]) {
			said.fire({ type: 'act', page, action: `${what}-${target}`, what, target });
			await settle();
		}
		const outcomes = posted.filter(message => message.type === 'outcome').map(message => [message.action, message.reason ?? 'ok']);
		assert.deepStrictEqual([order, outcomes], [[`pin ${RUN}`, `unpin ${RUN}`], [[`pin-${RUN}`, 'ok'], [`unpin-${RUN}`, 'ok'], ['pin-run-gone', 'gone'], ['unpin-run-gone', 'gone']]]);
	});

	test('PANEL-1.4: production card copy follows tool connection, CLI state and the source of input', async () => {
		const noState = { activity: 'unknown', reporting: false } as const;
		const waiting = { ...noState, notReady: true } as const;
		const unavailable = { tools: 'unavailable' } as const;
		const cases: [Partial<RunFacts>, string][] = [
			[{ tools: 'connecting', notReady: true }, 'Facade tools not connected yet'],
			[{ ...unavailable, toolsProblem: 'disconnected' }, 'Facade tools disconnected'],
			[{ ...unavailable, toolsProblem: 'cmd' }, 'Facade tools unavailable · replace .cmd with CLI in facade.json'],
			[{ ...unavailable, toolsProblem: 'conflict', toolsFile: 'SKILL.md' }, 'Facade tools unavailable · move or rename SKILL.md'],
			[{ ...unavailable, toolsProblem: 'variable', toolsFile: 'OPENCODE_CONFIG_CONTENT' }, 'Facade tools unavailable · OPENCODE_CONFIG_CONTENT unreadable'],
			[{ ...unavailable, toolsProblem: 'files' }, 'Facade tools unavailable · file creation failed'],
			[{ ...waiting, activityUnknown: 'waiting' }, 'No initial state · check terminal'],
			[{ ...waiting, activityUnknown: 'not_reporting' }, 'No state from CLI · check terminal'],
			[{ ...waiting, activityUnknown: 'cleared' }, 'State cleared · check terminal'],
			[{ ...waiting, activityUnknown: 'screen_unrecognized' }, 'State unrecognized · check terminal'],
			[{ ...waiting, activityUnknown: 'screen_reset' }, 'State reset · check terminal'],
		];
		runs.set(RUN, { ...FACTS, ...noState, said: 'Check the log' });
		runsChanged.fire({ run: RUN, kind: 'lifecycle' });
		const expected = new Map(cases.map(([facts, line], index) => {
			const id = `run-${String(index + 10).padStart(32, '0')}`;
			runs.set(id, { ...FACTS, id, alias: `#a${index + 10}`, ...facts });
			runsChanged.fire({ run: id, kind: 'added' });
			return [id, line];
		}));
		await settle();
		openPanel().fire({ type: 'ready', page: '0'.repeat(31) + '1', reducedMotion: false });
		await settle();
		const { cards } = posted.filter(message => message.type === 'state').at(-1)!.state as PanelState;
		for (const [id, line] of expected) {
			const card = cards.find(each => each.runId === id);
			assert.deepStrictEqual([card?.line, card?.stateText], [line, line], id);
		}
		const own = cards.find(each => each.runId === RUN)!;
		assert.deepStrictEqual([own.line, own.stateText], ['🧑‍💻 Check the log', 'State unavailable · check terminal']);
		assert.match(own.label, /Last input: Check the log$/);
		assert.doesNotMatch(own.label, /Facade tools/, 'a CLI without tool injection reports no tool problem');
	});

	test('notification navigation reveals the exact run and selects its card (UX-3.2)', async () => {
		assert.deepStrictEqual([await run('facade.revealAgent', { run_id: RUN }), await run('facade.revealAgent', { run_id: `run-${'8'.padStart(32, '0')}` }), did], [true, false, [`reveal ${RUN}`]]);
	});

	test('UX-1.1, LIFECYCLE-3.2: Continue Session shows its picker at once, busy, while the window\'s locations are read again; the histories open after, never before', async () => {
		let finish!: () => void;
		refreshing = new Promise<void>(resolve => { finish = resolve; });
		const done = run('facade.continueSession') as Promise<void>;
		await settle();
		const reading = [pickers.length, pickers[0]?.shown, pickers[0]?.busy, opened];
		finish();
		await settle();
		await settle();
		const read = [opened, pickers[0].busy, pickers[0].placeholder];
		pickers[0].hide();
		await done;
		assert.deepStrictEqual([reading, read, errors], [[1, true, true, 0], [1, false, 'No saved sessions in this window\'s folders'], []]);
	});

	test('CONFIGURATION-4.1: Continue Session says a settings file wrong as a whole, as the CLIs read it, and opens no history', async () => {
		fileProblems = [{ setting: '~/.facade/facade.json', problem: '~/.facade/facade.json:1:1: Expected a JSON object' }];
		const done = run('facade.continueSession') as Promise<void>;
		await settle();
		await settle();
		const shown = [(pickers[0].items as { readonly label: string; readonly detail?: string }[]).map(item => [item.label, item.detail]), opened];
		pickers[0].hide();
		await done;
		assert.deepStrictEqual(shown, [[['~/.facade/facade.json', '~/.facade/facade.json:1:1: Expected a JSON object']], 0]);
	});

	test('CONFIGURATION-1.2, UX-1.3: Open Settings opens the editor\'s Settings at Facade Code\'s section, the host\'s to show, and runs no editor command of its own', async () => {
		await run('facade.openSettings');
		assert.deepStrictEqual([did.filter(each => each === 'open settings'), executed.filter(([command]) => command !== 'setContext')], [['open settings'], []]);
	});

	test('the working-location commands, Refresh and New Agent Here are gone in this step: none is registered', () => {
		const gone = ['facade.customize', 'facade.openInNewWindow', 'facade.revealInFinder', 'facade.revealInOS', 'facade.openContainingFolder', 'facade.revealRemote', 'facade.copyPath', 'facade.openTerminalHere', 'facade.refresh', 'facade.newAgentHere'];
		assert.deepStrictEqual(gone.filter(id => handlers.has(id)), []);
	});
});
