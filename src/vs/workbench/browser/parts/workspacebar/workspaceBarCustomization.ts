/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, basenameOrAuthority } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { onDidChangeFolderKeys, rekeyFolders } from './workspaceBar.js';

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

/** The first of `FOLDER_COLORS` no other worktree of the repository has (WORKTREE.md WT-1.12). */
export function freeWorktreeColor(taken: readonly (FolderColor | undefined)[]): FolderColor | undefined {
	return FOLDER_COLORS.find(color => !taken.includes(color));
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

	/**
	 * What has been set for this folder, if anything: in this workspace, else - a worktree's - what it was given as Facade
	 * made it (`setMade`).
	 */
	get(uri: URI): IFolderCustomization | undefined;

	/** The one name every surface draws for a folder: its `folders[].name`, else a customized or default one (WORKSPACE.md W9.8). */
	nameFor(folder: IWorkspaceFolder): string;

	/**
	 * What folders are called when nobody has named them, where that is not their own name: a
	 * worktree's branch (WT-1.12), which the bar reads from git's files. Replaces what was set before.
	 */
	setDefaultNames(names: readonly { readonly uri: URI; readonly name: string }[]): void;

	/** Sets, or clears what is left out, in this workspace. */
	set(uri: URI, customization: IFolderCustomization): void;

	/**
	 * What a worktree is given as Facade makes it - the name and colour New Worktree was given, else a colour of its own
	 * - which every workspace shows until somebody changes it in theirs (WORKTREE.md WT-1.12). What was kept for an
	 * earlier worktree at its path goes, in every workspace.
	 */
	setMade(uri: URI, look: IFolderCustomization): void;

	/** Forgets a worktree that is gone: what it was made with, and what this workspace set for it (WORKTREE.md WT-8.1). */
	forget(uri: URI): void;

	/**
	 * The order somebody put a repository's worktrees in with Move Worktree Up and Down (WORKTREE.md
	 * WT-1.7), or undefined until they have moved one. A worktree deleted since may still be in it,
	 * and one made since is not: a reader places what it finds and skips what it does not.
	 */
	worktreeOrder(repository: URI): readonly URI[] | undefined;

	/** Keeps `worktrees` - the whole list, as it now stands - as a repository's order. */
	setWorktreeOrder(repository: URI, worktrees: readonly URI[]): void;

	/**
	 * The rows this workspace's bar shows, once it has read them. What the workspace took over from the record an earlier
	 * build kept for every workspace keeps only what it says of them, so that a folder set up in another workspace does
	 * not bring that look along when it joins this one (WORKSPACE.md W9.7). Does nothing after the first time.
	 */
	trimInherited(rows: readonly URI[]): void;
}

/** The folder's `name` in the workspace file, which VS Code's own surfaces read too (WORKSPACE.md W9.7). */
export function explicitNameOf(folder: IWorkspaceFolder): string | undefined {
	return folder.name !== basenameOrAuthority(folder.uri) ? folder.name : undefined;
}

/**
 * What a worktree is called: while it is a folder of the workspace, what `nameFor` calls that folder, as
 * the window title does; else the name somebody gave it, or its branch (WT-1.12).
 */
export function worktreeNameFor(customizationService: Pick<IWorkspaceBarCustomizationService, 'nameFor' | 'get'>, worktree: { readonly uri: URI; readonly label: string; readonly folder: IWorkspaceFolder | undefined }): string {
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
 * The glyph a worktree's row is drawn with. Not chosen in Customize (WORKTREE.md WT-1.12): the glyph is
 * what says worktree, and only its colour is the worktree's own.
 */
export const worktreeIcon = registerIcon('workspace-bar-worktree', Codicon.circleSmallFilled, localize('workspaceBar.worktreeIcon', "Icon for a worktree in the workspace bar."));

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
 * How this workspace's records began, decided the first time it is opened since they are kept per workspace
 * (`adoptEarlierRecords`): `inherited` while they are a copy of an earlier build's not yet trimmed to its rows, else `own`.
 */
const ORIGIN_STORAGE_KEY = 'facade.workspaceBar.customization.origin';

/**
 * Where what a worktree was made with is kept, for every workspace of every profile on this machine (`setMade`): one key
 * per worktree, so that two windows making worktrees at once each write their own.
 */
const MADE_STORAGE_PREFIX = 'facade.workspaceBar.madeWith/';

/** What a worktree was made with, and when: what tells it from an earlier worktree at its path. */
interface IMadeWith {
	readonly uri: URI;
	readonly look: IFolderCustomization;
	readonly made: number;
}

/** What a workspace set for a folder; for a worktree, the `made` of the worktree it was set for. */
interface IWorkspaceCustomization extends IFolderCustomization {
	readonly made?: number;
}

/**
 * Each folder's colour and icon, the names of rows not in the list, and each repository's worktree order,
 * kept per workspace: what somebody sets in one workspace's bar is that workspace's (WORKSPACE.md W2). A
 * folder in the list is named by its `folders[].name` (WORKSPACE.md W9.7). What a worktree is made with is
 * the worktree's, in every workspace, until one sets its own (WORKTREE.md WT-1.12).
 */
export class WorkspaceBarCustomizationService extends Disposable implements IWorkspaceBarCustomizationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange = this._onDidChange.event;

	private readonly byFolder = new Map<string, IWorkspaceCustomization>();
	private readonly madeWith: Map<string, IMadeWith>;
	private readonly worktreesByRepository = new Map<string, readonly URI[]>();
	/** `setDefaultNames`, by folder: read from git's files, so never stored. */
	private defaultNames = new Map<string, { readonly uri: URI; readonly name: string }>();
	/** Whether the records are a copy of the shared ones still to be trimmed to this workspace's rows (`trimInherited`). */
	private inherited: boolean;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IFileService fileService: IFileService,
	) {
		super();
		this.inherited = this.adoptEarlierRecords();
		this.load();
		this.loadWorktreeOrder();
		this.madeWith = this.loadMadeWith();

		// A worktree another window made, or forgot: its look here too
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, undefined, this._store)(e => {
			if (!e.external || !e.key.startsWith(MADE_STORAGE_PREFIX)) {
				return;
			}

			const key = e.key.slice(MADE_STORAGE_PREFIX.length);
			const before = this.madeWith.get(key);
			const after = this.readMadeWith(e.key);
			if (after) {
				this.madeWith.set(key, after);
			} else {
				this.madeWith.delete(key);
			}
			const entry = after ?? before;
			if (entry && before?.made !== after?.made) {
				this._onDidChange.fire(entry.uri);
			}
		}));

		this._register(this.contextService.onDidChangeWorkspaceFolders(e => this.moveNamesIntoWorkspace(e.added)));

		// Loaded, or set, before a remote's file system registers, which can key its folders another way (REMOTE.md R7)
		this._register(onDidChangeFolderKeys(fileService)(scheme => this.rekey(scheme)));
	}

	/**
	 * Each folder of `scheme` keyed as its keys are now; of a folder's two records that way, the one set since the other was
	 * loaded. Each is announced: what its row asked for before found nothing.
	 */
	private rekey(scheme: string): void {
		const key = (uri: URI) => this.key(uri);
		if (rekeyFolders(this.byFolder, scheme, key)) {
			this.save();
		}
		if (rekeyFolders(this.worktreesByRepository, scheme, key)) {
			this.saveWorktreeOrder();
		}
		rekeyFolders(this.madeWith, scheme, key);
		rekeyFolders(this.defaultNames, scheme, key);

		const folders = new Set([...this.byFolder.keys(), ...this.worktreesByRepository.keys(), ...this.madeWith.keys(), ...this.defaultNames.keys()]);
		for (const folder of folders) {
			if (folder.startsWith(`${scheme}:`)) {
				this._onDidChange.fire(URI.parse(folder));
			}
		}
	}

	/** Writes the names of rows that joined into their `folders[].name`, unless the file already names them. */
	private moveNamesIntoWorkspace(added: readonly IWorkspaceFolder[]): void {
		if (this.contextService.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
			return;
		}

		for (const folder of added) {
			const customization = this.get(folder.uri);
			if (!customization?.name || explicitNameOf(folder)) {
				continue;
			}

			this.workspaceEditingService.renameFolder(folder.uri, customization.name, true).then(
				() => this.set(folder.uri, { color: customization.color, icon: customization.icon }),
				onUnexpectedError);
		}
	}

	private key(uri: URI): string {
		return this.uriIdentityService.extUri.getComparisonKey(uri);
	}

	/**
	 * Whether this workspace holds a copy of what an earlier build kept for every workspace, still to be trimmed to its
	 * rows (`trimInherited`). Decided the first time it is opened since these are kept per workspace, and kept: one opened
	 * before takes the copy, both records at once, so that nothing it shows looks different; one made since takes none,
	 * in its later windows either, where it is no longer new, nor does one that keeps a record of its own already
	 * (WORKSPACE.md W9.7).
	 */
	private adoptEarlierRecords(): boolean {
		const origin = this.storageService.get(ORIGIN_STORAGE_KEY, StorageScope.WORKSPACE);
		if (origin !== undefined) {
			return origin === 'inherited';
		}

		let inherited = false;
		const keys = [STORAGE_KEY, WORKTREE_ORDER_STORAGE_KEY];
		if (!this.storageService.isNew(StorageScope.WORKSPACE) && keys.every(key => this.storageService.get(key, StorageScope.WORKSPACE) === undefined)) {
			for (const key of keys) {
				const shared = this.storageService.get(key, StorageScope.PROFILE);
				if (shared !== undefined) {
					this.storageService.store(key, shared, StorageScope.WORKSPACE, StorageTarget.MACHINE);
					inherited = true;
				}
			}
		}
		this.storageService.store(ORIGIN_STORAGE_KEY, inherited ? 'inherited' : 'own', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		return inherited;
	}

	private load(): void {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
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
				const { name, color, icon, made } = value as { name?: unknown; color?: unknown; icon?: unknown; made?: unknown };
				const customization: IWorkspaceCustomization = {
					name: typeof name === 'string' && name.length > 0 ? name : undefined,
					color: isFolderColor(color) ? color : undefined,
					icon: isFolderIcon(icon) ? icon : undefined,
					made: typeof made === 'number' ? made : undefined
				};

				// Nothing set but for a worktree made with a look: that look cleared in this workspace
				if (customization.name || customization.color || customization.icon || customization.made !== undefined) {
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
			this.storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}

		// This machine's paths
		this.storageService.store(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.byFolder)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	get(uri: URI): IFolderCustomization | undefined {
		const key = this.key(uri);
		const own = this.byFolder.get(key);
		const madeWith = this.madeWith.get(key);
		// WT-1.12: what was set here for an earlier worktree at this path is not this one's
		if (own && own.made === madeWith?.made) {
			return { name: own.name, color: own.color, icon: own.icon };
		}
		return madeWith?.look;
	}

	nameFor(folder: IWorkspaceFolder): string {
		return explicitNameOf(folder) || this.get(folder.uri)?.name || this.defaultNames.get(this.key(folder.uri))?.name || folder.name;
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
		// For a worktree Facade made, the one it was made as; clearing every field then clears its look in this workspace
		const made = this.madeWith.get(key)?.made;

		if (!name && !color && !icon && made === undefined) {
			if (!this.byFolder.delete(key)) {
				return;
			}
		} else {
			const before = this.byFolder.get(key);
			if (before?.name === name && before?.color === color && before?.icon === icon && before?.made === made) {
				return;
			}

			this.byFolder.set(key, { name, color, icon, made });
		}

		this.save();
		this._onDidChange.fire(uri);
	}

	setMade(uri: URI, look: IFolderCustomization): void {
		const key = this.key(uri);
		const entry: IMadeWith = { uri, look: { name: look.name?.trim() || undefined, color: look.color }, made: Date.now() };
		this.madeWith.set(key, entry);
		// This machine's paths, for every workspace on it
		this.storageService.store(`${MADE_STORAGE_PREFIX}${key}`, JSON.stringify({ uri: uri.toString(), ...entry.look, made: entry.made }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		if (this.byFolder.delete(key)) {
			this.save();
		}
		this._onDidChange.fire(uri);
	}

	forget(uri: URI): void {
		const key = this.key(uri);
		const made = this.madeWith.delete(key);
		const own = this.byFolder.delete(key);
		if (made) {
			this.storageService.remove(`${MADE_STORAGE_PREFIX}${key}`, StorageScope.APPLICATION);
		}
		if (own) {
			this.save();
		}
		if (made || own) {
			this._onDidChange.fire(uri);
		}
	}

	private loadMadeWith(): Map<string, IMadeWith> {
		const madeWith = new Map<string, IMadeWith>();
		for (const storageKey of this.storageService.keys(StorageScope.APPLICATION, StorageTarget.MACHINE)) {
			const entry = storageKey.startsWith(MADE_STORAGE_PREFIX) ? this.readMadeWith(storageKey) : undefined;
			if (entry) {
				madeWith.set(storageKey.slice(MADE_STORAGE_PREFIX.length), entry);
			}
		}
		return madeWith;
	}

	/** What one worktree was made with, each field checked on the way in as in `load`; undefined where none can be read. */
	private readMadeWith(storageKey: string): IMadeWith | undefined {
		try {
			const { uri, name, color, made }: { uri?: unknown; name?: unknown; color?: unknown; made?: unknown } = JSON.parse(this.storageService.get(storageKey, StorageScope.APPLICATION, '{}')) ?? {};
			if (typeof uri === 'string' && typeof made === 'number') {
				return { uri: URI.parse(uri), look: { name: typeof name === 'string' && name.length > 0 ? name : undefined, color: isFolderColor(color) ? color : undefined }, made };
			}
		} catch {
			// A record that cannot be read costs what that worktree was made with: it looks as its workspace has it
		}
		return undefined;
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

		this.saveWorktreeOrder();
		this._onDidChange.fire(repository);
	}

	private saveWorktreeOrder(): void {
		if (this.worktreesByRepository.size === 0) {
			this.storageService.remove(WORKTREE_ORDER_STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}

		// This machine's paths
		this.storageService.store(WORKTREE_ORDER_STORAGE_KEY,
			JSON.stringify(Object.fromEntries([...this.worktreesByRepository].map(([repositoryKey, uris]) => [repositoryKey, uris.map(uri => uri.toString())]))),
			StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	trimInherited(rows: readonly URI[]): void {
		if (!this.inherited) {
			return;
		}
		this.inherited = false;
		this.storageService.store(ORIGIN_STORAGE_KEY, 'own', StorageScope.WORKSPACE, StorageTarget.MACHINE);

		// Nothing that is shown changes: what goes is what no row here draws
		const shown = new Set(rows.map(uri => this.key(uri)));
		const looks = [...this.byFolder.keys()].filter(key => !shown.has(key));
		const orders = [...this.worktreesByRepository.keys()].filter(key => !shown.has(key));
		looks.forEach(key => this.byFolder.delete(key));
		orders.forEach(key => this.worktreesByRepository.delete(key));
		if (looks.length) {
			this.save();
		}
		if (orders.length) {
			this.saveWorktreeOrder();
		}
	}

	private loadWorktreeOrder(): void {
		const raw = this.storageService.get(WORKTREE_ORDER_STORAGE_KEY, StorageScope.WORKSPACE);
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
