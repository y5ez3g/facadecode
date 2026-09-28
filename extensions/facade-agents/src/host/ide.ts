/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from '../common/git';
import { KernelError } from '../common/kernel/kernel';
import { Caller } from '../common/kernel/model';
import { IdeHost } from '../common/kernel/tools';

/*
 * The `ide` tool (L2-PLAN, step 31): what the person can do in the IDE, for every participant.
 * Facade's own parts - the workspace bar's rows, worktrees, folder terminals - go through the
 * workbench's dialog-free `_facade.*` commands; everything else is VS Code's own API and commands.
 */

interface WorktreeCreated {
	readonly path: string;
	readonly branch: string;
}

/** A terminal as `_facade.terminal.list` gives it. */
interface ListedTerminal {
	readonly name: string;
	readonly processId?: number;
	readonly folder?: string;
	readonly where: 'tab' | 'panel' | 'background';
}

/** Where a terminal is, in words. */
function whereIs(terminal: ListedTerminal): string {
	switch (terminal.where) {
		case 'tab': return terminal.folder ? `a tab in ${terminal.folder}` : 'a tab';
		case 'panel': return 'in the panel';
		default: return terminal.folder ? `held under the row of ${terminal.folder}, shown when the window goes there` : 'in the background';
	}
}

export class WindowIde implements IdeHost {

	constructor(private readonly git: Git) { }

	readonly actions = [
		{ name: 'open_file', description: 'open a file in the editor: path, line?' },
		{ name: 'open_diff', description: 'open a diff: left, right, title?' },
		{ name: 'show_folder', description: 'bring a folder into the workspace and go to it: path' },
		{ name: 'remove_folder', description: 'take a folder out of the workspace, leaving it on disk: path' },
		{ name: 'create_worktree', description: 'a new worktree on a new branch, with its row: repo, branch, base?' },
		{ name: 'delete_worktree', description: 'delete a worktree and its row; changes not committed are thrown away only with force: path, force?' },
		{ name: 'open_terminal', description: 'a terminal in a folder, under its row: path, name?' },
		{ name: 'send_terminal', description: 'type into a terminal: name, text, enter? (default true)' },
		{ name: 'read_terminal', description: 'the last lines of a terminal: name, lines? (default 50)' },
		{ name: 'list_terminals', description: 'the open terminals, and where each is' },
		{ name: 'set_row', description: 'a workspace bar row\'s name and colour: path, name?, color?' },
		{ name: 'command', description: 'run any VS Code command: id, args? (a list)' }
	] as const;

	async run(_caller: Caller, action: string, args: Record<string, unknown>): Promise<{ readonly text: string; readonly data?: object }> {
		switch (action) {
			case 'open_file': {
				const file = this.path(args.path, 'path');
				const line = typeof args.line === 'number' && args.line > 0 ? Math.floor(args.line) - 1 : undefined;
				await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false, selection: line !== undefined ? new vscode.Range(line, 0, line, 0) : undefined });
				return { text: `Opened ${file}${line !== undefined ? ` at line ${line + 1}` : ''}.` };
			}
			case 'open_diff': {
				const left = this.path(args.left, 'left');
				const right = this.path(args.right, 'right');
				const title = typeof args.title === 'string' ? args.title : `${path.basename(left)} ↔ ${path.basename(right)}`;
				await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(left), vscode.Uri.file(right), title);
				return { text: `Opened the diff ${title}.` };
			}
			case 'show_folder': {
				const folder = this.path(args.path, 'path');
				await vscode.commands.executeCommand('_facade.folder.show', vscode.Uri.file(folder));
				return { text: `The window is on ${folder}.` };
			}
			case 'remove_folder': {
				const folder = this.path(args.path, 'path');
				await vscode.commands.executeCommand('_facade.folder.remove', vscode.Uri.file(folder));
				return { text: `${folder} is no longer in the workspace. It is still on disk.` };
			}
			case 'create_worktree': {
				const repo = this.path(args.repo, 'repo');
				const branch = this.text(args.branch, 'branch');
				// The workbench takes a commit id: a branch or tag is read here, where git is.
				const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
				const startPoint = base ? await this.git.resolveCommit(repo, base) : undefined;
				if (base && !startPoint) {
					throw new KernelError('INVALID', `${base} is not a commit in ${repo}.`);
				}
				const created = await vscode.commands.executeCommand<WorktreeCreated>('_facade.worktree.create', vscode.Uri.file(repo), branch, startPoint);
				return { text: `Made the worktree ${created.path} on the new branch ${created.branch}.`, data: created };
			}
			case 'delete_worktree': {
				const folder = this.path(args.path, 'path');
				await vscode.commands.executeCommand('_facade.worktree.delete', vscode.Uri.file(folder), args.force === true);
				return { text: `Deleted the worktree ${folder}.` };
			}
			case 'open_terminal': {
				const folder = this.path(args.path, 'path');
				const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
				const opened = await vscode.commands.executeCommand<{ readonly name: string }>('_facade.terminal.create', vscode.Uri.file(folder), { name });
				return { text: `Opened the terminal ${opened.name} in ${folder}.`, data: opened };
			}
			case 'send_terminal': {
				const terminal = this.terminal(args.name);
				const text = typeof args.text === 'string' ? args.text : '';
				terminal.sendText(text, args.enter !== false);
				return { text: `Typed into ${terminal.name}.` };
			}
			case 'read_terminal': {
				const terminal = this.terminal(args.name);
				const lines = typeof args.lines === 'number' && args.lines > 0 ? Math.min(2000, Math.floor(args.lines)) : 50;
				// The window tells a terminal's process id with its first output, and of some never
				const processId = await Promise.race([Promise.resolve(terminal.processId), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2_000))]);
				if (processId === undefined) {
					return { text: `${terminal.name} has shown nothing yet.` };
				}
				const text = await vscode.commands.executeCommand<string>('_facade.terminal.read', processId, lines);
				return { text: `The last ${lines} lines of ${terminal.name}:\n${text ?? ''}` };
			}
			case 'list_terminals': {
				const listed = await vscode.commands.executeCommand<ListedTerminal[]>('_facade.terminal.list').then(undefined, () => undefined);
				if (!listed) {
					const names = vscode.window.terminals.map(terminal => terminal.name);
					return { text: names.length ? names.join('\n') : 'No terminals are open.', data: { terminals: names } };
				}
				const lines = listed.map(terminal => `${terminal.name} · ${whereIs(terminal)}`);
				return { text: lines.length ? lines.join('\n') : 'No terminals are open.', data: { terminals: listed } };
			}
			case 'set_row': {
				const folder = this.path(args.path, 'path');
				const name = typeof args.name === 'string' ? args.name : undefined;
				const color = typeof args.color === 'string' ? args.color : undefined;
				await vscode.commands.executeCommand('_facade.row.set', vscode.Uri.file(folder), { name, color });
				return { text: `Set the row of ${folder}.` };
			}
			case 'command': {
				const id = this.text(args.id, 'id');
				const commandArgs = Array.isArray(args.args) ? args.args : args.args === undefined ? [] : [args.args];
				const result = await vscode.commands.executeCommand(id, ...commandArgs);
				let shown: string;
				try {
					shown = result === undefined ? 'nothing' : JSON.stringify(result);
				} catch {
					shown = String(result);
				}
				return { text: `Ran ${id}; it returned ${shown.length > 2000 ? `${shown.slice(0, 2000)}…` : shown}.` };
			}
		}
		throw new KernelError('INVALID', `Unknown action ${action}. The actions: ${this.actions.map(each => each.name).join(', ')}.`);
	}

	private path(value: unknown, name: string): string {
		const text = this.text(value, name);
		if (!path.isAbsolute(text)) {
			throw new KernelError('INVALID', `${name} must be an absolute path.`);
		}
		return path.normalize(text);
	}

	private text(value: unknown, name: string): string {
		if (typeof value !== 'string' || !value.trim()) {
			throw new KernelError('INVALID', `${name} is required.`);
		}
		return value.trim();
	}

	private terminal(value: unknown): vscode.Terminal {
		const name = this.text(value, 'name');
		const terminal = vscode.window.terminals.find(each => each.name === name || each.creationOptions.name === name) ?? vscode.window.terminals.find(each => each.name.startsWith(name));
		if (!terminal) {
			throw new KernelError('NOT_FOUND', `No terminal is called ${name}. list_terminals shows them.`);
		}
		return terminal;
	}
}
