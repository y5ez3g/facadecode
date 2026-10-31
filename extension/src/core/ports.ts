/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The contracts between the core and its environment (ARCHITECTURE-1.3): the core decides, these ports act. Only plain data
// crosses them, so the core is tested with fakes and never imports vscode, sockets or a CLI's screen parser.

export interface Disposable {
	dispose(): void;
}

/** Subscribes `listener`; the returned disposable unsubscribes it. */
export type Event<T> = (listener: (value: T) => void) => Disposable;

/** One accepted launch, unique across the client network and never reassigned: `run-<32 hex>` (RULES-2.2). */
export type RunId = string;

/** A qualified execution location: `loc-<hash of environment and canonical path>` (RULES-2.4, WORKTREES-1.2). */
export type LocationId = string;

// ---------------------------------------------------------------------------------------------------------------------------
// Locations (WORKTREES-1)

export interface WorkspaceFolderInfo {
	readonly index: number;
	readonly name: string;
	/** The folder's URI as the editor has it, with any remote authority. */
	readonly uri: string;
	/** Its path in its execution environment. */
	readonly path: string;
}

export type GitState = 'none' | 'pending' | 'ok' | 'stale' | 'failed' | 'missing';

export interface Location {
	readonly id: LocationId;
	/** The execution path in its own environment, as opened (not canonicalized for display). */
	readonly path: string;
	/** The location's URI, keeping the window's remote authority (WORKTREES-3.1). */
	readonly uri: string;
	/** `local`, or the remote environment the window runs in. */
	readonly environment: string;
	/** Its branch, else its folder's name (WORKTREES-1.2). */
	readonly label: string;
	/** The workspace folders this location is associated with, first the one it is listed under. */
	readonly folders: readonly WorkspaceFolderInfo[];
	/** `folder`: an opened folder that is no Git checkout (or Git is unavailable); `checkout`: a Git checkout. */
	readonly kind: 'folder' | 'checkout';
	readonly isMain?: boolean;
	readonly branch?: string;
	readonly detached?: boolean;
	/** Whether this is the location a workspace folder opened (the first in its folder group). */
	readonly opened: boolean;
	readonly git: GitState;
}

export interface Catalog {
	/** Editor folder order; within a folder, the opened location first (WORKTREES-1.2). */
	readonly locations: readonly Location[];
	readonly folders: readonly WorkspaceFolderInfo[];
	/** Whether Git metadata is still being read for some folder; plain folders are always present. */
	readonly pending: boolean;
}

export interface LocationRemoval {
	readonly ids: readonly LocationId[];
	readonly cause: 'folder' | 'deleted';
}

export interface LocationPort {
	/** Returns at once; ordinary folders are always present, Git metadata follows (WORKTREES-1.1). */
	snapshot(): Catalog;
	resolve(id: LocationId): Location | undefined;
	/** Re-reads Git where needed; errors stay with the caller (WORKTREES-1.1, 1.3). */
	refresh(): Promise<void>;
	readonly onDidChange: Event<void>;
	/** Confirmed removal only: a workspace folder removed or a worktree confirmed deleted (RULES-2.4, S11). */
	readonly onDidRemove: Event<LocationRemoval>;
	/** Whether this session reported `id` removed: removals found as the host restarts can precede reattachment (RULES-2.4). */
	removalOf(id: LocationId): LocationRemoval['cause'] | undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------
// CLIs (CLIS-1, CLIS-3)

export interface CliChoice {
	/** API ID: `claude`. */
	readonly id: string;
	readonly displayName: string;
	/** Whether a new run can start: installed, enabled and validly configured in the destination environment. */
	readonly available: boolean;
	/** Why it cannot start, in English for agents and logs; the UI shows it with a way to the CLI's settings. */
	readonly problem?: string;
	/** The same, for the person's language (UX-2.4). */
	readonly said?: FacadeReason;
	/** A built-in that is simply not installed in this environment: New Agent does not list it (LIFECYCLE-1.1). */
	readonly notInstalled?: boolean;
}

export interface CliCatalogPort {
	/** Built-ins in CLIS-1.1 order, for `location`'s environment. */
	list(location: Location): Promise<readonly CliChoice[]>;
}

/** What the core asks the planner to start. */
export interface PlanRequest {
	readonly run: RunId;
	readonly alias: string;
	readonly name: string;
	readonly cli: string;
	readonly location: Location;
	readonly yolo: boolean;
}

/** A fully computed launch, made before any file or process exists (CLIS-4.2). */
export interface LaunchPlan {
	readonly cli: string;
	readonly displayName: string;
	/** The command name, which chooses the terminal's logo. */
	readonly command: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
	readonly cwd: string;
	/** How ptyd reads its status from its screen while it reports nothing, where its adapter names a reader (CLIS-2.3, D80). */
	readonly screenStatus?: string;
}

/** A reason Facade itself gives, by its kind and values, so that the person's language can say it (UX-2.4); the English is its message. */
export interface FacadeReason {
	readonly kind: string;
	readonly values: readonly string[];
}

/** A launch that cannot be planned: the actual configuration or prerequisite problem, before any effect (RULES-5.1). */
export class PlanError extends Error {
	constructor(message: string, readonly reason: 'configuration_invalid' | 'not_found' | 'unsupported' | 'unavailable', readonly said?: FacadeReason) {
		super(message);
	}
}

export interface LaunchPlanner {
	plan(request: PlanRequest): Promise<LaunchPlan>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Execution: the agent's editor terminal and its process, held by ptyd (ARCHITECTURE-2.3, LIFECYCLE-1.5, 2.2, 3.1)

/** What the terminal shows of a run, from acceptance on. */
export interface PairFacts {
	readonly run: RunId;
	readonly name: string;
	readonly cli: string;
	readonly displayName: string;
	readonly command: string;
	readonly cwd: string;
}

export type Activity = 'working' | 'not_working' | 'unknown';

/** What a run's CLI reports (CLIS-2.3), mapped to activity; `error` is a known error the CLI reported. */
export interface ActivityReport {
	readonly run: RunId;
	readonly activity: Activity;
	/** A native blocker the CLI reports, in its own words where it gives them. */
	readonly blocker?: { readonly kind: 'permission' | 'question' | 'auth'; readonly text?: string };
	/** Why activity is unknown or in error, for the card's second line. */
	readonly reason?: string;
	readonly error?: string;
	/** A missing supervisor connection is infrastructure uncertainty, independent of the CLI's activity. */
	readonly disconnected?: boolean;
	/** The CLI's own title, sanitized and capped at 300 code points. */
	readonly title?: string;
	/** Whether this run's CLI has proven it reports activity (S12). */
	readonly reporting: boolean;
	/** Its CLI has shown no activity yet, and its run is still starting: no later than its bound from its process start (CLIS-2.3, D81). */
	readonly awaitingActivity?: true;
}

export interface ExitReport {
	readonly run: RunId;
	readonly code?: number;
	readonly signal?: string;
	/** Whether the adapter verified an ordinary interrupt (for example the CLI's Ctrl+C handling) caused it (RULES-3.3). */
	readonly interruptVerified: boolean;
}

/** A run still held by ptyd for this workspace, found again after a reload (LIFECYCLE-3.5). */
export interface LiveRun {
	readonly run: RunId;
	/** What the window stored with the run when it started it. */
	readonly meta: RunMeta;
	readonly pid: number;
	readonly startedAt: number;
	readonly exited?: { readonly code?: number; readonly signal?: string; readonly interruptVerified: boolean };
	/** Whether another connected window of this workspace currently claims it. */
	readonly claimedElsewhere: boolean;
}

export type CleanupResult = 'terminated' | 'already_exited' | 'unconfirmed' | 'failed';

export interface ExecutionPort {
	/** Creates the run's editor terminal at once, before any process: the same terminal is used through startup (LIFECYCLE-1.5). */
	openPair(facts: PairFacts, options: { readonly reveal: boolean }): void;
	/** Writes a line of startup progress or failure into the run's terminal (UX-1.1: existing surfaces). */
	note(run: RunId, text: string): void;
	/** Starts the planned process in the run's existing terminal. Rejects with the actual error when it cannot. */
	spawn(run: RunId, plan: LaunchPlan, meta: RunMeta): Promise<{ readonly pid: number; readonly startedAt: number }>;
	/** Reattaches a live run's existing process to a new terminal after reload, without duplicating output. */
	attach(live: LiveRun, facts: PairFacts): Promise<void>;
	/** Stops further input, then ends the process in the background: graceful, then forced (LIFECYCLE-3.1). */
	terminate(run: RunId): Promise<CleanupResult>;
	/** Disposes the run's terminal at once (explicit close, normal exit, removal) and lets ptyd forget the run. */
	removePair(run: RunId): void;
	/** Shows the run's own terminal; false where it has none (LIFECYCLE-2.2). */
	reveal(run: RunId, options: { readonly preserveFocus: boolean }): Promise<boolean>;
	/** Opens a live run's terminal again after its tab was closed and the person kept the agent (LIFECYCLE-3.1). */
	reopen?(run: RunId): void;
	/** Updates the terminal's tab title for a renamed run (LIFECYCLE-2.2). */
	rename(run: RunId, name: string): void;
	/** Updates the meta ptyd keeps with a live run (name, location...). */
	setMeta(run: RunId, meta: RunMeta): void;
	/** The live runs ptyd holds for this workspace, after a reload (LIFECYCLE-3.5). */
	live(): Promise<readonly LiveRun[]>;
	/** Ends every run of this window: only on actual window closure evidence (RULES-4.1, ARCHITECTURE-2.2). */
	endWindow(): Promise<void>;
	readonly onDidReport: Event<ActivityReport>;
	readonly onDidExit: Event<ExitReport>;
	/** The run whose terminal is the active one, as the editor reports it; undefined when another editor/terminal is active. */
	readonly onDidActivate: Event<RunId | undefined>;
	/**
	 * The person renamed a run's terminal tab natively (LIFECYCLE-2.2), told by the run's own terminal: `name` as they gave it, without
	 * the separator and CLI title they kept. Whatever becomes of it, the tab then shows the agent's name.
	 */
	readonly onDidRenameTab?: Event<{ readonly run: RunId; readonly name: string }>;
	/** The person closed a run's terminal tab natively: a close they confirm for a live agent (LIFECYCLE-3.1). */
	readonly onDidClosePair?: Event<RunId>;
	/** A successor activation owns the workspace. Detach cards without closing or forgetting transferred runs. */
	readonly onDidLoseOwnership?: Event<void>;
}

/** What ptyd keeps with a run so a reloaded window can show it again. Plain JSON. */
export interface RunMeta {
	readonly alias: string;
	readonly name: string;
	readonly cli: string;
	readonly displayName: string;
	readonly command: string;
	readonly location: LocationId;
	readonly cwd: string;
	readonly environment: string;
	readonly yolo: boolean;
	readonly createdAt: number;
}

// ---------------------------------------------------------------------------------------------------------------------------
// New worktrees (WORKTREES-2)

export interface WorktreePlan {
	/** The selected source checkout (WORKTREES-2.1): its HEAD is the default base. */
	readonly source: LocationId;
	readonly branch: string;
	readonly baseRef: string;
	readonly baseCommit: string;
	/** `<main-folder>.worktrees/<branch-folder>`, with the next free numeric suffix (WORKTREES-2.2). */
	readonly destination: string;
}

/** Creation facts confirmed by Git/native results. Missing fields make no claim about unknown effects (WORKTREES-2.2). */
export interface WorktreeCreationEffects {
	readonly branch?: string;
	readonly folder?: string;
}

/** Why creation cannot start: `repository_required`, `commit_required`, `unavailable` (no native API), `invalid_argument`. */
export class WorktreeError extends Error {
	constructor(message: string, readonly reason: string, readonly effects: { readonly branchCreated?: boolean; readonly destinationCreated?: string } = {}) {
		super(message);
	}
}

export interface WorktreePort {
	/** Whether this location can get a new worktree here, and why not (UX-3.1 availability; WORKTREES-2.1). */
	availability(source: LocationId): Promise<{ readonly available: true } | { readonly available: false; readonly reason: string }>;
	/** Validates and proposes; no effect (WORKTREES-2.1, 2.2). */
	plan(source: LocationId, branch: string, baseRef?: string): Promise<WorktreePlan>;
	/** Creates through the editor's native Git API, then confirms with Git; partial effects are kept and reported (WORKTREES-2.2). */
	create(plan: WorktreePlan, stillWanted: () => boolean): Promise<Location>;
	/**
	 * Deletes a linked worktree that no workspace folder is in (WORKTREES-3.2, D73): refused with nothing touched where Git lists a
	 * change that is not committed or an untracked file; otherwise `closeAgents` - the agents launched there closed, their processes
	 * ended - then `git worktree remove` without `--force`. Its branch is kept.
	 */
	remove(id: LocationId, closeAgents: () => Promise<void>): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Runs as the core records them (RULES-2.2, 3.1)

/** Internal lifecycle (RULES-3.1); explicit close removes the run from the UI at once, whatever this says. */
export type Lifecycle = 'starting' | 'running' | 'ended';

/** The visible startup stage of an accepted launch (LIFECYCLE-1.5). */
export type Phase = 'creating_worktree' | 'launching_cli' | 'running';

export interface RunError {
	readonly reason: string;
	readonly worktree?: WorktreeCreationEffects;
	/** Where the error came from: `launch`, `cli`, `exit`, `activity`, `location`... */
	readonly source: string;
	readonly at: number;
}

export interface RunFacts {
	readonly id: RunId;
	/** `#aN` (LIFECYCLE-2.1); the number is unique in this environment until the client network allocates it (M4). */
	readonly alias: string;
	readonly name: string;
	readonly cli: string;
	readonly displayName: string;
	readonly command: string;
	readonly location: LocationId;
	readonly cwd: string;
	readonly environment: string;
	readonly yolo: boolean;
	readonly createdAt: number;
	readonly lifecycle: Lifecycle;
	readonly phase: Phase;
	readonly pid?: number;
	readonly startedAt?: number;
	readonly activity: Activity;
	readonly activityReason?: string;
	/** Whether the run's CLI proved it reports activity; without it activity is unknown, shown red (RULES-3.2). */
	readonly reporting: boolean;
	/** Its process started, its CLI has shown no activity yet: the run is still starting, green, within CLIS-2.3's bound (D81). */
	readonly awaitingActivity?: true;
	readonly blocker?: { readonly kind: 'permission' | 'question' | 'auth'; readonly text?: string };
	readonly title?: string;
	/** The unresolved error that makes the card red (RULES-3.2): launch failure, abnormal exit, reported error. */
	readonly error?: RunError;
	/** How the process ended, where it ended and the pair is retained (abnormal exit or failed launch, RULES-3.3). */
	readonly end?: { readonly kind: 'abnormal' | 'failed'; readonly code?: number; readonly signal?: string; readonly at: number };
}

export interface RunChange {
	readonly run: RunId;
	/** For `removed`: an exit removes after its process ended normally; a close or location removal at once (UX-2.2). */
	readonly cause?: 'exit' | 'close' | 'transfer';
	/** `added`, `removed` (pair gone), `lifecycle` (state/phase/error/end), `reported` (activity/title/blocker), `renamed`. */
	readonly kind: 'added' | 'removed' | 'lifecycle' | 'reported' | 'renamed';
}

// ---------------------------------------------------------------------------------------------------------------------------
// The person (RULES-1.8, UX-1.2)

/** A failure the core tells the person, as facts the window words in the person's language (UX-2.4). */
export type HumanFailure = { readonly kind: 'start'; readonly name: string; readonly reason: string; readonly worktree?: WorktreeCreationEffects };

export interface HumanPort {
	/** A human-operation error or a known failure with no responsible agent, in the related window only (RULES-1.8). */
	failed(failure: HumanFailure, options: { readonly show?: RunId; readonly configure?: boolean }): void;
	/** The same, for a human operation's error the UI has already worded. */
	error(text: string, options: { readonly show?: RunId; readonly configure?: boolean }): void;
	/**
	 * The person closed a live agent's terminal tab, alone or with other editors (LIFECYCLE-3.1): whether they confirm ending it. Tabs
	 * closed together are asked about once; the editor's `terminal.integrated.confirmOnKill` decides whether to ask at all.
	 */
	confirmClose?(agent: { readonly run: RunId; readonly label: string }): Promise<boolean>;
}

/** The person's last successful launch in this workspace (LIFECYCLE-1.2): written only once a human launch's CLI process starts. */
export interface LaunchHistoryPort {
	last(): { readonly location?: LocationId; readonly cli?: string };
	remember(location: LocationId, cli: string): void;
}

/** The window's lifetime evidence (RULES-4.1, ARCHITECTURE-2.2): `closed` only with demonstrated closure evidence. */
export interface WindowLifetimePort {
	readonly onDidClose: Event<void>;
}

/** Durable facts of runs that have no live process to remember them: failed launches retained red (LIFECYCLE-1.5). */
export interface RetainedStore {
	list(): readonly RunFacts[];
	put(run: RunFacts): void;
	remove(run: RunId): void;
}

/** Allocates `#aN` aliases, never reused in this environment (RULES-2.2); the client network replaces it in M4. */
export interface AliasPort {
	next(): string;
}

export interface Clock {
	now(): number;
}

export interface LogPort {
	/** One line of the agents log: UTC, safe references, no secrets or message text (ARCHITECTURE-3.3). */
	event(text: string): void;
}

// ---------------------------------------------------------------------------------------------------------------------------
// What the UI calls (LIFECYCLE-4.1: one launch service and one run record for every origin)

export interface LaunchRequest {
	readonly name: string;
	readonly location: LocationId;
	readonly cli: string;
	/** Create this new worktree from `location` first (WORKTREES-2.1); the launch runs in it. */
	readonly worktree?: { readonly branch: string; readonly baseRef?: string };
}

export interface Agents {
	/** Validates (all problems together) and, once accepted, creates the pair at once and returns its run ID (LIFECYCLE-1.5). */
	launch(request: LaunchRequest): RunId;
	/** Close Agent, the single close action for starting, live and retained runs: pair removed at once, cleanup in the background (LIFECYCLE-3.1). */
	close(run: RunId): Promise<CleanupResult | 'already_ended' | 'not_started'>;
	/** Renames a run's display label, trimming it and allowing an empty string (LIFECYCLE-2.1). */
	rename(run: RunId, name: string): void;
	list(): readonly RunFacts[];
	get(run: RunId): RunFacts | undefined;
	readonly onDidChange: Event<RunChange>;
}
