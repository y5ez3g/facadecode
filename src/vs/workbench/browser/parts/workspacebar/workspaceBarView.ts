/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow, isHTMLElement, reset, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { IconLabel } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
import { HoverStyle } from '../../../../base/browser/ui/hover/hover.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeContextMenuEvent, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultCountBadgeStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { asCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { FolderKey, orderWorktrees } from './workspaceBar.js';
import { areWorktreesShown, SHOW_WORKTREES, WorkspaceBarContextMenu, WorkspaceBarFocusContext, WorkspaceBarRowExpansionContext, WorkspaceBarRowKindContext, WorkspaceBarRowToolbar } from './workspaceBarActions.js';
import { IWorkspaceBarAgentsService } from './workspaceBarAgents.js';
import { FACADE_AGENT_BADGE_BACKGROUND, FACADE_AGENT_BADGE_FOREGROUND } from './workspaceBarColors.js';
import { folderGlyphFor, folderRowNameFor, IWorkspaceBarCustomizationService, worktreeIcon, worktreeNameFor } from './workspaceBarCustomization.js';
import { IWorkspaceBarWorktree, WorkspaceBarGit, WorkspaceBarGroup } from './workspaceBarGit.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';
import { WorkspaceBarSwitcher } from './workspaceBarSwitcher.js';

/** ⚠️ 28, the compact activity bar's item height, measured. Not the workbench's usual 22: a dozen rows pointed at, not hundreds scanned. */
export const ROW_HEIGHT = 28;

const TEMPLATE_ID = 'workspaceBar.row';

/** How many agents a row draws by their logos; the rest are counted, `+N` (WT-1.15). */
const MAX_AGENT_LOGOS = 3;

/** The repositories somebody closed in this workspace (WT-1.10), as a list of their main checkouts' keys. */
const CLOSED_STORAGE_KEY = 'facade.workspaceBar.closedRepositories';

/** What `CLOSED_STORAGE_KEY` holds; nothing when it cannot be read, which costs only the state. */
function readClosed(storageService: IStorageService): string[] {
	try {
		const stored: unknown = JSON.parse(storageService.get(CLOSED_STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
		return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [];
	} catch {
		return [];
	}
}

/** A folder of the list: a plain folder, or a repository's main checkout. */
interface IFolderRow {
	readonly kind: 'folder';
	readonly uri: URI;
	/** Undefined for a repository whose main checkout is not in `folders[]`: only a worktree of it was added. */
	readonly folder: IWorkspaceFolder | undefined;
	readonly repository: boolean;
	/** Its worktrees, so that it can carry the mark for one of them that cannot be seen (WT-1.10). */
	readonly worktrees: readonly URI[];
	/**
	 * Whether its row offers `New Worktree...` - every folder while the bar lists worktrees, a folder
	 * with no repository of its own included, which becomes one first (WT-5.8). None while they are
	 * switched off: the bar is then the list it was before them.
	 */
	readonly offersWorktree: boolean;
}

/** A worktree of a repository, under the repository's row. */
interface IWorktreeRow {
	readonly kind: 'worktree';
	readonly worktree: IWorkspaceBarWorktree;
}

export type WorkspaceBarRow = IFolderRow | IWorktreeRow;

function uriOf(row: WorkspaceBarRow): URI {
	return row.kind === 'folder' ? row.uri : row.worktree.uri;
}

/**
 * The folder of the workspace a row is, when it is one: what the agent launchers report agents by
 * (`IFolderTerminalsService.folderOf`).
 *
 * ⚠️ Not `uriOf`, which for a worktree is the path git recorded. The two name one directory and can
 * be spelled apart - `/tmp/x` and `/private/tmp/x`, a junction - and the row would show none of the
 * agents running in it.
 */
function workspaceFolderUriOf(row: WorkspaceBarRow): URI {
	return row.kind === 'folder' ? row.folder?.uri ?? row.uri : row.worktree.folder?.uri ?? row.worktree.uri;
}

/** What a row says is in it (WT-1.15), on screen and to a screen reader alike. */
interface IRowContents {
	/** A closed repository's worktrees; none for any other row, whose worktrees are rows of their own. */
	readonly worktrees: number;
	/** The icons of the agents running in its folder, and while it is a closed repository in its worktrees too. */
	readonly agents: readonly ThemeIcon[];
}

function rowContentsOf(node: ITreeNode<WorkspaceBarRow | null, void>, agentsService: IWorkspaceBarAgentsService): IRowContents {
	// A closed repository speaks for its worktrees, as its count does: their agents after its own
	const closed = node.collapsible && node.collapsed;
	const rows = closed ? [node.element, ...node.children.map(child => child.element)] : [node.element];
	return {
		worktrees: closed ? node.children.length : 0,
		// Only the tree's root has no element, and it is never a row
		agents: rows.flatMap(row => row ? agentsService.agentsIn(workspaceFolderUriOf(row)) : [])
	};
}

/**
 * What a row is called on screen, to a screen reader and to type-to-find alike - for a folder of the
 * workspace, what `nameFor` calls it, as the window title does: the name somebody gave it, else a
 * worktree's branch, else the folder's own name.
 */
function displayNameOf(row: WorkspaceBarRow, customizationService: IWorkspaceBarCustomizationService): string {
	if (row.kind === 'worktree') {
		return worktreeNameFor(customizationService, row.worktree);
	}

	return folderRowNameFor(customizationService, row.uri, row.folder);
}

/**
 * The rows to draw: `folders[]` flat while worktrees are off or unread, else grouped by git's records
 * (WORKTREE.md WT-3.6). A folder that joined since the last read gets a row of its own at the end.
 */
export function workspaceBarRows(input: {
	readonly folders: readonly IWorkspaceFolder[];
	readonly groups: readonly WorkspaceBarGroup[];
	readonly worktrees: boolean;
	readonly key: FolderKey;
	/** Whether somebody closed the repository of `main` - kept across a reload, for its first drawing. */
	readonly closed?: (main: URI) => boolean;
	/** Whether a worktree is being deleted: its row is left out while git still records it (WT-8.9). */
	readonly leaving?: (worktree: URI) => boolean;
}): IObjectTreeElement<WorkspaceBarRow>[] {
	const flat = (folder: IWorkspaceFolder): IObjectTreeElement<WorkspaceBarRow> =>
		({ element: { kind: 'folder', uri: folder.uri, folder, repository: false, worktrees: [], offersWorktree: input.worktrees }, collapsible: false });

	if (!input.worktrees) {
		return input.folders.map(flat);
	}

	const present = new Map(input.folders.map(folder => [input.key(folder.uri), folder]));
	const drawn = new Set<string>();
	const take = (key: string): IWorkspaceFolder | undefined => {
		const current = present.get(key);
		if (current) {
			drawn.add(key);
		}
		return current;
	};

	// The folders the last read placed. Any other folder of folders[] joined since.
	const read = new Set(input.groups.flatMap(group => group.kind === 'folder' ? [group.folder] : group.members).map(folder => input.key(folder.uri)));

	/** The folder the last read found, while it is still in folders[]. */
	const stillIn = (folder: IWorkspaceFolder | undefined) => folder ? take(input.key(folder.uri)) : undefined;
	/** A folder that joined folders[] since the last read, at a path git's records name. */
	const joined = (uri: URI) => read.has(input.key(uri)) ? undefined : take(input.key(uri));

	const rows: IObjectTreeElement<WorkspaceBarRow>[] = [];
	for (const group of input.groups) {
		if (group.kind === 'folder') {
			const folder = stillIn(group.folder);
			if (folder) {
				rows.push(flat(folder));
			}
			continue;
		}

		// Every folder of it is on this row, under whichever spelling it was added by, and on no other.
		// A worktree that has left the workspace is still one of the repository's; a repository with no
		// folder left in the workspace, or none but a worktree being deleted, is not drawn.
		const remaining = group.members.map(stillIn).filter(member => member !== undefined);
		const main = stillIn(group.folder) ?? joined(group.main);
		// A worktree being deleted takes its folder with it: still in folders[] for a moment, it is not
		// drawn at the end either.
		const leaving = new Set<string>();
		const worktrees = group.worktrees.flatMap(worktree => {
			const folder = stillIn(worktree.folder) ?? joined(worktree.uri);
			if (input.leaving?.(worktree.uri)) {
				leaving.add(input.key(worktree.uri));
				if (folder) {
					leaving.add(input.key(folder.uri));
				}
				return [];
			}
			return [{ ...worktree, folder }];
		});
		if (!main && !worktrees.some(worktree => worktree.folder) && remaining.every(member => leaving.has(input.key(member.uri)))) {
			continue;
		}

		// Whether a repository is open is the tree's to keep across rebuilds, and its first drawing is as
		// it was left (`PreserveOr...`). One without worktrees is neither collapsible nor collapsed
		// (WT-1.8): collapsible, Left and Space closed a row with nothing in it; left collapsed, its
		// first worktree arrived hidden.
		const hasWorktrees = worktrees.length > 0;
		rows.push({
			element: { kind: 'folder', uri: group.main, folder: main, repository: true, worktrees: worktrees.map(worktree => worktree.uri), offersWorktree: true },
			children: worktrees.map(worktree => ({ element: { kind: 'worktree', worktree } })),
			collapsible: hasWorktrees,
			collapsed: !hasWorktrees ? ObjectTreeElementCollapseState.Expanded
				: input.closed?.(group.main) ? ObjectTreeElementCollapseState.PreserveOrCollapsed : ObjectTreeElementCollapseState.PreserveOrExpanded
		});
	}

	for (const folder of input.folders) {
		if (!drawn.has(input.key(folder.uri))) {
			rows.push(flat(folder));
		}
	}

	return rows;
}

/**
 * Whether a row carries the mark for where the window is.
 *
 * Its own folder, always. And a repository's row stands in for a worktree of it while that worktree's
 * row cannot be seen - the repository's row closed, whether the bar is open or collapsed to its icons
 * (WT-1.10) - so the column never loses its one "you are here".
 */
export function carriesMark(row: WorkspaceBarRow, active: URI | undefined, worktreesHidden: boolean, key: (uri: URI) => string): boolean {
	if (!active) {
		return false;
	}

	if (key(uriOf(row)) === key(active)) {
		return true;
	}

	return worktreesHidden && isOnWorktreeOf(row, active, key);
}

/**
 * Whether the window is on one of the worktrees under a repository's row - which closing that row
 * would hide, and so sends the window to the repository itself (WT-1.5).
 */
export function isOnWorktreeOf(row: WorkspaceBarRow, active: URI | undefined, key: (uri: URI) => string): boolean {
	if (!active || row.kind !== 'folder') {
		return false;
	}

	const activeKey = key(active);
	return row.worktrees.some(worktree => key(worktree) === activeKey);
}

class WorkspaceBarDelegate implements IListVirtualDelegate<WorkspaceBarRow> {
	getHeight(): number { return ROW_HEIGHT; }
	getTemplateId(): string { return TEMPLATE_ID; }
}

interface IRowTemplate {
	readonly row: HTMLElement;
	/** A folder's icon, or a worktree's glyph. */
	readonly icon: HTMLElement;
	readonly label: IconLabel;
	/** A folder's own buttons (`WorkspaceBarRowToolbar`) - its `+` - shown while the pointer is on it. */
	readonly toolbar: MenuWorkbenchToolBar;
	/**
	 * The bar's own disclosure triangle, in a repository's icon slot, which it takes under the pointer.
	 * The tree's is hidden: see `twistieAdditionalCssClass`.
	 */
	readonly twistie: HTMLElement;
	/** A closed repository's worktrees, counted in a badge on its icon (WT-1.15). */
	readonly worktreeCount: HTMLElement;
	/** That the row's folder runs agents, on its icon while the bar is collapsed to icons (WT-1.15). */
	readonly agentDot: HTMLElement;
	/** The logos of the agents running in the row's folder, up to `MAX_AGENT_LOGOS` (WT-1.15). */
	readonly agentLogos: HTMLElement;
	/** `+N` after them, for the agents past the last logo; hidden while there are none. */
	readonly moreAgents: HTMLElement;
	readonly moreAgentsBadge: CountBadge;
	/**
	 * ⚠️ Mutable, and read by the hover rather than handed to it. A template is reused for whatever
	 * row scrolls into it, so a hover closed over the folder it was built with would name the folder
	 * that used to be there.
	 */
	name: string;
	/** What pressing the triangle does, `Expand` or `Collapse` - mutable for the same reason as `name`. */
	twistieLabel: string;
	/** The row this template drew last (`WorkspaceBarIdentityProvider`), to know when it is handed another. */
	id: string | undefined;
	/** Taking `recycled` back off, two frames after the template was handed another row. */
	readonly recycled: MutableDisposable<IDisposable>;
	readonly templateDisposable: IDisposable;
}

class RowRenderer implements ITreeRenderer<WorkspaceBarRow, void, IRowTemplate> {

	readonly templateId = TEMPLATE_ID;

	constructor(
		private readonly isUnavailable: (row: WorkspaceBarRow) => boolean,
		private readonly isActive: (node: ITreeNode<WorkspaceBarRow, void>) => boolean,
		private readonly isCollapsed: () => boolean,
		private readonly hoverDelegate: IHoverDelegate,
		/** The row's id, as the tree knows it (`WorkspaceBarIdentityProvider`). */
		private readonly idOf: (row: WorkspaceBarRow) => string,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
		@IWorkspaceBarAgentsService private readonly agentsService: IWorkspaceBarAgentsService,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const disposables = new DisposableStore();
		const row = append(container, $('.workspacebar-row'));
		// The one slot every row draws its glyph in, so every name in the column starts on one line.
		const glyph = append(row, $('.workspacebar-glyph'));
		const icon = append(glyph, $('.workspacebar-icon'));
		// A repository's triangle, over its icon: under the pointer the folder gives way to it.
		const twistie = append(glyph, $(`.workspacebar-twistie${ThemeIcon.asCSSSelector(Codicon.treeItemExpanded)}`));
		// A closed repository's worktrees, counted on its icon as the activity bar counts on its own.
		const worktreeCount = append(glyph, $('.workspacebar-worktree-count'));
		// Collapsed to icons the logos are gone: a dot on the icon says its folder runs agents.
		const agentDot = append(glyph, $('.workspacebar-agent-dot'));
		const label = disposables.add(new IconLabel(row, { supportHighlights: true, supportDescriptionHighlights: true }));
		// The row's end: the agents its folder runs, and a folder's `+` in the same place, under the
		// header's `+`, taking theirs under the pointer.
		const actions = append(row, $('.workspacebar-row-actions'));
		const agents = append(actions, $('.workspacebar-agents'));
		const agentLogos = append(agents, $('.workspacebar-agent-logos'));
		const moreAgents = append(agents, $('.workspacebar-more-agents'));
		// Its hover says how many, singular or plural, as each row draws it.
		const moreAgentsBadge = disposables.add(new CountBadge(moreAgents, { countFormat: '+{0}' }, {
			...defaultCountBadgeStyles,
			badgeBackground: asCssVariable(FACADE_AGENT_BADGE_BACKGROUND),
			badgeForeground: asCssVariable(FACADE_AGENT_BADGE_FOREGROUND)
		}));
		const toolbar = disposables.add(this.instantiationService.createInstance(MenuWorkbenchToolBar, append(actions, $('.workspacebar-row-toolbar')), WorkspaceBarRowToolbar, {
			menuOptions: { shouldForwardArgs: true },
			hiddenItemStrategy: HiddenItemStrategy.NoHide
		}));
		// Pointer only, as the triangle: a stop in every row would make Tab walk the list. The keyboard
		// has the row's menu.
		toolbar.setFocusable(false);

		const template: IRowTemplate = { row, toolbar, twistie, worktreeCount, agentDot, agentLogos, moreAgents, moreAgentsBadge, icon, label, name: '', twistieLabel: '', id: undefined, recycled: disposables.add(new MutableDisposable()), templateDisposable: disposables };

		twistie.setAttribute('role', 'button');
		disposables.add(this.hoverService.setupDelayedHover(twistie, () => ({ content: template.twistieLabel })));

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

		// A template handed a different row - the list reuses its elements when the row count changes or
		// it scrolls - shows it at once instead of transitioning from the last row it drew. `recycled`
		// turns the transitions off (`workspacebarpart.css`) for two frames, so the first is drawn with it.
		const id = this.idOf(element);
		if (template.id !== undefined && template.id !== id) {
			template.row.classList.add('recycled');
			const targetWindow = getWindow(template.row);
			template.recycled.value = scheduleAtNextAnimationFrame(targetWindow, () => {
				template.recycled.value = scheduleAtNextAnimationFrame(targetWindow, () => template.row.classList.remove('recycled'));
			});
		}
		template.id = id;

		template.row.classList.toggle('unavailable', this.isUnavailable(element));

		// ⚠️ The bar's own mark, not the list's selection. Which folder the window is in is a fact
		// about the window; a list's selection is the person's, and the list clears it when a
		// pointer lands anywhere on it that is not a row (`MouseController.onViewPointer`, where
		// `e.index` is undefined). That is right for a list and wrong for this.
		template.row.classList.toggle('active', this.isActive(node));

		// The bar's own triangle, in the row's icon slot: the tree's sits outside the row's box and would
		// push the row's band and mark off the column's edge. Drawn as every tree in the workbench draws
		// its own, down while open and turned to point right while closed. Only repositories with
		// worktrees are collapsible (`workspaceBarRows`).
		template.row.classList.toggle('collapsible', node.collapsible);
		template.twistie.classList.toggle('collapsed', node.collapsed);
		template.twistieLabel = node.collapsed ? localize('workspaceBar.expand', "Expand") : localize('workspaceBar.collapse', "Collapse");
		template.twistie.setAttribute('aria-label', template.twistieLabel);

		// A closed repository counts its worktrees on its icon, where an open one lists them (WT-1.15).
		const { worktrees, agents } = rowContentsOf(node, this.agentsService);
		template.worktreeCount.textContent = worktrees ? String(worktrees) : '';
		template.worktreeCount.hidden = !worktrees;

		// The `+` on every folder of the list while the bar lists worktrees - a plain one included (WT-5.8).
		template.row.classList.toggle('offers-worktree', element.kind === 'folder' && element.offersWorktree);
		template.toolbar.context = uriOf(element);

		// Each agent by its logo, oldest first; past the last logo, how many more (WT-1.15).
		reset(template.agentLogos, ...agents.slice(0, MAX_AGENT_LOGOS).map(agent => $(`span.workspacebar-agent${ThemeIcon.asCSSSelector(agent)}`)));
		const more = Math.max(0, agents.length - MAX_AGENT_LOGOS);
		template.moreAgentsBadge.setCount(more);
		template.moreAgentsBadge.setTitleFormat(more === 1 ? localize('workspaceBar.oneMoreAgent', "1 more agent") : localize('workspaceBar.moreAgents', "{0} more agents"));
		template.moreAgents.hidden = more === 0;
		template.agentDot.hidden = agents.length === 0;

		// A glyph in the folder icon's slot rather than an indent: the glyph says the depth, and the column
		// keeps one left edge. A worktree's name and colour are its own; unnamed, it is called by its branch.
		if (element.kind === 'worktree') {
			const customization = this.customizationService.get(element.worktree.uri);
			template.icon.className = `workspacebar-icon workspacebar-worktree ${ThemeIcon.asClassName(worktreeIcon)}`
				+ (customization?.color ? ` workspacebar-icon-${customization.color}` : '');
		} else {
			// ⚠️ The colour paints the icon and nothing else. Not the name, not the chevron: a row is
			// read as a name, and a name in ten colours is ten kinds of emphasis nobody asked for.
			const customization = this.customizationService.get(element.uri);
			template.icon.className = `workspacebar-icon ${ThemeIcon.asClassName(folderGlyphFor(customization))}`
				+ (customization?.color ? ` workspacebar-icon-${customization.color}` : '');
		}

		// The hover shows the whole name, which the row's agents can cut short
		template.name = displayNameOf(element, this.customizationService);
		template.label.setLabel(template.name, undefined, { title: template.name });
	}

	disposeTemplate(template: IRowTemplate): void {
		template.templateDisposable.dispose();
	}
}

export class WorkspaceBarIdentityProvider implements IIdentityProvider<WorkspaceBarRow> {

	constructor(private readonly key: (uri: URI) => string) { }

	getId(row: WorkspaceBarRow): string {
		return `${row.kind}:${this.key(uriOf(row))}`;
	}
}

class WorkspaceBarAccessibilityProvider implements IListAccessibilityProvider<WorkspaceBarRow> {

	constructor(
		private readonly isUnavailable: (row: WorkspaceBarRow) => boolean,
		private readonly nameOf: (row: WorkspaceBarRow) => string,
		/** What the row shows is in it: asked of its tree node, which knows whether it is closed. */
		private readonly contentsOf: (row: WorkspaceBarRow) => IRowContents
	) { }

	getWidgetAriaLabel(): string {
		return localize('workspaceBar.ariaLabel', "Workspace folders");
	}

	getAriaLabel(row: WorkspaceBarRow): string {
		const name = this.nameOf(row);
		const label = this.isUnavailable(row)
			? localize('workspaceBar.unavailableAria', "{0}, not on disk", name)
			: row.kind === 'worktree' ? localize('workspaceBar.worktreeAria', "{0}, worktree", name) : name;

		// What the row shows at its end and on its icon, read out after its name (WT-1.15, W9.14)
		const { worktrees, agents } = this.contentsOf(row);
		const counts: string[] = [];
		if (worktrees) {
			counts.push(worktrees === 1 ? localize('workspaceBar.oneWorktreeAria', "1 worktree") : localize('workspaceBar.worktreesAria', "{0} worktrees", worktrees));
		}
		if (agents.length) {
			counts.push(agents.length === 1 ? localize('workspaceBar.oneAgentAria', "1 agent") : localize('workspaceBar.agentsAria', "{0} agents", agents.length));
		}
		return [label, ...counts].join(', ');
	}
}

class WorkspaceBarKeyboardNavigationLabelProvider implements IKeyboardNavigationLabelProvider<WorkspaceBarRow> {

	constructor(private readonly nameOf: (row: WorkspaceBarRow) => string) { }

	getKeyboardNavigationLabel(row: WorkspaceBarRow): string {
		return this.nameOf(row);
	}
}

/**
 * The folders, and the worktrees of each repository among them. Every change rebuilds the whole tree
 * with one `setChildren`; the tree keeps what was expanded by the rows' identity (WORKTREE.md WT-1.10).
 */
export class WorkspaceBarView extends Disposable {

	private readonly tree: WorkbenchObjectTree<WorkspaceBarRow, void>;
	private readonly empty: HTMLElement;
	private readonly rowKind: IContextKey<'folder' | 'repository' | 'worktree'>;
	private readonly rowExpansion: IContextKey<'' | 'expanded' | 'collapsed'>;
	/** The repositories somebody closed, by their main checkout's key (`CLOSED_STORAGE_KEY`). */
	private readonly closed: Set<string>;
	/** The worktrees being deleted, by key, whose rows are left out (`hideWorktree`). */
	private readonly leaving = new Set<string>();

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
		@IWorkspaceBarAgentsService agentsService: IWorkspaceBarAgentsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.closed = new Set(readClosed(this.storageService));

		this.empty = append(container, $('.workspacebar-empty'));
		// ⚠️ Says what to do next, and names both ways of doing it - the column is a drop target over
		// its whole height, which nothing else on screen says.
		this.empty.textContent = localize('workspaceBar.empty', "Open a folder or drag one here.");

		const isUnavailable = (row: WorkspaceBarRow) => row.kind === 'worktree'
			? !row.worktree.exists
			: row.kind === 'folder' && !!row.folder && model.isUnavailable(row.folder);

		const list = append(container, $('.workspacebar-list'));

		// Whether the keyboard moved last in the list, for the keyboard row's highlight (`workspacebarpart.css`):
		// a key in the list, or arriving by Tab (its key comes up here), turns it on; a pointer turns it off.
		// Captured, because the list stops the keys it handles from bubbling.
		this._register(addDisposableListener(list, EventType.KEY_DOWN, () => list.classList.add('keyboard'), true));
		this._register(addDisposableListener(list, EventType.KEY_UP, e => {
			if (e.key === 'Tab') {
				list.classList.add('keyboard');
			}
		}, true));
		this._register(addDisposableListener(list, EventType.POINTER_DOWN, () => list.classList.remove('keyboard'), true));

		// One identity for the tree and for the renderer, which tells by it when one of its templates is
		// handed a different row.
		const identity = new WorkspaceBarIdentityProvider(model.key);

		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<WorkspaceBarRow, void>,
			'WorkspaceBar',
			list,
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
					})),
				(row: WorkspaceBarRow) => identity.getId(row))],
			{
				// The bar's own folder key, so rebuilds keep focus, selection and expansion on the right rows.
				identityProvider: identity,
				// ⚠️ `this.tree` is read when a row is labelled, which is after it has been assigned.
				accessibilityProvider: new WorkspaceBarAccessibilityProvider(isUnavailable, row => displayNameOf(row, this.customizationService), row => rowContentsOf(this.tree.getNode(row), agentsService)),
				keyboardNavigationLabelProvider: new WorkspaceBarKeyboardNavigationLabelProvider(row => displayNameOf(row, this.customizationService)),
				// One click. Left alone this follows `workbench.list.openMode`, which is about files.
				openOnSingleClick: true,
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				// A click on a row goes there. The tree's own triangle is hidden, so it never expands;
				// `onDidOpen` below toggles on the row's own triangle.
				expandOnlyOnTwistieClick: true,
				expandOnDoubleClick: false,
				// No triangle, indent or guides from the tree, which draws them outside the row's box
				// (as upstream's `sessionsList.ts` does).
				indent: 0,
				defaultIndent: 0,
				renderIndentGuides: RenderIndentGuides.None,
				twistieAdditionalCssClass: () => 'force-no-twistie',
				// A repository's row stuck over its worktrees would be drawn with its buttons, but the tree
				// only scrolls to a stuck row: a click there would neither go to it nor reach them.
				enableStickyScroll: false,
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

		// On the tree's own scope: keybindings resolve the focused element's context, and a scope wrapped
		// around the tree is not among its parents.
		WorkspaceBarFocusContext.bindTo(this.tree.contextKeyService).set(true);
		this.rowKind = WorkspaceBarRowKindContext.bindTo(this.tree.contextKeyService);
		this.rowExpansion = WorkspaceBarRowExpansionContext.bindTo(this.tree.contextKeyService);
		this._register(this.tree.onDidChangeFocus(e => this.setRowKind(e.elements[0] ?? undefined)));

		this._register(this.tree.onContextMenu(e => this.onContextMenu(e)));

		// A repository row carries the mark for a worktree of it only while that worktree is hidden,
		// so expanding or collapsing it changes how it is drawn - and what its menu offers.
		this._register(this.tree.onDidChangeCollapseState(e => {
			const row = e.node.element;
			if (row) {
				this.tree.rerender(row);
			}
			this.setRowKind(this.tree.getFocus()[0] ?? undefined);

			// Kept for the next time the window opens (WT-1.10): rebuilds preserve it, so only an open or
			// a close gets here.
			if (row?.kind === 'folder' && row.repository && e.node.collapsible) {
				this.rememberClosed(row.uri, e.node.collapsed);
			}

			// Closing the repository whose worktree the window is on takes the window to the repository
			// (WT-1.5), however it was closed. Rebuilds preserve the state, so only a person gets here.
			if (row?.kind === 'folder' && e.node.collapsed && isOnWorktreeOf(row, this.switcher.active, this.model.key)) {
				this.goToFolder(row).then(undefined, onUnexpectedError);
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
		// ⚠️ The same redraw, although only what the rows draw has changed: `tree.rerender()` with no
		// row is the list's redraw for rows of changing height, and does nothing in this one.
		this._register(agentsService.onDidChange(() => this.refresh()));
		// Collapsed to its icons the rows are the same (WT-1.10), and drawn again for the new shape.
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
			// Each repository's worktrees in the order somebody put them in, if they have (WT-1.7).
			groups: this.git.groups.map(group => group.kind === 'repository'
				? { ...group, worktrees: orderWorktrees(group.worktrees, this.customizationService.worktreeOrder(group.main), worktree => worktree.uri, this.model.key) }
				: group),
			worktrees: areWorktreesShown(this.configurationService) && this.git.ready,
			key: this.model.key,
			closed: main => this.closed.has(this.model.key(main)),
			leaving: worktree => this.leaving.has(this.model.key(worktree))
		}));

		// Without a `diffIdentityProvider` this replaces and redraws every row, the mark with it.
		// A rebuild moves focus onto the new rows without a focus event, so the row kind is set again:
		// left saying "worktree" on a folder, Alt+Up ran Move Worktree Up on it.
		this.setRowKind(this.tree.getFocus()[0] ?? undefined);
	}

	/** Keeps whether the repository of `main` is closed, for its first drawing after a reload. */
	private rememberClosed(main: URI, closed: boolean): void {
		const key = this.model.key(main);
		if (closed === this.closed.has(key)) {
			return;
		}

		if (closed) {
			this.closed.add(key);
		} else {
			this.closed.delete(key);
		}

		if (this.closed.size > 0) {
			this.storageService.store(CLOSED_STORAGE_KEY, JSON.stringify([...this.closed]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(CLOSED_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	private isActive(node: ITreeNode<WorkspaceBarRow, void>): boolean {
		return carriesMark(node.element, this.switcher.active, node.collapsed, this.model.key);
	}

	/**
	 * Goes to a row, or opens and closes it when the click was on its triangle. A folder not in the
	 * workspace goes through `show`, which adds it first; a worktree whose folder is gone, through the
	 * switcher, which says so rather than add a missing folder.
	 */
	private async open(row: WorkspaceBarRow, browserEvent: UIEvent | undefined): Promise<void> {
		// The list opens on a click and again on the `dblclick` that follows it: the click has done it,
		// and a second toggle or a second New Worktree would undo or repeat it.
		if (browserEvent?.type === 'dblclick') {
			return;
		}

		const target = browserEvent?.target;
		if (isHTMLElement(target) && target.closest('.workspacebar-twistie') && this.tree.isCollapsible(row)) {
			this.tree.toggleCollapsed(row);
			return;
		}

		if (row.kind === 'folder') {
			return this.goToFolder(row);
		}

		const { worktree } = row;
		if (worktree.folder || !worktree.exists) {
			return this.switcher.switchTo(worktree.folder?.uri ?? worktree.uri);
		}

		return this.show(worktree.uri);
	}

	/** A folder row's own place: through the switcher when it is in the workspace, `show` when not. */
	private goToFolder(row: IFolderRow): Promise<void> {
		return row.folder ? this.switcher.switchTo(row.folder.uri) : this.show(row.uri);
	}

	private setRowKind(row: WorkspaceBarRow | undefined): void {
		if (!row) {
			this.rowKind.set('folder');
			this.rowExpansion.set('');
			return;
		}

		this.rowKind.set(row.kind === 'worktree' ? 'worktree' : row.repository ? 'repository' : 'folder');
		this.rowExpansion.set(this.expansionOf(row));
	}

	/**
	 * Whether a repository's row is open onto its worktrees, for its menu (WT-1.10); empty for a row
	 * with nothing under it (WT-1.8).
	 */
	private expansionOf(row: WorkspaceBarRow): '' | 'expanded' | 'collapsed' {
		if (row.kind !== 'folder' || !this.tree.hasElement(row)) {
			return '';
		}

		const node = this.tree.getNode(row);
		return node.children.length === 0 ? '' : node.collapsed ? 'collapsed' : 'expanded';
	}

	/** Opens or closes a repository's row onto its worktrees: `IWorkspaceBarService.setExpanded`. */
	setExpanded(uri: URI, expanded: boolean): void {
		const key = this.model.key(uri);
		const row = this.tree.getNode().children
			.map(node => node.element)
			.find(element => element?.kind === 'folder' && this.model.key(element.uri) === key);
		if (!row) {
			return;
		}

		if (expanded) {
			this.tree.expand(row);
		} else {
			this.tree.collapse(row);
		}
	}

	/** Every row's folder, top to bottom, a closed repository's worktrees included: `IWorkspaceBarService.rowOrder`. */
	rowOrder(): URI[] {
		return this.tree.getNode().children
			.flatMap(node => [node, ...node.children])
			.flatMap(node => node.element ? [uriOf(node.element)] : []);
	}

	/**
	 * Leaves a worktree's row out until the result is disposed: `IWorkspaceBarService.hideWorktree`.
	 *
	 * Disposed, git's files are read again before the row can come back. After a delete that worked
	 * they no longer list the worktree, and a row drawn again from the read before would flash back.
	 */
	hideWorktree(worktree: URI): IDisposable {
		const key = this.model.key(worktree);
		this.leaving.add(key);
		this.refresh();

		return toDisposable(() => {
			this.git.refresh().finally(() => {
				this.leaving.delete(key);
				if (!this._store.isDisposed) {
					this.refresh();
				}
			}).then(undefined, onUnexpectedError);
		});
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
