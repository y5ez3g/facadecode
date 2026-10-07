/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isObject, isString } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { IShellLaunchConfig, TerminalIcon } from '../../../../platform/terminal/common/terminal.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { StartupKind } from '../../../services/lifecycle/common/lifecycle.js';

/** The glyph of an agent without a logo of its own (`agentIcon`). */
export const AGENT_TERMINAL_ICON = Codicon.robot;

/**
 * Each built-in agent's logo, by the program its command starts. Icons, so that every surface that
 * draws one draws these, each at the size of the glyph it stands for.
 *
 * Every logo is painted by `media/agentIcons.css` over the default here, which is what shows where
 * that stylesheet does not reach: the maker's mark in the icon font where it has one - the codicons
 * upstream's agent sessions use for Claude and Codex (`iconForAgentProvider`) - and the robot where it
 * has none. A product icon theme's glyph for one is painted over the same way.
 */
const AGENT_ICONS: ReadonlyMap<string, ThemeIcon> = new Map([
	['claude', registerIcon('agent-claude', Codicon.claude, localize('agentIcon.claude', "Icon for a terminal running Claude Code."))],
	['codex', registerIcon('agent-codex', Codicon.openai, localize('agentIcon.codex', "Icon for a terminal running Codex."))],
	['agy', registerIcon('agent-antigravity', Codicon.robot, localize('agentIcon.antigravity', "Icon for a terminal running Antigravity."))],
	['muse', registerIcon('agent-muse', Codicon.robot, localize('agentIcon.muse', "Icon for a terminal running Muse Code."))],
	['grok', registerIcon('agent-grok', Codicon.xai, localize('agentIcon.grok', "Icon for a terminal running Grok Build."))]
]);

/**
 * The icon an agent's terminal is drawn with: its logo when it runs one of the built-in agents, the
 * robot otherwise - and for a command that is only a shell.
 *
 * By the program the command starts rather than by the agent's id, so a row somebody adds to the list
 * that runs `claude` is drawn as Claude, and a renamed built-in keeps its mark. The name is read as the
 * last segment of a path, without an extension: `C:\tools\claude.cmd` is `claude`.
 */
export function agentIcon(command: string): ThemeIcon {
	const name = programOf(command);
	return (name && AGENT_ICONS.get(name)) || AGENT_TERMINAL_ICON;
}

/** The program a command starts, by its name: the last segment of its path, without an extension, in lower case. */
function programOf(command: string): string | undefined {
	return commandExecutable(command)?.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, '').toLowerCase();
}

/** The CLIs Facade starts, by the programs that start them, as its agents' extension knows them by id. */
const FACADE_CLIS: ReadonlySet<string> = new Set(['claude', 'codex', 'muse', 'agy']);

/**
 * The CLI of Facade's that a launcher's command starts - `claude`, `codex`, `muse` or `agy` - by its program,
 * as `agentIcon` reads it; undefined for any other. While Facade is on, such a launcher is Start Agent with
 * that CLI chosen: the CLI's launch settings say how it starts, and the rest of the command line is not used.
 */
export function facadeCliOf(command: string): string | undefined {
	const program = programOf(command);
	return program && FACADE_CLIS.has(program) ? program : undefined;
}

/**
 * Every icon an agent's terminal can have, which is how one is recognised afterwards.
 *
 * A terminal has nowhere to carry a flag of ours: `reconnectionProperties` is the field upstream built
 * for an owner to mark one, and setting it takes the terminal out of `shouldPersist` unless
 * `task.reconnection` is on - a worse bug traded for a smaller one. The icon is what survives a reload,
 * so the icon is the marker.
 */
const AGENT_ICON_IDS: ReadonlySet<string> = new Set([AGENT_TERMINAL_ICON.id, ...[...AGENT_ICONS.values()].map(icon => icon.id)]);

/**
 * Whether a terminal is drawn as an agent's, which is what makes it one.
 *
 * ⚠️ It reads both ways, and that is the price of the marker. Changing an agent tab's icon to something
 * else stops it being an agent tab, and giving a plain terminal the robot or an agent's logo starts it
 * being one. A terminal that looks like an agent behaves like one, which is at least a rule somebody can
 * see.
 */
export function isAgentTerminalIcon(icon: TerminalIcon | undefined): boolean {
	return ThemeIcon.isThemeIcon(icon) && AGENT_ICON_IDS.has(icon.id);
}

/**
 * Whether a terminal being brought back as the window starts is an agent's that is gone: the agent
 * did not outlive the app, and only a reload finds it still running. Brought back anyway, its tab
 * would be a fresh shell under the old output, looking like the agent - so it is left out, as
 * upstream leaves out a task's terminal (`TerminalService._recreateTerminalGroup`).
 */
export function isAgentGoneAtStartup(icon: TerminalIcon | undefined, startupKind: StartupKind): boolean {
	return startupKind !== StartupKind.ReloadedWindow && isAgentTerminalIcon(icon);
}

/**
 * The title template of the terminals the agent button starts: the title the agent sets for itself,
 * its name standing in until it has.
 */
export const AGENT_TITLE_TEMPLATE = '${sequence}';

/**
 * The name and title template an agent's terminal was started with, which a reload gives back
 * (`restoreAgentLaunch`). With the agent button's template the agent's own title wins; without one
 * the name is the title, as it is for Facade's agents, which are known by it.
 */
export interface IAgentName {
	readonly name: string;
	readonly titleTemplate?: string;
}

/**
 * What to keep of a terminal started now for a reload to give back: the name and title template it
 * was started with, when it is an agent's - drawn with an agent's icon, whoever started it: the agent
 * button, or anything else that gives a terminal one, as Facade's agents do. Undefined for any other,
 * one without a name, and one a reload brought back (`restoreAgentLaunch`).
 */
export function agentLaunchOf(shellLaunchConfig: IShellLaunchConfig): IAgentName | undefined {
	if (shellLaunchConfig.attachPersistentProcess || !isAgentTerminalIcon(shellLaunchConfig.icon) || !shellLaunchConfig.name) {
		return undefined;
	}

	return { name: shellLaunchConfig.name, titleTemplate: shellLaunchConfig.titleTemplate };
}

/**
 * The names of the agents a window had running, out of what was kept for them: by each terminal's
 * shell integration nonce, which its process carries across a reload. Storage that cannot be read
 * gives none rather than a wrong one.
 */
export function readAgentNames(value: string | undefined): Map<string, IAgentName> {
	const names = new Map<string, IAgentName>();

	let stored: unknown;
	try {
		stored = value ? JSON.parse(value) : undefined;
	} catch {
		return names;
	}

	if (isObject(stored)) {
		for (const [nonce, kept] of Object.entries(stored)) {
			// A name on its own is how the agent button's agents were kept before any other agent was
			if (isString(kept) && kept) {
				names.set(nonce, { name: kept, titleTemplate: AGENT_TITLE_TEMPLATE });
			} else if (isObject(kept)) {
				const { name, titleTemplate } = kept as { name?: unknown; titleTemplate?: unknown };
				if (isString(name) && name) {
					names.set(nonce, { name, titleTemplate: isString(titleTemplate) ? titleTemplate : undefined });
				}
			}
		}
	}

	return names;
}

/**
 * Gives an agent's terminal that a reload brought back the name and title template it was started
 * with, found by its nonce, and answers whether it did. A terminal reconnecting carries neither, only
 * the title the pty host last had for it. Without the template, the agent button's would read the
 * name of its process rather than the title the agent sets. And the window tells the pty host of
 * titles in one debounced call for all its terminals, so the name one was started with can have been
 * dropped for another terminal's title. Given both back, it takes the course it took when it started.
 *
 * ⚠️ Only one still drawn as an agent's: given another icon since, it is no longer one.
 */
export function restoreAgentLaunch(shellLaunchConfig: IShellLaunchConfig, names: ReadonlyMap<string, IAgentName>): boolean {
	const reconnecting = shellLaunchConfig.attachPersistentProcess;
	const kept = reconnecting && isAgentTerminalIcon(reconnecting.icon) ? names.get(reconnecting.shellIntegrationNonce) : undefined;
	if (!kept) {
		return false;
	}

	shellLaunchConfig.name = kept.name;
	shellLaunchConfig.titleTemplate = kept.titleTemplate;
	return true;
}

/**
 * Something the agent button can start: a name and a command line.
 */
export interface ITerminalLauncher {
	readonly id: string;
	readonly label: string;

	/** Sent to a new shell in the active folder. An empty command means just the shell. */
	readonly command: string;
}

/**
 * The launchers this fork knows about. A table rather than a fixed set of buttons, so that adding
 * one costs a row.
 *
 * A name and a command, and nothing else. No glyph to store: an agent's is worked out from its
 * command (`agentIcon`), so there is no per-agent icon to pick, to keep, or to get wrong.
 *
 * And nothing about where the thing is installed. An earlier version carried a list of directories
 * per launcher and it was a list of Windows paths copied off one machine: `%LOCALAPPDATA%` means
 * nothing on macOS, and there was no macOS or Linux entry to mean anything instead. Where a tool
 * lives is what the shell's own `PATH` already answers, on every platform, without a table that
 * goes stale the next time an installer moves.
 */
export const BUILT_IN_LAUNCHERS: readonly ITerminalLauncher[] = [
	{ id: 'claude', label: 'Claude Code', command: 'claude' },
	{ id: 'codex', label: 'Codex', command: 'codex' },
	{ id: 'antigravity', label: 'Antigravity', command: 'agy' },
	{ id: 'muse', label: 'Muse Code', command: 'muse' },
	{ id: 'grok', label: 'Grok Build', command: 'grok' }
];

/**
 * What a bare command could be called on Windows when `PATHEXT` cannot be read.
 *
 * A fallback and not the answer: the real list is the environment's, which is what
 * `TerminalLauncherDetection` asks for, and it carries entries like `.PS1` that this does not.
 */
export const WINDOWS_PATH_EXTENSIONS: readonly string[] = ['.com', '.exe', '.bat', '.cmd'];

/** The setting that holds the agents somebody has added to the button. */
export const AGENTS_SETTING = 'facade.agents';

/**
 * The executable a command line starts with, or `undefined` when there is no command. Quoted
 * first, so that a path containing spaces is a single word.
 */
export function commandExecutable(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) {
		return undefined;
	}

	const quoted = trimmed.match(/^"(?<double>[^"]+)"|^'(?<single>[^']+)'/);
	if (quoted) {
		return quoted.groups?.double ?? quoted.groups?.single;
	}

	return trimmed.split(/\s+/)[0];
}

/**
 * The file names a bare command could resolve to.
 *
 * Windows finds `claude` by trying `claude.exe` and the rest of `PATHEXT`; a name that already
 * carries one of those extensions is left alone. An empty list is every other platform, where the
 * name on the command line is the name on disk.
 */
export function executableFileNames(executable: string, pathExtensions: readonly string[]): string[] {
	if (pathExtensions.length === 0) {
		return [executable];
	}

	const hasExtension = pathExtensions.some(extension => executable.toLowerCase().endsWith(extension.toLowerCase()));
	return hasExtension ? [executable] : pathExtensions.map(extension => executable + extension);
}

/** Whether a command names a location rather than something to look for on the search path. */
export function isPathLike(executable: string): boolean {
	return executable.includes('/') || executable.includes('\\');
}

/**
 * The agents somebody has added, out of the setting's raw value.
 *
 * Hand-edited JSON, so every field is checked and a row that does not answer is dropped rather
 * than drawn as a button that cannot start anything. An empty command is kept: it means the shell.
 */
export function readConfiguredLaunchers(value: unknown): ITerminalLauncher[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const launchers: ITerminalLauncher[] = [];
	const seen = new Set<string>();

	for (const entry of value) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}

		const { id, label, command } = entry as Record<string, unknown>;
		if (typeof id !== 'string' || !id.trim() || typeof command !== 'string' || seen.has(id)) {
			continue;
		}

		seen.add(id);
		launchers.push({
			id,
			label: typeof label === 'string' && label.trim() ? label : id,
			command
		});
	}

	return launchers;
}

/** What goes back into the setting: the fields somebody can change, and nothing else. */
export function toConfiguredLaunchers(launchers: readonly ITerminalLauncher[]): object[] {
	return launchers.map(({ id, label, command }) => ({ id, label, command }));
}

/**
 * The agents to start somebody off with, the first time the dialog is opened and never again.
 *
 * A seed and not a verdict. The scan reads the `PATH` the window was started with, and Windows
 * does not hand a new one to a process that is already running - measured here, `agy` was on the
 * stored `PATH` and absent from the running one, so an installed agent looked missing. Whatever
 * comes back, the list is somebody's to edit from then on.
 */
export function seedLaunchers(detected: ReadonlySet<string>): ITerminalLauncher[] {
	const found = BUILT_IN_LAUNCHERS.filter(launcher => detected.has(launcher.id));

	// Nothing found is usually the scan being wrong rather than the machine being empty, so the
	// whole table is offered instead of an empty form
	return [...(found.length ? found : BUILT_IN_LAUNCHERS)];
}

/**
 * An id for a row somebody just added, from the name they gave it.
 *
 * Only ever computed for a new row: an id already in the setting is what its command is registered
 * under, and renaming an agent should not make it a different one.
 */
export function uniqueLauncherId(label: string, taken: ReadonlySet<string>): string {
	const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
	if (!taken.has(base)) {
		return base;
	}

	// Bounded by what is already there, so the loop cannot outlive the set it is avoiding
	for (let suffix = 2; suffix <= taken.size + 2; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) {
			return candidate;
		}
	}

	return `${base}-${taken.size + 3}`;
}

/**
 * The directories a `PATH` names, in order and without repeats.
 *
 * The separator and the case folding are the caller's, so that both platforms' rules can be
 * exercised from either one: Windows joins with `;` and treats two spellings of a directory as one,
 * everything else joins with `:` and does not.
 */
export function searchPathEntries(path: string, separator: string, caseSensitive: boolean): string[] {
	const entries: string[] = [];
	const seen = new Set<string>();

	for (const raw of path.split(separator)) {
		const entry = raw.trim();
		if (!entry) {
			continue;
		}

		// Slashes are folded either way, so that `C:\tools` and `C:/tools` are the one directory
		const spelling = entry.replace(/\\/g, '/');
		const key = caseSensitive ? spelling : spelling.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			entries.push(entry);
		}
	}

	return entries;
}
