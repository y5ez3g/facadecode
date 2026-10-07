/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import { isEqualPath } from '../base/files';
import { isJsonObject } from '../base/json';
import { InstalledCli } from '../clis/cli';
import { knownClis } from '../clis/registry';
import { StartRequest, WindowFolder } from '../core/facade';
import { agentName, nameOfWorktree } from '../record/agents';

/**
 * Facade: Start Agent: the person picks the CLI and the folder - the one on screen offered first - and
 * types the name, the model, how hard it thinks and, if they like, its task; the core starts it. The
 * agent button runs it with its CLI chosen. A script gives any of them as the command's argument,
 * `{ cli, name, model, effort, task, folder }`, and is asked only for the rest; `task: ''` starts the
 * agent without one.
 *
 * @param folders The window's folders an agent can start in.
 */
export async function askStartAgent(rawArgs: unknown, installed: readonly InstalledCli[], folders: readonly WindowFolder[]): Promise<StartRequest | undefined> {
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
	const { displayName } = chosen.cli;

	const place = typeof args.folder === 'string' && args.folder.trim() ? { folder: path.resolve(args.folder), worktree: path.basename(args.folder) } : await pickPlace(title, folders);
	if (!place) {
		return undefined;
	}

	const name = await given(args.name, () => vscode.window.showInputBox({
		title,
		prompt: vscode.l10n.t("Its name: a label, which other agents may have too."),
		value: nameOfWorktree(place.worktree),
		validateInput: whyNotAName
	}));
	if (!name) {
		return undefined;
	}
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
		task = await vscode.window.showInputBox({ title, prompt: vscode.l10n.t("Its task. Leave it empty to start it without one, at its own prompt."), placeHolder: vscode.l10n.t("What it should do") });
		if (task === undefined) {
			return undefined;
		}
	}

	return { cli: chosen.cli.id, name, model, effort, task: task.trim() || undefined, folder: place.folder };
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

/** Why `value` is not an agent's name, as Facade says it; nothing where it is one. */
function whyNotAName(value: string): string | undefined {
	try {
		agentName(value);
		return undefined;
	} catch (err) {
		return messageOf(err);
	}
}

/**
 * The folder the agent works in, picked among the window's: the one on screen first, as the workspace
 * bar shows it. Not asked where the window has one.
 */
async function pickPlace(title: string, folders: readonly WindowFolder[]): Promise<WindowFolder | undefined> {
	// Only Facade's workbench has the command; its answer crosses to the extension host as a URI.
	const onScreen = (await vscode.commands.getCommands()).includes('_facade.folder.active') ? await vscode.commands.executeCommand<unknown>('_facade.folder.active') : undefined;
	const first = onScreen instanceof vscode.Uri && onScreen.scheme === 'file' ? folders.find(each => isEqualPath(each.folder, onScreen.fsPath)) : undefined;
	const ordered = first ? [first, ...folders.filter(each => each !== first)] : folders;
	if (ordered.length <= 1) {
		return ordered[0];
	}
	const pick = await vscode.window.showQuickPick(ordered.map(each => ({
		label: each.worktree,
		description: each === first ? vscode.l10n.t("{0} - on screen", each.folder) : each.folder,
		place: each
	})), { title, placeHolder: vscode.l10n.t("Which folder does it work in?") });
	return pick?.place;
}
