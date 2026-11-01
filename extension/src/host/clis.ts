/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The CLI catalog and launch planner of this execution environment (CLIS-1.1, 4.2): the pure adapters of `clis/`, given the
// editor's settings and the destination folder's terminal environment. Read on every use, so a setting or PATH change applies to
// the next list and the next start. A start of a CLI that keeps its trust in a file of its own has its folder trusted there first;
// where it cannot be, the start goes ahead and the CLI asks in its terminal (CLIS-3.3, D62).

import { SESSION_HOOK_SCRIPT, sessionFileOf, sessionHookCommand } from '../clis/identity';
import * as fs from 'fs';
import * as path from 'path';
import type { StoreEnvironments } from '../clis/history';
import { facadeHome } from '../record/paths';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { CatalogEntry, catalogOf, SettingsReader } from '../clis/catalog';
import type { CliProblem } from '../clis/config';
import { CUSTOM_SETTING } from '../clis/custom';
import { describeLaunches, LaunchDescription } from '../clis/describe';
import { CliPlanError, DestinationEnvironment, discover, environmentOf, planLaunch, PlannedLaunch } from '../clis/plan';
import { writeTrust } from '../clis/trust';
import { CliCatalogPort, CliChoice, CliChoices, LaunchPlan, LaunchPlanner, Location, PlanError, PlanRequest } from '../core/ports';
import { readSetting } from './settings';
import { destinationEnvironment } from './terminals';

/** Where the planner reads from: the editor's settings and terminal environment unless a test gives its own. */
export interface HostClisOptions {
	readonly read?: SettingsReader;
	/** The destination environment of a location; for none, the window's. */
	readonly destination?: (location: Location | undefined) => DestinationEnvironment;
	/** Where a diagnostic goes: a folder trusted or not (CLIS-3.3). */
	readonly log?: (line: string) => void;
	readonly home?: string;
}

/** The plan as the core has it: without the trust written for it. */
function launchPlanOf(planned: PlannedLaunch): LaunchPlan {
	const { trust, files, ...plan } = planned;
	return plan;
}

/** The environment a location's launches see: its folder's terminal settings, by its own URI, remote authority kept; the window's for none. */
function destinationOf(location: Location | undefined): DestinationEnvironment {
	return destinationEnvironment(location && vscode.Uri.parse(location.uri));
}

/** CliCatalogPort and LaunchPlanner for this window's execution environment. */
export class HostClis implements CliCatalogPort, LaunchPlanner {

	private readonly home: string;
	private readonly read: SettingsReader;
	private readonly destination: (location: Location | undefined) => DestinationEnvironment;
	private readonly log: (line: string) => void;

	constructor(options: HostClisOptions = {}) {
		this.home = options.home ?? facadeHome();
		this.read = options.read ?? readSetting;
		this.destination = options.destination ?? destinationOf;
		this.log = options.log ?? (() => undefined);
	}

	storeEnvironments(location: Location): StoreEnvironments {
		const destination = this.destination(location);
		return Object.fromEntries(catalogOf(this.read).entries.filter(entry => entry.enabled && !entry.problems.length)
			.map(entry => [entry.adapter.id, environmentOf(entry, destination)]));
	}

	storeArguments(): Readonly<Record<string, readonly string[]>> {
		return Object.fromEntries(catalogOf(this.read).entries.map(entry => [entry.adapter.id, entry.extra]));
	}

	resumeProblem(cli: string, location: Location): string | undefined {
		const catalog = catalogOf(this.read);
		const entry = catalog.entries.find(each => each.adapter.id === cli);
		if (!entry || !entry.enabled || (!entry.custom && !entry.adapter.groups.resume)) { return 'This CLI cannot resume conversations here.'; }
		const found = discover(catalog, this.destination(location), location.path).find(each => each.entry === entry);
		return found?.available ? undefined : found?.problem ?? 'This CLI is unavailable.';
	}

	/**
	 * The built-ins new starts are offered in CLIS-1.1 order - a turned-off one hidden - then the custom CLIs, for `location`; and the
	 * errors of `facade.custom` no CLI stands for (CLIS-3.4).
	 */
	async list(location: Location): Promise<CliChoices> {
		const catalog = catalogOf(this.read);
		const clis = discover(catalog, this.destination(location), location.path).map(({ entry, available, problem, said, notInstalled }): CliChoice => ({
			id: entry.adapter.id,
			displayName: entry.adapter.displayName,
			available,
			...problem !== undefined ? { problem } : {},
			...said ? { said } : {},
			...notInstalled ? { notInstalled } : {}
		}));
		return { clis, problems: catalog.problems.map(each => ({ setting: CUSTOM_SETTING, problem: each.text, said: each.said })) };
	}

	/**
	 * What Show Agent Launch shows (CLIS-4.1): each CLI as a start in `location` would have it now, with `yolo`, computed without
	 * running any CLI or writing any file - none without a location - each CLI's settings as read, and what is wrong with
	 * `facade.custom` as a whole (CLIS-3.4).
	 */
	describe(location: Location | undefined, yolo: boolean): { readonly launches: readonly LaunchDescription[]; readonly entries: readonly CatalogEntry[]; readonly problems: readonly CliProblem[] } {
		const catalog = catalogOf(this.read);
		return { launches: location ? describeLaunches(catalog, this.destination(location), location.path, yolo) : [], entries: catalog.entries, problems: catalog.problems };
	}

	/**
	 * The launch of `request` (CLIS-3.3, 4.2): computed and validated before any file or process exists, then its folder trusted where
	 * its CLI keeps trust in a file. A PlanError with the actual reason where the launch itself cannot be planned.
	 */
	async plan(request: PlanRequest): Promise<LaunchPlan> {
		try {
			const destination = this.destination(request.location);
			const file = sessionFileOf(this.home, request.run);
			const script = path.join(file.replace(/\.json$/, '.d'), 'hook.cjs');
			const planned = planLaunch(catalogOf(this.read), { cli: request.cli, alias: request.alias, cwd: request.location.path, yolo: request.yolo, resume: request.resume, sessionFile: file, sessionHook: sessionHookCommand(process.execPath, destination.platform, request.cli, file, script) }, destination);
			for (const file of [...planned.files ?? [], ...planned.exactResume ? [{ file: script, content: SESSION_HOOK_SCRIPT }] : []]) {
				fs.mkdirSync(path.dirname(file.file), { recursive: true, mode: 0o700 });
				fs.writeFileSync(file.file, file.content, { mode: 0o600 });
			}
			this.trust(planned);
			return launchPlanOf(planned);
		} catch (err) {
			throw err instanceof CliPlanError ? new PlanError(err.message, err.reason, err.said) : err;
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
