/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, isHTMLElement } from '../../../../base/browser/dom.js';
import { IconLabel } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
import { HoverStyle } from '../../../../base/browser/ui/hover/hover.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeContextMenuEvent, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { NEW_WORKTREE_COMMAND, SHOW_WORKTREES, WorkspaceBarContextMenu, WorkspaceBarFocusContext, WorkspaceBarRowKindContext } from './workspaceBarActions.js';
import { IWorkspaceBarCustomizationService } from './workspaceBarCustomization.js';
import { IWorkspaceBarWorktree, WorkspaceBarGit, WorkspaceBarGroup } from './workspaceBarGit.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';
import { WorkspaceBarSwitcher } from './workspaceBarSwitcher.js';

/** ⚠️ 28, the compact activity bar's item height, measured. Not the workbench's usual 22: a dozen rows pointed at, not hundreds scanned. */
const ROW_HEIGHT = 28;

const TEMPLATE_ID = 'workspaceBar.row';

/** A folder of the list: a plain folder, or a repository's main checkout. */
interface IFolderRow {
	readonly kind: 'folder';
	readonly uri: URI;
	/** Undefined for a repository whose main checkout is not in `folders[]`: only a worktree of it was added. */
	readonly folder: IWorkspaceFolder | undefined;
	readonly repository: boolean;
	/** Its worktrees, so that it can carry the mark for one of them that cannot be seen (WT-1.10). */
	readonly worktrees: readonly URI[];
}

/** A worktree of a repository, under the repository's row. */
interface IWorktreeRow {
	readonly kind: 'worktree';
	readonly worktree: IWorkspaceBarWorktree;
}

/** What a repository with no worktrees shows under it, and a way to make the first one (WT-1.8). */
interface IPlaceholderRow {
	readonly kind: 'placeholder';
	readonly repository: URI;
}

export type WorkspaceBarRow = IFolderRow | IWorktreeRow | IPlaceholderRow;

function uriOf(row: WorkspaceBarRow): URI {
	switch (row.kind) {
		case 'folder': return row.uri;
		case 'worktree': return row.worktree.uri;
		case 'placeholder': return row.repository;
	}
}

function nameOf(row: WorkspaceBarRow): string {
	switch (row.kind) {
		case 'folder': return row.folder?.name ?? basename(row.uri);
		case 'worktree': return row.worktree.label;
		case 'placeholder': return localize('workspaceBar.noWorktrees', "No worktrees yet — create one");
	}
}

/**
 * What the tree holds.
 *
 * ⚠️ `folders[]` itself, flat, while `worktrees` is false: when they are switched off (WORKTREE.md section 11), and until
 * the first read of git's files has finished - the reader starts empty, and a bar drawn from it would
 * start blank and fill in.
 */
export function workspaceBarRows(input: {
	readonly folders: readonly IWorkspaceFolder[];
	readonly groups: readonly WorkspaceBarGroup[];
	readonly worktrees: boolean;
	readonly collapsed: boolean;
}): IObjectTreeElement<WorkspaceBarRow>[] {
	const flat = (folder: IWorkspaceFolder): IObjectTreeElement<WorkspaceBarRow> =>
		({ element: { kind: 'folder', uri: folder.uri, folder, repository: false, worktrees: [] } });

	if (!input.worktrees) {
		return input.folders.map(flat);
	}

	return input.groups.map(group => {
		if (group.kind === 'folder') {
			return flat(group.folder);
		}

		const children: IObjectTreeElement<WorkspaceBarRow>[] = group.worktrees.length > 0
			? group.worktrees.map(worktree => ({ element: { kind: 'worktree', worktree } }))
			: [{ element: { kind: 'placeholder', repository: group.main } }];

		return {
			element: { kind: 'folder', uri: group.main, folder: group.folder, repository: true, worktrees: group.worktrees.map(worktree => worktree.uri) },
			// ⚠️ Collapsed to its icons, a column cannot tell a repository from a worktree, so the
			// worktrees wait for the bar to open (WT-1.10).
			children: input.collapsed ? [] : children,
			collapsed: ObjectTreeElementCollapseState.PreserveOrExpanded
		};
	});
}

/**
 * Whether a row carries the mark for where the window is.
 *
 * Its own folder, always. And a repository's row stands in for a worktree of it while that worktree's
 * row cannot be seen - the bar collapsed to its icons, or the repository's row closed (WT-1.10) - so
 * the column never loses its one "you are here".
 */
export function carriesMark(row: WorkspaceBarRow, active: URI | undefined, worktreesHidden: boolean, key: (uri: URI) => string): boolean {
	if (!active || row.kind === 'placeholder') {
		return false;
	}

	const activeKey = key(active);
	if (key(uriOf(row)) === activeKey) {
		return true;
	}

	return row.kind === 'folder' && worktreesHidden && row.worktrees.some(worktree => key(worktree) === activeKey);
}

class WorkspaceBarDelegate implements IListVirtualDelegate<WorkspaceBarRow> {
	getHeight(): number { return ROW_HEIGHT; }
	getTemplateId(): string { return TEMPLATE_ID; }
}

interface IRowTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: IconLabel;
	/** `New Worktree...` on a repository's row, shown while the pointer is on it. */
	readonly add: HTMLElement;
	/** The bar's own disclosure triangle, last in the row. The tree's is hidden: see `twistieAdditionalCssClass`. */
	readonly twistie: HTMLElement;
	/**
	 * ⚠️ Mutable, and read by the hover rather than handed to it. A template is reused for whatever
	 * row scrolls into it, so a hover closed over the folder it was built with would name the folder
	 * that used to be there.
	 */
	name: string;
	readonly templateDisposable: IDisposable;
}

class RowRenderer implements ITreeRenderer<WorkspaceBarRow, void, IRowTemplate> {

	readonly templateId = TEMPLATE_ID;

	constructor(
		private readonly isUnavailable: (row: WorkspaceBarRow) => boolean,
		private readonly isActive: (node: ITreeNode<WorkspaceBarRow, void>) => boolean,
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
		const add = append(row, $(`.workspacebar-add${ThemeIcon.asCSSSelector(Codicon.add)}`));
		const twistie = append(row, $('.workspacebar-twistie'));

		const template: IRowTemplate = { row, add, twistie, icon, label, name: '', templateDisposable: disposables };

		add.setAttribute('role', 'button');
		add.setAttribute('aria-label', localize('workspaceBar.newWorktree', "New Worktree..."));
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), add, localize('workspaceBar.newWorktree', "New Worktree...")));

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

	renderElement(node: ITreeNode<WorkspaceBarRow, void>, _index: number, template: IRowTemplate): void {
		const element = node.element;

		template.row.classList.toggle('unavailable', this.isUnavailable(element));

		// ⚠️ The bar's own mark, not the list's selection. Which folder the window is in is a fact
		// about the window; a list's selection is the person's, and the list clears it when a
		// pointer lands anywhere on it that is not a row (`MouseController.onViewPointer`, where
		// `e.index` is undefined). That is right for a list and wrong for this.
		template.row.classList.toggle('active', this.isActive(node));

		// ⚠️ The bar's own triangle, drawn inside the row rather than the tree's beside it. The tree's
		// sits outside the row's box, so the band and the leading line that mark a row would start
		// after it and run down the middle of the column instead of its edge.
		// ⚠️ And at the row's trailing end, not its leading one: a leading triangle moves every folder
		// icon along, and the icons are where they are because collapsing is measured to move none.
		const twistie = node.collapsible ? (node.collapsed ? Codicon.chevronRight : Codicon.chevronDown) : undefined;
		template.twistie.className = twistie ? `workspacebar-twistie ${ThemeIcon.asClassName(twistie)}` : 'workspacebar-twistie hidden';

		template.row.classList.toggle('worktree', element.kind === 'worktree');
		template.row.classList.toggle('placeholder', element.kind === 'placeholder');
		template.add.classList.toggle('hidden', element.kind !== 'folder' || !element.repository);

		if (element.kind === 'placeholder') {
			template.icon.className = `workspacebar-icon ${ThemeIcon.asClassName(Codicon.add)}`;
			template.name = nameOf(element);
			template.label.setLabel(template.name);
			return;
		}

		if (element.kind === 'worktree') {
			template.icon.className = `workspacebar-icon ${ThemeIcon.asClassName(Codicon.gitBranch)}`;
			template.name = element.worktree.label;
			template.label.setLabel(template.name, undefined, {
				title: this.labelService.getUriLabel(element.worktree.uri)
			});
			return;
		}

		// ⚠️ The colour paints the icon and nothing else. Not the name, not the chevron: a row is
		// read as a name, and a name in six colours is six kinds of emphasis nobody asked for.
		// ⚠️ And the glyph is a choice too now. `folder` is the fallback rather than a stored value,
		// so a folder nobody has customised and one set back to a plain folder draw the same.
		const customization = this.customizationService.get(element.uri);
		const glyph = customization?.icon ? ThemeIcon.fromId(customization.icon) : Codicon.folder;
		template.icon.className = `workspacebar-icon ${ThemeIcon.asClassName(glyph)}`
			+ (customization?.color ? ` workspacebar-icon-${customization.color}` : '');

		// ⚠️ Through `nameFor`, which the window title also calls. The workspace's own name for the
		// root is the fallback - a `.code-workspace` can name a folder and that name is somebody's
		// too - but a display name set here wins over it. A repository whose main checkout is not a
		// folder of the workspace has no workspace name, only its own and the directory's.
		// The full path on hover is what tells two rows with the same name apart.
		template.name = element.folder
			? this.customizationService.nameFor(element.folder)
			: customization?.name || basename(element.uri);
		template.label.setLabel(template.name, undefined, {
			title: this.labelService.getUriLabel(element.uri)
		});
	}

	disposeTemplate(template: IRowTemplate): void {
		template.templateDisposable.dispose();
	}
}

class WorkspaceBarIdentityProvider implements IIdentityProvider<WorkspaceBarRow> {

	constructor(private readonly key: (uri: URI) => string) { }

	getId(row: WorkspaceBarRow): string {
		return `${row.kind}:${this.key(uriOf(row))}`;
	}
}

class WorkspaceBarAccessibilityProvider implements IListAccessibilityProvider<WorkspaceBarRow> {

	constructor(private readonly isUnavailable: (row: WorkspaceBarRow) => boolean) { }

	getWidgetAriaLabel(): string {
		return localize('workspaceBar.ariaLabel', "Workspace folders");
	}

	getAriaLabel(row: WorkspaceBarRow): string {
		const name = nameOf(row);
		if (this.isUnavailable(row)) {
			return localize('workspaceBar.unavailableAria', "{0}, not on disk", name);
		}

		return row.kind === 'worktree' ? localize('workspaceBar.worktreeAria', "{0}, worktree", name) : name;
	}
}

class WorkspaceBarKeyboardNavigationLabelProvider implements IKeyboardNavigationLabelProvider<WorkspaceBarRow> {

	getKeyboardNavigationLabel(row: WorkspaceBarRow): string {
		return nameOf(row);
	}
}

/**
 * The folders, and the worktrees of each repository among them.
 *
 * ⚠️ Declarative: every change rebuilds the whole tree with one `setChildren`, and each repository
 * row says `PreserveOrExpanded`, so the tree keeps what somebody expanded or collapsed by the rows'
 * identity. Kumite's first tree cached row objects and applied collapse state by hand to avoid this,
 * and rows still closed by themselves (WORKTREE.md section 13).
 */
export class WorkspaceBarView extends Disposable {

	private readonly tree: WorkbenchObjectTree<WorkspaceBarRow, void>;
	private readonly empty: HTMLElement;
	private readonly rowKind: IContextKey<'folder' | 'repository' | 'worktree'>;

	constructor(
		container: HTMLElement,
		private readonly model: WorkspaceBarModel,
		private readonly git: WorkspaceBarGit,
		private readonly switcher: WorkspaceBarSwitcher,
		private readonly isCollapsed: () => boolean,
		onDidChangeCollapsed: Event<void>,
		/** Puts a folder in the workspace and moves the window onto it: `IWorkspaceBarService.show`. */
		private readonly show: (uri: URI) => Promise<void>,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.empty = append(container, $('.workspacebar-empty'));
		// ⚠️ Says what to do next, and names both ways of doing it - the column is a drop target over
		// its whole height, which nothing else on screen says.
		this.empty.textContent = localize('workspaceBar.empty', "Open a folder or drag one here.");

		const isUnavailable = (row: WorkspaceBarRow) => row.kind === 'worktree'
			? !row.worktree.exists
			: row.kind === 'folder' && !!row.folder && model.isUnavailable(row.folder);

		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<WorkspaceBarRow, void>,
			'WorkspaceBar',
			append(container, $('.workspacebar-list')),
			new WorkspaceBarDelegate(),
			[instantiationService.createInstance(RowRenderer,
				isUnavailable,
				(node: ITreeNode<WorkspaceBarRow, void>) => this.isActive(node),
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
				// ⚠️ The bar's own rule, not `uri.toString()`: the tree keeps focus, selection and what is
				// expanded on the right row across a rebuild with it, so it has to agree with everything else.
				identityProvider: new WorkspaceBarIdentityProvider(model.key),
				accessibilityProvider: new WorkspaceBarAccessibilityProvider(isUnavailable),
				keyboardNavigationLabelProvider: new WorkspaceBarKeyboardNavigationLabelProvider(),
				// One click. Left alone this follows `workbench.list.openMode`, which is about files.
				openOnSingleClick: true,
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				// ⚠️ A click on a row goes there; only the triangle expands. With the tree's own triangle
				// hidden, "only the twistie" means never, and `onDidOpen` below toggles on the bar's own.
				expandOnlyOnTwistieClick: true,
				expandOnDoubleClick: false,
				// ⚠️ The tree draws no triangle, no indent and no guides: all three sit outside the row's
				// box. The row draws its own triangle, last, and indents a worktree inside its box, so the
				// band and the leading line still run the column's full width. Upstream's sessions list
				// hides the tree's triangle the same way (`sessionsList.ts`).
				indent: 0,
				defaultIndent: 0,
				renderIndentGuides: RenderIndentGuides.None,
				twistieAdditionalCssClass: () => 'force-no-twistie',
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
		)) as WorkbenchObjectTree<WorkspaceBarRow, void>;

		this._register(this.tree.onDidOpen(e => {
			if (e.element) {
				this.open(e.element, e.browserEvent).then(undefined, onUnexpectedError);
			}
		}));

		// ⚠️ On the tree's own scope, not a scope of ours around it. A keybinding resolves the context
		// of the focused element, which is inside the tree, and that context's parent is the root -
		// a sibling scope wrapped around the tree is never on the way and is never consulted.
		WorkspaceBarFocusContext.bindTo(this.tree.contextKeyService).set(true);
		this.rowKind = WorkspaceBarRowKindContext.bindTo(this.tree.contextKeyService);
		this._register(this.tree.onDidChangeFocus(e => this.setRowKind(e.elements[0] ?? undefined)));

		this._register(this.tree.onContextMenu(e => this.onContextMenu(e)));

		// A repository row carries the mark for a worktree of it only while that worktree is hidden,
		// so expanding or collapsing it changes how it is drawn.
		this._register(this.tree.onDidChangeCollapseState(e => {
			if (e.node.element) {
				this.tree.rerender(e.node.element);
			}
		}));

		this._register(this.model.onDidChange(() => this.refresh()));
		this._register(this.git.onDidChange(() => this.refresh()));
		// ⚠️ A redraw, not a class toggled on whatever happens to be rendered: the list is
		// virtualised, so the rows are recycled and the mark has to come from the renderer.
		this._register(this.switcher.onDidChangeActive(() => this.refresh()));
		// ⚠️ A name or a colour is drawn by the renderer, so a change to one has to reach the rows
		// the same way a change to the folder list does. Without this the dialog saves and the bar
		// goes on showing what it showed before, until something else happens to redraw it.
		this._register(this.customizationService.onDidChange(() => this.refresh()));
		// Collapsed to its icons, the bar shows folder rows only (WT-1.10).
		this._register(onDidChangeCollapsed(() => this.refresh()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SHOW_WORKTREES)) {
				this.refresh();
			}
		}));
		this.refresh();
	}

	/** Rebuilds the tree. */
	private refresh(): void {
		this.empty.classList.toggle('hidden', this.model.folders.length > 0);
		this.tree.setChildren(null, workspaceBarRows({
			folders: this.model.folders,
			groups: this.git.groups,
			worktrees: this.configurationService.getValue<boolean>(SHOW_WORKTREES) !== false && this.git.ready,
			collapsed: this.isCollapsed()
		}));

		// ⚠️ Rows whose data did not change are kept as they were by the identity provider, and so is
		// the mark on them - which may now be wrong: the mark depends on where the window is, not on
		// the row. Draw them all again.
		this.tree.rerender();
	}

	private isActive(node: ITreeNode<WorkspaceBarRow, void>): boolean {
		return carriesMark(node.element, this.switcher.active, this.isCollapsed() || node.collapsed, this.model.key);
	}

	/**
	 * Goes to a row, or opens and closes it when the click was on its triangle.
	 *
	 * ⚠️ A row whose folder is not in the workspace goes through `show`, which puts it there first;
	 * one that is, through the switcher. A worktree whose folder is gone goes to the switcher either
	 * way: it checks the disk before anything else and says so, rather than adding a folder that is
	 * not there.
	 */
	private async open(row: WorkspaceBarRow, browserEvent: UIEvent | undefined): Promise<void> {
		const target = browserEvent?.target;
		if (isHTMLElement(target) && target.closest('.workspacebar-twistie') && this.tree.isCollapsible(row)) {
			this.tree.toggleCollapsed(row);
			return;
		}

		// A repository's `+`, and the row that says it has no worktrees yet, both make one.
		if (row.kind === 'placeholder' || (row.kind === 'folder' && row.repository && isHTMLElement(target) && target.closest('.workspacebar-add'))) {
			await this.commandService.executeCommand(NEW_WORKTREE_COMMAND, uriOf(row));
			return;
		}

		if (row.kind === 'folder') {
			return row.folder ? this.switcher.switchTo(row.folder.uri) : this.show(row.uri);
		}

		const { worktree } = row;
		if (worktree.folder || !worktree.exists) {
			return this.switcher.switchTo(worktree.folder?.uri ?? worktree.uri);
		}

		return this.show(worktree.uri);
	}

	private setRowKind(row: WorkspaceBarRow | undefined): void {
		if (!row) {
			this.rowKind.set('folder');
			return;
		}

		// The placeholder stands in for its repository, so its menu is the repository's.
		this.rowKind.set(row.kind === 'worktree' ? 'worktree' : row.kind === 'placeholder' || row.repository ? 'repository' : 'folder');
	}

	/**
	 * The menu for one row.
	 *
	 * The clicked row, not the active one: the tree has already moved focus onto it, so what the
	 * menu acts on is what is highlighted behind it.
	 */
	private onContextMenu(e: ITreeContextMenuEvent<WorkspaceBarRow | null>): void {
		if (!e.element) {
			return;
		}

		this.setRowKind(e.element);
		this.contextMenuService.showContextMenu({
			menuId: WorkspaceBarContextMenu,
			menuActionOptions: { shouldForwardArgs: true, arg: uriOf(e.element) },
			contextKeyService: this.tree.contextKeyService,
			getAnchor: () => e.anchor
		});
	}

	/** The row the tree has focus on, for an action that arrived without one. */
	focused(): URI | undefined {
		const row = this.tree.getFocus()[0];
		return row ? uriOf(row) : undefined;
	}

	layout(width: number, height: number): void {
		this.tree.layout(height, width);
	}

	focus(): void {
		this.tree.domFocus();
	}
}
