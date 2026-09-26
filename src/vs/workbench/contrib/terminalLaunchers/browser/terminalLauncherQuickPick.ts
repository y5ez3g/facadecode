/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { escapeIcons } from '../../../../base/common/iconLabels.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IExtUri } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputButton, IQuickInputService, IQuickPick, IQuickPickItem, ItemActivation } from '../../../../platform/quickinput/common/quickInput.js';
import { TerminalExitReason, TerminalLocation, TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { FolderColor, folderGlyphFor, folderRowNameFor, glyphInFolderColor, IWorkspaceBarCustomizationService } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { findWorktree, IWorkspaceBarRepository } from '../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { ConfirmOnKill } from '../../terminal/common/terminal.js';
import { AGENT_TERMINAL_ICON } from '../common/terminalLaunchers.js';
import { ITerminalLauncherService } from './terminalLauncherService.js';

/** A row of the agent picker: one agent's terminal. */
export interface IAgentPick extends IQuickPickItem {
	readonly instance: ITerminalInstance;
}

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

/**
 * A worktree's glyph. The bar draws a worktree as a dot of its own (`workspacebar-dot`), which lives in
 * the bar's style sheet and cannot go into a line of text; this is the glyph drawn most like it.
 */
const WORKTREE_GLYPH = Codicon.circleSmallFilled;

const closeButton: IQuickInputButton = {
	iconClass: ThemeIcon.asClassName(Codicon.close),
	tooltip: localize('agentPicker.close', "Close Agent")
};

/**
 * The agent picker's rows: every agent, in the order of the bar's rows they are on and, on one row, in
 * the order they were started - each drawn as the way to it, which `placeOf` reads off the bar.
 */
export function agentPicks(agents: readonly ITerminalInstance[], placeOf: (agent: ITerminalInstance) => IAgentPlace): IAgentPick[] {
	return agents
		.map(agent => ({ agent, place: placeOf(agent) }))
		// Instance ids count up as terminals are made, so they are the order the agents were started in
		.sort((a, b) => a.place.row - b.place.row || a.agent.instanceId - b.agent.instanceId)
		.map(({ agent, place }) => toPick(agent, place.steps));
}

/**
 * Where a folder is, drawn as the workspace bar draws it: the glyph, colour and name of its row - the
 * name somebody gave it in Customize, else its default one - and a worktree after its repository, the
 * row the bar draws it under.
 */
export function placeOfFolder(folder: IWorkspaceFolder, repository: IWorkspaceBarRepository | undefined, customizationService: Pick<IWorkspaceBarCustomizationService, 'nameFor' | 'get'>, extUri: IExtUri): IPlaceStep[] {
	const folderRow = (uri: URI, name: string): IPlaceStep => {
		const customization = customizationService.get(uri);
		return { glyph: folderGlyphFor(customization), color: customization?.color, name };
	};

	const worktree = findWorktree(repository, folder.uri, extUri);
	if (!repository || !worktree) {
		return [folderRow(folder.uri, customizationService.nameFor(folder))];
	}

	// A worktree's row is a dot in the colour the worktree was given, as in the bar (`workspaceBarView.ts`)
	return [
		folderRow(repository.main, folderRowNameFor(customizationService, repository.main, repository.folder)),
		{ glyph: WORKTREE_GLYPH, color: customizationService.get(worktree.uri)?.color, name: customizationService.nameFor(folder) }
	];
}

/** What an agent's tab says: the title the agent gave it, or before it has, the agent's name. */
function titleOf(agent: ITerminalInstance): string {
	return agent.title || agent.shellLaunchConfig.name || localize('agentPicker.untitled', "Agent");
}

/**
 * An agent's row, read as a path the way the bar is read: each row on the way to it, then the agent's
 * tab - the robot and the tab's title - and after a dot which agent it is, on every row alike, one
 * whose title is only the agent's name included.
 */
function toPick(agent: ITerminalInstance, steps: readonly IPlaceStep[]): IAgentPick {
	const title = titleOf(agent);
	const name = agent.shellLaunchConfig.name;
	const tab = name ? localize('agentPicker.titleAndAgent', "{0} \u00b7 {1}", escapeIcons(title), escapeIcons(name)) : escapeIcons(title);

	return {
		instance: agent,
		label: [...steps.map(drawStep), `$(${AGENT_TERMINAL_ICON.id}) ${tab}`].join(` $(${Codicon.chevronRight.id}) `),
		// In words: the glyphs and chevrons are drawn, and read out they would be their names
		ariaLabel: [...steps.map(step => step.name), title, name].filter(part => !!part).join(', '),
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
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IActiveFolderService activeFolderService: IActiveFolderService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@ITerminalLauncherService private readonly _launcherService: ITerminalLauncherService
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
			this._folderTerminalsService.reveal(selected.instance).then(undefined, onUnexpectedError);
		}));

		this._register(this._quickPick.onDidTriggerItemButton(({ item }) => this._close(item.instance).then(undefined, onUnexpectedError)));

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
		this._register(contextService.onDidChangeWorkspaceFolders(update));
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
		const highlighted = this._quickPick.activeItems[0]?.instance;

		// A folder's row in the bar, and past the last one for no folder
		const rows = this._workspaceBarService.rowOrder();
		const rowOf = (folder: URI | undefined) => {
			const row = folder ? rows.findIndex(candidate => this._uriIdentityService.extUri.isEqual(candidate, folder)) : -1;
			return row === -1 ? rows.length : row;
		};

		this._quickPick.items = agentPicks(agents, agent => this._placeOf(agent, rowOf));
		this._quickPick.placeholder = agents.length ? localize('agentPicker.placeholder', "Select an agent") : localize('agentPicker.empty', "No active agents");

		// The rows are new objects each time, so the one somebody was on is found again by its terminal
		const stillThere = highlighted && this._quickPick.items.find(item => item.instance === highlighted);
		if (stillThere) {
			this._quickPick.activeItems = [stillThere];
		}
	}

	/** Where an agent is: its folder as the bar draws it, on that folder's row (`rowOf`), or the panel. */
	private _placeOf(agent: ITerminalInstance, rowOf: (folder: URI | undefined) => number): IAgentPlace {
		const folder = this._folderTerminalsService.folderOf(agent);
		if (folder) {
			return {
				steps: placeOfFolder(folder, this._workspaceBarService.repositoryFor(folder.uri), this._customizationService, this._uriIdentityService.extUri),
				row: rowOf(folder.uri)
			};
		}

		// In the panel only when it is on screen there: a terminal in the background says `Panel` too
		const inPanel = agent.target === TerminalLocation.Panel && this._terminalService.foregroundInstances.includes(agent);
		return {
			steps: inPanel ? [{ glyph: Codicon.layoutPanel, name: localize('agentPicker.panel', "Panel") }] : [],
			row: rowOf(undefined)
		};
	}

	/**
	 * Ends an agent's terminal, asking first where closing its tab would: while something runs in it
	 * and `terminal.integrated.confirmOnKill` covers where it is. Its row goes with it.
	 */
	private async _close(instance: ITerminalInstance): Promise<void> {
		if (instance.hasChildProcesses && this._confirmsOnKill(instance)) {
			// Or the picker closes when the dialog takes the focus, taking the list away mid-question
			this._quickPick.ignoreFocusOut = true;
			try {
				const { confirmed } = await this._dialogService.confirm({
					type: Severity.Warning,
					message: localize('agentPicker.confirmClose', "Do you want to terminate running processes?"),
					detail: localize('agentPicker.confirmCloseDetail', "Closing {0} will terminate the running processes in it.", titleOf(instance)),
					primaryButton: localize({ key: 'agentPicker.confirmCloseButton', comment: ['&& denotes a mnemonic'] }, "&&Terminate")
				});
				if (!confirmed) {
					return;
				}
			} finally {
				this._quickPick.ignoreFocusOut = false;
			}
		}

		instance.dispose(TerminalExitReason.User);
	}

	private _confirmsOnKill(instance: ITerminalInstance): boolean {
		const confirmOnKill = this._configurationService.getValue<ConfirmOnKill>(TerminalSettingId.ConfirmOnKill);
		return confirmOnKill === 'always' || confirmOnKill === (instance.target === TerminalLocation.Editor ? 'editor' : 'panel');
	}
}
