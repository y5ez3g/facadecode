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
import { ACTIVE_GROUP, AUX_WINDOW_GROUP, AUX_WINDOW_GROUP_TYPE } from '../../../services/editor/common/editorService.js';
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
	 * and taking it out of the workspace stops.
	 */
	terminalsOf(folder: URI): readonly ITerminalInstance[];

	/**
	 * The folder a terminal belongs to: the one it is put away for, or while it has a tab, the one the
	 * window is on. `undefined` for a terminal that belongs to the window, in the panel.
	 */
	folderOf(instance: ITerminalInstance): IWorkspaceFolder | undefined;

	/**
	 * Puts a terminal in front and focuses it. One put away for another folder is brought back by
	 * moving the window onto that folder first, as a click on its row does.
	 */
	reveal(instance: ITerminalInstance): Promise<void>;

	/**
	 * A terminal opened for `folder` as if somebody on it had opened it, without moving the window: in
	 * the editor area when the window is on it; kept for it in the background, to come up when the
	 * window goes there, when it is another folder of the workspace; in the panel, the window's own,
	 * when it is not a folder of the workspace or terminals do not follow folders.
	 */
	openFor(folder: URI, config: IShellLaunchConfig): Promise<ITerminalInstance>;
}

/** `IFolderTerminalsService`, served by the `FolderTerminals` contribution that keeps the terminals. */
export class FolderTerminalsService implements IFolderTerminalsService {

	declare readonly _serviceBrand: undefined;

	terminalsOf(folder: URI): readonly ITerminalInstance[] {
		return getWorkbenchContribution<FolderTerminals>(FolderTerminals.ID).terminalsOf(folder);
	}

	folderOf(instance: ITerminalInstance): IWorkspaceFolder | undefined {
		return getWorkbenchContribution<FolderTerminals>(FolderTerminals.ID).folderOf(instance);
	}

	reveal(instance: ITerminalInstance): Promise<void> {
		return getWorkbenchContribution<FolderTerminals>(FolderTerminals.ID).reveal(instance);
	}

	openFor(folder: URI, config: IShellLaunchConfig): Promise<ITerminalInstance> {
		return getWorkbenchContribution<FolderTerminals>(FolderTerminals.ID).openFor(folder, config);
	}
}

/**
 * The group recorded for a terminal opened for another folder: none, so that coming back puts it at
 * the end of whichever column is in front, behind that column's own tab.
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
	 * The id of its group in the main editor grid, or {@link AUXILIARY_WINDOW}. By id, not by column:
	 * closing a column to its left moves the column along.
	 */
	readonly group: number;

	/** The index within that group. Not meaningful for an auxiliary window. */
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
}

function isStoredParkedTerminal(candidate: unknown): candidate is IStoredParkedTerminal {
	if (!isObject(candidate)) {
		return false;
	}

	const { nonce, group, index, persisted, active } = candidate as Record<string, unknown>;
	return isString(nonce) && isNumber(group) && isNumber(index) && isBoolean(active)
		&& (persisted === undefined || isBoolean(persisted));
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
	 * restored, then each one the bar has put up since. Not the folder the window is on while a switch
	 * is still putting them there.
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
	folderOf(instance: ITerminalInstance): IWorkspaceFolder | undefined {
		const key = this._keyParkedFor(instance);
		if (key !== undefined) {
			return this._folderFor(key);
		}

		// With a tab, it is the folder on screen's: leaving that folder is what would put it away - or
		// without `FOLLOW_FOLDER`, close it
		if (instance.target === TerminalLocation.Editor && this._terminalService.foregroundInstances.includes(instance)) {
			return this._activeFolderService.activeFolder;
		}

		return undefined;
	}

	/** {@link IFolderTerminalsService.reveal}. */
	async reveal(instance: ITerminalInstance): Promise<void> {
		const key = this._keyParkedFor(instance);
		if (key !== undefined && !await this._bringBack(key, instance)) {
			return;
		}

		this._terminalService.setActiveInstance(instance);
		await this._terminalService.revealTerminal(instance);
		await instance.focusWhenReady(true);
	}

	/** {@link IFolderTerminalsService.openFor}. */
	async openFor(folder: URI, config: IShellLaunchConfig): Promise<ITerminalInstance> {
		const key = this._key(folder);
		const target = this._folderFor(key);
		if (target && this._isActive(key)) {
			return this._terminalService.createTerminal({ config, location: { viewColumn: ACTIVE_GROUP } });
		}

		if (!target || !this._isEnabled()) {
			return this._terminalService.createTerminal({ config, location: TerminalLocation.Panel });
		}

		// Made in the background and held for its folder, as if it had been open there when the window
		// left: never shown in the folder on screen, not even for a moment.
		const instance = await this._terminalService.createTerminal({ config: { ...config, hideFromUser: true, forcePersist: true }, location: TerminalLocation.Editor });
		this._hold(key, [{ instance, group: NO_GROUP, index: -1, persisted: config.forcePersist, active: false }]);
		this._logService.trace(`[folderTerminals] opened a terminal for ${key}, held until the window goes there`);
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
		const folder = this._folderFor(key);
		if (!folder) {
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
				await this._workspaceBarService.show(folder.uri);

				// Refused, as a folder that is gone from disk is
				if (!this._isActive(key)) {
					return false;
				}
			} else if (!this._unparking.has(key)) {
				// On it already with nothing bringing it back: a restore that failed left it parked
				this._unpark(key).then(undefined, onUnexpectedError);
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

	/** Records terminals as parked for a folder, until they are shown again or end. */
	private _hold(key: string, parking: readonly IParkedTerminal[]): void {
		const held = this._parked.get(key) ?? [];
		this._parked.set(key, [...held, ...parking]);

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
			stored[key] = [...stored[key] ?? [], ...parked.map(({ instance, group, index, persisted, active }) => ({ nonce: instance.shellIntegrationNonce, group, index, persisted, active }))];
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
			for (const { instance } of parked) {
				instance.target = TerminalLocation.Editor;
			}
			this._hold(key, parked);
			restored += parked.length;
		}

		this._logService.trace(`[folderTerminals] parked ${restored} terminal(s) again`);

		// A folder that left the workspace while the window was closed takes its terminals with it, as
		// one leaving now does
		this._pruneRemovedFolders();

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
	 * Shows the folder's terminals again, in the columns and at the tabs they were at.
	 *
	 * Entries are shown lowest index first so that each lands in a column whose earlier tabs
	 * are already in place, and each one stays in the queue until it is actually back so that a
	 * failure or a second switch does not leave a live shell untracked.
	 */
	private async _unpark(key: string): Promise<void> {
		const parked = this._parked.get(key);
		if (!parked?.length) {
			return;
		}

		const generation = this._generation;
		// Floated ones last: a new auxiliary window takes the focus.
		const queue = [...parked].sort((a, b) => Number(a.group === AUXILIARY_WINDOW) - Number(b.group === AUXILIARY_WINDOW) || a.index - b.index);
		this._parked.set(key, queue);
		this._unparking.add(key);

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

				// The open cannot be cancelled once it is in flight, so a terminal that arrives after the
				// window has moved on is put straight back rather than left in the wrong folder
				if (this._generation !== generation) {
					this._terminalService.moveToBackground(entry.instance);
					this._logService.trace(`[folderTerminals] switch during restore, ${queue.length} terminal(s) still parked for ${key}`);
					return;
				}

				entry.instance.shellLaunchConfig.forcePersist = entry.persisted;
				queue.shift();
				this._onDidUnpark.fire(entry.instance);
			}

			this._parked.delete(key);
			this._watching.get(key)?.dispose();
			this._watching.delete(key);

			this._logService.trace(`[folderTerminals] reopened ${parked.length} terminal(s) for ${key}`);
		} finally {
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

	private _forget(key: string, instance: ITerminalInstance): void {
		const remaining = (this._parked.get(key) ?? []).filter(candidate => candidate.instance !== instance);
		if (remaining.length) {
			this._parked.set(key, remaining);
			return;
		}

		this._parked.delete(key);
		this._watching.get(key)?.dispose();
		this._watching.delete(key);
	}

	private _pruneRemovedFolders(): void {
		const present = new Set(this._contextService.getWorkspace().folders.map(folder => this._key(folder.uri)));

		for (const [key, parked] of [...this._parked]) {
			if (present.has(key)) {
				continue;
			}

			this._logService.trace(`[folderTerminals] folder removed, disposing ${parked.length} parked terminal(s)`);
			this._parked.delete(key);
			this._watching.get(key)?.dispose();
			this._watching.delete(key);

			for (const { instance } of parked) {
				instance.dispose(TerminalExitReason.User);
			}
		}
	}

	private _forgetAll(): void {
		for (const store of this._watching.values()) {
			store.dispose();
		}

		this._watching.clear();
		this._parked.clear();
	}

	private _key(uri: URI): string {
		return folderKey(this._uriIdentityService, uri);
	}
}
