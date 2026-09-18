/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/workspacebarpart.css';
import { $, append } from '../../../../base/browser/dom.js';
import { ISerializedNode, LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { getTitleBarStyle, TitlebarStyle } from '../../../../platform/window/common/window.js';
import { ACTIVITY_BAR_BACKGROUND, ACTIVITY_BAR_BORDER, ACTIVITY_BAR_FOREGROUND, MODERN_ACTIVITY_BAR_BACKGROUND, MODERN_ACTIVITY_BAR_INACTIVE_BACKGROUND } from '../../../common/theme.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, LayoutSettings, Parts } from '../../../services/layout/browser/layoutService.js';
import { Part } from '../../part.js';

/**
 * The width the bar opens at and the narrowest it can be dragged to, and the widest. Measured off
 * the product this is modelled on: 219 of content and a 1px divider, an edge that will not go left
 * of that, and 480 when pushed the other way.
 */
export const WORKSPACEBAR_WIDTH = 220;
export const WORKSPACEBAR_MAXIMUM_WIDTH = 480;

/**
 * Whether the grid has the workspace bar as its first column, which is what every hard-coded grid
 * coordinate in `layout.ts` rests on.
 *
 * Here rather than in `layout.ts` so that it can be tested without building a workbench. `layout.ts`
 * asks it of the grid it actually built rather than of the descriptor it asked for, because a
 * restored layout comes from storage and can be older than the code reading it.
 */
export function isWorkspaceBarFirstColumn(root: ISerializedNode | undefined): boolean {
	if (root?.type !== 'branch') {
		return false;
	}

	const first = root.data[0];
	return first?.type === 'leaf' && (first.data as { type?: Parts } | undefined)?.type === Parts.WORKSPACEBAR_PART;
}

/**
 * A marker, not an API. `layout.ts` resolves it to force the part into existence before the grid is
 * built; the part has nothing else to offer callers.
 */
export interface IWorkspaceBarService {
	readonly _serviceBrand: undefined;
}

export const IWorkspaceBarService = createDecorator<IWorkspaceBarService>('workspaceBarService');

/**
 * The workspace bar: column zero of the window, from the top edge to the bottom.
 *
 * This class is the shell and nothing more. It takes part in the grid, gives the macOS window
 * controls somewhere to sit, and draws a header. Nothing in it knows what a project is.
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

	private activeWindowId: number | undefined;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super(
			Parts.WORKSPACEBAR_PART,
			{
				hasTitle: false,
				// Without this the content is laid out at the full width while the border eats a
				// pixel of it, and the last pixel of every row sits under the border. `sidebarPart.ts`
				// declares the same thing for the same reason.
				borderWidth: () => (this.getColor(ACTIVITY_BAR_BORDER) || this.getColor(contrastBorder)) ? 1 : 0
			},
			themeService, storageService, layoutService);

		// The borrowed background depends on window focus, so redo it on the same events the
		// activity bar does.
		const updateStyles = () => {
			if (this.element) {
				this.updateStyles();
			}
		};
		this._register(this.hostService.onDidChangeFocus(updateStyles));
		this._register(this.hostService.onDidChangeActiveWindow(windowId => {
			this.activeWindowId = windowId;
			updateStyles();
		}));
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		// Must come first: the grid reads `view.element`.
		this.element = parent;
		this.content = append(this.element, $('.content'));

		// The bar starts at the top of the window rather than below the title bar, so the header
		// needs the title bar's height above it to line up with the side bar's. `layout` sets it.
		// On macOS the strip is also where the traffic lights land, since the system draws them
		// over column zero. `getTitleBarStyle` rather than `hasCustomTitlebar`, which is true for
		// everyone: native tabs and simple fullscreen fall back to a native title bar that keeps
		// the lights away from us.
		this.titlebarSpacer = append(this.content, $('.workspacebar-titlebar-spacer'));
		this.titlebarSpacer.setAttribute('aria-hidden', 'true');
		if (isMacintosh && getTitleBarStyle(this.configurationService) === TitlebarStyle.CUSTOM) {
			this.titlebarSpacer.classList.add('draggable');
		}

		const header = append(this.content, $('.workspacebar-header'));
		append(header, $('span.workspacebar-title')).textContent = localize('workspaceBar.title', "Projects");

		return this.content;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();
		if (!container) {
			return;
		}

		// The activity bar's rule in full: three tokens, not one. Taking only the first agrees with
		// it in eighteen of the nineteen built-in themes and then disagrees in Solarized Light,
		// which leaves `modernActivityBar.background` undefined.
		let background = ACTIVITY_BAR_BACKGROUND;
		if (this.configurationService.getValue<boolean>(LayoutSettings.MODERN_UI) === true) {
			const isWindowActive = this.activeWindowId === undefined ? mainWindow.document.hasFocus() : this.activeWindowId === mainWindow.vscodeWindowId;
			const isInactive = !this.hostService.hasFocus || !isWindowActive;
			background = isInactive ? MODERN_ACTIVITY_BAR_INACTIVE_BACKGROUND : MODERN_ACTIVITY_BAR_BACKGROUND;
		}

		container.style.backgroundColor = this.getColor(background) ?? '';
		container.style.color = this.getColor(ACTIVITY_BAR_FOREGROUND) ?? '';

		const borderColor = this.getColor(ACTIVITY_BAR_BORDER) ?? this.getColor(contrastBorder);
		container.style.borderRight = borderColor ? `1px solid ${borderColor}` : '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);

		// Follows the title bar and the banner, however tall they are - including not at all, which
		// is what full screen and a hidden title bar both come out as.
		if (this.titlebarSpacer) {
			this.titlebarSpacer.style.height = `${this.layoutService.mainContainerOffset.top}px`;
		}

		super.layoutContents(width, height);
	}

	toJSON(): object {
		return { type: Parts.WORKSPACEBAR_PART };
	}
}

registerSingleton(IWorkspaceBarService, WorkspaceBarPart, InstantiationType.Eager);
