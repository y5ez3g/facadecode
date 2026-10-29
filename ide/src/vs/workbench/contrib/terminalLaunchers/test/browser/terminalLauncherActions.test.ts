/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuMenuDelegate, IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { INotificationService, NotificationMessage } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IFacadeRunsService } from '../../../facadeCommands/browser/facadeRuns.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { AGENT_MENU_GROUP, agentMenuRows, ShowAgentMenuAction, StartAgentRestrictedAction } from '../../browser/terminalLauncherActions.js';
import { ITerminalLauncherService, TerminalLauncherService } from '../../browser/terminalLauncherService.js';
import { agentIcon } from '../../common/terminalLaunchers.js';

/** Runs every command, except the one that fails and the one somebody cancels. */
class TestCommandService extends mock<ICommandService>() {

	readonly ran: string[] = [];

	override async executeCommand<R>(id: string): Promise<R | undefined> {
		if (id === 'fails') {
			throw new Error('No shell to start the agent in');
		}
		if (id === 'cancelled') {
			throw new CancellationError();
		}
		this.ran.push(id);
		return undefined;
	}
}

class TestNotificationService extends mock<INotificationService>() {

	readonly errors: NotificationMessage[] = [];

	override error(message: NotificationMessage): void {
		this.errors.push(message);
	}
}

suite('Agent menu - the dropdown the agent button opens', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const contextKeyService = new class extends mock<IContextKeyService>() { };

	function row(commandService: ICommandService, id: string, title: string, icon?: ThemeIcon): MenuItemAction {
		return new MenuItemAction({ id, title, icon }, undefined, undefined, undefined, undefined, contextKeyService, commandService);
	}

	test('the agents above the line, each with its logo, and the rest of the menu below it', () => {
		const commandService = new TestCommandService();

		const { agents, rest } = agentMenuRows([
			[AGENT_MENU_GROUP, [row(commandService, 'claude', 'Claude Code', agentIcon('claude')), row(commandService, 'mine', 'My Agent', agentIcon('my-agent --fast'))]],
			['z_configure', [row(commandService, 'active', 'Show Active Agents...'), row(commandService, 'configure', 'Configure Agents...')]]
		], new TestNotificationService());

		assert.deepStrictEqual(agents.map(agent => [agent.label, agent.icon?.id]), [['Claude Code', 'agent-claude'], ['My Agent', 'robot']]);
		assert.deepStrictEqual(rest.map(other => other.label), ['Show Active Agents...', 'Configure Agents...']);
	});

	test('a row runs its command, and one that fails says so - as a row of a context menu does - unless it was cancelled', async () => {
		const commandService = new TestCommandService();
		const notificationService = new TestNotificationService();

		const { agents } = agentMenuRows([
			[AGENT_MENU_GROUP, [row(commandService, 'claude', 'Claude Code'), row(commandService, 'fails', 'Codex'), row(commandService, 'cancelled', 'Grok Build')]]
		], notificationService);
		await Promise.all(agents.map(agent => agent.run()));

		assert.deepStrictEqual(commandService.ran, ['claude']);
		assert.deepStrictEqual(notificationService.errors.map(error => error instanceof Error ? error.message : error), ['No shell to start the agent in']);
	});
});

suite('Agent menu - Show Agent Menu', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('with no button on screen - a native or hidden title bar, or the button put away in the title bar\'s overflow - it looks for the built-ins before it opens the menu as a context menu, so that what it finds is in it; a look that takes longer than a moment is not waited for (AGENT-LAUNCHER.md, L3; LA-08)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const steps: string[] = [];
		let look = new DeferredPromise<void>();
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITerminalLauncherService, {
			showMenu: () => false,
			refreshAvailable: () => {
				steps.push('look for the built-ins');
				return look.p;
			}
		});
		instantiationService.stub(IWorkbenchLayoutService, { isVisible: () => false });
		instantiationService.stub(IContextKeyService, store.add(new MockContextKeyService()));
		instantiationService.stub(IContextMenuService, { showContextMenu: delegate => { steps.push(`open ${(delegate as IContextMenuMenuDelegate).menuId?.id}`); } });
		const showAgentMenu = () => instantiationService.invokeFunction(accessor => new ShowAgentMenuAction().run(accessor));

		const opening = showAgentMenu();
		await Promise.resolve();
		const whileLooking = [...steps];
		look.complete();
		await opening;
		const found = steps.splice(0);
		look = new DeferredPromise<void>();
		await showAgentMenu();

		assert.deepStrictEqual({ whileLooking, found, slow: steps }, {
			whileLooking: ['look for the built-ins'],
			found: ['look for the built-ins', 'open FacadeAgentMenu'],
			slow: ['look for the built-ins', 'open FacadeAgentMenu'],
		});
	}));
});

suite('Agent menu - Start Agent... in Restricted Mode', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Start Agent... run in Restricted Mode, VS Code's question whether to trust the workspace answered with `answer`: what it asked and ran. */
	async function startAgentRestricted(answer: boolean): Promise<string[]> {
		const ran: string[] = [];
		const instantiationService = store.add(new TestInstantiationService());
		// The agent menu's service, as far as a start goes
		instantiationService.stub(ITerminalService, { onDidChangeInstances: Event.None, onDidDisposeInstance: Event.None, onAnyInstanceIconChange: Event.None, onDidCreateInstance: Event.None, whenConnected: Promise.resolve(), instances: [] });
		instantiationService.stub(IFacadeRunsService, { onDidChangeLive: Event.None, whenRestored: Promise.resolve() });
		instantiationService.stub(IStorageService, store.add(new TestStorageService()));
		instantiationService.stub(ILifecycleService, { when: async () => { } });
		instantiationService.stub(IActiveFolderService, { activeFolder: undefined });
		instantiationService.stub(IWorkspaceTrustManagementService, { isWorkspaceTrusted: () => false });
		instantiationService.stub(IWorkspaceTrustRequestService, {
			requestWorkspaceTrust: async options => {
				ran.push(`asked "${options?.message}"`);
				return answer;
			}
		});
		instantiationService.stub(ICommandService, {
			executeCommand: async (id: string, ...args: unknown[]) => {
				ran.push(`${id} ${JSON.stringify(args)}`);
				return undefined;
			}
		});
		instantiationService.stub(ITerminalLauncherService, store.add(instantiationService.createInstance(TerminalLauncherService)));
		await instantiationService.invokeFunction(accessor => new StartAgentRestrictedAction().run(accessor));
		return ran;
	}

	test('asks VS Code\'s question whether to trust the workspace first, as the agent menu does, and runs the extension\'s own Start Agent... once the person trusts it; nothing once they do not (AGENT-LAUNCHER.md, L3)', async () => {
		const asked = 'asked "An agent works in the folders of this workspace. Trust the workspace to start one."';

		assert.deepStrictEqual({ trusted: await startAgentRestricted(true), notTrusted: await startAgentRestricted(false) }, {
			trusted: [asked, 'facade.agents.startAgent []'],
			notTrusted: [asked]
		});
	});
});
