/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { isJsonObject, isStringArray } from '../base/json';
import { disposeAll } from '../base/lifecycle';
import { Environment } from '../clis/cli';
import { FacadeError } from '../core/errors';
import { Disposable, InputEffect, KeysOptions, PersonInput, StopSignal, TerminalEnd, TerminalLaunch, Terminals, TerminalScreen, TerminalsInside, TypeOptions } from '../core/ports';

/**
 * How long Facade's workbench is waited for at most to have its terminals back where the wait has no time of its own -
 * whether an agent's process is alive, a doorbell: its pty host may not answer. A call waits its own time (D2, D3).
 */
const RESTORE_TIMEOUT_MS = 60_000;
/** How long, once the window has its terminals back, a process it cannot tell of yet is asked after: its id comes a moment after its terminal. */
const UNKNOWN_WAIT_MS = 10_000;
const UNKNOWN_POLL_MS = 250;
/** How often the watched agents' processes are looked at, for one that ended while its terminal stays open to show how. */
const ENDS_POLL_MS = 5_000;
/** Why a window cannot read agents' screens or type there: in English, as Facade's errors say it to the agent. */
const WITHOUT_WORKBENCH = 'Cannot read agent screens or send terminal input: this window is running without Facade\'s workbench.';
/** Why the window says it closed an agent's terminal, where it was not its tab. */
const TERMINAL_END_REASONS: ReadonlySet<string> = new Set<NonNullable<TerminalEnd['reason']>>(['worktreeDeleted', 'folderRemoved', 'folderGone']);
/** Why the window says not all of an input went in. */
const INPUT_REASONS: ReadonlySet<string> = new Set<NonNullable<InputEffect['reason']>>(['ended', 'timeout', 'frameworkOff']);

/** What the window knows of an agent's process, as `_facade.terminal.processes` answers. */
type RunProcess =
	| { readonly id: number; readonly state: 'present'; readonly processId?: number }
	| { readonly id: number; readonly state: 'unknown' }
	| { readonly id: number; readonly state: 'gone'; readonly end?: TerminalEnd };

/** Whether `candidate` is a `RunProcess`: the workbench's answer, each field checked. */
function isRunProcess(candidate: unknown): candidate is RunProcess {
	if (!isJsonObject(candidate) || typeof candidate.id !== 'number') {
		return false;
	}
	const { state, end, processId } = candidate;
	return (state === 'present' && (processId === undefined || (typeof processId === 'number' && Number.isInteger(processId) && processId > 0))) || state === 'unknown' || (state === 'gone' && (end === undefined || (isJsonObject(end) && typeof end.byThePerson === 'boolean' && (end.exitCode === undefined || typeof end.exitCode === 'number') && (end.reason === undefined || isTerminalEndReason(end.reason)))));
}

/** Whether `value` is a reason the window gives for closing an agent's terminal. */
function isTerminalEndReason(value: unknown): value is NonNullable<TerminalEnd['reason']> {
	return typeof value === 'string' && TERMINAL_END_REASONS.has(value);
}

/** Whether `value` is a reason the window gives for not all of an input going in. */
function isInputReason(value: unknown): value is NonNullable<InputEffect['reason']> {
	return typeof value === 'string' && INPUT_REASONS.has(value);
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
	/**
	 * The agents whose processes' ends are looked for: those launched here, and those found running coming back - or not
	 * told of then, whose end is recorded once the window can tell of it (AGENT-LAUNCHER.md, L12).
	 */
	private readonly watched = new Set<number>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly poll: ReturnType<typeof setInterval>;
	/** Settles once the window has the terminals it had back; each call waits for it for its own time at most. */
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

	async launch(request: TerminalLaunch): Promise<{ readonly processId?: number }> {
		if (!(await vscode.commands.getCommands()).includes('_facade.terminal.create')) {
			throw new Error('Cannot create agent terminals in this window: Facade Code\'s workbench is unavailable.');
		}
		const opened = await vscode.commands.executeCommand<{ readonly processId?: number; readonly closed: boolean; readonly exitCode?: number }>('_facade.terminal.create', vscode.Uri.file(request.cwd), {
			name: request.name,
			executable: request.executable,
			args: request.args,
			env: request.env,
			cwd: request.cwd,
			agent: request.command,
			custom: request.custom,
			reveal: request.reveal,
			run: this.runOf(request.id),
			finalScreen: vscode.Uri.file(request.finalScreen)
		});
		// Closed already: its process could not start.
		if (opened.closed) {
			throw new Error(exitedAsItStarted(request.executable, opened.exitCode));
		}
		this.watched.add(request.id);
		return typeof opened.processId === 'number' && opened.processId > 0 ? { processId: opened.processId } : {};
	}

	/** How the processes `isAlive` found gone had ended, where the window saw it. */
	private readonly seenEnds = new Map<number, TerminalEnd>();
	/** The processes `isAlive` found running, where the window knows them. */
	private readonly seenProcesses = new Map<number, number>();

	onDidEnd(listener: (id: number, end: TerminalEnd) => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	async isAlive(id: number): Promise<boolean> {
		await this.whenRestored(undefined);
		const deadline = Date.now() + UNKNOWN_WAIT_MS;
		let known = await this.processOf(id);
		while (known.state === 'unknown' && Date.now() < deadline) {
			await timeout(UNKNOWN_POLL_MS);
			known = await this.processOf(id);
		}
		if (known.state === 'unknown') {
			// Looked for all the same: once the window tells of its end, that end is recorded (L12)
			this.watched.add(id);
			throw new Error('the window cannot determine whether the agent\'s process is running');
		}
		if (known.state === 'present') {
			this.watched.add(id);
			if (known.processId !== undefined) {
				this.seenProcesses.set(id, known.processId);
			}
		}
		if (known.state === 'gone' && known.end) {
			this.seenEnds.set(id, known.end);
		}
		return known.state === 'present';
	}

	/** Whether the window has agent `id`'s terminal now, its process running: no waiting on one it cannot tell of. */
	async hasTerminal(id: number): Promise<boolean> {
		try {
			return (await this.processOf(id)).state === 'present';
		} catch {
			return false;
		}
	}

	endOf(id: number): TerminalEnd | undefined {
		return this.seenEnds.get(id);
	}

	processIdOf(id: number): number | undefined {
		return this.seenProcesses.get(id);
	}

	async stop(id: number, signal?: StopSignal): Promise<{ readonly exitCode?: number }> {
		const gone = await vscode.commands.executeCommand<false | { readonly exitCode?: number }>('_facade.terminal.stop', this.runOf(id), signal);
		if (!gone) {
			throw new Error('its process has not ended yet');
		}
		return typeof gone.exitCode === 'number' ? { exitCode: gone.exitCode } : {};
	}

	async read(id: number, lines: number, waitMs: number): Promise<TerminalScreen | undefined> {
		if (!await hasCommand('_facade.terminal.read')) {
			throw new FacadeError('UNAVAILABLE', WITHOUT_WORKBENCH);
		}
		// A terminal the window is still giving back after a reload is waited for, the call's time at most (D2)
		await this.whenRestored(waitMs);
		return screenOf(await vscode.commands.executeCommand<unknown>('_facade.terminal.read', this.runOf(id), lines));
	}

	async type(id: number, text: string, options: TypeOptions): Promise<InputEffect | undefined> {
		if (!await hasCommand('_facade.terminal.type')) {
			throw new FacadeError('UNAVAILABLE', WITHOUT_WORKBENCH, { outcome: 'not_applied' });
		}
		// Its wait for the terminals back counts in its queue's time: a call waits that long at most before it begins (D3)
		const queueTimeoutMs = await this.whenRestored(options.queueTimeoutMs);
		return effectOf(await vscode.commands.executeCommand<unknown>('_facade.terminal.type', this.runOf(id), text, { enter: options.enter, enterDelayMs: options.enterDelayMs, queueTimeoutMs: queueTimeoutMs ?? null, ...(options.requiresFramework ? { requiresFramework: true } : {}) }));
	}

	async keys(id: number, keys: readonly string[], options: KeysOptions): Promise<InputEffect | undefined> {
		if (!await hasCommand('_facade.terminal.keys')) {
			throw new FacadeError('UNAVAILABLE', WITHOUT_WORKBENCH, { outcome: 'not_applied' });
		}
		const queueTimeoutMs = await this.whenRestored(options.queueTimeoutMs);
		return effectOf(await vscode.commands.executeCommand<unknown>('_facade.terminal.keys', this.runOf(id), keys, { queueTimeoutMs: queueTimeoutMs ?? null }));
	}

	/**
	 * Waits until the window has its terminals back after a reload - `waitMs` at most, {@link RESTORE_TIMEOUT_MS}
	 * with none - and answers with what is left of `waitMs`. Its timer is cleared once they are back: no call leaves
	 * one running.
	 */
	private async whenRestored(waitMs: number | undefined): Promise<number | undefined> {
		const start = Date.now();
		const over = new AbortController();
		await Promise.race([this.restored, timeout(waitMs ?? RESTORE_TIMEOUT_MS, over.signal).catch(() => undefined)]);
		over.abort();
		return waitMs === undefined ? undefined : Math.max(waitMs - (Date.now() - start), 0);
	}

	/** What holds Facade's input into the agent's terminal back, as Facade's workbench saw the person's keys there; undefined where it cannot tell. */
	async input(id: number): Promise<PersonInput | undefined> {
		if (!await hasCommand('_facade.terminal.input')) {
			return undefined;
		}
		const input = await vscode.commands.executeCommand<unknown>('_facade.terminal.input', this.runOf(id));
		if (!isJsonObject(input) || typeof input.pending !== 'boolean') {
			return undefined;
		}
		return { pending: input.pending, ...(typeof input.lastKey === 'number' ? { lastKey: input.lastKey } : {}), ...(input.busy === true ? { busy: true } : {}) };
	}

	async register(id: number, finalScreen: string): Promise<boolean> {
		if (!await hasCommand('_facade.terminal.register')) {
			return false;
		}
		return await vscode.commands.executeCommand<unknown>('_facade.terminal.register', this.runOf(id), vscode.Uri.file(finalScreen)) === true;
	}

	/** Puts the agent's terminal in front through its folder's row, which the window goes to. False when its process runs in none, or it could not be put in front. */
	async reveal(id: number): Promise<boolean> {
		return vscode.commands.executeCommand<boolean>('_facade.terminal.reveal', this.runOf(id));
	}

	dispose(): void {
		clearInterval(this.poll);
		this.listeners.clear();
		disposeAll(this.disposables, err => this.log(`Error while shutting down Facade agents: ${messageOf(err)}`));
	}

	async inside(folder: string): Promise<TerminalsInside> {
		const uri = vscode.Uri.file(folder);
		const [answer, titles] = await Promise.all([
			vscode.commands.executeCommand<unknown>('_facade.terminal.inside', uri),
			vscode.commands.executeCommand<unknown>('_facade.terminal.elsewhere', uri)
		]);
		const runs = (Array.isArray(answer) ? answer : []).filter((run): run is { readonly workspace: string; readonly id: number } => typeof run?.workspace === 'string' && typeof run?.id === 'number');
		const elsewhere = (Array.isArray(titles) ? titles : []).filter((title): title is string => typeof title === 'string');
		return { agents: runs.filter(run => run.workspace === this.workspace).map(run => run.id), others: runs.filter(run => run.workspace !== this.workspace).length, elsewhere };
	}

	/** The run of the agent numbered `id`: its terminal's, as the workbench knows it. */
	runOf(id: number): { readonly workspace: string; readonly id: number } {
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
		}).catch(err => this.log(`Could not check for agents whose processes have ended: ${messageOf(err)}`)).finally(() => {
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
		throw new Error('The window did not return its terminal environment.');
	}
	return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
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

/** The screen the workbench answered `_facade.terminal.read` with; undefined for none, or an answer that is not one. */
function screenOf(value: unknown): TerminalScreen | undefined {
	if (!isJsonObject(value) || !isStringArray(value.lines) || (value.buffer !== 'normal' && value.buffer !== 'alternate') || typeof value.capturedAt !== 'number') {
		return undefined;
	}
	return {
		lines: value.lines,
		buffer: value.buffer,
		older: value.older === true,
		trimmed: value.trimmed === true,
		capturedAt: value.capturedAt,
		...(typeof value.lastOutput === 'number' ? { lastOutput: value.lastOutput } : {}),
		exited: value.exited === true
	};
}

/**
 * What went in, as the workbench answered an input: undefined where it found no such terminal. An answer
 * that says nothing of what went in leaves it unknown: an error, never "nothing went in" (D9).
 */
function effectOf(value: unknown): InputEffect | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!isJsonObject(value) || (value.outcome !== 'applied' && value.outcome !== 'partial' && value.outcome !== 'not_applied')
		|| (value.reason !== undefined && !isInputReason(value.reason))
		|| (value.pasted !== undefined && typeof value.pasted !== 'boolean') || (value.entered !== undefined && typeof value.entered !== 'boolean')
		|| (value.keysSent !== undefined && (typeof value.keysSent !== 'number' || !Number.isInteger(value.keysSent) || value.keysSent < 0))) {
		throw new Error(`The workbench did not confirm whether input was written: ${JSON.stringify(value)}.`);
	}
	return {
		outcome: value.outcome,
		...(value.reason !== undefined ? { reason: value.reason } : {}),
		...(value.pasted !== undefined ? { pasted: value.pasted } : {}),
		...(value.entered !== undefined ? { entered: value.entered } : {}),
		...(value.keysSent !== undefined ? { keysSent: value.keysSent } : {})
	};
}

/** Why a launch failed whose terminal closed as it started; in English, as Facade's own errors say it to the parent. */
function exitedAsItStarted(executable: string, exitCode: number | undefined): string {
	return exitCode === undefined ? `${executable} exited during startup.` : `${executable} exited during startup (exit code ${exitCode}).`;
}

/**
 * Settles once the window has the terminals it had back - reconnected to their processes, the editor
 * area's and floating windows' restored - as Facade's workbench says.
 */
async function terminalsRestored(): Promise<void> {
	await Promise.resolve(vscode.commands.executeCommand('_facade.terminal.whenRestored')).catch(() => undefined);
}
