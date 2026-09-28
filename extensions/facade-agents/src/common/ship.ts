/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Git } from './git';
import { formatAgent, ProgramState, ShipMode, UsageRecord } from './model';
import { formatUsage } from './render';

/*
 * Shipping (design doc section 10): the integration branch, reviewed and fully checked, goes into
 * the base branch once the person approves it in Facade. The base branch only ever gets the tree
 * that was reviewed and checked (invariant I3), and never by rewriting history (I4).
 *
 *   merge   `git merge --no-ff` where the base branch is checked out and clean; where it is checked
 *           out nowhere, a merge commit made with commit-tree and a compare-and-swap of its ref.
 *   squash  one commit with the integration tree on top of the base branch.
 *   pr      push the integration branch and open a pull request with `gh`.
 */

export class ShipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ShipError';
	}
}

export interface ShipDeps {
	readonly git: Git;
	/** Runs a program such as `gh` with an argument array; resolves with its exit code and output. */
	run(argv: readonly string[], cwd: string): Promise<{ readonly exitCode: number | null; readonly output: string }>;
}

/** What `ship` needs before it asks the person, beyond the base branch being merged in. */
export function shipProblems(program: ProgramState): string[] {
	const problems: string[] = [];
	const tip = program.integrationTip;
	if (program.status !== 'running' && program.status !== 'paused') {
		problems.push(`Program ${program.id} is ${program.status}.`);
	}
	if (!program.reviewCompleted || program.reviewCompleted.tip !== tip) {
		problems.push(program.reviewCompleted ? 'The integration branch moved since review_complete was accepted: review the new merges and call review_complete again.' : 'review_complete has not been accepted yet.');
	}
	if (!program.fullChecks || program.fullChecks.commit !== tip || !program.fullChecks.checks.passed) {
		problems.push('The full checks have not passed on the integration tip.');
	}
	if (program.queue.length) {
		problems.push(`The merge queue still holds ${program.queue.map(item => item.id).join(', ')}.`);
	}
	const working = [...program.features.values()].filter(feature => feature.status === 'running' || feature.status === 'verifying' || feature.status === 'pending' || feature.status === 'verified');
	if (working.length) {
		problems.push(`Still in progress: ${working.map(feature => feature.spec.id).join(', ')}.`);
	}
	if (program.ship && (program.ship.status === 'awaiting_approval' || program.ship.status === 'shipping')) {
		problems.push('Shipping was already requested and waits for the person.');
	}
	return problems;
}

/** The merge message: what the person approves and what the base branch's history keeps. English. */
export function shipMessage(program: ProgramState, mode: ShipMode): string {
	const goal = program.plan.goal.split('\n')[0].trim();
	const title = mode === 'squash' ? truncate(goal, 72) : truncate(`Merge ${program.integrationBranch}: ${goal}`, 100);
	const lines = [title, '', ...wrap(program.plan.approach, 72), ''];
	lines.push('Features');
	const width = Math.max(...[...program.features.values()].map(feature => `${feature.spec.id} ${feature.spec.title}`.length), 10) + 2;
	for (const feature of program.features.values()) {
		const agents = [...new Set(program.merges.filter(merge => merge.item.feature === feature.spec.id).map(merge => merge.item.agent ?? (merge.item.kind === 'lead' ? 'lead' : undefined)).filter((agent): agent is string => !!agent))];
		const fixes = program.merges.filter(merge => merge.item.kind === 'feature' && merge.item.feature === feature.spec.id).length - 1;
		const detail = feature.status === 'abandoned' ? 'abandoned' : `${agents.join(', ') || (feature.active ? formatAgent(feature.active.agent) : '-')}, ${feature.attempts} attempt${feature.attempts === 1 ? '' : 's'}${fixes > 0 ? `, ${fixes} review fix${fixes === 1 ? '' : 'es'}` : ''}`;
		lines.push(`  ${`${feature.spec.id} ${feature.spec.title}`.padEnd(width)}${detail}`);
	}
	const findings = [...program.findings.values()];
	const count = (status: string) => findings.filter(finding => finding.status === status).length;
	lines.push(`Review: ${findings.length} finding${findings.length === 1 ? '' : 's'}; ${count('verified')} fixed and verified, ${count('follow-up')} follow-up, ${count('wontfix')} wontfix${count('open') ? `, ${count('open')} minor or nit left open` : ''}`);
	const ruled = findings.filter(finding => finding.status === 'follow-up' || finding.status === 'wontfix');
	if (ruled.length) {
		lines.push('Rulings');
		for (const finding of ruled) {
			lines.push(`  ${finding.id} ${finding.status}: ${finding.title}; ${finding.ruling ?? ''}`);
		}
	}
	const full = program.fullChecks;
	if (full) {
		lines.push(`Checks: full ${full.checks.passed ? 'pass' : 'FAIL'} on ${full.commit.slice(0, 9)}${full.checks.runs.length ? ` (${full.checks.runs.map(run => run.argv.join(' ')).join('; ')})` : ''}`);
	}
	const usage = totalUsage(program);
	if (usage) {
		lines.push(`Agents: ${formatUsage(usage)} reported by the workers`);
	}
	if (program.reviewCompleted?.summary) {
		lines.push('', ...wrap(program.reviewCompleted.summary, 72));
	}
	lines.push('', `Facade-Program: ${program.id}`);
	return `${lines.join('\n')}\n`;
}

export function totalUsage(program: ProgramState): UsageRecord | undefined {
	let total: UsageRecord | undefined;
	for (const feature of program.features.values()) {
		const usage = feature.usage;
		if (!usage) {
			continue;
		}
		total = total ? {
			inputTokens: total.inputTokens + usage.inputTokens,
			outputTokens: total.outputTokens + usage.outputTokens,
			cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
			cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
			costUsd: total.costUsd !== undefined || usage.costUsd !== undefined ? (total.costUsd ?? 0) + (usage.costUsd ?? 0) : undefined
		} : usage;
	}
	return total;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split(/\n\s*\n/)) {
		let line = '';
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			if (line && line.length + word.length + 1 > width) {
				lines.push(line);
				line = word;
			} else {
				line = line ? `${line} ${word}` : word;
			}
		}
		if (line) {
			lines.push(line);
		}
		lines.push('');
	}
	while (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Puts the reviewed integration tip into the base branch. Throws a ShipError, having changed
 * nothing, when it cannot. Returns the base branch's new commit, or the pull request.
 */
export async function shipToBase(deps: ShipDeps, program: ProgramState, mode: ShipMode, message: string): Promise<{ commit?: string; url?: string }> {
	const git = deps.git;
	const repo = program.repoRoot;
	const tip = program.integrationTip!;
	const base = program.plan.base;
	const baseRef = `refs/heads/${base}`;
	const baseTip = await git.resolveCommit(repo, baseRef);
	if (!baseTip) {
		throw new ShipError(`The base branch ${base} no longer exists.`);
	}
	if (!await git.isAncestor(repo, baseTip, tip)) {
		throw new ShipError(`${base} moved after the review. Call ship again: Facade merges it into the integration branch first.`);
	}
	const tree = await git.tree(repo, tip);

	if (mode === 'pr') {
		const remote = await git.remoteFor(repo, base);
		if (!remote) {
			throw new ShipError('The repository has no remote to push the integration branch to.');
		}
		await git.push(repo, remote, program.integrationBranch!);
		const [title, , ...body] = message.split('\n');
		const bodyFile = path.join(os.tmpdir(), `facade-pr-${process.pid}-${Date.now()}.md`);
		fs.writeFileSync(bodyFile, body.join('\n'));
		try {
			const result = await deps.run(['gh', 'pr', 'create', '--base', base, '--head', program.integrationBranch!, '--title', title, '--body-file', bodyFile], repo);
			if (result.exitCode !== 0) {
				throw new ShipError(`The branch is pushed, but gh pr create failed: ${result.output.trim().split('\n').slice(-3).join(' ')}`);
			}
			const url = result.output.split(/\s+/).reverse().find(word => /^https?:\/\//.test(word));
			return { url };
		} finally {
			fs.rmSync(bodyFile, { force: true });
		}
	}

	const holder = await git.branchCheckedOutAt(repo, base);
	let commit: string;
	if (holder) {
		// Someone's worktree has the base branch: merge there, so its files and index stay in step.
		const dirty = await git.isDirty(holder);
		if (dirty.length) {
			throw new ShipError(`${base} is checked out in ${holder} with uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}). Commit or stash them there and ship again, or ship as a pull request.`);
		}
		const expected = await git.mergeTree(repo, baseTip, tip);
		if (expected.conflicts.length || expected.tree !== tree) {
			throw new ShipError(`Merging into ${base} would not give the reviewed tree; nothing was changed.`);
		}
		await git.mergeWithMessage(holder, tip, message, mode === 'squash');
		commit = await git.head(holder);
	} else {
		commit = await git.commitTree(repo, tree, mode === 'squash' ? [baseTip] : [baseTip, tip], message);
		await git.compareAndSwapRef(repo, baseRef, commit, baseTip, `facade: ship ${program.id}`);
	}
	const shipped = await git.tree(repo, commit);
	if (shipped !== tree) {
		// Cannot happen when the checks above held; say so loudly rather than hide it.
		throw new ShipError(`${base} moved to ${commit.slice(0, 9)}, but its tree ${shipped.slice(0, 9)} is not the reviewed tree ${tree.slice(0, 9)}. Check ${base} before anything else.`);
	}
	return { commit };
}

export interface CleanupPlan {
	readonly worktrees: readonly string[];
	/** Files Facade wrote into each worktree for its agents, relative to the worktree. */
	readonly injected?: ReadonlyMap<string, readonly string[]>;
	/** Branches Facade created, with the commits they must still point at to be deleted. */
	readonly branches: readonly string[];
	/** Whether the integration branch goes too: only when the base branch contains it. */
	readonly deleteIntegration: boolean;
}

/**
 * Removes the worktrees and branches Facade made (design doc section 10.4). Anything that would lose
 * work stays: a worktree with changes, a branch with commits the integration branch does not have.
 * Branches the person made are never touched.
 */
export async function cleanup(git: Git, program: ProgramState, plan: CleanupPlan): Promise<{ removed: string[]; kept: string[] }> {
	const repo = program.repoRoot;
	const removed: string[] = [];
	const kept: string[] = [];
	const failedWorktrees = new Set<string>();
	for (const worktree of plan.worktrees) {
		if (!await git.hasWorktree(repo, worktree)) {
			continue;
		}
		try {
			// Facade's own files go first, so they do not keep git from removing the worktree.
			for (const file of plan.injected?.get(worktree) ?? []) {
				await removeInjected(git, worktree, file);
			}
			await git.removeWorktree(repo, worktree);
			removed.push(worktree);
		} catch (err) {
			failedWorktrees.add(worktree);
			kept.push(`${worktree} (${firstLine((err as Error).message)})`);
		}
	}
	const tip = program.integrationTip!;
	const branches = [...plan.branches, ...(plan.deleteIntegration ? [program.integrationBranch!] : [])];
	for (const branch of [...new Set(branches)]) {
		const ref = `refs/heads/${branch}`;
		const at = await git.resolveCommit(repo, ref);
		if (!at) {
			continue;
		}
		const holder = await git.branchCheckedOutAt(repo, branch);
		if (holder) {
			kept.push(`${branch} (checked out in ${holder})`);
			continue;
		}
		const contained = branch === program.integrationBranch ? await git.isAncestor(repo, at, `refs/heads/${program.plan.base}`) : await git.isAncestor(repo, at, tip);
		if (!contained) {
			kept.push(`${branch} (has commits that were not shipped)`);
			continue;
		}
		try {
			await git.deleteRef(repo, ref, at);
			removed.push(branch);
		} catch (err) {
			kept.push(`${branch} (${firstLine((err as Error).message)})`);
		}
	}
	return { removed, kept };
}

/** A file Facade wrote for an agent: back to the repository's version, or gone with its empty folders. */
async function removeInjected(git: Git, worktree: string, file: string): Promise<void> {
	const target = path.join(worktree, file);
	if (!fs.existsSync(target)) {
		return;
	}
	if (await git.isTracked(worktree, file)) {
		await git.restoreFile(worktree, file);
		return;
	}
	fs.rmSync(target, { force: true });
	for (let dir = path.dirname(target); dir.length > worktree.length && fs.existsSync(dir) && !fs.readdirSync(dir).length; dir = path.dirname(dir)) {
		fs.rmdirSync(dir);
	}
}

function firstLine(text: string): string {
	return text.split('\n')[0].slice(0, 200);
}
