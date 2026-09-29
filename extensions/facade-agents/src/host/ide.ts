/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FoundTerminal, Ide } from '../core/ports';
import { processIdOf } from './terminals';

/** How long a terminal's process id is waited for: the window tells it with the first output. */
const PID_WAIT_MS = 2_000;

/**
 * The core's Ide port (WORKTREE-AGENTS.md, WA-9.5), with VS Code's API, and with the workbench's
 * `_facade.*` commands for what that API cannot do: open a terminal held under a folder's row, and
 * read what a terminal shows.
 */
export class HostIde implements Ide {

	async openFile(file: string, line: number | undefined): Promise<void> {
		const selection = line !== undefined ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
		await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false, selection });
	}

	async openTerminal(folder: string, name: string | undefined): Promise<string> {
		const opened = await vscode.commands.executeCommand<{ readonly name: string }>('_facade.terminal.create', vscode.Uri.file(folder), { name });
		return opened.name;
	}

	async findTerminal(name: string): Promise<FoundTerminal | undefined> {
		const terminals = vscode.window.terminals;
		const terminal = terminals.find(each => each.name === name || each.creationOptions.name === name) ?? terminals.find(each => each.name.startsWith(name));
		return terminal && { name: terminal.name };
	}

	async sendTerminal(name: string, text: string, enter: boolean): Promise<void> {
		terminalNamed(name)?.sendText(text, enter);
	}

	async readTerminal(name: string, lines: number): Promise<string | undefined> {
		const terminal = terminalNamed(name);
		// Some terminals never tell their process id: one that has not within a moment has shown nothing.
		const processId = terminal && await processIdOf(terminal, PID_WAIT_MS);
		return processId === undefined ? undefined : vscode.commands.executeCommand<string | undefined>('_facade.terminal.read', processId, lines);
	}

	async runCommand(id: string, args: readonly unknown[]): Promise<unknown> {
		return vscode.commands.executeCommand(id, ...args);
	}
}

/** The terminal of that whole name, as `findTerminal` answered it. */
function terminalNamed(name: string): vscode.Terminal | undefined {
	return vscode.window.terminals.find(terminal => terminal.name === name);
}
