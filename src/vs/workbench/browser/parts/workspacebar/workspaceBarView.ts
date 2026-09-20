/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { IconLabel } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
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
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { FolderKey } from './workspaceBar.js';
import { WorkspaceBarContextMenu, WorkspaceBarFocusContext } from './workspaceBarActions.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';
import { WorkspaceBarSwitcher } from './workspaceBarSwitcher.js';

/** ⚠️ 32, not the workbench's usual 22: a dozen rows pointed at, not hundreds scanned. */
const ROW_HEIGHT = 32;

const TEMPLATE_ID = 'workspaceBar.folder';

class WorkspaceBarDelegate implements IListVirtualDelegate<IWorkspaceFolder> {
	getHeight(): number { return ROW_HEIGHT; }
	getTemplateId(): string { return TEMPLATE_ID; }
}

interface IRowTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: IconLabel;
	readonly templateDisposable: IDisposable;
}

class FolderRenderer implements IListRenderer<IWorkspaceFolder, IRowTemplate> {

	readonly templateId = TEMPLATE_ID;

	constructor(
		private readonly isUnavailable: (folder: IWorkspaceFolder) => boolean,
		private readonly isActive: (folder: IWorkspaceFolder) => boolean,
		@ILabelService private readonly labelService: ILabelService,
	) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const disposables = new DisposableStore();
		const row = append(container, $('.workspacebar-row'));
		const icon = append(row, $('.workspacebar-icon'));
		const label = disposables.add(new IconLabel(row, { supportHighlights: true, supportDescriptionHighlights: true }));

		return { row, icon, label, templateDisposable: disposables };
	}

	renderElement(folder: IWorkspaceFolder, _index: number, template: IRowTemplate): void {
		template.row.classList.toggle('unavailable', this.isUnavailable(folder));

		// ⚠️ The bar's own mark, not the list's selection. Which folder the window is in is a fact
		// about the window; a list's selection is the person's, and the list clears it when a
		// pointer lands anywhere on it that is not a row (`MouseController.onViewPointer`, where
		// `e.index` is undefined). That is right for a list and wrong for this.
		template.row.classList.toggle('active', this.isActive(folder));

		template.icon.className = `workspacebar-icon ${ThemeIcon.asClassName(Codicon.folder)}`;
		// ⚠️ The workspace's own name for the root, not the last segment of its path: a
		// `.code-workspace` can give a folder a name, and that is the one to show.
		// The full path on hover is what tells two rows with the same name apart.
		template.label.setLabel(folder.name, undefined, {
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
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();

		this.empty = append(container, $('.workspacebar-empty'));
		// Says what to do next, not that there is nothing.
		this.empty.textContent = localize('workspaceBar.empty', "Add a folder to get started.");

		this.list = this._register(instantiationService.createInstance(
			WorkbenchList<IWorkspaceFolder>,
			'WorkspaceBar',
			append(container, $('.workspacebar-list')),
			new WorkspaceBarDelegate(),
			[instantiationService.createInstance(FolderRenderer,
				(folder: IWorkspaceFolder) => model.isUnavailable(folder),
				(folder: IWorkspaceFolder) => this.isActive(folder))],
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
					listInactiveSelectionIconForeground: undefined
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
