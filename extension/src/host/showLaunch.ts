/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Show Agent Launch (CLIS-4.1): a read-only document of how each CLI would start now in a chosen working location - executable and
// environment source, working directory, literal argument order, YOLO, sandbox and approvals, how the folder is trusted and
// configuration errors - computed without running any CLI or writing any file, secrets redacted, in the person's language.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ApprovalFact, SandboxFact } from '../clis/adapter';
import type { CatalogEntry } from '../clis/catalog';
import type { CliProblem } from '../clis/config';
import type { EnvironmentSource, LaunchDescription } from '../clis/describe';
import type { LaunchTrust } from '../clis/plan';
import { redactedText } from '../clis/redact';
import { trustEntryJson } from '../clis/trust';
import { invalid } from '../core/errors';
import type { Location, LocationPort, LogPort } from '../core/ports';
import { locationLabel } from '../ui/cardView';
import { COMMANDS } from '../ui/catalog';
import { chooseLaunchLocation } from '../ui/pickers/launchLocation';
import { environmentLabel } from '../ui/pickers/location';
import { reasonText } from '../ui/presentation';
import type { HostClis } from './clis';
import type { FacadeSettings } from './facadeSettings';
import { YOLO_SETTING } from './settings';
import { terminalEnvSetting } from './terminals';

/** Where the document lives: read-only, as a content provider's documents are. */
const DOCUMENT = vscode.Uri.from({ scheme: 'facade-launch', path: '/Agent Launch' });

/** An argument as the document lists it: as it is, or quoted where whitespace, quotes or emptiness would hide its bounds. */
function shownArg(arg: string): string {
	return /^[^\s"'\\]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function shownArgs(args: readonly string[]): string {
	return args.map(shownArg).join(' ');
}

function sandboxText(sandbox: SandboxFact, launch: LaunchDescription): string {
	switch (sandbox.state) {
		// {0} is the CLI's options that turn it on, such as --sandbox workspace-write
		case 'on': return sandbox.by ? vscode.l10n.t("Sandbox: on, by {0}", shownArgs(sandbox.by)) : vscode.l10n.t("Sandbox: on, by Facade settings");
		// {0} is the CLI's options that turn it off
		case 'off': return vscode.l10n.t("Sandbox: off, by {0}", shownArgs(sandbox.by));
		case 'native': return vscode.l10n.t("Sandbox: as the CLI's own configuration sets it");
		// {0} is the CLI's name, such as Claude Code
		case 'none': return vscode.l10n.t("Sandbox: none; {0} has no sandbox here", launch.displayName);
		case 'unknown': return vscode.l10n.t("Sandbox: unknown; Facade does not read a custom CLI's configuration");
	}
}

function approvalsText(approvals: ApprovalFact, launch: LaunchDescription): string {
	switch (approvals.state) {
		// {0} is the CLI's options that bypass them, such as --dangerously-skip-permissions
		case 'bypassed': return vscode.l10n.t("Approvals: bypassed, by {0}", shownArgs(approvals.by));
		case 'native': return vscode.l10n.t("Approvals: the CLI's own");
		// {0} is the CLI's name, such as Pi
		case 'none': return vscode.l10n.t("Approvals: none; {0} has no approvals", launch.displayName);
		case 'unknown': return vscode.l10n.t("Approvals: unknown; Facade does not read a custom CLI's configuration");
	}
}

/** A watch of the settings file `file`, which calls `changed` as it is saved, made or removed (CONFIGURATION-1.1). */
export function watchSettingsFile(file: string, changed: () => void): vscode.Disposable[] {
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
	return [watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)];
}

/** Where an environment layer comes from, as the document names it (CLIS-1.2). */
function sourceText(source: EnvironmentSource, launch: LaunchDescription): string {
	switch (source) {
		case 'host': return vscode.l10n.t("the extension host's environment");
		case 'terminal': return terminalEnvSetting();
		// {0} is the profile's name, quoted
		case 'profile': return vscode.l10n.t("the env of the default terminal profile {0}", JSON.stringify(launch.environment.profile ?? ''));
		case 'launch': return `${launch.setting}.env`;
		// {0} is the CLI's name
		case 'adapter': return vscode.l10n.t("the {0} integration", launch.displayName);
		case 'run': return vscode.l10n.t("all agents");
		case 'facade': return vscode.l10n.t("Facade's tools and session tracking");
	}
}

/**
 * How a start trusts its folder (CLIS-3.3, 3.4): for the launch alone, by an entry merged into the CLI's file - none where that file
 * is not there - not at all, or - for a custom CLI - as its own configuration has it.
 */
function trustText(trust: LaunchTrust): string {
	if (trust.kind === 'unknown') {
		return vscode.l10n.t("Trust: not granted by Facade; a custom CLI that prompts for folder trust asks in its terminal");
	}
	if (trust.kind === 'file') {
		if (trust.target.withheld) {
			return vscode.l10n.t("Trust: none provided for home folder, parents, or filesystem root; CLI prompts in its terminal");
		}
		// A file the CLI has not made is not made for it, so nothing is merged (CLIS-3.3)
		if (!fs.existsSync(trust.target.file)) {
			// {0} is the CLI's file
			return vscode.l10n.t("Trust: no entry is written, as {0} does not exist; the CLI prompts in its terminal", trust.target.file);
		}
		// {0} is the entry, as JSON; {1} the CLI's file
		return vscode.l10n.t("Trust: {0} merged into {1} before each start; unreadable files are preserved and the CLI prompts in its terminal", JSON.stringify(trustEntryJson(trust.target)), trust.target.file);
	}
	// {0} is the CLI's options that trust the folder
	return trust.args.length ? vscode.l10n.t("Trust: for this launch alone, by {0}", shownArgs(trust.args)) : vscode.l10n.t("Trust: none required; the CLI does not prompt for trust");
}

/** One CLI's section of the document. */
function launchSection(launch: LaunchDescription): string[] {
	const lines = [`${launch.displayName} (${launch.cli}, ${launch.setting})`];
	const add = (text: string) => lines.push(`  ${text}`);
	if (!launch.enabled) {
		// {0} is the CLI's entry, such as clis.claude
		add(vscode.l10n.t("Status: off; {0}.enabled is false, so New Agent does not offer it", launch.setting));
	} else if (launch.problems.length) {
		add(vscode.l10n.t("Status: cannot start until configuration errors are fixed"));
	} else if ('missing' in launch.program) {
		// {0} is why
		add(vscode.l10n.t("Status: cannot start: {0}", reasonText(launch.program.said, launch.program.missing)));
	} else if (launch.planProblem !== undefined) {
		add(vscode.l10n.t("Status: cannot start: {0}", reasonText(launch.planProblem.said, launch.planProblem.text)));
	} else {
		add(vscode.l10n.t("Status: available"));
	}
	if (launch.problems.length) {
		add(vscode.l10n.t("Configuration errors:"));
		launch.problems.forEach(problem => add(`  - ${reasonText(problem.said, problem.text)}`));
	}
	if ('file' in launch.program) {
		add(launch.program.configured
			// {0} is the program; {1} its entry, such as clis.codex; {2} the command configured there
			? vscode.l10n.t("Executable: {0} (from {1}.command {2})", launch.program.file, launch.setting, JSON.stringify(launch.program.configured))
			: vscode.l10n.t("Executable: {0} (found on PATH)", launch.program.file));
		if (launch.program.script !== undefined) {
			add(vscode.l10n.t("Node script: {0}", launch.program.script));
		}
		if (launch.program.throughCmd) {
			add(vscode.l10n.t("Runs via cmd.exe: arguments interpreted by cmd.exe are rejected"));
		}
	} else if ('missing' in launch.program) {
		add(vscode.l10n.t("Executable: not found: {0}", reasonText(launch.program.said, launch.program.missing)));
	} else {
		add(vscode.l10n.t("Executable: unresolved until configuration errors are fixed"));
	}
	add(vscode.l10n.t("Working directory: {0}", launch.cwd));
	// {0} is the layers, joined by arrows
	add(vscode.l10n.t("Environment layers, lowest precedence first: {0}", launch.environment.sources.map(source => sourceText(source, launch)).join(' → ')));
	for (const variable of launch.environment.variables) {
		const from = sourceText(variable.source, launch);
		// The person's own variables by name alone: a value may be a secret whatever its name (CONFIGURATION-4.2); Facade's own with theirs
		const own = variable.source === 'adapter' || variable.source === 'run' || variable.source === 'facade';
		// {0} is a variable's name; {1} the layer that removes it, or sets it
		add(`  ${variable.value === null ? vscode.l10n.t("{0} removed ({1})", variable.name, from) : own ? `${variable.name}=${variable.value} (${from})` : vscode.l10n.t("{0} set ({1})", variable.name, from)}`);
	}
	if (launch.args) {
		add(vscode.l10n.t("Arguments, in order:"));
		launch.args.forEach(arg => add(`  ${shownArg(arg)}`));
		if (!launch.args.length) {
			add(`  ${vscode.l10n.t("(none)")}`);
		}
		if (launch.runSettings) {
			// {0} is the file of the run that holds them
			add(vscode.l10n.t("Run settings, in {0}:", launch.runSettings.file));
			JSON.stringify(launch.runSettings.settings, undefined, 2).split('\n').forEach(line => add(`  ${line}`));
		}
	} else {
		add(vscode.l10n.t("Arguments: none; CLI cannot start with current configuration"));
	}
	add(launch.yolo === undefined
		? vscode.l10n.t("YOLO: not applied; a custom CLI starts exactly as configured")
		: launch.yolo ? vscode.l10n.t("YOLO: on") : vscode.l10n.t("YOLO: off"));
	add(sandboxText(launch.sandbox, launch));
	add(approvalsText(launch.approvals, launch));
	if (launch.trust) {
		add(trustText(launch.trust));
	}
	return lines;
}

/** What the document is computed from: its location as the window names it, and what HostClis describes from one reading of the file. */
export interface LaunchDocumentInput {
	/** The location shown; none in a window without one. */
	readonly location?: { readonly label: string; readonly path: string; readonly environment?: string };
	/** A location shown before that this window no longer has, by the name it had. */
	readonly gone?: string;
	/** `yolo` as the settings file sets it; not shown where the file has errors. */
	readonly yolo: boolean;
	readonly launches: readonly LaunchDescription[];
	readonly entries: readonly Pick<CatalogEntry, 'adapter' | 'enabled' | 'problems'>[];
	/** What is wrong with the settings file as a whole, which stops every start and leaves no CLI to show (CONFIGURATION-4.1). */
	readonly problems: readonly CliProblem[];
	/** The settings file, as the person reads its path. */
	readonly file: string;
	readonly now: Date;
}

/** The document (CLIS-4.1): for a location, each CLI as a start there would have it; without one, each CLI's settings and errors. */
export function launchDocument(input: LaunchDocumentInput): string {
	const { yolo, location } = input;
	if (input.gone !== undefined) {
		// {0} is the working location's name
		return `${vscode.l10n.t("Working location {0} is no longer available. Run Show Agent Launch again to choose another.", input.gone)}\n`;
	}
	const lines: string[] = [];
	if (!location) {
		lines.push(vscode.l10n.t("No folder is open. Open a folder to view agent launch details."));
	} else {
		// {0} is the working location's name
		lines.push(vscode.l10n.t("Agent launch in {0}", location.label));
		lines.push(location.environment === undefined
			// {0} is the working location's path
			? vscode.l10n.t("Working location: {0}", location.path)
			// {0} is the working location's path; {1} its remote environment, such as SSH: build
			: vscode.l10n.t("Working location: {0} ({1})", location.path, location.environment));
	}
	// {0} is the date and time, such as 2026-10-30 21:15:00
	lines.push(vscode.l10n.t("Computed at {0} UTC without starting any CLI. This shows the configuration a new agent would use now, not an observation of a running process. Secret values are <redacted>.", input.now.toISOString().replace('T', ' ').slice(0, 19)));
	if (input.problems.length) {
		// {0} is the settings file
		lines.push(vscode.l10n.t("{0} has errors; no agent can start until they are fixed:", input.file));
		input.problems.forEach(problem => lines.push(`  - ${reasonText(problem.said, redactedText(problem.text))}`));
	} else {
		lines.push(yolo
			// {0} is the setting, yolo; {1} the settings file
			? vscode.l10n.t("YOLO: on, from {0} in {1}; applies to newly started agents", YOLO_SETTING, input.file)
			: vscode.l10n.t("YOLO: off, from {0} in {1}; applies to newly started agents", YOLO_SETTING, input.file));
	}
	if (location) {
		for (const launch of input.launches) {
			lines.push('', ...launchSection(launch));
		}
	} else {
		for (const entry of input.entries) {
			const { adapter } = entry;
			lines.push('', `${adapter.displayName} (${adapter.id}, ${adapter.setting})`);
			if (!entry.enabled) {
				lines.push(`  ${vscode.l10n.t("Status: off; {0}.enabled is false, so New Agent does not offer it", adapter.setting)}`);
			}
			lines.push(entry.problems.length ? `  ${vscode.l10n.t("Configuration errors:")}` : `  ${vscode.l10n.t("Configuration errors: none")}`);
			entry.problems.forEach(problem => lines.push(`    - ${reasonText(problem.said, problem.text)}`));
		}
	}
	return `${lines.join('\n')}\n`;
}

/**
 * The location Show Agent Launch's argument names (UX-3.1): `{ location_id }` exactly; nothing, as the Command Palette gives, or
 * `null`, for the person to choose. Anything else fails without a guess.
 */
export function locationArgument(argument: unknown): string | undefined {
	if (argument === undefined || argument === null) {
		return undefined;
	}
	const given = argument as { readonly [key: string]: unknown };
	if (typeof argument !== 'object' || Array.isArray(argument) || Object.keys(given).some(key => key !== 'location_id') || typeof given.location_id !== 'string') {
		throw invalid('invalid_argument', 'Expected { "location_id": "<the ID of a working location of this window>" }.');
	}
	return given.location_id;
}

/** The location the command shows: the one its argument names, the only one, or the person's choice; null when they cancel. */
export async function chosen(locations: Pick<LocationPort, 'snapshot' | 'resolve' | 'refresh' | 'onDidChange'>, argument: unknown, log: LogPort): Promise<Location | undefined | null> {
	const id = locationArgument(argument);
	if (id !== undefined) {
		const location = locations.resolve(id);
		if (!location) {
			throw invalid('invalid_argument', `No working location ${JSON.stringify(id)} in this window.`);
		}
		return location;
	}
	// A folder inside a location is no launch choice of its own (WORKTREES-1.2)
	const offered = locations.snapshot().locations.filter(each => !each.within);
	if (offered.length <= 1) {
		return offered[0];
	}
	return chooseLaunchLocation(locations, log);
}

/**
 * Registers Show Agent Launch (CLIS-4.1): the command, and its read-only document, read again as Facade's settings file or the
 * terminal environment settings change while it is open. `remote` is the window's remote authority, as its environment is named.
 */
export function registerShowLaunch(clis: HostClis, locations: LocationPort, log: LogPort, settings: Pick<FacadeSettings, 'file'>, remote?: string): vscode.Disposable {
	const changed = new vscode.EventEmitter<vscode.Uri>();
	/** The location shown, as it was named: a later document says so where it is gone. */
	let shown: { readonly id: string; readonly label: string } | undefined;
	const document = (): string => {
		const location = shown && locations.resolve(shown.id);
		const described = clis.describeLaunch(location);
		return launchDocument({
			...shown && !location ? { gone: shown.label } : {},
			...location ? {
				location: {
					label: locationLabel(location, locations.snapshot()),
					path: location.path,
					...location.environment !== 'local' ? { environment: environmentLabel(location.environment, remote) } : {}
				}
			} : {},
			yolo: described.yolo,
			launches: described.launches,
			entries: described.entries,
			problems: described.problems,
			file: described.file,
			now: new Date()
		});
	};
	return vscode.Disposable.from(
		changed,
		vscode.workspace.registerTextDocumentContentProvider(DOCUMENT.scheme, { onDidChange: changed.event, provideTextDocumentContent: document }),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('terminal.integrated')) {
				changed.fire(DOCUMENT);
			}
		}),
		// The settings file saved, made or removed: the document read again (CONFIGURATION-1.1)
		...watchSettingsFile(settings.file, () => changed.fire(DOCUMENT)),
		vscode.commands.registerCommand(COMMANDS.showAgentLaunch, async (argument?: unknown) => {
			const location = await chosen(locations, argument, log);
			if (location === null) {
				return;
			}
			shown = location && { id: location.id, label: locationLabel(location, locations.snapshot()) };
			changed.fire(DOCUMENT);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(DOCUMENT), { preview: false });
		})
	);
}
