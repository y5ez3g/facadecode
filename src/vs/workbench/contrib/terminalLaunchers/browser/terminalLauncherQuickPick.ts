/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { escapeIcons } from '../../../../base/common/iconLabels.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IExtUri } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmResult } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputButton, IQuickInputService, IQuickPick, IQuickPickItem, ItemActivation } from '../../../../platform/quickinput/common/quickInput.js';
import { TerminalExitReason, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { FolderColor, folderGlyphFor, folderRowNameFor, glyphInFolderColor, IWorkspaceBarCustomizationService, worktreeIcon, worktreeNameFor } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { findWorktree, IWorkspaceBarRepository } from '../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../terminal/browser/terminalEditorInput.js';
import { facadeRunOf, IPreparingRun, runFolderUri } from '../../facadeCommands/common/facadeRun.js';
import { AGENT_TERMINAL_ICON } from '../common/terminalLaunchers.js';
import { ITerminalLauncherService } from './terminalLauncherService.js';

/** A row of the agent picker: one agent's terminal - or an active agent with none yet, `preparing` (L3). */
export type IAgentPick = IQuickPickItem & (
	| { readonly instance: ITerminalInstance; readonly preparing?: undefined }
	| { readonly preparing: IPreparingRun; readonly instance?: undefined }
);

/** One step of the way to an agent, drawn as the workspace bar draws the row it stands for: a glyph in the row's colour, then a name. */
export interface IPlaceStep {
	readonly glyph: ThemeIcon;
	readonly color?: FolderColor;
	readonly name: string;
}

/** Where an agent is: the way to it, and how far down the bar that is. */
export interface IAgentPlace {
	readonly steps: readonly IPlaceStep[];
	/** Its row in the bar, counted from the top; past the last row for an agent on none, one in the panel say. */
	readonly row: number;
}

const closeButton: IQuickInputButton = {
	iconClass: ThemeIcon.asClassName(Codicon.close),
	tooltip: localize('agentPicker.close', "Close Agent")
};

/**
 * The agent picker's rows: every active agent - by its terminal, or, for one with none yet as its worktree is made or
 * set up, by the agent and what it is doing - in the order of the bar's rows they are on and, on one row, in the order
 * they were started: by their numbers, which count up as agents start (AGENT-LAUNCHER.md, L3). Each is drawn as the
 * way to it, which `placeOf` and `placeOfPreparing` read off the bar.
 */
export function agentPicks(agents: readonly ITerminalInstance[], preparing: readonly IPreparingRun[], placeOf: (agent: ITerminalInstance) => IAgentPlace, placeOfPreparing: (run: IPreparingRun) => IAgentPlace): IAgentPick[] {
	return [
		// A terminal of no run's by when it was made: instance ids count up as terminals are made
		...agents.map(agent => ({ place: placeOf(agent), number: facadeRunOf(agent)?.id ?? Number.MAX_SAFE_INTEGER, made: agent.instanceId, pick: (steps: readonly IPlaceStep[]) => toPick(agent, steps) })),
		...preparing.map(run => ({ place: placeOfPreparing(run), number: run.id, made: Number.MAX_SAFE_INTEGER, pick: (steps: readonly IPlaceStep[]) => toPreparingPick(run, steps) }))
	]
		.sort((a, b) => a.place.row - b.place.row || a.number - b.number || a.made - b.made)
		.map(({ place, pick }) => pick(place.steps));
}

/** The row of an active agent with no terminal yet: the way to its worktree where it has one, then the agent and what it is doing. */
function toPreparingPick(run: IPreparingRun, steps: readonly IPlaceStep[]): IAgentPick {
	const doing = run.phase === 'creating_worktree' ? localize('agentPicker.creatingWorktree', "creating its worktree") : localize('agentPicker.runningSetup', "setting up its worktree");
	const agent = `@${run.name} #a${run.id}`;
	return {
		preparing: run,
		label: [...steps.map(drawStep), `$(${Codicon.loading.id}~spin) ${localize('agentPicker.preparing', "{0} \u00b7 {1}", escapeIcons(agent), doing)}`].join(` $(${Codicon.chevronRight.id}) `),
		ariaLabel: [...steps.map(step => step.name), agent, doing].join(', '),
		buttons: [closeButton]
	};
}

/**
 * Where the folder at `uri` is, drawn as the workspace bar draws it: the glyph, colour and name of its
 * row - the name somebody gave it in Customize, else its default one - and a worktree after its
 * repository, the row the bar draws it under, whether or not it has joined the workspace.
 * `workspaceFolder` is the workspace's folder there, when there is one.
 */
export function placeOfFolder(uri: URI, workspaceFolder: IWorkspaceFolder | undefined, repository: IWorkspaceBarRepository | undefined, customizationService: Pick<IWorkspaceBarCustomizationService, 'nameFor' | 'get'>, extUri: IExtUri): IPlaceStep[] {
	const folderRow = (at: URI, name: string): IPlaceStep => {
		const customization = customizationService.get(at);
		return { glyph: folderGlyphFor(customization), color: customization?.color, name };
	};

	const worktree = findWorktree(repository, uri, extUri);
	if (!repository || !worktree) {
		return [folderRow(uri, folderRowNameFor(customizationService, uri, workspaceFolder))];
	}

	// A worktree's row is its glyph in the colour the worktree was given, as in the bar (`workspaceBarView.ts`)
	return [
		folderRow(repository.main, folderRowNameFor(customizationService, repository.main, repository.folder)),
		{ glyph: worktreeIcon, color: customizationService.get(worktree.uri)?.color, name: worktreeNameFor(customizationService, worktree) }
	];
}

/**
 * Which agent a tab is, and what else it says: the terminal's own title - the one the person renamed it to, where
 * they did, else its CLI's - without the agent it ends with as an agent's tab is titled, `${sequence}${separator}`
 * and the agent (N-22; AGENT-LAUNCHER.md, L3: a renamed terminal keeps the agent suffix); none where the tab has no
 * title of its own yet. A terminal with no agent's name is its title alone.
 */
function tabOf(agent: ITerminalInstance): { readonly agent: string; readonly title: string } {
	const title = agent.title.trim();
	const name = agent.shellLaunchConfig.name;
	if (!name) {
		return { agent: '', title: title || localize('agentPicker.untitled', "Agent") };
	}
	return { agent: name, title: title.endsWith(name) ? title.slice(0, -name.length).replace(/\s*[-\u00b7]?\s*$/, '') : title };
}

/**
 * An agent's row, read as a path the way the bar is read: each row on the way to it, then the agent's
 * tab - the glyph its tab has, which agent it is, then its title (`tabOf`): the agent first, so that a long
 * title the row cuts never takes the agent's name and number with it (AGENT-LAUNCHER.md, L3).
 */
function toPick(agent: ITerminalInstance, steps: readonly IPlaceStep[]): IAgentPick {
	const tab = tabOf(agent);
	const text = tab.agent && tab.title ? localize('agentPicker.agentAndTitle', "{0} \u00b7 {1}", tab.agent, tab.title) : tab.agent || tab.title;
	// The tab's own glyph, so the row shows the mark the tab does; the robot for one that has none
	const glyph = ThemeIcon.isThemeIcon(agent.icon) ? agent.icon : AGENT_TERMINAL_ICON;

	return {
		instance: agent,
		label: [...steps.map(drawStep), `$(${glyph.id}) ${escapeIcons(text)}`].join(` $(${Codicon.chevronRight.id}) `),
		// In words, in the same order: the glyphs and chevrons are drawn, and read out they would be their names
		ariaLabel: [...steps.map(step => step.name), ...[tab.agent, tab.title].filter(part => part)].join(', '),
		buttons: [closeButton]
	};
}

/** A step as the bar draws its row: the glyph in the row's colour, then the name - as the text it is, not the icons it might spell. */
function drawStep(step: IPlaceStep): string {
	return `$(${glyphInFolderColor(step.glyph, step.color).id}) ${escapeIcons(step.name)}`;
}

/**
 * Every active agent in the window, whichever folder it is in, to go to one or to close it.
 *
 * Made the way the browser's tab picker is (`browserTabManagementFeatures.ts`): a close button on each
 * row, and kept up to date while it is open. Going to an agent in another folder moves the window onto
 * that folder first, as a click on its row in the bar does.
 */
export class TerminalLauncherQuickPick extends Disposable {

	private readonly _quickPick: IQuickPick<IAgentPick>;

	/**
	 * Updates gathered up, into at most one rebuild a tenth of a second: an agent at work retitles its
	 * tab many times a second, and a picker that rebuilt on each one would redraw under the pointer.
	 */
	private readonly _update = this._register(new RunOnceScheduler(() => this._fill(), 100));

	constructor(
		@IQuickInputService quickInputService: IQuickInputService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IFolderTerminalsService private readonly _folderTerminalsService: IFolderTerminalsService,
		@IWorkspaceBarService private readonly _workspaceBarService: IWorkspaceBarService,
		@IWorkspaceBarCustomizationService private readonly _customizationService: IWorkspaceBarCustomizationService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IEditorService private readonly _editorService: IEditorService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IActiveFolderService activeFolderService: IActiveFolderService,
		@ITerminalLauncherService private readonly _launcherService: ITerminalLauncherService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService
	) {
		super();

		this._quickPick = this._register(quickInputService.createQuickPick<IAgentPick>());
		this._quickPick.sortByLabel = false;
		// No row until somebody moves to one, or they are at an agent: a highlighted first row would
		// read as the agent they are at
		this._quickPick.itemActivation = ItemActivation.NONE;

		this._register(this._quickPick.onDidAccept(() => {
			const [selected] = this._quickPick.selectedItems;
			if (!selected) {
				return;
			}

			this._quickPick.hide();
			if (selected.instance) {
				this._folderTerminalsService.reveal(selected.instance).then(undefined, onUnexpectedError);
			} else if (selected.preparing.folder) {
				// Its worktree, where its setup runs: as a click on its row in the bar goes there
				this._workspaceBarService.show(runFolderUri(selected.preparing.folder, this._environmentService.remoteAuthority)).then(undefined, onUnexpectedError);
			}
		}));

		this._register(this._quickPick.onDidTriggerItemButton(({ item }) => {
			if (item.instance) {
				this._close(item.instance).then(undefined, onUnexpectedError);
			} else {
				this._launcherService.stopPreparing(item.preparing.id).then(undefined, onUnexpectedError);
			}
		}));

		// An agent starting, ending or retitling itself; the window moving between folders, which puts
		// agents away and shows them again; folders added, removed or moved; and a folder renamed,
		// recoloured or its worktrees reordered in Customize.
		// ⚠️ Scheduled once, not again on every change: `schedule` starts the wait over, and agents that
		// retitle more often than it - a spinner, or two at work - would keep the rows from ever refreshing
		const update = () => {
			if (!this._update.isScheduled()) {
				this._update.schedule();
			}
		};
		this._register(this._launcherService.onDidChangeAgentTerminals(update));
		this._register(this._terminalService.onAnyInstanceTitleChange(update));
		this._register(activeFolderService.onDidChangeActiveFolder(update));
		this._register(this._contextService.onDidChangeWorkspaceFolders(update));
		this._register(this._customizationService.onDidChange(update));

		this._register(this._quickPick.onDidHide(() => this.dispose()));
	}

	show(): void {
		this._fill();

		// On the agent somebody is at, and otherwise on none in particular
		const current = this._currentAgent();
		const pick = current && this._quickPick.items.find(item => item.instance === current);
		if (pick) {
			this._quickPick.activeItems = [pick];
		}

		this._quickPick.show();
	}

	/**
	 * The terminal somebody is at: the one with the focus, else the one whose tab is in front. Not the
	 * terminal service's active one, which stays the last terminal used while somebody is in a browser.
	 */
	private _currentAgent(): ITerminalInstance | undefined {
		const active = this._terminalService.activeInstance;
		if (active?.hasFocus) {
			return active;
		}

		return this._terminalService.getInstanceFromResource(this._editorService.activeEditor?.resource);
	}

	private _fill(): void {
		const agents = this._launcherService.agentTerminals;
		const preparing = this._launcherService.preparingAgents;
		const highlighted = this._quickPick.activeItems[0];

		// A folder's row in the bar, and past the last one for no folder
		const rows = this._workspaceBarService.rowOrder();
		const rowOf = (folder: URI | undefined) => {
			const row = folder ? rows.findIndex(candidate => this._uriIdentityService.extUri.isEqual(candidate, folder)) : -1;
			return row === -1 ? rows.length : row;
		};

		this._quickPick.items = agentPicks(agents, preparing, agent => this._placeOf(agent, rowOf), run => this._placeOfFolder(run.folder !== undefined ? runFolderUri(run.folder, this._environmentService.remoteAuthority) : undefined, rowOf));
		this._quickPick.placeholder = agents.length || preparing.length ? localize('agentPicker.placeholder', "Select an agent") : localize('agentPicker.empty', "No active agents");

		// The rows are new objects each time, so the one somebody was on is found again by its terminal, or its number
		const stillThere = highlighted && this._quickPick.items.find(item => highlighted.instance ? item.instance === highlighted.instance : item.preparing?.id === highlighted.preparing?.id);
		if (stillThere) {
			this._quickPick.activeItems = [stillThere];
		}
	}

	/** Where the folder `folder` is, as the bar draws it, on its row (`rowOf`); past the last row for none. */
	private _placeOfFolder(folder: URI | undefined, rowOf: (folder: URI | undefined) => number): IAgentPlace {
		if (!folder) {
			return { steps: [], row: rowOf(undefined) };
		}
		const extUri = this._uriIdentityService.extUri;
		const workspaceFolder = this._contextService.getWorkspace().folders.find(candidate => extUri.isEqual(candidate.uri, folder));
		return {
			steps: placeOfFolder(folder, workspaceFolder, this._workspaceBarService.repositoryFor(folder), this._customizationService, extUri),
			row: rowOf(folder)
		};
	}

	/** Where an agent is: its folder as the bar draws it, on that folder's row (`rowOf`), or the panel. */
	private _placeOf(agent: ITerminalInstance, rowOf: (folder: URI | undefined) => number): IAgentPlace {
		const folder = this._folderTerminalsService.folderOf(agent);
		if (folder) {
			return this._placeOfFolder(folder, rowOf);
		}

		// In the panel only when it is on screen there: a terminal in the background says `Panel` too
		const inPanel = agent.target === TerminalLocation.Panel && this._terminalService.foregroundInstances.includes(agent);
		return {
			steps: inPanel ? [{ glyph: Codicon.layoutPanel, name: localize('agentPicker.panel', "Panel") }] : [],
			row: rowOf(undefined)
		};
	}

	/**
	 * Ends an agent's terminal the way VS Code closes it where it is, so that its own confirmation - by
	 * `terminal.integrated.confirmOnKill`, in its own words - is the one asked (AGENT-LAUNCHER.md, L6): its tab in
	 * the editor area closed through the editor service, as closing the tab does; one of the editor area whose tab was
	 * put away with its folder asked as closing its tab asks, and ended only if confirmed; one in the panel as Kill
	 * Terminal ends it. Its row goes with it.
	 */
	private async _close(instance: ITerminalInstance): Promise<void> {
		// Or the picker closes when a dialog takes the focus, taking the list away mid-question
		this._quickPick.ignoreFocusOut = true;
		const store = new DisposableStore();
		try {
			const tabs = this._editorService.findEditors(instance.resource);
			if (tabs.length) {
				await this._editorService.closeEditors(tabs);
			} else if (instance.target === TerminalLocation.Editor) {
				// Kill Terminal leaves an editor-area terminal's confirmation to its tab, and this one has none open
				if (await this._confirmsClosingTab(instance)) {
					instance.dispose(TerminalExitReason.User);
				}
			} else {
				// Done once it is closed: Kill Terminal's own end waits for the process to exit, which one that exited
				// already - its tab kept open - does not again
				await Promise.race([this._terminalService.safeDisposeTerminal(instance), Event.toPromise(instance.onDisposed, store)]);
			}
		} finally {
			store.dispose();
			this._quickPick.ignoreFocusOut = false;
		}
	}

	/**
	 * Whether `instance`, a terminal of the editor area with no tab open - put away with its folder - is to be closed:
	 * asked by an editor input of its own, as closing its tab would ask. VS Code asks about such a terminal nowhere
	 * else; the question does not use the group it is given.
	 */
	private async _confirmsClosingTab(instance: ITerminalInstance): Promise<boolean> {
		const input = this._instantiationService.createInstance(TerminalEditorInput, instance.resource, instance);
		try {
			return !input.showConfirm() || await input.confirm([{ editor: input, groupId: this._editorGroupsService.activeGroup.id }]) !== ConfirmResult.CANCEL;
		} finally {
			// It only asked: let go of the terminal before the input goes, or disposing the input would end it. Letting go
			// does nothing else to a terminal put away: it was taken off its element as it was put away, and the parent of
			// its context keys is set to the window's, as putting it away set it - its group's again once it is shown in
			// an editor (`TerminalEditorInput.setGroup`)
			input.detachInstance();
			input.dispose();
		}
	}
}
