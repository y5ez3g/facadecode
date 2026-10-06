/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { isEqualPath, replaceFile } from '../base/files';
import { Caller, Exit, ExitKind, isAgentName, isLive, LiveProcess, MadeWorktree, MAX_NAME_LENGTH, parentOf, PERSON, Process, RESERVED_NAMES, WorkspaceState } from './events';
import { Ledger, LedgerOptions } from './ledger';

/** The person's token, in the workspace's folder: scripts that hold it act as the person. */
const YOU_TOKEN_FILE = 'you.token';
/**
 * The highest PID the workspace gave, beside its ledger: a ledger moved aside - by Facade, being another
 * version's, or by the person - and begun anew counts on from it, so that no PID is given twice.
 */
const LAST_PID_FILE = 'last-pid';
const RUNS_DIR = 'runs';
/** A file of a process's run: `<pid>.<anything>`. */
const RUN_FILE = /^(?<pid>\d+)\./;

/** An agent's name as given - `@clamp` or `Clamp` - in its form: lower case, without the `@`. Throws with why one is no name. */
export function agentName(text: string): string {
	const name = text.trim().replace(/^@/, '').toLowerCase();
	if (RESERVED_NAMES.has(name)) {
		throw new Error(`"${name}" is reserved: choose another name.`);
	}
	if (!isAgentName(name)) {
		throw new Error(`"${text}" is not a name: use up to ${MAX_NAME_LENGTH} letters, digits, dots, dashes or underscores, starting with a letter or digit.`);
	}
	return name;
}

/** The name an agent gets from its worktree when it is given none: `feature/Clamp` gives `feature-clamp`. */
export function nameOfWorktree(worktree: string): string {
	const name = worktree.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, MAX_NAME_LENGTH).replace(/[^a-z0-9]+$/, '');
	return isAgentName(name) ? name : 'agent';
}

/** Where a workspace's processes are recorded, and what tests replace of the ledger's. */
export interface ProcessTableOptions extends LedgerOptions {
	/** The workspace's folder under `~/.facade/workspaces`. */
	readonly dir: string;
}

/** A process to start: who it is, who starts it, and where it works. */
export interface NewProcess {
	readonly name: string;
	readonly ppid: number;
	readonly cli: string;
	readonly model: string;
	readonly effort: string;
	readonly worktree: string;
	readonly folder: string;
	/** The task of a CLI that is told of its task in its terminal, given its PID: written to a file of its own. */
	readonly task?: (pid: number) => string;
}

/** A process just started, and the token it calls Facade with. */
export interface StartedProcess {
	readonly process: Process;
	readonly token: string;
	/** The file its MCP server reads the token from. */
	readonly tokenFile: string;
}

/**
 * A workspace's processes as its ledger records them, and the tokens they call Facade with. Each
 * process's token is in a file of its run, which its MCP server reads; the ledger keeps only its hash.
 * The person's token is in `you.token`. Every file is readable by the user only.
 */
export class ProcessTable {

	private personToken = '';
	/** The highest PID given, as `last-pid` says it: a ledger begun anew counts on from it. */
	private lastPid = 0;

	private constructor(private readonly options: ProcessTableOptions, private readonly ledger: Ledger) { }

	/** Opens a workspace's ledger, making it the first time. */
	static open(options: ProcessTableOptions): ProcessTable {
		const ledger = Ledger.open(options.dir, options);
		const table = new ProcessTable(options, ledger);
		try {
			table.personToken = readOrCreateToken(path.join(options.dir, YOU_TOKEN_FILE));
			table.lastPid = readLastPid(path.join(options.dir, LAST_PID_FILE));
		} catch (err) {
			ledger.close();
			throw err;
		}
		table.removeRunFiles(pid => !isLive(table.state.processes.get(pid)));
		return table;
	}

	/** What the ledger says now. */
	get state(): WorkspaceState {
		return this.ledger.state;
	}

	/** The workspace's folder under `~/.facade/workspaces`. */
	get dir(): string {
		return this.options.dir;
	}

	/** Where each process's token, task and launch files go. */
	get runsDir(): string {
		return path.join(this.options.dir, RUNS_DIR);
	}

	/** Closes the ledger, for this window's reload or the next window to open it. */
	dispose(): void {
		this.ledger.close();
	}

	/** The person, or the process that has not exited, that a token belongs to. */
	authenticate(token: string): Caller | undefined {
		if (token === this.personToken) {
			return PERSON;
		}
		const pid = this.state.tokens.get(hashToken(token));
		const process = pid === undefined ? undefined : this.state.processes.get(pid);
		return isLive(process) ? { pid: process.pid, name: process.name } : undefined;
	}

	/** The process with the PID `pid`, exited or not. */
	get(pid: number): Process | undefined {
		return this.state.processes.get(pid);
	}

	/** The processes that have not exited and are called `name`. */
	liveNamed(name: string): LiveProcess[] {
		return [...this.state.processes.values()].filter((process): process is LiveProcess => isLive(process) && process.name === name);
	}

	/** A process's parent now: the person's PID once the process that spawned it has exited. */
	parentOf(process: Process): number {
		return parentOf(this.state, process);
	}

	/** The children of `pid` that have not exited, oldest first. */
	childrenOf(pid: number): LiveProcess[] {
		return [...this.state.processes.values()].filter((process): process is LiveProcess => isLive(process) && this.parentOf(process) === pid);
	}

	/**
	 * Records a new process under the next PID, and writes its token and its task. Nothing is written
	 * once the ledger is closed or another window's: the PID may be one that window gave.
	 */
	start(process: NewProcess): StartedProcess {
		const name = agentName(process.name);
		this.ledger.assertOpen();
		const pid = Math.max(this.state.lastPid, this.lastPid) + 1;
		// Given before it is recorded: a PID the ledger missed is never given again either
		replaceFile(path.join(this.options.dir, LAST_PID_FILE), String(pid));
		this.lastPid = pid;
		const token = crypto.randomBytes(32).toString('base64url');
		const tokenFile = path.join(this.runsDir, `${pid}.token`);
		fs.mkdirSync(this.runsDir, { recursive: true });
		fs.writeFileSync(tokenFile, token, { mode: 0o600 });
		let taskFile: string | undefined;
		if (process.task) {
			taskFile = path.join(this.runsDir, `${pid}.task.md`);
			fs.writeFileSync(taskFile, process.task(pid), { mode: 0o600 });
		}
		this.ledger.append({
			type: 'process.started',
			pid,
			name,
			ppid: process.ppid,
			cli: process.cli,
			model: process.model,
			effort: process.effort,
			worktree: process.worktree,
			folder: process.folder,
			...(taskFile !== undefined ? { taskFile } : {}),
			tokenHash: hashToken(token)
		});
		const started = this.state.processes.get(pid);
		if (!started) {
			throw new Error(`The ledger did not record PID ${pid}.`);
		}
		return { process: started, token, tokenFile };
	}

	/** Records that a starting process is running: its MCP server said hello. */
	setRunning(pid: number): void {
		if (this.state.processes.get(pid)?.state === 'starting') {
			this.ledger.append({ type: 'process.running', pid });
		}
	}

	/** Records that the line telling a process of its task file was typed into its terminal. */
	setTaskTyped(pid: number): void {
		const process = this.state.processes.get(pid);
		if (isLive(process) && process.taskFile !== undefined && !process.taskTyped) {
			this.ledger.append({ type: 'task.typed', pid });
		}
	}

	/** Records how a process exited, and removes its run files; answers with its exit, or undefined for one that had exited already. */
	setExited(pid: number, kind: ExitKind, reason: string): Exit | undefined {
		if (!isLive(this.state.processes.get(pid))) {
			return undefined;
		}
		this.ledger.append({ type: 'process.exited', pid, kind, reason });
		this.removeRunFiles(each => each === pid);
		return this.state.processes.get(pid)?.exit;
	}

	/** Records a worktree Facade made for a child. */
	recordWorktree(worktree: MadeWorktree): void {
		this.ledger.append({ type: 'worktree.made', ...worktree });
	}

	/** Records that a worktree Facade made is gone; nothing for a folder Facade did not make. */
	forgetWorktree(folder: string): void {
		if ([...this.state.worktrees.keys()].some(made => isEqualPath(made, folder))) {
			this.ledger.append({ type: 'worktree.gone', folder });
		}
	}

	/** The worktree Facade made at `folder`, if it did. */
	madeWorktree(folder: string): MadeWorktree | undefined {
		return [...this.state.worktrees.values()].find(made => isEqualPath(made.folder, folder));
	}

	/** Removes the run files of the processes `exited` names; a file that is in use stays for the next opening. */
	private removeRunFiles(exited: (pid: number) => boolean): void {
		let names: string[];
		try {
			names = fs.readdirSync(this.runsDir);
		} catch {
			return;
		}
		for (const name of names) {
			const pid = RUN_FILE.exec(name)?.groups?.pid;
			if (pid !== undefined && exited(Number(pid))) {
				try {
					fs.rmSync(path.join(this.runsDir, name), { recursive: true, force: true });
				} catch {
					// Held open for a moment on Windows.
				}
			}
		}
	}
}

/** The ledger keeps a token's hash, never the token. */
function hashToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * The person's token: made the first time, and written in one step. One that cannot be read is not
 * replaced - the scripts that hold it would no longer be the person's - and opening fails with why.
 */
function readOrCreateToken(file: string): string {
	try {
		const token = fs.readFileSync(file, 'utf8').trim();
		if (token) {
			return token;
		}
	} catch (err) {
		if (codeOf(err) !== 'ENOENT') {
			throw err;
		}
	}
	const token = crypto.randomBytes(32).toString('base64url');
	replaceFile(file, token);
	return token;
}

/** The highest PID `file` says the workspace gave; 0 when it says none, or nothing a PID can be. */
function readLastPid(file: string): number {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return 0;
		}
		throw err;
	}
	const pid = Number(text.trim());
	return Number.isInteger(pid) && pid > 0 ? pid : 0;
}
