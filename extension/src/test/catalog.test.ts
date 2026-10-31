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
	['facade.filter', 'Filter by Working Location...', '$(filter)'],
	['facade.clearFilter', 'Clear Filter'],
	['facade.configureAgents', 'Configure Agents...'],
	['facade.showAgentLaunch', 'Show Agent Launch'],
	['facade.showAgentsLog', 'Show Agents Log']
];
const HIDDEN: readonly [string, string, string?][] = [
	['facade.newWorktree', 'New Worktree...'],
	['facade.moveUp', 'Move Up'],
	['facade.moveDown', 'Move Down'],
	['facade.filterByLocation', 'Filter by This Location'],
	['facade.filterByFolder', 'Filter by This Folder'],
	// Filter by Working Location as its title button shows it while a filter is on (UX-3.2)
	['facade.filterOn', 'Filter by Working Location...', '$(filter-filled)'],
	['facade.revealAgent', 'Show Agent']
];
const HOST_COMMANDS = ['facade.newWorktree', 'facade.showAgentLaunch', 'facade.showAgentsLog'];
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

	test('menus: Filter by Working Location - filled while a filter is on - then New Agent in the title; the card menu in PANEL-2.2\'s groups, Close Agent for every card; the palette by availability, context-only commands hidden', () => {
		const card = "webviewId == 'facade.agents' && webviewSection == 'agent'";
		assert.deepStrictEqual(contributes.menus, {
			'view/title': [
				{ command: 'facade.filter', when: 'view == facade.agents && !facade.filtered', group: 'navigation@1' },
				{ command: 'facade.filterOn', when: 'view == facade.agents && facade.filtered', group: 'navigation@1' },
				{ command: 'facade.newAgent', when: 'view == facade.agents', group: 'navigation@3' },
				// The More Actions menu (PANEL-1.1, D58): the editor's own Add Folder to Workspace..., not declared here, keeps its own title
				{ command: 'workbench.action.addRootFolder', when: 'view == facade.agents', group: '1_locations@1' },
				{ command: 'facade.newWorktree', when: 'view == facade.agents && workspaceFolderCount != 0', group: '1_locations@2' },
				{ command: 'facade.configureAgents', when: 'view == facade.agents', group: '9_configure@1' }
			],
			'webview/context': [
				{ command: 'facade.renameAgent', when: card, group: '1_agent@1' },
				{ command: 'facade.copyAgentReference', when: card, group: '1_agent@3' },
				{ command: 'facade.moveUp', when: `${card} && webviewMoveUp`, group: '2_move@1' },
				{ command: 'facade.moveDown', when: `${card} && webviewMoveDown`, group: '2_move@2' },
				{ command: 'facade.filterByLocation', when: `${card} && webviewFilterLocation`, group: '3_location@1' },
				{ command: 'facade.filterByFolder', when: `${card} && webviewFilterFolder`, group: '3_location@2' },
				{ command: 'facade.clearFilter', when: `${card} && webviewFiltered`, group: '3_location@3' },
				{ command: 'facade.closeAgent', when: card, group: '4_close@1' }
			],
			commandPalette: [
				{ command: 'facade.renameAgent', when: 'facade.agentSelected' },
				{ command: 'facade.copyAgentReference', when: 'facade.agentSelected' },
				{ command: 'facade.closeAgent', when: 'facade.agentSelected' },
				{ command: 'facade.clearFilter', when: 'facade.filtered' },
				...HIDDEN.map(([command]) => ({ command, when: 'false' }))
			]
		});
	});

	test('PANEL-1.1, D58, D83: the view\'s native menu is Add Folder to Workspace..., New Worktree..., a line, Configure Agents... - in that order, as the editor sorts groups and their order', () => {
		type Entry = { command: string; group: string };
		const more = (contributes.menus['view/title'] as Entry[]).filter(each => !each.group.startsWith('navigation'));
		const placed = more.map(each => ({ command: each.command, group: each.group.split('@')[0], order: Number(each.group.split('@')[1]) }))
			.sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order);
		const shown = placed.flatMap((each, at) => at > 0 && placed[at - 1].group !== each.group ? ['──', each.command] : [each.command]);
		assert.deepStrictEqual(shown, ['workbench.action.addRootFolder', 'facade.newWorktree', '──', 'facade.configureAgents']);
		// Go to Agent, Show Agent Launch and Show Agents Log are in the Command Palette alone (D83); Configure Agents is in it too
		const palette = ['facade.showActiveAgents', 'facade.showAgentLaunch', 'facade.showAgentsLog'];
		assert.ok(!more.some(each => palette.includes(each.command)));
		assert.ok(!contributes.menus.commandPalette.some((each: { command: string }) => [...palette, 'facade.configureAgents'].includes(each.command)));
	});

	test('settings: Agents, then each built-in CLI in its catalog order with whether it is offered, its path and its launch; machine scope (UX-4.1, D43, CLIS-1.1, 1.2, 3.1)', () => {
		const sections = contributes.configuration.map((section: { id: string; title: string; order: number; properties: Record<string, unknown> }) => [section.id, english(section.title), section.order, Object.keys(section.properties)]);
		const cli = (setting: string) => [`${setting}.enabled`, `${setting}.path`, `${setting}.launch`];
		assert.deepStrictEqual(sections, [
			['facade.agents', 'Agents', 2, ['facade.yolo']],
			['facade.claude', 'Claude Code', 3, cli('facade.claude')],
			['facade.codex', 'Codex', 4, cli('facade.codex')],
			['facade.antigravity', 'Antigravity', 5, cli('facade.antigravity')],
			['facade.muse', 'Muse Code', 6, cli('facade.muse')],
			['facade.opencode', 'OpenCode', 7, cli('facade.opencode')],
			['facade.pi', 'Pi', 8, cli('facade.pi')]
		]);
		// The sections are the catalog's, by its adapters' settings and display names
		assert.deepStrictEqual(sections.slice(1).map((section: unknown[]) => [section[0], section[1]]), BUILT_IN_ADAPTERS.map(adapter => [adapter.setting, adapter.displayName]));
		const settings: Record<string, { type: string; default: unknown; scope: string; markdownDescription: string }> = Object.assign({}, ...contributes.configuration.map((section: { properties: object }) => section.properties));
		assert.deepStrictEqual(Object.entries(settings).map(([key, value]) => [key, value.type, value.default, value.scope]), [
			['facade.yolo', 'boolean', true, 'machine'],
			...BUILT_IN_ADAPTERS.flatMap(adapter => [
				[`${adapter.setting}.enabled`, 'boolean', true, 'machine'],
				[`${adapter.setting}.path`, 'string', '', 'machine'],
				[`${adapter.setting}.launch`, 'object', {}, 'machine']
			])
		]);
		// Each description names its CLI - the path the command PATH is searched for, the launch Show Agent Launch
		for (const adapter of BUILT_IN_ADAPTERS) {
			assert.strictEqual(english(settings[`${adapter.setting}.enabled`].markdownDescription), `Controls whether ${adapter.displayName} is offered for new agents. Turning it off does not stop agents that are running.`);
			assert.strictEqual(english(settings[`${adapter.setting}.path`].markdownDescription), `Path to ${adapter.displayName}. Leave empty to use "${adapter.command}" from the terminal environment's PATH.`);
			assert.strictEqual(english(settings[`${adapter.setting}.launch`].markdownDescription), `Advanced: additional command-line arguments and environment variables for ${adapter.displayName}. **Show Agent Launch** shows what each agent starts with.`);
		}
		// A launch takes literal arguments and an environment map alone, as CLIS-3.1 reads it
		const launch = settings['facade.claude.launch'] as unknown as { properties: Record<string, unknown>; additionalProperties: boolean };
		assert.deepStrictEqual([Object.keys(launch.properties), launch.additionalProperties, launch.properties.arguments, (launch.properties.environment as { additionalProperties: unknown }).additionalProperties], [
			['arguments', 'environment'], false, { type: 'array', items: { type: 'string' }, default: [], markdownDescription: '%config.launch.arguments%' }, { type: ['string', 'null'] }
		]);
		// Every description resolves; no retired setting survives
		const keys = [...JSON.stringify(contributes).matchAll(/"%([\w.]+)%"/g)].map(match => match[1]);
		assert.deepStrictEqual(keys.filter(key => nls[key] === undefined), []);
		for (const retired of ['agentLocation', 'worktrees"', 'taskDelay', 'unattended', 'enterDelay', 'trust', 'facade.agents.']) {
			assert.ok(!JSON.stringify(contributes.configuration).includes(retired), retired);
		}
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
					agents: { list: () => [], get: () => undefined, onDidChange: emitter.event, launch: () => '', close: async () => 'already_ended', rename: () => undefined },
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

		test('the panel registers the manifest\'s UI commands; the host separately registers New Worktree, Show Agent Launch and Show Agents Log (UX-3.2, E03)', () => {
			const manifested = contributes.commands.map((each: { command: string }) => each.command).filter((id: string) => !HOST_COMMANDS.includes(id));
			assert.deepStrictEqual(registered(false).sort(), [...manifested].sort());
		});

		test('the integration build adds only state, selectRow and probe, which no manifest lists (UX-3.2)', () => {
			const extra = registered(true).filter(id => !contributes.commands.some((each: { command: string }) => each.command === id));
			assert.deepStrictEqual(extra.sort(), [...TEST_COMMANDS].sort());
		});
	});
});
