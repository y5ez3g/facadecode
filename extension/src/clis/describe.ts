/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Show Agent Launch shows of each CLI for a chosen location (CLIS-4.1): the current effective configuration - the same
// one configuration every start uses - computed as a launch would compute it, without running any CLI or writing any file.
// Account secrets and sensitive environment values are redacted; an invalid configuration shows its errors and no invented plan.

import type { ApprovalFact, SandboxFact } from './adapter';
import type { Catalog, CatalogEntry } from './catalog';
import type { CliProblem, CliSaid } from './config';
import { AGENT_TERMINAL_VARIABLES, composeEnvironment, EnvironmentMap, RUN_VARIABLE } from './environment';
import { CliPlanError, DestinationEnvironment, environmentOf, executableOf, LaunchTrust, planLaunch, targetOf } from './plan';
import { redacted, redactedText } from './redact';

/**
 * A layer of the environment (CLIS-1.2), lowest first: the extension host's, the folder's terminal settings, the default
 * profile's map, the CLI's launch environment, its adapter's own quirk, and what every run is given.
 */
export type EnvironmentSource = 'host' | 'terminal' | 'profile' | 'launch' | 'adapter' | 'run';

/** One CLI as the document describes it. */
export interface LaunchDescription {
	readonly cli: string;
	readonly displayName: string;
	readonly setting: string;
	/** False for a built-in turned off by its `.enabled`: new starts are not offered it (CLIS-1.1). */
	readonly enabled: boolean;
	/** Configuration errors, each naming its setting path; with any, no plan is shown (CLIS-4.1). */
	readonly problems: readonly CliProblem[];
	/** The program found, and how; else why none was; none looked for while its configuration has errors, so that none is invented. */
	readonly program: { readonly file: string; readonly configured: string; readonly script?: string; readonly throughCmd: boolean } | { readonly missing: string; readonly said: CliSaid } | { readonly unresolved: true };
	readonly cwd: string;
	/** Where its environment comes from, lowest first, and what the configured layers set or remove, secrets redacted. */
	readonly environment: {
		readonly sources: readonly EnvironmentSource[];
		readonly variables: readonly { readonly source: EnvironmentSource; readonly name: string; readonly value: string | null }[];
		/** The default terminal profile whose `env` is the `profile` layer. */
		readonly profile?: string;
	};
	/** The literal invocation in order, secrets redacted; none where the configuration or the program is missing. */
	readonly args?: readonly string[];
	readonly yolo: boolean;
	readonly sandbox: SandboxFact;
	readonly approvals: ApprovalFact;
	/** How a start trusts its folder (CLIS-3.3): named, never written; none where no launch can be planned. */
	readonly trust?: LaunchTrust;
	/** Why a launch would fail here although its configuration is valid. */
	readonly planProblem?: { readonly text: string; readonly said?: CliSaid };
}

/** What every run's environment is given last (CLIS-1.2): the run's alias is the run's own, so it is named, not valued. */
const RUN_VARIABLES: readonly { readonly name: string; readonly value: string | null }[] = [...AGENT_TERMINAL_VARIABLES, { name: RUN_VARIABLE, value: '#aN' }];

/** A problem as the document says it: its English and its values with any secret in them redacted (CLIS-4.1). */
function safeProblem(problem: CliProblem): CliProblem {
	return { text: redactedText(problem.text), said: safeSaid(problem.said) };
}

function safeSaid(said: CliSaid): CliSaid {
	return { kind: said.kind, values: said.values.map(redactedText) };
}

/** The variables an environment map sets or removes, as the document lists them: values of secret names redacted. */
function variablesOf(source: EnvironmentSource, map: EnvironmentMap | undefined): { source: EnvironmentSource; name: string; value: string | null }[] {
	return Object.entries(map ?? {}).map(([name, value]) => ({ source, name, value: value === null ? null : redacted(value, name) as string }));
}

/**
 * Each CLI of `catalog` as a start in `cwd` would have it now (CLIS-4.1): with `yolo` - the destination's `facade.yolo`, the one
 * YOLO source (RULES-4.3) - and the destination environment's own layers. Nothing is written: a trust kept in a file of the CLI's
 * is only named.
 */
export function describeLaunches(catalog: Catalog, destination: DestinationEnvironment, cwd: string, yolo: boolean): readonly LaunchDescription[] {
	return catalog.entries.map(entry => describeOne(entry, catalog, destination, cwd, yolo));
}

function describeOne(entry: CatalogEntry, catalog: Catalog, destination: DestinationEnvironment, cwd: string, yolo: boolean): LaunchDescription {
	const { adapter } = entry;
	const { platform } = destination;
	const env = environmentOf(entry, destination);
	const unadjusted = composeEnvironment({ host: destination.host, terminal: destination.terminal, profile: destination.profile, launch: entry.environment }, platform);
	// What the adapter changes for a quirk of its CLI's (CLIS-1.2): the variables it removes or sets differently
	const adjusted: { source: EnvironmentSource; name: string; value: string | null }[] = [
		...Object.keys(unadjusted).filter(name => !Object.hasOwn(env, name)).map(name => ({ source: 'adapter' as const, name, value: null })),
		...Object.entries(env).filter(([name, value]) => unadjusted[name] !== value).map(([name, value]) => ({ source: 'adapter' as const, name, value: redacted(value, name) as string }))
	];
	// While its configuration has errors no program is looked for: a wrong `.path` is never PATH's command (CLIS-1.2)
	const executable = entry.problems.length ? undefined : executableOf(entry, env, cwd, platform);
	let program: LaunchDescription['program'];
	if (executable === undefined) {
		program = { unresolved: true };
	} else if (executable.executable === undefined) {
		program = { missing: redactedText(executable.problem), said: safeSaid(executable.said) };
	} else {
		const target = targetOf(entry, executable.executable, env, platform, cwd);
		program = { file: target.executable, configured: entry.path, ...target.args.length ? { script: target.args.join(' ') } : {}, throughCmd: target.throughCmd };
	}
	const sources: EnvironmentSource[] = [
		'host',
		...destination.terminal && Object.keys(destination.terminal).length ? ['terminal' as const] : [],
		...destination.profile && Object.keys(destination.profile).length ? ['profile' as const] : [],
		...Object.keys(entry.environment).length ? ['launch' as const] : [],
		...adjusted.length ? ['adapter' as const] : [],
		'run'
	];
	let args: readonly string[] | undefined;
	let trust: LaunchTrust | undefined;
	let planProblem: LaunchDescription['planProblem'];
	if (entry.enabled && executable?.executable !== undefined) {
		try {
			const planned = planLaunch(catalog, { cli: adapter.id, alias: '#a0', cwd, yolo }, destination);
			args = redacted(planned.args) as string[];
			trust = planned.trust.kind === 'arguments' ? { kind: 'arguments', args: redacted(planned.trust.args) as string[] } : planned.trust;
		} catch (err) {
			const text = redactedText(err instanceof Error ? err.message : String(err));
			planProblem = err instanceof CliPlanError && err.said ? { text, said: safeSaid(err.said) } : { text };
		}
	}
	return {
		cli: adapter.id,
		displayName: adapter.displayName,
		setting: adapter.setting,
		enabled: entry.enabled,
		problems: entry.problems.map(safeProblem),
		program,
		cwd,
		environment: {
			sources,
			variables: [
				...variablesOf('terminal', destination.terminal),
				...variablesOf('profile', destination.profile),
				...variablesOf('launch', entry.environment),
				...adjusted,
				...RUN_VARIABLES.map(each => ({ source: 'run' as const, ...each }))
			],
			...destination.profileName && destination.profile && Object.keys(destination.profile).length ? { profile: destination.profileName } : {}
		},
		...args ? { args } : {},
		yolo,
		sandbox: adapter.sandbox(yolo, platform),
		approvals: adapter.approvals(yolo),
		...trust ? { trust } : {},
		...planProblem ? { planProblem } : {}
	};
}
