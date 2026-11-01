/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { CleanupResult, Location, RunFacts } from '../core/ports';
import { TestEmitter, withModules } from './withModules';

const LOCATION: Location = { id: 'loc-main', path: '/shop', uri: 'file:///shop', environment: 'local', label: 'main', folders: [{ index: 0, name: 'shop', uri: 'file:///shop', path: '/shop' }], kind: 'checkout', opened: true, git: 'ok', branch: 'main' };
const RUN = `run-${'3'.padStart(32, '0')}`;

/** The editor's Quick Pick as Resume Agent drives it: what it shows, and whether it is up. */
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
	let cleanup: CleanupResult | 'already_ended';
	let did: string[];
	let activate: TestEmitter<string | undefined>;
	let disposables: { dispose(): void }[];
	/** What the locations' next read is; Quick Picks made; how many times the window's histories were opened. */
	let refreshing: Promise<void>;
	let pickers: FakePick[];
	let opened: number;
	const settle = () => new Promise(resolve => setImmediate(resolve));
	const run = (id: string, arg?: unknown) => handlers.get(id)!(arg);

	setup(async () => {
		handlers = new Map(); executed = []; clipboard = []; errors = []; closed = []; did = [];
		refreshing = Promise.resolve(); pickers = []; opened = 0;
		cleanup = 'terminated';
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
				registerWebviewViewProvider: () => none, withProgress: async (_: unknown, task: () => Promise<unknown>) => task(),
				createQuickPick: () => { const pick = new FakePick(); pickers.push(pick); return pick; }
			},
			workspace: { onDidChangeConfiguration: () => none, getConfiguration: () => ({ get: () => undefined }) },
			ThemeIcon: class { constructor(readonly id: string) { } }
		};
		const { registerUi } = withModules({ vscode: api })<typeof import('../ui/commands/index')>(require.resolve('../ui/commands/index'));
		const changes = new TestEmitter<never>();
		const runs = new Map([[RUN, FACTS]]);
		disposables = registerUi({
			agents: {
				requested: () => undefined, started: async () => ({ state: 'running' }), warmedUp: async () => undefined, list: () => [...runs.values()], get: id => runs.get(id), onDidChange: changes.event, resume: () => '', holding: () => undefined, refreshConversations: async () => {}, pin: () => {}, unpin: () => {}, pins: () => [], reorderPins: () => {}, restorePins: async () => {},
			launch: () => RUN,
				close: async id => { closed.push(id); runs.delete(id); return cleanup; }, rename: () => undefined
			},
			worktrees: { availability: async () => ({ available: false, reason: 'none' }), plan: async () => { throw new Error('none'); }, create: async () => { throw new Error('none'); }, remove: async () => { throw new Error('none'); } },
			conversations: { open: () => { opened++; return { next: async () => ({ entries: [], done: true }), dispose: () => undefined }; } },
			locations: {
				snapshot: () => ({ locations: [LOCATION], folders: LOCATION.folders, pending: false }), resolve: id => id === LOCATION.id ? LOCATION : undefined,
				refresh: () => refreshing, onDidChange: changes.event, onDidRemove: changes.event, removalOf: () => undefined
			},
			clis: { list: async () => ({ clis: [], problems: [] }) },
			history: { last: () => ({}), remember: () => undefined },
			execution: { reveal: async id => { did.push(`reveal ${id}`); return true; }, onDidActivate: activate.event },
			workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] } as never,
			extensionUri: { path: '/extension' } as never,
			log: { event: () => undefined },
			notifyError: text => errors.push(text),
			ready: Promise.resolve()
		});
		await settle();
	});

	teardown(() => disposables.forEach(each => each.dispose()));

	test('UX-3.1: from the Command Palette a command is about the selected run, kept as a file comes in front; a context-only command is about the card it was opened on alone', async () => {
		await run('facade.copyAgentReference');
		const nothingSelected = [...clipboard];
		activate.fire(RUN);
		await settle();
		await run('facade.copyAgentReference');
		activate.fire(undefined);
		await settle();
		// The card stays selected as a file comes in front, and the palette's command is still about it
		await run('facade.copyAgentReference');
		run('facade.moveUp');
		assert.deepStrictEqual([nothingSelected, clipboard], [[], ['@Ada Lovelace #a3', '@Ada Lovelace #a3']]);
	});

	test('a card\'s menu names its run: a run gone does nothing; another shape fails without a guess', async () => {
		await run('facade.copyAgentReference', { run_id: `run-${'9'.padStart(32, '0')}` });
		await run('facade.copyAgentReference', { webview: 'facade.agents', webviewSection: 'agent', run_id: RUN, preventDefaultContextMenuItems: true });
		assert.deepStrictEqual(clipboard, ['@Ada Lovelace #a3']);
		for (const bad of [{ run: RUN }, { run_id: 3 }, 'run', null]) {
			assert.throws(() => run('facade.closeAgent', bad), /run_id/, JSON.stringify(bad));
		}
		assert.throws(() => run('facade.revealAgent'), /run_id/);
	});

	test('LIFECYCLE-3.1: Close Agent closes the exact run; a process that could not be ended is said to the person who asked, an unconfirmed one is not claimed ended', async () => {
		cleanup = 'failed';
		await run('facade.closeAgent', { run_id: RUN });
		assert.deepStrictEqual([closed, errors], [[RUN], ['Ada Lovelace was closed, but its process could not be terminated.']]);
	});

	test('notification navigation reveals the exact run and selects its card (UX-3.2)', async () => {
		assert.deepStrictEqual([await run('facade.revealAgent', { run_id: RUN }), await run('facade.revealAgent', { run_id: `run-${'8'.padStart(32, '0')}` }), did], [true, false, [`reveal ${RUN}`]]);
	});

	test('UX-1.1, LIFECYCLE-3.2: Resume Agent shows its picker at once, busy, while the window\'s locations are read again; the histories open after, never before', async () => {
		let finish!: () => void;
		refreshing = new Promise<void>(resolve => { finish = resolve; });
		const done = run('facade.history') as Promise<void>;
		await settle();
		const reading = [pickers.length, pickers[0]?.shown, pickers[0]?.busy, opened];
		finish();
		await settle();
		await settle();
		const read = [opened, pickers[0].busy, pickers[0].placeholder];
		pickers[0].hide();
		await done;
		assert.deepStrictEqual([reading, read, errors], [[1, true, true, 0], [1, false, 'No saved conversations in this window\'s folders'], []]);
	});

	test('CLIS-1.1, UX-1.3: Configure Agents... opens the editor\'s Settings showing this extension\'s settings alone', async () => {
		await run('facade.configureAgents');
		assert.deepStrictEqual(executed.filter(([command]) => command !== 'setContext'), [['workbench.action.openSettings', '@ext:facade.facadecode']]);
	});

	test('the working-location commands, Refresh and New Agent Here are gone in this step: none is registered', () => {
		const gone = ['facade.customize', 'facade.openInNewWindow', 'facade.revealInFinder', 'facade.revealInOS', 'facade.openContainingFolder', 'facade.revealRemote', 'facade.copyPath', 'facade.openTerminalHere', 'facade.refresh', 'facade.newAgentHere'];
		assert.deepStrictEqual(gone.filter(id => handlers.has(id)), []);
	});
});
