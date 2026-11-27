/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import type { LogPort } from '../../core/ports';
import { COMMANDS } from '../../ui/catalog';
import { reasonOf, reasonText } from '../../ui/presentation';
import { notificationText } from '../notify';

/** `file` as the person reads it: from their home folder as `~` where it is there. */
export function shownFile(file: string, home: string = os.homedir()): string {
	const relative = path.relative(home, file);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `~${path.sep}${relative}` : file;
}

/**
 * Creates `file` holding `text`, readable and writable by its user alone, in one step: a whole file or none, never over one that is
 * there (CONFIGURATION-1.3). False where another window or the person made it first, which then stays as it is. The file is written
 * beside it first and then linked into place, which is atomic and never replaces a file; a file system without hard links is said
 * as a failure, never given a file another window could read half written.
 */
export function createExclusively(file: string, text: string): boolean {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
		try {
			fs.linkSync(temporary, file);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
				return false;
			}
			throw err;
		}
	} finally {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// Never made, or gone already
		}
	}
}

/** Open VS Code's Facade Code Framework section or the configured setting itself (CONFIGURATION-1.2). */
export function openFacadeSettings(query: string): Thenable<unknown> {
	return vscode.env.remoteName !== undefined
		? vscode.commands.executeCommand('workbench.action.openRemoteSettings', { query })
		: vscode.commands.executeCommand('workbench.action.openSettings2', { query });
}

export async function openSettingsOf(extensionId: string): Promise<void> {
	if (vscode.env.remoteName !== undefined && vscode.workspace.getConfiguration('workbench.settings').get('editor') === 'json') {
		await vscode.commands.executeCommand(COMMANDS.openSettingsFile);
		return;
	}
	await openFacadeSettings(`@ext:${extensionId}`);
}

/** Open the execution host's actual settings file on demand (CONFIGURATION-7.1, UX-6.2). */
export function frameworkSettings(options: { readonly status: () => Promise<{ readonly settings_file: string }>; readonly log: LogPort }): {
	readonly open: () => Promise<void>;
	register(): vscode.Disposable;
} {
	const open = async (): Promise<void> => {
		const { settings_file: file } = await options.status();
		if (!path.isAbsolute(file)) {
			throw new Error(vscode.l10n.t("Facade Code Framework did not return an absolute path to facade.json."));
		}
		const shown = shownFile(file);
		try {
			// An empty object uses Facade Code Framework's defaults. A concurrent creator keeps its file.
			if (!fs.existsSync(file) && createExclusively(file, '{}\n')) {
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
