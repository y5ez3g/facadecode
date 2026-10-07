/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isNumber, isObject, isString } from '../../../../base/common/types.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/** An agent's run: the record of its workspace, by the record's id, and the agent's number in that record. */
export interface IFacadeRun {
	readonly workspace: string;
	readonly id: number;
}

/** How a run's own process ended, as this load of the window saw it end. */
export interface IFacadeRunEnd {
	/** The code it exited with, where known. */
	readonly exitCode?: number;

	/**
	 * Whether the person closed its terminal: closed for the user with no exit code. VS Code closes a
	 * terminal in the editor area whose process exited as if the user had, the process's code kept.
	 */
	readonly byThePerson: boolean;
}

/**
 * What the window knows of a run's own process: `present` in one of its terminals; `gone` from every one
 * of them, with how it ended where this load of the window saw it end; `unknown` while the window cannot
 * tell - its terminals not all back yet, its process's id not told yet, or its terminal going with the
 * window.
 */
export type FacadeRunProcess =
	| { readonly state: 'present' }
	| { readonly state: 'gone'; readonly end?: IFacadeRunEnd }
	| { readonly state: 'unknown' };

/** Whether `candidate` is an `IFacadeRun`: a record's id, and a number. */
export function isFacadeRun(candidate: unknown): candidate is IFacadeRun {
	if (!isObject(candidate)) {
		return false;
	}

	const { workspace, id } = candidate as Record<string, unknown>;
	return isString(workspace) && !!workspace && isNumber(id) && Number.isInteger(id) && id > 0;
}

export const IFacadeRunsService = createDecorator<IFacadeRunsService>('facadeRunsService');

/**
 * The agents' runs the window holds, each registered on the terminal made for it, by the process that
 * terminal started for it: its own. The registration goes with that process through reloads, a window
 * that crashed and was reopened, and moves within the window, whatever the terminal's title. A new process
 * in the terminal - relaunched - is no run, and neither is a new terminal, split from it.
 */
export interface IFacadeRunsService {
	readonly _serviceBrand: undefined;

	/**
	 * Settles once the window has every terminal it had back: reconnected to their processes, those of the
	 * editor area and of floating windows restored. Until then a run not found may still be coming.
	 */
	readonly whenRestored: Promise<void>;

	/** Registers the terminal just made for `run`: the process it starts now is the run's own. */
	register(instance: ITerminalInstance, run: IFacadeRun): void;

	/** The terminal the run's own process runs in; undefined for none. */
	terminalOf(run: IFacadeRun): ITerminalInstance | undefined;

	/**
	 * What the window knows of the own processes of `workspace`'s runs: of those numbered `ids`, in their
	 * order, or of every one it holds. A run it never registered is gone once its terminals are all back.
	 */
	processes(workspace: string, ids?: readonly number[]): readonly (FacadeRunProcess & { readonly id: number })[];
}

/** Where the runs are kept while their processes may run on, a reload away: `IStoredRun`s. */
export const RUNS_STORAGE_KEY = 'facade.runs';

/** A run as it is kept: with the nonce of the terminal made for it, and its own process's id once told. */
interface IStoredRun extends IFacadeRun {
	/**
	 * The terminal's shell integration nonce. Made once for each terminal, it goes with the process: a
	 * reload reconnects to the same one, and a restart of the app revives it - under a new process.
	 */
	readonly nonce: string;
	readonly processId?: number;
}

/** A run as the window holds it. */
interface IRunRecord {
	readonly run: IFacadeRun;
	readonly nonce: string;
	/** Its own process's id, once the window has told it: on Windows, with the process's first output. */
	processId: number | undefined;
	/** How its own process ended, once this load of the window saw it end. */
	end?: IFacadeRunEnd;
	/** Set as its terminal goes with the window: whether its process comes back is the next load's to say. */
	leaving?: boolean;
}

/** What was kept of the runs. Storage that cannot be read keeps nothing, and an entry that is not a run is left out. */
function readRuns(value: string | undefined): IStoredRun[] {
	let stored: unknown;
	try {
		stored = value ? JSON.parse(value) : undefined;
	} catch {
		return [];
	}

	return Array.isArray(stored) ? stored.filter((candidate): candidate is IStoredRun => {
		if (!isFacadeRun(candidate)) {
			return false;
		}
		const { nonce, processId } = candidate as unknown as Record<string, unknown>;
		return isString(nonce) && (processId === undefined || isNumber(processId));
	}) : [];
}

/** The key a run is held by. */
function keyOf(run: IFacadeRun): string {
	return `${run.workspace}#${run.id}`;
}

export class FacadeRunsService extends Disposable implements IFacadeRunsService {

	declare readonly _serviceBrand: undefined;

	readonly whenRestored: Promise<void>;

	/** Every run this load of the window knows of, those kept by the load before it included, by `keyOf`. */
	private readonly _runs = new Map<string, IRunRecord>();

	/** Whether the window has every terminal it had back (`whenRestored`). */
	private _restored = false;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IStorageService private readonly _storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService
	) {
		super();

		for (const { workspace, id, nonce, processId } of readRuns(this._storageService.get(RUNS_STORAGE_KEY, StorageScope.WORKSPACE))) {
			const run = { workspace, id };
			this._runs.set(keyOf(run), { run, nonce, processId });
		}

		// ⚠️ Floating windows' terminals come back last: after the editor area's, with their windows
		this.whenRestored = Promise.all([this._terminalService.whenConnected, lifecycleService.when(LifecyclePhase.Eventually)]).then(() => {
			this._restored = true;
			this._save();
		});
		this.whenRestored.then(undefined, onUnexpectedError);

		this._register(this._terminalService.onDidDisposeInstance(instance => this._closed(instance)));

		// Kept as each change is made, as well: a window that crashes does not save its state as it goes
		this._register(this._storageService.onWillSaveState(() => this._save()));
	}

	register(instance: ITerminalInstance, run: IFacadeRun): void {
		const record: IRunRecord = { run, nonce: instance.shellIntegrationNonce, processId: instance.processId };
		this._runs.set(keyOf(run), record);

		// Its process could not start: the terminal has closed already
		if (instance.isDisposed) {
			record.end = { exitCode: instance.exitCode, byThePerson: false };
		} else if (record.processId === undefined) {
			instance.processReady.then(() => {
				if (record.processId === undefined && !instance.isDisposed) {
					record.processId = instance.processId;
					this._save();
				}
			}, () => { /* It did not start, and closes */ });
		}
		this._save();
	}

	terminalOf(run: IFacadeRun): ITerminalInstance | undefined {
		const record = this._runs.get(keyOf(run));
		const process = record ? this._processOf(record) : undefined;
		return process?.state === 'present' ? process.instance : undefined;
	}

	processes(workspace: string, ids?: readonly number[]): readonly (FacadeRunProcess & { readonly id: number })[] {
		const records = ids
			? ids.map(id => this._runs.get(keyOf({ workspace, id })) ?? { run: { workspace, id }, nonce: '', processId: undefined })
			: [...this._runs.values()].filter(record => record.run.workspace === workspace);
		return records.map(record => {
			const process = record.nonce ? this._processOf(record) : this._restored ? { state: 'gone' as const } : { state: 'unknown' as const };
			return process.state === 'present' ? { id: record.run.id, state: process.state } : { id: record.run.id, ...process };
		});
	}

	/** Where a run's own process is: in which terminal, or how it went. */
	private _processOf(record: IRunRecord): FacadeRunProcess & { readonly instance?: ITerminalInstance } {
		if (record.end) {
			return { state: 'gone', end: record.end };
		}
		if (record.leaving) {
			return { state: 'unknown' };
		}

		const instance = this._terminalService.instances.find(each => each.shellIntegrationNonce === record.nonce && !each.isDisposed);
		if (!instance) {
			return this._restored ? { state: 'gone' } : { state: 'unknown' };
		}

		// The process a reload reconnected to tells its id a moment later. One whose id was never told - the
		// window went before its first output - had not run long enough to be relaunched: kept with the next save.
		if (record.processId === undefined && instance.processId !== undefined) {
			record.processId = instance.processId;
		}
		if (instance.processId === undefined) {
			return record.processId === undefined ? { state: 'present', instance } : { state: 'unknown' };
		}
		if (instance.processId !== record.processId) {
			// Relaunched: the run's own process ended, unseen
			return { state: 'gone' };
		}
		if (instance.exitCode !== undefined) {
			// Ended, its terminal kept open to show how
			return { state: 'gone', end: { exitCode: instance.exitCode, byThePerson: false } };
		}
		return { state: 'present', instance };
	}

	/** A terminal closed: the end of the run whose own process it ran - unless it went with the window. */
	private _closed(instance: ITerminalInstance): void {
		const record = [...this._runs.values()].find(each => each.nonce === instance.shellIntegrationNonce && !each.end && !each.leaving);
		if (!record || (record.processId !== undefined && instance.processId !== undefined && instance.processId !== record.processId)) {
			return;
		}

		if (instance.exitReason === TerminalExitReason.Shutdown) {
			record.leaving = true;
		} else {
			record.end = { exitCode: instance.exitCode, byThePerson: instance.exitReason === TerminalExitReason.User && instance.exitCode === undefined };
		}
		this._save();
	}

	/** Keeps the runs whose processes may run on: not seen ending, and not found gone. */
	private _save(): void {
		const kept: IStoredRun[] = [];
		for (const record of this._runs.values()) {
			if (record.end || (this._restored && !record.leaving && this._processOf(record).state === 'gone')) {
				continue;
			}
			kept.push({ ...record.run, nonce: record.nonce, ...(record.processId !== undefined ? { processId: record.processId } : {}) });
		}

		if (kept.length) {
			this._storageService.store(RUNS_STORAGE_KEY, JSON.stringify(kept), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this._storageService.remove(RUNS_STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}
}

// ⚠️ Eager: made as the window starts, so that it sees every run's terminal close - before the agents'
// extension first asks after them, too.
registerSingleton(IFacadeRunsService, FacadeRunsService, InstantiationType.Eager);
