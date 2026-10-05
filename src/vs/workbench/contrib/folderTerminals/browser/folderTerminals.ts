/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
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
import { GroupsOrder, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { EditorGroupColumn } from '../../../services/editor/common/editorGroupColumn.js';
import { AUX_WINDOW_GROUP, AUX_WINDOW_GROUP_TYPE } from '../../../services/editor/common/editorService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/**
 * Controls whether a terminal in the editor area belongs to the folder it was opened in.
 */
export const FOLLOW_FOLDER = 'facade.terminal.followFolder';

export const IFolderTerminalsService = createDecorator<IFolderTerminalsService>('folderTerminalsService');

/** Which terminals belong to a folder of the workspace (`FolderTerminals`). */
export interface IFolderTerminalsService {
	readonly _serviceBrand: undefined;

	/**
	 * The terminals `folder` has in the editor area: put away while the window is elsewhere, or there
	 * now while it is on it - the ones leaving it puts away, or without {@link FOLLOW_FOLDER} closes,
	 * and taking it out of the workspace stops. For a row of the bar that has not joined the workspace,
	 * those held under it ({@link openFor}).
	 */
	terminalsOf(folder: URI): readonly ITerminalInstance[];

	/**
	 * The folder a terminal belongs to, by its row on the bar: the one it is put away for - a folder of
	 * the workspace, or a row that has not joined it - or while it has a tab, the one the window is on.
	 * `undefined` for a terminal that belongs to the window, in the panel.
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
	 * while the window is on that folder, and is held for it until the window goes there otherwise. Any
	 * other folder's, and every one while terminals do not follow folders, is the panel's, the window's
	 * own. {@link reveal} puts it in front.
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
 * working set is captured, and shown again once the incoming folder's editors are up.
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
	 * shown meanwhile is closed, the shell in it with it, by the editors the switch puts there.
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

			if (e.from && this._isEnabled()) {
				this._park(this._key(e.from.uri));
			}
		}));

		// Not on the folder change itself: the workspace bar starts its restore there without
		// awaiting it, so terminals shown at that point are closed again by the working set
		this._register(this._workspaceBarService.onDidRestoreEditors(() => {
			const folder = this._activeFolderService.activeFolder;
			this._editorsUpFor = folder && this._key(folder.uri);
			if (this._editorsUpFor !== undefined) {
				this._unpark(this._editorsUpFor).then(undefined, onUnexpectedError);
			}
		}));

		// A folder can leave the workspace without the active folder service announcing it first, in
		// which case nothing parks and the terminals would be held for a folder that is gone
		this._register(this._contextService.onDidChangeWorkspaceFolders(() => this._pruneRemovedFolders()));

		// And the bar's rows follow git's files
		this._register(this._workspaceBarService.onDidChangeRepositories(() => this._pruneGoneRows()));

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

		// On the folder now, the editor area's terminals are the ones leaving it will put away. Not
		// `instances`: those put away for other folders are in it too, and still say `Editor`.
		const active = this._activeFolderService.activeFolder;
		const shown = active && this._key(active.uri) === key ? this._terminalService.foregroundInstances.filter(instance => instance.target === TerminalLocation.Editor) : [];

		return [...held, ...shown];
	}

	/** {@link IFolderTerminalsService.folderOf}. */
	folderOf(instance: ITerminalInstance): URI | undefined {
		const key = this._keyParkedFor(instance);
		if (key !== undefined) {
			return this._folderFor(key)?.uri ?? this._rows.get(key)?.uri;
		}

		// With a tab, it is the folder on screen's: leaving that folder is what would put it away - or
		// without `FOLLOW_FOLDER`, close it
		if (instance.target === TerminalLocation.Editor && this._terminalService.foregroundInstances.includes(instance)) {
			return this._activeFolderService.activeFolder?.uri;
		}

		return undefined;
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
			return this._terminalService.createTerminal({ config, location: TerminalLocation.Panel });
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
		if (!this._folderFor(key)) {
			this._rows.set(key, { uri: folder, members: this._membersOf(folder) });
		}
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
		// A folder of the workspace, or a row that is not one yet, which going to puts in it
		const target = this._folderFor(key)?.uri ?? this._rows.get(key)?.uri;
		if (!target) {
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
			if (!this._isActive(key)) {
				await this._workspaceBarService.show(target);

				// Refused, as a folder that is gone from disk is
				if (!this._isActive(key)) {
					return false;
				}
			} else {
				// On it already: brought back now when nothing is - one that could not be shown before, say -
				// unless a switch is still putting the folder's editors up, which brings it once they are
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
	 * Moves the folder's terminal editors to the background, recording where each one was.
	 *
	 * Only terminals that currently have a tab are taken; a panel terminal belongs to the window
	 * and one that is already in the background has no position to read. Positions are read and the
	 * record written before anything is moved, since backgrounding closes tabs and renumbers the
	 * ones after them.
	 */
	private _park(key: string): void {
		const parking: IParkedTerminal[] = [];

		for (const instance of this._terminalService.instances) {
			if (instance.target !== TerminalLocation.Editor) {
				continue;
			}

			const place = this._placeOf(instance);
			if (place) {
				parking.push({ instance, ...place, persisted: instance.shellLaunchConfig.forcePersist });
			}
		}

		if (parking.length === 0) {
			return;
		}

		this._hold(key, parking);

		for (const { instance } of parking) {
			// `setTerminalLayoutInfo` only persists backgrounded terminals that carry this, so without
			// it a window reload would discard the shells this contribution exists to keep
			instance.shellLaunchConfig.forcePersist = true;
			this._terminalService.moveToBackground(instance);
		}

		this._logService.trace(`[folderTerminals] parked ${parking.length} terminal(s) for ${key}`);
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
	}

	/**
	 * Parks again the terminals kept as parked when the window closed, once the terminal service has
	 * brought them back, and shows those of the folder the window is on once its editors are up. One
	 * that did not come back is dropped - an agent's after a restart of the app, which the agent does
	 * not outlive.
	 */
	private async _restore(): Promise<void> {
		const kept = readParkedTerminals(this._storageService.get(PARKED_STORAGE_KEY, StorageScope.WORKSPACE));
		if (!kept.size) {
			return;
		}

		this._unrestored = kept;
		try {
			await this._terminalService.whenConnected;
		} finally {
			this._unrestored = undefined;
		}

		if (this._store.isDisposed) {
			return;
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
			await this._unpark(key);
		}
	}

	/**
	 * The position of a terminal's tab, and whether it is the one in front of its group, or
	 * `undefined` when it does not have one.
	 */
	private _placeOf(instance: ITerminalInstance): { group: number; index: number; active: boolean } | undefined {
		for (const group of this._editorGroupsService.mainPart.getGroups(GroupsOrder.GRID_APPEARANCE)) {
			const [editor] = group.findEditors(instance.resource);
			if (editor) {
				return { group: group.id, index: group.getIndexOfEditor(editor), active: group.activeEditor === editor };
			}
		}

		for (const part of this._editorGroupsService.parts) {
			if (part === this._editorGroupsService.mainPart) {
				continue;
			}

			for (const group of part.groups) {
				const [editor] = group.findEditors(instance.resource);
				if (editor) {
					return { group: AUXILIARY_WINDOW, index: -1, active: group.activeEditor === editor };
				}
			}
		}

		return undefined;
	}

	/**
	 * Shows the terminals held for the folder on screen now, when its editors are up and nothing is
	 * showing them already: while a switch is still putting the folder's editors up they bring them, and
	 * a terminal shown before then would be closed with the shell in it.
	 */
	private _unparkIfUp(key: string): void {
		if (this._isActive(key) && this._editorsUpFor === key && !this._unparking.has(key)) {
			this._unpark(key).then(undefined, onUnexpectedError);
		}
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
		try {
			while (queue.length) {
				const entry = queue[0];

				try {
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
					return;
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
	 * Follows the workspace's folders: a folder that left takes the terminals parked for it with it. A
	 * row that joined them is a folder like the others from then on; one whose repository left them - the
	 * last of its folders gone - goes with it, its terminals with it.
	 */
	private _pruneRemovedFolders(): void {
		const present = new Set(this._contextService.getWorkspace().folders.map(folder => this._key(folder.uri)));
		for (const [key, row] of [...this._rows]) {
			if (present.has(key)) {
				this._rows.delete(key);
			} else if (row.members && ![...row.members].some(member => present.has(member))) {
				this._logService.trace(`[folderTerminals] repository removed, disposing ${this._parked.get(key)?.length ?? 0} terminal(s) held for ${key}`);
				this._endHeld(key);
			}
		}

		for (const [key, parked] of [...this._parked]) {
			if (present.has(key) || this._rows.has(key)) {
				continue;
			}

			this._logService.trace(`[folderTerminals] folder removed, disposing ${parked.length} parked terminal(s)`);
			this._endHeld(key);
		}
	}

	/**
	 * Follows the bar's reading of git's files. A row it reads keeps its repository's folders up to date
	 * (`_pruneRemovedFolders`). One it does not is not gone for that alone - a read misses a file git is
	 * rewriting, and while the bar lists no worktrees it reads none - but once its folder is gone from
	 * disk it is, and its terminals end as a folder's do when it leaves the workspace.
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
	}

	/** Ends the terminals held under the row at `uri` once its folder is not found on disk - not when it cannot be looked at. */
	private async _endIfGoneFromDisk(key: string, uri: URI): Promise<void> {
		try {
			await this._fileService.stat(uri);
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
	}

	private _key(uri: URI): string {
		return folderKey(this._uriIdentityService, uri);
	}
}
