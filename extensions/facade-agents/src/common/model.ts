/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Facade Code: the data of a program - a goal a lead agent split into features that other agents
 * build in parallel (L2-PLAN, milestone 1). Nothing in `common/` imports `vscode`, so the whole
 * engine runs and is tested under plain mocha.
 */

/** A command Facade runs itself: an argument array, never a shell string. */
export interface Cmd {
	readonly argv: readonly string[];
	/** Relative to the worktree root. */
	readonly cwd?: string;
	readonly timeoutSec?: number;
	/** 1-based indexes into the feature's criteria that this command checks. */
	readonly covers?: readonly number[];
}

/** The plan a lead saves with `plan_save`. */
export interface ProgramPlan {
	readonly schema: 1;
	/** The person's goal, in their words. */
	readonly goal: string;
	/** The lead's approach, in at most a few sentences. */
	readonly approach: string;
	/** The branch the program starts from, `main` for example. Pinned to a commit on submit. */
	readonly base: string;
	/** Defaults to `facade/<program>-<slug>`. */
	readonly integrationBranch?: string;
	/** The repository's rules, one per line, copied into every worker's contract. */
	readonly conventions: readonly string[];
	readonly scaffold: {
		readonly summary: string;
		/** Paths the scaffold creates or changes. Nobody else may own them, stubs aside. */
		readonly paths: readonly string[];
		/** Interfaces the scaffold defines, as `path#Symbol` followed by an optional signature. */
		readonly provides?: readonly string[];
	};
	readonly checks: {
		/** Runs after every merge into the integration branch, and on the scaffold. */
		readonly fast: readonly Cmd[];
		/** The repository's own gate. */
		readonly full: readonly Cmd[];
	};
	readonly features: readonly FeatureSpec[];
	readonly policy?: {
		readonly maxParallel?: number;
		readonly ladder?: readonly string[];
		readonly retriesPerRung?: number;
	};
}

export type FeatureSize = 'S' | 'M';
export type FeatureRisk = 'low' | 'medium' | 'high';

export interface FeatureSpec {
	/** `f1`, `f2` and so on. */
	readonly id: string;
	/** An English imperative sentence; also the commit title. */
	readonly title: string;
	/** The outcome, not the steps. */
	readonly goal: string;
	/** Globs relative to the repository root. No two features may own the same path. */
	readonly owns: readonly string[];
	readonly reads?: readonly string[];
	readonly interfaces?: {
		readonly consumes?: readonly string[];
		readonly provides?: readonly string[];
	};
	readonly acceptance: {
		readonly criteria: readonly string[];
		readonly commands: readonly Cmd[];
	};
	readonly dependsOn?: readonly string[];
	readonly size: FeatureSize;
	readonly risk: FeatureRisk;
	/** Overrides the program's ladder for this feature. */
	readonly ladder?: readonly string[];
	/** How much of the how the contract spells out: `full` for small models. */
	readonly detail?: 'brief' | 'full';
}

/** An agent on a rung of the ladder: an id from the catalogue and an optional model. */
export interface AgentRef {
	readonly id: string;
	readonly model?: string;
}

export const LEAD_RUNG = 'lead';

/** Parses `codex`, `claude:sonnet` or `lead`. */
export function parseRung(rung: string): AgentRef {
	const index = rung.indexOf(':');
	return index < 0 ? { id: rung.trim() } : { id: rung.slice(0, index).trim(), model: rung.slice(index + 1).trim() || undefined };
}

export function formatAgent(agent: AgentRef): string {
	return agent.model ? `${agent.id}:${agent.model}` : agent.id;
}

/** What a worker hands in with `submit_result`. The shape of Paperclip's completion contract. */
export interface WorkerResult {
	readonly outcome: 'done' | 'partial' | 'blocked';
	readonly summary: string;
	readonly criteria: readonly { readonly id: string; readonly status: 'met' | 'not_met' | 'unknown'; readonly evidence?: readonly string[] }[];
	readonly assumptions?: readonly string[];
	readonly risks?: readonly string[];
}

export interface ProgressStep {
	readonly title: string;
	readonly status: 'pending' | 'active' | 'done';
}

export interface CheckRun {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly status: 'pass' | 'fail' | 'timeout' | 'error';
	readonly exitCode?: number;
	readonly ms: number;
	/** The last lines of output, control characters removed. */
	readonly tail: string;
	readonly logPath?: string;
	/** Whether the result came from the cache instead of a run. */
	readonly cached?: boolean;
}

export interface CheckSummary {
	readonly passed: boolean;
	readonly tree: string;
	readonly runs: readonly CheckRun[];
}

/** Why an attempt runs (design doc sections 7.4, 8.2, 8.3 and 9.5). */
export type AttemptKind =
	/** The feature's own work, first time or again. */
	| 'implement'
	/** Merging the integration branch into the feature conflicted in files it owns. */
	| 'resolve'
	/** It passed its own checks and broke the fast checks once merged. */
	| 'regression'
	/** Review findings the lead routed to its worker. */
	| 'fix';

/** What the lead hands in with `lead_submit`. */
export type LeadSubmitKind = 'scaffold' | 'fix' | 'resolve' | 'implement';

/** One change waiting to enter the integration branch. The queue is the branch's only writer. */
export interface QueueItem {
	/** `f2@3` for attempt 3 of f2, `lead-41` for a lead submission, `sync-57` for the base branch. */
	readonly id: string;
	readonly kind: 'feature' | 'lead' | 'sync';
	/** The commit to merge. */
	readonly commit: string;
	/** A line for the merge message. */
	readonly title: string;
	readonly feature?: string;
	readonly attempt?: number;
	/** The agent that made a feature's change. */
	readonly agent?: string;
	readonly leadKind?: LeadSubmitKind;
	/** Findings this change says it fixes. */
	readonly resolves?: readonly string[];
	readonly at: number;
}

/** A merge the queue made into the integration branch. */
export interface MergeRecord {
	readonly commit: string;
	/** The integration commit it was merged onto: its first parent. */
	readonly parent: string;
	readonly item: QueueItem;
	readonly checks: CheckSummary;
	/** Fast checks that failed once and passed when run again. */
	readonly flaky?: readonly string[];
	/** The review packet written for it. */
	readonly packet?: string;
	readonly at: number;
	/** Set once a reviewer recorded its review (invariant I6). */
	review?: { readonly verdict: 'clean' | 'issues'; readonly findings: readonly string[]; readonly at: number };
}

export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type FindingRoute = 'worker' | 'lead' | 'follow-up' | 'wontfix';
export type FindingStatus = 'open' | 'fixing' | 'fixed' | 'verified' | 'follow-up' | 'wontfix';

export interface FindingLocation {
	readonly path: string;
	readonly line?: number;
}

/** A problem a review found (design doc section 9.4). */
export interface Finding {
	/** `r1`, `r2` and so on. */
	readonly id: string;
	/** The merge commit it was found in, or `integration` for the review of the whole program. */
	readonly merge: string;
	/** The feature whose files it is in, when there is one. */
	readonly feature?: string;
	readonly paths: readonly FindingLocation[];
	readonly severity: Severity;
	readonly title: string;
	readonly detail: string;
	readonly suggestion?: string;
	readonly source: 'reviewer' | 'lead';
	route?: FindingRoute;
	status: FindingStatus;
	/** Why it is a follow-up or wontfix; shown to the person before shipping. */
	ruling?: string;
	/** Fix rounds so far. After the third, the lead rules on it. */
	rounds: number;
	/** The merge that says it fixed it. */
	fixedIn?: string;
}

export type ShipMode = 'merge' | 'squash' | 'pr';

/** Tokens and dollars one attempt spent, as its agent reported them. */
export interface UsageRecord {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/** Dollars, when the agent reported them or Facade knows the model's price. */
	readonly costUsd?: number;
	readonly model?: string;
}

/*
 * Events. A program is its event log: every state below is folded from these, in order.
 */

interface EventBase {
	/** Assigned by the store. */
	readonly seq: number;
	/** Epoch milliseconds. */
	readonly ts: number;
}

export type ProgramEventBody =
	| { readonly type: 'program.created'; readonly plan: ProgramPlan; readonly repoRoot: string; readonly repoName: string; readonly createdBy: string }
	| { readonly type: 'plan.updated'; readonly plan: ProgramPlan }
	| { readonly type: 'plan.submitted'; readonly baseCommit: string; readonly integrationBranch: string; readonly newCommands: readonly string[] }
	| { readonly type: 'plan.approved'; readonly approvedCommands: readonly string[] }
	| { readonly type: 'plan.changes_requested'; readonly comment: string }
	| { readonly type: 'integration.created'; readonly branch: string; readonly commit: string }
	/** The worktree the queue checks candidates in; nobody else works there. */
	| { readonly type: 'integration.worktree'; readonly path: string; readonly branch: string }
	| { readonly type: 'lead.workspace'; readonly path: string; readonly branch: string; readonly commit: string }
	/** A lead submission enters the queue. */
	| { readonly type: 'lead.submitted'; readonly item: QueueItem }
	| { readonly type: 'program.started' }
	| { readonly type: 'program.paused'; readonly reason: string }
	| { readonly type: 'program.resumed' }
	| { readonly type: 'program.aborted' }
	| { readonly type: 'feature.started'; readonly feature: string; readonly attempt: number; readonly rung: number; readonly agent: AgentRef; readonly worktree: string; readonly branch: string; readonly base: string; readonly tokenHash: string; readonly terminal?: string; readonly kind?: AttemptKind; readonly injected?: readonly string[]; readonly headless?: boolean }
	/** The integration branch was merged into the feature's branch before an attempt. */
	| { readonly type: 'feature.synced'; readonly feature: string; readonly base: string; readonly conflicts: readonly string[] }
	| { readonly type: 'feature.progress'; readonly feature: string; readonly attempt: number; readonly steps: readonly ProgressStep[]; readonly note?: string }
	| { readonly type: 'feature.question'; readonly feature: string; readonly attempt: number; readonly questionId: string; readonly question: string; readonly options?: readonly string[] }
	| { readonly type: 'feature.answered'; readonly questionId: string; readonly answer: string; readonly by: 'lead' | 'timeout' }
	| { readonly type: 'feature.submitted'; readonly feature: string; readonly attempt: number; readonly result: WorkerResult }
	| { readonly type: 'feature.rejected'; readonly feature: string; readonly attempt: number; readonly reason: 'out_of_scope' | 'no_changes' | 'invalid_result' | 'secret_added' | 'conflict_markers'; readonly detail: string; readonly paths?: readonly string[] }
	| { readonly type: 'feature.checked'; readonly feature: string; readonly attempt: number; readonly commit: string; readonly checks: CheckSummary }
	/** Passed its own checks; the feature enters the merge queue. */
	| { readonly type: 'feature.verified'; readonly feature: string; readonly attempt: number; readonly commit: string; readonly flags?: readonly string[] }
	| { readonly type: 'feature.escalated'; readonly feature: string; readonly fromRung: number; readonly toRung: number; readonly reason: string }
	| { readonly type: 'feature.needs_lead'; readonly feature: string; readonly reason: string }
	/** `finished`: the worker exited by itself after its work was verified, the way a headless one does. */
	| { readonly type: 'feature.ended'; readonly feature: string; readonly attempt: number; readonly reason: 'exited' | 'finished' | 'stopped' | 'interrupted' | 'launch_failed'; readonly detail?: string }
	/** A launch that failed before the worker existed, such as a worktree git could not create. */
	| { readonly type: 'feature.launch_failed'; readonly feature: string; readonly attempt: number; readonly detail: string }
	| { readonly type: 'feature.stalled'; readonly feature: string; readonly attempt: number; readonly idleMinutes: number }
	/** The agent says it waits for the person, from a hook: a permission prompt, for example. */
	| { readonly type: 'feature.waiting'; readonly feature: string; readonly attempt: number; readonly reason: string }
	/** The agent ended its turn without submitting, from a hook. */
	| { readonly type: 'feature.turn_ended'; readonly feature: string; readonly attempt: number }
	| { readonly type: 'feature.usage'; readonly feature: string; readonly attempt: number; readonly agent: AgentRef; readonly usage: UsageRecord; readonly source: string }
	/** A submission whose checks a reload cut off goes back to its worker, at no cost to it. */
	| { readonly type: 'feature.reset'; readonly feature: string; readonly attempt: number; readonly reason: string }
	| { readonly type: 'feature.reassigned'; readonly feature: string; readonly ladder: readonly string[] }
	| { readonly type: 'feature.retry'; readonly feature: string }
	| { readonly type: 'feature.abandoned'; readonly feature: string }
	/** The lead routed review findings to the feature's worker: one fix attempt for all of them. */
	| { readonly type: 'feature.fix_requested'; readonly feature: string; readonly findings: readonly string[] }
	/** The base branch moved; its tip enters the queue. */
	| { readonly type: 'sync.enqueued'; readonly item: QueueItem }
	| { readonly type: 'queue.merged'; readonly itemId: string; readonly commit: string; readonly parent: string; readonly checks: CheckSummary; readonly flaky?: readonly string[]; readonly packet?: string }
	| { readonly type: 'queue.checks_failed'; readonly itemId: string; readonly candidate: string; readonly checks: CheckSummary }
	| { readonly type: 'queue.conflict'; readonly itemId: string; readonly paths: readonly string[]; readonly resolver: 'worker' | 'lead' }
	/** An item that no longer applies, such as a feature the lead abandoned after it was verified, or one already merged. */
	| { readonly type: 'queue.dropped'; readonly itemId: string; readonly reason: string; readonly alreadyIn?: string }
	/** The queue stops until the person resumes the program. */
	| { readonly type: 'queue.halted'; readonly reason: string }
	/** The person resumed a halted queue of a program that was not running yet. */
	| { readonly type: 'queue.resumed' }
	| { readonly type: 'checks.full'; readonly commit: string; readonly checks: CheckSummary }
	/** Every feature is merged or abandoned and the queue is empty. */
	| { readonly type: 'program.all_merged'; readonly commit: string }
	| { readonly type: 'review.recorded'; readonly merge: string; readonly verdict: 'clean' | 'issues'; readonly added: readonly Finding[]; readonly addressed: readonly { readonly id: string; readonly addressed: boolean; readonly note?: string }[] }
	| { readonly type: 'findings.routed'; readonly items: readonly { readonly id: string; readonly route: FindingRoute; readonly ruling?: string }[] }
	| { readonly type: 'review.completed'; readonly tip: string; readonly summary: string }
	| { readonly type: 'ship.requested'; readonly mode: ShipMode; readonly tip: string }
	| { readonly type: 'ship.cancelled'; readonly reason: string }
	| { readonly type: 'ship.approved' }
	| { readonly type: 'ship.done'; readonly mode: ShipMode; readonly commit?: string; readonly url?: string; readonly removed: readonly string[]; readonly kept: readonly string[] }
	| { readonly type: 'ship.failed'; readonly reason: string };

export type ProgramEvent = ProgramEventBody & EventBase;
export type ProgramEventType = ProgramEvent['type'];

/*
 * State folded from the events.
 */

export type ProgramStatus = 'draft' | 'awaiting_approval' | 'approved' | 'running' | 'paused' | 'aborted' | 'shipped';

export type FeatureStatus =
	/** Not started, or waiting on dependencies or a free slot. */
	| 'pending'
	/** A worker is on it. */
	| 'running'
	/** Its last submission is being checked. */
	| 'verifying'
	/** Passed its own checks; waiting in the merge queue. */
	| 'verified'
	/** Its work is on the integration branch. A review fix takes it back to pending. */
	| 'merged'
	/** Every agent on its ladder failed it, or its merge needs a decision; the lead decides. */
	| 'needs_lead'
	| 'abandoned';

export interface ActiveAttempt {
	readonly attempt: number;
	readonly agent: AgentRef;
	readonly tokenHash: string;
	readonly terminal?: string;
	readonly startedAt: number;
	readonly kind: AttemptKind;
	readonly headless?: boolean;
}

export interface FeatureState {
	readonly spec: FeatureSpec;
	status: FeatureStatus;
	/** Index into the feature's ladder. */
	rung: number;
	/** Failed rounds on the current rung. */
	failuresOnRung: number;
	/** Increments with every launch. */
	attempts: number;
	worktree?: string;
	branch?: string;
	/** The commit its changes are measured from: where it started, or the integration commit last merged into it. */
	base?: string;
	active?: ActiveAttempt;
	/** What the next attempt is for. */
	kind: AttemptKind;
	/** Merge the integration branch into the feature's branch before the next attempt. */
	syncBeforeNext: boolean;
	/** Paths the last merge of the integration branch left in conflict. */
	conflicts?: readonly string[];
	/** The fast checks that failed on its last merge candidate. */
	queueChecks?: CheckSummary;
	/** How often its merge broke the fast checks. The second time goes to the lead. */
	regressions: number;
	/** Findings the next or current attempt fixes. */
	fixFindings?: readonly string[];
	/** Files Facade wrote into its worktree for the agent: never committed, never out of scope. */
	injected?: readonly string[];
	/** Ladder the lead set with `feature_update`, if any. */
	ladder?: readonly string[];
	progress?: { readonly steps: readonly ProgressStep[]; readonly note?: string; readonly at: number };
	lastResult?: WorkerResult;
	lastChecks?: CheckSummary;
	lastRejection?: { readonly reason: string; readonly detail: string; readonly paths?: readonly string[] };
	verifiedCommit?: string;
	/** Notes for review, such as `tests_weakened`. */
	flags?: readonly string[];
	/** The last merge commit that brought its work into the integration branch. */
	mergedCommit?: string;
	/** Set while a question from this feature waits for an answer. */
	openQuestion?: string;
	/** When a worker last called a Facade tool. */
	lastActivity?: number;
	needsLeadReason?: string;
	/** What its agent waits for, from a hook, until it next calls Facade. */
	waiting?: string;
	/** Tokens and dollars, summed over its attempts. */
	usage?: UsageRecord;
}

export interface QuestionState {
	readonly id: string;
	readonly feature: string;
	readonly attempt: number;
	readonly question: string;
	readonly options?: readonly string[];
	readonly askedAt: number;
	answer?: string;
	answeredBy?: 'lead' | 'timeout';
}

export interface ShipState {
	readonly mode: ShipMode;
	readonly tip: string;
	status: 'awaiting_approval' | 'shipping' | 'done' | 'failed' | 'cancelled';
	commit?: string;
	url?: string;
	reason?: string;
	removed?: readonly string[];
	kept?: readonly string[];
}

export interface ProgramState {
	readonly id: string;
	seq: number;
	repoRoot: string;
	repoName: string;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	plan: ProgramPlan;
	status: ProgramStatus;
	pauseReason?: string;
	baseCommit?: string;
	integrationBranch?: string;
	integrationTip?: string;
	integrationWorktree?: { readonly path: string; readonly branch: string };
	lead?: { readonly path: string; readonly branch: string };
	scaffoldMerged: boolean;
	newCommands: readonly string[];
	lastChangeRequest?: string;
	features: Map<string, FeatureState>;
	questions: Map<string, QuestionState>;
	/** Check results by tree and command, so an unchanged tree is never checked twice. */
	checkCache: Map<string, CheckRun>;
	/** Changes waiting to merge, first in first out. */
	queue: QueueItem[];
	/** Why the queue stopped, until the program resumes. */
	queueHalted?: string;
	merges: MergeRecord[];
	/** The last full checks, and the commit they ran on. */
	fullChecks?: { readonly commit: string; readonly checks: CheckSummary };
	/** The integration commit at which every feature was merged or abandoned. */
	allMergedAt?: string;
	findings: Map<string, Finding>;
	/** When the lead recorded its review of the whole program. */
	integrationReviewed?: { readonly tip: string; readonly at: number };
	reviewCompleted?: { readonly tip: string; readonly summary: string };
	ship?: ShipState;
}
