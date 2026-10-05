/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualPath } from '../base/files';
import { JsonObject } from '../base/json';

/** The person's name: the root of the process tree, and the parent of every orphan. */
const YOU = 'you';
/** The person's PID. */
export const YOU_PID = 1;
/** Facade's own name, which no agent takes: its MCP server is called so, and what it says to an agent starts `[facade]`. */
const FACADE = 'facade';
/** The first PID an agent gets; PIDs then count up and are never reused within a workspace. */
const FIRST_PID = 2;
/** Names an agent cannot take. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([YOU, FACADE, 'all', 'everyone', 'me', 'init', 'kernel']);
/** The longest an agent's name is. */
export const MAX_NAME_LENGTH = 40;
/** An agent's name: lower case, a letter or digit, then letters, digits, dots, dashes and underscores. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** A token's hash, as the ledger keeps it: SHA-256, in hex. */
const TOKEN_HASH = /^[0-9a-f]{64}$/;

/** Whether `name` is an agent's name: of the form agents' names have, and not reserved. */
export function isAgentName(name: string): boolean {
	return NAME.test(name) && !RESERVED_NAMES.has(name);
}

/**
 * `starting` from its launch, `running` once its MCP server said hello to Facade, `exited` once its
 * terminal ended, it was killed, or it did not come up.
 */
export type ProcessState = 'starting' | 'running' | 'exited';

/** How a process exited: its CLI ended, it was killed, or it never came up. */
export type ExitKind = 'exited' | 'killed' | 'failed';

/** How and why a process exited, and when. */
export interface Exit {
	readonly kind: ExitKind;
	readonly reason: string;
	readonly time: number;
}

/** An agent: one CLI running in its own terminal, in one folder. */
export interface Process {
	readonly pid: number;
	/** A label, which other processes may share. */
	readonly name: string;
	/** The process that spawned it, or the person. */
	readonly ppid: number;
	/** The CLI's id. */
	readonly cli: string;
	readonly model: string;
	/** The name of its worktree: `main` for a repository's own checkout, else its branch. */
	readonly worktree: string;
	readonly folder: string;
	/** The file its task is in, for a CLI that is told of its task in its terminal. */
	readonly taskFile?: string;
	/** Set once the line that tells it of its task file was typed into its terminal. */
	taskTyped?: boolean;
	state: ProcessState;
	exit?: Exit;
	readonly startTime: number;
}

/** A process that has not exited. */
export type LiveProcess = Process & { readonly state: 'starting' | 'running' };

/** A worktree Facade made for a child. */
export interface MadeWorktree {
	/** Its branch, which is also its name. */
	readonly name: string;
	readonly folder: string;
	/** The folder of the repository's main checkout. */
	readonly repository: string;
	/** The name of the worktree it was branched from. */
	readonly parentWorktree: string;
	/** The PID of the process that spawned the child, or the person's. */
	readonly madeBy: number;
}

/** The events a workspace's ledger records; its state is what replaying them gives. */
export type LedgerEventBody =
	| {
		readonly type: 'process.started';
		readonly pid: number;
		readonly name: string;
		readonly ppid: number;
		readonly cli: string;
		readonly model: string;
		readonly worktree: string;
		readonly folder: string;
		readonly taskFile?: string;
		readonly tokenHash: string;
	}
	| { readonly type: 'process.running'; readonly pid: number }
	| { readonly type: 'task.typed'; readonly pid: number }
	| { readonly type: 'process.exited'; readonly pid: number; readonly kind: ExitKind; readonly reason: string }
	| { readonly type: 'worktree.made' } & MadeWorktree
	| { readonly type: 'worktree.gone'; readonly folder: string };

/** An event as the ledger keeps it: numbered, with the time it happened. */
export type LedgerEvent = LedgerEventBody & { readonly seq: number; readonly time: number };

/** Who a call comes from: a process, or the person. */
export interface Caller {
	readonly pid: number;
	readonly name: string;
}

/** The person, as a caller. */
export const PERSON: Caller = { pid: YOU_PID, name: YOU };

/** What a workspace's ledger says now. */
export interface WorkspaceState {
	seq: number;
	/** The highest PID given so far. */
	lastPid: number;
	/** Every process the workspace has had, by PID. */
	readonly processes: Map<number, Process>;
	/** The PIDs of the processes that have not exited, by the hashes of their tokens. */
	readonly tokens: Map<string, number>;
	/** The worktrees Facade made, by folder. */
	readonly worktrees: Map<string, MadeWorktree>;
}

/** The state of a workspace with no ledger yet: no process, the next PID the first. */
export function createState(): WorkspaceState {
	return { seq: 0, lastPid: FIRST_PID - 1, processes: new Map(), tokens: new Map(), worktrees: new Map() };
}

const EXIT_KINDS: ReadonlySet<string> = new Set<ExitKind>(['exited', 'killed', 'failed']);

function isExitKind(value: unknown): value is ExitKind {
	return typeof value === 'string' && EXIT_KINDS.has(value);
}

/** Whether `value` is a PID at least `least`: an agent's is 2 or more, a parent's the person's 1 or more. */
function isPidFrom(value: unknown, least: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= least;
}

/** Whether `value` is a string with something in it. */
function isText(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/**
 * An event read from the ledger, each field checked for what it may hold; undefined when the line is not
 * an event this version writes. Whether it fits what came before it is `fitsState`'s to say.
 */
export function eventOf(value: JsonObject): LedgerEvent | undefined {
	const { seq, time } = value;
	if (typeof seq !== 'number' || typeof time !== 'number') {
		return undefined;
	}
	const body = bodyOf(value);
	return body && { ...body, seq, time };
}

function bodyOf(value: JsonObject): LedgerEventBody | undefined {
	switch (value.type) {
		case 'process.started': {
			const { pid, name, ppid, cli, model, worktree, folder, taskFile, tokenHash } = value;
			if (!isPidFrom(pid, FIRST_PID) || typeof name !== 'string' || !isAgentName(name) || !isPidFrom(ppid, YOU_PID) || !isText(cli) || !isText(model)
				|| !isText(worktree) || !isText(folder) || typeof tokenHash !== 'string' || !TOKEN_HASH.test(tokenHash) || (taskFile !== undefined && !isText(taskFile))) {
				return undefined;
			}
			return { type: 'process.started', pid, name, ppid, cli, model, worktree, folder, tokenHash, ...(taskFile !== undefined ? { taskFile } : {}) };
		}
		case 'process.running':
		case 'task.typed':
			return isPidFrom(value.pid, FIRST_PID) ? { type: value.type, pid: value.pid } : undefined;
		case 'process.exited': {
			const { pid, kind, reason } = value;
			return isPidFrom(pid, FIRST_PID) && isExitKind(kind) && typeof reason === 'string'
				? { type: 'process.exited', pid, kind, reason }
				: undefined;
		}
		case 'worktree.made': {
			const { name, folder, repository, parentWorktree, madeBy } = value;
			return isText(name) && isText(folder) && isText(repository) && isText(parentWorktree) && isPidFrom(madeBy, YOU_PID)
				? { type: 'worktree.made', name, folder, repository, parentWorktree, madeBy }
				: undefined;
		}
		case 'worktree.gone': {
			const { folder } = value;
			return isText(folder) ? { type: 'worktree.gone', folder } : undefined;
		}
	}
	return undefined;
}

/**
 * Whether an event can follow the state the ledger gave so far: a process starts under a PID above every
 * one given, as the child of the person or of a process started before it; any other event of a process
 * is of one the ledger started; a worktree is made by the person or by such a process.
 */
export function fitsState(state: WorkspaceState, event: LedgerEvent): boolean {
	switch (event.type) {
		case 'process.started':
			return event.pid > state.lastPid && (event.ppid === YOU_PID || state.processes.has(event.ppid));
		case 'process.running':
		case 'task.typed':
		case 'process.exited':
			return state.processes.has(event.pid);
		case 'worktree.made':
			return event.madeBy === YOU_PID || state.processes.has(event.madeBy);
		case 'worktree.gone':
			return true;
	}
}

/** Applies one event to the state the ledger is replayed into. */
export function applyEvent(state: WorkspaceState, event: LedgerEvent): void {
	state.seq = event.seq;
	switch (event.type) {
		case 'process.started': {
			state.processes.set(event.pid, {
				pid: event.pid,
				name: event.name,
				ppid: event.ppid,
				cli: event.cli,
				model: event.model,
				worktree: event.worktree,
				folder: event.folder,
				...(event.taskFile !== undefined ? { taskFile: event.taskFile } : {}),
				state: 'starting',
				startTime: event.time
			});
			state.lastPid = Math.max(state.lastPid, event.pid);
			state.tokens.set(event.tokenHash, event.pid);
			break;
		}
		case 'process.running': {
			const process = state.processes.get(event.pid);
			if (process?.state === 'starting') {
				process.state = 'running';
			}
			break;
		}
		case 'task.typed': {
			const process = state.processes.get(event.pid);
			if (process && process.taskFile !== undefined) {
				process.taskTyped = true;
			}
			break;
		}
		case 'process.exited': {
			const process = state.processes.get(event.pid);
			if (process && process.state !== 'exited') {
				process.state = 'exited';
				process.exit = { kind: event.kind, reason: event.reason, time: event.time };
			}
			for (const [hash, pid] of state.tokens) {
				if (pid === event.pid) {
					state.tokens.delete(hash);
				}
			}
			break;
		}
		case 'worktree.made': {
			const { name, folder, repository, parentWorktree, madeBy } = event;
			state.worktrees.set(folder, { name, folder, repository, parentWorktree, madeBy });
			break;
		}
		case 'worktree.gone': {
			for (const folder of [...state.worktrees.keys()]) {
				if (isEqualPath(folder, event.folder)) {
					state.worktrees.delete(folder);
				}
			}
			break;
		}
	}
}

/** Whether a process has not exited: starting, or running. */
export function isLive(process: Process | undefined): process is LiveProcess {
	return !!process && process.state !== 'exited';
}

/** A process's parent now: the process that spawned it while that one has not exited, else the person. */
export function parentOf(state: WorkspaceState, process: Process): number {
	return isLive(state.processes.get(process.ppid)) ? process.ppid : YOU_PID;
}
