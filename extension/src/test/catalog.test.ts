/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ROBOTS } from '../base/robot';
import { COMMANDS, CONTEXT } from '../ui/catalog';
import { TestEmitter, withModules } from './withModules';

const ROOT = path.join(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nls: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', 'package.nls.json'), 'utf8'));
const contributes = manifest.contributes;

/** A manifest string as the English window shows it. */
const english = (value: string) => value.replace(/^%(.+)%$/, (_, key) => nls[key] ?? `<missing ${key}>`);

/** The catalog of UX-3.1 (public) and UX-3.2 (context only) of this build: ID, English title, icon. */
const PUBLIC: readonly [string, string, string?][] = [
	// Facade Code Extension's own copy of codicons' `new-session`, which VS Code before 1.111 has not (PANEL-1.1)
	['facade.newAgent', 'New Agent...', '$(facade-new-agent)'],
	['facade.resumeAgent', 'Resume Agent...', '$(history)'],
	['facade.continueSession', 'Continue Session...', '$(history)'],
	['facade.pinAgent', 'Pin Agent'],
	['facade.unpinAgent', 'Unpin Agent'],
	['facade.openTerminal', 'Open Terminal'],
	['facade.renameAgent', 'Rename Agent...'],
	['facade.stopAgent', 'Stop Agent...'],
	['facade.deleteAgent', 'Remove'],
	['facade.copyAgentReference', 'Copy Agent Reference'],
	['facade.dismissAgent', 'Dismiss Agent'],
	['facade.showAgentDetails', 'Show Agent Details'],
	['facade.filter', 'Filter Agents...', '$(filter)'],
	['facade.openSettings', 'Open Settings'],
	['facade.showAgentLaunch', 'Show Agent Command Line...'],
	['facade.showAgentsLog', 'Show Agents Log']
];
const HIDDEN: readonly [string, string, string?][] = [
	['facade.newWorktree', 'New Worktree...'],
	['facade.moveUp', 'Move Up'],
	['facade.moveDown', 'Move Down'],
	// Filter Agents as its title button shows it while a filter is on (UX-3.2)
	['facade.filterOn', 'Filter Agents...', '$(filter-filled)'],
	['facade.revealAgent', 'Show Agent'],
	['facade.openSettingsFile', 'Edit in facade.json']
];
/**
 * Registered by the host itself rather than the panel: New Worktree, Show Agent Command Line and Show Agents Log beside the CLIs and the log,
 * and Open Settings File beside the settings file.
 */
const OUTSIDE_PANEL = new Set(['facade.newWorktree', 'facade.showAgentsLog', 'facade.openSettingsFile', 'facade.showAgentLaunch', 'facade.dismissAgent', 'facade.continueSession']);
const TEST_COMMANDS = ['facade.state', 'facade.selectRow', 'facade.probe'];

suite('The manifest equals the command and settings catalog (UX-3, UX-4.1, U06)', () => {

	test('one view container and webview, startup activation, native New Agent and CLI icons; no keybindings or languages (PANEL-1.1, LIFECYCLE-2.2, UX-2.1, 2.3)', () => {
		assert.deepStrictEqual([Object.keys(contributes), manifest.activationEvents], [['viewsContainers', 'views', 'commands', 'menus', 'icons', 'configuration', 'jsonValidation'], ['onStartupFinished']]);
		// Facade Code Extension's own copy of codicons' `new-session`, at its codicon's code point in the font beside the manifest
		assert.deepStrictEqual(contributes.icons['facade-new-agent'], { description: '%icon.newAgent%', default: { fontPath: './media/new-agent.woff', fontCharacter: '\\EC84' } });
		// Besides New Agent's, each built-in's logo and each of Facade Code Extension's robots, for terminal tabs (CONFIGURATION-2.4)
		assert.deepStrictEqual(Object.keys(contributes.icons).sort(), ['facade-new-agent', ...['claude', 'codex', 'agy', 'muse', 'opencode', 'pi', 'devin', 'agent', 'kiro-cli', 'qoder', 'omp', 'copilot'].map(cli => `facade-cli-${cli}`), ...ROBOTS.map(robot => `facade-robot-${robot}`)].sort());
		assert.ok(fs.statSync(path.join(ROOT, 'media', 'new-agent.woff')).isFile());
		assert.strictEqual(english('%icon.newAgent%'), 'New Agent icon');
		assert.deepStrictEqual(contributes.viewsContainers, { activitybar: [{ id: 'facade', title: '%view.container%', icon: 'media/facade.svg' }] });
		assert.deepStrictEqual(contributes.views, { facade: [{ type: 'webview', id: 'facade.agents', name: '%view.container%' }] });
		assert.strictEqual(english('%view.container%'), 'Facade Code Extension');
	});

	test('every command has one catalog ID and its title in the Facade Code Extension category (UX-3.1, UX-6.1)', () => {
		const commands = contributes.commands.map((each: { command: string; title: string; category: string; icon?: string }) => [each.command, english(each.title), ...each.icon ? [each.icon] : []]);
		assert.deepStrictEqual(commands, [...PUBLIC, ...HIDDEN].map(([id, title, icon]) => [id, title, ...icon ? [icon] : []]));
		assert.deepStrictEqual(commands.map(([id]: string[]) => id).sort(), Object.values(COMMANDS).sort());
		assert.ok(contributes.commands.every((each: { category: string }) => english(each.category) === 'Facade Code Extension'));
		const text = JSON.stringify(manifest);
		// Gone in this step too: Refresh, New Agent Here, the working-location commands and their context keys
		for (const retired of ['facadeDots', 'facade.closeAgent', 'facade.history', 'facade.showActiveAgents', 'facade.nextAgent', 'facade.startAgent', 'ChatRoom', 'deleteWorktree', 'facade.refresh', 'facade.newAgentHere', 'webviewHere',
			'facade.goToAgent', 'facade.hideAgent', 'facade.customize', 'facade.openInNewWindow', 'facade.revealIn', 'facade.openContainingFolder', 'facade.revealRemote', 'facade.copyPath', 'facade.openTerminalHere', 'canManageWorktrees', 'facade.remote']) {
			assert.ok(!text.includes(retired), retired);
		}
	});

	test('menus expose Facade Code Framework actions and hide retired legacy actions (PANEL-2.2, PANEL-4.2)', () => {
		const card = "webviewId == 'facade.agents' && webviewSection == 'agent'";
		const running = CONTEXT.agentSelectedRunning;
		assert.deepStrictEqual(contributes.menus, {
			'view/title': [
				// A Facade Code Framework window can always filter its cards (PANEL-4.3)
				{ command: 'facade.filter', when: 'view == facade.agents && !facade.filtered && facade.implementation == framework', group: 'navigation@1' },
				{ command: 'facade.filterOn', when: 'view == facade.agents && facade.filtered && facade.implementation == framework', group: 'navigation@1' },
				{ command: 'facade.resumeAgent', when: 'view == facade.agents && facade.implementation == framework', group: 'navigation@2' },
				{ command: 'facade.newAgent', when: 'view == facade.agents', group: 'navigation@3' },
				// The More Actions menu (PANEL-1.1): the editor's own Add Folder to Workspace..., not declared here, keeps its own title
				{ command: 'workbench.action.addRootFolder', when: 'view == facade.agents', group: '1_locations@1' },
				{ command: 'facade.newWorktree', when: 'view == facade.agents && workspaceFolderCount != 0', group: '1_locations@2' },
				{ command: 'facade.openSettings', when: 'view == facade.agents', group: '9_configure@1' }
			],
			'webview/context': [
				{ command: 'facade.renameAgent', when: card, group: '1_agent@1' },
				{ command: 'facade.moveUp', when: `${card} && webviewMoveUp`, group: '2_move@1' },
				{ command: 'facade.moveDown', when: `${card} && webviewMoveDown`, group: '2_move@2' }
			],
			commandPalette: [
				{ command: 'facade.resumeAgent', when: 'facade.implementation == framework' },
				{ command: 'facade.continueSession', when: 'false' },
				{ command: 'facade.showAgentLaunch', when: 'false' },
				{ command: 'facade.renameAgent', when: 'facade.agentSelected' },
				{ command: 'facade.openTerminal', when: `facade.implementation == framework && facade.agentSelected && ${running}` },
				{ command: 'facade.stopAgent', when: 'facade.implementation == framework' },
				{ command: 'facade.deleteAgent', when: 'facade.implementation == framework && facade.agentSelected' },
				{ command: 'facade.copyAgentReference', when: 'facade.implementation == framework && facade.agentSelected' },
				{ command: 'facade.dismissAgent', when: 'false' },
				{ command: 'facade.showAgentDetails', when: 'facade.agentSelected && facade.agentSelectedVisible' },
				...HIDDEN.map(([command]) => ({ command, when: 'false' })),
				{ command: 'facade.pinAgent', when: 'facade.agentSelected && facade.agentSelectedPinnable && !facade.agentSelectedPinned' },
				{ command: 'facade.unpinAgent', when: 'facade.agentSelectedPinned' },
				{ command: 'facade.filter', when: 'facade.implementation == framework' }
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
		// These commands stay out of More Actions.
		const palette = ['facade.showAgentLaunch', 'facade.showAgentsLog'];
		assert.ok(!more.some(each => palette.includes(each.command)));
		// Show Agent Command Line has been retired.
		assert.ok(!contributes.menus.commandPalette.some((each: { command: string }) => [...palette.filter(command => command !== 'facade.showAgentLaunch'), 'facade.openSettings'].includes(each.command)));
	});

	test('settings retain Facade Home, link to facade.json, and keep its schema (CONFIGURATION-7.1, UX-6.2)', () => {
		assert.deepStrictEqual(contributes.configuration.map((section: { id: string; title: string; order: number }) => [section.id, english(section.title), section.order]), [['facade.agents', 'Facade Code Extension', 2]]);
		const settings: Record<string, { type: string; default: unknown; scope: string; order?: number; pattern?: string; patternErrorMessage?: string; markdownDescription: string }> = contributes.configuration[0].properties;
		// A real setting, a path: the box VS Code draws for it has no Edit in settings.json button; a workspace cannot set it
		assert.deepStrictEqual(settings['facade.home'], { type: 'string', default: '~/.facade', scope: 'machine', order: 0, pattern: '^$|^(~[\\\\/]|/|[A-Za-z]:[\\\\/]|\\\\\\\\)', patternErrorMessage: '%config.home.pattern%', markdownDescription: '%config.home%' });
		const usable = new RegExp(settings['facade.home'].pattern!);
		assert.deepStrictEqual(['', '~/.facade', '/Volumes/Data/facade', 'D:\\Facade Code Extension', 'D:/Facade Code Extension', '\\\\server\\share', 'facade', './facade', '~', 'D:Facade Code Extension'].map(value => usable.test(value)),
			[true, true, true, true, true, true, false, false, false, false]);
		assert.strictEqual(english(settings['facade.home'].markdownDescription), 'The Facade home this window uses for settings, agent records, and legacy migration. '
			+ 'A path here takes precedence over `FACADE_HOME` and the `~/.facade` default.\n\n'
			+ '[Edit in facade.json](command:facade.openSettingsFile) to change YOLO, suggested names, and how CLIs start.');
		assert.strictEqual(english('%config.home.pattern%'), 'The path must start with ~/ or be absolute.');
		assert.deepStrictEqual(Object.keys(settings), ['facade.home']);
		// facade.json is checked against its schema wherever the Facade home is: the file's name is Facade Code Extension's own
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
		/** The active panel's command registry and the integration-only additions. */
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
				const { registerFrameworkUi } = withModules({ vscode: api })<typeof import('../ui/commands/index')>(require.resolve('../ui/commands/index'));
				const emitter = new TestEmitter<never>();
				const disposables = registerFrameworkUi({
					agents: { list: () => [], get: () => undefined, onDidChange: emitter.event, pins: () => [], reorderPins: () => undefined,
						open: async () => false, stop: async () => undefined, remove: async () => undefined,
						setPinned: async () => undefined, rename: async () => undefined },
					locations: { snapshot: () => ({ locations: [], folders: [], pending: false }), resolve: () => undefined,
						refresh: async () => undefined, onDidChange: emitter.event, onDidRemove: emitter.event, removalOf: () => undefined },
					pickers: {} as never,
					onDidActivate: emitter.event, openSettings: async () => undefined,
					workspaceState: { get: () => undefined, update: async () => undefined },
					extensionUri: { path: '/extension' } as never, log: { event: () => undefined },
					notifyError: assert.fail, ready: Promise.resolve(), motion: () => undefined
				});
				disposables.forEach(each => each.dispose());
			} finally {
				delete (globalThis as { FACADE_TEST_MODE?: boolean }).FACADE_TEST_MODE;
			}
			return ids;
		};

		test('the Facade Code Framework panel registers exactly its UI commands from the manifest (UX-3.2, E03)', () => {
			const expected = [...PUBLIC, ...HIDDEN].map(([id]) => id).filter(id => !OUTSIDE_PANEL.has(id));
			assert.deepStrictEqual(registered(false).sort(), expected.sort());
		});

		test('the integration build adds only state, selectRow and probe, which no manifest lists (UX-3.2)', () => {
			const shipping = new Set(registered(false));
			const extra = registered(true).filter(id => !shipping.has(id));
			assert.deepStrictEqual(extra.sort(), [...TEST_COMMANDS].sort());
			assert.ok(extra.every(id => !contributes.commands.some((each: { command: string }) => each.command === id)));
		});
	});
});
