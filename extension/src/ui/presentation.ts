/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { clauseOf, messageOf } from '../base/errors';
import { FacadeError } from '../core/errors';
import { PlanError, type FacadeReason, type WorktreeCreationEffects } from '../core/ports';
import { PROGRAM_ICON, robotOf } from '../base/robot';

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

/**
 * The icon `icon` as one there is (CONFIGURATION-2.4): itself, a built-in's logo or a robot; anything else - a CLI's name where no icon
 * is known for it - as a program's.
 */
function knownIcon(icon: string): string {
	return Object.hasOwn(LOGOS, icon) || robotOf(icon) ? icon : PROGRAM_ICON;
}

/**
 * An entry's icon in native pickers (LIFECYCLE-2.2, CONFIGURATION-2.4): a built-in's logo, in each theme's variant where it has two, or
 * a robot's image - the same files as its card's. Terminal tabs use cliTerminalIcon.
 */
export function cliIcon(media: vscode.Uri, icon: string): vscode.IconPath {
	const known = knownIcon(icon);
	const logo = Object.hasOwn(LOGOS, known) ? LOGOS[known] : undefined;
	if (logo) {
		return { light: vscode.Uri.joinPath(media, 'agents', logo.light), dark: vscode.Uri.joinPath(media, 'agents', logo.dark) };
	}
	const robot = vscode.Uri.joinPath(media, 'agents', `robot-${robotOf(known)}.svg`);
	return { light: robot, dark: robot };
}

/**
 * An entry's icon on its terminal tab (LIFECYCLE-2.2, CONFIGURATION-2.4): a glyph Facade contributes, which survives the native file-icon
 * theme rules that can hide a tab's image icon - a built-in's logo in the theme's text color, or a robot in its own colors.
 */
export function cliTerminalIcon(icon: string): vscode.ThemeIcon {
	const known = knownIcon(icon);
	return Object.hasOwn(LOGOS, known)
		? new vscode.ThemeIcon(`facade-cli-${known}`, new vscode.ThemeColor('foreground'))
		: new vscode.ThemeIcon(`facade-robot-${robotOf(known)}`);
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

/**
 * Why an operation of the person's failed, as they are told it (UX-2.4): Facade's own reason in their language, any other error -
 * the system's, Git's or a CLI's - in its own words.
 */
export function reasonOf(err: unknown): string {
	return err instanceof PlanError || err instanceof FacadeError ? reasonText(err.said, err.message) : messageOf(err);
}

/** Facade's own reason in the person's language (UX-2.4), as `said` names it; `otherwise` where it has none. */
export function reasonText(said: FacadeReason | undefined, otherwise: string): string {
	const [a = '', b = '', c = '', d = '', e = ''] = said?.values ?? [];
	switch (said?.kind) {
		// {0} is the settings file, such as ~/.facade/facade.json; {1} a line; {2} a column
		case 'settings_syntax': return vscode.l10n.t("{0}:{1}:{2}: this is not valid JSON with comments", a, b, c);
		// {0} is the settings file; {1} a line; {2} a column; {3} the key, quoted
		case 'settings_duplicate': return vscode.l10n.t("{0}:{1}:{2}: {3} appears twice in the same object", a, b, c, d);
		// {0} is the settings file; {1} the type of value it holds, such as array
		case 'settings_root': return vscode.l10n.t("{0} must hold one object, such as {}; it holds {1}", a, b);
		// {0} is the settings file; {1} a line; {2} a column; {3} the type of value, such as string
		case 'settings_yolo': return vscode.l10n.t("{0}:{1}:{2}: yolo must be true or false; received {3}", a, b, c, d);
		case 'settings_clis': return vscode.l10n.t("{0}:{1}:{2}: clis must be an object of CLIs by name; received {3}", a, b, c, d);
		case 'settings_schema': return vscode.l10n.t("{0}:{1}:{2}: $schema must be a string; received {3}", a, b, c, d);
		case 'settings_names': return vscode.l10n.t("{0}:{1}:{2}: names must be a list of strings; received {3}", a, b, c, d);
		// {0} is the settings file; {1} a line; {2} a column; {3} the name's place in the list, counting from 1
		case 'settings_name_blank': return vscode.l10n.t("{0}:{1}:{2}: the name at position {3} must not be empty or only spaces", a, b, c, d);
		// {0} is the settings file; {1} a line; {2} a column; {3} the key, quoted
		case 'settings_key': return vscode.l10n.t("{0}:{1}:{2}: {3} is not a Facade setting; the settings are yolo, names and clis", a, b, c, d);
		// {0} is the settings file; {1} why, as the system says it
		case 'settings_read': return vscode.l10n.t("{0} could not be read: {1}", a, b);
		case 'settings_create': return vscode.l10n.t("{0} could not be created: {1}", a, b);
		case 'settings_migration_read': return vscode.l10n.t("The editor's Facade settings that {0} would be made from could not be read: {1}", a, b);
		// {0} is an earlier editor setting, such as facade.custom.aider.launch
		case 'migration_shape': return vscode.l10n.t("{0} has no place in facade.json; fix it or remove it, or write facade.json yourself", a);
		// {0} and {1} are earlier editor settings, such as facade.custom.codex and facade.codex; {2} the entry both would be, such as clis.codex
		case 'migration_collision': return vscode.l10n.t("{0} and {1} would both be {2}; rename or remove one of them, or write facade.json yourself", a, b, c);
		// {0} is an entry, such as clis["My CLI"]
		case 'entry_name_empty': return vscode.l10n.t("{0}: a CLI's name needs a visible character", a);
		case 'entry_name_space': return vscode.l10n.t("{0}: a CLI's name cannot start or end with a space", a);
		case 'entry_name_control': return vscode.l10n.t("{0}: a CLI's name cannot hold a control character", a);
		// {0} is an entry, such as clis.Codex; {1} the built-in CLI whose name it is, such as Codex
		case 'entry_name_builtin': return vscode.l10n.t("{0}: this is {1}'s name; choose another name for this CLI", a, b);
		// {0} is an entry, such as clis.codex; {1} the type of value it holds, such as string
		case 'entry_type_object': return vscode.l10n.t("{0} must be an object of type, icon, command, args, env, model, effort and enabled; received {1}", a, b);
		// {0} is an entry, such as clis.codex; {1} a field of it that is no field; {2} the fields an entry takes
		case 'entry_field': return vscode.l10n.t("{0}.{1} is not a field of an entry, which takes {2}", a, b, c);
		// {0} is the field, such as clis.claude.type; {1} the built-in's entry, such as claude; {2} its CLI, such as Claude Code
		case 'entry_type_builtin': return vscode.l10n.t("{0} cannot change the {1} entry's type: it is {2}'s; set it back to \"{1}\" or remove the line", a, b, c);
		// {0} is the field, such as clis["My CLI"].type; {1} the types, such as claude, codex, custom
		case 'entry_type_missing': return vscode.l10n.t("{0} is missing; set it to the CLI it runs: {1}", a, b);
		// {0} is the field, such as clis["My CLI"].type or clis.codex.icon; {1} the values it takes, such as claude, codex, custom; {2} the
		// kind of value it holds, such as string or number
		case 'entry_type_unknown':
		case 'entry_icon': return vscode.l10n.t("{0} must be one of {1}; received {2}", a, b, c);
		// {0} is the field, such as clis.codex.command; {1} the type of value it holds, such as number
		case 'entry_text_type': return vscode.l10n.t("{0} must be a string; received {1}", a, b);
		// {0} is the field, such as clis.codex.model
		case 'entry_text_empty': return vscode.l10n.t("{0} is empty; set it, or leave it out", a);
		case 'entry_text_nul': return vscode.l10n.t("{0} contains a NUL character, which it cannot hold", a);
		case 'entry_command_missing': return vscode.l10n.t("{0} is missing; set it to the program to run", a);
		// {0} is the field, such as clis.aider.model
		case 'entry_choice_program': return vscode.l10n.t("{0} is not taken by a program: give its own options in args", a);
		// {0} is the field, such as clis.opencode.model; {1} the CLI, such as OpenCode
		case 'entry_choice_unsupported': return vscode.l10n.t("{0} is not taken by {1}, which sets it in its own configuration", a, b);
		// {0} is the field, such as clis.codex.enabled; {1} the type of value it holds, such as string
		case 'entry_enabled_type': return vscode.l10n.t("{0} must be true or false; received {1}", a, b);
		// {0} is the setting, such as clis.codex.args; {1} the argument's place in it, from 0; {2} the option, such as --sandbox
		case 'args_reserved': return vscode.l10n.t("{0}[{1}] is {2}, which Facade sets or decides itself; remove it", a, b, c);
		// {0} is the setting, such as clis.codex.args; {1} the argument's place in it, from 0; {2} the configuration key, such as model
		case 'args_reserved_key': return vscode.l10n.t("{0}[{1}] sets {2}, which Facade sets itself; remove it", a, b, c);
		// {0} is the setting, such as clis.codex.args; {1} the argument's place in it, from 0
		case 'args_positional': return vscode.l10n.t("{0}[{1}] is not an option: Facade gives the CLI its task and folder itself, so args holds only options and their values", a, b);
		// {0} is the variable's field, such as clis.claude.env.ANTHROPIC_AUTH_TOKEN; {1} the variable it reads
		// {2} is the reference as written, such as ${env:WORK_API_KEY}: a value of its own, as VS Code fills no placeholder inside braces
		case 'env_reference_missing': return vscode.l10n.t("{0} reads {2}, but {1} is not in the editor's environment; set it there, or write the value", a, b, `\${env:${b}}`);
		// {0} is the setting, such as clis.codex.env; {1} and {2} two variable names
		case 'env_case_duplicate': return vscode.l10n.t("{0} names {1} and {2}, which are one variable on Windows; keep one of them", a, b, c);
		// {0} is the argument, such as clis.claude.args[2]; {1} the option, such as --settings
		case 'run_settings_text': return vscode.l10n.t("{0} gives {1} text that is not a JSON object", a, b);
		case 'run_settings_missing': return vscode.l10n.t("{0} is {1} with no value after it", a, b);
		// {0} is the argument; {1} the option, such as --settings; {2} the file it names, quoted
		case 'run_settings_file': return vscode.l10n.t("{0} gives {1} {2}, which cannot be read as a JSON object", a, b, c);
		// {0} is the field, such as clis.muse.effort; {1} the CLI, such as Muse Code
		case 'choice_through_cmd': return vscode.l10n.t("{0} cannot be passed to {1} where it runs through cmd.exe; leave it out here", a, b);
		// {0} is the variable's field, such as clis["Claude · work"].env.MY_FLAG; {1} the variable; {2} the Claude Code settings that set it again
		case 'claude_env_readded': return vscode.l10n.t("{0} removes {1}, but {2} sets it again for Claude Code; remove it there, or set it in env instead", a, b, c);
		// {0} is the setting, such as clis.claude.args; {1} the type of value it holds, such as object
		case 'arguments_type': return vscode.l10n.t("{0} must be an array of strings; received {1}", a, b);
		// {0} is the setting, such as clis.claude.args; {1} the argument's place in it, from 0; {2} the type of value there, such as number
		case 'argument_type': return vscode.l10n.t("{0}[{1}] must be a string; received {2}", a, b, c);
		case 'argument_nul': return vscode.l10n.t("{0}[{1}] contains a NUL character, which is not permitted in arguments", a, b);
		// {0} is the setting, such as clis.claude.env; {1} the type of value it holds, such as array, or a variable's name, quoted
		case 'environment_type': return vscode.l10n.t("{0} must be an object of variable names to strings or null; received {1}", a, b);
		case 'environment_name': return vscode.l10n.t("{0} contains invalid environment variable name {1}", a, b);
		// {0} is the setting, such as clis.claude.env; {1} a variable's name; {2} the type of value it is given, such as number
		case 'environment_value': return vscode.l10n.t("{0}.{1} must be a string or null; received {2}", a, b, c);
		case 'environment_nul': return vscode.l10n.t("{0}.{1} contains a NUL character, which is not permitted in environment variables", a, b);
		// {0} is the CLI's name, such as Claude Code; {1} its entry, such as clis.claude
		case 'cli_disabled': return vscode.l10n.t("{0} is turned off by {1}.enabled", a, b);
		// {0} is the CLI's command, {1} the folder, {2} its entry, such as clis.claude
		case 'not_on_path': return vscode.l10n.t("{0} was not found on PATH in {1}, and {2}.command does not name its location", a, b, c);
		case 'path_not_on_path': return vscode.l10n.t("{0}.command is {1}, which was not found on PATH in {2}", a, b, c);
		case 'not_runnable': return vscode.l10n.t("{0}.command is {1}, and {2} is not an executable program", a, b, c);
		// {0} is the program, {1} the argument, {2} the CLI's entry, such as clis.claude
		case 'cmd_unsafe': return vscode.l10n.t("{0} runs via cmd.exe, which cannot safely accept argument {1}; set {2}.command to the CLI executable or Node entry point", a, b, c);
		// {0} is the program; {1} the setting, such as clis.claude.args; {2} the argument's place in it; {3} the character; {4} the CLI's entry
		case 'cmd_unsafe_setting': return vscode.l10n.t("{0} runs via cmd.exe, which cannot safely accept {1}[{2}] containing {3}; set {4}.command to the CLI executable or Node entry point", a, b, c, d, e);
		// {0} is the program, {1} the CLI's entry, such as clis.claude
		case 'cmd_unsafe_path': return vscode.l10n.t("{0} runs via cmd.exe, which cannot safely accept its path; set {1}.command to the CLI executable or Node entry point", a, b);
		// {0} is the program, {1} the folder - a network share's or a WSL distribution's, starting with \\ - {2} the CLI's entry
		case 'cmd_unc_folder': return vscode.l10n.t("{0} runs via cmd.exe, which cannot run in UNC path {1}; set {2}.command to the CLI executable or Node entry point", a, b, c);
		// {0} is the installed version of OpenCode, such as 1.19.5; the commands are npm's, to be kept as they are
		case 'opencode_1x': return vscode.l10n.t("OpenCode {0} is not supported: Facade Code needs OpenCode 2 or later. Replace npm's opencode-ai with @opencode/cli: npm uninstall -g opencode-ai, then npm install -g @opencode/cli", a);
		// {0} is the script, such as a package's cli.js
		case 'node_missing': return vscode.l10n.t("{0} is a Node script, and Node is not on PATH to run it", a);
		case 'component_outdated': return vscode.l10n.t("Facade Code requires a newer Window Component. Update \"Facade Code Window Component\" on this computer, then reload the window.");
		case 'numbers_unavailable': return vscode.l10n.t("This computer's counter could not give the agent a number. Try again.");
		case 'ownership_lost': return vscode.l10n.t("This workspace is owned by another window. Reload this window to take ownership.");
		// {0} is the file of Facade Code's installation that an update or uninstall removed, such as its dist/ptyd.js
		case 'installation_removed': return vscode.l10n.t("The Facade Code installation that runs this window's agents was removed by an update or uninstall ({0} is gone), so no agent can start. Reload the window to start agents with the installed version.", a);
		// {0} is the CLI's ID, quoted; {1} the settings file
		case 'cli_not_configured': return vscode.l10n.t("No CLI {0} is configured; add it to clis in {1}.", a, b);
		// {0} is the entry, such as clis["Codex · work"]; {1} the CLI the conversation is of, such as Codex
		case 'resume_type_changed': return vscode.l10n.t("{0} runs another CLI now, but this conversation is {1}'s; it cannot be resumed with it", a, b);
		// {0} is the entry, such as clis["Codex · work"]; {1} the CLI the pinned agent ran, such as Codex
		case 'pin_type_changed': return vscode.l10n.t("{0} runs another CLI now, but this agent ran {1}; it cannot be restored with it", a, b);
		case 'pin_unsupported': return vscode.l10n.t("Its CLI cannot resume this exact conversation, so it cannot be pinned.");
		case 'location_gone': return vscode.l10n.t("The working location is no longer available.");
		// {0} is the working location's path
		case 'location_not_here': return vscode.l10n.t("The working location {0} is not available in this window.", a);
		case 'end_unconfirmed': return vscode.l10n.t("Stop unconfirmed · check process");
		default: return otherwise;
	}
}

/**
 * `text` as a picker's row or an input box's message shows it, word for word: the editor draws `$(name)` there as a theme icon, and a
 * name, path, branch or conversation title may hold it (PANEL-3.2). A title draws it as it is, and is given it as it is.
 */
export function plainText(text: string): string {
	return text.replace(/\$\(/g, '\\$(');
}

/** How many agents, in words: the panel's badge and Filter by Working Location say it alike (PANEL-1.1, 2.3). */
export function agentCountText(count: number): string {
	return count === 1 ? vscode.l10n.t("1 agent") : vscode.l10n.t("{0} agents", count);
}

/** The command that opens the editor's Settings at Facade Code's section, as its gear and its items in New Agent say it (UX-1.3). */
export function openSettingsLabel(): string {
	return vscode.l10n.t("Open Settings");
}

/** The link that opens facade.json, as Facade Code's Settings section says it, and so the button of an error it holds (UX-1.3). */
export function editSettingsFileLabel(): string {
	return vscode.l10n.t("Edit in facade.json");
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
		return vscode.l10n.t("just now");
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
