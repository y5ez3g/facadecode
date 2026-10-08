/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpression, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { agentIcon, BUILT_IN_LAUNCHERS, CUSTOM_AGENTS_SETTING, ITerminalLauncher, readCustomAgents } from '../common/terminalLaunchers.js';
import { AGENT_MENU, AGENT_MENU_GROUP, CONFIGURE_AGENTS, createAgentMenuActionViewItem } from './terminalLauncherActions.js';
import { ITerminalLauncherService } from './terminalLauncherService.js';

/** What an agent's command is called: a built-in's id, or `custom.` and a custom agent's name, is the last part. */
export const OPEN_AGENT_PREFIX = 'facade.agent.open.';

/** Whether this machine has a built-in, and the person offers it, by its id: what puts it in the menu. */
function availableKey(id: string): RawContextKey<boolean> {
	return new RawContextKey<boolean>(`facadeAgentAvailable.${id}`, false);
}

/** The glyph of the line an empty menu has in place of agents. */
const AGENT_EMPTY_ICON = Codicon.info;

/** Whether the menu has no agent to offer: no built-in found, and no custom agent. */
const NO_AGENTS = new RawContextKey<boolean>('facadeNoAgents', false);

/**
 * Keeps the agent menu in step with this machine and the settings (AGENT-LAUNCHER.md, L3): the built-ins it
 * has and the person offers, in the menu's order, then the person's custom agents in theirs - listed found
 * or not, for choosing one to say what is wrong - and, with none of either, a line that says so above
 * Configure Agents. The built-ins are looked for again as the menu opens, as the settings change, and as
 * the window comes back to the front: nothing found is written into the settings.
 */
export class TerminalLauncherMenu extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.terminalLaunchers';

	private readonly _agents = this._register(new MutableDisposable<DisposableStore>());
	private readonly _available: ReadonlyMap<string, IContextKey<boolean>>;
	private readonly _none: IContextKey<boolean>;
	/** Whether the built-ins have been looked for once: until then the menu says nothing of having none. */
	private _looked = false;
	/** One store per watched group and per watched part, released when that group or part goes. */
	private readonly _groups = this._register(new DisposableMap<IEditorGroup>());
	private readonly _parts = this._register(new DisposableMap<IEditorPart>());
	private readonly _refresh = new Map<IEditorGroup, () => void>();

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@ITerminalLauncherService private readonly _launcherService: ITerminalLauncherService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService
	) {
		super();

		// The button draws itself, for the count on its corner and the keybinding in its tooltip, which a
		// tool bar's own dropdown for a submenu has neither of
		this._register(actionViewItemService.register(MenuId.TitleBar, AGENT_MENU, createAgentMenuActionViewItem));

		this._editorGroupsService.whenReady.then(() => this._watchGroups(), onUnexpectedError);

		this._available = new Map(BUILT_IN_LAUNCHERS.map(launcher => [launcher.id, availableKey(launcher.id).bindTo(contextKeyService)]));
		this._none = NO_AGENTS.bindTo(contextKeyService);
		this._registerBuiltIns();
		this._update();
		this._register(this._launcherService.onDidChangeAvailable(() => this._showAvailable()));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CUSTOM_AGENTS_SETTING)) {
				this._update();
			}
			if (e.affectsConfiguration('facade.agents')) {
				this._launcherService.refreshAvailable().catch(onUnexpectedError);
			}
		}));
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused) {
				this._launcherService.refreshAvailable().catch(onUnexpectedError);
			}
		}));
		this._launcherService.refreshAvailable().then(() => {
			this._looked = true;
			this._showAvailable();
		}, onUnexpectedError);
	}

	/** The built-ins, each a command and a row shown while this machine has it and the person offers it. */
	private _registerBuiltIns(): void {
		for (const [order, launcher] of BUILT_IN_LAUNCHERS.entries()) {
			this._registerAgent(this._store, launcher, `${OPEN_AGENT_PREFIX}${launcher.id}`, order, availableKey(launcher.id).isEqualTo(true));
		}

		this._register(MenuRegistry.appendMenuItem(AGENT_MENU, {
			command: { id: CONFIGURE_AGENTS, title: localize('facade.agent.noneFound', "No Agents Found: Configure Agents..."), icon: AGENT_EMPTY_ICON },
			group: AGENT_MENU_GROUP,
			order: 0,
			when: NO_AGENTS.isEqualTo(true)
		}));
	}

	/** A command that starts `launcher`, and its row in the menu. */
	private _registerAgent(store: DisposableStore, launcher: ITerminalLauncher, id: string, order: number, when: ContextKeyExpression | undefined): void {
		store.add(CommandsRegistry.registerCommand(id, (accessor: ServicesAccessor) =>
			accessor.get(ITerminalLauncherService).open(launcher)));

		// With the agent's logo, the icon its terminal tab will carry: the button's dropdown draws it
		// (`AgentMenuActionViewItem`), and the title bar's overflow, a context menu, leaves it out
		store.add(MenuRegistry.appendMenuItem(AGENT_MENU, {
			command: { id, title: launcher.label, icon: agentIcon(launcher.command) },
			group: AGENT_MENU_GROUP,
			order,
			when
		}));
	}

	/** The built-ins as last found, and whether the menu has nothing to offer. */
	private _showAvailable(): void {
		const available = this._launcherService.available;
		for (const [id, key] of this._available) {
			key.set(available.has(id));
		}
		this._none.set(this._looked && available.size === 0 && readCustomAgents(this._configurationService.getValue(CUSTOM_AGENTS_SETTING)).length === 0);
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

	/**
	 * The person's custom agents, thrown away and made again as their setting changes: after the built-ins,
	 * in the order they wrote them.
	 */
	private _update(): void {
		// Assigning disposes the previous batch, which is what takes the old agents out of the menu
		const store = new DisposableStore();
		this._agents.value = store;

		for (const [order, launcher] of readCustomAgents(this._configurationService.getValue(CUSTOM_AGENTS_SETTING)).entries()) {
			this._registerAgent(store, launcher, `${OPEN_AGENT_PREFIX}custom.${launcher.id}`, BUILT_IN_LAUNCHERS.length + order, undefined);
		}
		this._showAvailable();
	}
}
