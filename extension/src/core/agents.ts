/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { FacadeError, invalid } from './errors';
import { worktreeCreationEffects } from './locations/problems';
import { labelOf, normalizeName } from './names';
import {
	ActivityReport, Agents, AliasPort, CleanupResult, Clock, Disposable, Event, ExecutionPort, ExitReport, HumanPort, LaunchHistoryPort,
	LaunchPlanner, LaunchRequest, LiveRun, Location, LocationPort, LocationRemoval, LogPort, PairFacts, PlanError, RetainedStore, RunChange,
	RunFacts, RunId, RunMeta, WindowLifetimePort, WorktreeCreationEffects, WorktreeError, WorktreePort
} from './ports';

export interface AgentServiceDeps {
	readonly execution: ExecutionPort;
	readonly planner: LaunchPlanner;
	readonly locations: LocationPort;
	readonly worktrees: WorktreePort;
	readonly history: LaunchHistoryPort;
	readonly human: HumanPort;
	readonly retained: RetainedStore;
	readonly aliases: AliasPort;
	readonly clock: Clock;
	readonly log: LogPort;
	readonly lifetime: WindowLifetimePort;
	/** The destination's current `facade.yolo`, read when each launch is accepted (RULES-4.3). */
	readonly yolo: () => boolean;
	/** A failure in the person's language (UX-2.4): Facade's own reasons translated, any other its `english` as it is. */
	readonly describe?: (err: unknown, english: string) => string;
	readonly newRunId: () => RunId;
}

interface Run {
	facts: RunFacts;
	/** Known startup creation effects, retained if later CLI planning or spawning fails. */
	worktree?: WorktreeCreationEffects;
	/** Whether an explicit close of this run was requested: its exit is then normal (RULES-3.3). */
	closing: boolean;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The one launch service and run record for every origin (LIFECYCLE-4.1): an accepted launch creates its card and terminal at
 * once (LIFECYCLE-1.5), close removes them at once with cleanup in the background (LIFECYCLE-3.1), exits are classified
 * independently of who caused them (RULES-3.3), and confirmed location removal closes the affected agents (RULES-2.4).
 */
export class AgentService implements Agents, Disposable {
	private readonly runs = new Map<RunId, Run>();
	private readonly listeners = new Set<(change: RunChange) => void>();
	private readonly subscriptions: Disposable[] = [];
	private ownershipLost = false;

	readonly onDidChange: Event<RunChange> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	constructor(private readonly deps: AgentServiceDeps) {
		const { execution } = deps;
		this.subscriptions.push(
			execution.onDidReport(report => this.reported(report)),
			execution.onDidExit(exit => this.exited(exit)),
			deps.locations.onDidRemove(removal => this.locationsRemoved(removal)),
			deps.lifetime.onDidClose(() => void execution.endWindow())
		);
		if (execution.onDidClosePair) {
			this.subscriptions.push(execution.onDidClosePair(run => void this.tabClosed(run)));
		}
		if (execution.onDidRenameTab) {
			this.subscriptions.push(execution.onDidRenameTab(({ run, name }) => this.tabRenamed(run, name)));
		}
		if (execution.onDidLoseOwnership) {
			this.subscriptions.push(execution.onDidLoseOwnership(() => {
				this.ownershipLost = true;
				for (const id of [...this.runs.keys()]) {
					this.runs.delete(id);
					this.emit({ run: id, kind: 'removed', cause: 'transfer' });
				}
			}));
		}
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.listeners.clear();
	}

	list(): readonly RunFacts[] {
		return [...this.runs.values()].map(run => run.facts);
	}

	get(run: RunId): RunFacts | undefined {
		return this.runs.get(run)?.facts;
	}

	/**
	 * Finds this window's runs again after a reload, and the failed launches it retained (LIFECYCLE-3.5, 1.5). Answers how many live
	 * runs the execution owner reports as held elsewhere. Actual process records take precedence over a retained failed-start
	 * observation. Ownership is acquired before any retained pair is shown.
	 */
	async restore(): Promise<number> {
		if (this.ownershipLost) {
			return 0;
		}
		let live: readonly LiveRun[];
		try {
			live = await this.deps.execution.live();
		} catch (err) {
			this.deps.log.event(`Could not list the agents still running for this window: ${messageOf(err)}`);
			return 0;
		}
		if (this.ownershipLost) {
			return 0;
		}
		const liveIds = new Set(live.map(run => run.run));
		for (const facts of this.deps.retained.list()) {
			if (!isRetainedRun(facts)) {
				this.deps.log.event('Ignored an invalid retained agent record.');
				continue;
			}
			if (liveIds.has(facts.id)) {
				this.deps.retained.remove(facts.id);
				continue;
			}
			if (!this.runs.has(facts.id)) {
				this.runs.set(facts.id, { facts, closing: false });
				this.deps.execution.openPair(pairOf(facts), { reveal: false });
				if (facts.error) {
					this.deps.execution.note(facts.id, facts.error.reason);
				}
				this.emit({ run: facts.id, kind: 'added' });
			}
		}
		let elsewhere = 0;
		for (const each of live) {
			if (this.ownershipLost) {
				return 0;
			}
			if (this.runs.has(each.run)) {
				continue;
			}
			if (each.claimedElsewhere) {
				elsewhere++;
				continue;
			}
			const facts: RunFacts = {
				...factsOf(each.run, each.meta),
				lifecycle: 'running',
				phase: 'running',
				pid: each.pid,
				startedAt: each.startedAt
			};
			const run: Run = { facts, closing: false };
			this.runs.set(each.run, run);
			try {
				await this.deps.execution.attach(each, pairOf(facts));
			} catch (err) {
				if (this.runs.get(each.run) === run) {
					this.runs.delete(each.run);
				}
				this.deps.log.event(`Could not reattach ${facts.alias}: ${messageOf(err)}`);
				continue;
			}
			this.emit({ run: each.run, kind: 'added' });
			if (this.deps.locations.removalOf(facts.location)) {
				// Its location went while the host restarted: removal closes it, as it would have (RULES-2.4)
				void this.close(each.run).catch(() => undefined);
			} else if (each.exited) {
				this.exited({ run: each.run, ...each.exited });
			}
		}
		return elsewhere;
	}

	launch(request: LaunchRequest): RunId {
		if (this.ownershipLost) {
			throw invalid('ownership_lost', 'This workspace is now owned by another window. Reload this window to take ownership.');
		}
		return this.accept(request, this.validated(request));
	}

	/** Reports every problem of a request together before any effect (RULES-5.1). */
	private validated(request: LaunchRequest): Location {
		const problems: string[] = [];
		if (typeof request.name !== 'string') {
			problems.push('The name must be a string.');
		}
		const location = request.location ? this.deps.locations.resolve(request.location) : undefined;
		if (!request.location) {
			problems.push('A working location is required.');
		} else if (!location) {
			problems.push(`The working location ${request.location} is not available in this window.`);
		}
		if (!request.cli) {
			problems.push('A CLI is required.');
		}
		if (request.worktree && !request.worktree.branch?.trim()) {
			problems.push('A new worktree needs a branch.');
		}
		if (problems.length || !location) {
			throw invalid(request.name === undefined || !request.cli || !request.location ? 'missing_argument' : 'invalid_argument', problems.join(' '));
		}
		return location;
	}

	private accept(request: LaunchRequest, location: Location): RunId {
		const id = this.deps.newRunId();
		const now = this.deps.clock.now();
		const facts: RunFacts = {
			id,
			alias: this.deps.aliases.next(),
			name: normalizeName(request.name),
			cli: request.cli,
			displayName: request.cli,
			command: request.cli,
			location: location.id,
			cwd: location.path,
			environment: location.environment,
			yolo: this.deps.yolo(),
			createdAt: now,
			lifecycle: 'starting',
			phase: request.worktree ? 'creating_worktree' : 'launching_cli',
			activity: 'unknown',
			reporting: false
		};
		const run: Run = { facts, closing: false };
		this.runs.set(id, run);
		// The person's own launch shows its terminal (LIFECYCLE-2.2)
		this.deps.execution.openPair(pairOf(facts), { reveal: true });
		this.emit({ run: id, kind: 'added' });
		this.deps.log.event(`Accepted ${facts.alias} ${JSON.stringify(facts.name)} (${facts.cli}) in ${facts.cwd} [${id}]`);
		void this.start(run, request, location);
		return id;
	}

	private async start(run: Run, request: LaunchRequest, source: Location): Promise<void> {
		let location: Location | undefined = source;
		if (request.worktree) {
			try {
				const plan = await this.deps.worktrees.plan(source.id, request.worktree.branch, request.worktree.baseRef);
				location = await this.deps.worktrees.create(plan, () => this.live(run));
				run.worktree = { branch: plan.branch, folder: location.path };
			} catch (err) {
				run.worktree = err instanceof WorktreeError ? worktreeCreationEffects(request.worktree.branch, err.effects) : undefined;
				return this.fail(run, messageOf(err), 'worktree', err);
			}
			if (!this.live(run)) {
				return;
			}
			this.update(run, { location: location.id, cwd: location.path, phase: 'launching_cli' }, 'lifecycle');
		} else {
			location = this.deps.locations.resolve(run.facts.location);
		}
		if (!location) {
			return this.fail(run, `The working location ${run.facts.cwd} is no longer available.`, 'location');
		}
		let plan;
		try {
			plan = await this.deps.planner.plan({ run: run.facts.id, alias: run.facts.alias, name: run.facts.name, cli: request.cli, location, yolo: run.facts.yolo });
		} catch (err) {
			return this.fail(run, err instanceof PlanError || err instanceof FacadeError ? err.message : messageOf(err), 'launch', err);
		}
		if (!this.live(run)) {
			return;
		}
		this.update(run, { displayName: plan.displayName, command: plan.command, cwd: plan.cwd }, 'lifecycle');
		try {
			const started = await this.deps.execution.spawn(run.facts.id, plan, metaOf(run.facts));
			if (!this.live(run)) {
				return;
			}
			this.update(run, { lifecycle: 'running', phase: 'running', pid: started.pid, startedAt: started.startedAt }, 'lifecycle');
			this.deps.history.remember(run.facts.location, run.facts.cli);
			// The arguments may hold a credential: never logged (ARCHITECTURE-3.3, CLIS-4.2)
			this.deps.log.event(`Started ${run.facts.alias} (${plan.cli}) pid ${started.pid}: ${plan.executable} with ${plan.args.length} argument${plan.args.length === 1 ? '' : 's'}`);
		} catch (err) {
			this.fail(run, messageOf(err), 'launch', err);
		}
	}

	/** Whether the run is still wanted: closing it during startup prevents a later spawn (WORKTREES-2.5, RULES-5.2). */
	private live(run: Run): boolean {
		return this.runs.get(run.facts.id) === run && !run.closing;
	}

	/** The launch failed: its pair kept red with why in the person's words, the English in the log (RULES-3.3, UX-2.4). */
	private fail(run: Run, english: string, source: string, err?: unknown): void {
		if (!this.live(run)) {
			return;
		}
		const at = this.deps.clock.now();
		const effects = run.worktree ? { worktree: run.worktree } : {};
		const reason = err !== undefined && this.deps.describe ? this.deps.describe(err, english) : english;
		this.update(run, { lifecycle: 'ended', end: { kind: 'failed', at }, error: { reason, source, at, ...effects } }, 'lifecycle');
		this.deps.retained.put(run.facts);
		this.deps.execution.note(run.facts.id, reason);
		this.deps.log.event(`Could not start ${run.facts.alias}: ${english}`);
		this.deps.human.failed({ kind: 'start', name: labelOf(run.facts), reason, ...effects }, { show: run.facts.id, configure: source === 'launch' });
	}

	async close(id: RunId): Promise<CleanupResult | 'already_ended' | 'not_started'> {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		run.closing = true;
		this.runs.delete(id);
		this.deps.retained.remove(id);
		this.deps.execution.removePair(id);
		this.emit({ run: id, kind: 'removed', cause: 'close' });
		if (run.facts.lifecycle === 'ended') {
			this.deps.log.event(`Closed ${run.facts.alias}`);
			return 'already_ended';
		}
		if (run.facts.pid === undefined) {
			// Closed before its process started: it never starts; one already spawning is ended in the background (WORKTREES-2.5)
			this.deps.log.event(`Closed ${run.facts.alias} before its process started`);
			return 'not_started';
		}
		const result = await this.deps.execution.terminate(id).catch(err => {
			this.deps.log.event(`Could not end ${run.facts.alias}: ${messageOf(err)}`);
			return 'failed' as const;
		});
		this.deps.log.event(`Closed ${run.facts.alias}: ${result}`);
		return result;
	}

	rename(id: RunId, raw: string): void {
		const run = this.runs.get(id);
		if (!run) {
			throw new FacadeError('NOT_FOUND', 'not_found', `No agent ${id} in this window.`);
		}
		const name = normalizeName(raw);
		if (name === run.facts.name) {
			return;
		}
		this.update(run, { name }, 'renamed');
		this.deps.execution.rename(id, name);
		if (run.facts.pid !== undefined) {
			// ptyd keeps an exited run's record too: a renamed red card keeps its name across a reload
			this.deps.execution.setMeta(id, metaOf(run.facts));
		}
		if (run.facts.lifecycle === 'ended' && run.facts.end?.kind === 'failed') {
			this.deps.retained.put(run.facts);
		}
	}

	/**
	 * The person closed a run's terminal tab, alone or with other editors (LIFECYCLE-3.1): a live agent ends only once they confirm it;
	 * kept, it goes on and its terminal opens again. A starting or ended one closes at once.
	 */
	private async tabClosed(id: RunId): Promise<void> {
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		if (run.facts.lifecycle === 'running' && this.deps.human.confirmClose && !await this.deps.human.confirmClose({ run: id, label: labelOf(run.facts) })) {
			if (this.runs.get(id) === run) {
				this.deps.log.event(`Kept ${run.facts.alias} running: its terminal tab was closed and the person chose to keep it`);
				this.deps.execution.reopen?.(id);
			}
			return;
		}
		if (this.runs.get(id) === run) {
			await this.close(id).catch(() => undefined);
		}
	}

	/**
	 * The person renamed a run's terminal tab (LIFECYCLE-2.2): rename the label as Rename Agent does, including to an empty string.
	 */
	private tabRenamed(id: RunId, name: string): void {
		const run = this.runs.get(id);
		if (!run) {
			return;
		}
		this.rename(id, name);
	}

	private reported(report: ActivityReport): void {
		const run = this.runs.get(report.run);
		if (!run || run.facts.lifecycle === 'ended') {
			return;
		}
		const changes: Partial<Mutable<RunFacts>> = {
			activity: report.activity,
			reporting: report.reporting,
			awaitingActivity: report.awaitingActivity,
			activityReason: report.reason,
			blocker: report.blocker,
			title: report.title ?? run.facts.title
		};
		let kind: RunChange['kind'] = 'reported';
		if (report.disconnected && report.reason && !run.facts.error) {
			changes.error = { reason: report.reason, source: 'connection', at: this.deps.clock.now() };
			kind = 'lifecycle';
		} else if (!report.disconnected && run.facts.error?.source === 'connection') {
			changes.error = undefined;
			kind = 'lifecycle';
		}
		if (report.error) {
			if (run.facts.error?.source !== 'cli' || run.facts.error.reason !== report.error) {
				changes.error = { reason: report.error, source: 'cli', at: this.deps.clock.now() };
				kind = 'lifecycle';
			}
		} else if (!report.disconnected && run.facts.error?.source === 'cli') {
			// Recovery clears only the corresponding error (RULES-3.2)
			changes.error = undefined;
			kind = 'lifecycle';
		}
		this.update(run, changes, kind);
	}

	private exited(exit: ExitReport): void {
		const run = this.runs.get(exit.run);
		if (!run) {
			return;
		}
		const normal = exit.code === 0 || run.closing || exit.interruptVerified;
		if (normal) {
			// A normal exit removes the pair (RULES-3.3)
			this.runs.delete(exit.run);
			this.deps.execution.removePair(exit.run);
			this.emit({ run: exit.run, kind: 'removed', cause: 'exit' });
			this.deps.log.event(`${run.facts.alias} exited${exit.code !== undefined ? ` with code ${exit.code}` : ''}`);
			return;
		}
		const at = this.deps.clock.now();
		const how = exit.signal ? `Ended by signal ${exit.signal}` : `Exited with code ${exit.code ?? 'unknown'}`;
		// An abnormal exit keeps the red pair, without a restart loop (RULES-3.3)
		this.update(run, {
			lifecycle: 'ended',
			end: { kind: 'abnormal', at, ...(exit.code !== undefined ? { code: exit.code } : {}), ...(exit.signal ? { signal: exit.signal } : {}) },
			error: { reason: how, source: 'exit', at }
		}, 'lifecycle');
		this.deps.log.event(`${run.facts.alias} ${how.toLowerCase()}`);
	}

	private locationsRemoved(removal: LocationRemoval): void {
		const removed = new Set(removal.ids);
		for (const run of [...this.runs.values()]) {
			if (removed.has(run.facts.location)) {
				this.deps.log.event(`Closing ${run.facts.alias}: its working location was ${removal.cause === 'folder' ? 'removed from the workspace' : 'deleted'}`);
				void this.close(run.facts.id).catch(() => undefined);
			}
		}
	}

	private update(run: Run, changes: Partial<Mutable<RunFacts>>, kind: RunChange['kind']): void {
		const next = { ...run.facts } as Mutable<RunFacts>;
		for (const [key, value] of Object.entries(changes) as [keyof RunFacts, unknown][]) {
			if (value === undefined) {
				delete next[key];
			} else {
				(next as Record<string, unknown>)[key] = value;
			}
		}
		run.facts = next;
		this.emit({ run: run.facts.id, kind });
	}

	private emit(change: RunChange): void {
		for (const listener of [...this.listeners]) {
			listener(change);
		}
	}
}

/** Disk records are observations, not typed objects: reject a damaged record before opening any of its UI. */
function isRetainedRun(value: unknown): value is RunFacts {
	if (!isJsonObject(value)) {
		return false;
	}
	const strings = ['id', 'alias', 'name', 'cli', 'displayName', 'command', 'location', 'cwd', 'environment'];
	return strings.every(key => typeof value[key] === 'string') && typeof value.yolo === 'boolean' &&
		typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && value.lifecycle === 'ended' &&
		typeof value.phase === 'string' && ['creating_worktree', 'launching_cli', 'running'].includes(value.phase) &&
		typeof value.activity === 'string' && ['working', 'not_working', 'unknown'].includes(value.activity) && typeof value.reporting === 'boolean' &&
		['title', 'activityReason'].every(key => value[key] === undefined || typeof value[key] === 'string') &&
		['pid', 'startedAt'].every(key => value[key] === undefined || typeof value[key] === 'number' && Number.isFinite(value[key])) &&
		(value.blocker === undefined || isJsonObject(value.blocker) && typeof value.blocker.kind === 'string' &&
			['permission', 'question', 'auth'].includes(value.blocker.kind) && (value.blocker.text === undefined || typeof value.blocker.text === 'string')) &&
		isJsonObject(value.end) && value.end.kind === 'failed' && typeof value.end.at === 'number' && Number.isFinite(value.end.at) &&
		(value.end.code === undefined || typeof value.end.code === 'number') && (value.end.signal === undefined || typeof value.end.signal === 'string') &&
		isJsonObject(value.error) && typeof value.error.reason === 'string' && typeof value.error.source === 'string' && typeof value.error.at === 'number' && Number.isFinite(value.error.at) &&
		(value.error.worktree === undefined || (isJsonObject(value.error.worktree) &&
			(value.error.worktree.branch === undefined || (typeof value.error.worktree.branch === 'string' && !!value.error.worktree.branch)) &&
			(value.error.worktree.folder === undefined || (typeof value.error.worktree.folder === 'string' && !!value.error.worktree.folder)) &&
			(value.error.worktree.branch !== undefined || value.error.worktree.folder !== undefined)));
}

function factsOf(id: RunId, meta: RunMeta): RunFacts {
	return {
		id,
		alias: meta.alias,
		name: meta.name,
		cli: meta.cli,
		displayName: meta.displayName,
		command: meta.command,
		location: meta.location,
		cwd: meta.cwd,
		environment: meta.environment,
		yolo: meta.yolo,
		createdAt: meta.createdAt,
		lifecycle: 'running',
		phase: 'running',
		activity: 'unknown',
		reporting: false
	};
}

export function metaOf(facts: RunFacts): RunMeta {
	return {
		alias: facts.alias,
		name: facts.name,
		cli: facts.cli,
		displayName: facts.displayName,
		command: facts.command,
		location: facts.location,
		cwd: facts.cwd,
		environment: facts.environment,
		yolo: facts.yolo,
		createdAt: facts.createdAt
	};
}

export function pairOf(facts: RunFacts): PairFacts {
	return { run: facts.id, name: facts.name, cli: facts.cli, displayName: facts.displayName, command: facts.command, cwd: facts.cwd };
}
