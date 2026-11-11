/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI catalog and launch planner of this execution environment (CLIS-1.1, 4.2): the pure adapters of `clis/`, given Facade's
// settings file and the destination folder's terminal environment. Read on every use, so a saved setting or a PATH change applies to
// the next list and the next start. A start given the Facade tools has their files written before it is returned: where that
// fails, the CLI starts without them (CLIS-2.2). A start of a CLI that keeps its trust in a file of its own has its folder trusted
// there first; where it cannot be, the start goes ahead and the CLI asks in its terminal (CLIS-3.3).

import { SESSION_HOOK_SCRIPT, sessionDirOf, sessionFileOf, sessionHookCommand } from '../clis/identity';
import * as fs from 'fs';
import * as path from 'path';
import type { StoreEnvironments } from '../clis/history';
import { facadeHome } from '../record/paths';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { builtInOf, Catalog, CatalogEntry, catalogOf, entryOf, iconOf, isProgram } from '../clis/catalog';
import { acquireProject, injectedRecordOf, markPlanned, reconcileRuns, releaseRun, removeRunFiles, writeRunFiles } from '../clis/injected';
import { CliPlanError, configurationProblems, DestinationEnvironment, discover, discoverEntry, environmentOf, inputOf, PlanInput, planLaunch, PlannedLaunch, takesThrough, targetOf, turnedOffError } from '../clis/plan';
import { installedVersionOf } from '../clis/version';
import { markedSkill, McpServer, runDirOf, ToolsInput } from '../clis/tools';
import { writeTrust } from '../clis/trust';
import type { CliFacts } from '../contract/tools';
import { CliCatalogPort, CliChoice, CliChoices, LaunchPlan, LaunchPlanner, Location, PlanError, PlanRequest } from '../core/ports';
import { FACADE_SKILL } from '../schema/skill';
import { FacadeSettings } from './facadeSettings';
import type { CliProblem } from '../clis/config';
import { describeLaunches, EffectiveInputs, LaunchDescription, PLACEHOLDERS } from '../clis/describe';
import { destinationEnvironment } from './terminals';

/** Where the planner reads from: Facade's settings file and the editor's terminal environment unless a test gives its own. */
export interface HostClisOptions {
	readonly settings?: Pick<FacadeSettings, 'snapshot'>;
	/** The destination environment of a location; for none, the window's. */
	readonly destination?: (location: Location | undefined) => DestinationEnvironment;
	/** Where a diagnostic goes: a folder trusted or not (CLIS-3.3), the Facade tools' files. */
	readonly log?: (line: string) => void;
	readonly fact?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
	/** This execution environment's Facade directory, where runs' launch files go (ARCHITECTURE-3.1). */
	readonly home?: string;
	/** The extension's version, which marks the skill Facade writes into a folder (CLIS-2.2). */
	readonly version?: string;
	/** The MCP server a start of `run` would be given, as Show Agent Launch shows it: what only a start has, placeholders (CLIS-4.1). */
	readonly server?: (run: string) => McpServer;
}

/** The plan as the core has it: without the trust and injected files written for it. */
function launchPlanOf(planned: PlannedLaunch): LaunchPlan {
	const { injection, trust, files, ...plan } = planned;
	return plan;
}

/** The environment a location's launches see: its folder's terminal settings, by its own URI, remote authority kept; the window's for none. */
function destinationOf(location: Location | undefined): DestinationEnvironment {
	return destinationEnvironment(location && vscode.Uri.parse(location.uri));
}

/** CliCatalogPort and LaunchPlanner for this window's execution environment. */
export class HostClis implements CliCatalogPort, LaunchPlanner {

	private readonly settings: Pick<FacadeSettings, 'snapshot'>;
	private readonly destination: (location: Location | undefined) => DestinationEnvironment;
	private readonly log: (line: string) => void;
	private readonly home: string;
	private readonly scans = new Map<string, string>();
	private readonly fact: HostClisOptions['fact'];
	private readonly skill: string;
	private readonly server: HostClisOptions['server'];

	constructor(options: HostClisOptions = {}) {
		this.settings = options.settings ?? new FacadeSettings();
		this.destination = options.destination ?? destinationOf;
		this.log = options.log ?? (() => undefined);
		this.home = options.home ?? facadeHome();
		this.fact = options.fact;
		this.skill = options.version ? markedSkill(FACADE_SKILL, options.version) : FACADE_SKILL;
		this.server = options.server;
	}

	/** The catalog as the settings file reads now (CLIS-1.1, CONFIGURATION-2.1). */
	private catalog(): Catalog {
		return catalogOf(this.settings.snapshot());
	}

	/** The icon each CLI shows, by its API ID, from one reading of the settings file (CONFIGURATION-2.4). */
	icons(): (cli: string) => string {
		const catalog = this.catalog();
		return cli => iconOf(catalog, cli);
	}

	/**
	 * What each built-in states for a start at `location` (MCP-2.1): the choices it takes, its native prompt argument, the reader of
	 * its message input and its version where its installation says it - never more than its adapter stands behind.
	 */
	describe(location: Location, _yolo: boolean): { readonly launches: readonly CliFacts[] } {
		const destination = this.destination(location);
		return { launches: discover(this.catalog(), destination, location.path).map(found => this.factsOf(found, destination, location, true)) };
	}

	private factsOf({ entry, executable, env }: ReturnType<typeof discover>[number], destination: DestinationEnvironment, location: Location, details: boolean): CliFacts {
		const { adapter } = entry;
		const version = details && executable ? installedVersionOf(builtInOf(adapter.id, adapter.builtIn) ?? adapter.id, executable) : undefined;
		const target = executable && env ? targetOf(entry, executable, env, destination.platform, location.path) : undefined;
		return {
			cli: adapter.id,
			takes: takesThrough(adapter, target?.throughCmd ?? false, location.path, destination.platform),
			...adapter.initialPrompt ? { initialPrompt: { ...adapter.groups.prompt ? { mapping: adapter.groups.prompt } : {}, capability: adapter.initialPrompt } } : {},
			...!adapter.initialPrompt && adapter.promptAfterStart ? { initialPrompt: { capability: { state: 'unavailable' as const, reason: adapter.promptAfterStart } } } : {},
			input: inputOf(adapter), ...version ? { version } : {}
		};
	}

	storeEnvironments(location: Location): StoreEnvironments {
		const destination = this.destination(location);
		return Object.fromEntries(this.catalog().entries.filter(entry => entry.enabled && !configurationProblems(entry, destination).length)
			.map(entry => [entry.adapter.id, environmentOf(entry, destination)]));
	}

	storeArguments(): Readonly<Record<string, readonly string[]>> {
		return Object.fromEntries(this.catalog().entries.map(entry => [entry.adapter.id, entry.extra]));
	}

	/** The built-in each added entry of a built-in's type runs, by its name: whose store its conversations are in (CONFIGURATION-2.3). */
	storeBuiltIns(): Readonly<Record<string, string>> {
		return Object.fromEntries(this.catalog().entries.flatMap(entry => entry.adapter.builtIn ? [[entry.adapter.id, entry.adapter.builtIn]] : []));
	}

	/**
	 * Why a conversation of `cli` cannot be resumed at `location` now, where it cannot (LIFECYCLE-3.2): its CLI alone is found there - the
	 * picker asks for each conversation it lists, so no other CLI's program is looked for.
	 */
	resumeProblem(cli: string, location: Location, store?: string): string | undefined {
		const catalog = this.catalog();
		if (catalog.problems.length) {
			return catalog.problems.map(each => each.text).join('; ');
		}
		const entry = entryOf(catalog, cli);
		// The entry that started it, as it is now: gone, wrong, turned off or of another type, it is said, never another chosen
		// (CONFIGURATION-3.4); what is wrong with it before its being turned off, as New Agent and a start say it (CONFIGURATION-4.1)
		if (!entry) { return `${JSON.stringify(cli)} is no longer in clis of ${catalog.file}, so this conversation cannot be resumed with it.`; }
		const problems = configurationProblems(entry, this.destination(location));
		if (problems.length) { return problems.map(each => each.text).join('; '); }
		if (!entry.enabled) { return turnedOffError(entry.adapter).message; }
		const runs = builtInOf(entry.adapter.id, entry.adapter.builtIn);
		if (store !== undefined && runs !== store) {
			return `${entry.entry.setting} runs ${runs === undefined ? 'a program' : entryOf(catalog, runs)?.adapter.displayName ?? runs} now, so this conversation cannot be resumed with it.`;
		}
		if (isProgram(entry) || !entry.adapter.groups.resume) { return 'This CLI cannot resume conversations here.'; }
		const found = discoverEntry(entry, this.destination(location), location.path);
		return found.available ? undefined : found.problem ?? 'This CLI is unavailable.';
	}

	/** Why `cli` is not offered for new starts, where its entry's `enabled` turns it off (CLIS-1.1); none otherwise. */
	turnedOff(cli: string): string | undefined {
		const entry = entryOf(this.catalog(), cli);
		return entry && !entry.enabled ? turnedOffError(entry.adapter).message : undefined;
	}

	/**
	 * The built-ins new starts are offered in CLIS-1.1 order - a turned-off one hidden - then the added CLIs, for `location`; and what is
	 * wrong with the settings file as a whole, which stops every start (CONFIGURATION-4.1).
	 */
	/** What no CLI stands for - the settings file wrong as a whole - by the file, of `catalog`'s reading of it (CONFIGURATION-4.1). */
	problems(catalog: Catalog = this.catalog()): CliChoices['problems'] {
		return catalog.problems.map(each => ({ setting: catalog.file, problem: each.text, said: each.said }));
	}

	async list(location: Location, details = false): Promise<CliChoices & { readonly launches: readonly CliFacts[] }> {
		const catalog = this.catalog();
		const destination = this.destination(location);
		const found = discover(catalog, destination, location.path);
		const clis = found.map(({ entry, available, problem, said, notInstalled }): CliChoice => ({
			id: entry.adapter.id,
			displayName: entry.adapter.displayName,
			icon: entry.entry.icon,
			available,
			...problem !== undefined ? { problem } : {},
			...said ? { said } : {},
			...notInstalled ? { notInstalled } : {}
		}));
		// Of the same reading as its CLIs: a save landing meanwhile never pairs one version's CLIs with another's problems
		const problems = this.problems(catalog);
		const fields = { location_id: location.id, path: location.path,
			clis: clis.map(({ id, available, problem }) => ({ cli: id, available, problem })),
			problems: problems.map(({ setting, problem }) => ({ setting, problem })) };
		const signature = JSON.stringify(fields);
		if (signature !== this.scans.get(location.id)) { this.scans.set(location.id, signature); this.fact?.('cli_scan', fields); }
		return { clis, problems, launches: found.map(each => this.factsOf(each, destination, location, details)) };
	}

	/**
	 * What Show Agent Launch shows (CLIS-4.1), from one reading of the settings file: `yolo`, each CLI as a start in `location` would
	 * have it now, computed without running any CLI or writing any file - none without a location - each CLI's entry as read, and what
	 * is wrong with the file as a whole, which leaves no CLI to show (CONFIGURATION-4.1).
	 */
	describeLaunch(location: Location | undefined): { readonly yolo: boolean; readonly launches: readonly LaunchDescription[]; readonly entries: readonly CatalogEntry[]; readonly problems: readonly CliProblem[]; readonly file: string } {
		const settings = this.settings.snapshot();
		const catalog = catalogOf(settings);
		// What a start adds, as plan() gives it: its session tracking always, the tools where they are on - named, never written
		const file = sessionFileOf(this.home, PLACEHOLDERS.run);
		const script = path.join(sessionDirOf(file), 'hook.cjs');
		const effective: EffectiveInputs = {
			sessionFile: file,
			sessionHook: (cli, platform) => sessionHookCommand(process.execPath, platform, builtInOf(cli, entryOf(catalog, cli)?.adapter.builtIn) ?? cli, file, script),
			runDir: runDirOf(this.home, PLACEHOLDERS.run),
			...this.server ? { tools: this.toolsOf(PLACEHOLDERS.run, this.server(PLACEHOLDERS.run)) } : {}
		};
		return { yolo: settings.yolo, launches: location ? describeLaunches(catalog, this.destination(location), location.path, settings.yolo, effective) : [], entries: catalog.entries, problems: catalog.problems, file: catalog.file };
	}

	/**
	 * The launch of `request` (CLIS-2.2, 3.3, 4.2): computed and validated before any file or process exists, then - where it is given
	 * the tools - their run and project files written. Where they cannot be, the CLI still starts, without them, its tools `unavailable`
	 * with why. Its folder is then trusted where its CLI keeps trust in a file. A PlanError with the actual reason where the launch itself
	 * cannot be planned.
	 */
	async plan(request: PlanRequest): Promise<LaunchPlan> {
		const input: PlanInput = {
			cli: request.cli,
			alias: request.alias,
			cwd: request.location.path,
			yolo: request.yolo,
			...request.model !== undefined ? { model: request.model } : {},
			...request.effort !== undefined ? { effort: request.effort } : {},
			...request.prompt !== undefined ? { prompt: request.prompt } : {},
			...request.builtIn !== undefined ? { builtIn: request.builtIn } : {}
		};
		try {
			const catalog = this.catalog();
			const destination = this.destination(request.location);
			const file = sessionFileOf(this.home, request.run);
			const script = path.join(sessionDirOf(file), 'hook.cjs');
			// The session hook is the built-in's whose adapter runs it: an added entry's is its built-in's (CONFIGURATION-2.3)
			const hookCli = builtInOf(request.cli, entryOf(catalog, request.cli)?.adapter.builtIn) ?? request.cli;
			const resumable = { ...input, resume: request.resume, sessionFile: file, sessionHook: sessionHookCommand(process.execPath, destination.platform, hookCli, file, script), runDir: runDirOf(this.home, request.run) };
			let planned = planLaunch(catalog, { ...resumable, ...request.tools ? { tools: this.toolsOf(request.run, request.tools) } : {} }, destination);
			const failure = planned.injection && this.inject(request.run, input.cwd, planned);
			if (failure) {
				planned = { ...planLaunch(catalog, resumable, destination), tools: { state: 'unavailable', reason: failure.reason, problem: failure.problem, ...failure.file !== undefined ? { file: failure.file } : {} } };
			}
			const owned = [...planned.files ?? [], ...planned.exactResume ? [{ file: script, content: SESSION_HOOK_SCRIPT }] : []];
			// A file in the run's own folder is planned first, so that no window's reconcile takes it before its process starts (CLIS-2.2)
			if (owned.some(each => each.file.startsWith(runDirOf(this.home, request.run)))) {
				markPlanned(this.home, request.run);
			}
			for (const each of owned) {
				fs.mkdirSync(path.dirname(each.file), { recursive: true, mode: 0o700 });
				fs.writeFileSync(each.file, each.content, { mode: 0o600 });
			}
			const plan = launchPlanOf(planned);
			this.trust(planned);
			return plan;
		} catch (err) {
			throw err instanceof CliPlanError ? new PlanError(err.message, err.reason, err.said) : err;
		}
	}

	/**
	 * The run ended or was closed (CLIS-2.2, RULES-5.3): its launch files go, and its project references, content no run holds taken
	 * out.
	 */
	async release(run: string): Promise<void> {
		try {
			releaseRun(this.home, run).forEach(this.log);
		} catch (err) {
			this.log(`Could not release the Facade tools of ${run}: ${messageOf(err)}`);
		}
	}

	/**
	 * Releases what runs not in `alive` still hold, as after windows that ended without releasing it. `alive` is every run of this
	 * execution environment that may still be running, whichever window it is in; a run another window has just planned and not yet
	 * started counts as alive too.
	 */
	async reconcile(alive: readonly string[]): Promise<void> {
		try {
			reconcileRuns(this.home, alive).forEach(this.log);
		} catch (err) {
			this.log(`Could not release the Facade tools of ended agents: ${messageOf(err)}`);
		}
	}

	/** What a start of `run` is given of the tools: its shim, the bundled skill and its own folder. */
	private toolsOf(run: string, server: ToolsInput['server']): ToolsInput {
		return { server, skill: this.skill, runDir: runDirOf(this.home, run) };
	}

	/**
	 * Writes the files of `planned`'s injection for `run`, the run marked planned first so that no other window's reconcile takes
	 * them before its process starts; returns why they could not all be written, and then none stays.
	 */
	private inject(run: string, cwd: string, planned: PlannedLaunch): { readonly reason: string; readonly problem: 'files' | 'conflict'; readonly file?: string } | undefined {
		const injection = planned.injection!;
		try {
			markPlanned(this.home, run);
			writeRunFiles(injection);
			const conflict = acquireProject(injectedRecordOf(this.home), run, cwd, injection.project);
			if (conflict !== undefined) {
				removeRunFiles(this.home, run);
				// The folder's own file stays as it is: the person moves or renames it, and Facade writes its own next time (CLIS-2.2)
				const file = injection.project.find(write => conflict.includes(write.path))?.path ?? injection.project[0]?.path;
				return { reason: conflict, problem: 'conflict', ...file !== undefined ? { file } : {} };
			}
			return undefined;
		} catch (err) {
			try {
				removeRunFiles(this.home, run);
			} catch {
				// What could not be removed goes at the next reconcile
			}
			return { reason: `the launch files of the Facade tools could not be written: ${messageOf(err)}`, problem: 'files' };
		}
	}

	/**
	 * Trusts the folder `planned` starts in where its CLI keeps trust in a file of its own, as the person would by accepting its question
	 * (CLIS-3.3): what was merged, or why nothing could be, is logged. Nothing stops the start: the CLI then asks in its terminal.
	 */
	private trust(planned: PlannedLaunch): void {
		if (planned.trust.kind !== 'file') {
			return;
		}
		const { target } = planned.trust;
		try {
			const said = writeTrust(planned.displayName, target);
			if (said !== undefined) {
				this.log(said);
			}
		} catch (err) {
			this.log(`Did not trust ${target.folder} for ${planned.displayName} in ${target.file}: ${messageOf(err)}; ${planned.displayName} asks in its terminal.`);
		}
	}
}
