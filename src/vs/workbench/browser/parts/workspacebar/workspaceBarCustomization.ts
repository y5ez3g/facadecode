/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

/**
 * The colours a folder can be given.
 *
 * ⚠️ Names of the six tokens in `workspaceBarColors.ts`, which write their values down rather than
 * pointing at another theme colour - see the note there for why a tag is not a surface, and for the
 * measurement that says one value per colour cannot cover both a dark column and a light one.
 *
 * ⚠️ This list used to name `charts.<name>`, on the reasoning that "every theme defines it and a
 * hex here would be one person's dark theme baked into everybody else's". Both halves were wrong.
 * Two themes do not define `charts.orange` at all, and the hex being avoided is what upstream itself
 * writes for `charts.green` and `charts.purple`. There is no pink because six is the number that
 * was designed, not because `charts` has none to point at.
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
	 * The name to draw for a folder.
	 *
	 * ⚠️ The one place that decides it. The bar draws it and so does the window title, and a second
	 * copy of `customization?.name ?? folder.name` is a second copy that stops agreeing with the
	 * first - which is how the same folder ends up called two things in one window.
	 */
	nameFor(folder: IWorkspaceFolder): string;

	/** Sets, or clears what is left out. */
	set(uri: URI, customization: IFolderCustomization): void;
}

const STORAGE_KEY = 'facade.workspaceBar.customization';

/**
 * Display names and colours, per folder, kept where the person is rather than in their workspace file.
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

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();
		this.load();
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
		return this.get(folder.uri)?.name || folder.name;
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
}

registerSingleton(IWorkspaceBarCustomizationService, WorkspaceBarCustomizationService, InstantiationType.Delayed);
