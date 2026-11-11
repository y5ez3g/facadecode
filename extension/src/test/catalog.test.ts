/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ROBOTS } from '../base/robot';
import { LEGACY_SETTINGS } from '../clis/migration';
import { TestEmitter, withModules } from './withModules';

const ROOT = path.join(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nls: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'package.nls.json'), 'utf8'));
const contributes = manifest.contributes;

/** A manifest string as the English window shows it. */
const english = (value: string) => value.replace(/^%(.+)%$/, (_, key) => nls[key] ?? `<missing ${key}>`);

/** The catalog of UX-3.1 (public) and UX-3.2 (context only) of this build: ID, English title, icon. */
const PUBLIC: readonly [string, string, string?][] = [
	// Facade's own copy of codicons' `new-session`, which VS Code before 1.111 has not (PANEL-1.1)
	['facade.newAgent', 'New Agent...', '$(facade-new-agent)'],
	['facade.history', 'Resume Agent...', '$(history)'],
	['facade.pinAgent', 'Pin Agent'],
	['facade.unpinAgent', 'Unpin Agent'],
	['facade.showActiveAgents', 'Go to Agent...'],
	['facade.renameAgent', 'Rename Agent...'],
	['facade.closeAgent', 'End Agent'],
	['facade.showAgentDetails', 'Show Agent Details'],
	['facade.filter', 'Filter by Working Location...', '$(filter)'],
	['facade.openSettings', 'Open Settings'],
	['facade.showAgentLaunch', 'Show Agent Launch...'],
	['facade.showAgentsLog', 'Show Agents Log']
];
/** The moved notice where VS Code cannot show a link (CONFIGURATION-6.3). */
const MOVED_PLAIN = 'Moved to facade.json. Run Facade Code: Open Settings to reach it.';
const HIDDEN: readonly [string, string, string?][] = [
	['facade.newWorktree', 'New Worktree...'],
	['facade.moveUp', 'Move Up'],
	['facade.moveDown', 'Move Down'],
	// Filter by Working Location as its title button shows it while a filter is on (UX-3.2)
	['facade.filterOn', 'Filter by Working Location...', '$(filter-filled)'],
	['facade.revealAgent', 'Show Agent'],
	// The link of Facade: Home's description in the editor's Settings, which Open Settings shows (CONFIGURATION-1.2)
	['facade.openSettingsFile', 'Open facade.json']
];
/**
 * Registered by the host itself rather than the panel: New Worktree, Show Agent Launch and Show Agents Log beside the CLIs and the log,
 * and Open Settings File beside the settings file.
 */
const HOST_COMMANDS = ['facade.newWorktree', 'facade.showAgentLaunch', 'facade.showAgentsLog', 'facade.openSettingsFile'];
const TEST_COMMANDS = ['facade.state', 'facade.selectRow', 'facade.probe'];

suite('The manifest equals the command and settings catalog (UX-3, UX-4.1, U06)', () => {

	test('one view container and webview, startup activation, native New Agent and CLI icons; no keybindings or languages (PANEL-1.1, LIFECYCLE-2.2, UX-2.1, 2.3)', () => {
		assert.deepStrictEqual([Object.keys(contributes), manifest.activationEvents], [['viewsContainers', 'views', 'commands', 'menus', 'icons', 'configuration', 'jsonValidation'], ['onStartupFinished']]);
		// Facade's own copy of codicons' `new-session`, at its codicon's code point in the font beside the manifest
		assert.deepStrictEqual(contributes.icons['facade-new-agent'], { description: '%icon.newAgent%', default: { fontPath: './media/new-agent.woff', fontCharacter: '\\EC84' } });
		// Besides New Agent's, each built-in's logo and each of Facade's robots, for terminal tabs (CONFIGURATION-2.4)
		assert.deepStrictEqual(Object.keys(contributes.icons).sort(), ['facade-new-agent', ...['claude', 'codex', 'agy', 'muse', 'opencode', 'pi'].map(cli => `facade-cli-${cli}`), ...ROBOTS.map(robot => `facade-robot-${robot}`)].sort());
		assert.ok(fs.statSync(path.join(ROOT, 'media', 'new-agent.woff')).isFile());
		assert.strictEqual(english('%icon.newAgent%'), 'New Agent icon');
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

	test('menus: Filter by Working Location - filled while a filter is on - then New Agent in the title; the card menu in PANEL-2.2\'s groups, End Agent for every card; the palette by availability, context-only commands hidden', () => {
		const card = "webviewId == 'facade.agents' && webviewSection == 'agent'";
		assert.deepStrictEqual(contributes.menus, {
			'view/title': [
				// Not offered where every agent works in the window's one place to work, unless a filter is on (PANEL-2.3)
				{ command: 'facade.filter', when: 'view == facade.agents && !facade.filtered && !facade.onePlace', group: 'navigation@1' },
				{ command: 'facade.filterOn', when: 'view == facade.agents && facade.filtered', group: 'navigation@1' },
				{ command: 'facade.history', when: 'view == facade.agents', group: 'navigation@2' },
				{ command: 'facade.newAgent', when: 'view == facade.agents', group: 'navigation@3' },
				// The More Actions menu (PANEL-1.1): the editor's own Add Folder to Workspace..., not declared here, keeps its own title
				{ command: 'workbench.action.addRootFolder', when: 'view == facade.agents', group: '1_locations@1' },
				{ command: 'facade.newWorktree', when: 'view == facade.agents && workspaceFolderCount != 0', group: '1_locations@2' },
				{ command: 'facade.openSettings', when: 'view == facade.agents', group: '9_configure@1' }
			],
			'webview/context': [
				{ command: 'facade.renameAgent', when: card, group: '1_agent@1' },
				{ command: 'facade.moveUp', when: `${card} && webviewMoveUp`, group: '2_move@1' },
				{ command: 'facade.moveDown', when: `${card} && webviewMoveDown`, group: '2_move@2' },
				{ command: 'facade.closeAgent', when: card, group: '4_close@1' }
			],
			commandPalette: [
				{ command: 'facade.renameAgent', when: 'facade.agentSelected' },
				{ command: 'facade.closeAgent', when: 'facade.agentSelected' },
				{ command: 'facade.showAgentDetails', when: 'facade.agentSelected && facade.agentSelectedVisible' },
				...HIDDEN.map(([command]) => ({ command, when: 'false' })),
				{ command: 'facade.pinAgent', when: 'facade.agentSelected && facade.agentSelectedPinnable && !facade.agentSelectedPinned' },
				{ command: 'facade.unpinAgent', when: 'facade.agentSelectedPinned' },
				{ command: 'facade.filter', when: '!facade.onePlace || facade.filtered' }
			]
		});
	});

	test('PANEL-1.1: the view\'s native menu is Add Folder to Workspace..., New Worktree..., a line, Open Settings - in that order, as the editor sorts groups and their order', () => {
		type Entry = { command: string; group: string };
		const more = (contributes.menus['view/title'] as Entry[]).filter(each => !each.group.startsWith('navigation'));
		const placed = more.map(each => ({ command: each.command, group: each.group.split('@')[0], order: Number(each.group.split('@')[1]) }))
			.sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order);
		const shown = placed.flatMap((each, at) => at > 0 && placed[at - 1].group !== each.group ? ['──', each.command] : [each.command]);
		assert.deepStrictEqual(shown, ['workbench.action.addRootFolder', 'facade.newWorktree', '──', 'facade.openSettings']);
		// These commands are in the Command Palette alone (PANEL-1.1); Open Settings is in it too.
		const palette = ['facade.showActiveAgents', 'facade.showAgentLaunch', 'facade.showAgentsLog'];
		assert.ok(!more.some(each => palette.includes(each.command)));
		assert.ok(!contributes.menus.commandPalette.some((each: { command: string }) => [...palette, 'facade.openSettings'].includes(each.command)));
	});

	test('settings: one Facade Code section, its first item Facade: Home, the folder Facade keeps its data in, whose description links to facade.json; every setting an earlier build read stays as it was, marked moved; the file has its schema (CONFIGURATION-1.2, 6.3, UX-4.1, ARCHITECTURE-3.1)', () => {
		assert.deepStrictEqual(contributes.configuration.map((section: { id: string; title: string; order: number }) => [section.id, english(section.title), section.order]), [['facade.agents', 'Facade Code', 2]]);
		const settings: Record<string, { type: string; default: unknown; scope: string; order?: number; pattern?: string; patternErrorMessage?: string; markdownDescription: string; markdownDeprecationMessage?: string; deprecationMessage?: string }> = contributes.configuration[0].properties;
		// A real setting, a path: the box VS Code draws for it has no Edit in settings.json button; a workspace cannot set it
		assert.deepStrictEqual(settings['facade.home'], { type: 'string', default: '~/.facade', scope: 'machine', order: 0, pattern: '^$|^(~[\\\\/]|/|[A-Za-z]:[\\\\/]|\\\\\\\\)', patternErrorMessage: '%config.home.pattern%', markdownDescription: '%config.home%' });
		const usable = new RegExp(settings['facade.home'].pattern!);
		assert.deepStrictEqual(['', '~/.facade', '/Volumes/Data/facade', 'D:\\Facade', 'D:/Facade', '\\\\server\\share', 'facade', './facade', '~', 'D:Facade'].map(value => usable.test(value)),
			[true, true, true, true, true, true, false, false, false, false]);
		assert.strictEqual(english(settings['facade.home'].markdownDescription), 'The Facade home is the folder for Facade\'s settings, agent history, and messages. '
			+ 'Only agents in windows with the same Facade home can communicate with each other. The `FACADE_HOME` environment variable overrides the '
			+ '`~/.facade` default; a path here overrides both.\n\n[Edit in facade.json](command:facade.openSettingsFile) to add your own CLIs or '
			+ 'terminal programs. You also choose how each starts, what New Agent offers, the names it suggests, and whether YOLO is on.');
		assert.strictEqual(english('%config.home.pattern%'), 'The path must start with ~/ or be absolute.');
		// The earlier settings keep their types and defaults, so the editor still checks a value set and a migration reads it; the
		// editor shows a deprecated setting only where it is set, with where it went
		const earlier = Object.keys(settings).filter(key => key !== 'facade.home');
		assert.deepStrictEqual(earlier, [...LEGACY_SETTINGS]);
		assert.deepStrictEqual(earlier.map(key => [key, settings[key].type, settings[key].default, settings[key].scope]), [
			['facade.yolo', 'boolean', true, 'machine'],
			['facade.collaboration.enabled', 'boolean', true, 'machine'],
			...['claude', 'codex', 'antigravity', 'muse', 'opencode', 'pi'].flatMap(segment => [
				[`facade.${segment}.enabled`, 'boolean', true, 'machine'],
				[`facade.${segment}.path`, 'string', '', 'machine'],
				[`facade.${segment}.launch`, 'object', {}, 'machine']
			]),
			['facade.custom', 'object', {}, 'machine']
		]);
		assert.deepStrictEqual(earlier.filter(key => settings[key].markdownDeprecationMessage !== '%config.moved%' || settings[key].deprecationMessage !== '%config.movedPlain%'), []);
		assert.deepStrictEqual([english('%config.moved%'), english('%config.movedPlain%')], [
			'Moved to `facade.json`. [Edit in facade.json](command:facade.openSettingsFile)',
			MOVED_PLAIN
		]);
		// facade.json is checked against its schema wherever the Facade home is: the file's name is Facade's own
		assert.deepStrictEqual(contributes.jsonValidation, [{ fileMatch: ['**/facade.json'], url: './media/settings.schema.json' }]);
		assert.ok(fs.existsSync(path.join(ROOT, 'media', 'settings.schema.json')));
		// Every description resolves; no retired setting survives
		const keys = [...JSON.stringify(contributes).matchAll(/"%([\w.]+)%"/g)].map(match => match[1]);
		assert.deepStrictEqual(keys.filter(key => nls[key] === undefined), []);
		// How long a start or stop is waited for is no setting (MCP-1.3)
		for (const retired of ['agentLocation', 'worktrees"', 'taskDelay', 'unattended', 'enterDelay', 'trust', 'facade.agents.', 'waitSeconds']) {
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
					savedName: () => undefined,
					agents: { requested: () => undefined, started: async () => ({ state: 'closed' }), warmedUp: async () => undefined, list: () => [], get: () => undefined, onDidChange: emitter.event, resume: () => '', holding: () => undefined, refreshConversations: async () => {}, pin: () => {}, unpin: () => {}, pins: () => [], reorderPins: () => {}, restorePins: async () => {},
			launch: () => '', close: async () => 'already_ended', rename: () => undefined },
					worktrees: { availability: async () => ({ available: false, reason: 'none' }), plan: async () => { throw new Error('none'); }, create: async () => { throw new Error('none'); }, remove: async () => { throw new Error('none'); } },
					locations: { snapshot: () => ({ locations: [], folders: [], pending: false }), resolve: () => undefined, refresh: async () => undefined, onDidChange: emitter.event, onDidRemove: emitter.event, removalOf: () => undefined },
					clis: { list: async () => ({ clis: [], problems: [] }) },
					history: { last: () => ({}), remember: () => undefined },
					execution: { reveal: async () => false, tabOpen: () => false, onDidActivate: emitter.event },
					workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] } as never,
					extensionUri: { path: '/extension' } as never,
					log: { event: () => undefined },
					notifyError: () => undefined,
					openSettings: async () => undefined,
					ready: Promise.resolve()
				});
				disposables.forEach(each => each.dispose());
			} finally {
				delete (globalThis as { FACADE_TEST_MODE?: boolean }).FACADE_TEST_MODE;
			}
			return ids;
		};

		test('the panel registers the manifest\'s UI commands; the host separately registers New Worktree, Show Agent Launch, Show Agents Log and Open Settings File (UX-3.2, E03)', () => {
			const manifested = contributes.commands.map((each: { command: string }) => each.command).filter((id: string) => !HOST_COMMANDS.includes(id));
			assert.deepStrictEqual(registered(false).sort(), [...manifested].sort());
		});

		test('the integration build adds only state, selectRow and probe, which no manifest lists (UX-3.2)', () => {
			const extra = registered(true).filter(id => !contributes.commands.some((each: { command: string }) => each.command === id));
			assert.deepStrictEqual(extra.sort(), [...TEST_COMMANDS].sort());
		});
	});
});
