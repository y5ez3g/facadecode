/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BUILT_IN_ADAPTERS } from '../clis/catalog';
import { TestEmitter, withModules } from './withModules';

const ROOT = path.join(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nls: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'package.nls.json'), 'utf8'));
const contributes = manifest.contributes;

/** A manifest string as the English window shows it. */
const english = (value: string) => value.replace(/^%(.+)%$/, (_, key) => nls[key] ?? `<missing ${key}>`);

/** The catalog of UX-3.1 (public) and UX-3.2 (context only) of this build: ID, English title, icon. */
const PUBLIC: readonly [string, string, string?][] = [
	['facade.newAgent', 'New Agent...', '$(new-session)'],
	['facade.showActiveAgents', 'Go to Agent...'],
	['facade.renameAgent', 'Rename Agent...'],
	['facade.copyAgentReference', 'Copy Agent Reference'],
	['facade.closeAgent', 'Close Agent'],
	['facade.messageHistory', 'Message History...'],
	['facade.configureAgents', 'Configure Agents...']
];
const HIDDEN: readonly [string, string, string?][] = [
	['facade.newWorktree', 'New Worktree...'],
	['facade.moveUp', 'Move Up'],
	['facade.moveDown', 'Move Down'],
	['facade.revealAgent', 'Show Agent']
];
/** Registered by the host itself rather than the panel: New Worktree, and Message History beside the message records (COLLABORATION-3.2). */
const HOST_COMMANDS = ['facade.newWorktree', 'facade.messageHistory'];
const TEST_COMMANDS = ['facade.state', 'facade.selectRow', 'facade.probe'];

suite('The manifest equals the command and settings catalog (UX-3, UX-4.1, U06)', () => {

	test('one view container `facade` with the webview view `facade.agents`, activated after startup; nothing else is contributed - no colours, keybindings or languages (PANEL-1.1, UX-2.1, 2.3)', () => {
		assert.deepStrictEqual([Object.keys(contributes), manifest.activationEvents], [['viewsContainers', 'views', 'commands', 'menus', 'configuration'], ['onStartupFinished']]);
		assert.deepStrictEqual(contributes.viewsContainers, { activitybar: [{ id: 'facade', title: '%view.container%', icon: 'media/facade.svg' }] });
		assert.deepStrictEqual(contributes.views, { facade: [{ type: 'webview', id: 'facade.agents', name: '%view.container%' }] });
		assert.strictEqual(english('%view.container%'), 'Facade Code');
	});

	test('every command has one `facade.` ID and its UX-3.1 title in the Facade Code category; retired and later-milestone commands are absent', () => {
		const commands = contributes.commands.map((each: { command: string; title: string; category: string; icon?: string }) => [each.command, english(each.title), ...each.icon ? [each.icon] : []]);
		assert.deepStrictEqual(commands, [...PUBLIC, ...HIDDEN].map(([id, title, icon]) => [id, title, ...icon ? [icon] : []]));
		assert.ok(contributes.commands.every((each: { category: string }) => english(each.category) === 'Facade Code'));
		const text = JSON.stringify(manifest);
		// Gone in this step too: Refresh, New Agent Here, the working-location commands and their context keys
		for (const retired of ['facadeDots', 'facade.stopAgent', 'facade.nextAgent', 'facade.startAgent', 'ChatRoom', 'deleteWorktree', 'facade.refresh', 'facade.newAgentHere', 'webviewHere',
			'facade.customize', 'facade.openInNewWindow', 'facade.revealIn', 'facade.openContainingFolder', 'facade.revealRemote', 'facade.copyPath', 'facade.openTerminalHere', 'canManageWorktrees', 'facade.remote']) {
			assert.ok(!text.includes(retired), retired);
		}
	});

	test('menus: New Agent in the title; the card menu in PANEL-2.2\'s groups, Close Agent for every card; the palette by availability, context-only commands hidden', () => {
		const card = "webviewId == 'facade.agents' && webviewSection == 'agent'";
		assert.deepStrictEqual(contributes.menus, {
			'view/title': [
				{ command: 'facade.newAgent', when: 'view == facade.agents', group: 'navigation@3' },
				// The More Actions menu (PANEL-1.1, D58): the editor's own Add Folder to Workspace..., not declared here, keeps its own title
				{ command: 'workbench.action.addRootFolder', when: 'view == facade.agents', group: '1_locations@1' },
				{ command: 'facade.newWorktree', when: 'view == facade.agents && workspaceFolderCount != 0', group: '1_locations@2' },
				{ command: 'facade.messageHistory', when: 'view == facade.agents', group: '9_configure@1' },
				{ command: 'facade.configureAgents', when: 'view == facade.agents', group: '9_configure@2' }
			],
			'webview/context': [
				{ command: 'facade.renameAgent', when: card, group: '1_agent@1' },
				{ command: 'facade.copyAgentReference', when: card, group: '1_agent@3' },
				{ command: 'facade.moveUp', when: `${card} && webviewMoveUp`, group: '2_move@1' },
				{ command: 'facade.moveDown', when: `${card} && webviewMoveDown`, group: '2_move@2' },
				{ command: 'facade.closeAgent', when: card, group: '4_close@1' }
			],
			commandPalette: [
				{ command: 'facade.renameAgent', when: 'facade.agentSelected' },
				{ command: 'facade.copyAgentReference', when: 'facade.agentSelected' },
				{ command: 'facade.closeAgent', when: 'facade.agentSelected' },
				...HIDDEN.map(([command]) => ({ command, when: 'false' }))
			]
		});
	});

	test('PANEL-1.1, D58: the view\'s native menu is Add Folder to Workspace..., New Worktree..., a line, Message History..., Configure Agents... - in that order, as the editor sorts groups and their order', () => {
		type Entry = { command: string; group: string };
		const more = (contributes.menus['view/title'] as Entry[]).filter(each => !each.group.startsWith('navigation'));
		const placed = more.map(each => ({ command: each.command, group: each.group.split('@')[0], order: Number(each.group.split('@')[1]) }))
			.sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order);
		const shown = placed.flatMap((each, at) => at > 0 && placed[at - 1].group !== each.group ? ['──', each.command] : [each.command]);
		assert.deepStrictEqual(shown, ['workbench.action.addRootFolder', 'facade.newWorktree', '──', 'facade.messageHistory', 'facade.configureAgents']);
		// Go to Agent stays in the Command Palette alone; Configure Agents is in it too
		assert.ok(!more.some(each => each.command === 'facade.showActiveAgents'));
		assert.ok(!contributes.menus.commandPalette.some((each: { command: string }) => each.command === 'facade.showActiveAgents' || each.command === 'facade.configureAgents'));
	});

	test('settings: Agents - YOLO, the agents\' tools switch and the start/stop timeout - then each built-in CLI in its catalog order; machine scope; each CLI has its path alone - turning it off and its launch come in later steps (UX-4.1, D43, D89, CLIS-1.2)', () => {
		const sections = contributes.configuration.map((section: { id: string; title: string; order: number; properties: Record<string, unknown> }) => [section.id, english(section.title), section.order, Object.keys(section.properties)]);
		assert.deepStrictEqual(sections, [
			['facade.agents', 'Agents', 2, ['facade.yolo', 'facade.collaboration.enabled', 'facade.collaboration.waitSeconds']],
			['facade.claude', 'Claude Code', 3, ['facade.claude.path']],
			['facade.codex', 'Codex', 4, ['facade.codex.path']],
			['facade.antigravity', 'Antigravity', 5, ['facade.antigravity.path']],
			['facade.muse', 'Muse Code', 6, ['facade.muse.path']],
			['facade.opencode', 'OpenCode', 7, ['facade.opencode.path']],
			['facade.pi', 'Pi', 8, ['facade.pi.path']]
		]);
		// The sections are the catalog's, by its adapters' settings and display names
		assert.deepStrictEqual(sections.slice(1).map((section: unknown[]) => [section[0], section[1]]), BUILT_IN_ADAPTERS.map(adapter => [adapter.setting, adapter.displayName]));
		const settings: Record<string, { type: string; default: unknown; scope: string; markdownDescription: string }> = Object.assign({}, ...contributes.configuration.map((section: { properties: object }) => section.properties));
		assert.deepStrictEqual(Object.entries(settings).map(([key, value]) => [key, value.type, value.default, value.scope]), [
			['facade.yolo', 'boolean', true, 'machine'],
			['facade.collaboration.enabled', 'boolean', true, 'machine'],
			['facade.collaboration.waitSeconds', 'integer', 120, 'machine'],
			...BUILT_IN_ADAPTERS.map(adapter => [`${adapter.setting}.path`, 'string', '', 'machine'])
		]);
		// Each path's description names its CLI and the command PATH is searched for
		for (const adapter of BUILT_IN_ADAPTERS) {
			assert.strictEqual(english(settings[`${adapter.setting}.path`].markdownDescription), `Path to ${adapter.displayName}. Leave empty to use "${adapter.command}" from the terminal environment's PATH.`);
		}
		// Every description resolves; no retired setting survives
		const keys = [...JSON.stringify(contributes).matchAll(/"%([\w.]+)%"/g)].map(match => match[1]);
		assert.deepStrictEqual(keys.filter(key => nls[key] === undefined), []);
		for (const retired of ['agentLocation', 'worktrees"', 'taskDelay', 'unattended', 'enterDelay', 'trust', 'facade.claude.enabled', 'facade.claude.launch', 'facade.agents.timeout', 'facade.agents.yolo']) {
			assert.ok(!JSON.stringify(contributes.configuration).includes(retired), retired);
		}
		// The timeout's bounds are MCP-1.3's: whole seconds from 1 to 3600
		const timeout = settings['facade.collaboration.waitSeconds'] as unknown as { minimum: number; maximum: number };
		assert.deepStrictEqual([timeout.minimum, timeout.maximum], [1, 3600]);
	});

	suite('what the panel registers', () => {
		/** The commands `registerUi` registers, its build's test mode as `testMode` says. */
		const registered = (testMode: boolean): string[] => {
			const ids: string[] = [];
			const none = { dispose: () => undefined };
			const api = {
				Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }) },
				l10n: { t: (text: string) => text },
				env: { language: 'en', remoteName: undefined, clipboard: { writeText: async () => undefined } },
				commands: { registerCommand: (id: string) => { ids.push(id); return none; }, executeCommand: async () => undefined },
				window: { registerWebviewViewProvider: () => none, withProgress: async () => undefined },
				workspace: { onDidChangeConfiguration: () => none, getConfiguration: () => ({ get: () => undefined }) },
				ThemeIcon: class { constructor(readonly id: string) { } }
			};
			(globalThis as { FACADE_TEST_MODE?: boolean }).FACADE_TEST_MODE = testMode;
			try {
				const { registerUi } = withModules({ vscode: api })<typeof import('../ui/commands/index')>(require.resolve('../ui/commands/index'));
				const emitter = new TestEmitter<never>();
				const disposables = registerUi({
					agents: { requested: () => undefined, list: () => [], get: () => undefined, onDidChange: emitter.event, launch: () => '', started: async () => ({ state: 'closed' }), warmedUp: async () => undefined, close: async () => 'already_ended', rename: () => undefined },
					worktrees: { availability: async () => ({ available: false, reason: 'none' }), plan: async () => { throw new Error('none'); }, create: async () => { throw new Error('none'); }, remove: async () => { throw new Error('none'); } },
					locations: { snapshot: () => ({ locations: [], folders: [], pending: false }), resolve: () => undefined, refresh: async () => undefined, onDidChange: emitter.event, onDidRemove: emitter.event, removalOf: () => undefined },
					clis: { list: async () => [] },
					history: { last: () => ({}), remember: () => undefined },
					execution: { reveal: async () => false, onDidActivate: emitter.event },
					workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] } as never,
					extensionUri: { path: '/extension' } as never,
					log: { event: () => undefined },
					notifyError: () => undefined,
					ready: Promise.resolve()
				});
				disposables.forEach(each => each.dispose());
			} finally {
				delete (globalThis as { FACADE_TEST_MODE?: boolean }).FACADE_TEST_MODE;
			}
			return ids;
		};

		test('the panel registers the manifest\'s UI commands; the host separately registers New Worktree and Message History (UX-3.2, E03)', () => {
			const manifested = contributes.commands.map((each: { command: string }) => each.command).filter((id: string) => !HOST_COMMANDS.includes(id));
			assert.deepStrictEqual(registered(false).sort(), [...manifested].sort());
		});

		test('the integration build adds only state, selectRow and probe, which no manifest lists (UX-3.2)', () => {
			const extra = registered(true).filter(id => !contributes.commands.some((each: { command: string }) => each.command === id));
			assert.deepStrictEqual(extra.sort(), [...TEST_COMMANDS].sort());
		});
	});
});
