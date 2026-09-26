/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebarpart.css';
import { getWCOTitlebarAreaRect, isFullscreen, onDidChangeFullscreen } from '../../../../base/browser/browser.js';
import { $, append, getWindow, getWindowId } from '../../../../base/browser/dom.js';
import { ISerializedNode, LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { coalesce } from '../../../../base/common/arrays.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event, Relay } from '../../../../base/common/event.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { getTitleBarStyle, TitlebarStyle } from '../../../../platform/window/common/window.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { Part } from '../../part.js';
import { BANNER_HEIGHT } from '../banner/bannerPart.js';
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
import { IWorkspaceBarService } from './workspaceBarService.js';
import { WorkspaceBarEditors } from './workspaceBarEditors.js';
import { WorkspaceBarSwitcher } from './workspaceBarSwitcher.js';
import { WorkspaceBarView } from './workspaceBarView.js';

/** The width the bar opens at and the narrowest it can be dragged to. Measured: 219 and a divider. */
export const WORKSPACEBAR_WIDTH = 220;

/** Kept with the stylesheet's `.workspacebar-header` height, which the list is laid out below. */
const HEADER_HEIGHT = 35;

/** Kept with the stylesheet's `.band-sliding` transition, which the band's skin waits out. */
const BAND_SLIDE_DURATION = 200;
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
 * Whether the grid has the workspace bar as its first column, which every hard-coded grid coordinate
 * in `layout.ts` rests on. Asked of the grid that was built, not the descriptor: a restored layout
 * comes from storage and can be older than the code reading it.
 */
export function isWorkspaceBarFirstColumn(root: ISerializedNode | undefined): boolean {
	if (root?.type !== 'branch') {
		return false;
	}

	const first = root.data[0];
	return first?.type === 'leaf' && (first.data as { type?: Parts } | undefined)?.type === Parts.WORKSPACEBAR_PART;
}

/**
 * Whether the window's own buttons are drawn across the top of column zero. It decides where this
 * bar's content starts: under the title bar where they are, and at the very top of the window where
 * they are not, which is a row the column gets back on every platform but one.
 *
 * ⚠️ Read, not tabulated per platform. Windows puts the three buttons at the end of the row and so
 * does Linux, but a Linux window manager lets a person move them to the front - elementary OS ships
 * that way - so a table keyed on the platform is wrong there the moment somebody does. The rect
 * answers for the window in front of us and keeps answering the day any of that changes.
 *
 * ⚠️ `isMac` is a parameter with the real platform as its default rather than a read of
 * `isMacintosh` inside, so that the macOS branch can be tested from a build that is not on macOS.
 * Callers pass three arguments.
 */
export function controlsOccupyColumnZero(titleBarStyle: TitlebarStyle, titlebarAreaRect: Pick<DOMRect, 'x'> | undefined, fullscreen: boolean, isMac = isMacintosh): boolean {
	// Full screen first, and for every platform: the window has no buttons up there to draw.
	// macOS takes the traffic lights away entirely, and Windows and Linux have no caption row
	// left to put theirs in - `titlebarpart.css` says the same thing its own way, hiding
	// `.window-controls-container` under `.fullscreen`.
	//
	// ⚠️ The room beside the lights is written the same way one file over: the 70px of padding
	// the open header leaves for them is `.mac:not(.fullscreen)` in `workspacebarpart.css`. The
	// row above them is the same fact and belongs in the same condition - without it the header
	// sits 35px down in full screen with an empty band over it, which is the one place this
	// column does not look like it does on Windows.
	if (fullscreen) {
		return false;
	}

	// macOS draws the traffic lights at the top left and has no way to draw them anywhere else, so
	// the platform answers and the rect is not consulted. It would agree - `windows.ts` does set
	// `titleBarOverlay` on macOS, so a rect does arrive - but a fact that cannot vary is a better
	// source than a measurement this fork has no macOS build to check.
	//
	// ⚠️ `titleBarStyle`, not `hasCustomTitlebar`. Native tabs and simple fullscreen both fall back to
	// a native title bar, and the lights then sit above the web contents rather than over this column.
	if (isMac) {
		return titleBarStyle === TitlebarStyle.CUSTOM;
	}

	// The rect is the part of the row the buttons left alone, so it starts past them when they are at
	// the front and at zero when they are at the end - which is where Chromium draws them in a
	// left-to-right window.
	if (titlebarAreaRect) {
		return titlebarAreaRect.x > 0;
	}

	// No overlay to read, which is `window.controlsStyle` set to `custom` or to `hidden`, or a native
	// title bar. The first draws the buttons into the title bar's own far end, the second draws none
	// at all, and the third draws them outside the web contents. None of the three reach this column.
	return false;
}

/**
 * The workspace bar: column zero of the window. The shell only - what a folder is belongs to
 * `WorkspaceBarModel`, switching to `WorkspaceBarSwitcher`, how one looks to `WorkspaceBarView`.
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
	/** What the header's toggle draws from: `<` or `>` (`WorkspaceBarCollapsedContext`). */
	private readonly collapsedContext: IContextKey<boolean>;
	get collapsed(): boolean { return this._collapsed; }

	private readonly _onDidChangeCollapsed = this._register(new Emitter<void>());
	readonly onDidChangeCollapsed = this._onDidChangeCollapsed.event;

	/** The strip above the header. Its height is the title bar's, read on every layout. */
	private titlebarSpacer: HTMLElement | undefined;

	/** The height the strip was last given, which is where a slide starts from. */
	private bandHeight: number | undefined;

	/** Set by the one change that slides the band rather than snapping it: full screen. */
	private slideNextBandChange = false;

	/** Takes the slide class off, and the skin with it if the band slid shut, once the slide is over. */
	private readonly bandSettler = this._register(new RunOnceScheduler(() => this.settleBand(), BAND_SLIDE_DURATION));

	private readonly model: WorkspaceBarModel;
	private readonly git: WorkspaceBarGit;
	private view: WorkspaceBarView | undefined;
	private editors: WorkspaceBarEditors | undefined;
	private switcher: WorkspaceBarSwitcher | undefined;

	// A relay because the switcher is created in `createContentArea`, after a listener can arrive
	private readonly _onDidRestoreEditors = this._register(new Relay<void>());
	readonly onDidRestoreEditors = this._onDidRestoreEditors.event;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IHostService private readonly hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkspaceBarCustomizationService customizationService: IWorkspaceBarCustomizationService,
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

		// ⚠️ The strip above the header is painted in the title bar's colours, and the title bar has
		// two: it dims when the window loses focus. Without this the column keeps one bright band
		// across the top of a window nobody is looking at.
		this._register(this.hostService.onDidChangeFocus(focused => {
			this.element?.classList.toggle('window-inactive', !focused);
		}));

		// ⚠️ Entering full screen takes the window's buttons away, which changes how much room this
		// column has to leave above its header - and the grid does not necessarily lay this part out
		// again to ask. The window resizes for the transition, but macOS fires `enter-full-screen`
		// when the animation ends, after those resizes, so the last layout of the transition is one
		// taken while the answer was still the old one.
		this._register(onDidChangeFullscreen(windowId => {
			if (this.element && windowId === getWindowId(getWindow(this.element))) {
				this.slideNextBandChange = true;
				this.relayoutAtCurrentSize();
			}
		}));

		// Built here rather than with the content area: an action can run before anything has been
		// drawn, and "add a folder" has nothing to do with whether the bar has been laid out.
		this.model = this._register(this.instantiationService.createInstance(WorkspaceBarModel));

		// Which of those folders are one repository, and its worktrees - read from git's own files, so
		// that the first drawing of the bar already has them (WORKTREE.md section 5). While the bar lists
		// no worktrees (section 11) the reader is handed no folders, and reads and watches nothing.
		const model = this.model;
		this.git = this._register(this.instantiationService.createInstance(WorkspaceBarGit, {
			get folders() { return areWorktreesShown(configurationService) ? model.folders : []; },
			onDidChange: Event.any(model.onDidChange, Event.signal(Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(SHOW_WORKTREES)))),
			key: model.key
		}));

		// WT-1.12: a worktree in folders[] that nobody has named is called by its branch - in the window's
		// title as in the bar, both through `nameFor`.
		this._register(this.git.onDidChange(() => customizationService.setDefaultNames(this.git.groups.flatMap(group => group.kind === 'repository'
			? coalesce(group.worktrees.map(worktree => worktree.folder && { uri: worktree.folder.uri, name: worktree.label }))
			: []))));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		// Must come first: the grid reads `view.element`.
		this.element = parent;
		this.content = append(this.element, $('.content'));

		// The bar starts at the top of the window, so the header needs the title bar's height above it,
		// which is also where macOS draws the traffic lights. ⚠️ `getTitleBarStyle`, not
		// `hasCustomTitlebar`: native tabs and simple fullscreen keep the lights off column zero.
		this.titlebarSpacer = append(this.content, $('.workspacebar-titlebar-spacer'));
		this.titlebarSpacer.setAttribute('aria-hidden', 'true');
		if (isMacintosh && getTitleBarStyle(this.configurationService) === TitlebarStyle.CUSTOM) {
			this.titlebarSpacer.classList.add('draggable');
		}

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
			this.content, this.model, this.git, this.switcher, () => this.collapsed, this.onDidChangeCollapsed, (uri: URI) => this.show(uri)));

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
		this.editors?.prune(new Set(this.model.folders.map(folder => this.model.key(folder.uri))));
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

		// ⚠️ The colour and whether there is a line at all; the line itself is drawn by the
		// stylesheet, the way `activitybarPart.ts` does it. Setting `border-right` inline here instead
		// is what the first attempt did, and an inline declaration cannot be overridden by a rule - so
		// the collapsed rule that has to switch this border off for the band silently lost, and the
		// line went on cutting the band in two while the stylesheet said it should not.
		const borderColor = this.getColor(FACADE_BAR_BORDER) ?? this.getColor(contrastBorder);
		container.classList.toggle('bordered', !!borderColor);
		container.style.setProperty('--facade-divider', borderColor ? String(borderColor) : '');
	}

	/**
	 * Lays the column out again at the size it already has.
	 *
	 * `Part` has one of these and keeps it private, so this is the same three lines that
	 * `sessions/browser/parts/auxiliaryBarPart.ts` writes for the same reason: a part told
	 * something by an event rather than by the grid.
	 */
	private relayoutAtCurrentSize(): void {
		if (this.dimension && this.contentPosition) {
			this.layout(this.dimension.width, this.dimension.height, this.contentPosition.top, this.contentPosition.left);
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);

		// Follows the title bar, however tall it is - including not at all, which is what full
		// screen and a hidden title bar both come out as.
		//
		// ⚠️ And a row of its own under them while collapsed. macOS draws the window's three buttons
		// across the top of this column - measured at 70px wide, which is what the title bar reserves
		// for the same three - and a collapsed column is 36. There is no "beside" left, so the toggle
		// goes below them. Open, 70 + 24 fits in 220 and it sits beside them as it should.
		//
		// ⚠️ Only where those buttons are actually over this column. Where they are not - Windows and
		// Linux draw them at the far end of the row, and full screen draws none at all - the strip
		// was holding a row open for something that is nowhere near it, and the one part that reaches
		// the top of the window was the one part not using it: the header began 35px down for no
		// reason a person could see.
		if (this.titlebarSpacer) {
			const targetWindow = getWindow(this.element);
			const controlsAbove = controlsOccupyColumnZero(
				getTitleBarStyle(this.configurationService),
				getWCOTitlebarAreaRect(targetWindow),
				isFullscreen(targetWindow));
			// ⚠️ The title bar's row and not the banner's. `mainContainerOffset` counts both, because
			// every other column has the banner over it - but the banner starts to the right of this
			// one, and the lights sit in the title bar's row only. Counted, the header dropped 26px
			// whenever the Restricted Mode banner was up, under a band with nothing in it. It did not
			// even do that reliably: showing the banner does not lay this column out again, so the
			// header stayed put until the next resize - maximising and restoring the window - moved it.
			const bannerHeight = this.layoutService.isVisible(Parts.BANNER_PART) ? BANNER_HEIGHT : 0;
			const above = controlsAbove ? this.layoutService.mainContainerOffset.top - bannerHeight : 0;

			// ⚠️ Slid rather than snapped, and only when full screen is what moved it. The header
			// jumped 35px the moment macOS reported the change, which is after its own animation has
			// finished - so the least this can do is not add a second jolt to the end of the first.
			// Only full screen: a band that slides at startup or on collapse is a header that drifts
			// into place every time the window opens.
			//
			// ⚠️ And only where the workbench animates at all. With reduced motion the stylesheet has no
			// transition to run, and holding the skin on for a slide that is not happening leaves the
			// collapsed strip's bottom border as a hairline across the top for its length.
			const slide = this.slideNextBandChange && this.bandHeight !== undefined && this.bandHeight !== above
				&& !!this.element.closest('.monaco-enable-motion');
			this.slideNextBandChange = false;
			this.bandHeight = above;

			// ⚠️ Spacing and nothing else. macOS draws the window's three buttons across this row - 70px
			// of them, over a column that is 36 when collapsed - so nothing of ours goes in it.
			this.titlebarSpacer.style.height = `${above}px`;

			// ⚠️ The same number the stylesheet needs to know where the collapsed divider starts, set
			// from the one place that computes it. The strip's height and the point the line begins are
			// the same edge, and two sources for it is two edges a frame apart.
			this.element.style.setProperty('--facade-band-height', `${above}px`);

			if (slide) {
				// ⚠️ The skin stays on for the length of the slide, whichever way it goes. Taken off at
				// the start of a slide shut, the band loses its colour and its bottom line in the first
				// frame and the slide is a gap closing rather than a band.
				this.element.classList.add('band-sliding', 'banded');
				this.bandSettler.schedule();
			} else {
				this.bandSettler.cancel();
				this.settleBand();
			}
		}

		// A virtualised list does not re-flow on its own: without handing the size down the rows stop
		// being recycled against the visible area and the scroll height is computed from the old one.
		//
		// ⚠️ Given the height the band is going to, not the one it has. Mid-slide the strip's
		// `clientHeight` is somewhere between the two, and a list laid out against that is the wrong
		// height for as long as nothing lays it out again - which, after a full screen change, is
		// until the next resize.
		const { contentSize } = super.layoutContents(width, height);
		this.view?.layout(contentSize.width, contentSize.height - (this.bandHeight ?? 0) - HEADER_HEIGHT);
	}

	/**
	 * The band as it is at rest: no slide under way, and its skin on exactly when it has a height.
	 *
	 * ⚠️ The collapsed strip is `border-box` with a 1px bottom border, so a height of zero still
	 * paints that border: measured, the strip came back 1px tall and the header started at y=1,
	 * leaving a hairline of `titleBar.border` across the top of a column that has no band under it.
	 * The class is what the stylesheet keys the skin off, so it has to go when the height does.
	 */
	private settleBand(): void {
		this.element?.classList.remove('band-sliding');
		this.element?.classList.toggle('banded', (this.bandHeight ?? 0) > 0);
	}

	async add(uris: readonly URI[]): Promise<void> {
		await this.model.add(uris);
	}

	async addAndShow(uris: readonly URI[]): Promise<void> {
		if (uris.length === 0) {
			return;
		}

		await this.addForShow(uris);
		await this.show(uris[uris.length - 1]);
	}

	async show(uri: URI): Promise<void> {
		// ⚠️ Through the model, not straight to the workspace: it is what knows that `/tmp/x` and
		// `/private/tmp/x` are one folder, so a folder opened twice under two spellings is one row
		// rather than two. `add` skips what is already there, which makes this the same call whether
		// the folder is new to the window or one it already has.
		await this.addForShow([uri]);

		// ⚠️ Switched to the row, not to the spelling that was asked for. A folder the workspace
		// took in long ago under the other spelling of the same place is a row `setActiveFolder`
		// would not find, and it throws rather than guess.
		const folder = await this.model.resolve(uri);
		if (!folder) {
			// ⚠️ Nothing stats what is handed in here - `addFolders` writes what it is given - so this
			// is the workspace having refused it: an empty window that could not be turned into one,
			// or an edit that failed. Too rare to have a screen of its own, too quiet to leave out of
			// the log.
			this.logService.warn(`[workspaceBar] ${uri.toString(true)} did not become a folder of this workspace`);
			return;
		}

		await this.switcher?.switchTo(folder.uri);
	}

	/**
	 * Puts folders in the workspace for the window to move onto, and when any were added, waits for
	 * git's files to be read again: the rows come from that read, and moving onto a folder before its
	 * row exists left no row marked for a moment.
	 */
	private async addForShow(uris: readonly URI[]): Promise<void> {
		const added = await this.model.add(uris);
		if (added.length > 0) {
			await this.git.refresh();
		}
	}

	async remove(uris: readonly URI[]): Promise<void> {
		// ⚠️ Nothing to forget here. Taking the folders out of the workspace is what moves the window
		// off one that is leaving, and `pruneEditors` drops what they left behind - which is the same
		// work whether the removal came from this bar or from someone editing the workspace file.
		await this.model.remove(uris);
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
		// None while worktrees are switched off (WORKTREE.md section 11): every row is then a folder.
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
