/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI catalog and launch planner of this execution environment (CLIS-1.1, 4.2): the pure adapters of `clis/`, given the
// editor's settings and the destination folder's terminal environment. Read on every use, so a setting or PATH change applies to
// the next list and the next start. A start given the Facade tools has their files written before it is returned: where that
// fails, the CLI starts without them (CLIS-2.2). A start of a CLI that keeps its trust in a file of its own has its folder trusted
// there first; where it cannot be, the start goes ahead and the CLI asks in its terminal (CLIS-3.3, D62).

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { catalogOf, SettingsReader } from '../clis/catalog';
import { acquireProject, injectedRecordOf, markPlanned, reconcileRuns, releaseRun, removeRunFiles, writeRunFiles } from '../clis/injected';
import { CliPlanError, DestinationEnvironment, discover, environmentOf, executableOf, inputOf, PlanInput, planLaunch, PlannedLaunch } from '../clis/plan';
import { installedVersionOf } from '../clis/version';
import { runDirOf, ToolsInput } from '../clis/tools';
import { writeTrust } from '../clis/trust';
import type { CliFacts } from '../contract/tools';
import { CliCatalogPort, CliChoice, LaunchPlan, LaunchPlanner, Location, PlanError, PlanRequest } from '../core/ports';
import { facadeHome } from '../record/paths';
import { FACADE_SKILL } from '../schema/skill';
import { readCollaboration, readSetting } from './settings';
import { destinationEnvironment } from './terminals';

/** Where the planner reads from: the editor's settings and terminal environment unless a test gives its own. */
export interface HostClisOptions {
	readonly read?: SettingsReader;
	/** The destination environment of a location; for none, the window's. */
	readonly destination?: (location: Location | undefined) => DestinationEnvironment;
	/** Where a diagnostic goes: a folder trusted or not (CLIS-3.3), the Facade tools' files. */
	readonly log?: (line: string) => void;
	/** This execution environment's Facade directory, where runs' launch files go (ARCHITECTURE-3.1). */
	readonly home?: string;
}

/** The plan as the core has it: without the trust and injected files written for it. */
function launchPlanOf(planned: PlannedLaunch): LaunchPlan {
	const { injection, trust, ...plan } = planned;
	return plan;
}

/** The environment a location's launches see: its folder's terminal settings, by its own URI, remote authority kept; the window's for none. */
function destinationOf(location: Location | undefined): DestinationEnvironment {
	return destinationEnvironment(location && vscode.Uri.parse(location.uri));
}

/** CliCatalogPort and LaunchPlanner for this window's execution environment. */
export class HostClis implements CliCatalogPort, LaunchPlanner {

	private readonly read: SettingsReader;
	private readonly destination: (location: Location | undefined) => DestinationEnvironment;
	private readonly log: (line: string) => void;
	private readonly home: string;

	constructor(options: HostClisOptions = {}) {
		this.read = options.read ?? readSetting;
		this.destination = options.destination ?? destinationOf;
		this.log = options.log ?? (() => undefined);
		this.home = options.home ?? facadeHome();
	}

	/**
	 * Whether a start now is given the Facade tools (RULES-4.4): `facade.collaboration.enabled`, read on each start, so a change
	 * applies to future starts alone; a value that is neither true nor false gives none, its problem logged.
	 */
	collaborationEnabled(): boolean {
		const { value, problem } = readCollaboration(this.read);
		if (problem !== undefined) {
			this.log(problem);
		}
		return value;
	}

	/**
	 * What each built-in states for a start at `location` (MCP-2.1): the choices it takes, its native prompt argument, the reader of
	 * its message input and its version where its installation says it - never more than its adapter stands behind.
	 */
	describe(location: Location, _yolo: boolean): { readonly launches: readonly CliFacts[] } {
		const destination = this.destination(location);
		return {
			launches: discover(catalogOf(this.read), destination, location.path).map(({ entry, available }): CliFacts => {
				const { adapter } = entry;
				const found = available ? executableOf(entry, environmentOf(entry, destination), location.path, destination.platform) : undefined;
				const version = found?.executable ? installedVersionOf(adapter.id, found.executable) : undefined;
				return {
					cli: adapter.id,
					takes: adapter.takes,
					...adapter.initialPrompt ? { initialPrompt: { ...adapter.groups.prompt ? { mapping: adapter.groups.prompt } : {}, capability: adapter.initialPrompt } } : {},
					// A CLI whose first task waits for what its start types: the prompt goes after it, as its first message (COLLABORATION-2.2)
					...!adapter.initialPrompt && adapter.promptAfterStart ? { initialPrompt: { capability: { state: 'unavailable' as const, reason: adapter.promptAfterStart } } } : {},
					input: inputOf(adapter),
					...version ? { version } : {}
				};
			})
		};
	}

	/** The built-ins new starts are offered in CLIS-1.1 order for `location`. */
	async list(location: Location): Promise<readonly CliChoice[]> {
		return discover(catalogOf(this.read), this.destination(location), location.path).map(({ entry, available, problem, said, notInstalled }) => ({
			id: entry.adapter.id,
			displayName: entry.adapter.displayName,
			available,
			...problem !== undefined ? { problem } : {},
			...said ? { said } : {},
			...notInstalled ? { notInstalled } : {}
		}));
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
			...request.prompt !== undefined ? { prompt: request.prompt } : {}
		};
		try {
			const catalog = catalogOf(this.read);
			const destination = this.destination(request.location);
			const planned = planLaunch(catalog, { ...input, ...request.tools ? { tools: this.toolsOf(request.run, request.tools) } : {} }, destination);
			const failure = planned.injection && this.inject(request.run, input.cwd, planned);
			const plan = failure === undefined ? launchPlanOf(planned) : { ...launchPlanOf(planLaunch(catalog, input, destination)), tools: { state: 'unavailable' as const, reason: failure.reason, problem: failure.problem, ...failure.file !== undefined ? { file: failure.file } : {} } };
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
		return { server, skill: FACADE_SKILL, runDir: runDirOf(this.home, run) };
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
	 * (CLIS-3.3, D62): what was merged, or why nothing could be, is logged. Nothing stops the start: the CLI then asks in its terminal.
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
