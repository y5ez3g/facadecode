/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { IconLabel } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
import { HoverStyle } from '../../../../base/browser/ui/hover/hover.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListContextMenuEvent, IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { FolderKey } from './workspaceBar.js';
import { WorkspaceBarContextMenu, WorkspaceBarFocusContext } from './workspaceBarActions.js';
import { IWorkspaceBarCustomizationService } from './workspaceBarCustomization.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';
import { WorkspaceBarSwitcher } from './workspaceBarSwitcher.js';

/** ⚠️ 28, the compact activity bar's item height, measured. Not the workbench's usual 22: a dozen rows pointed at, not hundreds scanned. */
const ROW_HEIGHT = 28;

const TEMPLATE_ID = 'workspaceBar.folder';

class WorkspaceBarDelegate implements IListVirtualDelegate<IWorkspaceFolder> {
	getHeight(): number { return ROW_HEIGHT; }
	getTemplateId(): string { return TEMPLATE_ID; }
}

interface IRowTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: IconLabel;
	/**
	 * ⚠️ Mutable, and read by the hover rather than handed to it. A template is reused for whatever
	 * row scrolls into it, so a hover closed over the folder it was built with would name the folder
	 * that used to be there.
	 */
	name: string;
	readonly templateDisposable: IDisposable;
}

class FolderRenderer implements IListRenderer<IWorkspaceFolder, IRowTemplate> {

	readonly templateId = TEMPLATE_ID;

	constructor(
		private readonly isUnavailable: (folder: IWorkspaceFolder) => boolean,
		private readonly isActive: (folder: IWorkspaceFolder) => boolean,
		private readonly isCollapsed: () => boolean,
		private readonly hoverDelegate: IHoverDelegate,
		@ILabelService private readonly labelService: ILabelService,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
		@IHoverService private readonly hoverService: IHoverService,
	) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const disposables = new DisposableStore();
		const row = append(container, $('.workspacebar-row'));
		const icon = append(row, $('.workspacebar-icon'));
		const label = disposables.add(new IconLabel(row, { supportHighlights: true, supportDescriptionHighlights: true }));

		const template: IRowTemplate = { row, icon, label, name: '', templateDisposable: disposables };

		/*
		 * The name, on the row itself, while the column is collapsed.
		 *
		 * ⚠️ On the row and not on the label: collapsed, `display: none` takes the label away, and an
		 * element that is not drawn cannot be pointed at. The row is the 36px strip that is left.
		 *
		 * ⚠️ `undefined` while the column is open, rather than no hover at all. The name is on screen
		 * then, and the label already carries the full path under the workbench's own delay - two
		 * hovers over one row is one too many.
		 *
		 * ⚠️ `setupManagedHover` with an instant delegate, although it is marked deprecated in favour
		 * of `setupDelayedHover`. Delayed is the thing being avoided: the activity bar waits out
		 * `workbench.hover.delay` before it names its icon and this column is not to. The instant
		 * delegate is the in-tree way to say so - `buttonbar.ts`, `chatInputPart.ts` and
		 * `unifiedQuickAccess.ts` all reach for the same pair.
		 */
		disposables.add(this.hoverService.setupManagedHover(
			this.hoverDelegate,
			row,
			() => this.isCollapsed() ? template.name : undefined));

		return template;
	}

	renderElement(folder: IWorkspaceFolder, _index: number, template: IRowTemplate): void {
		template.row.classList.toggle('unavailable', this.isUnavailable(folder));

		// ⚠️ The bar's own mark, not the list's selection. Which folder the window is in is a fact
		// about the window; a list's selection is the person's, and the list clears it when a
		// pointer lands anywhere on it that is not a row (`MouseController.onViewPointer`, where
		// `e.index` is undefined). That is right for a list and wrong for this.
		template.row.classList.toggle('active', this.isActive(folder));

		// ⚠️ The colour paints the icon and nothing else. Not the name, not the chevron: a row is
		// read as a name, and a name in six colours is six kinds of emphasis nobody asked for.
		// ⚠️ And the glyph is a choice too now. `folder` is the fallback rather than a stored value,
		// so a folder nobody has customised and one set back to a plain folder draw the same.
		const customization = this.customizationService.get(folder.uri);
		const glyph = customization?.icon ? ThemeIcon.fromId(customization.icon) : Codicon.folder;
		template.icon.className = `workspacebar-icon ${ThemeIcon.asClassName(glyph)}`
			+ (customization?.color ? ` workspacebar-icon-${customization.color}` : '');

		// ⚠️ Through `nameFor`, which the window title also calls. The workspace's own name for the
		// root is the fallback - a `.code-workspace` can name a folder and that name is somebody's
		// too - but a display name set here wins over it.
		// The full path on hover is what tells two rows with the same name apart.
		template.name = this.customizationService.nameFor(folder);
		template.label.setLabel(template.name, undefined, {
			title: this.labelService.getUriLabel(folder.uri)
		});
	}

	disposeTemplate(template: IRowTemplate): void {
		template.templateDisposable.dispose();
	}
}

class WorkspaceBarIdentityProvider implements IIdentityProvider<IWorkspaceFolder> {

	constructor(private readonly key: FolderKey) { }

	getId(folder: IWorkspaceFolder): string {
		return this.key(folder.uri);
	}
}

class WorkspaceBarAccessibilityProvider implements IListAccessibilityProvider<IWorkspaceFolder> {

	getWidgetAriaLabel(): string {
		return localize('workspaceBar.ariaLabel', "Workspace folders");
	}

	constructor(private readonly isUnavailable: (folder: IWorkspaceFolder) => boolean) { }

	getAriaLabel(folder: IWorkspaceFolder): string {
		return this.isUnavailable(folder)
			? localize('workspaceBar.unavailableAria', "{0}, not on disk", folder.name)
			: folder.name;
	}
}

class WorkspaceBarKeyboardNavigationLabelProvider implements IKeyboardNavigationLabelProvider<IWorkspaceFolder> {

	getKeyboardNavigationLabel(folder: IWorkspaceFolder): string {
		return folder.name;
	}
}

/** The list of folders. */
export class WorkspaceBarView extends Disposable {

	private readonly list: WorkbenchList<IWorkspaceFolder>;
	private readonly empty: HTMLElement;

	constructor(
		container: HTMLElement,
		private readonly model: WorkspaceBarModel,
		private readonly switcher: WorkspaceBarSwitcher,
		private readonly isCollapsed: () => boolean,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
	) {
		super();

		this.empty = append(container, $('.workspacebar-empty'));
		// ⚠️ Says what to do next, and names both ways of doing it - the column is a drop target over
		// its whole height, which nothing else on screen says.
		this.empty.textContent = localize('workspaceBar.empty', "Open a folder or drag one here.");

		this.list = this._register(instantiationService.createInstance(
			WorkbenchList<IWorkspaceFolder>,
			'WorkspaceBar',
			append(container, $('.workspacebar-list')),
			new WorkspaceBarDelegate(),
			[instantiationService.createInstance(FolderRenderer,
				(folder: IWorkspaceFolder) => model.isUnavailable(folder),
				(folder: IWorkspaceFolder) => this.isActive(folder),
				this.isCollapsed,
				/*
				 * The activity bar's card: beside the icon, pointing back at it, with no wait.
				 *
				 * ⚠️ `hoverPosition: RIGHT` with `HoverStyle.Pointer` is what makes it that card rather
				 * than a tooltip - anchored to the icon and opening into the window, not following the
				 * mouse. `compositeBarActions.ts` passes exactly this pair. Neither can be set through
				 * `setupManagedHover`'s own options, whose `position` is only `anchorAlignment`, so they
				 * are the delegate's override options. Measured without them: the card opened at x=2,
				 * across the 36px column it was supposed to sit beside.
				 *
				 * ⚠️ `dynamicDelay: () => 0`, and not `createInstantHoverDelegate()`, which does not do
				 * what its name says: `instantHover` only skips the fade-in when another hover was hidden
				 * within the last 200ms, and the delay still comes from `workbench.hover.delay` - which
				 * on macOS defaults to **1500**, not the 500 the other platforms get. Measured before
				 * this was written: the card was correct, and arrived a second and a half after the
				 * pointer. `dynamicDelay` is the supported way to answer 0.
				 *
				 * ⚠️ One delegate for the whole list, owned by the view. Made per template it would be
				 * one more hover widget group than there are rows on screen.
				 */
				this._register(instantiationService.createInstance(
					WorkbenchHoverDelegate,
					'element',
					{ instantHover: true, dynamicDelay: () => 0 },
					{
						style: HoverStyle.Pointer,
						position: { hoverPosition: HoverPosition.RIGHT }
					})))],
			{
				// ⚠️ The bar's own rule, not `uri.toString()`: the list keeps focus and selection on
				// the right row across a redraw with it, so it has to agree with everything else.
				identityProvider: new WorkspaceBarIdentityProvider(model.key),
				accessibilityProvider: new WorkspaceBarAccessibilityProvider(folder => model.isUnavailable(folder)),
				keyboardNavigationLabelProvider: new WorkspaceBarKeyboardNavigationLabelProvider(),
				// One click. Left alone this follows `workbench.list.openMode`, which is about files.
				openOnSingleClick: true,
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				overrideStyles: {
					// ⚠️ `undefined` is not "use the default" here, it is "paint nothing":
					// `computeStyles` passes it straight through and `listWidget` guards every rule
					// with a truthiness check, so no rule is emitted at all.
					//
					// The bar paints its own surface, so the list must not paint another one over it.
					listBackground: undefined,
					// And selection is not a concept in this bar. The row the window is in is marked
					// by `.active`, which this view owns and which the renderer puts on. Left to
					// paint a selection as well, the column carries two marks for as long as a click
					// lands on a row the window does not end up in - a folder no longer on disk, say.
					listActiveSelectionBackground: undefined,
					listActiveSelectionForeground: undefined,
					listActiveSelectionIconForeground: undefined,
					listInactiveSelectionBackground: undefined,
					listInactiveSelectionForeground: undefined,
					// ⚠️ Keyed on `.focused` rather than on a selection, whatever its name says
					// (`listWidget.ts`). Left painted it puts the selection's icon ink on a row the
					// list is drawing in the focus colours - half of one pair over the other, and
					// the icon comes out brighter than the name beside it.
					listInactiveSelectionIconForeground: undefined,
					// ⚠️ And the focus pair, for the same reason as the selection pair. A filled band and a
					// blue frame are what a list uses to say "the keyboard is here"; the activity bar says
					// it with the same line it uses for "this is the one", and this column is read beside
					// that one. Measured on the compact activity bar: `activityBar.activeBackground` is
					// declared by the theme and painted by nothing.
					//
					// ⚠️ Not dropped, moved: `.focused` gets the same leading line in the focus colour,
					// below in the stylesheet. Taking the mark away without putting one back makes the
					// column invisible to the keyboard.
					listFocusBackground: undefined,
					listFocusForeground: undefined,
					listFocusOutline: undefined,
					listInactiveFocusBackground: undefined,
					listInactiveFocusOutline: undefined,
					// ⚠️ And hover, the last of the four the list paints. The activity bar answers a pointer
					// with its ink and nothing else - measured, its item stays transparent while a row here
					// lit up `list.hoverBackground` under the whole name. Same gesture, so same answer.
					listHoverBackground: undefined,
					listHoverForeground: undefined,
					listHoverOutline: undefined,
					// ⚠️ And the pair that only exists when a row is **both**, which in this bar is what a
					// click makes every row it lands on. `listWidget` keeps a third set of rules for
					// `.selected.focused` and reaches them through their own keys; turning off selection
					// and focus separately leaves these two untouched and the row painted anyway.
					// Measured: `CSS.getMatchedStylesForNode` named the rule, which no amount of reading
					// the override list would have.
					listFocusAndSelectionBackground: undefined,
					listFocusAndSelectionForeground: undefined,
					// ⚠️ And its outline falls back through `listSelectionOutline` to `listFocusOutline`,
					// so all three have to be off for the frame to go.
					listFocusAndSelectionOutline: undefined,
					listSelectionOutline: undefined
				}
			}
		)) as WorkbenchList<IWorkspaceFolder>;

		this._register(this.list.onDidOpen(e => {
			if (e.element) {
				this.switcher.switchTo(e.element.uri).then(undefined, onUnexpectedError);
			}
		}));

		// ⚠️ On the list's own scope, not a scope of ours around it. A keybinding resolves the context
		// of the focused element, which is inside the list, and that context's parent is the root -
		// a sibling scope wrapped around the list is never on the way and is never consulted.
		WorkspaceBarFocusContext.bindTo(this.list.contextKeyService).set(true);

		this._register(this.list.onContextMenu(e => this.onContextMenu(e)));

		this._register(this.model.onDidChange(() => this.refresh()));
		// ⚠️ A redraw, not a class toggled on whatever happens to be rendered: the list is
		// virtualised, so the rows are recycled and the mark has to come from the renderer.
		this._register(this.switcher.onDidChangeActive(() => this.refresh()));
		// ⚠️ A name or a colour is drawn by the renderer, so a change to one has to reach the rows
		// the same way a change to the folder list does. Without this the dialog saves and the bar
		// goes on showing what it showed before, until something else happens to redraw it.
		this._register(this.customizationService.onDidChange(() => this.refresh()));
		this.refresh();
	}

	/**
	 * Redraws the rows.
	 *
	 * ⚠️ `splice`, not `rerender`: `ListView.rerender` only resets dynamic row heights and returns
	 * immediately for a list that has none, so it reads like a redraw and is not one.
	 */
	private refresh(): void {
		const folders = this.model.folders;
		const focus = this.list.length > 0 ? this.list.getFocus() : [];
		const scrollTop = this.list.scrollTop;

		this.empty.classList.toggle('hidden', folders.length > 0);
		this.list.splice(0, this.list.length, [...folders]);

		this.list.setFocus(focus.filter(index => index < folders.length));
		this.list.scrollTop = scrollTop;
	}

	/** Whether `folder` is the one the window is in. */
	private isActive(folder: IWorkspaceFolder): boolean {
		const active = this.switcher.active;

		return !!active && this.model.key(active) === this.model.key(folder.uri);
	}

	/**
	 * The menu for one folder.
	 *
	 * The clicked row, not the active one: the list has already moved focus onto it, so what the
	 * menu acts on is what is highlighted behind it.
	 */
	private onContextMenu(e: IListContextMenuEvent<IWorkspaceFolder>): void {
		if (!e.element) {
			return;
		}

		this.contextMenuService.showContextMenu({
			menuId: WorkspaceBarContextMenu,
			menuActionOptions: { shouldForwardArgs: true, arg: e.element.uri },
			contextKeyService: this.list.contextKeyService,
			getAnchor: () => e.anchor
		});
	}

	/** The folder the list has focus on, for an action that arrived without one. */
	focused(): URI | undefined {
		return this.list.getFocusedElements()[0]?.uri;
	}

	layout(width: number, height: number): void {
		this.list.layout(height, width);
	}

	focus(): void {
		this.list.domFocus();
	}
}
