/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebarpart.css';
import { $, append } from '../../../../base/browser/dom.js';
import { ISerializedNode, LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { getTitleBarStyle, TitlebarStyle } from '../../../../platform/window/common/window.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { Part } from '../../part.js';
import { FACADE_BAR_BACKGROUND, FACADE_BAR_BORDER, FACADE_BAR_FOREGROUND } from './workspaceBarColors.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { URI } from '../../../../base/common/uri.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
// Imported for its `registerAction2` calls as much as for the menu id.
import { WorkspaceBarTitleMenu } from './workspaceBarActions.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';
import { IWorkspaceBarService } from './workspaceBarService.js';
import { WorkspaceBarEditors } from './workspaceBarEditors.js';
import { WorkspaceBarSwitcher } from './workspaceBarSwitcher.js';
import { WorkspaceBarView } from './workspaceBarView.js';

/** The width the bar opens at and the narrowest it can be dragged to. Measured: 219 and a divider. */
export const WORKSPACEBAR_WIDTH = 220;

/** Kept with the stylesheet's `.workspacebar-header` height, which the list is laid out below. */
const HEADER_HEIGHT = 35;
const WORKSPACEBAR_MAXIMUM_WIDTH = 480;

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
 * The workspace bar: column zero of the window. The shell only - what a folder is belongs to
 * `WorkspaceBarModel`, switching to `WorkspaceBarSwitcher`, how one looks to `WorkspaceBarView`.
 */
export class WorkspaceBarPart extends Part implements IWorkspaceBarService {

	declare readonly _serviceBrand: undefined;

	readonly minimumWidth: number = WORKSPACEBAR_WIDTH;
	readonly maximumWidth: number = WORKSPACEBAR_MAXIMUM_WIDTH;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	/** Low, like the side bar and the auxiliary bar: the editor takes what the window gains or loses. */
	readonly priority: LayoutPriority = LayoutPriority.Low;

	private content: HTMLElement | undefined;

	/** The strip above the header. Its height is the title bar's, read on every layout. */
	private titlebarSpacer: HTMLElement | undefined;

	private readonly model: WorkspaceBarModel;
	private view: WorkspaceBarView | undefined;
	private editors: WorkspaceBarEditors | undefined;
	private switcher: WorkspaceBarSwitcher | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
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

		// Built here rather than with the content area: an action can run before anything has been
		// drawn, and "add a folder" has nothing to do with whether the bar has been laid out.
		this.model = this._register(this.instantiationService.createInstance(WorkspaceBarModel));
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
		this.view = this._register(this.instantiationService.createInstance(WorkspaceBarView, this.content, this.model, this.switcher));

		return this.content;
	}

	/** Whatever took a folder out of the workspace, its editors go with it. */
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

		const borderColor = this.getColor(FACADE_BAR_BORDER) ?? this.getColor(contrastBorder);
		container.style.borderRight = borderColor ? `1px solid ${borderColor}` : '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);

		// Follows the title bar and the banner, however tall they are - including not at all, which
		// is what full screen and a hidden title bar both come out as.
		if (this.titlebarSpacer) {
			this.titlebarSpacer.style.height = `${this.layoutService.mainContainerOffset.top}px`;
		}

		// A virtualised list does not re-flow on its own: without handing the size down the rows stop
		// being recycled against the visible area and the scroll height is computed from the old one.
		const { contentSize } = super.layoutContents(width, height);
		this.view?.layout(contentSize.width, contentSize.height - (this.titlebarSpacer?.clientHeight ?? 0) - HEADER_HEIGHT);
	}

	async add(uris: readonly URI[]): Promise<void> {
		await this.model.add(uris);
	}

	async addAndShow(uris: readonly URI[]): Promise<void> {
		if (uris.length === 0) {
			return;
		}

		await this.model.add(uris);
		await this.show(uris[uris.length - 1]);
	}

	async show(uri: URI): Promise<void> {
		// ⚠️ Through the model, not straight to the workspace: it is what knows that `/tmp/x` and
		// `/private/tmp/x` are one folder, so a folder opened twice under two spellings is one row
		// rather than two. `add` skips what is already there, which makes this the same call whether
		// the folder is new to the window or one it already has.
		await this.model.add([uri]);

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

	async remove(uris: readonly URI[]): Promise<void> {
		// ⚠️ Nothing to forget here. Taking the folders out of the workspace is what moves the window
		// off one that is leaving, and `pruneEditors` drops what they left behind - which is the same
		// work whether the removal came from this bar or from someone editing the workspace file.
		await this.model.remove(uris);
	}

	/**
	 * ⚠️ The fallback is not decoration: the list has no focused row until someone clicks in the bar,
	 * so without it the command palette entry is a silent no-op on a fresh window.
	 */
	folderForCommand(): URI | undefined {
		return this.view?.focused() ?? this.switcher?.active;
	}

	focus(): void {
		this.view?.focus();
	}

	toJSON(): object {
		return { type: Parts.WORKSPACEBAR_PART };
	}
}

registerSingleton(IWorkspaceBarService, WorkspaceBarPart, InstantiationType.Eager);
