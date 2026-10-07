/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { facadeRunOf, IFacadeRun, isFacadeRunTerminal } from '../common/facadeRun.js';

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

export const IFacadeRunsService = createDecorator<IFacadeRunsService>('facadeRunsService');

/**
 * The agents' runs the window holds. A terminal made for a run is marked with it (`facadeRunProperties`),
 * and the pty host keeps the mark with the terminal's process: a reload, a window that crashed and was
 * reopened, and a move within the window find it there, whatever the terminal's title. A run's own process
 * is the one its terminal started for it, or the one the terminal reconnected to after a reload: a new
 * process in that terminal - relaunched - is none of the run's, and neither is a terminal split from it.
 */
export interface IFacadeRunsService {
	readonly _serviceBrand: undefined;

	/**
	 * Settles once the window has every terminal it had back: reconnected to their processes, those of the
	 * editor area and of floating windows restored. Until then a run not found may still be coming.
	 */
	readonly whenRestored: Promise<void>;

	/** Notes the terminal just made for `run`, marked with it: the process it starts now is the run's own. */
	register(instance: ITerminalInstance, run: IFacadeRun): void;

	/** The terminal the run's own process runs in; undefined for none. */
	terminalOf(run: IFacadeRun): ITerminalInstance | undefined;

	/**
	 * What the window knows of the own processes of `workspace`'s runs: of those numbered `ids`, in their
	 * order, or of every one it knows of. A run it does not have is gone once its terminals are all back.
	 */
	processes(workspace: string, ids?: readonly number[]): readonly (FacadeRunProcess & { readonly id: number })[];
}

/** What this load of the window knows of a run beyond its terminal's mark. */
interface IRunRecord {
	readonly run: IFacadeRun;

	/** The terminal made for it in this load of the window. */
	made?: ITerminalInstance;

	/** Its own process's id, once the window has told it: on Windows, with the process's first output. */
	processId?: number;

	/** How its own process ended, once this load of the window saw it end. */
	end?: IFacadeRunEnd;

	/** Set as its terminal goes with the window: whether its process comes back is the next load's to say. */
	leaving?: boolean;
}

/** The key a run is known by. */
function keyOf(run: IFacadeRun): string {
	return `${run.workspace}#${run.id}`;
}

/** Whether a terminal is marked as made for `run`. */
function isMadeFor(instance: ITerminalInstance, run: IFacadeRun): boolean {
	const its = facadeRunOf(instance);
	return its?.workspace === run.workspace && its.id === run.id;
}

export class FacadeRunsService extends Disposable implements IFacadeRunsService {

	declare readonly _serviceBrand: undefined;

	readonly whenRestored: Promise<void>;

	/** The runs this load of the window has seen, by `keyOf`. */
	private readonly _runs = new Map<string, IRunRecord>();

	/** Whether the window has every terminal it had back (`whenRestored`). */
	private _restored = false;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@IFolderTerminalsService private readonly _folderTerminalsService: IFolderTerminalsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService
	) {
		super();

		// ⚠️ Floating windows' terminals come back last: after the editor area's, with their windows
		this.whenRestored = Promise.all([this._terminalService.whenConnected, lifecycleService.when(LifecyclePhase.Eventually)]).then(() => {
			this._restored = true;
		});
		this.whenRestored.then(() => this._takeBack()).then(undefined, onUnexpectedError);

		this._register(this._terminalService.onDidDisposeInstance(instance => this._closed(instance)));

		// What the active terminal's actions offer depends on it
		const isRun = TerminalContextKeys.facadeRun.bindTo(contextKeyService);
		const refresh = () => isRun.set(isFacadeRunTerminal(this._terminalService.activeInstance));
		this._register(this._terminalService.onDidChangeActiveInstance(refresh));
		refresh();
	}

	register(instance: ITerminalInstance, run: IFacadeRun): void {
		const record: IRunRecord = { run, made: instance, processId: instance.processId };
		this._runs.set(keyOf(run), record);

		// Its process could not start: the terminal has closed already
		if (instance.isDisposed) {
			record.end = { exitCode: instance.exitCode, byThePerson: false };
		} else if (record.processId === undefined) {
			instance.processReady.then(() => {
				if (record.processId === undefined && !instance.isDisposed) {
					record.processId = instance.processId;
				}
			}, () => { /* It did not start, and closes */ });
		}
	}

	terminalOf(run: IFacadeRun): ITerminalInstance | undefined {
		const found = this._processOf(run);
		return found.state === 'present' ? found.instance : undefined;
	}

	processes(workspace: string, ids?: readonly number[]): readonly (FacadeRunProcess & { readonly id: number })[] {
		return (ids ?? this._idsOf(workspace)).map(id => {
			const found = this._processOf({ workspace, id });
			return found.state === 'gone' ? { id, state: found.state, ...(found.end ? { end: found.end } : {}) } : { id, state: found.state };
		});
	}

	/** The numbers of `workspace`'s runs this load of the window knows of: those it saw, and those whose terminals it has. */
	private _idsOf(workspace: string): number[] {
		const ids = new Set<number>();
		for (const { run } of this._runs.values()) {
			if (run.workspace === workspace) {
				ids.add(run.id);
			}
		}
		for (const instance of this._terminalService.instances) {
			const run = facadeRunOf(instance);
			if (run?.workspace === workspace) {
				ids.add(run.id);
			}
		}
		return [...ids].sort((a, b) => a - b);
	}

	/** Where a run's own process is: in which terminal, or how it went. */
	private _processOf(run: IFacadeRun): FacadeRunProcess & { readonly instance?: ITerminalInstance } {
		const known = this._runs.get(keyOf(run));
		if (known?.end) {
			return { state: 'gone', end: known.end };
		}
		if (known?.leaving) {
			return { state: 'unknown' };
		}

		const instance = this._terminalService.instances.find(each => !each.isDisposed && isMadeFor(each, run));
		if (!instance) {
			return this._restored ? { state: 'gone' } : { state: 'unknown' };
		}
		if (instance.processId === undefined) {
			// Made here, its process has not told its id yet; reconnected after a reload, its id comes a moment
			// after its terminal
			return instance === known?.made ? { state: 'present', instance } : { state: 'unknown' };
		}

		// The process a terminal reconnected to after a reload is its run's own: the first one seen in it
		const record = known ?? { run };
		this._runs.set(keyOf(run), record);
		record.processId ??= instance.processId;
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
		const run = facadeRunOf(instance);
		if (!run) {
			return;
		}
		const record = this._runs.get(keyOf(run)) ?? { run };
		if (record.end || record.leaving || (record.processId !== undefined && instance.processId !== undefined && instance.processId !== record.processId)) {
			return;
		}

		this._runs.set(keyOf(run), record);
		if (instance.exitReason === TerminalExitReason.Shutdown) {
			record.leaving = true;
		} else {
			record.end = { exitCode: instance.exitCode, byThePerson: instance.exitReason === TerminalExitReason.User && instance.exitCode === undefined };
		}
	}

	/**
	 * Takes back the runs of this workspace whose processes the pty host still runs for no window: those of
	 * a window that crashed, reopened as a new window, which brings no agent's terminal back itself
	 * (`isAgentGoneAtStartup`). One the pty host revived after a restart of the app has no process yet, and
	 * is never started: it would run its agent's CLI again. Another workspace's are that workspace's window's.
	 */
	private async _takeBack(): Promise<void> {
		const backend = await this._terminalInstanceService.getBackend();
		const workspaceId = this._workspaceContextService.getWorkspace().id;
		for (const details of await backend?.listProcesses() ?? []) {
			const run = facadeRunOf(details);
			if (this._store.isDisposed || !run || details.workspaceId !== workspaceId || details.pid <= 0 || this._processOf(run).state === 'present') {
				continue;
			}
			this._logService.info(`[facadeRuns] taking back ${keyOf(run)}, its process ${details.pid} still running`);
			await this._folderTerminalsService.openFor(URI.file(details.cwd), { attachPersistentProcess: details });
		}
	}
}

// ⚠️ Eager: made as the window starts, so that it sees every run's terminal close - before the agents'
// extension first asks after them, too.
registerSingleton(IFacadeRunsService, FacadeRunsService, InstantiationType.Eager);
