/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commandKey } from './validator';
import { CheckSummary, Cmd, FeatureSpec, FeatureState, formatAgent, ProgramEvent, ProgramPlan, ProgramState, QueueItem, UsageRecord } from './model';

/*
 * Folds a program's events into its state. The only place state changes: the engine appends an
 * event and applies it here, and loading a program applies the same events in the same order, so
 * what a reload rebuilds is what was there before it.
 */

export function checkCacheKey(tree: string, cmd: Cmd): string {
	return `${tree}\u0000${commandKey(cmd)}`;
}

function newFeature(spec: FeatureSpec): FeatureState {
	return { spec, status: 'pending', rung: 0, failuresOnRung: 0, attempts: 0, kind: 'implement', syncBeforeNext: false, regressions: 0 };
}

function featuresOf(plan: ProgramPlan): Map<string, FeatureState> {
	return new Map(plan.features.map(spec => [spec.id, newFeature(spec)]));
}

/** The state before its first event is applied, from `program.created`. */
export function createState(id: string, created: Extract<ProgramEvent, { type: 'program.created' }>): ProgramState {
	return {
		id,
		seq: created.seq,
		repoRoot: created.repoRoot,
		repoName: created.repoName,
		createdBy: created.createdBy,
		createdAt: created.ts,
		updatedAt: created.ts,
		plan: created.plan,
		status: 'draft',
		scaffoldMerged: false,
		newCommands: [],
		features: featuresOf(created.plan),
		questions: new Map(),
		checkCache: new Map(),
		queue: [],
		merges: [],
		findings: new Map()
	};
}

/** Caches what ran; a failed run ends the list, so later commands have nothing to cache. */
function cacheChecks(state: ProgramState, checks: CheckSummary): void {
	for (const run of checks.runs) {
		if (!run.cached && (run.status === 'pass' || run.status === 'fail')) {
			state.checkCache.set(checkCacheKey(checks.tree, { argv: run.argv, cwd: run.cwd }), run);
		}
	}
}

function addUsage(total: UsageRecord | undefined, next: UsageRecord): UsageRecord {
	if (!total) {
		return next;
	}
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
		cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
		costUsd: total.costUsd !== undefined || next.costUsd !== undefined ? (total.costUsd ?? 0) + (next.costUsd ?? 0) : undefined,
		model: next.model ?? total.model
	};
}

/** The line a feature's merge gets in the merge message. */
function itemTitle(feature: FeatureState): string {
	switch (feature.active?.kind ?? feature.kind) {
		case 'fix': return `${feature.spec.title}: fix ${(feature.fixFindings ?? []).join(', ') || 'review findings'}`;
		case 'resolve': return `${feature.spec.title}: resolve a conflict with the integration branch`;
		case 'regression': return `${feature.spec.title}: fix a regression in the fast checks`;
		default: return feature.spec.title;
	}
}

function takeItem(state: ProgramState, itemId: string): QueueItem | undefined {
	const index = state.queue.findIndex(item => item.id === itemId);
	return index < 0 ? undefined : state.queue.splice(index, 1)[0];
}

function markFixed(state: ProgramState, ids: readonly string[] | undefined, merge: string): void {
	for (const id of ids ?? []) {
		const finding = state.findings.get(id);
		if (finding && (finding.status === 'fixing' || finding.status === 'open')) {
			finding.status = 'fixed';
			finding.fixedIn = merge;
		}
	}
}

/** Applies one event. Events the state has already seen (by `seq`) are ignored. */
export function applyEvent(state: ProgramState, event: ProgramEvent): void {
	if (event.seq <= state.seq && event.type !== 'program.created') {
		return;
	}
	state.seq = Math.max(state.seq, event.seq);
	state.updatedAt = event.ts;

	// Every event about one feature names it in `feature`.
	const featureId = (event as { readonly feature?: string }).feature;
	const feature = featureId !== undefined ? state.features.get(featureId) : undefined;

	switch (event.type) {
		case 'program.created':
			break;
		case 'plan.updated':
			state.plan = event.plan;
			state.features = featuresOf(event.plan);
			state.status = 'draft';
			state.newCommands = [];
			break;
		case 'plan.submitted':
			state.status = 'awaiting_approval';
			state.baseCommit = event.baseCommit;
			state.integrationBranch = event.integrationBranch;
			state.newCommands = event.newCommands;
			state.lastChangeRequest = undefined;
			break;
		case 'plan.approved':
			state.status = 'approved';
			state.newCommands = [];
			break;
		case 'plan.changes_requested':
			state.status = 'draft';
			state.lastChangeRequest = event.comment;
			break;
		case 'integration.created':
			state.integrationBranch = event.branch;
			state.integrationTip = event.commit;
			break;
		case 'integration.worktree':
			state.integrationWorktree = { path: event.path, branch: event.branch };
			break;
		case 'lead.workspace':
			state.lead = { path: event.path, branch: event.branch };
			break;
		case 'lead.submitted':
		case 'sync.enqueued':
			state.queue.push(event.item);
			break;
		case 'program.started':
		case 'program.resumed':
			state.status = 'running';
			state.pauseReason = undefined;
			state.queueHalted = undefined;
			break;
		case 'program.paused':
			state.status = 'paused';
			state.pauseReason = event.reason;
			break;
		case 'program.aborted':
			state.status = 'aborted';
			for (const each of state.features.values()) {
				each.active = undefined;
				if (each.status === 'running' || each.status === 'verifying') {
					each.status = 'pending';
				}
			}
			break;
		case 'feature.started':
			if (feature) {
				feature.status = 'running';
				feature.attempts = event.attempt;
				feature.rung = event.rung;
				feature.worktree = event.worktree;
				feature.branch = event.branch;
				feature.base = event.base;
				feature.injected = event.injected;
				feature.active = { attempt: event.attempt, agent: event.agent, tokenHash: event.tokenHash, terminal: event.terminal, startedAt: event.ts, kind: event.kind ?? feature.kind, headless: event.headless };
				feature.lastActivity = event.ts;
				feature.needsLeadReason = undefined;
				feature.waiting = undefined;
			}
			break;
		case 'feature.synced':
			if (feature) {
				feature.base = event.base;
				feature.conflicts = event.conflicts.length ? event.conflicts : undefined;
				feature.syncBeforeNext = false;
			}
			break;
		case 'feature.progress':
			if (feature) {
				feature.progress = { steps: event.steps, note: event.note, at: event.ts };
				feature.lastActivity = event.ts;
				feature.waiting = undefined;
			}
			break;
		case 'feature.question':
			state.questions.set(event.questionId, { id: event.questionId, feature: event.feature, attempt: event.attempt, question: event.question, options: event.options, askedAt: event.ts });
			if (feature) {
				feature.openQuestion = event.questionId;
				feature.lastActivity = event.ts;
			}
			break;
		case 'feature.answered': {
			const question = state.questions.get(event.questionId);
			if (question) {
				question.answer = event.answer;
				question.answeredBy = event.by;
				const asker = state.features.get(question.feature);
				if (asker?.openQuestion === event.questionId) {
					asker.openQuestion = undefined;
				}
			}
			break;
		}
		case 'feature.submitted':
			if (feature) {
				feature.status = 'verifying';
				feature.lastResult = event.result;
				feature.lastActivity = event.ts;
				feature.waiting = undefined;
			}
			break;
		case 'feature.rejected':
			if (feature) {
				feature.status = 'running';
				feature.failuresOnRung++;
				feature.lastRejection = { reason: event.reason, detail: event.detail, paths: event.paths };
			}
			break;
		case 'feature.checked':
			if (feature) {
				cacheChecks(state, event.checks);
				feature.lastChecks = event.checks;
				feature.lastRejection = undefined;
				if (!event.checks.passed) {
					feature.status = 'running';
					feature.failuresOnRung++;
				}
			}
			break;
		case 'feature.verified':
			if (feature) {
				state.queue.push({ id: `${feature.spec.id}@${event.attempt}`, kind: 'feature', commit: event.commit, title: itemTitle(feature), feature: feature.spec.id, attempt: event.attempt, agent: feature.active ? formatAgent(feature.active.agent) : undefined, resolves: (feature.active?.kind ?? feature.kind) === 'fix' ? feature.fixFindings : undefined, at: event.ts });
				feature.status = 'verified';
				feature.verifiedCommit = event.commit;
				feature.flags = event.flags?.length ? event.flags : undefined;
			}
			break;
		case 'feature.escalated':
			if (feature) {
				feature.rung = event.toRung;
				feature.failuresOnRung = 0;
				feature.active = undefined;
				feature.status = 'pending';
			}
			break;
		case 'feature.needs_lead':
			if (feature) {
				feature.status = 'needs_lead';
				feature.needsLeadReason = event.reason;
				feature.active = undefined;
			}
			break;
		case 'feature.ended':
			if (feature && feature.active?.attempt === event.attempt) {
				feature.active = undefined;
				feature.waiting = undefined;
				if (feature.status === 'running' || feature.status === 'verifying') {
					feature.status = 'pending';
					if (event.reason === 'exited' || event.reason === 'launch_failed') {
						feature.failuresOnRung++;
					}
				}
			}
			break;
		case 'feature.launch_failed':
			if (feature) {
				feature.attempts = event.attempt;
				feature.failuresOnRung++;
			}
			break;
		case 'feature.stalled':
		case 'feature.turn_ended':
			break;
		case 'feature.waiting':
			if (feature?.active?.attempt === event.attempt) {
				feature.waiting = event.reason;
			}
			break;
		case 'feature.usage':
			if (feature) {
				feature.usage = addUsage(feature.usage, event.usage);
			}
			break;
		case 'feature.reset':
			if (feature && feature.status === 'verifying' && feature.active?.attempt === event.attempt) {
				feature.status = 'running';
			}
			break;
		case 'feature.reassigned':
			if (feature) {
				feature.ladder = event.ladder;
				feature.rung = 0;
				feature.failuresOnRung = 0;
				feature.regressions = 0;
				if (feature.status === 'needs_lead') {
					feature.status = 'pending';
				}
			}
			break;
		case 'feature.retry':
			if (feature) {
				feature.failuresOnRung = 0;
				feature.regressions = 0;
				if (feature.status === 'needs_lead') {
					feature.status = 'pending';
				}
			}
			break;
		case 'feature.abandoned':
			if (feature) {
				feature.status = 'abandoned';
				feature.active = undefined;
			}
			break;
		case 'feature.fix_requested':
			if (feature) {
				feature.status = 'pending';
				feature.kind = 'fix';
				feature.syncBeforeNext = true;
				feature.fixFindings = event.findings;
				feature.failuresOnRung = 0;
				for (const id of event.findings) {
					const finding = state.findings.get(id);
					if (finding) {
						finding.status = 'fixing';
					}
				}
			}
			break;
		case 'queue.merged': {
			const item = takeItem(state, event.itemId);
			if (!item) {
				break;
			}
			cacheChecks(state, event.checks);
			state.integrationTip = event.commit;
			state.merges.push({ commit: event.commit, parent: event.parent, item, checks: event.checks, flaky: event.flaky, packet: event.packet, at: event.ts });
			markFixed(state, item.resolves, event.commit);
			const merged = item.feature !== undefined ? state.features.get(item.feature) : undefined;
			if (item.kind === 'feature' && merged && merged.status === 'verified') {
				merged.status = 'merged';
				merged.mergedCommit = event.commit;
				merged.kind = 'implement';
				merged.syncBeforeNext = false;
				merged.conflicts = undefined;
				merged.queueChecks = undefined;
				merged.fixFindings = undefined;
			} else if (item.kind === 'lead' && item.leadKind === 'scaffold') {
				state.scaffoldMerged = true;
			} else if (item.kind === 'lead' && item.leadKind === 'implement' && merged) {
				merged.status = 'merged';
				merged.mergedCommit = event.commit;
				merged.kind = 'implement';
				merged.syncBeforeNext = false;
				merged.conflicts = undefined;
				merged.needsLeadReason = undefined;
			}
			break;
		}
		case 'queue.checks_failed': {
			const item = takeItem(state, event.itemId);
			cacheChecks(state, event.checks);
			const failed = item?.kind === 'feature' && item.feature !== undefined ? state.features.get(item.feature) : undefined;
			if (failed && failed.status === 'verified') {
				failed.regressions++;
				failed.queueChecks = event.checks;
				failed.kind = 'regression';
				failed.syncBeforeNext = true;
				if (failed.regressions >= 2) {
					failed.status = 'needs_lead';
					failed.needsLeadReason = 'its merge broke the fast checks twice';
				} else {
					failed.status = 'pending';
				}
			}
			break;
		}
		case 'queue.conflict': {
			const item = takeItem(state, event.itemId);
			const conflicted = item?.kind === 'feature' && item.feature !== undefined ? state.features.get(item.feature) : undefined;
			if (conflicted && conflicted.status === 'verified') {
				conflicted.conflicts = event.paths;
				conflicted.kind = 'resolve';
				conflicted.syncBeforeNext = true;
				if (event.resolver === 'worker') {
					conflicted.status = 'pending';
				} else {
					conflicted.status = 'needs_lead';
					conflicted.needsLeadReason = `merging it conflicts in files it does not own: ${event.paths.join(', ')}`;
				}
			}
			break;
		}
		case 'queue.dropped': {
			const item = takeItem(state, event.itemId);
			const already = item?.kind === 'feature' && item.feature !== undefined ? state.features.get(item.feature) : undefined;
			if (already && event.alreadyIn && already.status === 'verified') {
				already.status = 'merged';
				already.mergedCommit = event.alreadyIn;
				already.kind = 'implement';
				already.syncBeforeNext = false;
			}
			break;
		}
		case 'queue.halted':
			state.queueHalted = event.reason;
			break;
		case 'queue.resumed':
			state.queueHalted = undefined;
			break;
		case 'checks.full':
			cacheChecks(state, event.checks);
			state.fullChecks = { commit: event.commit, checks: event.checks };
			break;
		case 'program.all_merged':
			state.allMergedAt = event.commit;
			break;
		case 'review.recorded': {
			for (const finding of event.added) {
				state.findings.set(finding.id, { ...finding });
			}
			if (event.merge === 'integration') {
				state.integrationReviewed = { tip: state.integrationTip ?? '', at: event.ts };
			} else {
				const record = state.merges.find(merge => merge.commit === event.merge);
				if (record) {
					record.review = { verdict: record.review?.verdict === 'issues' ? 'issues' : event.verdict, findings: [...(record.review?.findings ?? []), ...event.added.map(finding => finding.id)], at: event.ts };
				}
			}
			for (const mark of event.addressed) {
				const finding = state.findings.get(mark.id);
				if (!finding) {
					continue;
				}
				if (mark.addressed) {
					finding.status = 'verified';
				} else {
					finding.status = 'open';
					finding.route = undefined;
					finding.fixedIn = undefined;
					finding.rounds++;
				}
			}
			break;
		}
		case 'findings.routed':
			for (const item of event.items) {
				const finding = state.findings.get(item.id);
				if (finding) {
					finding.route = item.route;
					finding.ruling = item.ruling;
					finding.status = item.route === 'follow-up' ? 'follow-up' : item.route === 'wontfix' ? 'wontfix' : 'fixing';
				}
			}
			break;
		case 'review.completed':
			state.reviewCompleted = { tip: event.tip, summary: event.summary };
			break;
		case 'ship.requested':
			state.ship = { mode: event.mode, tip: event.tip, status: 'awaiting_approval' };
			break;
		case 'ship.cancelled':
			if (state.ship) {
				state.ship.status = 'cancelled';
				state.ship.reason = event.reason;
			}
			break;
		case 'ship.approved':
			if (state.ship) {
				state.ship.status = 'shipping';
			}
			break;
		case 'ship.done':
			if (state.ship) {
				state.ship.status = 'done';
				state.ship.commit = event.commit;
				state.ship.url = event.url;
				state.ship.removed = event.removed;
				state.ship.kept = event.kept;
			}
			state.status = 'shipped';
			for (const each of state.features.values()) {
				each.active = undefined;
			}
			break;
		case 'ship.failed':
			if (state.ship) {
				state.ship.status = 'failed';
				state.ship.reason = event.reason;
			}
			break;
	}
}
