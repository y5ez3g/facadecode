/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Git } from './git';
import { CheckSummary, Finding, FindingLocation, FindingRoute, MergeRecord, ProgramState, QueueItem, Severity } from './model';
import { ownerOf } from './queue';
import { criterionId, failedCheckSummary, formatLocations, renderChecks, REPORTED } from './render';
import { formatCommand, interfaceKey } from './validator';

/*
 * Review (design doc section 9). Every merge into the integration branch gets a packet: a file with
 * the rubric, the contract, the evidence and the diff, so a reviewer subagent reads the diff and the
 * lead does not. Reviewers record findings; the lead routes each one; fixes go through the queue
 * and come back for a re-review. `review_complete` holds shipping until the conditions of 9.7 hold.
 */

const MAX_DIFF_BYTES = 400_000;
const DUPLICATE_WINDOW = 8;

export const SEVERITIES: readonly Severity[] = ['blocker', 'major', 'minor', 'nit'];
export const MAX_ROUNDS = 3;

const RUBRIC = [
	'- blocker: wrong behaviour, lost data, a security problem, a broken contract or repository rule, weakened tests. Must be fixed and re-reviewed before shipping.',
	'- major: an expected error path left unhandled, an acceptance criterion without a test, logic duplicated across features, an obvious performance regression. Fixed and re-reviewed, or ruled wontfix with a reason.',
	'- minor: readability, local style, small problems off the critical path. The lead decides whether to fix it now or later.',
	'- nit: preference. Never blocks.'
];

function focusFor(risk: string | undefined): string {
	switch (risk) {
		case 'high': return 'Risk high: two reviewers, each with one lens. Lens 1: correctness and error paths. Lens 2: the contract, the repository rules and the tests.';
		case 'medium': return 'Risk medium: one reviewer. Besides reading the change, check each criterion against the code and its tests.';
		default: return 'Risk low: one reviewer, one careful read-through.';
	}
}

export interface PacketStats {
	readonly path: string;
	readonly files: number;
	readonly added: number;
	readonly removed: number;
}

/** What a merge packet needs from its merge; also works before the merge is in the log. */
export interface MergeFacts {
	readonly commit: string;
	readonly parent: string;
	readonly item: QueueItem;
	readonly checks: CheckSummary;
	readonly flaky?: readonly string[];
}

function fence(text: string, language = 'text'): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
	const ticks = '`'.repeat(longest + 1);
	return `${ticks}${language}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

function countDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			added++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			removed++;
		}
	}
	return { added, removed };
}

/** Writes the review packet of one merge and returns where it is and how big the change is. */
export async function writeMergePacket(git: Git, program: ProgramState, merge: MergeFacts, file: string): Promise<PacketStats> {
	const repo = program.repoRoot;
	const item = merge.item;
	const feature = item.feature !== undefined ? program.features.get(item.feature) : undefined;
	const diff = await git.diffText(repo, merge.parent, merge.commit, 10);
	const changed = await git.diffNames(repo, merge.parent, merge.commit);
	const commits = await git.logOneline(repo, merge.parent, item.commit);
	const lines: string[] = [];
	const what = item.kind === 'feature' ? `${item.feature} ${feature?.spec.title ?? ''}` : item.kind === 'sync' ? `sync with ${program.plan.base}` : `lead ${item.leadKind}${item.feature ? ` of ${item.feature}` : ''}`;
	lines.push(`# Review packet · ${program.id} · ${what.trim()} · merged as ${merge.commit.slice(0, 9)}`, '');
	lines.push(`Record your review with review_record, program_id "${program.id}", target "${merge.commit}".`);
	const resolves = (item.resolves ?? []).map(id => program.findings.get(id)).filter((finding): finding is Finding => !!finding);
	if (resolves.length) {
		lines.push('This change says it fixes the findings below. Mark each one addressed or not addressed in review_record, and look for new problems in this diff only.');
	}
	lines.push('', '## Rubric', '', ...RUBRIC, '', focusFor(feature?.spec.risk));
	if (program.plan.conventions.length) {
		lines.push('', 'Repository rules:', ...program.plan.conventions.map(rule => `- ${rule}`));
	}

	if (resolves.length) {
		lines.push('', '## Findings this change says it fixes', '');
		for (const finding of resolves) {
			lines.push(`- ${finding.id} [${finding.severity}] ${finding.title} (${formatLocations(finding.paths)}), round ${finding.rounds + 1}`, `  ${finding.detail}`);
			if (finding.suggestion) {
				lines.push(`  Suggested: ${finding.suggestion}`);
			}
		}
	}

	lines.push('', '## Contract', '');
	if (feature) {
		const spec = feature.spec;
		lines.push(`Program goal: ${program.plan.goal}`, `Feature goal: ${spec.goal}`, `Owns: ${spec.owns.join(', ')}`);
		if (spec.interfaces?.consumes?.length) {
			lines.push(`Uses: ${spec.interfaces.consumes.join('; ')}`);
		}
		if (spec.interfaces?.provides?.length) {
			lines.push(`Provides: ${spec.interfaces.provides.join('; ')}`);
		}
		lines.push('Criteria:', ...spec.acceptance.criteria.map((criterion, index) => `  ${criterionId(index)}. ${criterion}`));
		lines.push('Commands:', ...spec.acceptance.commands.map(cmd => `  $ ${formatCommand(cmd)}`));
	} else if (item.kind === 'sync') {
		lines.push(`${program.plan.base} moved since the program started. This merge brings it into the integration branch. Review how it combines with the program's changes, not ${program.plan.base}'s own changes.`);
	} else {
		lines.push(`The lead's ${item.leadKind} change: ${item.title}.`, item.leadKind === 'scaffold' ? `The plan's scaffold: ${program.plan.scaffold.summary}\nScaffold paths: ${program.plan.scaffold.paths.join(', ') || 'none'}` : '');
	}

	if (feature?.lastResult && item.kind === 'feature') {
		const result = feature.lastResult;
		const report = [
			`Outcome: ${result.outcome}`,
			`Summary: ${result.summary}`,
			...result.criteria.map(criterion => `${criterion.id} ${criterion.status}${criterion.evidence?.length ? `: ${criterion.evidence.join(' | ')}` : ''}`),
			...(result.assumptions?.length ? ['Assumptions:', ...result.assumptions.map(each => `- ${each}`)] : []),
			...(result.risks?.length ? ['Risks:', ...result.risks.map(each => `- ${each}`)] : [])
		].join('\n');
		lines.push('', '## Worker report', '', REPORTED, fence(report));
	}

	lines.push('', '## Evidence', '');
	if (feature?.lastChecks && item.kind === 'feature') {
		lines.push(`Feature checks on ${feature.lastChecks.tree.slice(0, 9)} (tree): ${feature.lastChecks.passed ? 'pass' : failedCheckSummary(feature.lastChecks)}`, renderChecks(feature.lastChecks));
	}
	lines.push(`Fast checks on this merge: ${merge.checks.passed ? 'pass' : failedCheckSummary(merge.checks)}`, renderChecks(merge.checks) || '  (no fast checks)');
	if (merge.flaky?.length) {
		lines.push(`Flaky: ${merge.flaky.join('; ')} failed once and passed when run again.`);
	}
	if (feature && item.kind === 'feature') {
		lines.push(`Attempts: ${feature.attempts}${item.agent ? `; this one by ${item.agent}` : ''}.`);
		if (feature.flags?.length) {
			lines.push(`Flags: ${feature.flags.join(', ')}.${feature.flags.includes('tests_weakened') ? ' Test files lost cases or assertions: check that nothing was weakened to pass.' : ''}`);
		}
		const answered = [...program.questions.values()].filter(question => question.feature === feature.spec.id);
		for (const question of answered) {
			lines.push(`Question ${question.id}: ${JSON.stringify(question.question)} answered ${question.answeredBy === 'timeout' ? 'by nobody; the worker assumed' : `by the lead: ${JSON.stringify(question.answer ?? '')}`}.`);
		}
	}

	const interactions = await interactionLines(git, program, merge, changed);
	if (interactions.length) {
		lines.push('', '## Interactions', '', ...interactions);
	}

	lines.push('', '## Commits', '', fence(commits.join('\n') || '(none)'));
	const truncated = Buffer.byteLength(diff) > MAX_DIFF_BYTES;
	lines.push('', `## Diff (first parent: git diff -U10 ${merge.parent.slice(0, 9)} ${merge.commit.slice(0, 9)})`, '');
	lines.push(fence(truncated ? `${diff.slice(0, MAX_DIFF_BYTES)}\n... cut at ${MAX_DIFF_BYTES} bytes: run the git diff above for the rest.` : diff || '(no changes)', 'diff'));

	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join('\n')}\n`);
	return { path: file, files: changed.length, ...countDiff(diff) };
}

async function interactionLines(git: Git, program: ProgramState, merge: MergeFacts, changed: readonly string[]): Promise<string[]> {
	const lines: string[] = [];
	const scaffold = new Set(program.plan.scaffold.paths);
	const touchedByScaffold = changed.filter(file => scaffold.has(file));
	if (touchedByScaffold.length && merge.item.leadKind !== 'scaffold') {
		lines.push(`Files here the scaffold also changed: ${touchedByScaffold.join(', ')}`);
	}
	const byOthers = new Map<string, string[]>();
	for (const record of program.merges) {
		if (record.commit === merge.commit || record.item.kind === 'sync') {
			continue;
		}
		const theirs = new Set(await git.diffNames(program.repoRoot, record.parent, record.commit).catch(() => [] as string[]));
		const shared = changed.filter(file => theirs.has(file));
		if (shared.length) {
			byOthers.set(describeItem(record.item), shared);
		}
	}
	for (const [who, files] of byOthers) {
		lines.push(`Files here ${who} also changed: ${files.join(', ')}`);
	}
	const feature = merge.item.feature !== undefined ? program.features.get(merge.item.feature) : undefined;
	const symbols = [...(feature?.spec.interfaces?.provides ?? []), ...(feature?.spec.interfaces?.consumes ?? [])].map(symbolOf).filter((symbol): symbol is string => !!symbol);
	for (const symbol of [...new Set(symbols)].slice(0, 6)) {
		const hits = (await git.grep(program.repoRoot, merge.commit, symbol, 12).catch(() => [] as string[])).filter(hit => !changed.some(file => hit.startsWith(`${file}:`)));
		if (hits.length) {
			lines.push(`Uses of ${symbol} outside this change:`, ...hits.map(hit => `  ${hit.slice(0, 200)}`));
		}
	}
	return lines;
}

function symbolOf(declaration: string): string | undefined {
	const key = interfaceKey(declaration);
	const hash = key.indexOf('#');
	const symbol = hash < 0 ? undefined : key.slice(hash + 1).trim();
	return symbol && /^[\w$.]+$/.test(symbol) ? symbol.split('.').pop() : undefined;
}

export function describeItem(item: QueueItem): string {
	switch (item.kind) {
		case 'feature': return item.feature!;
		case 'sync': return 'the sync with the base branch';
		default: return item.leadKind === 'scaffold' ? 'the scaffold' : `the lead's ${item.leadKind} (${item.id})`;
	}
}

/** The packet for the lead's review of the whole program (design doc section 9.3). */
export async function writeIntegrationPacket(git: Git, program: ProgramState, file: string): Promise<PacketStats> {
	const repo = program.repoRoot;
	const tip = program.integrationTip!;
	const base = program.baseCommit!;
	const lines: string[] = [`# Integration review packet · ${program.id} · ${program.integrationBranch} @ ${tip.slice(0, 9)}`, ''];
	lines.push(
		`Record the result with review_record, program_id "${program.id}", target "integration" - also when you find nothing.`,
		'Read the hotspots first, then the code they point to. Check that the features together meet the goal, agree with each other (names, errors, logging, settings), follow the scaffold\'s interfaces, do not duplicate each other, and leave nothing that no feature owned undone: docs, settings, migrations.',
		'',
		`Goal: ${program.plan.goal}`,
		'',
		'## Features',
		''
	);
	for (const feature of program.features.values()) {
		const open = [...program.findings.values()].filter(finding => finding.feature === feature.spec.id && !['verified', 'wontfix', 'follow-up'].includes(finding.status));
		const merges = program.merges.filter(merge => merge.item.feature === feature.spec.id);
		lines.push(`${feature.spec.id} ${feature.spec.title}: ${feature.status}, ${feature.attempts} attempt${feature.attempts === 1 ? '' : 's'}, ${merges.length} merge${merges.length === 1 ? '' : 's'}${open.length ? `; open: ${open.map(finding => `${finding.id} ${finding.severity}`).join(', ')}` : ''}`);
		if (feature.lastResult) {
			lines.push(`   ${REPORTED} ${JSON.stringify(feature.lastResult.summary.slice(0, 300))}`);
		}
	}

	// Which changes touched which files.
	const touches = new Map<string, Set<string>>();
	const added = new Map<string, AddedBlock[]>();
	for (const merge of program.merges) {
		const who = describeItem(merge.item);
		for (const changed of await git.diffNames(repo, merge.parent, merge.commit)) {
			const set = touches.get(changed) ?? new Set<string>();
			set.add(who);
			touches.set(changed, set);
		}
		if (merge.item.kind === 'feature' && merge.item.feature) {
			const blocks = added.get(merge.item.feature) ?? [];
			blocks.push(...addedBlocks(await git.diffText(repo, merge.parent, merge.commit, 0)));
			added.set(merge.item.feature, blocks);
		}
	}
	const hotspots = [...touches].filter(([, who]) => who.size > 1).sort((a, b) => b[1].size - a[1].size);
	lines.push('', '## Hotspots', '');
	lines.push(...(hotspots.length ? hotspots.slice(0, 40).map(([file, who]) => `- ${file}: ${[...who].join(', ')}`) : ['None: no file was changed by more than one merge.']));

	const duplicates = findDuplicates(added);
	lines.push('', '## Possible duplication', '');
	lines.push(...(duplicates.length ? duplicates.slice(0, 20).map(pair => `- ${pair}`) : [`None found: no block of ${DUPLICATE_WINDOW} or more lines appears in more than one feature.`]));

	const open = [...program.findings.values()].filter(finding => !['verified', 'wontfix', 'follow-up'].includes(finding.status));
	lines.push('', '## Findings not closed', '');
	lines.push(...(open.length ? open.map(finding => `- ${finding.id} [${finding.severity}] ${finding.status}${finding.route ? ` → ${finding.route}` : ''} ${finding.feature ?? ''} ${formatLocations(finding.paths)}: ${finding.title}`) : ['None.']));
	const ruled = [...program.findings.values()].filter(finding => finding.status === 'wontfix' || finding.status === 'follow-up');
	if (ruled.length) {
		lines.push('', 'Rulings so far:', ...ruled.map(finding => `- ${finding.id} ${finding.status}: ${finding.ruling ?? ''}`));
	}

	lines.push('', '## Acceptance criteria', '');
	for (const feature of program.features.values()) {
		lines.push(`${feature.spec.id} ${feature.spec.title}:`, ...feature.spec.acceptance.criteria.map((criterion, index) => `  ${criterionId(index)}. ${criterion}`));
	}

	lines.push('', '## Checks', '');
	if (program.fullChecks) {
		lines.push(`Full checks on ${program.fullChecks.commit.slice(0, 9)}: ${program.fullChecks.checks.passed ? 'pass' : failedCheckSummary(program.fullChecks.checks)}${program.fullChecks.commit === tip ? '' : ' (not the tip: they run again once the queue is empty and every feature is merged)'}`, renderChecks(program.fullChecks.checks));
	} else {
		lines.push('The full checks have not run yet.');
	}

	const stat = await git.diffStat(repo, base, tip);
	lines.push('', `## Diffstat ${program.plan.base}@${base.slice(0, 9)}..${tip.slice(0, 9)}`, '', fence(stat || '(no changes)'));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${lines.join('\n')}\n`);
	return { path: file, files: touches.size, ...countDiff(await git.diffText(repo, base, tip, 0)) };
}

interface AddedBlock {
	readonly file: string;
	/** Normalized lines, and the line in the new file each came from. */
	readonly lines: readonly { readonly text: string; readonly line: number }[];
}

/** Lines each hunk adds, normalized for comparison; lines that say nothing on their own are left out. */
export function addedBlocks(diff: string): AddedBlock[] {
	const blocks: AddedBlock[] = [];
	let file = '';
	let current: { text: string; line: number }[] = [];
	let next = 0;
	const flush = () => {
		if (current.length) {
			blocks.push({ file, lines: current });
			current = [];
		}
	};
	for (const raw of diff.split('\n')) {
		if (raw.startsWith('+++ ')) {
			flush();
			file = raw.slice(4).replace(/^b\//, '');
		} else if (raw.startsWith('@@')) {
			flush();
			next = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
		} else if (raw.startsWith('+')) {
			const text = raw.slice(1).trim().replace(/\s+/g, ' ');
			if (/[A-Za-z0-9]/.test(text) && text.length > 3) {
				current.push({ text, line: next });
			}
			next++;
		} else if (!raw.startsWith('-')) {
			flush();
		}
	}
	flush();
	return blocks;
}

/** Windows of lines that more than one feature added, as readable pairs. */
export function findDuplicates(byFeature: ReadonlyMap<string, readonly AddedBlock[]>): string[] {
	const seen = new Map<string, { feature: string; file: string; from: number; to: number }[]>();
	for (const [feature, blocks] of byFeature) {
		for (const block of blocks) {
			for (let start = 0; start + DUPLICATE_WINDOW <= block.lines.length; start++) {
				const window = block.lines.slice(start, start + DUPLICATE_WINDOW);
				const key = window.map(line => line.text).join('\n');
				const list = seen.get(key) ?? [];
				list.push({ feature, file: block.file, from: window[0].line, to: window[window.length - 1].line });
				seen.set(key, list);
			}
		}
	}
	const pairs = new Map<string, string>();
	for (const places of seen.values()) {
		const features = new Set(places.map(place => place.feature));
		if (features.size < 2) {
			continue;
		}
		const [first, ...rest] = places;
		for (const other of rest.filter(place => place.feature !== first.feature)) {
			const key = `${first.feature}:${first.file}|${other.feature}:${other.file}`;
			if (!pairs.has(key)) {
				pairs.set(key, `${first.feature} ${first.file}:${first.from}-${first.to} and ${other.feature} ${other.file}:${other.from}-${other.to}`);
			}
		}
	}
	return [...pairs.values()];
}

/*
 * Findings
 */

function words(text: string): Set<string> {
	return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2));
}

/** A finding already recorded at the same place with a similar title: two reviewers saw the same thing. */
export function similarFinding(existing: Iterable<Finding>, merge: string, location: FindingLocation | undefined, title: string): Finding | undefined {
	const wanted = words(title);
	for (const finding of existing) {
		const place = finding.paths[0];
		if (finding.merge !== merge || !place || !location || place.path !== location.path) {
			continue;
		}
		if (place.line !== undefined && location.line !== undefined && Math.abs(place.line - location.line) > 3) {
			continue;
		}
		const theirs = words(finding.title);
		const shared = [...wanted].filter(word => theirs.has(word)).length;
		const union = new Set([...wanted, ...theirs]).size;
		if (union === 0 || shared / union >= 0.5) {
			return finding;
		}
	}
	return undefined;
}

/** The feature a finding belongs to: the merged feature, else whoever owns its first path. */
export function featureOfFinding(program: ProgramState, record: MergeRecord | undefined, paths: readonly FindingLocation[]): string | undefined {
	if (record?.item.kind === 'feature') {
		return record.item.feature;
	}
	return paths[0] ? ownerOf(program, paths[0].path)?.spec.id : undefined;
}

/** Why a route is not allowed, or undefined when it is (design doc sections 9.4 to 9.6). */
export function routeProblem(program: ProgramState, finding: Finding, route: FindingRoute, ruling: string | undefined): string | undefined {
	if (finding.status !== 'open') {
		return `${finding.id} is ${finding.status}; only open findings can be routed.`;
	}
	if ((route === 'follow-up' || route === 'wontfix') && !ruling?.trim()) {
		return `${finding.id}: a ${route} needs a ruling, the reason the person reads before shipping.`;
	}
	if (route === 'follow-up' && finding.severity === 'blocker') {
		return `${finding.id} is a blocker: it cannot wait for a follow-up.`;
	}
	if (finding.rounds >= MAX_ROUNDS) {
		if (route === 'worker') {
			return `${finding.id} has had ${finding.rounds} fix rounds. Rule on it: wontfix or follow-up with a reason${finding.severity === 'blocker' ? ', fix it yourself (lead), or ask the user' : ''}.`;
		}
		if (route === 'lead' && finding.severity !== 'blocker') {
			return `${finding.id} has had ${finding.rounds} fix rounds. Rule on it: wontfix or follow-up with a reason.`;
		}
	}
	if (route === 'worker') {
		const feature = finding.feature !== undefined ? program.features.get(finding.feature) : undefined;
		if (!feature) {
			return `${finding.id} is in no feature's files; route it to the lead.`;
		}
		if (feature.status === 'abandoned') {
			return `${feature.spec.id} is abandoned; route ${finding.id} to the lead.`;
		}
		if (feature.status !== 'merged') {
			return `${feature.spec.id} is ${feature.status}; route ${finding.id} after its current work merges, or to the lead.`;
		}
	}
	return undefined;
}

/** What still stands between the program and `review_complete` (design doc section 9.7). */
export function completionProblems(program: ProgramState): string[] {
	const problems: string[] = [];
	const features = [...program.features.values()];
	const unmerged = features.filter(feature => feature.status !== 'merged' && feature.status !== 'abandoned');
	if (unmerged.length) {
		problems.push(`Not merged yet: ${unmerged.map(feature => `${feature.spec.id} (${feature.status})`).join(', ')}.`);
	}
	if (program.queue.length) {
		problems.push(`The merge queue still holds ${program.queue.map(item => item.id).join(', ')}.`);
	}
	const tip = program.integrationTip;
	if (!program.fullChecks || program.fullChecks.commit !== tip) {
		problems.push('The full checks have not passed on the integration tip yet; they run once the queue is empty and every feature is merged.');
	} else if (!program.fullChecks.checks.passed) {
		problems.push(`The full checks fail on the tip: ${failedCheckSummary(program.fullChecks.checks)}. Fix it (lead_submit kind "fix") or route a finding.`);
	}
	const findings = [...program.findings.values()];
	const blocking = findings.filter(finding => (finding.severity === 'blocker' || finding.severity === 'major') && (finding.status === 'open' || finding.status === 'fixing'));
	if (blocking.length) {
		problems.push(`Blocker or major findings still open or being fixed: ${blocking.map(finding => `${finding.id} (${finding.status})`).join(', ')}.`);
	}
	const unverified = findings.filter(finding => finding.status === 'fixed');
	if (unverified.length) {
		problems.push(`Fixed but not re-reviewed: ${unverified.map(finding => `${finding.id} in ${finding.fixedIn?.slice(0, 9)}`).join(', ')}.`);
	}
	const unreviewed = program.merges.filter(merge => !merge.review);
	if (unreviewed.length) {
		problems.push(`Merges without a review: ${unreviewed.map(merge => `${merge.commit.slice(0, 9)} (${describeItem(merge.item)})`).join(', ')}. Start facade-reviewer on each packet.`);
	}
	if (!program.integrationReviewed) {
		problems.push('The review of the whole program is not recorded: review_packet with target "integration", review it, then review_record with target "integration".');
	}
	return problems;
}

export function severityRank(severity: Severity): number {
	return SEVERITIES.indexOf(severity);
}
