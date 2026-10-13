/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebarpart.css';
import { $, append } from '../../../../base/browser/dom.js';
import { ISerializedNode, LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { coalesce } from '../../../../base/common/arrays.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event, Relay } from '../../../../base/common/event.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { Part } from '../../part.js';
import { FACADE_BAR_BACKGROUND, FACADE_BAR_BORDER, FACADE_BAR_FOREGROUND } from './workspaceBarColors.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { URI } from '../../../../base/common/uri.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
// Imported for its `registerAction2` calls as much as for the menu id.
import { areWorktreesShown, SHOW_WORKTREES, WorkspaceBarCollapsedContext, WorkspaceBarTitleMenu } from './workspaceBarActions.js';
import { moveRow, rowsOfFolders } from './workspaceBar.js';
import { IWorkspaceBarCustomizationService } from './workspaceBarCustomization.js';
import { IWorkspaceBarRepository, WorkspaceBarGit } from './workspaceBarGit.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';
import { IRemoveOptions, IWorkspaceBarService, RemoveResult, ShowResult } from './workspaceBarService.js';
import { WorkspaceBarRemoval } from './workspaceBarRemoval.js';
import { WorkspaceBarEditors } from './workspaceBarEditors.js';
import { WorkspaceBarSwitcher } from './workspaceBarSwitcher.js';
import { ROW_HEIGHT, WorkspaceBarView } from './workspaceBarView.js';

/** The width the bar opens at and the narrowest it can be dragged to. Measured: 219 and a divider. */
export const WORKSPACEBAR_WIDTH = 220;

/**
 * The header is one row of the list, open and collapsed alike. Kept with the stylesheet's
 * `.workspacebar-header` height, which the list is laid out below.
 */
const HEADER_HEIGHT = ROW_HEIGHT;

const WORKSPACEBAR_MAXIMUM_WIDTH = 480;

/**
 * What the bar is when it is collapsed.
 *
 * ⚠️ 36, the compact activity bar's width, and it is not an arbitrary match. Measured: a folder
 * icon's centre sits at x=18 in this column and an activity bar glyph's centre sits at x=18 in that
 * one, so collapsing to 36 leaves every icon exactly where it was. The row's padding needs no
 * collapsed variant of its own - 10 on the left plus a 16px glyph is already dead centre of 36.
 */
export const WORKSPACEBAR_COLLAPSED_WIDTH = 36;

const COLLAPSED_STORAGE_KEY = 'facade.workspaceBar.collapsed';

/**
 * Whether the grid has the workspace bar as the middle row's first column, which every hard-coded
 * grid coordinate in `layout.ts` rests on: the root is title, banner, middle row, status bar, and
 * the middle row is where upstream's `[2, ...]` coordinates point. Asked of the grid that was built,
 * not of the descriptor it was built from.
 */
export function isWorkspaceBarFirstInMiddleRow(root: ISerializedNode | undefined): boolean {
	if (root?.type !== 'branch') {
		return false;
	}

	const middle = root.data[2];
	if (middle?.type !== 'branch') {
		return false;
	}

	const first = middle.data[0];
	return first?.type === 'leaf' && (first.data as { type?: Parts } | undefined)?.type === Parts.WORKSPACEBAR_PART;
}

/**
 * The workspace bar: the middle row's first column, between the title bar and the status bar. The
 * shell only - what a folder is belongs to `WorkspaceBarModel`, switching to `WorkspaceBarSwitcher`,
 * how one looks to `WorkspaceBarView`.
 */
export class WorkspaceBarPart extends Part implements IWorkspaceBarService {

	declare readonly _serviceBrand: undefined;

	/**
	 * ⚠️ Getters, not fields: collapsing pins the column to one width, and the grid only asks
	 * again when `_onDidChange` fires. A field read once at construction is a bar that keeps its old
	 * width and hides its labels inside it.
	 */
	get minimumWidth(): number { return this.collapsed ? WORKSPACEBAR_COLLAPSED_WIDTH : WORKSPACEBAR_WIDTH; }
	get maximumWidth(): number { return this.collapsed ? WORKSPACEBAR_COLLAPSED_WIDTH : WORKSPACEBAR_MAXIMUM_WIDTH; }
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	/** Low, like the side bar and the auxiliary bar: the editor takes what the window gains or loses. */
	readonly priority: LayoutPriority = LayoutPriority.Low;

	private content: HTMLElement | undefined;

	private _collapsed = false;
	/** What the title bar's toggle says it will do (`WorkspaceBarCollapsedContext`). */
	private readonly collapsedContext: IContextKey<boolean>;
	get collapsed(): boolean { return this._collapsed; }

	private readonly _onDidChangeCollapsed = this._register(new Emitter<void>());
	readonly onDidChangeCollapsed = this._onDidChangeCollapsed.event;

	private readonly model: WorkspaceBarModel;
	private readonly git: WorkspaceBarGit;
	private view: WorkspaceBarView | undefined;
	private editors: WorkspaceBarEditors | undefined;
	private switcher: WorkspaceBarSwitcher | undefined;

	/** Made on the first removal: what it asks of the workbench need not exist while the part is being built. */
	private _removal: WorkspaceBarRemoval | undefined;
	private get removal(): WorkspaceBarRemoval {
		this._removal ??= this.instantiationService.createInstance(WorkspaceBarRemoval, this.model, (uri: URI) => this.repositoryFor(uri));
		return this._removal;
	}

	// A relay because the switcher is created in `createContentArea`, after a listener can arrive
	private readonly _onDidRestoreEditors = this._register(new Relay<void>());
	readonly onDidRestoreEditors = this._onDidRestoreEditors.event;

	readonly onDidChangeRepositories: Event<void>;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkspaceBarCustomizationService customizationService: IWorkspaceBarCustomizationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IHostService private readonly hostService: IHostService,
	) {
		super(
			Parts.WORKSPACEBAR_PART,
			{
				hasTitle: false,
				// Without this the content is laid out at the full width while the border eats a
				// pixel of it, and the last pixel of every row sits under the border. `sidebarPart.ts`
				// declares the same thing for the same reason.
				borderWidth: () => (this.getColor(FACADE_BAR_BORDER) || this.getColor(contrastBorder)) ? 1 : 0
			},
			themeService, storageService, layoutService);

		// ⚠️ Read here, before the grid asks what this column's width may be. Restored in `layout`
		// instead, the first layout happens at the open width and the column snaps a frame later.
		//
		// Collapsed until somebody opens it: a profile that has never touched the toggle starts with
		// the column of icons, and the choice is remembered from the first time it is made.
		this._collapsed = this.storageService.getBoolean(COLLAPSED_STORAGE_KEY, StorageScope.PROFILE, true);
		this.collapsedContext = WorkspaceBarCollapsedContext.bindTo(contextKeyService);
		this.collapsedContext.set(this._collapsed);

		// Built here rather than with the content area: an action can run before anything has been
		// drawn, and "add a folder" has nothing to do with whether the bar has been laid out.
		this.model = this._register(this.instantiationService.createInstance(WorkspaceBarModel));

		// Repositories and their worktrees from git's own files, read before the first drawing (WORKTREE.md WT-3)
		const model = this.model;
		this.git = this._register(this.instantiationService.createInstance(WorkspaceBarGit, {
			get folders() { return areWorktreesShown(configurationService) ? model.folders : []; },
			onDidChange: Event.any(model.onDidChange, Event.signal(Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(SHOW_WORKTREES)))),
			key: model.key
		}));
		// Switching worktrees off is a read too: one of no folders
		this.onDidChangeRepositories = this.git.onDidChange;

		// WT-1.12: a worktree in folders[] that nobody has named is called by its branch - in the window's
		// title as in the bar, both through `nameFor`. Named at once from the groups kept from the last
		// window as well (WT-3.7): a first read that finds the same fires nothing.
		const setDefaultNames = () => customizationService.setDefaultNames(this.git.groups.flatMap(group => group.kind === 'repository'
			? coalesce(group.worktrees.map(worktree => worktree.folder && { uri: worktree.folder.uri, name: worktree.label }))
			: []));
		setDefaultNames();
		this._register(this.git.onDidChange(setDefaultNames));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		// Must come first: the grid reads `view.element`.
		this.element = parent;
		this.content = append(this.element, $('.content'));

		if (this._collapsed) {
			this.element.classList.add('collapsed');
		}

		const header = append(this.content, $('.workspacebar-header'));
		append(header, $('span.workspacebar-title')).textContent = localize('workspaceBar.title', "Workspace");

		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar,
			append(header, $('.workspacebar-actions')),
			WorkspaceBarTitleMenu,
			{
				orientation: ActionsOrientation.HORIZONTAL,
				toggleMenuTitle: localize('workspaceBar.moreActions', "More Actions...")
			}
		));

		// Built here and handed in rather than made inside the switcher, so that what stores a
		// folder's editors can be replaced in a test.
		this.editors = this._register(this.instantiationService.createInstance(WorkspaceBarEditors));
		this._register(this.model.onDidChange(() => this.pruneEditors()));
		this.pruneEditors();
		this.switcher = this._register(this.instantiationService.createInstance(WorkspaceBarSwitcher, this.model, this.editors));
		this._onDidRestoreEditors.input = this.switcher.onDidRestoreEditors;
		// `show` handed in rather than resolved as `IWorkspaceBarService`: this part is that service,
		// and the view is built while the part is being created.
		this.view = this._register(this.instantiationService.createInstance(WorkspaceBarView,
			this.content, this.model, this.git, this.switcher, () => this.collapsed, this.onDidChangeCollapsed, async (uri: URI) => { await this.show(uri); }));

		return this.content;
	}

	/**
	 * Collapses the bar to a column of icons, or opens it again.
	 *
	 *  + W +  The width is pinned rather than merely suggested: both constraints return the same number
	 * while collapsed, so nothing can drag the column open by its edge and leave it half a bar wide
	 * with its labels clipped. The width somebody had chosen is remembered by `layout.ts` under
	 * `WORKSPACEBAR_SIZE` and comes back when the constraints widen again.
	 */
	toggleCollapsed(): void {
		this.setCollapsed(!this._collapsed);
	}

	private setCollapsed(collapsed: boolean): void {
		if (this._collapsed === collapsed) {
			return;
		}

		this._collapsed = collapsed;
		this.collapsedContext.set(collapsed);

		this.storageService.store(COLLAPSED_STORAGE_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
		this.element?.classList.toggle('collapsed', collapsed);
		this._onDidChangeCollapsed.fire();

		//  + W +  The grid caches what a view said its constraints were, so it has to be told to ask again.
		this._onDidChange.fire(undefined);
	}

	/**
	 * Whatever took a folder out of the workspace, its editors go with it.
	 *
	 * ⚠️ Its display name and colour do **not**. Those live in `StorageScope.PROFILE` because they
	 * are about the folder rather than about this window, so pruning them against one workspace's
	 * list would throw away a colour set in another. A folder taken out and put back is the same
	 * folder and comes back the colour it was.
	 */
	private pruneEditors(): void {
		void this.editors?.prune(this.model.folders.map(folder => folder.uri), folder => this.isRemoving(folder));
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();
		if (!container) {
			return;
		}

		container.style.backgroundColor = this.getColor(FACADE_BAR_BACKGROUND) ?? '';

		// ⚠️ Left unset when the theme has not set one, as the side bar does: a row's name then
		// inherits the workbench foreground, which is where the explorer's file names get theirs.
		container.style.color = this.getColor(FACADE_BAR_FOREGROUND) ?? '';

		// The colour and whether there is a line at all; the line itself is drawn by the stylesheet,
		// the way `activitybarPart.ts` does it.
		const borderColor = this.getColor(FACADE_BAR_BORDER) ?? this.getColor(contrastBorder);
		container.classList.toggle('bordered', !!borderColor);
		container.style.setProperty('--facade-divider', borderColor ? String(borderColor) : '');
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);

		// A virtualised list does not re-flow on its own: without handing the size down the rows stop
		// being recycled against the visible area and the scroll height is computed from the old one.
		const { contentSize } = super.layoutContents(width, height);
		this.view?.layout(contentSize.width, contentSize.height - HEADER_HEIGHT);
	}

	async add(uris: readonly URI[]): Promise<void> {
		await this.model.add(uris);
	}

	async addAndShow(uris: readonly URI[]): Promise<ShowResult> {
		if (uris.length === 0) {
			return { kind: 'cancelled' };
		}
		if (uris.length === 1) {
			return this.show(uris[0]);
		}

		let added: readonly URI[];
		try {
			added = await this.addForShow(uris);
		} catch (error) {
			return this.couldNotAdd(uris[uris.length - 1], toErrorMessage(error));
		}
		return this.doShow(uris[uris.length - 1], added);
	}

	show(uri: URI): Promise<ShowResult> {
		return this.doShow(uri, []);
	}

	/** `show`, for a folder that `addedBefore` were put in the workspace on the way to. */
	private async doShow(uri: URI, addedBefore: readonly URI[]): Promise<ShowResult> {
		// An empty window opens on its first folder, as stock, rather than becoming an untitled workspace (W4)
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			await this.hostService.openWindow([{ folderUri: uri }], { forceReuseWindow: true });
			return { kind: 'shown' };
		}

		// ⚠️ Through the model, not straight to the workspace: it is what knows that `/tmp/x` and
		// `/private/tmp/x` are one folder, so a folder opened twice under two spellings is one row
		// rather than two. `add` skips what is already there, which makes this the same call whether
		// the folder is new to the window or one it already has.
		let added: readonly URI[];
		try {
			added = [...addedBefore, ...await this.addForShow([uri])];
		} catch (error) {
			return this.couldNotAdd(uri, toErrorMessage(error));
		}

		// ⚠️ Switched to the row, not to the spelling that was asked for. A folder the workspace
		// took in long ago under the other spelling of the same place is a row `setActiveFolder`
		// would not find, and it throws rather than guess.
		const folder = await this.model.resolve(uri);
		if (!folder || !this.switcher) {
			// The workspace refused the edit
			return this.couldNotAdd(uri, localize('workspaceBar.notTaken', "the folder was not added to the workspace"));
		}

		// The folders stay if the switch fails, which the switcher reports (W5)
		const result = await this.switcher.switchTo(folder.uri, added);
		return result.kind === 'failed' && added.length > 0 ? { ...result, added: true } : result;
	}

	private couldNotAdd(uri: URI, reason: string): ShowResult {
		this.logService.warn(`[workspaceBar] ${uri.toString(true)} did not become a folder of this workspace: ${reason}`);
		this.notificationService.error(localize('workspaceBar.couldNotAdd', "Failed to add folder '{0}' to the workspace: {1}", uri.scheme === 'file' ? uri.fsPath : uri.toString(true), reason));
		return { kind: 'failed', reason };
	}

	/** Adds folders to move onto and waits for their rows to be read from git; returns the ones added. */
	private async addForShow(uris: readonly URI[]): Promise<readonly URI[]> {
		const added = await this.model.add(uris);
		if (added.length > 0) {
			await this.git.refresh();
		}
		return added;
	}

	remove(uris: readonly URI[], options?: IRemoveOptions): Promise<RemoveResult> {
		// ⚠️ Nothing to forget here. Taking the folders out of the workspace is what moves the window
		// off one that is leaving, and `pruneEditors` drops what they left behind - which is the same
		// work whether the removal came from this bar or from someone editing the workspace file.
		return this.removal.remove(uris, options);
	}

	isRemoving(folder: URI): boolean {
		return !!this._removal?.isRemoving(folder);
	}

	async moveFolder(uri: URI, offset: number): Promise<void> {
		// Worked out when the edit runs, on the folders as they are then: an order worked out now would
		// undo a move still in the queue, and leave out a folder being added.
		await this.model.reorder(folders => moveRow(rowsOfFolders(folders, folder => this.rowRepositoryOf(folder), this.model.key), uri, offset, this.model.key));
	}

	/**
	 * The repository whose row `folder` is drawn on, or undefined for a folder on a row of its own. Not
	 * `repositoryFor`, which also knows a folder git records as a worktree but the bar draws on its
	 * own, its `.git` gone.
	 */
	private rowRepositoryOf(folder: URI): URI | undefined {
		if (!areWorktreesShown(this.configurationService)) {
			return undefined;
		}

		const key = this.model.key(folder);
		for (const group of this.git.groups) {
			if (group.kind === 'repository' && group.members.some(member => this.model.key(member.uri) === key)) {
				return group.main;
			}
		}

		return undefined;
	}

	/**
	 * ⚠️ The fallback is not decoration: the list has no focused row until someone clicks in the bar,
	 * so without it the command palette entry is a silent no-op on a fresh window.
	 */
	folderForCommand(): URI | undefined {
		return this.view?.focused() ?? this.switcher?.active;
	}

	repositoryFor(uri: URI): IWorkspaceBarRepository | undefined {
		// None while worktrees are switched off (WORKTREE.md WT-9): every row is then a folder.
		if (!areWorktreesShown(this.configurationService)) {
			return undefined;
		}

		const key = this.model.key(uri);
		for (const group of this.git.groups) {
			if (group.kind === 'repository' && (this.model.key(group.main) === key || group.worktrees.some(worktree => this.model.key(worktree.uri) === key))) {
				return group;
			}
		}

		return undefined;
	}

	rowOrder(): readonly URI[] {
		// Before the bar is drawn its rows are the folders, in their order
		return this.view?.rowOrder() ?? this.model.folders.map(folder => folder.uri);
	}

	setExpanded(uri: URI, expanded: boolean): void {
		this.view?.setExpanded(uri, expanded);
	}

	async whenListed(worktree: URI): Promise<void> {
		if (areWorktreesShown(this.configurationService) && !this.repositoryFor(worktree)) {
			await this.git.refresh();
		}
	}

	hideWorktree(worktree: URI): IDisposable {
		return this.view?.hideWorktree(worktree) ?? Disposable.None;
	}

	focus(): void {
		this.view?.focus();
	}

	toJSON(): object {
		return { type: Parts.WORKSPACEBAR_PART };
	}
}

registerSingleton(IWorkspaceBarService, WorkspaceBarPart, InstantiationType.Eager);
