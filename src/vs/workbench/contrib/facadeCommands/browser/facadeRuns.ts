/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, disposableTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { GroupModelChangeKind } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { FolderTerminalEndReason, IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../terminal/common/terminalContextKey.js';
import { AGENT_RECORD_STORAGE_KEY, facadeRunOf, facadeRunTerminalOf, IFacadeRun, IPreparingRun, isFacadeRunTerminal, runFolderUri, setAgentRecordForAttach } from '../common/facadeRun.js';

/** How a run's own process ended, as this load of the window saw it end. */
export interface IFacadeRunEnd {
	/** The code it exited with, where known. */
	readonly exitCode?: number;

	/**
	 * Whether the person closed its terminal: closed for the user with no exit code, its process not ended
	 * before - but for its folder gone from the disk, which no one the window knows did. VS Code closes a
	 * terminal in the editor area whose process exited as if the user had, the process's code kept; one
	 * killed with no code, its tab closed after, ended by its process (C-WB-16).
	 */
	readonly byThePerson: boolean;

	/**
	 * Why it was closed, where it was not its tab that was closed: the person's deletion of its worktree (N-04), or
	 * removal of its folder from the workspace; or its folder gone from the disk (AGENT-LAUNCHER.md, L6).
	 */
	readonly reason?: FacadeRunCloseReason;
}

/**
 * What the window knows of a run's own process: `present` in one of its terminals, with its id once told -
 * which the agents' extension keeps for an agent it finds again (N-79); `gone` from every one of them and
 * from the pty host, with how it ended where this load of the window saw it end; `unknown`
 * while the window cannot tell - its terminals not all back yet, its record not said yet, its process's id
 * not told yet, its terminal going with the window, or its process still the pty host's for a window that went.
 */
export type FacadeRunProcess =
	| { readonly state: 'present'; readonly processId?: number }
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

	/**
	 * Says why the person's act is about to close `instance`, a run's terminal, where it is not its tab they
	 * close - their deletion of its worktree: its run's end says so (N-04).
	 */
	closingBecause(instance: ITerminalInstance, reason: FacadeRunClosingReason): void;

	/**
	 * The runs of the window's record that are live - starting, running or stopping - as the agents' extension
	 * last said: those with no terminal yet, their worktrees being made or set up, listed apart in `preparing`
	 * too; one that ended keeps its tab (X-51). Undefined until it has said, as while it is not running in the
	 * window.
	 */
	readonly live: IFacadeLiveRuns | undefined;
	readonly onDidChangeLive: Event<void>;

	/** What the agents' extension says is live now in its record `workspace`; `preparing`, those of them with no terminal yet. */
	setLive(workspace: string, ids: readonly number[], preparing: readonly IPreparingRun[]): void;
}

/** The live runs of the record `workspace`, as the agents' extension says them (`IFacadeRunsService.live`). */
export interface IFacadeLiveRuns {
	readonly workspace: string;
	/** Every one of them, by its number. */
	readonly ids: readonly number[];
	/** Those of them with no terminal yet: their worktrees being made or set up (L3). */
	readonly preparing: readonly IPreparingRun[];
}

/**
 * Why a run's terminal is closed, where it is not its tab the person closes: a code, the record's to word - the person's
 * deletion of its worktree, or why the folder terminals ended it: the person's removal of its folder from the workspace,
 * or its folder gone from the disk, by no one the window knows (AGENT-LAUNCHER.md, L6).
 */
export type FacadeRunCloseReason = 'worktreeDeleted' | FolderTerminalEndReason;

/** Why the person's act is about to close a run's terminal, as the window is told beforehand (`closingBecause`). */
type FacadeRunClosingReason = Extract<FacadeRunCloseReason, 'worktreeDeleted'>;

/** What this load of the window knows of a run beyond its terminal's mark. */
interface IRunRecord {
	readonly run: IFacadeRun;

	/** The terminal made for it in this load of the window. */
	made?: ITerminalInstance;

	/** Its own process's id, once the window has told it: on Windows, with the process's first output. */
	processId?: number;

	/** How its own process ended, once this load of the window saw it end. */
	end?: IFacadeRunEnd;

	/** Its process ended - its terminal kept open, say - whatever closes the terminal after: with its code, where it had one. */
	exited?: { readonly exitCode: number | undefined };

	/** Why the person's act is about to close its terminal, where it is not its tab they close. */
	closingBecause?: FacadeRunClosingReason;

	/** Set as its terminal goes with the window: whether its process comes back is the next load's to say. */
	leaving?: boolean;
}

/** How often the processes the pty host still runs for a window that went are looked at again. */
const TAKE_BACK_RETRY_MS = 2_000;

/** For how long: past the minute the pty host keeps an orphan for its window to come back. */
const TAKE_BACK_WAIT_MS = 90_000;

/**
 * How long the take-back waits for the editor parts, floating windows included, to be restored: within the
 * minute the pty host keeps an orphan for its window to come back.
 */
const EDITORS_WAIT_MS = 10_000;

/**
 * How long the take-back waits for the agents' extension to say the window's record: only its runs are
 * taken back, and warned about (REMOTE.md R7). Past it, with the extension silent, there is nothing to
 * take back, and a run not found is gone. Within what the extension waits for the window's terminals.
 */
const LIVE_WAIT_MS = 30_000;

/** How soon an agent's tab placed is kept: a moment on, once a move - out of one group, into another - is done. */
const KEEP_PLACE_MS = 1_000;

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
	/** The runs whose processes the pty host saw exit lately, by run, with their codes: while the window was away, reloading (N-14). */
	private readonly _exitedAway = new Map<string, number | undefined>();
	/** The take-back under way, which the next waits for. */
	private _takingBack: Promise<void> = Promise.resolve();
	/** What hears each run's process end, by its run, as long as its terminal is there. */
	private readonly _exits = this._register(new DisposableMap<string, DisposableStore>());

	/** Whether the window has every terminal it had back (`whenRestored`). */
	private _restored = false;

	/** Settled once the agents' extension has said the window's record (`setLive`). */
	private readonly _liveKnown = new DeferredPromise<void>();

	/**
	 * The runs of this workspace whose processes the pty host still runs for a window that went - one
	 * reloaded again before the pty host saw it go - by `keyOf`: neither present nor gone, until they are
	 * orphans the window takes back, or the pty host no longer has them.
	 */
	private readonly _elsewhere = new Set<string>();
	private readonly _retry = this._register(new MutableDisposable());

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@IFolderTerminalsService private readonly _folderTerminalsService: IFolderTerminalsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IStorageService private readonly _storageService: IStorageService
	) {
		super();

		// The record told last time, known synchronously at this start: attaching terminals are
		// decided with it until the agents' extension says this start's (REMOTE.md R7; RM-20)
		const remembered = this._storageService.get(AGENT_RECORD_STORAGE_KEY, StorageScope.WORKSPACE);
		if (remembered) {
			this._attachRecord.value = setAgentRecordForAttach(remembered);
		}

		// ⚠️ Floating windows' terminals come back last: after the editor area's, with their windows - once the
		// editor parts are restored, which no phase of the window's waits for. The agents whose processes outlived
		// a crashed window are taken back after that: one a floating window brought back is its, and one taken back
		// before opened in the main editor area, its floating window left empty (N-49; WIN-13). Not past a while, as
		// the pty host keeps an orphan for its window a minute only. Until they are taken back, one is not gone.
		const editorsRestored = new DeferredPromise<void>();
		editorGroupsService.whenRestored.then(() => editorsRestored.complete(), () => editorsRestored.complete());
		this._register(disposableTimeout(() => editorsRestored.complete(), EDITORS_WAIT_MS));
		// And after the window's record is known: only its runs are taken back, two windows on the same
		// workspace - two computers on the same remote folder - keeping their own (REMOTE.md R7). Past a
		// while, with the extension silent, there is nothing to take back.
		const liveKnown = new DeferredPromise<void>();
		this._liveKnown.p.then(() => liveKnown.complete(), () => liveKnown.complete());
		this._register(disposableTimeout(() => liveKnown.complete(), LIVE_WAIT_MS));
		this.whenRestored = Promise.all([this._terminalService.whenConnected, lifecycleService.when(LifecyclePhase.Eventually), editorsRestored.p, liveKnown.p])
			.then(() => this._takeBack())
			.then(() => this._learnExitsAway())
			.then(undefined, onUnexpectedError)
			.then(() => {
				this._restored = true;
				this._takeBackLater(Date.now() + TAKE_BACK_WAIT_MS);
			});

		this._register(this._terminalService.onDidDisposeInstance(instance => this._closed(instance)));

		// An agent's tab placed - opened in the editor area or a floating window, or moved - is kept now, not with
		// the window's next save a minute on: its process outlives a crash of the window, which then comes back
		// as it was last kept - its tab in a floating window made since in the main editor area (N-49; WIN-13)
		const keepPlaces = this._register(new RunOnceScheduler(() => this._storageService.flush().then(undefined, onUnexpectedError), KEEP_PLACE_MS));
		this._register(editorService.onDidEditorsChange(({ event }) => {
			if ((event.kind === GroupModelChangeKind.EDITOR_OPEN || event.kind === GroupModelChangeKind.EDITOR_MOVE || event.kind === GroupModelChangeKind.EDITOR_CLOSE) && isFacadeRunTerminal(this._terminalService.getInstanceFromResource(event.editor?.resource))) {
				keepPlaces.schedule();
			}
		}));

		// What the active terminal's actions offer depends on it
		const isRun = TerminalContextKeys.facadeRun.bindTo(contextKeyService);
		const refresh = () => isRun.set(isFacadeRunTerminal(this._terminalService.activeInstance));
		this._register(this._terminalService.onDidChangeActiveInstance(refresh));
		refresh();
	}

	register(instance: ITerminalInstance, run: IFacadeRun): void {
		const record: IRunRecord = { run, made: instance, processId: instance.processId };
		this._runs.set(keyOf(run), record);

		// Its process ending is its end, whoever closes its terminal after - the person closing a tab kept open
		// once its CLI was killed does not stop it (C-WB-16; X-40)
		if (!instance.isDisposed) {
			const key = keyOf(run);
			const store = new DisposableStore();
			store.add(instance.onExit(code => {
				record.exited ??= { exitCode: typeof code === 'number' ? code : instance.exitCode };
			}));
			store.add(instance.onDisposed(() => this._exits.deleteAndDispose(key)));
			this._exits.set(key, store);
		}

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

	private _live: IFacadeLiveRuns | undefined;
	private readonly _onDidChangeLive = this._register(new Emitter<void>());
	readonly onDidChangeLive = this._onDidChangeLive.event;

	/** What answers the window's record for an attaching terminal while this load of the window has one (`setLive`). */
	private readonly _attachRecord = this._register(new MutableDisposable());

	get live(): IFacadeLiveRuns | undefined {
		return this._live;
	}

	setLive(workspace: string, ids: readonly number[], preparing: readonly IPreparingRun[]): void {
		const known = this._live?.workspace === workspace;
		this._live = { workspace, ids: [...ids], preparing: [...preparing] };
		this._liveKnown.complete();
		this._attachRecord.value = setAgentRecordForAttach(workspace);
		// Remembered for the next start: layout restore decides with it before the extension says the record (RM-20)
		this._storageService.store(AGENT_RECORD_STORAGE_KEY, workspace, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChangeLive.fire();
		// The window's record known now: its runs from before the window became a workspace are taken back too (X-31)
		if (!known) {
			this.whenRestored.then(() => this._store.isDisposed ? undefined : this._takeBack().then(() => this._learnExitsAway())).then(undefined, onUnexpectedError);
		}
	}

	closingBecause(instance: ITerminalInstance, reason: FacadeRunClosingReason): void {
		const run = facadeRunOf(instance);
		if (run) {
			const record = this._runs.get(keyOf(run)) ?? { run };
			record.closingBecause = reason;
			this._runs.set(keyOf(run), record);
		}
	}

	terminalOf(run: IFacadeRun): ITerminalInstance | undefined {
		const found = this._processOf(run);
		return found.state === 'present' ? found.instance : undefined;
	}

	processes(workspace: string, ids?: readonly number[]): readonly (FacadeRunProcess & { readonly id: number })[] {
		return (ids ?? this._idsOf(workspace)).map(id => {
			const found = this._processOf({ workspace, id });
			// A run's process, by the terminal that has it: a record that never heard of it takes it from here (N-79)
			const processId = found.state === 'present' ? found.instance?.processId : undefined;
			return found.state === 'gone' ? { id, state: found.state, ...(found.end ? { end: found.end } : {}) } : found.state === 'present' && processId !== undefined ? { id, state: found.state, processId } : { id, state: found.state };
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
			// Its terminal closed as the window came back, its process gone: how it exited is the pty host's (N-14, N-15)
			const away = known.end.exitCode === undefined && !known.end.byThePerson ? this._exitedAway.get(keyOf(run)) : undefined;
			if (away === undefined && known.end.exitCode === undefined && !known.end.byThePerson && !this._restored) {
				// Not known yet: the window has not asked the pty host how its processes ended while it was away (N-51)
				return { state: 'unknown' };
			}
			return { state: 'gone', end: away !== undefined ? { ...known.end, exitCode: away } : known.end };
		}
		if (known?.leaving) {
			return { state: 'unknown' };
		}

		const instance = this._terminalService.instances.find(each => !each.isDisposed && isMadeFor(each, run));
		if (!instance) {
			// The window's record not said yet: nothing taken back, and a run not found is not gone (REMOTE.md R7)
			if (!this._restored || !this._live || this._elsewhere.has(keyOf(run))) {
				return { state: 'unknown' };
			}
			// Exited while the window was away, as the pty host saw it: how is known (N-14)
			return this._exitedAway.has(keyOf(run)) ? { state: 'gone', end: { exitCode: this._exitedAway.get(keyOf(run)), byThePerson: false } } : { state: 'gone' };
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
			// A terminal that came back for a process that had ended meanwhile never had it: closing it stops no
			// agent, and how that one ended is the pty host's to say (N-51; REC-07)
			const neverAttached = instance.processId === undefined && instance.shellLaunchConfig.attachPersistentProcess !== undefined;
			const closed = !neverAttached && record.exited === undefined && instance.exitReason === TerminalExitReason.User && instance.exitCode === undefined;
			// Why, where it was not its tab that was closed: the person's deletion of its worktree, the folder terminals
			// ending it as its folder left the workspace - the person's act - or as its folder went from the disk, by no
			// one the window knows (AGENT-LAUNCHER.md, L6)
			const reason = closed ? record.closingBecause ?? this._folderTerminalsService.endedBecause(instance) : undefined;
			const byThePerson = closed && reason !== 'folderGone';
			record.end = { exitCode: record.exited?.exitCode ?? instance.exitCode, byThePerson, ...(reason ? { reason } : {}) };
		}
	}

	/**
	 * Takes back the runs of this window's record whose processes the pty host still runs for no window:
	 * those of a window that crashed, reopened as a new window, which brings no agent's terminal back
	 * itself (`isAgentGoneAtStartup`). One the pty host revived after a restart of the app has no process
	 * yet, and is never started: it would run its agent's CLI again. Another window's - another record's,
	 * two computers on the same remote folder sharing the workspace's id - are that window's (REMOTE.md R7).
	 */
	private _takeBack(): Promise<void> {
		// One at a time: two looking at once would each take back the same process
		const next = this._takingBack.then(() => this._takeBackNow());
		this._takingBack = next.then(undefined, () => undefined);
		return next;
	}

	private async _takeBackNow(): Promise<void> {
		const backend = await this._terminalInstanceService.getBackend(this._environmentService.remoteAuthority);
		// Every persistent process, not only the orphans: one a window that just went had taken back is not an
		// orphan until the pty host sees that window gone, and gone it is not - it runs, cut off
		const elsewhere = new Set<string>();
		for (const details of await backend?.listProcesses({ attached: true }) ?? []) {
			const run = facadeRunOf(details);
			// Only this window's record's: a folder window become a workspace keeps it, and only it (X-31)
			const ours = run !== undefined && this._live?.workspace === run.workspace;
			// One that ended here - its tab closed by the person before it reconnected - is not brought back (N-54)
			if (this._store.isDisposed || !run || !ours || details.pid <= 0 || this._processOf(run).state === 'present' || this._runs.get(keyOf(run))?.end) {
				continue;
			}
			// Not this window's yet, or this window's already: a terminal made for it - one the editor area brought back
			// after a crash, reconnecting - is its tab, and a second taken back for the same process doubled it (N-54).
			// Either is looked at again a moment later: an orphan whose tab did not come back is taken back then.
			if (!details.isOrphan || this._terminalService.instances.some(each => !each.isDisposed && isMadeFor(each, run))) {
				elsewhere.add(keyOf(run));
				continue;
			}
			this._elsewhere.delete(keyOf(run));
			this._logService.info(`[facadeRuns] Taking back ${keyOf(run)}; its process ${details.pid} is still running`);
			// As it was opened: its name, read as an agent's tab reads it, and held for the run's folder, not where
			// its process went since (X-31)
			const opened = facadeRunTerminalOf(details);
			await this._folderTerminalsService.openFor(runFolderUri(opened?.folder ?? details.cwd, this._environmentService.remoteAuthority), {
				attachPersistentProcess: details,
				...(opened?.name ? { name: opened.name, titleTemplate: `\${sequence}\${separator}${opened.name}` } : {})
			});
		}
		this._elsewhere.clear();
		elsewhere.forEach(key => this._elsewhere.add(key));
	}

	/**
	 * Learns which runs of this window's record the pty host saw exit lately - while the window was away,
	 * reloading - and how: the agent's end is its exit, with its code, not a process gone unseen (L12: a
	 * known exit is recorded; N-14).
	 */
	private async _learnExitsAway(): Promise<void> {
		const backend = await this._terminalInstanceService.getBackend(this._environmentService.remoteAuthority);
		for (const details of await backend?.listProcesses({ exited: true }) ?? []) {
			const run = facadeRunOf(details);
			if (run && this._live?.workspace === run.workspace) {
				this._exitedAway.set(keyOf(run), details.exitCode);
			}
		}
	}

	/**
	 * Takes back, as they become orphans, the runs whose processes the pty host still ran for a window that
	 * went, asking again a while apart - for longer than the pty host keeps an orphan before it ends it -
	 * until it no longer has any of them.
	 */
	private _takeBackLater(deadline: number): void {
		if (!this._elsewhere.size || this._store.isDisposed) {
			return;
		}
		if (Date.now() > deadline) {
			this._logService.warn(`[facadeRuns] Still held by the pty host for a closed window: ${[...this._elsewhere].join(', ')}`);
			this._elsewhere.clear();
			return;
		}
		this._retry.value = disposableTimeout(() => {
			this._takeBack().then(() => this._takeBackLater(deadline), onUnexpectedError);
		}, TAKE_BACK_RETRY_MS);
	}
}

registerSingleton(IFacadeRunsService, FacadeRunsService, InstantiationType.Eager);

/**
 * Makes the runs service as the window starts. `Eager` alone makes a service only with the first that
 * depends on it, here the agents' extension's first command: with the extension not running in the window
 * - another window has the workspace's agents, or its start failed - no run would be taken back after a
 * reload, and the pty host would end each held in the background after its minute; and a run's terminal
 * that closed before that command would go unseen.
 */
class FacadeRunsStarter implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.facadeRuns';

	constructor(@IFacadeRunsService _runs: IFacadeRunsService) { }
}

registerWorkbenchContribution2(FacadeRunsStarter.ID, FacadeRunsStarter, WorkbenchPhase.BlockRestore);
