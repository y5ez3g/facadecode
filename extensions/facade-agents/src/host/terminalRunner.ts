/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { FirstRunAnswer } from '../common/agents';
import { WorkerRunner } from '../common/engine';
import { StateStore } from '../common/kernel/fileState';
import { keysToAnswer } from '../common/kernel/firstRun';
import { AgentLaunchRequest } from '../common/kernel/spawner';

/*
 * Workers run in Facade's own terminals: the person can watch any of them and take over by typing.
 * Each starts the agent's executable directly with an argument array, never a command typed into a
 * shell. The robot icon makes them agent terminals by L1's rule: counted in the agent badge, kept
 * across a window reload, gone after an app restart.
 *
 * A reload can give a terminal back without its name, so each worker is also known by its process
 * id, which the pty host keeps.
 *
 * ⚠️ The window tells the extension host each terminal's process id on its own, and of some terminals
 * never: a terminal's `processId` is only ever waited for with a bound, never one after another.
 */

const PIDS_KEY = 'facade.agents.workerPids';
const LAUNCH_TIMEOUT_MS = 15_000;
const INPUT_DELAY_MS = 4_000;
/** How long one terminal's process id is waited for. */
const PID_WAIT_MS = 1_000;
/** How long after the extension host started a worker's terminal is looked for before it counts as gone. */
const SETTLE_MS = 5_000;
/** How long after an agent starts the questions its UI asks before it works are looked for. */
const FIRST_RUN_MS = 90_000;

export class TerminalRunner implements WorkerRunner, vscode.Disposable {

	private readonly byName = new Map<string, vscode.Terminal>();
	private readonly reported = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly poll: ReturnType<typeof setInterval>;
	private readonly startedAt = Date.now();

	constructor(private readonly state: StateStore, private readonly onExit: (name: string, exitCode: number | undefined) => void, private readonly log?: (message: string) => void) {
		this.disposables.push(vscode.window.onDidCloseTerminal(terminal => void this.closed(terminal)));
		// A process can end while its terminal stays open to show the exit code.
		this.poll = setInterval(() => this.checkExits(), 5_000);
		const prune = setTimeout(() => void this.forgetGone(), SETTLE_MS);
		this.disposables.push({ dispose: () => clearTimeout(prune) });
	}

	async launch(request: AgentLaunchRequest): Promise<void> {
		const started = inConsole(request.executable, request.args);
		const opened = await this.openUnderItsRow(request, started);
		const terminal = opened?.terminal ?? vscode.window.createTerminal({
			name: request.name,
			shellPath: started.executable,
			shellArgs: started.args,
			cwd: request.cwd,
			env: request.env,
			iconPath: new vscode.ThemeIcon('robot'),
			location: vscode.TerminalLocation.Panel
		});
		this.byName.set(request.name, terminal);
		const pid = opened?.processId ?? await pidOf(terminal, LAUNCH_TIMEOUT_MS);
		if (pid === undefined) {
			const exit = terminal.exitStatus;
			if (!opened || exit) {
				terminal.dispose();
				this.byName.delete(request.name);
				throw new Error(exit ? vscode.l10n.t("{0} exited as it started (exit code {1}).", request.executable, String(exit.code)) : vscode.l10n.t("{0} did not start within {1} seconds.", request.executable, String(LAUNCH_TIMEOUT_MS / 1000)));
			}
			// Running under its row and showing nothing yet: the window tells its id with its first output.
			this.log?.(`${request.name} runs, but its process id is not known yet.`);
			void Promise.resolve(terminal.processId).then(later => later !== undefined ? this.state.update(PIDS_KEY, { ...this.pids(), [request.name]: later }) : undefined);
		} else {
			await this.state.update(PIDS_KEY, { ...this.pids(), [request.name]: pid });
		}
		if (request.answers?.length) {
			void this.answerFirstQuestions(request.name, terminal, request.answers);
		}
		if (request.initialInput) {
			// An agent that takes no prompt argument gets it typed in once its UI is up.
			const input = request.initialInput;
			const timer = setTimeout(() => {
				if (terminal.exitStatus === undefined) {
					terminal.sendText(input, true);
				}
			}, INPUT_DELAY_MS);
			this.disposables.push({ dispose: () => clearTimeout(timer) });
		}
	}

	stop(name: string): void {
		void this.find(name).then(terminal => terminal?.dispose());
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
	private async openUnderItsRow(request: AgentLaunchRequest, started: { readonly executable: string; readonly args: string | string[] }): Promise<{ readonly terminal: vscode.Terminal; readonly processId: number | undefined } | undefined> {
		let opened: { readonly processId?: number } | undefined;
		try {
			opened = await vscode.commands.executeCommand<{ readonly processId?: number }>('_facade.terminal.create', vscode.Uri.file(request.cwd), {
				name: request.name,
				executable: started.executable,
				args: started.args,
				env: request.env,
				cwd: request.cwd,
				agent: true
			});
		} catch (err) {
			this.log?.(`Facade's terminal command is not there (${(err as Error).message}); ${request.name} opens in the panel.`);
			return undefined;
		}
		// ⚠️ Once the workbench made it, the agent runs: never a second one in the panel. Not found is a failure.
		// Without a process id when the process has shown nothing yet: then it is found by its name.
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

	/**
	 * Puts a worker's terminal in front. One held for another folder's row comes up by moving the
	 * window onto that folder, as a click on the row would; the workbench knows which.
	 */
	async reveal(name: string): Promise<boolean> {
		const terminal = await this.find(name);
		if (!terminal) {
			return false;
		}
		const pid = this.pids()[name] ?? await pidOf(terminal);
		try {
			if (pid !== undefined && await vscode.commands.executeCommand<boolean>('_facade.terminal.reveal', pid)) {
				return true;
			}
		} catch {
			// Without Facade's workbench commands, VS Code's own show does.
		}
		terminal.show();
		return true;
	}

	/** When the person last typed into a worker's terminal, if the window can tell. */
	async lastInputAt(name: string): Promise<number | undefined> {
		const terminal = await this.find(name);
		const pid = terminal && (this.pids()[name] ?? await pidOf(terminal));
		if (pid === undefined) {
			return undefined;
		}
		try {
			return await vscode.commands.executeCommand<number | undefined>('_facade.terminal.lastInput', pid);
		} catch {
			return undefined;
		}
	}

	/** Types a line into a worker's terminal, then Enter. */
	async type(name: string, text: string): Promise<boolean> {
		const terminal = await this.find(name);
		if (!terminal || terminal.exitStatus !== undefined) {
			return false;
		}
		terminal.sendText(text, false);
		// Enter on its own, a moment later: sent together, a terminal UI can take both as one paste
		// and put the line break into its input instead of submitting it.
		await new Promise(resolve => setTimeout(resolve, 300));
		terminal.sendText('\r', false);
		return true;
	}

	/**
	 * Answers the questions the agent's UI asks as it starts (`AgentLaunchRequest.answers`), which the
	 * person let Facade answer: read off its terminal's last lines, and answered with the keys the
	 * person would press, one at a time. One still on screen a few seconds later is answered again.
	 * Done once each was answered and none is on screen, or after a while.
	 */
	private async answerFirstQuestions(name: string, terminal: vscode.Terminal, answers: readonly FirstRunAnswer[]): Promise<void> {
		const answeredAt = new Map<FirstRunAnswer, number>();
		const deadline = Date.now() + FIRST_RUN_MS;
		while (Date.now() < deadline && terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal)) {
			await delay(500);
			const pid = this.pids()[name] ?? await pidOf(terminal);
			const screen = pid === undefined ? undefined : await Promise.resolve(vscode.commands.executeCommand<string | undefined>('_facade.terminal.read', pid, 40)).catch(() => undefined);
			if (!screen) {
				continue;
			}
			let asking = false;
			for (const answer of answers) {
				const keys = keysToAnswer(screen, answer);
				if (!keys) {
					continue;
				}
				asking = true;
				const last = answeredAt.get(answer);
				if (last !== undefined && Date.now() - last < 3_000) {
					continue;
				}
				answeredAt.set(answer, Date.now());
				this.log?.(`${name} asks ${answer.question.source}: answered ${answer.choose.source}`);
				for (const key of keys) {
					// One at a time: sent together, a terminal UI can take the keys for a paste
					terminal.sendText(key, false);
					await delay(150);
				}
			}
			if (!asking && answeredAt.size === answers.length) {
				return;
			}
		}
	}

	dispose(): void {
		clearInterval(this.poll);
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private pids(): Record<string, number> {
		return this.state.get<Record<string, number>>(PIDS_KEY, {});
	}

	/**
	 * Forgets the workers whose terminals did not come back once the extension host started: closed
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
		const pid = await pidOf(terminal);
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
			this.onExit(name, exitCode);
		}
	}
}

/**
 * The terminal a worker called `name` runs in: by that name, which it was given, else by its process
 * id. The ids are asked of all the terminals at once, each for a moment at most.
 */
async function terminalOf(name: string, pid: number | undefined): Promise<vscode.Terminal | undefined> {
	const terminals = vscode.window.terminals;
	const named = terminals.find(terminal => terminal.name === name || terminal.creationOptions.name === name);
	if (named || pid === undefined) {
		return named;
	}
	const pids = await Promise.all(terminals.map(terminal => pidOf(terminal)));
	const index = pids.indexOf(pid);
	return index >= 0 ? terminals[index] : undefined;
}

/**
 * How a program is started in a terminal. On Windows, Facade's own executable, which runs the shim,
 * is a windowed program: started straight in a terminal it gets no console, what it prints goes
 * nowhere, and the window never learns its process id, which comes with the first output. Under cmd
 * it takes cmd's console. Its arguments are paths and words, each quoted for cmd, which reads them as
 * they are - but for `%`, so anything with one is started straight.
 */
function inConsole(executable: string, args: readonly string[]): { readonly executable: string; readonly args: string | string[] } {
	const words = [executable, ...args];
	const windowed = process.platform === 'win32' && path.resolve(executable).toLowerCase() === path.resolve(process.execPath).toLowerCase();
	if (!windowed || words.some(word => /["%\r\n]/.test(word))) {
		return { executable, args: [...args] };
	}
	return { executable: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${words.map(word => `"${word}"`).join(' ')}"` };
}

/** A terminal's process id, or undefined when the window has not told it within `waitMs`. */
function pidOf(terminal: vscode.Terminal, waitMs = PID_WAIT_MS): Promise<number | undefined> {
	return Promise.race([Promise.resolve(terminal.processId), delay(waitMs).then(() => undefined)]);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
