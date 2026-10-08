/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { isProcessRunning } from '../base/system';
import { Environment } from '../clis/cli';
import { Disposable, PersonInput, TerminalEnd, TerminalLaunch, Terminals } from '../core/ports';
import { endOf } from './terminalEnd';
import { agentTerminalIndex } from './terminalMatch';
import { StateStore } from './windowState';

const PIDS_KEY = 'facade.agents.terminalPids';
const LAUNCH_TIMEOUT_MS = 15_000;
/** How long one terminal's process id is waited for. */
const PID_WAIT_MS = 1_000;
/** How long after the extension host started a window without Facade's workbench has its terminals back. */
const SETTLE_MS = 5_000;
/** How long Facade's workbench is waited for at most to have its terminals back: its pty host may not answer. */
const RESTORE_TIMEOUT_MS = 60_000;
/** How long, once the window has its terminals back, those not found are looked for still: the window tells the extension host of each on its own. */
const FOUND_GRACE_MS = 2_000;
/** How often the agents' processes are looked at, for one that ended while its terminal shows its exit code. */
const EXITS_POLL_MS = 5_000;
/** How often a terminal the window may still be telling of is looked for again. */
const FIND_POLL_MS = 250;
/** How often a terminal just launched is looked for among the window's. */
const LAUNCHED_POLL_MS = 100;

/**
 * The core's Terminals port. Agents run in Facade's own terminals, each in its own UI: the person
 * watches any of them and types into it. Each starts the agent's executable directly with an argument
 * array, never a command typed into a shell, and the workbench holds it under its folder's row. Its
 * CLI's logo, as the agent button draws it, makes it an agent terminal: counted in the agent badge,
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
	private readonly listeners = new Set<(name: string, end: TerminalEnd) => void>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly poll: ReturnType<typeof setInterval>;
	/**
	 * Settles once the window has the terminals it had back, after a reload, with the time until which one
	 * not found yet is still looked for: the window tells the extension host of each on its own. Those not
	 * found by then are gone - one deadline for them all.
	 */
	private readonly foundBy: Promise<number>;
	private disposed = false;

	constructor(private readonly state: StateStore, private readonly log: (message: string) => void) {
		this.disposables.push(vscode.window.onDidCloseTerminal(terminal => this.background('Noting a terminal that closed', this.closed(terminal))));
		// A process can end while its terminal stays open to show the exit code.
		this.poll = setInterval(() => this.checkExits(), EXITS_POLL_MS);
		this.foundBy = terminalsRestored().then(() => Date.now() + FOUND_GRACE_MS);
	}

	/**
	 * Facade has come back to its agents, telling their terminals apart by the process ids the window kept:
	 * those of the agents whose terminals did not come back are forgotten now, once the window has its
	 * terminals back. Not before - forgotten first, an agent's terminal is looked for by its name alone, and
	 * the new shell VS Code starts under the old title, in a tab it could not reconnect to, is taken for it.
	 */
	recovered(): void {
		this.background('Forgetting terminals that are gone', this.foundBy.then(async deadline => {
			await timeout(Math.max(0, deadline - Date.now()));
			if (!this.disposed) {
				await this.forgetGone();
			}
		}));
	}

	async launch(request: TerminalLaunch): Promise<void> {
		const opened = await this.openUnderItsRow(request);
		let terminal = opened?.terminal;
		// Its process ended already, the terminal kept open to show how.
		if (terminal?.exitStatus) {
			throw new Error(exitedAsItStarted(request.executable, terminal.exitStatus.code));
		}
		if (!terminal) {
			terminal = vscode.window.createTerminal({
				name: request.name,
				shellPath: request.executable,
				shellArgs: [...request.args],
				cwd: request.cwd,
				env: request.env,
				iconPath: new vscode.ThemeIcon('robot'),
				location: vscode.TerminalLocation.Panel
			});
			if (request.reveal) {
				terminal.show();
			}
		}
		this.byName.set(request.name, terminal);
		const pid = opened?.processId ?? await processIdOf(terminal, LAUNCH_TIMEOUT_MS);
		if (pid === undefined) {
			const exit = terminal.exitStatus;
			if (!opened || exit) {
				terminal.dispose();
				this.byName.delete(request.name);
				throw new Error(exit ? exitedAsItStarted(request.executable, exit.code) : `${request.executable} did not start within ${LAUNCH_TIMEOUT_MS / 1000} seconds.`);
			}
			// Running under its row and showing nothing yet: the window tells its id with its first output.
			this.log(`${request.name} runs, but its process id is not known yet.`);
			this.background(`Noting ${request.name}'s process`, this.rememberWhenKnown(request.name, terminal));
		} else {
			await this.state.update(PIDS_KEY, { ...this.pids(), [request.name]: pid });
		}
	}

	onDidEnd(listener: (name: string, end: TerminalEnd) => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async isAlive(name: string): Promise<boolean> {
		let terminal = await this.find(name);
		if (!terminal) {
			// The window can still be giving its terminals back, and telling the extension host of each: of
			// its process id too, by which one whose title changed is found.
			const deadline = await this.foundBy;
			terminal = await this.find(name);
			while (!terminal && Date.now() < deadline) {
				await timeout(FIND_POLL_MS);
				terminal = await this.find(name);
			}
		}
		return !!terminal && terminal.exitStatus === undefined;
	}

	async stop(name: string): Promise<void> {
		(await this.find(name))?.dispose();
	}

	async closeRevived(name: string): Promise<void> {
		// A name is an agent's alone: a terminal of it not running the agent's own process is one the window
		// revived. The agent's own, its process ended and its terminal kept to show how, stays for the person.
		const pid = this.pids()[name];
		// Without the agent's process id, one is not told from the other; nor is it found gone by its name then
		if (pid === undefined) {
			return;
		}
		for (const terminal of vscode.window.terminals.filter(each => isNamed(each, name))) {
			if (await processIdOf(terminal) !== pid) {
				this.log(`${name} came back without its agent: a shell the window started in its tab. Closed.`);
				terminal.dispose();
			}
		}
	}

	async type(name: string, text: string): Promise<boolean> {
		const terminal = await this.find(name);
		if (!terminal) {
			return false;
		}
		// Through Facade's workbench, which tells what Facade typed from what the person typed
		const processId = await hasCommand('_facade.terminal.type') ? await processIdOf(terminal) : undefined;
		if (processId === undefined) {
			terminal.sendText(text, false);
			return true;
		}
		return await vscode.commands.executeCommand<boolean>('_facade.terminal.type', processId, text) === true;
	}

	/** What the person typed into the terminal, as Facade's workbench saw their keys; undefined without it, or without the terminal's process id. */
	async input(name: string): Promise<PersonInput | undefined> {
		if (!await hasCommand('_facade.terminal.input')) {
			return undefined;
		}
		const processId = await this.processId(name);
		if (processId === undefined) {
			return undefined;
		}
		const input = await vscode.commands.executeCommand<unknown>('_facade.terminal.input', processId);
		if (!isJsonObject(input) || typeof input.pending !== 'boolean') {
			return undefined;
		}
		return { pending: input.pending, ...(typeof input.lastKey === 'number' ? { lastKey: input.lastKey } : {}) };
	}

	/** The id of the process the terminal runs, as the window tells it; undefined without the terminal, or without word from the window. */
	async processId(name: string): Promise<number | undefined> {
		const terminal = await this.find(name);
		return terminal && processIdOf(terminal);
	}

	/**
	 * Puts the terminal in front through its folder's row, which the window goes to; in the panel's way
	 * without Facade's workbench. False when there is no such terminal, or it could not be put in front.
	 */
	async reveal(name: string): Promise<boolean> {
		const terminal = await this.find(name);
		if (!terminal) {
			return false;
		}
		if (!await hasCommand('_facade.terminal.reveal')) {
			terminal.show();
			return true;
		}
		// The workbench knows it by its process id. Shown without, one held under a row would stay held.
		const processId = await processIdOf(terminal);
		if (processId === undefined) {
			this.log(`${name} cannot be put in front: the window has not told its process id.`);
			return false;
		}
		return vscode.commands.executeCommand<boolean>('_facade.terminal.reveal', processId);
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.poll);
		this.listeners.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/**
	 * The agent's terminal opened by the workbench for the folder it works in: under that folder's row,
	 * coming up when the window goes there, as a terminal somebody opened there would. Undefined in a
	 * window without Facade's workbench, for the panel to take it instead; a failure of the workbench's
	 * is the launch's.
	 */
	private async openUnderItsRow(request: TerminalLaunch): Promise<{ readonly terminal: vscode.Terminal; readonly processId: number | undefined } | undefined> {
		if (!await hasCommand('_facade.terminal.create')) {
			this.log(`The window has no Facade terminals; ${request.name} opens in the panel.`);
			return undefined;
		}
		// A process that ends as it starts can take its terminal with it before the extension host finds
		// it among the window's: its terminal's closing is watched from before it is made.
		let closed: vscode.Terminal | undefined;
		const watch = vscode.window.onDidCloseTerminal(terminal => {
			if (isNamed(terminal, request.name)) {
				closed = terminal;
			}
		});
		try {
			const opened = await vscode.commands.executeCommand<{ readonly processId?: number; readonly closed: boolean; readonly exitCode?: number }>('_facade.terminal.create', vscode.Uri.file(request.cwd), {
				name: request.name,
				executable: request.executable,
				args: request.args,
				env: request.env,
				cwd: request.cwd,
				agent: request.command,
				reveal: request.reveal
			});
			// Closed already: its process could not start.
			if (opened.closed) {
				throw new Error(exitedAsItStarted(request.executable, opened.exitCode));
			}
			// Once the workbench made it, the agent runs: never start a second one in the panel, and treat a
			// terminal that cannot be found as a failure. A process that has shown nothing yet has no id:
			// then its terminal is found by its name.
			const processId = opened.processId;
			const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
			do {
				if (closed) {
					throw new Error(exitedAsItStarted(request.executable, closed.exitStatus?.code));
				}
				const terminal = await terminalOf(request.name, processId);
				if (terminal) {
					return { terminal, processId };
				}
				await timeout(LAUNCHED_POLL_MS);
			} while (Date.now() < deadline);
			throw new Error(`${request.name} was started, but its terminal could not be found.`);
		} finally {
			watch.dispose();
		}
	}

	private async rememberWhenKnown(name: string, terminal: vscode.Terminal): Promise<void> {
		const pid = await terminal.processId;
		if (pid !== undefined) {
			await this.state.update(PIDS_KEY, { ...this.pids(), [name]: pid });
		}
	}

	/** The process ids of the agents' terminals, by their names, as the window kept them: each checked. */
	private pids(): { [name: string]: number } {
		return pidsIn(this.state);
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

	/** A terminal closed: an agent's has ended, as `endOf` reads its exit status. */
	private async closed(terminal: vscode.Terminal): Promise<void> {
		const exit = terminal.exitStatus;
		const end = endOf(exit?.reason === vscode.TerminalExitReason.Shutdown ? 'shutdown' : exit?.reason === vscode.TerminalExitReason.User ? 'user' : 'other', exit?.code);
		if (!end) {
			return;
		}
		const name = await this.nameOf(terminal);
		if (name) {
			this.report(name, end);
			this.byName.delete(name);
			const pids = this.pids();
			delete pids[name];
			await this.state.update(PIDS_KEY, pids);
		}
	}

	private checkExits(): void {
		for (const [name, terminal] of this.byName) {
			const exit = terminal.exitStatus;
			if (exit) {
				this.report(name, { ...(exit.code !== undefined ? { exitCode: exit.code } : {}), byThePerson: false });
			}
		}
	}

	private report(name: string, end: TerminalEnd): void {
		if (!this.reported.has(name)) {
			this.reported.add(name);
			for (const listener of [...this.listeners]) {
				listener(name, end);
			}
		}
	}

	/** Runs `work` on its own: should it fail, the log says what failed and why, and nothing is left unhandled. */
	private background(what: string, work: Promise<unknown>): void {
		work.catch(err => this.log(`${what} failed: ${messageOf(err)}`));
	}
}

/** The process ids of the agents' terminals a window kept in `state`, by their names: each checked. */
function pidsIn(state: StateStore): { [name: string]: number } {
	const kept = state.get(PIDS_KEY);
	const pids: { [name: string]: number } = {};
	for (const [name, pid] of Object.entries(isJsonObject(kept) ? kept : {})) {
		if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
			pids[name] = pid;
		}
	}
	return pids;
}

/**
 * The terminal an agent's launch called `name`, as `agentTerminalIndex` picks it: by the process id the
 * launch recorded, where it is known, else by that name. The ids are asked of all the terminals at once,
 * each for a moment at most.
 */
async function terminalOf(name: string, pid: number | undefined): Promise<vscode.Terminal | undefined> {
	const terminals = vscode.window.terminals;
	const named = terminals.findIndex(terminal => isNamed(terminal, name));
	const pids = pid === undefined ? [] : await Promise.all(terminals.map(terminal => processIdOf(terminal)));
	const index = agentTerminalIndex(named, pids, pid, pid !== undefined && isProcessRunning(pid));
	return index >= 0 ? terminals[index] : undefined;
}

/** Whether a terminal is the one an agent's launch named `name`: by its title, or the name it was made with. */
function isNamed(terminal: vscode.Terminal, name: string): boolean {
	return terminal.name === name || terminal.creationOptions.name === name;
}

/**
 * The environment an agent's terminal starts with, before its launch's own: the window's, as the
 * setting `terminal.integrated.env.<platform>` changes it - a variable set to null taken out, and
 * `${env:NAME}` read from the window's. Where a CLI keeps its files - its trust among them - depends on it.
 */
export function terminalEnvironment(): Environment {
	const windows = process.platform === 'win32';
	const changes = vscode.workspace.getConfiguration('terminal.integrated.env').get<unknown>(windows ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux');
	const env: { [name: string]: string | undefined } = { ...process.env };
	// Windows takes a variable's name in any case: a change is to the variable there is, whatever its case.
	const keyOf = (name: string) => windows ? Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase()) ?? name.toUpperCase() : name;
	for (const [name, value] of Object.entries(isJsonObject(changes) ? changes : {})) {
		if (value === null) {
			delete env[keyOf(name)];
		} else if (typeof value === 'string') {
			env[keyOf(name)] = value.replace(/\$\{env:(?<variable>[^}]+)\}/g, (_, variable: string) => process.env[variable] ?? '');
		}
	}
	return env;
}

/**
 * Whether a terminal process of an agent's that a window kept in `state` - its record's window state -
 * still runs: the agents of that record run on.
 */
export function agentTerminalRuns(state: StateStore): boolean {
	return Object.values(pidsIn(state)).some(isProcessRunning);
}

/** Why a launch failed whose terminal closed as it started; in English, as Facade's own errors say it to the parent. */
function exitedAsItStarted(executable: string, exitCode: number | undefined): string {
	return exitCode === undefined ? `${executable} exited as it started.` : `${executable} exited as it started (exit code ${exitCode}).`;
}

/** The commands of Facade's workbench found in the window: once there, they stay. */
const commandsFound = new Set<string>();

/** Whether the window has the command `id`: Facade's own are there only in Facade's workbench. */
async function hasCommand(id: string): Promise<boolean> {
	if (!commandsFound.has(id) && (await vscode.commands.getCommands()).includes(id)) {
		commandsFound.add(id);
	}
	return commandsFound.has(id);
}

/**
 * Settles once the window has the terminals it had back - reconnected to their processes, the editor
 * area's restored - as Facade's workbench says, for a minute at most; without it, a few seconds after
 * the extension host started. The window tells the extension host of each one as it has it.
 */
async function terminalsRestored(): Promise<void> {
	if (!await hasCommand('_facade.terminal.whenRestored')) {
		await timeout(SETTLE_MS);
		return;
	}
	await Promise.race([Promise.resolve(vscode.commands.executeCommand('_facade.terminal.whenRestored')).catch(() => undefined), timeout(RESTORE_TIMEOUT_MS)]);
}

/** A terminal's process id, or undefined when the window has not told it within `waitMs`. */
function processIdOf(terminal: vscode.Terminal, waitMs = PID_WAIT_MS): Promise<number | undefined> {
	return Promise.race([Promise.resolve(terminal.processId), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), waitMs))]);
}
