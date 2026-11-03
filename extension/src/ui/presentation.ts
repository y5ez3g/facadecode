/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { clauseOf, messageOf } from '../base/errors';
import { FacadeError } from '../core/errors';
import { PlanError, type FacadeReason, type WorktreeCreationEffects } from '../core/ports';

/** Native agent presentation shared by pickers, terminal tabs and notifications (ARCHITECTURE-1.3). */
const LOGOS: { readonly [cli: string]: { readonly name: string; readonly light: string; readonly dark: string } } = {
	claude: { name: 'Claude Code', light: 'claude.svg', dark: 'claude.svg' },
	codex: { name: 'Codex', light: 'codex-light.svg', dark: 'codex-dark.svg' },
	agy: { name: 'Antigravity', light: 'antigravity.png', dark: 'antigravity.png' },
	muse: { name: 'Muse Code', light: 'muse.png', dark: 'muse.png' },
	opencode: { name: 'OpenCode', light: 'opencode-light.svg', dark: 'opencode-dark.svg' },
	pi: { name: 'Pi', light: 'pi.svg', dark: 'pi.svg' }
};

/** The name behind a built-in's logo, for searching rows that show only that logo (LIFECYCLE-2.3). */
export function cliDisplayName(cli: string): string {
	return Object.hasOwn(LOGOS, cli) ? LOGOS[cli].name : cli;
}

/** Image logos for native pickers; terminal tabs use cliTerminalIcon (LIFECYCLE-2.2). */
export function cliIcon(media: vscode.Uri, cli: string): vscode.IconPath {
	const logo = Object.hasOwn(LOGOS, cli) ? LOGOS[cli] : undefined;
	return logo ? { light: vscode.Uri.joinPath(media, 'agents', logo.light), dark: vscode.Uri.joinPath(media, 'agents', logo.dark) } : new vscode.ThemeIcon('terminal');
}

/** Contributed glyphs survive native file-icon theme rules that can hide terminal URI icons (LIFECYCLE-2.2). */
export function cliTerminalIcon(cli: string): vscode.ThemeIcon {
	return Object.hasOwn(LOGOS, cli)
		? new vscode.ThemeIcon(`facade-cli-${cli}`, new vscode.ThemeColor('foreground'))
		: new vscode.ThemeIcon('terminal');
}

/** The same launch failure whether it is caught by the picker or reported later by the host (UX-1.2). */
export function launchFailureText(name: string, reason: string, effects?: WorktreeCreationEffects): string {
	return withWorktreeEffects(vscode.l10n.t("Could not start {0}: {1}.", name, clauseOf(reason)), effects);
}

/** Standalone creation has no agent to start; only its failure prefix differs. */
export function worktreeFailureText(reason: string, effects?: WorktreeCreationEffects): string {
	return withWorktreeEffects(vscode.l10n.t("Could not create worktree: {0}.", clauseOf(reason)), effects);
}

/** Notifications and retained cards describe the same confirmed effects, without inventing a rollback. */
export function withWorktreeEffects(reason: string, effects?: WorktreeCreationEffects): string {
	const retained = effects?.branch && effects.folder
		? vscode.l10n.t("Branch {0} and folder {1} were created and kept.", effects.branch, effects.folder)
		: effects?.branch ? vscode.l10n.t("Branch {0} was created and kept.", effects.branch)
			: effects?.folder ? vscode.l10n.t("Folder {0} was created and kept.", effects.folder) : '';
	const sentence = /[.!?。！？…]\s*$/.test(reason) ? reason.trimEnd() : `${reason}.`;
	return retained ? `${sentence} ${retained}` : reason;
}

/** Facade's own reason in the person's language (UX-2.4): a CLI's configuration or a launch setting; `otherwise` where it has none. */
/**
 * Why an operation of the person's failed, as they are told it (UX-2.4): Facade's own reason in their language, any other error -
 * the system's, Git's or a CLI's - in its own words.
 */
export function reasonOf(err: unknown): string {
	return err instanceof PlanError || err instanceof FacadeError ? reasonText(err.said, err.message) : messageOf(err);
}

export function reasonText(said: FacadeReason | undefined, otherwise: string): string {
	const [a = '', b = '', c = '', d = '', e = ''] = said?.values ?? [];
	switch (said?.kind) {
		// {0} is the setting, such as facade.claude; {1} the type of value it holds, such as number
		case 'path_type': return vscode.l10n.t("{0}.path must be a string; received {1}", a, b);
		case 'path_blank': return vscode.l10n.t("{0}.path contains only whitespace. Set the program path, or leave it empty to find the CLI on PATH", a);
		case 'path_nul': return vscode.l10n.t("{0}.path contains a NUL character, which is not permitted in paths", a);
		// {0} is the setting, such as facade.claude; {1} the type of value it holds, such as string
		case 'enabled_type': return vscode.l10n.t("{0}.enabled must be true or false; received {1}", a, b);
		case 'launch_type': return vscode.l10n.t("{0}.launch must be an object with arguments and environment; received {1}", a, b);
		// {0} is the setting, such as facade.claude; {1} a field of its launch that is no setting
		case 'launch_field': return vscode.l10n.t("{0}.launch.{1} is not a launch setting; launch accepts only arguments and environment", a, b);
		// {0} is the setting, such as facade.claude.launch.arguments; {1} the argument's place in it, from 0; {2} the option, such as --settings
		case 'launch_owned': return vscode.l10n.t("{0}[{1}] is {2}, which is reserved by Facade; remove it", a, b, c);
		// {0} is the setting, such as facade.claude.launch.arguments; {1} the type of value it holds, such as object
		case 'arguments_type': return vscode.l10n.t("{0} must be an array of strings; received {1}", a, b);
		// {0} is the setting, such as facade.claude.launch.arguments; {1} the argument's place in it, from 0; {2} the type of value there, such as number
		case 'argument_type': return vscode.l10n.t("{0}[{1}] must be a string; received {2}", a, b, c);
		case 'argument_nul': return vscode.l10n.t("{0}[{1}] contains a NUL character, which is not permitted in arguments", a, b);
		// {0} is the setting, such as facade.claude.launch.environment; {1} the type of value it holds, such as array, or a variable's name, quoted
		case 'environment_type': return vscode.l10n.t("{0} must be an object of variable names to strings or null; received {1}", a, b);
		case 'environment_name': return vscode.l10n.t("{0} contains invalid environment variable name {1}", a, b);
		// {0} is the setting, such as facade.claude.launch.environment; {1} a variable's name; {2} the type of value it is given, such as number
		case 'environment_value': return vscode.l10n.t("{0}.{1} must be a string or null; received {2}", a, b, c);
		case 'environment_nul': return vscode.l10n.t("{0}.{1} contains a NUL character, which is not permitted in environment variables", a, b);
		// {0} is the CLI's name, such as Claude Code; {1} its setting, such as facade.claude
		case 'cli_disabled': return vscode.l10n.t("{0} is disabled by {1}.enabled", a, b);
		// {0} is the CLI's command, {1} the folder, {2} the setting
		case 'not_on_path': return vscode.l10n.t("{0} was not found on PATH in {1}, and {2}.path is not configured", a, b, c);
		case 'path_not_on_path': return vscode.l10n.t("{0}.path is {1}, which was not found on PATH in {2}", a, b, c);
		case 'not_runnable': return vscode.l10n.t("{0}.path is {1}, and {2} is not an executable program", a, b, c);
		// {0} is the program, {1} the argument, {2} the setting
		case 'cmd_unsafe': return vscode.l10n.t("{0} runs via cmd.exe, which cannot safely accept argument {1}; set {2}.path to the CLI executable or Node entry point", a, b, c);
		// {0} is the program; {1} the setting, such as facade.claude.launch.arguments; {2} the argument's place in it; {3} the character; {4} the CLI's setting
		case 'cmd_unsafe_setting': return vscode.l10n.t("{0} runs via cmd.exe, which cannot safely accept {1}[{2}] containing {3}; set {4}.path to the CLI executable or Node entry point", a, b, c, d, e);
		// {0} is the program, {1} the setting
		case 'cmd_unsafe_path': return vscode.l10n.t("{0} runs via cmd.exe, which cannot safely accept its path; set {1}.path to the CLI executable or Node entry point", a, b);
		// {0} is the program, {1} the folder - a network share's or a WSL distribution's, starting with \\ - {2} the setting
		case 'cmd_unc_folder': return vscode.l10n.t("{0} runs via cmd.exe, which cannot run in UNC path {1}; set {2}.path to the CLI executable or Node entry point", a, b, c);
		// {0} is the installed version of OpenCode, such as 1.19.5; the commands are npm's, to be kept as they are
		case 'opencode_1x': return vscode.l10n.t("OpenCode {0} is not supported: Facade Code needs OpenCode 2 or later. Replace npm's opencode-ai with @opencode/cli: npm uninstall -g opencode-ai, then npm install -g @opencode/cli", a);
		// {0} is the script, such as a package's cli.js
		case 'node_missing': return vscode.l10n.t("{0} is a Node script, and Node is not on PATH to run it", a);
		case 'yolo_type': return vscode.l10n.t("facade.yolo must be true or false; received {0}", a);
		// {0} is the setting, facade.custom; {1} the type of value it holds, such as array
		case 'custom_type': return vscode.l10n.t("{0} must be an object of custom CLIs by ID; received {1}", a, b);
		// {0} is the setting, facade.custom; {1} the ID, quoted, such as ""
		case 'custom_key': return vscode.l10n.t("{0}: {1} is not a valid CLI ID; must contain visible characters without control characters", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.claude; {1} its ID, quoted
		case 'custom_builtin': return vscode.l10n.t("{0}: {1} matches a built-in CLI ID; choose a different ID for the custom CLI", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} the type of value it holds, such as string; {2} an example definition
		case 'custom_entry_type': return vscode.l10n.t("{0} must be an object such as {2}; received {1}", a, b, c);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli
		case 'custom_capabilities': return vscode.l10n.t("{0}.capabilities is not a supported setting; remove it", a);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} a field of it that is no setting
		case 'custom_field': return vscode.l10n.t("{0}.{1} is not a custom CLI setting; a custom CLI accepts only path and launch", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli
		case 'custom_path_missing': return vscode.l10n.t("{0}.path is missing; set it to the program to run", a);
		case 'custom_path_empty': return vscode.l10n.t("{0}.path is empty or contains only whitespace; set it to the program to run", a);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} the type of value it holds, such as array
		case 'custom_launch_type': return vscode.l10n.t("{0}.launch must be an object with start, resume, and environment; received {1}", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} a field of its launch that is no setting
		case 'custom_launch_field': return vscode.l10n.t("{0}.launch.{1} is not a custom launch setting; a custom launch accepts only start, resume, and environment", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} the placeholder, ${sessionId}
		case 'custom_resume_missing': return vscode.l10n.t("{0}.launch.resume is required: the arguments that resume an exact conversation, containing {1}", a, b);
		case 'custom_resume_placeholder': return vscode.l10n.t("{0}.launch.resume must contain {1}, the exact session ID it resumes", a, b);
		// {0} is the setting, such as facade.custom.my-cli.launch.start; {1} the argument's place in it, from 0; {2} the placeholder, ${sessionId}
		case 'custom_placeholder': return vscode.l10n.t("{0}[{1}] uses an unsupported placeholder; {2} in resume is the only placeholder a custom CLI's arguments can contain", a, b, c);
		// {0} is the setting, such as facade.custom.my-cli.launch.start; {1} the argument's place in it, from 0; {2} the placeholder, ${sessionId}
		case 'custom_start_session': return vscode.l10n.t("{0}[{1}] uses {2}, which only resume can contain: a new conversation has no session ID yet", a, b, c);
		case 'component_outdated': return vscode.l10n.t("Facade Code requires a newer Window Component. Update \"Facade Code Window Component\" on this computer, then reload the window.");
		case 'numbers_unavailable': return vscode.l10n.t("This computer's counter could not give the agent a number. Try again.");
		case 'ownership_lost': return vscode.l10n.t("This workspace is owned by another window. Reload this window to take ownership.");
		// {0} is the CLI's ID, quoted
		case 'cli_not_configured': return vscode.l10n.t("No CLI {0} is configured.", a);
		case 'pin_unsupported': return vscode.l10n.t("Its CLI cannot resume this exact conversation, so it cannot be pinned.");
		case 'location_gone': return vscode.l10n.t("The working location is no longer available.");
		// {0} is the working location's path
		case 'location_not_here': return vscode.l10n.t("The working location {0} is not available in this window.", a);
		default: return otherwise;
	}
}

/**
 * `text` as a picker's row or an input box's message shows it, word for word: the editor draws `$(name)` there as a theme icon, and a
 * name, path, branch or CLI title may hold it (PANEL-3.2). A title draws it as it is, and is given it as it is.
 */
export function plainText(text: string): string {
	return text.replace(/\$\(/g, '\\$(');
}

/** How many agents, in words: the panel's badge and Filter by Working Location say it alike (PANEL-1.1, 2.3). */
export function agentCountText(count: number): string {
	return count === 1 ? vscode.l10n.t("1 agent") : vscode.l10n.t("{0} agents", count);
}

/** The configuration action's native-button label, without the command's menu ellipsis (UX-1.3). */
export function configureAgentsLabel(): string {
	return vscode.l10n.t("Configure Agents");
}

/**
 * History-list age in the window's language (UX-2.4). Unit thresholds, rounding and short phrases follow VS Code's
 * `fromNow` with `ago` enabled (Microsoft, MIT; ThirdPartyNotices.txt). No private editor API is imported.
 */
export function ago(time: number, now: number, language: string): string {
	// Preserve a source clock ahead of this window instead of inventing fresh activity.
	if (time > now) {
		return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' }).format(time);
	}
	const seconds = Math.round((now - time) / 1_000);
	if (seconds < 30) {
		return vscode.l10n.t("now");
	}
	if (seconds < 60) {
		return vscode.l10n.t("{0} secs ago", seconds);
	}
	if (seconds < 3_600) {
		const minutes = Math.round(seconds / 60);
		return minutes === 1 ? vscode.l10n.t("{0} min ago", minutes) : vscode.l10n.t("{0} mins ago", minutes);
	}
	if (seconds < 86_400) {
		const hours = Math.round(seconds / 3_600);
		return hours === 1 ? vscode.l10n.t("{0} hr ago", hours) : vscode.l10n.t("{0} hrs ago", hours);
	}
	if (seconds < 604_800) {
		const days = Math.round(seconds / 86_400);
		return days === 1 ? vscode.l10n.t("{0} day ago", days) : vscode.l10n.t("{0} days ago", days);
	}
	if (seconds < 2_592_000) {
		const weeks = Math.round(seconds / 604_800);
		return weeks === 1 ? vscode.l10n.t("{0} wk ago", weeks) : vscode.l10n.t("{0} wks ago", weeks);
	}
	if (seconds < 31_536_000) {
		const months = Math.round(seconds / 2_592_000);
		return months === 1 ? vscode.l10n.t("{0} mo ago", months) : vscode.l10n.t("{0} mos ago", months);
	}
	const years = Math.round(seconds / 31_536_000);
	return years === 1 ? vscode.l10n.t("{0} yr ago", years) : vscode.l10n.t("{0} yrs ago", years);
}
