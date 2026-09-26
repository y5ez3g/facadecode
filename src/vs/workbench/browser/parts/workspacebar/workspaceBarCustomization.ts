/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

/**
 * The colours a folder can be given.
 *
 * ⚠️ Names of the ten tokens in `workspaceBarColors.ts`, which write their values down rather than
 * pointing at another theme colour - see the note there for why a tag is not a surface, and for the
 * measurement that says one value per colour cannot cover both a dark column and a light one.
 *
 * ⚠️ This list used to name `charts.<name>`, on the reasoning that "every theme defines it and a
 * hex here would be one person's dark theme baked into everybody else's". Both halves were wrong.
 * Two themes do not define `charts.orange` at all, and the hex being avoided is what upstream itself
 * writes for `charts.green` and `charts.purple`.
 */
export const FOLDER_COLORS = ['red', 'orange', 'yellow', 'lime', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'] as const;

export type FolderColor = typeof FOLDER_COLORS[number];

export function isFolderColor(candidate: unknown): candidate is FolderColor {
	return typeof candidate === 'string' && (FOLDER_COLORS as readonly string[]).includes(candidate);
}

/**
 * The glyphs a folder can be given, and nothing else from the 652 the icon font has.
 *
 * ⚠️ Ten, chosen against three rules rather than by taste. They have to survive 16px, which takes
 * out everything drawn in thin strokes or many of them; they have to be distinct from each other at a
 * glance, which takes out the second and third square box; and they have to say what a folder **is**
 * rather than what it is **doing** - a bug, a check, a play arrow are states, and a state that never
 * changes is a lie. `folder` is first because it is what an untagged row already draws.
 *
 * ⚠️ Names, not codepoints. `Codicon.<name>` is resolved once in the renderer, so a glyph that
 * upstream moves or renames breaks at the type checker rather than in the column.
 */
export const FOLDER_ICONS = ['folder', 'rocket', 'beaker', 'server', 'database', 'globe', 'device-mobile', 'book', 'tools', 'package'] as const;

export type FolderIcon = typeof FOLDER_ICONS[number];

export function isFolderIcon(candidate: unknown): candidate is FolderIcon {
	return typeof candidate === 'string' && (FOLDER_ICONS as readonly string[]).includes(candidate);
}

/** What somebody has changed about one folder. Every part is optional and each means "unset". */
export interface IFolderCustomization {
	readonly name?: string;
	readonly color?: FolderColor;
	readonly icon?: FolderIcon;
}

export const IWorkspaceBarCustomizationService = createDecorator<IWorkspaceBarCustomizationService>('workspaceBarCustomizationService');

export interface IWorkspaceBarCustomizationService {
	readonly _serviceBrand: undefined;

	/** Fires for every change, with the folder that changed. */
	readonly onDidChange: Event<URI>;

	/** What has been set for this folder, if anything. */
	get(uri: URI): IFolderCustomization | undefined;

	/**
	 * The name to draw for a folder: the one somebody gave it, else its default name, else its own.
	 *
	 * ⚠️ The one place that decides it. The bar draws it and so does the window title, and a second
	 * copy of `customization?.name ?? folder.name` is a second copy that stops agreeing with the
	 * first - which is how the same folder ends up called two things in one window.
	 */
	nameFor(folder: IWorkspaceFolder): string;

	/**
	 * What folders are called when nobody has named them, where that is not their own name: a
	 * worktree's branch (WT-1.12), which the bar reads from git's files. Replaces what was set before.
	 */
	setDefaultNames(names: readonly { readonly uri: URI; readonly name: string }[]): void;

	/** Sets, or clears what is left out. */
	set(uri: URI, customization: IFolderCustomization): void;

	/**
	 * The order somebody put a repository's worktrees in with Move Worktree Up and Down (WORKTREE.md
	 * WT-1.7), or undefined until they have moved one. A worktree deleted since may still be in it,
	 * and one made since is not: a reader places what it finds and skips what it does not.
	 */
	worktreeOrder(repository: URI): readonly URI[] | undefined;

	/** Keeps `worktrees` - the whole list, as it now stands - as a repository's order. */
	setWorktreeOrder(repository: URI, worktrees: readonly URI[]): void;
}

/**
 * What a worktree is called: while it is a folder of the workspace, what `nameFor` calls that folder, as
 * the window title does; else the name somebody gave it, or its branch (WT-1.12).
 */
export function worktreeNameFor(customizationService: IWorkspaceBarCustomizationService, worktree: { readonly uri: URI; readonly label: string; readonly folder: IWorkspaceFolder | undefined }): string {
	return worktree.folder ? customizationService.nameFor(worktree.folder) : customizationService.get(worktree.uri)?.name || worktree.label;
}

/**
 * What a folder's row is called, the folder being at `uri` and, when it is one of the workspace's,
 * `folder` - a repository whose main checkout was not added has a row and no folder. What `nameFor`
 * calls the folder, else the name somebody gave it, else its own.
 */
export function folderRowNameFor(customizationService: Pick<IWorkspaceBarCustomizationService, 'nameFor' | 'get'>, uri: URI, folder: IWorkspaceFolder | undefined): string {
	return folder ? customizationService.nameFor(folder) : customizationService.get(uri)?.name || basename(uri);
}

/**
 * The glyph a folder's row is drawn with: the one chosen in Customize, else a folder.
 *
 * ⚠️ `folder` is the fallback rather than a stored value, so a folder nobody has customised and one
 * set back to a plain folder draw the same.
 */
export function folderGlyphFor(customization: IFolderCustomization | undefined): ThemeIcon {
	return customization?.icon ? ThemeIcon.fromId(customization.icon) : Codicon.folder;
}

/**
 * A glyph in a folder's colour, as an icon a line of text can carry - the agent list's rows, say.
 *
 * ⚠️ `$(...)` takes an icon's id and one modifier and nothing else, so the colour goes as a modifier
 * of its own: `codicon-modifier-folder<colour>`, which `workspacebarpart.css` paints with the tokens
 * the bar's `workspacebar-icon-<colour>` uses.
 */
export function glyphInFolderColor(glyph: ThemeIcon, color: FolderColor | undefined): ThemeIcon {
	return color ? ThemeIcon.fromId(`${glyph.id}~folder${color}`) : glyph;
}

const STORAGE_KEY = 'facade.workspaceBar.customization';

/** Kept apart from the customisations: a record of those is replaced whole on every Save of the dialog. */
const WORKTREE_ORDER_STORAGE_KEY = 'facade.workspaceBar.worktreeOrder';

/**
 * Display names and colours, per folder, and the order of each repository's worktrees, kept where the
 * person is rather than in their workspace file.
 *
 * ⚠️ `StorageScope.PROFILE`. A folder's colour is something about the folder, not about one window,
 * so it follows the person into every workspace that lists it. And it is deliberately **not** written
 * to the `.code-workspace`: that file belongs to whoever shares it, and a colour of mine has no
 * business travelling to them.
 *
 * ⚠️ Which means the display name reaches the bar and the window title and stops there. The explorer's
 * header, the folder pickers and `${workspaceFolderBasename}` all go on saying what the folder is
 * really called, because those read the workspace and the workspace was not told. That is the price
 * of keeping the file clean, and it is a boundary rather than an oversight.
 */
export class WorkspaceBarCustomizationService extends Disposable implements IWorkspaceBarCustomizationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange = this._onDidChange.event;

	private readonly byFolder = new Map<string, IFolderCustomization>();
	private readonly worktreesByRepository = new Map<string, readonly URI[]>();
	/** `setDefaultNames`, by folder: read from git's files, so never stored. */
	private defaultNames = new Map<string, { readonly uri: URI; readonly name: string }>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();
		this.load();
		this.loadWorktreeOrder();
	}

	private key(uri: URI): string {
		return this.uriIdentityService.extUri.getComparisonKey(uri);
	}

	private load(): void {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return;
		}

		try {
			const stored = JSON.parse(raw);
			if (!stored || typeof stored !== 'object') {
				return;
			}

			for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
				if (!value || typeof value !== 'object') {
					continue;
				}

				// ⚠️ Each field checked on the way in. A colour that is no longer in the palette, or a
				// name that somebody hand-edited into a number, would otherwise reach the renderer.
				const { name, color, icon } = value as { name?: unknown; color?: unknown; icon?: unknown };
				const customization: IFolderCustomization = {
					name: typeof name === 'string' && name.length > 0 ? name : undefined,
					color: isFolderColor(color) ? color : undefined,
					icon: isFolderIcon(icon) ? icon : undefined
				};

				if (customization.name || customization.color || customization.icon) {
					this.byFolder.set(key, customization);
				}
			}
		} catch {
			// ⚠️ A value this cannot read costs the customisations, not the bar. The list of folders
			// is the workspace's and is never in here.
		}
	}

	private save(): void {
		if (this.byFolder.size === 0) {
			this.storageService.remove(STORAGE_KEY, StorageScope.PROFILE);
			return;
		}

		this.storageService.store(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.byFolder)), StorageScope.PROFILE, StorageTarget.USER);
	}

	get(uri: URI): IFolderCustomization | undefined {
		return this.byFolder.get(this.key(uri));
	}

	nameFor(folder: IWorkspaceFolder): string {
		return this.get(folder.uri)?.name || this.defaultNames.get(this.key(folder.uri))?.name || folder.name;
	}

	setDefaultNames(names: readonly { readonly uri: URI; readonly name: string }[]): void {
		const previous = this.defaultNames;
		this.defaultNames = new Map(names.map(entry => [this.key(entry.uri), entry]));

		for (const [key, entry] of this.defaultNames) {
			if (previous.get(key)?.name !== entry.name) {
				this._onDidChange.fire(entry.uri);
			}
		}
		for (const [key, entry] of previous) {
			if (!this.defaultNames.has(key)) {
				this._onDidChange.fire(entry.uri);
			}
		}
	}

	/**
	 * ⚠️ Every field, named three times: kept, compared, stored. A field this method does not know
	 * about is accepted by the type checker, written by the dialog and then silently dropped here -
	 * which is what happened to `icon`: the dialog returned it, the renderer was ready to draw it,
	 * and Save did nothing that could be seen. If a fourth is ever added, it goes in all three lines
	 * or it does not work.
	 */
	set(uri: URI, customization: IFolderCustomization): void {
		const key = this.key(uri);
		const name = customization.name?.trim() || undefined;
		const color = customization.color;
		const icon = customization.icon;

		if (!name && !color && !icon) {
			if (!this.byFolder.delete(key)) {
				return;
			}
		} else {
			const before = this.byFolder.get(key);
			if (before?.name === name && before?.color === color && before?.icon === icon) {
				return;
			}

			this.byFolder.set(key, { name, color, icon });
		}

		this.save();
		this._onDidChange.fire(uri);
	}

	worktreeOrder(repository: URI): readonly URI[] | undefined {
		return this.worktreesByRepository.get(this.key(repository));
	}

	setWorktreeOrder(repository: URI, worktrees: readonly URI[]): void {
		const key = this.key(repository);
		const before = this.worktreesByRepository.get(key) ?? [];
		if (before.length === worktrees.length && before.every((uri, index) => this.key(uri) === this.key(worktrees[index]))) {
			return;
		}

		// An order with nothing left in it - its last worktree deleted - is no record at all.
		if (worktrees.length > 0) {
			this.worktreesByRepository.set(key, [...worktrees]);
		} else {
			this.worktreesByRepository.delete(key);
		}

		// This machine's paths, so kept off Settings Sync.
		if (this.worktreesByRepository.size > 0) {
			this.storageService.store(WORKTREE_ORDER_STORAGE_KEY,
				JSON.stringify(Object.fromEntries([...this.worktreesByRepository].map(([repositoryKey, uris]) => [repositoryKey, uris.map(uri => uri.toString())]))),
				StorageScope.PROFILE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(WORKTREE_ORDER_STORAGE_KEY, StorageScope.PROFILE);
		}
		this._onDidChange.fire(repository);
	}

	private loadWorktreeOrder(): void {
		const raw = this.storageService.get(WORKTREE_ORDER_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return;
		}

		try {
			const stored = JSON.parse(raw);
			if (!stored || typeof stored !== 'object') {
				return;
			}

			for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
				// Each entry checked on the way in: one that is not a list of strings is dropped.
				if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
					this.worktreesByRepository.set(key, value.map(entry => URI.parse(entry)));
				}
			}
		} catch {
			// A value this cannot read costs the order, which falls back to the order they were made in.
		}
	}
}

registerSingleton(IWorkspaceBarCustomizationService, WorkspaceBarCustomizationService, InstantiationType.Delayed);
