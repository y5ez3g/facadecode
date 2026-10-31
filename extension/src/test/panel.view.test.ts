/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { PanelActions, PanelView } from '../ui/panel';
import type { SelectedAgent } from '../ui/model';
import type { PanelState } from '../webview/protocol';
import { TestEmitter, withModules } from './withModules';

/** The panel's view and its webview's page, with no editor behind them: what the extension posts, and what the page says to it. */
suite('The panel\'s view: what it takes from its webview, and which page it answers (PANEL-1.1, 3.1, 3.2)', () => {
	const none = { dispose: () => undefined };
	let posted: { readonly type: string;[key: string]: unknown }[];
	let acts: [string, string | undefined][];
	let contexts: Record<string, unknown>;
	let progress: number;
	let logged: string[];
	let state: PanelState;
	/** The editor's settings as the panel reads them, and their changes. */
	let settings: Record<string, unknown>;
	let configChanged: TestEmitter<{ affectsConfiguration(section: string): boolean }>;
	let front: SelectedAgent | undefined;
	let changed: TestEmitter<PanelState>;
	let said: TestEmitter<unknown>;
	let visibility: TestEmitter<void>;
	let view: { visible: boolean; badge: unknown; description: string | undefined; webview: { options: unknown; html: string } };
	/** What the actions answer next: a promise the test settles, where it holds the answer back. */
	let answer: () => Promise<'gone' | 'failed' | undefined>;
	let panel: PanelView;

	const page = (n: number) => n.toString(16).padStart(32, '0');
	const settle = () => new Promise(resolve => setTimeout(resolve, 0));
	const say = async (message: unknown) => {
		said.fire(message);
		await settle();
	};
	const states = () => posted.filter(message => message.type === 'state') as unknown as { readonly page: string; readonly state: PanelState }[];
	const stateOf = (revision: number, more: Partial<PanelState> = {}): PanelState => ({ revision, loading: false, cards: [], cardCount: 2, capabilities: { remote: false }, ...more });
	const update = async (next: PanelState) => {
		state = next;
		changed.fire(next);
		await settle();
	};

	/** The panel's view as the extension makes it, its build's test mode as `testMode` says, its webview resolved. */
	const make = (testMode = false) => {
		const api = {
			Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }) },
			l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)])) },
			env: { language: 'en' },
			commands: { executeCommand: async (command: string, key: string, value: unknown) => { if (command === 'setContext') { contexts[key] = value; } } },
			window: { withProgress: async () => void progress++ },
			workspace: {
				onDidChangeConfiguration: configChanged.event,
				getConfiguration: () => ({ get: (key: string) => settings[key] })
			}
		};
		(globalThis as { FACADE_TEST_MODE?: boolean }).FACADE_TEST_MODE = testMode;
		const { PanelView: View } = withModules({ vscode: api })<typeof import('../ui/panel')>(require.resolve('../ui/panel'));
		const model = { onDidChange: changed.event, state: () => state, selectedAgent: () => front };
		const actions: PanelActions = async (what, target) => {
			acts.push([what, target]);
			return answer();
		};
		panel = new View({ path: '/extension' } as never, model as never, actions, { event: message => logged.push(message) });
		view = {
			visible: true,
			badge: undefined,
			description: undefined,
			webview: {
				options: {},
				html: '',
				cspSource: 'vscode-resource:',
				asWebviewUri: (uri: { path: string }) => ({ toString: () => `webview:${uri.path}` }),
				onDidReceiveMessage: said.event,
				postMessage: async (message: { readonly type: string }) => {
					posted.push(message);
					return true;
				}
			},
			onDidChangeVisibility: visibility.event,
			onDidDispose: () => none,
			show: () => undefined
		} as never;
		panel.resolveWebviewView(view as never);
	};

	setup(() => {
		posted = []; acts = []; contexts = {}; progress = 0; logged = [];
		settings = {};
		configChanged = new TestEmitter();
		state = stateOf(1);
		front = undefined;
		changed = new TestEmitter();
		said = new TestEmitter();
		visibility = new TestEmitter();
		answer = async () => undefined;
		make();
	});

	teardown(() => {
		panel.dispose();
		delete (globalThis as { FACADE_TEST_MODE?: boolean }).FACADE_TEST_MODE;
	});

	test('each state goes to the page that said it is ready, with the model\'s own revision; nothing goes before', async () => {
		await update(stateOf(2));
		const before = states().length;
		await say({ type: 'ready', page: page(1) });
		await update(stateOf(3));
		assert.deepStrictEqual([before, states().map(each => [each.page, each.state.revision])], [0, [[page(1), 2], [page(1), 3]]]);
	});

	test('the page that said it is ready is told the list settings its wheel follows - VS Code\'s defaults where one is not a number - and told again as they or the window\'s zoom change, nothing else (PANEL-3.1, 3.3)', async () => {
		const scrolls = () => posted.filter(message => message.type === 'scrolling').map(message => [message.page, message.scrolling]);
		settings = { 'workbench.list.mouseWheelScrollSensitivity': 'much' };
		await say({ type: 'ready', page: page(1) });
		settings = { 'workbench.list.mouseWheelScrollSensitivity': 2, 'workbench.list.fastScrollSensitivity': 3, 'workbench.list.smoothScrolling': true, 'window.zoomLevel': 1 };
		configChanged.fire({ affectsConfiguration: section => section === 'editor.fontSize' });
		configChanged.fire({ affectsConfiguration: section => section === 'workbench.list' });
		configChanged.fire({ affectsConfiguration: section => section === 'window.zoomLevel' });
		assert.deepStrictEqual(scrolls(), [
			[page(1), { sensitivity: 1, fastSensitivity: 5, smooth: false, zoomFactor: 1 }],
			[page(1), { sensitivity: 2, fastSensitivity: 3, smooth: true, zoomFactor: 1.2 }],
			[page(1), { sensitivity: 2, fastSensitivity: 3, smooth: true, zoomFactor: 1.2 }]
		]);
	});

	test('a message of an unknown type, without a field its type has, with a field of the wrong type or any other field is refused and logged, and nothing is done (PANEL-3.2)', async () => {
		await say({ type: 'ready', page: page(1) });
		const refused = [
			{ type: 'navigate', page: page(1), url: 'command:workbench.action.reloadWindow' },
			{ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'open' },
			{ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'rename' },
			{ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'new', target: '1' },
			{ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'resume' },
			{ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'clearFilter', target: '1' },
			{ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'deleteWorktree' },
			{ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'open', revision: 1, target: '1' },
			{ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'open', target: '1', args: { agent: '2' } },
			{ type: 'act', page: 'not a page', action: `${page(1)}-1`, what: 'new' },
			{ type: 'ask', page: page(1), action: `${page(1)}-1`, what: 'rename', target: '1', name: 'Zed' },
			{ type: 'probed', page: page(1), id: 1, value: [] },
			{ type: 'ready', page: page(1), size: 10 },
			'ready',
			null
		];
		for (const message of refused) {
			await say(message);
		}
		assert.deepStrictEqual([acts, logged.length], [[], refused.length]);
		assert.ok(logged.every(line => line.startsWith('The panel refused a message from its webview')), logged.join('\n'));
	});

	test('what the person did on the page goes to the panel\'s actions with its card\'s run, and its outcome back to that page under its action ID (PANEL-1.2, 3.1)', async () => {
		await say({ type: 'ready', page: page(1) });
		answer = async () => acts.length === 1 ? 'gone' : undefined;
		for (const [what, target] of [['open', 'run-2'], ['new'], ['clearFilter'], ['openFolder'], ['rename', 'run-3']]) {
			await say({ type: 'act', page: page(1), action: `${page(1)}-${what}`, what, ...target ? { target } : {} });
		}
		assert.deepStrictEqual(acts, [['open', 'run-2'], ['new', undefined], ['clearFilter', undefined], ['openFolder', undefined], ['rename', 'run-3']]);
		assert.deepStrictEqual(posted.filter(message => message.type === 'outcome').map(({ action, ok, reason }) => [action, ok, reason]), [
			[`${page(1)}-open`, false, 'gone'], [`${page(1)}-new`, true, undefined], [`${page(1)}-clearFilter`, true, undefined], [`${page(1)}-openFolder`, true, undefined], [`${page(1)}-rename`, true, undefined]
		]);
	});

	test('U02: an action of an earlier page is not done; one of the current page is, its target left for the actions to revalidate by run ID, with no expected revision', async () => {
		await say({ type: 'ready', page: page(1) });
		await update(stateOf(4));
		await say({ type: 'act', page: page(2), action: `${page(2)}-1`, what: 'open', target: 'run-1' });
		const before = [...acts];
		await say({ type: 'act', page: page(1), action: `${page(1)}-3`, what: 'open', target: 'run-1' });
		await say({ type: 'act', page: page(1), action: `${page(1)}-4`, what: 'open', revision: 4, target: 'run-1' });
		assert.deepStrictEqual([before, acts, logged.length], [[], [['open', 'run-1']], 1]);
	});

	test('U02: the outcome goes to the page that asked alone - not to the page made in its place since', async () => {
		await say({ type: 'ready', page: page(1) });
		let release!: (reason: 'failed' | undefined) => void;
		answer = () => new Promise(resolve => release = resolve);
		await say({ type: 'act', page: page(1), action: `${page(1)}-1`, what: 'open', target: 'run-1' });
		// The view hides, its page gone, and shows again with a page of its own
		view.visible = false;
		visibility.fire();
		view.visible = true;
		visibility.fire();
		await say({ type: 'ready', page: page(2) });
		release('failed');
		await settle();
		const late = posted.filter(message => message.type === 'outcome');
		answer = async () => 'failed';
		await say({ type: 'act', page: page(2), action: `${page(2)}-1`, what: 'open', target: 'run-1' });
		assert.deepStrictEqual([late, posted.filter(message => message.type === 'outcome')], [[], [{ type: 'outcome', page: page(2), action: `${page(2)}-1`, ok: false, reason: 'failed' }]]);
	});

	test('PANEL-1.1, 2.3, UX-3.2: the badge counts every card - none at zero - the description names the filter, and the context keys come from the same state', async () => {
		const badges = [view.badge];
		front = { run: 'run-1', ended: true };
		await update(stateOf(2, { cardCount: 1, filter: { kind: 'location', id: 'loc-1', label: 'shop · main' }, capabilities: { remote: true } }));
		badges.push(view.badge);
		const selected = [view.description, { ...contexts }];
		front = undefined;
		await update(stateOf(3, { cardCount: 0 }));
		badges.push(view.badge);
		assert.deepStrictEqual([badges, selected, view.description, contexts], [
			[{ value: 2, tooltip: '2 agents' }, { value: 1, tooltip: '1 agent' }, undefined],
			['shop · main', { 'facade.hasAgents': true, 'facade.agentSelected': true, 'facade.agentSelectedEnded': true, 'facade.filtered': true }],
			undefined,
			{ 'facade.hasAgents': false, 'facade.agentSelected': false, 'facade.agentSelectedEnded': false, 'facade.filtered': false }
		]);
	});

	test('the view shows its own progress while this window\'s runs are not yet known, and draws nothing false meanwhile (PANEL-1.1)', () => {
		panel.dispose();
		state = stateOf(1, { loading: true });
		progress = 0;
		make();
		assert.strictEqual(progress, 1);
	});

	test('the page loads only bundled resources under an exact CSP, with its words escaped, and no probe flag (PANEL-3.2, UX-3.2)', () => {
		const html = view.webview.html;
		assert.match(html, /content="default-src 'none'; style-src vscode-resource:; img-src vscode-resource:; script-src 'nonce-[A-Za-z0-9+/=]{24}';"/);
		// Never all of dist/: the extension's and ptyd's code stay out of the page's reach
		assert.deepStrictEqual([html.includes('FACADE_PROBE'), (view.webview.options as { localResourceRoots: { path: string }[] }).localResourceRoots.map(root => root.path)], [false, ['/extension/media', '/extension/dist/webview']]);
		assert.deepStrictEqual([...html.matchAll(/(?:src|href)="webview:([^"]+)"/g)].map(match => match[1]), ['/extension/media/panel.css', '/extension/dist/webview/webview.js']);
		const words = html.slice(html.indexOf('window.FACADE_STRINGS'), html.indexOf('</script>', html.indexOf('window.FACADE_STRINGS')));
		assert.ok(words.includes('Launch an agent in this workspace.') && !words.includes('<'), 'the embedded words, with no raw <');
	});

	test('the shipped build answers no probe; the integration build has the page shown answer one (UX-3.2)', async () => {
		const shipped = [await panel.probe({ op: 'read', selector: '.name' }), posted.filter(message => message.type === 'probe').length];
		panel.dispose();
		posted = [];
		make(true);
		await say({ type: 'ready', page: page(3) });
		const probed = panel.probe({ op: 'read', selector: '.name', index: 1 });
		await settle();
		const sent = posted.filter(message => message.type === 'probe');
		await say({ type: 'probed', page: page(3), id: sent[0]?.id, value: ['Agent 2'] });
		assert.deepStrictEqual([shipped, sent, await probed], [[undefined, 0], [{ type: 'probe', page: page(3), id: 1, op: 'read', selector: '.name', index: 1 }], ['Agent 2']]);
	});
});
