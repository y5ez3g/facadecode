/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isObject, isString } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { IReconnectionProperties, IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ILifecycleService, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { isFacadeRunTerminal } from '../../facadeCommands/common/facadeRun.js';

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
 * The icon an agent's terminal is drawn with: a built-in agent's logo, by the command it runs; the robot
 * for every custom agent, whatever program it runs - and for a command that is only a shell.
 *
 * ⚠️ A custom agent is never drawn as a built-in, even one that runs `claude`: the logo says Facade's own
 * integration of that CLI - its tools, YOLO and trust - which a custom agent's launch does not have
 * (AGENT-LAUNCHER.md, L3: "every custom agent uses the standard robot icon, whatever program it runs";
 * X-60). A built-in's command is read as the last segment of a path, without an extension:
 * `C:\tools\claude.cmd` is `claude`.
 */
export function agentIcon(command: string, custom = false): ThemeIcon {
	const name = custom ? undefined : programOf(command);
	return (name && AGENT_ICONS.get(name)) || AGENT_TERMINAL_ICON;
}

/** The program a command starts, by its name: the last segment of its path, without an extension, in lower case. */
function programOf(command: string): string | undefined {
	return commandExecutable(command)?.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, '').toLowerCase();
}

/**
 * Whether a terminal being brought back as the window starts is an agent's that is gone: the window's
 * last shutdown - closed, quit, left for another workspace - ended its agents, and only a reload finds
 * them still running. Brought back anyway, its tab would be its CLI run again, or a fresh shell under the
 * old output - so it is left out, as upstream leaves out a task's terminal
 * (`TerminalService._recreateTerminalGroup`). An agent's terminal is one marked as an agent's run
 * (`isFacadeRunTerminal`), as every agent Facade starts is - from the agent menu or through `start_agent`,
 * the agent framework on or off - whatever its icon: not one only drawn as an agent's, an ordinary
 * terminal the person gave the robot, whose shell comes back as any other's (X-51, N-78).
 *
 * ⚠️ Not after a crash: its window did not shut down - no reason recorded - and its Reopen is a new window
 * whose agents run on in the pty host. They come back in their places, the panel's, the editor area's
 * and floating windows', not taken back afterwards all in one editor group (N-49).
 */
export function isAgentGoneAtStartup(terminal: { readonly reconnectionProperties?: IReconnectionProperties }, lifecycle: Pick<ILifecycleService, 'startupKind' | 'lastShutdownReason'>): boolean {
	return lifecycle.startupKind !== StartupKind.ReloadedWindow && lifecycle.lastShutdownReason !== undefined && isFacadeRunTerminal(terminal);
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
 * was started with, when it is an agent's - marked as its run's (`isFacadeRunTerminal`), as every agent
 * Facade starts is, whatever its icon. Undefined for any other - an ordinary terminal drawn with the
 * robot among them - one without a name, and one a reload brought back (`restoreAgentLaunch`).
 */
export function agentLaunchOf(shellLaunchConfig: IShellLaunchConfig): IAgentName | undefined {
	if (shellLaunchConfig.attachPersistentProcess || !isFacadeRunTerminal(shellLaunchConfig) || !shellLaunchConfig.name) {
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
 * ⚠️ Only an agent's: its process marked as its run's, whatever its icon - not an ordinary terminal drawn
 * with the robot (`agentLaunchOf`).
 */
export function restoreAgentLaunch(shellLaunchConfig: IShellLaunchConfig, names: ReadonlyMap<string, IAgentName>): boolean {
	const reconnecting = shellLaunchConfig.attachPersistentProcess;
	const kept = reconnecting && isFacadeRunTerminal(reconnecting) ? names.get(reconnecting.shellIntegrationNonce) : undefined;
	if (!reconnecting || !kept) {
		return false;
	}

	shellLaunchConfig.name = kept.name;
	shellLaunchConfig.titleTemplate = kept.titleTemplate;
	return true;
}

/**
 * Something the agent menu can start: an agent, by the id Start Agent takes - a built-in's, or a custom
 * agent's name - with its label and the program that runs it, which gives its logo.
 */
export interface ITerminalLauncher {
	readonly id: string;
	readonly label: string;

	/** The program it runs: a built-in's command, or the path a custom agent's setting names. */
	readonly command: string;

	/** Where its settings are: `facade.agents.<cli>` for a built-in; none for a custom agent. */
	readonly setting?: string;

	/** Whether it is one of the person's custom agents. */
	readonly custom?: boolean;
}

/**
 * The built-in agents, in the order the agent menu lists them (AGENT-LAUNCHER.md, L3): Claude Code, Codex,
 * Antigravity, Muse Code - each by the id Start Agent takes, its settings, and the command looked for.
 *
 * Nothing about where the thing is installed: where a tool lives is what the terminal's own `PATH`
 * answers, on every platform, or the person's path setting.
 */
export const BUILT_IN_LAUNCHERS: readonly ITerminalLauncher[] = [
	{ id: 'claude', label: 'Claude Code', command: 'claude', setting: 'facade.agents.claude' },
	{ id: 'codex', label: 'Codex', command: 'codex', setting: 'facade.agents.codex' },
	{ id: 'agy', label: 'Antigravity', command: 'agy', setting: 'facade.agents.antigravity' },
	{ id: 'muse', label: 'Muse Code', command: 'muse', setting: 'facade.agents.muse' }
];

/** The setting that holds the person's custom agents, by name: `{ "<name>": { "path": "...", "launch": { ... } } }`. */
export const CUSTOM_AGENTS_SETTING = 'facade.agents.custom';

/**
 * The person's custom agents, in the order they wrote them, out of the setting's raw value: each by its
 * name, run by the program its `path` names. One whose program is missing is listed all the same, so
 * that choosing it says what is wrong.
 */
export function readCustomAgents(value: unknown): ITerminalLauncher[] {
	if (!isObject(value) || Array.isArray(value)) {
		return [];
	}
	return Object.entries(value).map(([name, entry]) => {
		const program = isObject(entry) && isString((entry as Record<string, unknown>).path) ? ((entry as Record<string, unknown>).path as string).trim() : '';
		return { id: name, label: name, command: program, custom: true };
	});
}

/**
 * What a bare command could be called on Windows when `PATHEXT` cannot be read.
 *
 * A fallback and not the answer: the real list is the environment's, which is what
 * `TerminalLauncherDetection` asks for, and it carries entries like `.PS1` that this does not.
 */
export const WINDOWS_PATH_EXTENSIONS: readonly string[] = ['.com', '.exe', '.bat', '.cmd'];

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

/**
 * Whether a command names a location rather than something to look for on the search path: it has a path separator
 * in it - a backslash one on Windows alone, as the agents' extension reads it.
 */
export function isPathLike(executable: string): boolean {
	return (isWindows ? /[\\/]/ : /\//).test(executable);
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
