/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { InstalledCli } from '../clis';
import { SpawnRequest } from '../core/facade';

/**
 * Facade: Start Agent: the person picks the CLI, a model and a first message for the worktree on
 * screen, and the core starts it. A script gives any of them as the command's argument, `{ cli,
 * model, prompt, folder }`, and is asked only for the rest; `prompt: ''` starts the agent without a
 * first message.
 */
export async function askStartAgent(rawArgs: unknown, installed: readonly InstalledCli[]): Promise<SpawnRequest | undefined> {
	const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
	const title = vscode.l10n.t("Start Agent");
	if (!installed.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t("Facade starts Claude Code, which is not on this machine's PATH."));
		return undefined;
	}

	let chosen = typeof args.cli === 'string' ? installed.find(each => each.cli.id === args.cli) : installed.length === 1 ? installed[0] : undefined;
	if (typeof args.cli === 'string' && !chosen) {
		void vscode.window.showWarningMessage(vscode.l10n.t("Facade cannot start {0} here. It starts: {1}.", args.cli, installed.map(each => each.cli.id).join(', ')));
		return undefined;
	}
	if (!chosen) {
		const pick = await vscode.window.showQuickPick(installed.map(each => ({ label: each.cli.displayName, installed: each })), { title, placeHolder: vscode.l10n.t("Which agent?") });
		if (!pick) {
			return undefined;
		}
		chosen = pick.installed;
	}

	const folder = typeof args.folder === 'string' && args.folder.trim() ? path.resolve(args.folder) : await worktreeOnScreen(title);
	if (!folder) {
		return undefined;
	}

	let model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
	if (!model) {
		model = await vscode.window.showQuickPick(chosen.cli.models, { title, placeHolder: vscode.l10n.t("Which model for {0}?", chosen.cli.displayName) });
		if (!model) {
			return undefined;
		}
	}

	let prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
	if (prompt === undefined) {
		prompt = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t("Its first message. Leave it empty to start it without one."), placeHolder: vscode.l10n.t("What it should do") });
		if (prompt === undefined) {
			return undefined;
		}
	}

	return { cli: chosen.cli.id, model, prompt: prompt.trim() || undefined, folder };
}

/**
 * The folder the window is on, as the workspace bar shows it. Picked from the workspace's folders
 * when the window cannot tell, as without Facade's workbench.
 */
async function worktreeOnScreen(title: string): Promise<string | undefined> {
	let onScreen: unknown;
	try {
		onScreen = await vscode.commands.executeCommand('_facade.folder.active');
	} catch {
		// A window without Facade's workbench has no such command.
	}
	const uri = onScreen instanceof vscode.Uri ? onScreen : onScreen && typeof onScreen === 'object' && typeof (onScreen as { scheme?: unknown }).scheme === 'string' ? vscode.Uri.from(onScreen as vscode.Uri) : undefined;
	if (uri?.scheme === 'file') {
		return uri.fsPath;
	}
	const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
	if (folders.length <= 1) {
		return folders[0]?.uri.fsPath;
	}
	const pick = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title, placeHolder: vscode.l10n.t("Which folder does it work in?") });
	return pick?.folder.uri.fsPath;
}
