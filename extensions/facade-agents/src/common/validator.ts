/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { compileGlob, isGlob, normalizePath, PathMatcher } from './glob';
import { Cmd, FeatureSpec, LEAD_RUNG, parseRung, ProgramPlan } from './model';

/*
 * The checks `plan_save` runs before a plan can go to the person (design doc section 6.2). All of
 * it is pure: the engine gathers the repository's files, the installed agents and the approved
 * commands, and this decides.
 */

export type PlanRule = 'V0' | 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8' | 'V9';

export interface PlanIssue {
	readonly rule: PlanRule;
	readonly message: string;
	readonly feature?: string;
}

export interface PlanValidation {
	readonly errors: readonly PlanIssue[];
	readonly warnings: readonly PlanIssue[];
	/** Commands this repository has not approved yet, as `commandKey` gives them. */
	readonly newCommands: readonly string[];
}

export interface ValidationContext {
	/** `git ls-files` of the base, relative to the repository root. */
	readonly trackedFiles: readonly string[];
	readonly hotspots: readonly string[];
	/** Every agent id the catalogue knows. */
	readonly knownAgents: ReadonlySet<string>;
	/** The ones installed on this machine. */
	readonly availableAgents: ReadonlySet<string>;
	/** The ladder a feature gets when neither it nor the plan names one. */
	readonly defaultLadder: readonly string[];
	readonly approvedCommands: ReadonlySet<string>;
	/** Other programs in this repository that have not finished. */
	readonly otherPrograms: readonly { readonly id: string; readonly owns: readonly string[] }[];
	readonly ignoreCase?: boolean;
}

export const LIMITS = {
	minFeatures: 2,
	maxFeatures: 12,
	goal: 4000,
	approach: 2000,
	title: 80,
	featureGoal: 4000,
	listItem: 500,
	idPattern: /^[a-z][a-z0-9-]{0,31}$/
} as const;

/** Identifies a command for approval: the same arguments in the same folder. */
export function commandKey(cmd: Cmd): string {
	return JSON.stringify([normalizePath(cmd.cwd ?? '.'), ...cmd.argv]);
}

/** How a person reads a command in an approval: `folder> argv`. */
export function formatCommand(cmd: Cmd): string {
	const cwd = normalizePath(cmd.cwd ?? '.');
	const line = cmd.argv.map(arg => /[\s"']/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
	return cwd === '.' ? line : `${cwd}> ${line}`;
}

/** The ladder a feature climbs: its own, else the plan's, else the default. */
export function ladderOf(plan: ProgramPlan, feature: FeatureSpec, defaultLadder: readonly string[], override?: readonly string[]): readonly string[] {
	return override ?? feature.ladder ?? plan.policy?.ladder ?? defaultLadder;
}

/** `path#Symbol(args): Type` and `path#Symbol` both name `path#Symbol`. */
export function interfaceKey(declaration: string): string {
	const trimmed = declaration.trim();
	const hash = trimmed.indexOf('#');
	if (hash < 0) {
		return trimmed.split(/[\s(:]/)[0];
	}
	const path = normalizePath(trimmed.slice(0, hash));
	const symbol = trimmed.slice(hash + 1).split(/[\s(:<]/)[0];
	return `${path}#${symbol}`;
}

export function validatePlan(plan: ProgramPlan, context: ValidationContext): PlanValidation {
	const errors: PlanIssue[] = [];
	const warnings: PlanIssue[] = [];
	const shape = checkShape(plan);
	if (shape.length) {
		// The rest assumes the shape; report it alone.
		return { errors: shape, warnings, newCommands: [] };
	}

	const features = plan.features;
	checkGraph(features, errors);
	checkOwnership(plan, context, errors, warnings);
	checkInterfaces(plan, errors);
	checkLadders(plan, context, errors, warnings);

	if (features.length < LIMITS.minFeatures || features.length > LIMITS.maxFeatures) {
		errors.push({ rule: 'V6', message: `A program has ${LIMITS.minFeatures} to ${LIMITS.maxFeatures} features; this one has ${features.length}. Fewer than ${LIMITS.minFeatures}: do the work yourself.` });
	}
	if (plan.checks.full.length === 0) {
		warnings.push({ rule: 'V5', message: 'checks.full is empty: nothing will run the repository\'s own gate before the program ships.' });
	}

	const newCommands = new Set<string>();
	for (const cmd of allCommands(plan)) {
		const key = commandKey(cmd);
		if (!context.approvedCommands.has(key)) {
			newCommands.add(key);
		}
	}
	return { errors, warnings, newCommands: [...newCommands] };
}

function* allCommands(plan: ProgramPlan): Iterable<Cmd> {
	yield* plan.checks.fast;
	yield* plan.checks.full;
	for (const feature of plan.features) {
		yield* feature.acceptance.commands;
	}
}

/** V0 (shape), V5 (commands) and V6 (sizes): what JSON schema would say, in words a model can act on. */
function checkShape(plan: ProgramPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const fail = (message: string, feature?: string, rule: PlanRule = 'V0') => issues.push({ rule, message, feature });
	const isText = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
	const isTextList = (value: unknown, allowEmpty: boolean) => Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(item => isText(item, LIMITS.listItem));

	if (!plan || typeof plan !== 'object') {
		return [{ rule: 'V0', message: 'The plan must be an object.' }];
	}
	if (plan.schema !== 1) {
		fail('schema must be 1.');
	}
	if (!isText(plan.goal, LIMITS.goal)) {
		fail(`goal must be non-empty text of at most ${LIMITS.goal} characters.`);
	}
	if (!isText(plan.approach, LIMITS.approach)) {
		fail(`approach must be non-empty text of at most ${LIMITS.approach} characters.`);
	}
	if (!isText(plan.base, 200)) {
		fail('base must name a branch, for example "main".');
	}
	if (plan.integrationBranch !== undefined && !isText(plan.integrationBranch, 200)) {
		fail('integrationBranch, when given, must be a branch name.');
	}
	if (!isTextList(plan.conventions, true)) {
		fail('conventions must be a list of short rules (it may be empty).');
	}
	if (!plan.scaffold || typeof plan.scaffold !== 'object' || typeof plan.scaffold.summary !== 'string' || !isTextList(plan.scaffold.paths, true) || (plan.scaffold.provides !== undefined && !isTextList(plan.scaffold.provides, true))) {
		fail('scaffold must be { summary, paths[], provides?[] }. Use empty lists when the program needs no scaffold.');
	}
	if (!plan.checks || !isCommandList(plan.checks.fast) || !Array.isArray(plan.checks.full) || !plan.checks.full.every(isCommand)) {
		fail('checks must be { fast: Cmd[], full: Cmd[] }, where a Cmd is { argv: string[], cwd?, timeoutSec? }.');
	} else if (plan.checks.fast.length === 0) {
		fail('checks.fast needs at least one command: it verifies the scaffold and every merge.', undefined, 'V5');
	}
	if (!Array.isArray(plan.features)) {
		fail('features must be a list.');
		return issues;
	}
	plan.features.forEach((feature, index) => {
		const id = feature && typeof feature.id === 'string' ? feature.id : `#${index + 1}`;
		if (!feature || typeof feature !== 'object') {
			fail(`Feature ${id} must be an object.`);
			return;
		}
		if (typeof feature.id !== 'string' || !LIMITS.idPattern.test(feature.id)) {
			fail(`Feature ${id}: id must be lowercase letters, digits and dashes, starting with a letter, like "f1".`, id);
		}
		if (!isText(feature.title, LIMITS.title)) {
			fail(`Feature ${id}: title must be non-empty text of at most ${LIMITS.title} characters.`, id);
		}
		if (!isText(feature.goal, LIMITS.featureGoal)) {
			fail(`Feature ${id}: goal must describe the outcome.`, id);
		}
		if (!isTextList(feature.owns, false)) {
			fail(`Feature ${id}: owns must list at least one path or glob.`, id);
		}
		if (feature.reads !== undefined && !isTextList(feature.reads, true)) {
			fail(`Feature ${id}: reads must be a list of paths or symbols.`, id);
		}
		const interfaces = feature.interfaces;
		if (interfaces !== undefined && (typeof interfaces !== 'object' || (interfaces.consumes !== undefined && !isTextList(interfaces.consumes, true)) || (interfaces.provides !== undefined && !isTextList(interfaces.provides, true)))) {
			fail(`Feature ${id}: interfaces must be { consumes?: string[], provides?: string[] }.`, id);
		}
		if (!feature.acceptance || !isTextList(feature.acceptance.criteria, false)) {
			fail(`Feature ${id}: acceptance.criteria must list at least one criterion.`, id);
		}
		if (!feature.acceptance || !isCommandList(feature.acceptance.commands)) {
			fail(`Feature ${id}: acceptance.commands needs at least one command that fails before the work and passes after.`, id, 'V5');
		} else {
			const criteria = Array.isArray(feature.acceptance.criteria) ? feature.acceptance.criteria.length : 0;
			for (const cmd of feature.acceptance.commands) {
				for (const covered of cmd.covers ?? []) {
					if (!Number.isInteger(covered) || covered < 1 || covered > criteria) {
						fail(`Feature ${id}: covers ${covered} does not name one of its ${criteria} criteria (they count from 1).`, id);
					}
				}
			}
		}
		if (feature.dependsOn !== undefined && !(Array.isArray(feature.dependsOn) && feature.dependsOn.every((dep: unknown) => typeof dep === 'string'))) {
			fail(`Feature ${id}: dependsOn must be a list of feature ids.`, id);
		}
		if (feature.size !== 'S' && feature.size !== 'M') {
			fail(`Feature ${id}: size must be "S" (up to 150 changed lines) or "M" (up to 400). Split anything larger.`, id, 'V6');
		}
		if (feature.risk !== 'low' && feature.risk !== 'medium' && feature.risk !== 'high') {
			fail(`Feature ${id}: risk must be "low", "medium" or "high".`, id);
		}
		if (feature.ladder !== undefined && !isTextList(feature.ladder, false)) {
			fail(`Feature ${id}: ladder must list agents, for example ["codex", "lead"].`, id);
		}
		if (feature.detail !== undefined && feature.detail !== 'brief' && feature.detail !== 'full') {
			fail(`Feature ${id}: detail must be "brief" or "full".`, id);
		}
	});
	return issues;
}

function isCommand(value: unknown): value is Cmd {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const cmd = value as Cmd;
	return Array.isArray(cmd.argv) && cmd.argv.length > 0 && cmd.argv.every(arg => typeof arg === 'string') && cmd.argv[0].trim().length > 0
		&& (cmd.cwd === undefined || (typeof cmd.cwd === 'string' && !normalizePath(cmd.cwd).split('/').includes('..')))
		&& (cmd.timeoutSec === undefined || (Number.isInteger(cmd.timeoutSec) && cmd.timeoutSec >= 5 && cmd.timeoutSec <= 7200))
		&& (cmd.covers === undefined || Array.isArray(cmd.covers));
}

function isCommandList(value: unknown): value is Cmd[] {
	return Array.isArray(value) && value.length > 0 && value.every(isCommand);
}

/** V1: unique ids, dependencies that exist, no cycles. */
function checkGraph(features: readonly FeatureSpec[], errors: PlanIssue[]): void {
	const ids = new Set<string>();
	for (const feature of features) {
		if (ids.has(feature.id)) {
			errors.push({ rule: 'V1', message: `Two features share the id ${feature.id}.`, feature: feature.id });
		}
		ids.add(feature.id);
	}
	for (const feature of features) {
		for (const dep of feature.dependsOn ?? []) {
			if (dep === feature.id) {
				errors.push({ rule: 'V1', message: `Feature ${feature.id} depends on itself.`, feature: feature.id });
			} else if (!ids.has(dep)) {
				errors.push({ rule: 'V1', message: `Feature ${feature.id} depends on ${dep}, which the plan does not have.`, feature: feature.id });
			}
		}
	}
	const cycle = findCycle(features);
	if (cycle) {
		errors.push({ rule: 'V1', message: `The dependencies go round in a circle: ${cycle.join(' -> ')}.` });
	}
}

function findCycle(features: readonly FeatureSpec[]): string[] | undefined {
	const byId = new Map(features.map(feature => [feature.id, feature]));
	const state = new Map<string, 'visiting' | 'done'>();
	const stack: string[] = [];
	const visit = (id: string): string[] | undefined => {
		const current = state.get(id);
		if (current === 'done') {
			return undefined;
		}
		if (current === 'visiting') {
			return [...stack.slice(stack.indexOf(id)), id];
		}
		state.set(id, 'visiting');
		stack.push(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			if (byId.has(dep)) {
				const cycle = visit(dep);
				if (cycle) {
					return cycle;
				}
			}
		}
		stack.pop();
		state.set(id, 'done');
		return undefined;
	};
	for (const feature of features) {
		const cycle = visit(feature.id);
		if (cycle) {
			return cycle;
		}
	}
	return undefined;
}

/** V2 (no two features own a path), V3 (hotspots only in the scaffold) and V8 (other programs). */
function checkOwnership(plan: ProgramPlan, context: ValidationContext, errors: PlanIssue[], warnings: PlanIssue[]): void {
	const ignoreCase = context.ignoreCase;
	const owners = plan.features.map(feature => ({ id: feature.id, patterns: feature.owns, matchers: feature.owns.map(pattern => safeCompile(pattern, ignoreCase, errors, feature.id)) }));
	const hotspots = context.hotspots.map(pattern => compileGlob(pattern, ignoreCase));
	const matchesHotspot = (path: string) => hotspots.some(matcher => matcher(path));

	// Paths that exist, plus the literal paths features and the scaffold name, which may not exist yet.
	const candidates = new Set<string>(context.trackedFiles.map(normalizePath));
	for (const owner of owners) {
		for (const pattern of owner.patterns) {
			if (!isGlob(pattern)) {
				candidates.add(normalizePath(pattern));
			}
		}
	}
	for (const path of plan.scaffold.paths) {
		if (!isGlob(path)) {
			candidates.add(normalizePath(path));
		}
	}

	const reported = new Set<string>();
	for (const path of candidates) {
		const claimants = owners.filter(owner => owner.matchers.some(matcher => matcher(path))).map(owner => owner.id);
		if (claimants.length > 1) {
			const key = claimants.join(',');
			if (!reported.has(key)) {
				reported.add(key);
				errors.push({ rule: 'V2', message: `${claimants.join(' and ')} both own ${path}. Give each path one owner, or move what they share into the scaffold.` });
			}
		}
		if (claimants.length > 0 && matchesHotspot(path)) {
			errors.push({ rule: 'V3', message: `${claimants[0]} owns ${path}, a file several features would change. Change it in the scaffold instead.`, feature: claimants[0] });
		}
	}

	for (const other of context.otherPrograms) {
		const theirs = other.owns.map(pattern => compileGlob(pattern, ignoreCase));
		for (const path of candidates) {
			if (theirs.some(matcher => matcher(path)) && owners.some(owner => owner.matchers.some(matcher => matcher(path)))) {
				warnings.push({ rule: 'V8', message: `Program ${other.id} is still open and also changes ${path}; the second to ship will have to merge the first.` });
				break;
			}
		}
	}
}

function safeCompile(pattern: string, ignoreCase: boolean | undefined, errors: PlanIssue[], feature: string): PathMatcher {
	try {
		return compileGlob(pattern, ignoreCase);
	} catch (err) {
		errors.push({ rule: 'V0', message: `Feature ${feature}: ${(err as Error).message}`, feature });
		return () => false;
	}
}

/** V4: everything a feature consumes comes from the scaffold or from a feature it depends on. */
function checkInterfaces(plan: ProgramPlan, errors: PlanIssue[]): void {
	const fromScaffold = new Set((plan.scaffold.provides ?? []).map(interfaceKey));
	const providedBy = new Map<string, string>();
	for (const feature of plan.features) {
		for (const provided of feature.interfaces?.provides ?? []) {
			providedBy.set(interfaceKey(provided), feature.id);
		}
	}
	const byId = new Map(plan.features.map(feature => [feature.id, feature]));
	const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			if (!seen.has(dep)) {
				seen.add(dep);
				ancestors(dep, seen);
			}
		}
		return seen;
	};
	for (const feature of plan.features) {
		const deps = ancestors(feature.id);
		for (const consumed of feature.interfaces?.consumes ?? []) {
			const key = interfaceKey(consumed);
			if (fromScaffold.has(key)) {
				continue;
			}
			const provider = providedBy.get(key);
			if (provider === undefined) {
				errors.push({ rule: 'V4', message: `Feature ${feature.id} consumes ${key}, which neither the scaffold nor any feature provides.`, feature: feature.id });
			} else if (provider !== feature.id && !deps.has(provider)) {
				errors.push({ rule: 'V4', message: `Feature ${feature.id} consumes ${key} from ${provider} without depending on it. Put it in the scaffold, or add dependsOn.`, feature: feature.id });
			}
		}
	}
}

/** V7: every feature has an agent it can start with. */
function checkLadders(plan: ProgramPlan, context: ValidationContext, errors: PlanIssue[], warnings: PlanIssue[]): void {
	const missing = new Set<string>();
	for (const feature of plan.features) {
		const ladder = ladderOf(plan, feature, context.defaultLadder);
		let usable = 0;
		for (const rung of ladder) {
			const { id } = parseRung(rung);
			if (id === LEAD_RUNG) {
				usable++;
			} else if (!context.knownAgents.has(id)) {
				errors.push({ rule: 'V7', message: `Feature ${feature.id}: no agent is called "${id}". Known agents: ${[...context.knownAgents].join(', ')}.`, feature: feature.id });
			} else if (!context.availableAgents.has(id)) {
				missing.add(id);
			} else {
				usable++;
			}
		}
		if (usable === 0) {
			errors.push({ rule: 'V7', message: `Feature ${feature.id}: no agent on its ladder (${ladder.join(', ') || 'empty'}) is installed.`, feature: feature.id });
		}
	}
	for (const id of missing) {
		warnings.push({ rule: 'V7', message: `${id} is not installed on this machine; features skip it on their ladders.` });
	}
}
