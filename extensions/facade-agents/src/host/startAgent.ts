/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { isJsonObject } from '../base/json';
import { InstalledCli } from '../clis/cli';
import { knownClis } from '../clis/registry';
import { StartRequest } from '../core/facade';

/**
 * Facade: Start Agent: the person picks the CLI, and types a model, how hard it thinks and a first
 * message, for the worktree on screen; the core starts it. A script gives any of them as the command's
 * argument, `{ cli, model, effort, task, folder }`, and is asked only for the rest; `task: ''` starts
 * the agent without a first message.
 */
export async function askStartAgent(rawArgs: unknown, installed: readonly InstalledCli[]): Promise<StartRequest | undefined> {
	const args = isJsonObject(rawArgs) ? rawArgs : {};
	const title = vscode.l10n.t("Start Agent");
	if (!installed.length) {
		void vscode.window.showWarningMessage(vscode.l10n.t("Facade starts {0}, and none of them is on this machine's PATH, or where its path setting says.", new Intl.ListFormat(vscode.env.language, { type: 'conjunction' }).format(knownClis().map(cli => cli.displayName))));
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

	const { displayName } = chosen.cli;
	const model = await given(args.model, () => vscode.window.showInputBox({ title, prompt: vscode.l10n.t("Which model for {0}? As its --model option takes it.", displayName), validateInput: required }));
	if (!model) {
		return undefined;
	}
	const effort = await given(args.effort, () => vscode.window.showInputBox({ title, prompt: vscode.l10n.t("How hard should it think? As {0} takes it: low, medium, high and so on.", displayName), validateInput: required }));
	if (!effort) {
		return undefined;
	}

	let task = typeof args.task === 'string' ? args.task : undefined;
	if (task === undefined) {
		task = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t("Its first message. Leave it empty to start it without one."), placeHolder: vscode.l10n.t("What it should do") });
		if (task === undefined) {
			return undefined;
		}
	}

	return { cli: chosen.cli.id, model, effort, task: task.trim() || undefined, folder };
}

/** What a script gave, trimmed, where it gave text; else what the person types, trimmed; undefined where they cancelled. */
async function given(value: unknown, ask: () => Thenable<string | undefined>): Promise<string | undefined> {
	if (typeof value === 'string' && value.trim()) {
		return value.trim();
	}
	return (await ask())?.trim();
}

/** Refuses an empty answer: Facade passes no model or effort of its own. */
function required(value: string): string | undefined {
	return value.trim() ? undefined : vscode.l10n.t("Type one: Facade passes it to the CLI as it is.");
}

/**
 * The folder the window is on, as the workspace bar shows it. Picked from the workspace's folders
 * when the window cannot tell, as without Facade's workbench.
 */
async function worktreeOnScreen(title: string): Promise<string | undefined> {
	// Only Facade's workbench has the command; its answer crosses to the extension host as a URI.
	const onScreen = (await vscode.commands.getCommands()).includes('_facade.folder.active') ? await vscode.commands.executeCommand<unknown>('_facade.folder.active') : undefined;
	if (onScreen instanceof vscode.Uri && onScreen.scheme === 'file') {
		return onScreen.fsPath;
	}
	const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
	if (folders.length <= 1) {
		return folders[0]?.uri.fsPath;
	}
	const pick = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title, placeHolder: vscode.l10n.t("Which folder does it work in?") });
	return pick?.folder.uri.fsPath;
}
