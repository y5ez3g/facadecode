/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import type { LogPort } from '../../core/ports';
import { COMMANDS } from '../../ui/catalog';
import { reasonOf, reasonText } from '../../ui/presentation';
import { createExclusively, shownFile } from '../facadeSettings';
import { notificationText } from '../notify';

/** Open the execution host's actual settings file on demand (CONFIGURATION-7.1, UX-6.2). */
export function rustSettings(options: { readonly status: () => Promise<{ readonly settings_file: string }>; readonly log: LogPort }): {
	readonly open: () => Promise<void>;
	register(): vscode.Disposable;
} {
	const open = async (): Promise<void> => {
		const { settings_file: file } = await options.status();
		if (!isAbsolute(file)) {
			throw new Error(vscode.l10n.t("The Orchestrator did not return an absolute path to facade.json."));
		}
		const shown = shownFile(file);
		try {
			// An empty object uses the Orchestrator's defaults. A concurrent creator keeps its file.
			if (!existsSync(file) && createExclusively(file, '{}\n')) {
				options.log.event(`Created ${shown}`);
			}
		} catch (error) {
			const reason = messageOf(error);
			throw new Error(reasonText({ kind: 'settings_create', values: [shown, reason] }, reason));
		}
		try {
			await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
		} catch (error) {
			throw new Error(vscode.l10n.t("{0} could not be opened: {1}", shown, messageOf(error)));
		}
	};
	return {
		open,
		register: () => vscode.commands.registerCommand(COMMANDS.openSettingsFile, async () => {
			try {
				await open();
			} catch (error) {
				void vscode.window.showErrorMessage(notificationText(reasonOf(error)));
			}
		})
	};
}
