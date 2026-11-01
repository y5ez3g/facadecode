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
	/** Validates a conversation cwd inside this window, without changing successful-launch history. */
	conversationLocation?(cwd: string): Location | undefined;
	rememberLocation?(cwd: string): LocationId | undefined;
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

/**
 * What New Agent offers for a location (CLIS-1.1, 3.4): its CLIs, and the configuration errors no CLI stands for - `facade.custom`
 * wrong as a whole, or a key that cannot be a custom CLI's ID - said apart, with the way to the settings.
 */
export interface CliChoices {
	readonly clis: readonly CliChoice[];
	/** Each by the setting it is in, its English for agents and logs, and the same for the person's language (UX-2.4). */
	readonly problems: readonly { readonly setting: string; readonly problem: string; readonly said?: FacadeReason }[];
}

export interface CliCatalogPort {
	/** Built-ins in CLIS-1.1 order, then custom CLIs, for `location`'s environment; and what no CLI stands for. */
	list(location: Location): Promise<CliChoices>;
}

/** What the core asks the planner to start. */
export interface PlanRequest {
	readonly run: RunId;
	readonly alias: string;
	readonly name: string;
	readonly cli: string;
	readonly location: Location;
	readonly yolo: boolean;
	readonly resume?: { readonly sessionId: string };
	/** This start's own model and effort, over the configured launch arguments (CLIS-1.4). */
	readonly model?: string;
	readonly effort?: string;
	/** The creation prompt, given natively where the CLI's adapter maps one (COLLABORATION-2.2). */
	readonly prompt?: string;
	/** The run's MCP shim, where orchestration is on for this start; absent, nothing is injected (RULES-4.4, CLIS-2.2). */
	readonly tools?: McpServerLaunch;
}

/** An MCP stdio server as a CLI's configuration names it (MCP-6.1). */
export interface McpServerLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

/**
 * Why an agent runs without its Facade tools, as the card says it in plain words (PANEL-1.4): its CLI starts through cmd.exe, which
 * cannot take their arguments; the files they need could not be written; or its folder holds another `facade` skill or server.
 */
/**
 * Why a run has no Facade tools, for the person's words (CLIS-2.2): its CLI runs through cmd.exe, its files could not be written, a
 * file of the person's is in the way, or a variable of theirs the tools' would go on could not be read.
 */
export type ToolsProblem = 'cmd' | 'files' | 'conflict' | 'variable' | 'disconnected';

/** A capability as an adapter stands behind it (CLIS-2.1). */
export interface CapabilityState {
	readonly state: 'supported' | 'unavailable' | 'unverified';
	readonly reason: string;
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
	/** The CLI's installed version where its installation says it: a diagnostic, never a gate (CLIS-2.1). */
	readonly version?: string;
	readonly model?: string;
	readonly effort?: string;
	/** Whether the Facade MCP server was injected, and why not where it could not be (CLIS-2.2), by kind for the person's words. */
	readonly tools: { readonly state: 'injected' | 'not_injected' | 'unavailable'; readonly reason?: string; readonly problem?: ToolsProblem; readonly file?: string };
	/** How a requested creation prompt goes in: in the invocation, or as the first message once the process starts. */
	readonly prompt?: { readonly path: 'native' | 'post_start'; readonly capability: CapabilityState };
	/**
	 * The input reader of the run's ordinary-message input (CLIS-2.1): it recognizes the input by its layout, whatever the CLI's
	 * version. A CLI without one is never typed a message into.
	 */
	readonly input: { readonly adapter?: string; readonly capability: CapabilityState };
	/** How ptyd reads its status from its screen while it reports nothing, where its adapter names a reader (CLIS-2.3, D80). */
	readonly screenStatus?: string;
	readonly sessionId?: string;
	/** Whether a run can keep identifying its exact conversation, including after native session changes. */
	readonly exactResume?: boolean;
	/**
	 * What its start types before its first turn (COLLABORATION-2.2): `text` into its empty input, Enter once its screen shows `typed`,
	 * then `close` once it shows `ready`, while it shows `opened` - regular expressions' sources - where its first turn could not use
	 * the Facade tools otherwise.
	 */
	readonly warmUp?: { readonly text: string; readonly typed: string; readonly ready: string; readonly opened: string; readonly close: string };
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
	/** The run ended or was closed: its injected files and project references go (CLIS-2.2). */
	release(run: RunId): Promise<void>;
	/** References of runs no longer alive are released, as after a window that ended without releasing them. */
	reconcile(alive: readonly RunId[]): Promise<void>;
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
	readonly onDidIdentify?: Event<{ readonly run: RunId; readonly sessionId: string | null; readonly cwd?: string }>;
	readonly onDidPinTab?: Event<{ readonly run: RunId; readonly pinned: boolean }>;
	pinTab?(run: RunId, pinned: boolean): void;
	conversations?(): Promise<readonly ConversationKey[]>;
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
	/** A run's MCP shim connected: its tools are available (CLIS-2.2). */
	readonly onDidConnectTools?: Event<RunId>;
	/** No MCP shim of a run is connected any more: its tools are unavailable (RULES-3.1). */
	readonly onDidDisconnectTools?: Event<RunId>;
}

/** What ptyd keeps with a run so a reloaded window can show it again. Plain JSON. */
export interface RunMeta {
	/** Link to durable intent; validated against the workspace's saved Pins on reattachment. */
	readonly pin?: string;
	readonly sessionId?: string;
	readonly exactResume?: boolean;
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
	/** Its creation tree's root, and the agent that started it where an agent did (RULES-2.2). Absent, it is a root of its own. */
	readonly root?: RunId;
	readonly creator?: RunId;
	readonly creatorLabel?: string;
	readonly origin?: 'human' | 'agent';
	/** The creator's request ID for its start, where it gave one (MCP-1.1, D110). */
	readonly requestId?: string;
	readonly model?: string;
	readonly effort?: string;
	readonly version?: string;
	/** Whether the Facade MCP server was injected and has connected, kept across a reload. */
	readonly tools?: RunFacts['tools'];
	readonly toolsReason?: string;
	readonly toolsProblem?: ToolsProblem;
	readonly toolsFile?: string;
	readonly promptLine?: string;
	/** Its ordinary-message input as its launch planned it, kept across a reload. */
	readonly inputAdapter?: string;
	readonly inputCapability?: CapabilityState;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Conversations (RULES-2.2, 4.2; CLIS-2.4; LIFECYCLE-3.2, 3.3)

/** A conversation's identity: its execution environment, CLI and the vendor's exact session ID (RULES-2.2). */
export interface ConversationKey {
	readonly environment: string;
	readonly cli: string;
	readonly sessionId: string;
}

export function conversationId(key: ConversationKey): string {
	return `${key.environment}\u0000${key.cli}\u0000${key.sessionId}`;
}

/** One vendor conversation the Resume picker lists: list metadata only (LIFECYCLE-3.2). */
export interface ConversationEntry {
	readonly key: ConversationKey;
	readonly title?: string;
	/** The conversation's original working directory in its environment. */
	readonly cwd: string;
	/** A vendor workspace set with no original cwd: the person must choose before Resume (LIFECYCLE-3.2). */
	readonly cwdChoices?: readonly string[];
	/** Last activity, in milliseconds since 1970, where known. */
	readonly activityAt?: number;
	/** Why it cannot be resumed, when it cannot (missing CLI, unsupported exact resume...). */
	readonly unavailable?: string;
}

/** A Resume picker session: batches of 100, recent first, with metadata read once and reused (LIFECYCLE-3.2, D35). */
export interface ConversationPager extends Disposable {
	/** The next batch, or `done` once every relevant store is exhausted; never silently stops at a scan limit. */
	next(): Promise<{ readonly entries: readonly ConversationEntry[]; readonly done: boolean }>;
}

export interface ConversationDiscoveryPort {
	/** Vendor histories for these directories and their subdirectories (LIFECYCLE-3.2): the window's locations. */
	open(scope: { readonly environment: string; readonly directories: readonly string[] }): ConversationPager;
}

/** What Facade keeps of its own conversations so Resume/Pin restore their place and name (RULES-4.2, ARCHITECTURE-3.1). */
export interface ConversationMeta {
	readonly location?: LocationId;
	readonly cwd: string;
	readonly name: string;
}

export interface ConversationStore {
	get(key: ConversationKey): ConversationMeta | undefined;
	put(key: ConversationKey, meta: ConversationMeta): void;
}

/** Saved intent to restore an exact conversation in this workspace (RULES-2.2, 4.2; LIFECYCLE-3.4). */
export interface Pin {
	/** `pin-<hex>`: identifies the Pin across runs; the panel orders the Pin area by it (PANEL-2.1). */
	readonly id: string;
	readonly conversation: ConversationKey;
	readonly location: LocationId;
	readonly cwd: string;
	readonly name: string;
}

/** Pins in workspace storage, in their saved order (ARCHITECTURE-3.1). */
export interface PinStore {
	list(): readonly Pin[];
	save(pin: Pin): void;
	remove(id: string): void;
	/** Saves the Pin area's order, top first. */
	reorder(ids: readonly string[]): void;
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
	 * change that is not committed or an untracked file, or another worktree is inside it; otherwise `closeAgents` - the agents
	 * launched there closed, true once all their processes are known to have ended - then a second check and `git worktree remove`
	 * without `--force`. Its branch is kept.
	 */
	remove(id: LocationId, closeAgents: () => Promise<boolean>): Promise<void>;
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
	readonly sessionId?: string;
	readonly resumable?: boolean;
	readonly pin?: string;
	readonly id: RunId;
	/** `#aN` (LIFECYCLE-2.1, RULES-2.3): unique across the client network and never reassigned. */
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
	/** Epoch ms its CLI's report of its current activity came: how long ago it said so, never that it still does (RULES-3.2). */
	readonly activitySince?: number;
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
	/** Its creation tree: the person's agent it comes from, and the agent that started it where an agent did (RULES-2.2, 4.3). */
	readonly root: RunId;
	readonly creator?: RunId;
	/** The creator's reference as its window named it at the start, `@name #aN`: what the card's hover says started it (PANEL-1.5). */
	readonly creatorLabel?: string;
	readonly origin: 'human' | 'agent';
	/** The request ID its creator gave the start: the same one again answers this run, never another start (MCP-1.1, D110). */
	readonly requestId?: string;
	/** The model and effort this start asked for, where it asked (CLIS-1.4). */
	readonly model?: string;
	readonly effort?: string;
	/** Its CLI's installed version, where the installation says it: shown in diagnostics only (CLIS-2.1). */
	readonly version?: string;
	/** Tool connection axis (RULES-3.1): injected and connecting, connected, failed to inject, or none injected (CLIS-2.2). */
	readonly tools: 'connecting' | 'available' | 'unavailable' | 'not_injected';
	/** Why the Facade tools could not be injected, where they could not: the CLI runs without them. English, for agents and the log. */
	readonly toolsReason?: string;
	/** The same, by kind, for the person's words (PANEL-1.4). */
	readonly toolsProblem?: ToolsProblem;
	/** For a conflict, the folder's file Facade would not overwrite, relative to its folder: what the person moves or renames. */
	readonly toolsFile?: string;
	/** The first line of an agent's creation prompt, for the card's hover (PANEL-1.5). */
	readonly promptLine?: string;
	/** The input reader of its ordinary-message input, as its launch planned it (CLIS-2.1). */
	readonly inputAdapter?: string;
	/** Whether Facade can read that input, and why not; none before its launch is planned. */
	readonly inputCapability?: CapabilityState;
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
export type HumanFailure = { readonly kind: 'restore'; readonly name: string; readonly reason: string; readonly count: number; readonly worktree?: never }
	| { readonly kind: 'pin'; readonly name: string; readonly reason: string; readonly worktree?: never }
	| { readonly kind: 'start'; readonly name: string; readonly reason: string; readonly worktree?: WorktreeCreationEffects };

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

/** Request-bearing run metadata can remain without a visible pair until its request ID expires (MCP-1.1). */
export type RetainedRun = RunFacts & { readonly requestOnly?: true };

/** Durable run metadata: failed launches retained red, or request-bearing records without a pair. */
export interface RetainedStore {
	list(): readonly RetainedRun[];
	put(run: RetainedRun): void;
	remove(run: RunId): void;
}

/** Allocates `#aN` aliases, unique across the client network and never reused (RULES-2.2). */
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
// What the UI and the tools call (LIFECYCLE-4.1: one launch service and one run record for every origin)

export interface LaunchRequest {
	readonly name: string;
	readonly location: LocationId;
	readonly cli: string;
	/** Create this new worktree from `location` first (WORKTREES-2.1); the launch runs in it. */
	readonly worktree?: { readonly branch: string; readonly baseRef?: string };
	readonly model?: string;
	readonly effort?: string;
	/**
	 * Who starts it. The person's start shows its terminal; an agent's start opens it in the background (LIFECYCLE-2.2) and joins the
	 * calling agent's creation tree - `creator` and its `root`, from whichever window the caller is in (RULES-4.3, COLLABORATION-1.1).
	 */
	readonly origin: 'human' | 'agent';
	readonly creator?: { readonly run: RunId; readonly root: RunId; readonly label?: string };
	/** The caller's request ID, where it gave one: kept with the run, so that the same one again answers it (MCP-1.1, D110). */
	readonly requestId?: string;
	/** The creation prompt as the CLI is to receive it, handed to the planner for its native path (COLLABORATION-2.2). */
	readonly prompt?: string;
	/** The first line of the caller's own prompt text, shown in the card's hover. */
	readonly promptLine?: string;
}

/** How an accepted launch turned out, once its process started or it failed (MCP-2.3). */
export interface StartOutcome {
	readonly state: 'running' | 'failed' | 'closed';
	readonly error?: string;
	/** How the creation prompt went in, where one was asked for. */
	readonly prompt?: LaunchPlan['prompt'];
}

export interface Agents {
	resume(entry: ConversationEntry, options: { readonly reveal: boolean }): RunId | { readonly running: RunId | 'elsewhere' };
	holding(key: ConversationKey): RunId | 'elsewhere' | undefined;
	refreshConversations(): Promise<void>;
	pin(run: RunId): void;
	unpin(run: RunId): void;
	pins(): readonly Pin[];
	reorderPins(ids: readonly string[]): void;
	restorePins(): Promise<void>;
	/** Finds a caller's accepted start within the last hour, including a run whose pair has been removed. */
	requested(from: RunId, requestId: string): RunFacts | undefined;
	/** Validates (all problems together) and, once accepted, creates the pair at once and returns its run ID (LIFECYCLE-1.5). */
	launch(request: LaunchRequest): RunId;
	/** Settles when the accepted run's process started, its launch failed or it was closed first. */
	started(run: RunId): Promise<StartOutcome>;
	/**
	 * Settles once what the run's start types before its first turn is done or given up (COLLABORATION-2.2) - at once for a run whose
	 * CLI needs none, or that this window does not hold.
	 */
	warmedUp(run: RunId): Promise<void>;
	/** Close Agent, the single close action for starting, live and retained runs: pair removed at once, cleanup in the background (LIFECYCLE-3.1). */
	close(run: RunId): Promise<CleanupResult | 'already_ended' | 'not_started'>;
	/** Renames a run's display label, trimming it and allowing an empty string (LIFECYCLE-2.1). */
	rename(run: RunId, name: string): void;
	list(): readonly RunFacts[];
	get(run: RunId): RunFacts | undefined;
	readonly onDidChange: Event<RunChange>;
}
