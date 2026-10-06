/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { isBoolean, isNumber, isObject, isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { EditorActivation } from '../../../../platform/editor/common/editor.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig, TerminalExitReason, TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { folderKey } from '../../../browser/parts/workspacebar/workspaceBar.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { getWorkbenchContribution, IWorkbenchContribution } from '../../../common/contributions.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { EditorGroupColumn } from '../../../services/editor/common/editorGroupColumn.js';
import { AUX_WINDOW_GROUP, AUX_WINDOW_GROUP_TYPE } from '../../../services/editor/common/editorService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/**
 * Controls whether a terminal in the editor area belongs to the folder it was opened in. Off, it belongs
 * to the window, as one in the panel does.
 */
export const FOLLOW_FOLDER = 'facade.terminal.followFolder';

export const IFolderTerminalsService = createDecorator<IFolderTerminalsService>('folderTerminalsService');

/** Which terminals belong to a folder of the workspace (`FolderTerminals`). */
export interface IFolderTerminalsService {
	readonly _serviceBrand: undefined;

	/**
	 * The terminals `folder` has, which taking it out of the workspace stops: those opened for it
	 * ({@link openFor}) wherever they are, the panel's too, and in the editor area those put away while
	 * the window is elsewhere or there now - the ones leaving it puts away for it. Without
	 * {@link FOLLOW_FOLDER} the editor area's there now are the window's, unless opened for it. For a row
	 * of the bar that has not joined the workspace, those opened for it.
	 */
	terminalsOf(folder: URI): readonly ITerminalInstance[];

	/**
	 * The folder a terminal belongs to, by its row on the bar: the one it was opened for, wherever it is;
	 * else the one it is put away for, or while it has a tab the one it was opened in. `undefined` for a
	 * terminal that belongs to the window: one opened in the panel for none, or without
	 * {@link FOLLOW_FOLDER} one in the editor area.
	 */
	folderOf(instance: ITerminalInstance): URI | undefined;

	/**
	 * Puts a terminal in front and focuses it, and answers whether it is in front. One put away for
	 * another folder is brought back by moving the window onto that folder first, as a click on its row
	 * does. `false` when it does not come back - the move refused, the window moved on again first, or
	 * it could not be shown - and for a terminal that has closed.
	 */
	reveal(instance: ITerminalInstance): Promise<boolean>;

	/**
	 * Opens a terminal for `folder` without disturbing the window: it does not move the window, come in
	 * front of what is on screen or take the focus. A folder of the workspace keeps it, and so does a
	 * row of the bar that has not joined the workspace yet - a worktree's, or a repository's whose
	 * checkout is not one of the workspace's folders: it comes up behind the tabs of the column in front
	 * while the window is on that folder, and is held for it until the window goes there otherwise. While
	 * terminals do not follow folders it comes up in the panel, its folder's all the same. Wherever it is,
	 * it ends with its folder: when the folder leaves the workspace - a row's, with its repository - and
	 * once git has no worktree there any more. Any other folder's is the panel's, the window's own.
	 * {@link reveal} puts it in front.
	 */
	openFor(folder: URI, config: IShellLaunchConfig): Promise<ITerminalInstance>;
}

/** `IFolderTerminalsService`, served by the `FolderTerminals` contribution that keeps the terminals. */
export class FolderTerminalsService implements IFolderTerminalsService {

	declare readonly _serviceBrand: undefined;

	terminalsOf(folder: URI): readonly ITerminalInstance[] {
		return getWorkbenchContribution<FolderTerminals>(FolderTerminals.ID).terminalsOf(folder);
	}

	folderOf(instance: ITerminalInstance): URI | undefined {
		return getWorkbenchContribution<FolderTerminals>(FolderTerminals.ID).folderOf(instance);
	}

	reveal(instance: ITerminalInstance): Promise<boolean> {
		return getWorkbenchContribution<FolderTerminals>(FolderTerminals.ID).reveal(instance);
	}

	openFor(folder: URI, config: IShellLaunchConfig): Promise<ITerminalInstance> {
		return getWorkbenchContribution<FolderTerminals>(FolderTerminals.ID).openFor(folder, config);
	}
}

/**
 * The group recorded for a terminal opened for a folder (`openFor`): none, so that it comes up at the
 * end of whichever column is in front, behind that column's own tab.
 */
const NO_GROUP = -2;

/**
 * The group recorded for a terminal whose tab was in an auxiliary window rather than the main
 * editor grid.
 */
const AUXILIARY_WINDOW = -1;

/**
 * What the editor area's terminals are held under on their way from one folder to the next while they
 * do not follow folders: the window, not a folder - whose keys are never empty.
 */
const WINDOW = '';

/**
 * A terminal that has been taken out of the editor area, and the tab it should be given back.
 */
interface IParkedTerminal {
	readonly instance: ITerminalInstance;

	/**
	 * The id of its group in the main editor grid, {@link AUXILIARY_WINDOW}, or {@link NO_GROUP} for one
	 * that never had a tab. By id, not by column: closing a column to its left moves the column along.
	 */
	readonly group: number;

	/** The index within that group: -1, not meaningful, for an auxiliary window and for no group. */
	readonly index: number;

	/** The `forcePersist` value to restore once the terminal is shown again. */
	readonly persisted: boolean | undefined;

	/**
	 * Whether its tab was the one in front of its group. Only that one comes back in front: the rest
	 * return behind whatever the group shows, so the tab somebody left on is the tab they come back to.
	 */
	readonly active: boolean;
}

/** Where the terminals parked for each folder are kept while the window is closed (`IStoredParkedTerminal`). */
export const PARKED_STORAGE_KEY = 'facade.folderTerminals.parked';

/**
 * A parked terminal as it is kept: its place, and the terminal by its shell integration nonce.
 *
 * ⚠️ The nonce rather than `persistentProcessId`. Made once for each terminal, it goes with the process:
 * a reload reconnects to the same one, and a restart of the app revives it with the options it had,
 * the nonce among them - under a new id.
 */
interface IStoredParkedTerminal {
	readonly nonce: string;
	readonly group: number;
	readonly index: number;
	readonly persisted: boolean | undefined;
	readonly active: boolean;

	/** The row it was held under, not a folder of the workspace, as a URI (`FolderTerminals._rows`). */
	readonly row?: string;
}

/** A row of the bar that terminals are held under, not a folder of the workspace (`FolderTerminals._rows`). */
interface IHeldRow {
	readonly uri: URI;

	/**
	 * The folders of the workspace its repository has, as the bar last read them: the row goes with its
	 * repository, when the last of them leaves the workspace. Undefined until the bar has read them.
	 */
	readonly members: ReadonlySet</*folder*/string> | undefined;
}

/** A terminal opened for a folder (`openFor`), and that folder (`FolderTerminals._openedFor`). */
interface IOpenedFor {
	readonly key: string;
	readonly uri: URI;

	/** Whether it was a folder of the workspace when the workspace's folders last changed, not a row that had not joined it. */
	joined: boolean;

	/**
	 * The folders of the workspace its repository has, as the bar last read them: a row goes with the last
	 * of them. Undefined for a folder in no repository, which git's records say nothing of.
	 */
	members: ReadonlySet</*folder*/string> | undefined;

	readonly listener: IDisposable;
}

/** Where the folders terminals were opened for are kept while the window is closed, by each terminal's nonce. */
export const OPENED_FOR_STORAGE_KEY = 'facade.folderTerminals.openedFor';

/** What was kept of the folders terminals were opened for, by nonce. Storage that cannot be read keeps nothing. */
function readOpenedFor(value: string | undefined): Map</*nonce*/string, URI> {
	const kept = new Map<string, URI>();
	try {
		const stored: unknown = value ? JSON.parse(value) : undefined;
		if (isObject(stored)) {
			for (const [nonce, uri] of Object.entries(stored)) {
				if (isString(uri)) {
					kept.set(nonce, URI.parse(uri));
				}
			}
		}
	} catch {
		// Nothing kept
	}
	return kept;
}

function isStoredParkedTerminal(candidate: unknown): candidate is IStoredParkedTerminal {
	if (!isObject(candidate)) {
		return false;
	}

	const { nonce, group, index, persisted, active, row } = candidate as Record<string, unknown>;
	return isString(nonce) && isNumber(group) && isNumber(index) && isBoolean(active)
		&& (persisted === undefined || isBoolean(persisted)) && (row === undefined || isString(row));
}

/** What was kept of the parked terminals, by folder. Storage that cannot be read keeps nothing. */
function readParkedTerminals(value: string | undefined): Map</*folder*/string, IStoredParkedTerminal[]> {
	const kept = new Map<string, IStoredParkedTerminal[]>();

	let stored: unknown;
	try {
		stored = value ? JSON.parse(value) : undefined;
	} catch {
		return kept;
	}

	if (isObject(stored)) {
		for (const [key, entries] of Object.entries(stored)) {
			const valid = Array.isArray(entries) ? entries.filter(isStoredParkedTerminal) : [];
			if (valid.length) {
				kept.set(key, valid);
			}
		}
	}

	return kept;
}

/**
 * Keeps a terminal editor alive across a folder switch and puts it back where it was.
 *
 * Switching folders applies an editor working set, which closes every editor that is not part of
 * it. A `TerminalEditorInput` disposes its instance when it is closed, so without this the shells
 * of the folder being left are killed. Terminals are instead moved to the background before the
 * working set is captured, and shown again once the incoming folder's editors are up: each folder's
 * when the window comes back to it, and without {@link FOLLOW_FOLDER} all of them, the window's, with
 * whichever folder it goes to.
 */
export class FolderTerminals extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.folderTerminals';

	private readonly _parked = new Map</*folder*/string, IParkedTerminal[]>();
	private readonly _watching = new Map</*folder*/string, DisposableStore>();

	/**
	 * The rows of the bar terminals are held under that are not folders of the workspace (`openFor`): a
	 * worktree's, an agent's opened for the worktree made for it, or a repository's whose checkout has
	 * not joined. They are the row's as a folder's are the folder's. Going there puts it in the
	 * workspace, and from then on they are that folder's. The row leaving the bar ends them, as a folder
	 * leaving the workspace ends its own: with its repository (`_pruneRemovedFolders`), or with its
	 * folder, gone from disk (`_pruneGoneRows`).
	 */
	private readonly _rows = new Map</*folder*/string, IHeldRow>();

	/**
	 * The folder a terminal was opened in, for one that has left it with the window while terminals did
	 * not follow folders. One with no record is the folder's it is on screen in: opened there, or shown
	 * again there, the folder it is put away for.
	 */
	private readonly _origins = new WeakMap<ITerminalInstance, /*folder*/string>();

	/**
	 * The terminals opened for a folder of the workspace or a row of the bar (`openFor`) - agents' - each with
	 * that folder. Wherever one is - held for its folder, in the editor area, in the panel - it is that
	 * folder's, and ends with it: when the folder leaves the workspace, or for a row its repository does
	 * (`_pruneRemovedFolders`), and once git has no worktree there any more (`_pruneGoneRows`).
	 */
	private readonly _openedFor = new Map<ITerminalInstance, IOpenedFor>();

	/** What was kept of `_openedFor`, until `_restore` has it again: kept again meanwhile, as `_unrestored` is. */
	private _unrestoredOpenedFor: ReadonlyMap</*nonce*/string, URI> | undefined;

	/**
	 * Incremented by every folder switch. A restore in flight compares against it and stops when it
	 * has moved, so that terminals are not shown in a folder they do not belong to.
	 */
	private _generation = 0;

	/** The folders whose terminals are being shown again right now. */
	private readonly _unparking = new Set</*folder*/string>();

	/** Fires with each terminal as it is shown again. */
	private readonly _onDidUnpark = this._register(new Emitter<ITerminalInstance>());

	/** Fires with a folder when showing its terminals again stops, whether or not all came back. */
	private readonly _onDidStopUnparking = this._register(new Emitter</*folder*/string>());

	/**
	 * What was kept of the parked terminals, until the terminal service has brought them back and
	 * `_restore` has parked them again. Kept again meanwhile, or a reload before then would lose them.
	 */
	private _unrestored: ReadonlyMap</*folder*/string, readonly IStoredParkedTerminal[]> | undefined;

	/**
	 * The folder whose editors are up: the one the window opened on, whose editors the workbench
	 * restored, then each one the bar has put up since. None from the moment a switch is announced until
	 * the bar is done putting the incoming folder's up, which it says even when that failed: a terminal
	 * shown meanwhile is closed, the shell in it with it, by the editors the switch puts there. None too
	 * once the folder on screen has left the workspace, until the bar has put its neighbour's up.
	 */
	private _editorsUpFor: string | undefined;

	constructor(
		@IActiveFolderService private readonly _activeFolderService: IActiveFolderService,
		@IWorkspaceBarService private readonly _workspaceBarService: IWorkspaceBarService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IFileService private readonly _fileService: IFileService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService
	) {
		super();

		// Made once the workbench has restored the editors (`WorkbenchPhase.AfterRestored`): those of the
		// folder the window opened on are up
		const opened = this._activeFolderService.activeFolder;
		this._editorsUpFor = opened && this._key(opened.uri);

		this._register(this._activeFolderService.onWillChangeActiveFolder(e => {
			// Every switch, including one that has nothing to park, so that a restore in flight stops
			this._generation++;
			this._editorsUpFor = undefined;

			// ⚠️ Whether or not terminals follow folders. Kept with the editors the bar keeps for the folder,
			// a terminal is closed when the next folder's are put up - the shell in it with it - unless it
			// would ask first, when they take it along, and one a reload brought back is opened a second time,
			// beside itself, when they come back (`TerminalInputSerializer`).
			if (e.from) {
				this._park(this._key(e.from.uri));
			}
		}));

		// Not on the folder change itself: the workspace bar starts its restore there without
		// awaiting it, so terminals shown at that point are closed again by the working set
		this._register(this._workspaceBarService.onDidRestoreEditors(() => {
			const folder = this._activeFolderService.activeFolder;
			this._editorsUpFor = folder && this._key(folder.uri);
			if (this._editorsUpFor !== undefined) {
				this._unparkUp(this._editorsUpFor).then(undefined, onUnexpectedError);
			}
		}));

		// A folder can leave the workspace without the active folder service announcing a move first -
		// the one on screen does, the service moving on to its neighbour - in which case nothing parks,
		// and the terminals shown or held for a folder that is gone would outlive it
		this._register(this._contextService.onDidChangeWorkspaceFolders(() => this._pruneRemovedFolders()));

		// And the bar's rows follow git's files
		this._register(this._workspaceBarService.onDidChangeRepositories(() => this._pruneGoneRows()));

		// Following folders again: what came along with the window goes back to the folder it was opened in
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(FOLLOW_FOLDER) && this._isEnabled()) {
				this._putBack();
			}
		}));

		// Kept while the window is closed: a reload, or a restart of the app, brings the terminals back
		// in the background with nothing to say which folder they were put away for
		this._register(this._storageService.onWillSaveState(() => this._saveParked()));
		this._restore().then(undefined, onUnexpectedError);

		this._register(toDisposable(() => this._forgetAll()));
	}

	/** {@link IFolderTerminalsService.terminalsOf}. */
	terminalsOf(folder: URI): readonly ITerminalInstance[] {
		const key = this._key(folder);
		const held = (this._parked.get(key) ?? []).map(parked => parked.instance);

		// The editor area's terminals that are its own: the ones leaving the folder on screen will put away
		// for it. Not `instances`: those put away for other folders are in it too, and still say `Editor`.
		const shown = this._terminalService.foregroundInstances.filter(instance => instance.target === TerminalLocation.Editor && this._shownFor(instance) === key);

		// And those opened for it, wherever they are: in the panel, or on screen with the window
		const opened = [...this._openedFor].filter(([, entry]) => entry.key === key).map(([instance]) => instance);

		return [...new Set([...held, ...shown, ...opened])];
	}

	/** {@link IFolderTerminalsService.folderOf}. */
	folderOf(instance: ITerminalInstance): URI | undefined {
		// One opened for a folder is that folder's, wherever it is
		const opened = this._openedFor.get(instance);
		if (opened) {
			return this._folderFor(opened.key)?.uri ?? opened.uri;
		}

		const key = this._keyParkedFor(instance);
		if (key !== undefined) {
			// On its way with the window to the next folder, the window's
			return key === WINDOW ? undefined : this._folderFor(key)?.uri ?? this._rows.get(key)?.uri;
		}

		// With a tab, the folder's it was opened in, which leaving the folder on screen puts it away for
		const shownFor = instance.target === TerminalLocation.Editor && this._terminalService.foregroundInstances.includes(instance) ? this._shownFor(instance) : undefined;
		return shownFor === undefined ? undefined : this._folderFor(shownFor)?.uri;
	}

	/**
	 * The folder a terminal with a tab belongs to: its own ({@link _homeOf}), else the one on screen. None
	 * without {@link FOLLOW_FOLDER}: the editor area's are then the window's, as the panel's are.
	 */
	private _shownFor(instance: ITerminalInstance): string | undefined {
		if (!this._isEnabled()) {
			return undefined;
		}

		const home = this._homeOf(instance);
		if (home !== undefined) {
			return home;
		}

		const active = this._activeFolderService.activeFolder;
		return active && this._key(active.uri);
	}

	/**
	 * The folder or row a terminal belongs to wherever it is shown: the one it was opened for (`openFor`),
	 * else the one it was opened in while that is a folder of the workspace - a terminal that left it with
	 * the window while terminals did not follow folders. None for one that belongs to the folder on screen.
	 */
	private _homeOf(instance: ITerminalInstance): string | undefined {
		const opened = this._openedFor.get(instance);
		if (opened && (this._folderFor(opened.key) || this._rows.has(opened.key))) {
			return opened.key;
		}

		const origin = this._origins.get(instance);
		return origin !== undefined && this._folderFor(origin) ? origin : undefined;
	}

	/** {@link IFolderTerminalsService.reveal}. */
	async reveal(instance: ITerminalInstance): Promise<boolean> {
		// One that has closed has nowhere to be put in front, and the terminal service no longer knows it
		if (instance.isDisposed) {
			return false;
		}

		const key = this._keyParkedFor(instance);
		if (key !== undefined && !await this._bringBack(key, instance)) {
			return false;
		}

		this._terminalService.setActiveInstance(instance);
		await this._terminalService.revealTerminal(instance);
		await instance.focusWhenReady(true);
		// Closed meanwhile, it is not in front after all
		return !instance.isDisposed;
	}

	/** {@link IFolderTerminalsService.openFor}. */
	async openFor(folder: URI, config: IShellLaunchConfig): Promise<ITerminalInstance> {
		const key = this._key(folder);
		if (!this._isEnabled() || !this._keepsTerminals(folder, key)) {
			const instance = await this._terminalService.createTerminal({ config, location: TerminalLocation.Panel });
			// The panel's to show, and its folder's all the same, ending with it - looked at again, as the
			// workspace's folders can have changed while it was made
			if (!this._store.isDisposed && this._keepsTerminals(folder, key)) {
				this._recordOpenedFor(instance, folder, key);
			}
			return instance;
		}

		// Made in the background and held for its folder, as one put away there is: it never comes in
		// front of what is on screen, not even for a moment
		const instance = await this._terminalService.createTerminal({ config: { ...config, hideFromUser: true, forcePersist: true }, location: TerminalLocation.Editor });
		if (this._store.isDisposed) {
			return instance;
		}

		// Hidden only to be made in the background. Left so, anything that makes it the active terminal -
		// an extension's `show()` - shows it wherever the window is, past the folder it is held for.
		instance.shellLaunchConfig.hideFromUser = false;

		// Looked at again: the workspace's folders can have changed while it was made. Its folder gone, it is
		// the panel's, as one opened for no folder is.
		if (!this._keepsTerminals(folder, key)) {
			instance.target = TerminalLocation.Panel;
			instance.shellLaunchConfig.forcePersist = config.forcePersist;
			await this._terminalService.showBackgroundTerminal(instance, true);
			return instance;
		}
		this._recordOpenedFor(instance, folder, key);
		this._hold(key, [{ instance, group: NO_GROUP, index: -1, persisted: config.forcePersist, active: false }]);
		this._logService.trace(`[folderTerminals] opened a terminal for ${key}`);

		// On the folder already: up now, unless its editors are still being put up or its terminals are
		// coming back, which bring it with them
		this._unparkIfUp(key);
		return instance;
	}

	/**
	 * Shows a parked terminal again, and answers whether it is back. It comes back with the rest of
	 * its folder's terminals, once the bar has put that folder's editors up, which moving onto the
	 * folder starts but does not wait for - so it is waited for itself.
	 *
	 * `false` when it will not be back: the move was refused, the window moved on again first, or the
	 * terminal could not be shown or went away.
	 */
	private async _bringBack(key: string, instance: ITerminalInstance): Promise<boolean> {
		// A folder of the workspace, or a row that is not one yet, which going to puts in it - and none for one
		// on its way with the window, which comes back with whichever folder that is going to
		const target = key === WINDOW ? undefined : this._folderFor(key)?.uri ?? this._rows.get(key)?.uri;
		if (!target && key !== WINDOW) {
			return false;
		}

		// Listened for before the move, which can be done restoring by the time it returns
		const store = new DisposableStore();
		const back = new DeferredPromise<boolean>();
		store.add(this._onDidUnpark.event(shown => {
			if (shown === instance) {
				back.complete(true);
			}
		}));
		store.add(this._onDidStopUnparking.event(stopped => {
			if (stopped === key) {
				back.complete(this._keyParkedFor(instance) === undefined);
			}
		}));
		store.add(instance.onDisposed(() => back.complete(false)));

		try {
			if (target && !this._isActive(key)) {
				await this._workspaceBarService.show(target);

				// Refused, as a folder that is gone from disk is
				if (!this._isActive(key)) {
					return false;
				}
			} else {
				// On it already, or on its way with the window: brought back now when nothing is - one that
				// could not be shown before, say - unless a switch is still putting the folder's editors up,
				// which brings it once they are
				this._unparkIfUp(key);
			}

			// Moving on again first leaves it parked, for its own folder
			store.add(this._activeFolderService.onWillChangeActiveFolder(() => back.complete(false)));

			return await back.p;
		} finally {
			store.dispose();
		}
	}

	/** The folder a terminal is parked for, if it is parked. */
	private _keyParkedFor(instance: ITerminalInstance): string | undefined {
		for (const [key, parked] of this._parked) {
			if (parked.some(entry => entry.instance === instance)) {
				return key;
			}
		}

		return undefined;
	}

	private _folderFor(key: string): IWorkspaceFolder | undefined {
		return this._contextService.getWorkspace().folders.find(folder => this._key(folder.uri) === key);
	}

	/**
	 * Whether a terminal opened for `folder` is held for it: a folder of the workspace, or one with a row
	 * on the bar that has not joined it yet - a worktree's, or a repository's - under its row.
	 */
	private _keepsTerminals(folder: URI, key: string): boolean {
		return !!this._folderFor(key) || !!this._workspaceBarService.repositoryFor(folder);
	}

	/**
	 * The folders of the workspace the repository at `uri` has - as its checkout or as a worktree - as the
	 * bar last read them; undefined while it knows of none.
	 */
	private _membersOf(uri: URI): ReadonlySet</*folder*/string> | undefined {
		// None is not an answer: the bar lists a repository for the folders of it the workspace has
		const repository = this._workspaceBarService.repositoryFor(uri);
		return repository?.members.length ? new Set(repository.members.map(member => this._key(member.uri))) : undefined;
	}

	private _isActive(key: string): boolean {
		const active = this._activeFolderService.activeFolder;
		return !!active && this._key(active.uri) === key;
	}

	private _isEnabled(): boolean {
		return this._configurationService.getValue<boolean>(FOLLOW_FOLDER) !== false;
	}

	/**
	 * Moves the terminal editors to the background as the window leaves the folder `from`: each for the
	 * folder it belongs to - its own ({@link _homeOf}), else `from` - or without {@link FOLLOW_FOLDER} for the
	 * window, with whichever folder it goes to next.
	 */
	private _park(from: string): void {
		const following = this._isEnabled();
		this._putAway(instance => {
			const opened = this._homeOf(instance) ?? from;
			if (following) {
				return opened;
			}
			this._origins.set(instance, opened);
			return WINDOW;
		}, true);
	}

	/**
	 * Following folders again: each terminal that came along with the window goes back to its own folder
	 * ({@link _homeOf}) - one on screen in another folder's editor area put away for it now, one on its way
	 * with the window held for it - so that none is left as the folder's on screen when it is another's.
	 */
	private _putBack(): void {
		const active = this._activeFolderService.activeFolder;
		const here = active && this._key(active.uri);
		const homeOf = (instance: ITerminalInstance) => {
			const home = this._homeOf(instance);
			return home !== here ? home : undefined;
		};
		this._putAway(homeOf, false);

		// Those on their way, unless being shown right now: the next move puts those away
		const carried = this._parked.get(WINDOW);
		if (!carried || this._unparking.has(WINDOW)) {
			return;
		}
		for (const entry of [...carried]) {
			const home = homeOf(entry.instance);
			if (home !== undefined) {
				carried.splice(carried.indexOf(entry), 1);
				this._hold(home, [entry]);
			}
		}
		if (!carried.length) {
			this._drop(WINDOW);
		}
	}

	/**
	 * Moves to the background the terminal editors `away` names a folder for - or the window - each recorded
	 * for it with where it was; one it names none for stays. One caught on its way back, its tab up already,
	 * stays in the record it is in, and leaves the editor area with the others when `caught` says so.
	 *
	 * Only terminals that currently have a tab are taken; a panel terminal belongs to the window
	 * and one that is already in the background has no position to read. Positions are read and the
	 * record written before anything is moved, since backgrounding closes tabs and renumbers the
	 * ones after them.
	 */
	private _putAway(away: (instance: ITerminalInstance) => string | undefined, caught: boolean): void {
		const parking = new Map</*folder, or WINDOW*/string, IParkedTerminal[]>();
		const leaving: ITerminalInstance[] = [];

		for (const instance of this._terminalService.instances) {
			if (instance.target !== TerminalLocation.Editor) {
				continue;
			}

			const place = this._placeOf(instance);
			if (!place) {
				continue;
			}

			// Caught on its way back, its tab up already: the record it is in has it still
			if (this._keyParkedFor(instance) !== undefined) {
				if (caught) {
					leaving.push(instance);
				}
				continue;
			}

			const key = away(instance);
			if (key === undefined) {
				continue;
			}

			leaving.push(instance);
			const entries = parking.get(key) ?? [];
			entries.push({ instance, ...place, persisted: instance.shellLaunchConfig.forcePersist });
			parking.set(key, entries);
		}

		for (const [key, entries] of parking) {
			this._hold(key, entries);
			this._logService.trace(`[folderTerminals] parked ${entries.length} terminal(s) for ${key === WINDOW ? 'the window' : key}`);
		}

		for (const instance of leaving) {
			// `setTerminalLayoutInfo` only persists backgrounded terminals that carry this, so without
			// it a window reload would discard the shells this contribution exists to keep
			instance.shellLaunchConfig.forcePersist = true;
			this._terminalService.moveToBackground(instance);
		}
	}

	/**
	 * Records terminals as parked for a folder, until they are shown again or end. Added to the record
	 * itself, which is the queue of a folder whose terminals are coming back (`_unpark`): one held for it
	 * meanwhile comes back with them, rather than being lost when they are all back.
	 */
	private _hold(key: string, parking: readonly IParkedTerminal[]): void {
		const held = this._parked.get(key);
		if (held) {
			held.push(...parking);
		} else {
			this._parked.set(key, [...parking]);
		}

		const store = this._watching.get(key) ?? new DisposableStore();
		this._watching.set(key, store);

		for (const { instance } of parking) {
			// ⚠️ Not when the window closing takes it away: it comes back with a reload or a restart of
			// the app, and has to find its folder again then (`_saveParked`)
			store.add(instance.onDisposed(() => {
				if (instance.exitReason !== TerminalExitReason.Shutdown) {
					this._forget(key, instance);
				}
			}));
		}
	}

	/** Keeps the parked terminals, and those not yet parked again since the window opened, for `_restore`. */
	private _saveParked(): void {
		const stored: Record</*folder*/string, IStoredParkedTerminal[]> = {};
		for (const [key, kept] of this._unrestored ?? []) {
			stored[key] = [...kept];
		}
		for (const [key, parked] of this._parked) {
			const row = this._rows.get(key)?.uri.toString();
			stored[key] = [...stored[key] ?? [], ...parked.map(({ instance, group, index, persisted, active }) => ({ nonce: instance.shellIntegrationNonce, group, index, persisted, active, row }))];
		}

		if (Object.keys(stored).length) {
			this._storageService.store(PARKED_STORAGE_KEY, JSON.stringify(stored), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storageService.remove(PARKED_STORAGE_KEY, StorageScope.WORKSPACE);
		}

		// And the folder each terminal opened for one was opened for, wherever it is
		const opened: Record</*nonce*/string, string> = {};
		for (const [nonce, uri] of this._unrestoredOpenedFor ?? []) {
			opened[nonce] = uri.toString();
		}
		for (const [instance, { uri }] of this._openedFor) {
			opened[instance.shellIntegrationNonce] = uri.toString();
		}
		if (Object.keys(opened).length) {
			this._storageService.store(OPENED_FOR_STORAGE_KEY, JSON.stringify(opened), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storageService.remove(OPENED_FOR_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}

	/**
	 * Parks again the terminals kept as parked when the window closed, once the terminal service has
	 * brought them back, and shows those of the folder the window is on once its editors are up. One
	 * that did not come back is dropped - an agent's after a restart of the app, which the agent does
	 * not outlive. Each terminal opened for a folder is that folder's again, wherever it came back.
	 */
	private async _restore(): Promise<void> {
		const kept = readParkedTerminals(this._storageService.get(PARKED_STORAGE_KEY, StorageScope.WORKSPACE));
		const openedFor = readOpenedFor(this._storageService.get(OPENED_FOR_STORAGE_KEY, StorageScope.WORKSPACE));
		if (!kept.size && !openedFor.size) {
			return;
		}

		this._unrestored = kept;
		this._unrestoredOpenedFor = openedFor;
		try {
			await this._terminalService.whenConnected;
		} finally {
			this._unrestored = undefined;
			this._unrestoredOpenedFor = undefined;
		}

		if (this._store.isDisposed) {
			return;
		}

		for (const instance of this._terminalService.instances) {
			const uri = openedFor.get(instance.shellIntegrationNonce);
			if (uri && !this._openedFor.has(instance)) {
				this._recordOpenedFor(instance, uri, this._key(uri));
			}
		}

		// Brought back in the background, with nothing parking them since
		const background = new Map(this._terminalService.instances
			.filter(instance => !this._terminalService.foregroundInstances.includes(instance) && this._keyParkedFor(instance) === undefined)
			.map(instance => [instance.shellIntegrationNonce, instance]));

		let restored = 0;
		for (const [key, entries] of kept) {
			const parked = entries.flatMap(({ nonce, ...place }) => {
				const instance = background.get(nonce);
				return instance ? [{ instance, ...place }] : [];
			});
			if (!parked.length) {
				continue;
			}

			// ⚠️ Brought back as the panel's, and shown again a terminal goes where its target says - the
			// panel, whatever tab it is asked for (`showBackgroundTerminal`). It was a tab when it was parked.
			// And brought back hidden, which would let anything that makes it the active terminal show it
			// wherever the window is (`openFor`).
			for (const { instance } of parked) {
				instance.target = TerminalLocation.Editor;
				instance.shellLaunchConfig.hideFromUser = false;
			}
			const row = entries.find(entry => entry.row)?.row;
			if (row) {
				const uri = URI.parse(row);
				this._rows.set(key, { uri, members: this._membersOf(uri) });
			}
			this._hold(key, parked);
			restored += parked.length;
		}

		this._logService.trace(`[folderTerminals] parked ${restored} terminal(s) again`);

		// A folder that left the workspace while the window was closed takes its terminals with it, as
		// one leaving now does, and so does a row whose folder is gone from disk
		this._pruneRemovedFolders();
		this._pruneGoneRows();

		// ⚠️ The folder the window is on shows its own only once its editors are up. The terminal service
		// can take seconds to have them all back, replaying each one's buffer, and a switch made meanwhile
		// closes whatever tab it did not put there itself - the shells in them with them. It shows these
		// when it is done (`onDidRestoreEditors`).
		const active = this._activeFolderService.activeFolder;
		const key = active && this._key(active.uri);
		if (key !== undefined && key === this._editorsUpFor) {
			await this._unparkUp(key);
		}
	}

	/**
	 * The position of a terminal's tab, and whether it is the one in front of its group, or
	 * `undefined` when it does not have one. A tab whose editor is disposed is not the terminal's: it is
	 * what is left of one the terminal had, until its group closes it (`_closeLeftTabs`).
	 */
	private _placeOf(instance: ITerminalInstance): { group: number; index: number; active: boolean } | undefined {
		const tabIn = (group: IEditorGroup) => group.findEditors(instance.resource).find(editor => !editor.isDisposed());

		for (const group of this._editorGroupsService.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			const editor = tabIn(group);
			if (editor) {
				return { group: group.id, index: group.getIndexOfEditor(editor), active: group.activeEditor === editor };
			}
		}

		for (const part of this._editorGroupsService.parts) {
			if (part === this._editorGroupsService.mainPart) {
				continue;
			}

			for (const group of part.groups) {
				const editor = tabIn(group);
				if (editor) {
					return { group: AUXILIARY_WINDOW, index: -1, active: group.activeEditor === editor };
				}
			}
		}

		return undefined;
	}

	/**
	 * Closes what is left of a parked terminal's tab, before the terminal is shown again. Put away, it leaves
	 * the tab to its editor group, which closes it only on the next turn of the event loop - and a folder switch
	 * parks terminals, puts the next folder's editors up and shows terminals again within one turn, the editors
	 * put up keeping the tab of a terminal running a child process, which says closing it would ask first. Shown
	 * while that tab is there, the terminal is given it - a terminal has one tab (`singlePerResource`) - and it
	 * opens nothing: the terminal would be in the editor area with no tab. Reverted first, so that it does not
	 * ask: the terminal is not ending.
	 */
	private async _closeLeftTabs(instance: ITerminalInstance): Promise<void> {
		for (const group of this._editorGroupsService.groups) {
			for (const editor of group.findEditors(instance.resource)) {
				if (editor.isDisposed()) {
					await editor.revert(group.id);
					await group.closeEditor(editor, { preserveFocus: true });
				}
			}
		}
	}

	/**
	 * Shows the terminals held for the folder on screen now - or those on their way with the window, for
	 * whichever folder that is - when its editors are up and nothing is showing them already: while a
	 * switch is still putting the folder's editors up they bring them, and a terminal shown before then
	 * would be closed with the shell in it.
	 */
	private _unparkIfUp(key: string): void {
		const up = key === WINDOW ? this._editorsUpFor !== undefined : this._isActive(key) && this._editorsUpFor === key;
		if (up && !this._unparking.has(key)) {
			this._unpark(key).then(undefined, onUnexpectedError);
		}
	}

	/**
	 * Shows the terminals of the folder whose editors are up, then those that came along with the window -
	 * unless it has moved on meanwhile, when the next folder's editors bring them.
	 */
	private async _unparkUp(key: string): Promise<void> {
		// Not a second time over the same record: one still coming back from a move onto the folder before
		// goes on, or, stopped by the moves since, starts again (`_unpark`)
		if (!this._unparking.has(key)) {
			await this._unpark(key);
		}
		this._unparkIfUp(WINDOW);
	}

	/**
	 * Shows the folder's terminals again, in the columns and at the tabs they were at.
	 *
	 * Those that had a tab are shown lowest index first so that each lands in a column whose earlier
	 * tabs are already in place; those that never had one (`openFor`) after them, at the end of the
	 * column in front. Each one stays in the queue until it is actually back so that a failure or a
	 * second switch does not leave a live shell untracked.
	 */
	private async _unpark(key: string): Promise<void> {
		// The record itself is the queue: one held for the folder meanwhile joins it (`_hold`), and one
		// that ends leaves it (`_forget`)
		const queue = this._parked.get(key);
		if (!queue?.length) {
			return;
		}

		const generation = this._generation;
		// Floated ones last: a new auxiliary window takes the focus.
		const rank = (entry: IParkedTerminal) => entry.group === AUXILIARY_WINDOW ? 2 : entry.group === NO_GROUP ? 1 : 0;
		queue.sort((a, b) => rank(a) - rank(b) || a.index - b.index);
		this._unparking.add(key);

		let reopened = 0;
		let movedOn = false;
		try {
			while (queue.length) {
				const entry = queue[0];

				let failed = false;
				try {
					await this._closeLeftTabs(entry.instance);

					// Straight into its own column and at its own tab: moving it between groups closes its
					// editor, and the terminal editor service then stops tracking it. In another column, at
					// its end, in the order they come back - an editor opened without an index goes after
					// the one in front, which reverses them. In front only if it was the tab in front, and
					// only in its own column: in another, the tab in front is that column's, and stays in front.
					// `activation: PRESERVE` and `preserveFocus` so neither the column nor the caret moves.
					const place = this._placeFor(entry);
					await this._terminalService.showBackgroundTerminal(entry.instance, true, {
						viewColumn: place.column,
						index: place.own ? (entry.index >= 0 ? entry.index : undefined) : place.end,
						preserveFocus: true,
						inactive: !entry.active || !place.own,
						activation: EditorActivation.PRESERVE
					});
				} catch (error) {
					this._logService.error(`[folderTerminals] could not reopen a terminal for ${key}`, error);
					failed = true;
				}

				// Ended while it was being shown, it has been taken off already (`_forget`) - and is not to be
				// put back in the background, where it would stay for good
				const ended = queue[0] !== entry;

				// The open cannot be cancelled once it is in flight, so a terminal that arrives after the
				// window has moved on is put straight back rather than left in the wrong folder
				if (this._generation !== generation) {
					if (!ended) {
						this._terminalService.moveToBackground(entry.instance);
					}
					this._logService.trace(`[folderTerminals] switch during restore, ${queue.length} terminal(s) still parked for ${key}`);
					movedOn = true;
					return;
				}

				// Shown nowhere - the open failed, or opened nothing - it goes back to the background, parked
				// still, rather than staying in the editor area without a tab: there nobody sees it, and the
				// next reload loses it, the shell in it with it
				if (!ended && !this._placeOf(entry.instance)) {
					if (!failed) {
						this._logService.error(`[folderTerminals] a terminal for ${key} did not come back`);
					}
					this._terminalService.moveToBackground(entry.instance);
					return;
				}

				if (!ended) {
					entry.instance.shellLaunchConfig.forcePersist = entry.persisted;
					queue.shift();
					reopened++;
					this._onDidUnpark.fire(entry.instance);
				}
			}

			this._logService.trace(`[folderTerminals] reopened ${reopened} terminal(s) for ${key}`);
		} finally {
			// Only this record: one the folder going has dropped may have been followed by a new one
			if (!queue.length && this._parked.get(key) === queue) {
				this._drop(key);
			}
			this._unparking.delete(key);
			this._onDidStopUnparking.fire(key);

			// Stopped by a move: started again at once when what it was for is up again - the window back on
			// the folder, or for those on its way with it any folder - as the editors put up meanwhile did
			// not start it a second time (`_unparkUp`); else the editors still to be put up start it
			if (movedOn) {
				this._unparkIfUp(key);
			}
		}
	}

	/**
	 * Where a parked terminal is shown: a floated one in a new window of its own, else in the column of
	 * the group it was in, found by id. That group gone, at the `end` of the main window's active column,
	 * or of the first one not locked if that one is - named by its number, as `ACTIVE_GROUP` would be
	 * another window's while that one has the focus, and a number is taken as given, lock or no lock.
	 */
	private _placeFor(entry: IParkedTerminal): { readonly column: EditorGroupColumn | AUX_WINDOW_GROUP_TYPE; readonly own: boolean; readonly end: number | undefined } {
		if (entry.group === AUXILIARY_WINDOW) {
			return { column: AUX_WINDOW_GROUP, own: true, end: undefined };
		}

		const mainPart = this._editorGroupsService.mainPart;
		const columns = mainPart.getGroups(GroupsOrder.GRID_APPEARANCE);
		const own = columns.findIndex(group => group.id === entry.group);
		if (own !== -1) {
			return { column: own, own: true, end: undefined };
		}

		const other = [mainPart.activeGroup, ...columns].find(group => !group.isLocked) ?? mainPart.activeGroup;
		return { column: columns.indexOf(other), own: false, end: other.count };
	}

	/**
	 * Takes a terminal that ended off its folder's record - the record itself, which is the queue while
	 * that folder's terminals are coming back. The last one takes the record with it, unless they are
	 * coming back, which drops it once they are.
	 */
	private _forget(key: string, instance: ITerminalInstance): void {
		const parked = this._parked.get(key);
		const index = parked ? parked.findIndex(candidate => candidate.instance === instance) : -1;
		if (!parked || index === -1) {
			return;
		}

		parked.splice(index, 1);
		if (!parked.length && !this._unparking.has(key)) {
			this._drop(key);
		}
	}

	/** Stops keeping anything for a folder: its record, what watches its terminals, and its row. */
	private _drop(key: string): void {
		this._parked.delete(key);
		this._watching.get(key)?.dispose();
		this._watching.delete(key);
		this._rows.delete(key);
	}

	/**
	 * Follows the workspace's folders: a folder that left takes the terminals parked for it with it, and
	 * those opened for it wherever they are. A row that joined them is a folder like the others from then
	 * on; one whose repository left them - the last of its folders gone - goes with it, its terminals with
	 * it.
	 */
	private _pruneRemovedFolders(): void {
		const present = new Set(this._contextService.getWorkspace().folders.map(folder => this._key(folder.uri)));

		// The folder on screen gone: the active folder service moved on without announcing it, which is a
		// move all the same - a restore in flight stops - and its terminals are put away as on any: those
		// that are its for it, to end below with those held for it, those that came along with the window
		// for their own folders, and while terminals do not follow folders all of them for the window, back
		// with the next folder's editors - unless no folder is left, whose editors would put them back. Out
		// of the editor area first: ended in its tab, a terminal's tab is closed only once its group gets to
		// it, by when the editors the bar puts up for the next folder may have taken its place - nothing
		// closes it then, and the terminal editor service keeps the ended terminal for good.
		const gone = this._editorsUpFor;
		if (gone !== undefined && !present.has(gone)) {
			this._generation++;
			this._editorsUpFor = undefined;
			if (this._isEnabled() || present.size) {
				this._park(gone);
			}
		}

		for (const [key, row] of [...this._rows]) {
			if (present.has(key)) {
				this._rows.delete(key);
			} else if (row.members && ![...row.members].some(member => present.has(member))) {
				this._logService.trace(`[folderTerminals] repository removed, disposing ${this._parked.get(key)?.length ?? 0} terminal(s) held for ${key}`);
				this._endHeld(key);
			}
		}

		// Those on their way with the window are none of the folders'
		for (const [key, parked] of [...this._parked]) {
			if (key === WINDOW || present.has(key) || this._rows.has(key)) {
				continue;
			}

			this._logService.trace(`[folderTerminals] folder removed, disposing ${parked.length} parked terminal(s)`);
			this._endHeld(key);
		}

		// Those opened for a folder, wherever they are, as those held for one: a folder that left takes them,
		// and a row that never joined goes with its repository's last folder - not before the bar has read
		// which those are, as after a reload
		for (const [instance, opened] of [...this._openedFor]) {
			if (present.has(opened.key)) {
				opened.joined = true;
			} else if (opened.joined || (opened.members && ![...opened.members].some(member => present.has(member)))) {
				this._logService.trace(`[folderTerminals] folder removed, disposing a terminal opened for ${opened.key}`);
				this._endOpenedFor(instance);
			}
		}
	}

	/**
	 * Follows the bar's reading of git's files. A row it reads keeps its repository's folders up to date
	 * (`_pruneRemovedFolders`). One it does not is not gone for that alone - a read misses a file git is
	 * rewriting, and while the bar lists no worktrees it reads none - but once its folder is gone from
	 * disk it is, and its terminals end as a folder's do when it leaves the workspace. Gone, or left
	 * without its `.git`: git removing a worktree on Windows cannot delete the folder a process is in, and
	 * leaves it empty.
	 *
	 * And the terminals opened for a folder in a repository - a row, or a folder of the workspace - end once
	 * git has no worktree there any more, wherever they are. The person's own shells in a folder of the
	 * workspace stay, as the folder does.
	 */
	private _pruneGoneRows(): void {
		for (const [key, row] of [...this._rows]) {
			const members = this._membersOf(row.uri);
			if (members) {
				this._rows.set(key, { uri: row.uri, members });
			} else {
				this._endIfGoneFromDisk(key, row.uri).then(undefined, onUnexpectedError);
			}
		}

		for (const [instance, opened] of [...this._openedFor]) {
			opened.members = this._membersOf(opened.uri) ?? opened.members;
			if (opened.members) {
				this._endOpenedIfGone(instance, opened).then(undefined, onUnexpectedError);
			}
		}
	}

	/** Ends a terminal opened for a folder once the folder's `.git` is not found on disk - not when it cannot be looked at. */
	private async _endOpenedIfGone(instance: ITerminalInstance, opened: IOpenedFor): Promise<void> {
		try {
			await this._fileService.stat(joinPath(opened.uri, '.git'));
			return;
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
				return;
			}
		}

		// Unless it has ended meanwhile
		if (this._openedFor.get(instance) === opened) {
			this._logService.trace(`[folderTerminals] worktree gone from disk, disposing a terminal opened for ${opened.key}`);
			this._endOpenedFor(instance);
		}
	}

	/**
	 * Notes that a terminal was opened for the folder at `uri`, until it ends: one the window closing takes
	 * away comes back with the next window (`_saveParked`). One opened for a row of the bar is held for that
	 * row wherever it is put away, in the panel too.
	 */
	private _recordOpenedFor(instance: ITerminalInstance, uri: URI, key: string): void {
		const listener = instance.onDisposed(() => {
			if (instance.exitReason !== TerminalExitReason.Shutdown) {
				this._forgetOpenedFor(instance);
			}
		});
		this._openedFor.set(instance, { key, uri, joined: !!this._folderFor(key), members: this._membersOf(uri), listener });
		if (!this._folderFor(key) && !this._rows.has(key)) {
			this._rows.set(key, { uri, members: this._membersOf(uri) });
		}
	}

	private _forgetOpenedFor(instance: ITerminalInstance): void {
		const opened = this._openedFor.get(instance);
		if (opened) {
			opened.listener.dispose();
			this._openedFor.delete(instance);
		}
	}

	/**
	 * Ends a terminal opened for a folder that has gone, wherever it is: out of the editor area first, as
	 * the folder on screen's are (`_pruneRemovedFolders`).
	 */
	private _endOpenedFor(instance: ITerminalInstance): void {
		this._forgetOpenedFor(instance);
		if (this._placeOf(instance)) {
			this._terminalService.moveToBackground(instance);
		}
		instance.dispose(TerminalExitReason.User);
	}

	/**
	 * Ends the terminals held under the row at `uri` once its folder's `.git` is not found on disk - with
	 * the folder, or without it - and not when it cannot be looked at.
	 */
	private async _endIfGoneFromDisk(key: string, uri: URI): Promise<void> {
		try {
			await this._fileService.stat(joinPath(uri, '.git'));
			return;
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
				return;
			}
		}

		// Unless it has joined the workspace, ended, or been read again meanwhile
		if (this._rows.get(key)?.uri === uri && !this._membersOf(uri)) {
			this._logService.trace(`[folderTerminals] row gone from disk, disposing ${this._parked.get(key)?.length ?? 0} terminal(s) held for ${key}`);
			this._endHeld(key);
		}
	}

	/** Ends the terminals held for a folder or a row that has gone, and keeps nothing more for it. */
	private _endHeld(key: string): void {
		const parked = this._parked.get(key) ?? [];
		this._drop(key);

		for (const { instance } of parked) {
			instance.dispose(TerminalExitReason.User);
		}
	}

	private _forgetAll(): void {
		for (const store of this._watching.values()) {
			store.dispose();
		}

		this._watching.clear();
		this._parked.clear();
		this._rows.clear();

		for (const opened of this._openedFor.values()) {
			opened.listener.dispose();
		}
		this._openedFor.clear();
	}

	private _key(uri: URI): string {
		return folderKey(this._uriIdentityService, uri);
	}
}
