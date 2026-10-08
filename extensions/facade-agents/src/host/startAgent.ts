/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isJsonObject } from '../base/json';

/** An agent the person can start, as Start Agent offers it. */
export interface OfferedAgent {
	/** A built-in's id, or a custom agent's name. */
	readonly id: string;
	readonly label: string;
	readonly custom: boolean;
}

/**
 * Agents: Start Agent... asks only which agent (AGENT-LAUNCHER.md, L3): the agent menu, and a script, give
 * it as `{ cli, custom? }` - `custom` for the person's custom agent of that name. Answers with its id, and
 * whether it is a custom agent; undefined where the person chose none.
 */
export async function pickAgent(rawArgs: unknown, offered: readonly OfferedAgent[]): Promise<{ readonly id: string; readonly custom: boolean } | undefined> {
	const args = isJsonObject(rawArgs) ? rawArgs : {};
	if (typeof args.cli === 'string' && args.cli.trim()) {
		return { id: args.cli.trim(), custom: args.custom === true };
	}
	if (!offered.length) {
		const configure = vscode.l10n.t("Configure Agents");
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t("No agent is available: Facade found none of its built-in CLIs on this machine, and you have no custom agent."), configure);
		if (choice === configure) {
			await vscode.commands.executeCommand('facade.agent.configure');
		}
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(offered.map(each => ({ label: each.label, description: each.custom ? vscode.l10n.t("custom") : undefined, agent: each })), { title: vscode.l10n.t("Start Agent"), placeHolder: vscode.l10n.t("Which agent?") });
	return pick && { id: pick.agent.id, custom: pick.agent.custom };
}

/** The folder on the person's screen, as Facade's workbench says it; none where it says none, or is not Facade's. */
export async function folderOnScreen(): Promise<string | undefined> {
	// Only Facade's workbench has the command; its answer crosses to the extension host as a URI.
	const onScreen = (await vscode.commands.getCommands()).includes('_facade.folder.active') ? await vscode.commands.executeCommand<unknown>('_facade.folder.active') : undefined;
	return onScreen instanceof vscode.Uri && onScreen.scheme === 'file' ? onScreen.fsPath : undefined;
}
