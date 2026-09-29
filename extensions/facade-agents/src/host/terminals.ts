/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable, TerminalLaunch, Terminals } from '../core/ports';
import { StateStore } from '../record/windowState';

const PIDS_KEY = 'facade.agents.terminalPids';
const LAUNCH_TIMEOUT_MS = 15_000;
/** How long one terminal's process id is waited for. */
const PID_WAIT_MS = 1_000;
/** How long after the extension host started an agent's terminal is looked for before it counts as gone. */
const SETTLE_MS = 5_000;

/**
 * The core's Terminals port. Agents run in Facade's own terminals, each in its own UI: the person
 * watches any of them and types into it. Each starts the agent's executable directly with an argument
 * array, never a command typed into a shell (WA-4.1), and the workbench holds it under its worktree's
 * row (WA-9.1). The robot icon makes it an agent terminal by L1's rule: counted in the agent badge,
 * kept across a window reload, gone after an app restart.
 *
 * A reload can give a terminal back without its name, so each agent's terminal is also known by its
 * process id, which the pty host keeps. The window tells the extension host each terminal's process
 * id on its own, and of some terminals never, so a `processId` is only ever waited for with a bound,
 * and never one after another.
 */
export class HostTerminals implements Terminals, vscode.Disposable {

	private readonly byName = new Map<string, vscode.Terminal>();
	private readonly reported = new Set<string>();
	private readonly listeners = new Set<(name: string, exitCode: number | undefined) => void>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly poll: ReturnType<typeof setInterval>;
	private readonly startedAt = Date.now();

	constructor(private readonly state: StateStore, private readonly log?: (message: string) => void) {
		this.disposables.push(vscode.window.onDidCloseTerminal(terminal => void this.closed(terminal)));
		// A process can end while its terminal stays open to show the exit code.
		this.poll = setInterval(() => this.checkExits(), 5_000);
		const prune = setTimeout(() => void this.forgetGone(), SETTLE_MS);
		this.disposables.push({ dispose: () => clearTimeout(prune) });
	}

	async launch(request: TerminalLaunch): Promise<void> {
		const opened = await this.openUnderItsRow(request);
		const terminal = opened?.terminal ?? vscode.window.createTerminal({
			name: request.name,
			shellPath: request.executable,
			shellArgs: [...request.args],
			cwd: request.cwd,
			env: request.env,
			iconPath: new vscode.ThemeIcon('robot'),
			location: vscode.TerminalLocation.Panel
		});
		this.byName.set(request.name, terminal);
		const pid = opened?.processId ?? await processIdOf(terminal, LAUNCH_TIMEOUT_MS);
		if (pid === undefined) {
			const exit = terminal.exitStatus;
			if (!opened || exit) {
				terminal.dispose();
				this.byName.delete(request.name);
				throw new Error(exit ? vscode.l10n.t("{0} exited as it started (exit code {1}).", request.executable, String(exit.code)) : vscode.l10n.t("{0} did not start within {1} seconds.", request.executable, String(LAUNCH_TIMEOUT_MS / 1000)));
			}
			// Running under its row and showing nothing yet: the window tells its id with its first output.
			this.log?.(`${request.name} runs, but its process id is not known yet.`);
			void this.rememberWhenKnown(request.name, terminal);
		} else {
			await this.state.update(PIDS_KEY, { ...this.pids(), [request.name]: pid });
		}
	}

	private async rememberWhenKnown(name: string, terminal: vscode.Terminal): Promise<void> {
		const pid = await terminal.processId;
		if (pid !== undefined) {
			await this.state.update(PIDS_KEY, { ...this.pids(), [name]: pid });
		}
	}

	onDidEnd(listener: (name: string, exitCode: number | undefined) => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async isAlive(name: string): Promise<boolean> {
		let terminal = await this.find(name);
		// Just after the extension host started, the window can still be telling it of its terminals.
		while (!terminal && this.pids()[name] !== undefined && Date.now() < this.startedAt + SETTLE_MS) {
			await delay(250);
			terminal = await this.find(name);
		}
		return !!terminal && terminal.exitStatus === undefined;
	}

	/**
	 * The agent's terminal opened by the workbench for the folder it works in: under that folder's row,
	 * coming up when the window goes there, as a terminal somebody opened there would. Undefined when
	 * the window has no such command, for the panel to take it instead.
	 */
	private async openUnderItsRow(request: TerminalLaunch): Promise<{ readonly terminal: vscode.Terminal; readonly processId: number | undefined } | undefined> {
		let opened: { readonly processId?: number } | undefined;
		try {
			opened = await vscode.commands.executeCommand<{ readonly processId?: number }>('_facade.terminal.create', vscode.Uri.file(request.cwd), {
				name: request.name,
				executable: request.executable,
				args: request.args,
				env: request.env,
				cwd: request.cwd,
				agent: true
			});
		} catch (err) {
			this.log?.(`Facade's terminal command is not there (${(err as Error).message}); ${request.name} opens in the panel.`);
			return undefined;
		}
		// Once the workbench made it, the agent runs: never start a second one in the panel, and treat a
		// terminal that cannot be found as a failure. A process that has shown nothing yet has no id:
		// then its terminal is found by its name.
		const processId = opened?.processId;
		const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
		do {
			const terminal = await terminalOf(request.name, processId);
			if (terminal) {
				return { terminal, processId };
			}
			await delay(100);
		} while (Date.now() < deadline);
		throw new Error(vscode.l10n.t("{0} was started, but its terminal could not be found.", request.name));
	}

	dispose(): void {
		clearInterval(this.poll);
		this.listeners.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private pids(): Record<string, number> {
		return this.state.get<Record<string, number>>(PIDS_KEY, {});
	}

	/**
	 * Forgets the agents whose terminals did not come back once the extension host started: closed
	 * while none was there to see it, as an app restart closes them. Their process ids can be any
	 * other process's by now.
	 */
	private async forgetGone(): Promise<void> {
		const gone: string[] = [];
		for (const [name, pid] of Object.entries(this.pids())) {
			if (!await terminalOf(name, pid)) {
				gone.push(name);
			}
		}
		if (gone.length) {
			// Read again: a launch may have added one meanwhile.
			const pids = this.pids();
			for (const name of gone) {
				delete pids[name];
			}
			await this.state.update(PIDS_KEY, pids);
		}
	}

	private async find(name: string): Promise<vscode.Terminal | undefined> {
		const known = this.byName.get(name);
		if (known && vscode.window.terminals.includes(known)) {
			return known;
		}
		const terminal = await terminalOf(name, this.pids()[name]);
		if (terminal) {
			this.byName.set(name, terminal);
		}
		return terminal;
	}

	private async nameOf(terminal: vscode.Terminal): Promise<string | undefined> {
		for (const [name, known] of this.byName) {
			if (known === terminal) {
				return name;
			}
		}
		const pid = await processIdOf(terminal);
		return pid === undefined ? undefined : Object.entries(this.pids()).find(([, known]) => known === pid)?.[0];
	}

	private async closed(terminal: vscode.Terminal): Promise<void> {
		const name = await this.nameOf(terminal);
		if (name) {
			this.report(name, terminal.exitStatus?.code);
			this.byName.delete(name);
			const pids = this.pids();
			delete pids[name];
			await this.state.update(PIDS_KEY, pids);
		}
	}

	private checkExits(): void {
		for (const [name, terminal] of this.byName) {
			if (terminal.exitStatus !== undefined) {
				this.report(name, terminal.exitStatus.code);
			}
		}
	}

	private report(name: string, exitCode: number | undefined): void {
		if (!this.reported.has(name)) {
			this.reported.add(name);
			for (const listener of [...this.listeners]) {
				listener(name, exitCode);
			}
		}
	}
}

/**
 * The terminal an agent's incarnation called `name` runs in: by that name, which it was given, else by
 * its process id. The ids are asked of all the terminals at once, each for a moment at most.
 */
async function terminalOf(name: string, pid: number | undefined): Promise<vscode.Terminal | undefined> {
	const terminals = vscode.window.terminals;
	const named = terminals.find(terminal => terminal.name === name || terminal.creationOptions.name === name);
	if (named || pid === undefined) {
		return named;
	}
	const pids = await Promise.all(terminals.map(terminal => processIdOf(terminal)));
	const index = pids.indexOf(pid);
	return index >= 0 ? terminals[index] : undefined;
}

/** A terminal's process id, or undefined when the window has not told it within `waitMs`. */
export function processIdOf(terminal: vscode.Terminal, waitMs = PID_WAIT_MS): Promise<number | undefined> {
	return Promise.race([Promise.resolve(terminal.processId), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), waitMs))]);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
