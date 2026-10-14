/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isJsonObject } from '../base/json';
import { Environment } from '../clis/cli';
import { agentIconId } from './agentIcons';
import { terminalEnvironment } from './terminals';

/** An agent the person can start, as Start Agent offers it. */
export interface OfferedAgent {
	/** A built-in's id, or a custom agent's name. */
	readonly id: string;
	readonly label: string;
	readonly custom: boolean;
}

/**
 * Agents: Start Agent... asks only which agent (AGENT-LAUNCHER.md, L3): the agent menu, and a script, give
 * it as `{ cli, custom?, folder? }` - `custom` for the person's custom agent of that name, `folder` the one on
 * screen as the person chose it, which the menu sends with the choice (PS-15). Answers with its id, whether it
 * is a custom agent and that folder; undefined where the person chose none. Asked which, it lists `offered`, the
 * agents there are as they are found now, each with its icon as the agent menu has it; with none, it says why - no
 * built-in on this machine, or only those the person turned off, `turnedOff`, by their names.
 */
export async function pickAgent(rawArgs: unknown, offered: () => Promise<readonly OfferedAgent[]>, turnedOff: () => Promise<readonly string[]>): Promise<{ readonly id: string; readonly custom: boolean; readonly folder?: string } | undefined> {
	const args = isJsonObject(rawArgs) ? rawArgs : {};
	if (typeof args.cli === 'string' && args.cli.trim()) {
		const folder = args.folder instanceof vscode.Uri && args.folder.scheme === 'file' ? args.folder.fsPath : undefined;
		return { id: args.cli.trim(), custom: args.custom === true, ...(folder !== undefined ? { folder } : {}) };
	}
	const agents = await offered();
	if (!agents.length) {
		const configure = vscode.l10n.t("Configure Agents");
		const off = await turnedOff();
		const choice = await vscode.window.showInformationMessage(off.length
			? vscode.l10n.t("No agents are available: the built-in agent CLIs found on this machine are disabled in your settings ({0}), and no custom agents are configured.", off.join(', '))
			: vscode.l10n.t("No agents are available: none of the built-in agent CLIs were found on this machine, and no custom agents are configured."), configure);
		if (choice === configure) {
			await vscode.commands.executeCommand('facade.agent.configure');
		}
		return undefined;
	}
	// Each with the icon the agent menu shows it with: a built-in's logo, the robot for a custom agent
	const pick = await vscode.window.showQuickPick(agents.map(each => ({ label: each.label, iconPath: new vscode.ThemeIcon(agentIconId(each.id, each.custom)), description: each.custom ? vscode.l10n.t("custom") : undefined, agent: each })), { title: vscode.l10n.t("Start Agent"), placeHolder: vscode.l10n.t("Select an agent to start") });
	return pick && { id: pick.agent.id, custom: pick.agent.custom };
}

/** The folder on the person's screen, as Facade's workbench says it; none where it says none, or is not Facade's. */
export async function folderOnScreen(): Promise<string | undefined> {
	// Only Facade's workbench has the command; its answer crosses to the extension host as a URI.
	const onScreen = (await vscode.commands.getCommands()).includes('_facade.folder.active') ? await vscode.commands.executeCommand<unknown>('_facade.folder.active') : undefined;
	return onScreen instanceof vscode.Uri && onScreen.scheme === 'file' ? onScreen.fsPath : undefined;
}

/**
 * Where the CLIs are looked for, as a terminal finds them (X-39): the folder on screen - else the window's first on this
 * machine - and the environment a terminal there starts with; with no folder, this process's own.
 */
export async function terminalPlace(): Promise<{ readonly folder?: string; readonly env: Environment }> {
	const folder = await folderOnScreen() ?? vscode.workspace.workspaceFolders?.find(each => each.uri.scheme === 'file')?.uri.fsPath;
	return folder === undefined ? { env: process.env } : { folder, env: await terminalEnvironment(folder) };
}
