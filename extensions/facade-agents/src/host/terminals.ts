/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { Environment } from '../clis/cli';
import { Disposable, TerminalEnd, TerminalLaunch, Terminals } from '../core/ports';

/** How long Facade's workbench is waited for at most to have its terminals back: its pty host may not answer. */
const RESTORE_TIMEOUT_MS = 60_000;
/** How long, once the window has its terminals back, a process it cannot tell of yet is asked after: its id comes a moment after its terminal. */
const UNKNOWN_WAIT_MS = 10_000;
const UNKNOWN_POLL_MS = 250;
/** How often the watched agents' processes are looked at, for one that ended while its terminal stays open to show how. */
const ENDS_POLL_MS = 5_000;

/** What the window knows of an agent's process, as `_facade.terminal.processes` answers. */
type RunProcess =
	| { readonly id: number; readonly state: 'present' | 'unknown' }
	| { readonly id: number; readonly state: 'gone'; readonly end?: TerminalEnd };

/** Whether `candidate` is a `RunProcess`: the workbench's answer, each field checked. */
function isRunProcess(candidate: unknown): candidate is RunProcess {
	if (!isJsonObject(candidate) || typeof candidate.id !== 'number') {
		return false;
	}
	const { state, end } = candidate;
	return state === 'present' || state === 'unknown' || (state === 'gone' && (end === undefined || (isJsonObject(end) && typeof end.byThePerson === 'boolean' && (end.exitCode === undefined || typeof end.exitCode === 'number'))));
}

/**
 * The core's Terminals port. Agents run in Facade's own terminals, each in its own UI: the person
 * watches any of them and types into it. Each starts the agent's executable directly with an argument
 * array, never a command typed into a shell. The workbench holds it under its folder's row and registers
 * it under the agent's run - the record's id and the agent's number - by the process it started: the
 * agent's terminal is found by its run, whatever its title, through reloads and moves within the window.
 * Without Facade's workbench there are no agents' terminals.
 */
export class HostTerminals implements Terminals, vscode.Disposable {

	private readonly listeners = new Set<(id: number, end: TerminalEnd) => void>();
	/** The agents whose processes' ends are looked for: those launched here, and those found running coming back. */
	private readonly watched = new Set<number>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly poll: ReturnType<typeof setInterval>;
	/** Settles once the window has the terminals it had back, or a minute on. */
	private readonly restored = terminalsRestored();
	/** Set while the ends are looked for; looked for again once that is done, where asked meanwhile. */
	private looking: 'once' | 'again' | undefined;

	/** `workspace` is the id of the record the agents are in. */
	constructor(private readonly workspace: string, private readonly log: (message: string) => void) {
		// A terminal that closes may have been an agent's: its process ended with it.
		this.disposables.push(vscode.window.onDidCloseTerminal(() => this.lookForEnds()));
		// A process can end while its terminal stays open to show how.
		this.poll = setInterval(() => this.lookForEnds(), ENDS_POLL_MS);
	}

	async launch(request: TerminalLaunch): Promise<void> {
		if (!(await vscode.commands.getCommands()).includes('_facade.terminal.create')) {
			throw new Error('This window has no agents\' terminals: Facade Code\'s workbench makes them.');
		}
		const opened = await vscode.commands.executeCommand<{ readonly closed: boolean; readonly exitCode?: number }>('_facade.terminal.create', vscode.Uri.file(request.cwd), {
			name: request.name,
			executable: request.executable,
			args: request.args,
			env: request.env,
			cwd: request.cwd,
			agent: request.command,
			reveal: request.reveal,
			run: this.runOf(request.id)
		});
		// Closed already: its process could not start.
		if (opened.closed) {
			throw new Error(exitedAsItStarted(request.executable, opened.exitCode));
		}
		this.watched.add(request.id);
	}

	onDidEnd(listener: (id: number, end: TerminalEnd) => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async isAlive(id: number): Promise<boolean> {
		await this.restored;
		const deadline = Date.now() + UNKNOWN_WAIT_MS;
		let known = await this.processOf(id);
		while (known.state === 'unknown' && Date.now() < deadline) {
			await timeout(UNKNOWN_POLL_MS);
			known = await this.processOf(id);
		}
		if (known.state === 'unknown') {
			throw new Error('the window cannot tell whether its process runs');
		}
		if (known.state === 'present') {
			this.watched.add(id);
		}
		return known.state === 'present';
	}

	async stop(id: number): Promise<void> {
		if (!await vscode.commands.executeCommand<boolean>('_facade.terminal.stop', this.runOf(id))) {
			throw new Error('its process has not ended yet');
		}
	}

	async type(id: number, text: string): Promise<boolean> {
		return vscode.commands.executeCommand<boolean>('_facade.terminal.type', this.runOf(id), text);
	}

	/** Puts the agent's terminal in front through its folder's row, which the window goes to. False when its process runs in none, or it could not be put in front. */
	async reveal(id: number): Promise<boolean> {
		return vscode.commands.executeCommand<boolean>('_facade.terminal.reveal', this.runOf(id));
	}

	dispose(): void {
		clearInterval(this.poll);
		this.listeners.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/** The run of the agent numbered `id`: its terminal's, as the workbench knows it. */
	private runOf(id: number): { readonly workspace: string; readonly id: number } {
		return { workspace: this.workspace, id };
	}

	/** What the window knows of the agent's process: unknown, where it does not say. */
	private async processOf(id: number): Promise<RunProcess> {
		return (await processesOf(this.workspace, [id])).find(each => each.id === id) ?? { id, state: 'unknown' };
	}

	/** Reports each watched agent whose process the window says is gone, once: how it ended, where the window saw it end. */
	private lookForEnds(): void {
		if (this.looking) {
			this.looking = 'again';
			return;
		}
		if (!this.watched.size) {
			return;
		}
		this.looking = 'once';
		processesOf(this.workspace, [...this.watched]).then(processes => {
			for (const known of processes) {
				if (known.state === 'gone' && this.watched.delete(known.id)) {
					for (const listener of [...this.listeners]) {
						listener(known.id, known.end ?? { byThePerson: false });
					}
				}
			}
		}).catch(err => this.log(`Looking for agents whose processes ended failed: ${messageOf(err)}`)).finally(() => {
			const again = this.looking === 'again';
			this.looking = undefined;
			if (again) {
				this.lookForEnds();
			}
		});
	}
}

/** What the window knows of the processes of the runs of the record `workspace`: those numbered `ids`, or every one it holds. */
async function processesOf(workspace: string, ids?: readonly number[]): Promise<readonly RunProcess[]> {
	const answer = await vscode.commands.executeCommand<unknown>('_facade.terminal.processes', workspace, ids);
	return Array.isArray(answer) ? answer.filter(isRunProcess) : [];
}

/**
 * Whether a process of an agent of the record `workspace` may still run in a terminal of the window: one
 * that is there, or that the window cannot tell of yet. Asked once the window has its terminals back.
 */
export async function agentProcessesRun(workspace: string): Promise<boolean> {
	await terminalsRestored();
	return (await processesOf(workspace)).some(each => each.state !== 'gone');
}

/**
 * The environment a terminal in `folder` starts with, as the window makes it: the window's, with the
 * setting `terminal.integrated.env.<platform>` over it and what extensions add. Where a CLI keeps its
 * files - its trust among them - depends on it.
 */
export async function terminalEnvironment(folder: string): Promise<Environment> {
	const env = await vscode.commands.executeCommand<unknown>('_facade.terminal.environment', vscode.Uri.file(folder));
	if (!isJsonObject(env)) {
		throw new Error('The window did not say what environment its terminals get.');
	}
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Why a launch failed whose terminal closed as it started; in English, as Facade's own errors say it to the parent. */
function exitedAsItStarted(executable: string, exitCode: number | undefined): string {
	return exitCode === undefined ? `${executable} exited as it started.` : `${executable} exited as it started (exit code ${exitCode}).`;
}

/**
 * Settles once the window has the terminals it had back - reconnected to their processes, the editor
 * area's and floating windows' restored - as Facade's workbench says, for a minute at most.
 */
async function terminalsRestored(): Promise<void> {
	await Promise.race([Promise.resolve(vscode.commands.executeCommand('_facade.terminal.whenRestored')).catch(() => undefined), timeout(RESTORE_TIMEOUT_MS)]);
}
