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

	async sendTerminal(name: string, text: string, enter: boolean): Promise<FoundTerminal | undefined> {
		const terminal = terminalNamed(name);
		if (!terminal) {
			return undefined;
		}
		terminal.sendText(text, enter);
		return { name: terminal.name };
	}

	async readTerminal(name: string, lines: number): Promise<(FoundTerminal & { readonly text?: string }) | undefined> {
		const terminal = terminalNamed(name);
		if (!terminal) {
			return undefined;
		}
		// Some terminals never tell their process id: one that has not within a moment has shown nothing.
		const processId = await processIdOf(terminal, PID_WAIT_MS);
		const text = processId === undefined ? undefined : await vscode.commands.executeCommand<string | undefined>('_facade.terminal.read', processId, lines);
		return { name: terminal.name, text };
	}

	async runCommand(id: string, args: readonly unknown[]): Promise<unknown> {
		return vscode.commands.executeCommand(id, ...args);
	}
}

/** A terminal by the name it was opened with, or by the start of its name. */
function terminalNamed(name: string): vscode.Terminal | undefined {
	const terminals = vscode.window.terminals;
	return terminals.find(terminal => terminal.name === name || terminal.creationOptions.name === name) ?? terminals.find(terminal => terminal.name.startsWith(name));
}
