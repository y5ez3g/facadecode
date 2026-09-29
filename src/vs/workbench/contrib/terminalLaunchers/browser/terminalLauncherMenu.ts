/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { agentIcon, AGENTS_SETTING, readConfiguredLaunchers } from '../common/terminalLaunchers.js';
import { AGENT_MENU, AGENT_MENU_GROUP, createAgentMenuActionViewItem } from './terminalLauncherActions.js';
import { ITerminalLauncherService } from './terminalLauncherService.js';

/** What an agent's command is called. The id somebody chose is the last part. */
export const OPEN_AGENT_PREFIX = 'facade.agent.open.';

/**
 * Keeps the agent menu in step with the setting.
 *
 * One command and one menu item per agent, thrown away and rebuilt whenever the setting changes,
 * because agents come and go with a dialog and a menu built once would show the list somebody had
 * when the window opened.
 */
export class TerminalLauncherMenu extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.terminalLaunchers';

	private readonly _agents = this._register(new MutableDisposable<DisposableStore>());
	/** One store per watched group and per watched part, released when that group or part goes. */
	private readonly _groups = this._register(new DisposableMap<IEditorGroup>());
	private readonly _parts = this._register(new DisposableMap<IEditorPart>());
	private readonly _refresh = new Map<IEditorGroup, () => void>();

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@ITerminalLauncherService private readonly _launcherService: ITerminalLauncherService
	) {
		super();

		// The button draws itself, for the count on its corner and the keybinding in its tooltip, which a
		// tool bar's own dropdown for a submenu has neither of
		this._register(actionViewItemService.register(MenuId.TitleBar, AGENT_MENU, createAgentMenuActionViewItem));

		this._editorGroupsService.whenReady.then(() => this._watchGroups(), onUnexpectedError);
		this._update();

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENTS_SETTING)) {
				this._update();
			}
		}));
	}

	/**
	 * Tells each editor group whether the tab in front of it is an agent's.
	 *
	 * Per group rather than once for the window: a group's title menus read that group's scoped
	 * context, so a single key set from the active editor would answer for the split beside it too.
	 *
	 * Behind `whenReady`, because a contribution this early finds no groups to watch and the group
	 * that is about to exist was never added - it was restored - so nothing would ever be bound.
	 */
	private _watchGroups(): void {
		// `whenReady` can land after the window has gone, and adding to a store that is already
		// disposed leaks what is added rather than refusing it
		if (this._store.isDisposed) {
			return;
		}

		const watchGroup = (group: IEditorGroup) => {
			const store = new DisposableStore();
			const isAgent = TerminalContextKeys.agentTerminal.bindTo(group.scopedContextKeyService);
			const refresh = () => isAgent.set(this._launcherService.isAgentTerminal(group.activeEditor?.resource));

			store.add(group.onDidActiveEditorChange(refresh));
			store.add(toDisposable(() => { isAgent.reset(); this._refresh.delete(group); }));
			this._refresh.set(group, refresh);
			this._groups.set(group, store);
			refresh();
		};

		// Every part, not just the main one: a tab dragged into its own window takes its title menus
		// with it, and a group over there reads the context of the part it landed in.
		const watchPart = (part: IEditorPart) => {
			const store = new DisposableStore();
			part.groups.forEach(watchGroup);
			store.add(part.onDidAddGroup(watchGroup));
			store.add(part.onDidRemoveGroup(group => this._groups.deleteAndDispose(group)));
			store.add(part.onWillDispose(() => {
				part.groups.forEach(group => this._groups.deleteAndDispose(group));
				this._parts.deleteAndDispose(part);
			}));
			this._parts.set(part, store);
		};

		this._editorGroupsService.parts.forEach(watchPart);
		this._register(this._editorGroupsService.onDidCreateAuxiliaryEditorPart(watchPart));

		// The tab is active before it is known to be an agent's, so every group is asked again
		this._register(this._launcherService.onDidChangeAgentTerminals(() => this._refresh.forEach(refresh => refresh())));
	}

	private _update(): void {
		// Assigning disposes the previous batch, which is what takes the old agents out of the menu
		const store = new DisposableStore();
		this._agents.value = store;

		const launchers = readConfiguredLaunchers(this._configurationService.getValue(AGENTS_SETTING));

		for (const [order, launcher] of launchers.entries()) {
			const id = `${OPEN_AGENT_PREFIX}${launcher.id}`;

			store.add(CommandsRegistry.registerCommand(id, (accessor: ServicesAccessor) =>
				accessor.get(ITerminalLauncherService).open(launcher)));

			// With the agent's logo, the icon its terminal tab will carry: the button's dropdown draws it
			// (`AgentMenuActionViewItem`), and the title bar's overflow, a context menu, leaves it out
			store.add(MenuRegistry.appendMenuItem(AGENT_MENU, {
				command: { id, title: launcher.label, icon: agentIcon(launcher.command) },
				group: AGENT_MENU_GROUP,
				order
			}));
		}
	}
}
