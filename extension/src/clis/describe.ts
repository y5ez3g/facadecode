/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Show Agent Launch shows of each CLI for a chosen location (CLIS-4.1): the current effective configuration - the same
// one configuration every start uses - computed as a launch would compute it, without running any CLI or writing any file.
// Account secrets and sensitive environment values are redacted; an invalid configuration shows its errors and no invented plan.

import { isJsonObject } from '../base/json';
import type { ApprovalFact, SandboxFact } from './adapter';
import { Catalog, CatalogEntry, isProgram } from './catalog';
import type { CliProblem, CliSaid } from './config';
import { AGENT_TERMINAL_VARIABLES, EnvironmentMap, RUN_VARIABLE } from './environment';
import { adjustedEnvironment, CliPlanError, configurationProblems, DestinationEnvironment, executableOf, layeredEnvironmentOf, LaunchTrust, PlanInput, planLaunch, targetOf } from './plan';
import { redacted, redactedText } from './redact';
import type { ToolsInput } from './tools';

/**
 * A layer of the environment (CLIS-1.2), lowest first: the extension host's, the folder's terminal settings, the default
 * profile's map, the entry's `env`, its adapter's own quirk, what every run is given, and what Facade's tools and
 * session tracking give a start.
 */
export type EnvironmentSource = 'host' | 'terminal' | 'profile' | 'launch' | 'adapter' | 'run' | 'facade';

/** What only a start has, as the document names it in its place (CLIS-4.1): never a value one start would get. */
export const PLACEHOLDERS = { run: '<run ID>', session: '<session ID>', context: '<launch context>', instructions: '<instructions>' } as const;

/**
 * What a start adds to its CLI's launch besides the configuration (CLIS-2.2, 2.4): its session tracking, and the Facade tools where
 * they are on - each given as a start would be, its own values placeholders.
 */
export interface EffectiveInputs {
	readonly sessionFile: string;
	readonly sessionHook: (cli: string, platform: NodeJS.Platform) => string;
	readonly tools?: ToolsInput;
	/** The run's own folder, named, where a CLI's run settings file goes (CONFIGURATION-4.2). */
	readonly runDir?: string;
}

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
	/**
	 * The settings a start gives its CLI in a file of the run - Claude Code's and Antigravity's `--settings` - which `args` names by its
	 * path: shown as CONFIGURATION-4.2 has it, the values of their variables hidden and any other secret redacted (CLIS-4.1).
	 */
	readonly runSettings?: { readonly file: string; readonly settings: unknown };
	/** The YOLO a start is given; none for a program, which has no YOLO mapping (CONFIGURATION-2.3). */
	readonly yolo?: boolean;
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

/**
 * Run settings as the document shows them (CLIS-4.1, CONFIGURATION-4.2): each variable of their `env` by its name, its value hidden
 * unless empty - an empty one removes a key variable or is Facade's own switch - and any other secret redacted.
 */
function shownSettings(settings: unknown): unknown {
	if (!isJsonObject(settings) || !isJsonObject(settings.env)) {
		return redacted(settings);
	}
	const env = Object.fromEntries(Object.entries(settings.env).map(([name, value]) => [name, value === '' ? '' : '<redacted>']));
	return redacted({ ...settings, env });
}

/**
 * The variables one of the person's environment maps sets or removes, as the document lists them (CONFIGURATION-4.2): each by its
 * name, a value it sets never kept - whatever its name, it may be a secret.
 */
function variablesOf(source: EnvironmentSource, map: EnvironmentMap | undefined): { source: EnvironmentSource; name: string; value: string | null }[] {
	return Object.entries(map ?? {}).map(([name, value]) => ({ source, name, value: value === null ? null : '<redacted>' }));
}

/**
 * Each CLI of `catalog` as a start in `cwd` would have it now (CLIS-4.1): with `yolo` - the destination's settings file's `yolo`, the one
 * YOLO source (RULES-4.3) - the destination environment's own layers and, given `effective`, what a start adds: the Facade tools'
 * and session tracking's arguments and variables, in their places. Nothing is written: a trust kept in a file of the CLI's is only
 * named, and the tools' and session's files are named, never made.
 */
export function describeLaunches(catalog: Catalog, destination: DestinationEnvironment, cwd: string, yolo: boolean, effective?: EffectiveInputs): readonly LaunchDescription[] {
	return catalog.entries.map(entry => describeOne(entry, catalog, destination, cwd, yolo, effective));
}

function describeOne(entry: CatalogEntry, catalog: Catalog, destination: DestinationEnvironment, cwd: string, yolo: boolean, effective?: EffectiveInputs): LaunchDescription {
	const { adapter } = entry;
	const { platform } = destination;
	const unadjusted = layeredEnvironmentOf(entry, destination);
	const env = adjustedEnvironment(entry, unadjusted, platform);
	// What the adapter changes for a quirk of its CLI's (CLIS-1.2): the variables it removes or sets differently
	const adjusted: { source: EnvironmentSource; name: string; value: string | null }[] = [
		...Object.keys(unadjusted).filter(name => !Object.hasOwn(env, name)).map(name => ({ source: 'adapter' as const, name, value: null })),
		...Object.entries(env).filter(([name, value]) => unadjusted[name] !== value).map(([name, value]) => ({ source: 'adapter' as const, name, value: redacted(value, name) as string }))
	];
	// While its configuration has errors no program is looked for: a wrong `command` is never PATH's command (CLIS-1.2)
	const problems = configurationProblems(entry, destination);
	const executable = problems.length ? undefined : executableOf(entry, env, cwd, platform);
	let program: LaunchDescription['program'];
	if (executable === undefined) {
		program = { unresolved: true };
	} else if (executable.executable === undefined) {
		program = { missing: redactedText(executable.problem), said: safeSaid(executable.said) };
	} else {
		const target = targetOf(entry, executable.executable, env, platform, cwd);
		program = { file: target.executable, configured: entry.path, ...target.args.length ? { script: target.args.join(' ') } : {}, throughCmd: target.throughCmd };
	}
	let args: readonly string[] | undefined;
	let runSettings: LaunchDescription['runSettings'];
	let trust: LaunchTrust | undefined;
	let planProblem: LaunchDescription['planProblem'];
	const added: { source: EnvironmentSource; name: string; value: string | null }[] = [];
	if (entry.enabled && executable?.executable !== undefined) {
		try {
			const base: PlanInput = { cli: adapter.id, alias: '#aN', cwd, yolo };
			const configured = planLaunch(catalog, base, destination);
			const planned = effective ? planLaunch(catalog, {
				...base, sessionFile: effective.sessionFile, sessionHook: effective.sessionHook(adapter.id, platform), ...effective.tools ? { tools: effective.tools } : {},
				...effective.runDir ? { runDir: effective.runDir } : {}
			}, destination) : configured;
			// A new conversation's ID is made at its start: named in its place, never one a start would get
			const shown = (text: string) => planned.sessionId ? text.split(planned.sessionId).join(PLACEHOLDERS.session) : text;
			args = redacted(planned.args.map(shown)) as string[];
			// The settings it is given in a file of the run, which a start writes and this names alone
			const named = planned.args.indexOf('--settings');
			const given = named < 0 ? undefined : planned.files?.find(each => each.file === planned.args[named + 1]);
			if (given) {
				runSettings = { file: given.file, settings: shownSettings(JSON.parse(shown(given.content))) };
			}
			trust = planned.trust.kind === 'arguments' ? { kind: 'arguments', args: redacted(planned.trust.args) as string[] } : planned.trust;
			// What the tools and session tracking add to its environment, set by Facade itself after every layer: a value Facade merged
			// into one the person's layers had - OpenCode's configuration - holds theirs, so it is hidden as theirs is (CONFIGURATION-4.2)
			for (const [name, value] of Object.entries(planned.env)) {
				if (configured.env[name] !== value) {
					added.push({ source: 'facade', name, value: configured.env[name] === undefined ? redacted(shown(value), name) as string : '<redacted>' });
				}
			}
		} catch (err) {
			const text = redactedText(err instanceof Error ? err.message : String(err));
			planProblem = err instanceof CliPlanError && err.said ? { text, said: safeSaid(err.said) } : { text };
		}
	}
	const sources: EnvironmentSource[] = [
		'host',
		...destination.terminal && Object.keys(destination.terminal).length ? ['terminal' as const] : [],
		...destination.profile && Object.keys(destination.profile).length ? ['profile' as const] : [],
		...Object.keys(entry.environment).length ? ['launch' as const] : [],
		...adjusted.length ? ['adapter' as const] : [],
		'run',
		...added.length ? ['facade' as const] : []
	];
	return {
		cli: adapter.id,
		displayName: adapter.displayName,
		setting: adapter.setting,
		enabled: entry.enabled,
		problems: problems.map(safeProblem),
		program,
		cwd,
		environment: {
			sources,
			variables: [
				...variablesOf('terminal', destination.terminal),
				...variablesOf('profile', destination.profile),
				...variablesOf('launch', entry.environment),
				...adjusted,
				...RUN_VARIABLES.map(each => ({ source: 'run' as const, ...each })),
				...added
			],
			...destination.profileName && destination.profile && Object.keys(destination.profile).length ? { profile: destination.profileName } : {}
		},
		...args ? { args } : {},
		...runSettings ? { runSettings } : {},
		...isProgram(entry) ? {} : { yolo },
		sandbox: adapter.sandbox(yolo, platform),
		approvals: adapter.approvals(yolo),
		...trust ? { trust } : {},
		...planProblem ? { planProblem } : {}
	};
}
