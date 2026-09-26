/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { TerminalIcon } from '../../../../platform/terminal/common/terminal.js';
import { StartupKind } from '../../../services/lifecycle/common/lifecycle.js';

/**
 * The glyph every agent terminal is drawn with, and how one is recognised afterwards.
 *
 * The recognising is why this is a constant rather than a choice. A terminal has nowhere to carry
 * a flag of ours: `reconnectionProperties` is the field upstream built for an owner to mark one,
 * and setting it takes the terminal out of `shouldPersist` unless `task.reconnection` is on - a
 * worse bug traded for a smaller one. The icon is what survives, so the icon is the marker.
 */
export const AGENT_TERMINAL_ICON = Codicon.robot;

/**
 * Whether a terminal is drawn as an agent's, which is what makes it one.
 *
 * ⚠️ It reads both ways, and that is the price of the marker. Changing an agent tab's icon stops
 * it being an agent tab, and giving a plain terminal the robot starts it being one. A terminal
 * that looks like an agent behaves like one, which is at least a rule somebody can see.
 */
export function isAgentTerminalIcon(icon: TerminalIcon | undefined): boolean {
	return ThemeIcon.isThemeIcon(icon) && icon.id === AGENT_TERMINAL_ICON.id;
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
 * A name and a command, and nothing else. No glyph, because every agent is drawn with the robot
 * the button carries, so there is no per-agent icon to pick, to store, or to get wrong.
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
