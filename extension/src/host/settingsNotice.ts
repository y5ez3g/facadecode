/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The legacy implementation's settings file as the editor makes it from earlier Facade settings, and what the person is told
// about it in their language (UX-2.4, CONFIGURATION-6.2, 6.3): once, by the window that made it; and why Open facade.json cannot open
// it where it cannot be made.

import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import type { CliProblem } from '../clis/config';
import type { MigrationNote } from '../clis/migration';
import { reasonText } from '../ui/presentation';
import { FacadeSettings } from './facadeSettings';

/**
 * The legacy implementation's settings file for this window (CONFIGURATION-1.1, 1.3): made where it does not exist from the
 * editor's old Facade settings, said once by the window that made it, with Open to show it (CONFIGURATION-6.3).
 */
export function editorFacadeSettings(log: (line: string) => void): FacadeSettings {
	const settings: FacadeSettings = new FacadeSettings({
		legacy: name => {
			const previous = vscode.workspace.getConfiguration().inspect(name);
			if (vscode.env.remoteName === undefined) {
				return previous?.globalValue;
			}
			// VS Code merges local and remote values for unregistered keys. Use the remote machine's value for migration.
			return (previous as { readonly globalRemoteValue?: unknown } | undefined)?.globalRemoteValue;
		},
		log,
		migrated: (file, notes) => {
			const open = vscode.l10n.t("Open");
			void Promise.resolve(vscode.window.showInformationMessage(migratedText(settings.shown, notes), open)).then(choice => {
				if (choice === open) {
					return vscode.window.showTextDocument(vscode.Uri.file(file));
				}
				return undefined;
			}).catch(err => log(`Could not open ${settings.shown}: ${messageOf(err)}`));
		}
	});
	return settings;
}

/** The one notice of a migration (CONFIGURATION-6.3): where the settings went, and what changed on the way. */
export function migratedText(file: string, notes: readonly MigrationNote[]): string {
	const lines = [
		// {0} is the settings file, such as ~/.facade/facade.json
		vscode.l10n.t("Facade's settings moved to {0}. Your earlier settings are in it; the editor's Facade settings are no longer read.", file)
	];
	const moved = notes.filter(note => note.kind === 'choice_moved').map(note => note.to!);
	if (moved.length) {
		// {0} is the fields, such as clis.codex.model, clis.claude.effort
		lines.push(vscode.l10n.t("A model or effort set in a CLI's arguments moved into its own field: {0}.", moved.join(', ')));
	}
	if (notes.some(note => note.kind === 'tools_always')) {
		lines.push(vscode.l10n.t("Facade's tools are now always given to agents; the setting that turned them off is gone."));
	}
	const fixes = notes.filter(note => note.kind === 'needs_fix').map(note => note.from!);
	if (fixes.length) {
		// {0} is where, such as clis.codex, clis["My CLI"]
		lines.push(vscode.l10n.t("Fix these in the file before they can start: {0}. New Agent says what is wrong with each.", fixes.join(', ')));
	}
	const whole = notes.find(note => note.kind === 'file_needs_fix');
	if (whole) {
		// {0} is the settings file, such as ~/.facade/facade.json: something in it as a whole is wrong, which stops every start
		lines.push(vscode.l10n.t("{0} has errors; no agent can start until they are fixed.", whole.from!));
	}
	return lines.join(' ');
}

/** Why the settings file cannot be opened: the editor's earlier settings cannot all have a place in it, each said (CONFIGURATION-6.2). */
export function notMadeText(file: string, problems: readonly CliProblem[]): string {
	// {0} is the settings file; {1} why, one reason after another
	return vscode.l10n.t("{0} could not be made from the editor's Facade settings: {1}", file, problems.map(each => reasonText(each.said, each.text)).join('; '));
}
