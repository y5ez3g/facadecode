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
	const [a = '', b = '', c = ''] = said?.values ?? [];
	switch (said?.kind) {
		// {0} is the setting, such as facade.claude; {1} the value it holds
		case 'path_type': return vscode.l10n.t("{0}.path must be a string; received {1}", a, b);
		case 'path_blank': return vscode.l10n.t("{0}.path contains only whitespace. Set the program's path, or leave it empty to find the CLI on PATH", a);
		case 'path_nul': return vscode.l10n.t("{0}.path contains a NUL character, which no path can hold", a);
		// {0} is the CLI's command, {1} the folder, {2} the setting
		case 'not_on_path': return vscode.l10n.t("{0} was not found on the PATH of a terminal in {1}, and {2}.path does not name its location", a, b, c);
		case 'path_not_on_path': return vscode.l10n.t("{0}.path is {1}, which was not found on the PATH of a terminal in {2}", a, b, c);
		case 'not_runnable': return vscode.l10n.t("{0}.path is {1}, and {2} is not a program that can be run", a, b, c);
		// {0} is the program, {1} the argument, {2} the setting
		case 'cmd_unsafe': return vscode.l10n.t("{0} runs through cmd.exe, which cannot be given the argument {1} safely; set {2}.path to the CLI's own program or Node entry point", a, b, c);
		// {0} is the program, {1} the setting
		case 'cmd_unsafe_path': return vscode.l10n.t("{0} runs through cmd.exe, which cannot be given its path safely; set {1}.path to the CLI's own program or Node entry point", a, b);
		case 'yolo_type': return vscode.l10n.t("facade.yolo must be true or false; received {0}", a);
		default: return otherwise;
	}
}

/** How many agents, in words: the panel's badge and Filter by Working Location say it alike (PANEL-1.1, 2.3). */
export function agentCountText(count: number): string {
	return count === 1 ? vscode.l10n.t("1 agent") : vscode.l10n.t("{0} agents", count);
}

/** The configuration action's native-button label, without the command's menu ellipsis (UX-1.3). */
export function configureAgentsLabel(): string {
	return vscode.l10n.t("Configure Agents");
}
