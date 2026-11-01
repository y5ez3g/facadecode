/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { clauseOf } from '../base/errors';
import type { FacadeReason, WorktreeCreationEffects } from '../core/ports';

/** Native agent presentation shared by pickers, terminal tabs and notifications (ARCHITECTURE-1.3). */
const LOGOS: { readonly [cli: string]: { readonly light: string; readonly dark: string } } = {
	claude: { light: 'claude.svg', dark: 'claude.svg' },
	codex: { light: 'codex-light.svg', dark: 'codex-dark.svg' },
	agy: { light: 'antigravity.png', dark: 'antigravity.png' },
	muse: { light: 'muse.png', dark: 'muse.png' },
	opencode: { light: 'opencode-light.svg', dark: 'opencode-dark.svg' },
	pi: { light: 'pi.svg', dark: 'pi.svg' }
};

/** A built-in CLI's theme logo, or the native terminal icon for another CLI (LIFECYCLE-2.2). */
export function cliIcon(media: vscode.Uri, cli: string): vscode.IconPath {
	const logo = Object.hasOwn(LOGOS, cli) ? LOGOS[cli] : undefined;
	return logo ? { light: vscode.Uri.joinPath(media, 'agents', logo.light), dark: vscode.Uri.joinPath(media, 'agents', logo.dark) } : new vscode.ThemeIcon('terminal');
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
export function reasonText(said: FacadeReason | undefined, otherwise: string): string {
	const [a = '', b = '', c = '', d = '', e = ''] = said?.values ?? [];
	switch (said?.kind) {
		// {0} is the setting, such as facade.claude; {1} the type of value it holds, such as number
		case 'path_type': return vscode.l10n.t("{0}.path must be a string; received {1}", a, b);
		case 'path_blank': return vscode.l10n.t("{0}.path contains only whitespace. Set the program's path, or leave it empty to find the CLI on PATH", a);
		case 'path_nul': return vscode.l10n.t("{0}.path contains a NUL character, which no path can hold", a);
		// {0} is the setting, such as facade.claude; {1} the type of value it holds, such as string
		case 'enabled_type': return vscode.l10n.t("{0}.enabled must be true or false; received {1}", a, b);
		case 'launch_type': return vscode.l10n.t("{0}.launch must be an object with arguments and environment; received {1}", a, b);
		// {0} is the setting, such as facade.claude; {1} a field of its launch that is no setting
		case 'launch_field': return vscode.l10n.t("{0}.launch.{1} is not a launch setting; launch accepts only arguments and environment", a, b);
		// {0} is the setting, such as facade.claude.launch.arguments; {1} the argument's place in it, from 0; {2} the option, such as --settings
		case 'launch_owned': return vscode.l10n.t("{0}[{1}] is {2}, which Facade sets itself; remove it", a, b, c);
		// {0} is the setting, such as facade.claude.launch.arguments; {1} the type of value it holds, such as object
		case 'arguments_type': return vscode.l10n.t("{0} must be an array of strings; received {1}", a, b);
		// {0} is the setting, such as facade.claude.launch.arguments; {1} the argument's place in it, from 0; {2} the type of value there, such as number
		case 'argument_type': return vscode.l10n.t("{0}[{1}] must be a string; received {2}", a, b, c);
		case 'argument_nul': return vscode.l10n.t("{0}[{1}] contains a NUL character, which no argument can carry", a, b);
		// {0} is the setting, such as facade.claude.launch.environment; {1} the type of value it holds, such as array, or a variable's name, quoted
		case 'environment_type': return vscode.l10n.t("{0} must be an object of variable names to strings or null; received {1}", a, b);
		case 'environment_name': return vscode.l10n.t("{0} has the variable name {1}, which no environment can hold", a, b);
		// {0} is the setting, such as facade.claude.launch.environment; {1} a variable's name; {2} the type of value it is given, such as number
		case 'environment_value': return vscode.l10n.t("{0}.{1} must be a string or null; received {2}", a, b, c);
		case 'environment_nul': return vscode.l10n.t("{0}.{1} contains a NUL character, which no variable can carry", a, b);
		// {0} is the CLI's name, such as Claude Code; {1} its setting, such as facade.claude
		case 'cli_disabled': return vscode.l10n.t("{0} is turned off by {1}.enabled", a, b);
		// {0} is the CLI's command, {1} the folder, {2} the setting
		case 'not_on_path': return vscode.l10n.t("{0} was not found on the PATH of a terminal in {1}, and {2}.path does not name its location", a, b, c);
		case 'path_not_on_path': return vscode.l10n.t("{0}.path is {1}, which was not found on the PATH of a terminal in {2}", a, b, c);
		case 'not_runnable': return vscode.l10n.t("{0}.path is {1}, and {2} is not a program that can be run", a, b, c);
		// {0} is the program, {1} the argument, {2} the setting
		case 'cmd_unsafe': return vscode.l10n.t("{0} runs through cmd.exe, which cannot be given the argument {1} safely; set {2}.path to the CLI's own program or Node entry point", a, b, c);
		// {0} is the program; {1} the setting, such as facade.claude.launch.arguments; {2} the argument's place in it; {3} the character; {4} the CLI's setting
		case 'cmd_unsafe_setting': return vscode.l10n.t("{0} runs through cmd.exe, which cannot be given {1}[{2}] safely, as that argument contains {3}; set {4}.path to the CLI's own program or Node entry point", a, b, c, d, e);
		// {0} is the program, {1} the setting
		case 'cmd_unsafe_path': return vscode.l10n.t("{0} runs through cmd.exe, which cannot be given its path safely; set {1}.path to the CLI's own program or Node entry point", a, b);
		// {0} is the program, {1} the folder - a network share's or a WSL distribution's, starting with \\ - {2} the setting
		case 'cmd_unc_folder': return vscode.l10n.t("{0} runs through cmd.exe, which cannot run in the UNC folder {1}; set {2}.path to the CLI's own program or Node entry point", a, b, c);
		// {0} is the script, such as a package's cli.js
		case 'node_missing': return vscode.l10n.t("{0} is a Node script, and Node is not on the PATH to run it", a);
		case 'yolo_type': return vscode.l10n.t("facade.yolo must be true or false; received {0}", a);
		// {0} is the setting, facade.custom; {1} the type of value it holds, such as array
		case 'custom_type': return vscode.l10n.t("{0} must be an object of custom CLIs by ID; received {1}", a, b);
		// {0} is the setting, facade.custom; {1} the ID, quoted, such as ""
		case 'custom_key': return vscode.l10n.t("{0}: {1} cannot be a CLI's ID, which must have a visible character and no control character; choose another ID for the custom CLI", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.claude; {1} its ID, quoted
		case 'custom_builtin': return vscode.l10n.t("{0}: {1} is the ID of a built-in CLI; choose another ID for the custom CLI", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} the type of value it holds, such as string; {2} an example definition
		case 'custom_entry_type': return vscode.l10n.t("{0} must be an object such as {2}; received {1}", a, b, c);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli
		case 'custom_capabilities': return vscode.l10n.t("{0}.capabilities is not a custom CLI setting: capabilities are what a shipped adapter proves, never configured. Remove it", a);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} a field of it that is no setting
		case 'custom_field': return vscode.l10n.t("{0}.{1} is not a custom CLI setting; a custom CLI accepts only path and launch", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli
		case 'custom_path_missing': return vscode.l10n.t("{0}.path is missing; set it to the program to run", a);
		case 'custom_path_empty': return vscode.l10n.t("{0}.path is empty or contains only whitespace; set it to the program to run", a);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} the type of value it holds, such as array
		case 'custom_launch_type': return vscode.l10n.t("{0}.launch must be an object with start, resume and environment; received {1}", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} a field of its launch that is no setting
		case 'custom_launch_field': return vscode.l10n.t("{0}.launch.{1} is not a custom launch setting; a custom launch accepts only start, resume and environment", a, b);
		// {0} is a custom CLI's setting, such as facade.custom.my-cli; {1} the placeholder, ${sessionId}
		case 'custom_resume_missing': return vscode.l10n.t("{0}.launch.resume is required: the arguments that resume an exact conversation, containing {1}", a, b);
		case 'custom_resume_placeholder': return vscode.l10n.t("{0}.launch.resume must contain {1}, the exact session ID it resumes", a, b);
		// {0} is the setting, such as facade.custom.my-cli.launch.start; {1} the argument's place in it, from 0; {2} the placeholder, ${sessionId}
		case 'custom_placeholder': return vscode.l10n.t("{0}[{1}] uses an unsupported placeholder; {2} in resume is the only placeholder a custom CLI's arguments can contain", a, b, c);
		// {0} is the setting, such as facade.custom.my-cli.launch.start; {1} the argument's place in it, from 0; {2} the placeholder, ${sessionId}
		case 'custom_start_session': return vscode.l10n.t("{0}[{1}] uses {2}, which only resume can contain: a new conversation has no session ID yet", a, b, c);
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

/** How long ago `time` was, in the window's language, as briefly as it says it: now, 5 min. ago, yesterday (UX-2.4). */
export function ago(time: number, now: number, language: string): string {
	const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
	const minutes = Math.floor(Math.max(0, now - time) / 60_000);
	if (minutes < 1) {
		return format.format(0, 'second');
	}
	if (minutes < 60) {
		return format.format(-minutes, 'minute');
	}
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? format.format(-hours, 'hour') : format.format(-Math.floor(hours / 24), 'day');
}
