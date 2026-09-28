/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Git } from './git';
import { compileGlob } from './glob';
import { CheckSummary, Cmd, FeatureState, ProgramState, QueueItem } from './model';

/*
 * The merge queue (design doc section 8): the only writer of the integration branch. Like bors or
 * GitHub's merge queue, it builds what the branch would look like after a merge, checks that, and
 * only then moves the branch, by compare-and-swap, from the tip it built on to the checked commit.
 * So the branch never moves backwards and every commit on its first-parent line passed the fast
 * checks (invariants I1 and I2). Nothing here rewrites history (I4).
 *
 * The candidate is only ever checked out in the engine's own integration worktree; the branch
 * itself is checked out nowhere, so moving its ref disturbs no one.
 */

export interface QueueDeps {
	readonly git: Git;
	/** Runs `commands` in `worktree` at `commit`; cached by tree unless `fresh`. */
	runChecks(commands: readonly Cmd[], worktree: string, commit: string, fresh: boolean): Promise<CheckSummary>;
	/** The integration worktree, made on first use. */
	integrationWorktree(): Promise<string>;
}

export type MergeOutcome =
	| { readonly kind: 'merged'; readonly commit: string; readonly parent: string; readonly checks: CheckSummary; readonly flaky: readonly string[] }
	/** The item's commit is already on the integration branch. */
	| { readonly kind: 'already'; readonly tip: string }
	| { readonly kind: 'conflict'; readonly paths: readonly string[] }
	| { readonly kind: 'checks_failed'; readonly candidate: string; readonly checks: CheckSummary }
	/** Something other than the queue moved the integration branch. */
	| { readonly kind: 'moved'; readonly found: string | undefined }
	/** Someone has the integration branch checked out; moving it would change their files under them. */
	| { readonly kind: 'checked_out'; readonly path: string };

/** Where the queue keeps each candidate, so a restart finds a merge the log did not record. */
export function stagedRef(programId: string, itemId: string): string {
	return `refs/facade/${programId}/staged/${itemId}`;
}

/** Merges one item: candidate, fast checks in the integration worktree, compare-and-swap. */
export async function mergeItem(deps: QueueDeps, program: ProgramState, item: QueueItem): Promise<MergeOutcome> {
	const git = deps.git;
	const repo = program.repoRoot;
	const ref = `refs/heads/${program.integrationBranch}`;
	const tip = program.integrationTip!;
	const current = await git.resolveCommit(repo, ref);
	if (current !== tip) {
		return { kind: 'moved', found: current };
	}
	const holder = await git.branchCheckedOutAt(repo, program.integrationBranch!);
	if (holder) {
		return { kind: 'checked_out', path: holder };
	}
	if (await git.isAncestor(repo, item.commit, tip)) {
		return { kind: 'already', tip };
	}
	const merged = await git.mergeTree(repo, tip, item.commit);
	if (merged.conflicts.length) {
		return { kind: 'conflict', paths: merged.conflicts };
	}
	const candidate = await git.commitTree(repo, merged.tree, [tip, item.commit], mergeMessage(program, item));
	await git.setRef(repo, stagedRef(program.id, item.id), candidate);
	const worktree = await deps.integrationWorktree();
	await git.checkoutDetached(worktree, candidate);
	let checks = await deps.runChecks(program.plan.checks.fast, worktree, candidate, false);
	const flaky: string[] = [];
	if (!checks.passed) {
		// Run it again before blaming the change: a check that passes the second time is flaky.
		const again = await deps.runChecks(program.plan.checks.fast, worktree, candidate, true);
		if (!again.passed) {
			return { kind: 'checks_failed', candidate, checks: again };
		}
		flaky.push(...checks.runs.filter(run => run.status !== 'pass').map(run => run.argv.join(' ')));
		checks = again;
	}
	try {
		await git.compareAndSwapRef(repo, ref, candidate, tip);
	} catch {
		return { kind: 'moved', found: await git.resolveCommit(repo, ref) };
	}
	return { kind: 'merged', commit: candidate, parent: tip, checks, flaky };
}

/** The merge commit's message, in English as the repository's rules ask. */
export function mergeMessage(program: ProgramState, item: QueueItem): string {
	const trailers = [`Facade-Program: ${program.id}`];
	let title: string;
	switch (item.kind) {
		case 'feature':
			title = `Merge ${item.feature}: ${item.title}`;
			trailers.push(`Facade-Feature: ${item.feature}`);
			if (item.agent) {
				trailers.push(`Facade-Agent: ${item.agent}, attempt ${item.attempt}`);
			}
			break;
		case 'lead':
			title = item.leadKind === 'scaffold' ? `Merge scaffold: ${item.title}` : item.leadKind === 'implement' ? `Merge ${item.feature}, finished by the lead: ${item.title}` : `Merge lead ${item.leadKind}: ${item.title}`;
			trailers.push(`Facade-Kind: ${item.leadKind}`);
			break;
		case 'sync':
			title = `Merge ${program.plan.base} into ${program.integrationBranch}`;
			break;
	}
	if (item.resolves?.length) {
		trailers.push(`Facade-Resolves: ${item.resolves.join(', ')}`);
	}
	trailers.push('Facade-Checks: fast checks passed on this commit before it entered the branch');
	return `${title}\n\n${trailers.join('\n')}\n`;
}

/**
 * Who resolves a feature's conflict (design doc section 8.2). Features own disjoint files and their
 * changes stay inside them, so a conflict in files the feature owns comes from the lead changing
 * them too: its worker resolves it. Anywhere else means ownership changed under it: the lead decides.
 */
export function conflictResolver(program: ProgramState, feature: FeatureState, paths: readonly string[]): 'worker' | 'lead' {
	return outsideOwnership(program, feature, paths).length ? 'lead' : 'worker';
}

/** The paths that are not the feature's alone: not its own, or also another feature's. */
export function outsideOwnership(program: ProgramState, feature: FeatureState, paths: readonly string[]): string[] {
	const mine = feature.spec.owns.map(pattern => compileGlob(pattern));
	const others = [...program.features.values()].filter(other => other !== feature).flatMap(other => other.spec.owns.map(pattern => compileGlob(pattern)));
	return paths.filter(file => !mine.some(matcher => matcher(file)) || others.some(matcher => matcher(file)));
}

/** Which feature owns `file`, if one does. */
export function ownerOf(program: ProgramState, file: string): FeatureState | undefined {
	return [...program.features.values()].find(feature => feature.spec.owns.some(pattern => compileGlob(pattern)(file)));
}
