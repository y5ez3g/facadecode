/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualPath } from '../base/files';
import { JsonObject } from '../base/json';

/** The person's name: the root of the agents' tree, and the parent of every orphan. The person has no number. */
const YOU = 'you';
/** Facade's own name, which no agent takes: its MCP server is called so, and what it says to an agent starts `[facade]`. */
const FACADE = 'facade';
/** The first number an agent gets; numbers then count up and are never given twice within a workspace. */
const FIRST_ID = 1;
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
export type AgentState = 'starting' | 'running' | 'exited';

/** How an agent exited: its CLI ended, it was killed, or it never came up. */
export type ExitKind = 'exited' | 'killed' | 'failed';

/** How and why an agent exited, and when. */
export interface Exit {
	readonly kind: ExitKind;
	readonly reason: string;
	readonly time: number;
}

/** An agent: one CLI running in its own terminal, in one folder. */
export interface Agent {
	/** Its number, which no other agent of the workspace gets: #13, as words write it. */
	readonly id: number;
	/** A label, which other agents may share. */
	readonly name: string;
	/** The number of the agent that started it; none for one the person started. */
	readonly parent?: number;
	/** The CLI's id. */
	readonly cli: string;
	readonly model: string;
	/** How hard it thinks, as its CLI takes it. */
	readonly effort: string;
	/** The name of its worktree: `main` for a repository's own checkout, else its branch. */
	readonly worktree: string;
	readonly folder: string;
	/** The file its task is in, for a CLI that is told of its task in its terminal. */
	readonly taskFile?: string;
	/** Set once the line that tells it of its task file was typed into its terminal. */
	taskTyped?: boolean;
	/**
	 * Whether it was launched with YOLO on - its CLI's approvals and sandbox off, as its launch's
	 * `fullAccess` arguments turn them off - where its launch recorded it.
	 */
	readonly yolo?: boolean;
	state: AgentState;
	exit?: Exit;
	readonly startTime: number;
}

/** An agent that has not exited. */
export type LiveAgent = Agent & { readonly state: 'starting' | 'running' };

/** A worktree Facade made for a child. */
export interface MadeWorktree {
	/** Its branch, which is also its name. */
	readonly name: string;
	readonly folder: string;
	/** The folder of the repository's main checkout. */
	readonly repository: string;
	/** The name of the worktree it was branched from. */
	readonly parentWorktree: string;
	/** The number of the agent that started the child; none for the person. */
	readonly madeBy?: number;
}

/** The events a workspace's ledger records; its state is what replaying them gives. */
export type LedgerEventBody =
	| {
		readonly type: 'agent.started';
		readonly id: number;
		readonly name: string;
		/** None for an agent the person started. */
		readonly parent?: number;
		readonly cli: string;
		readonly model: string;
		readonly effort: string;
		readonly worktree: string;
		readonly folder: string;
		readonly taskFile?: string;
		readonly tokenHash: string;
		readonly yolo?: boolean;
	}
	| { readonly type: 'agent.running'; readonly id: number }
	| { readonly type: 'task.typed'; readonly id: number }
	| { readonly type: 'agent.exited'; readonly id: number; readonly kind: ExitKind; readonly reason: string }
	| { readonly type: 'worktree.made' } & MadeWorktree
	| { readonly type: 'worktree.gone'; readonly folder: string };

/** An event as the ledger keeps it: numbered, with the time it happened. */
export type LedgerEvent = LedgerEventBody & { readonly seq: number; readonly time: number };

/** Who a call comes from: an agent, by its number, or the person, who has none. */
export interface Caller {
	/** None for the person. */
	readonly id?: number;
	readonly name: string;
}

/** The person, as a caller. */
export const PERSON: Caller = { name: YOU };

/** An agent or the person, as Facade's words name them: `@name #7`, or `the person`. */
export function describe(who: Caller): string {
	return who.id === undefined ? 'the person' : `@${who.name} #${who.id}`;
}

/** Whether `text` names the person, as an agent may: `you` or `@you`, in any case. */
export function namesThePerson(text: string): boolean {
	return text.trim().replace(/^@/, '').toLowerCase() === YOU;
}

/** What a workspace's ledger says now. */
export interface WorkspaceState {
	seq: number;
	/** The highest number given so far. */
	lastId: number;
	/** Every agent the workspace has had, by number. */
	readonly agents: Map<number, Agent>;
	/** The numbers of the agents that have not exited, by the hashes of their tokens. */
	readonly tokens: Map<string, number>;
	/** The worktrees Facade made, by folder. */
	readonly worktrees: Map<string, MadeWorktree>;
}

/** The state of a workspace with no ledger yet: no agent, the next number the first. */
export function createState(): WorkspaceState {
	return { seq: 0, lastId: FIRST_ID - 1, agents: new Map(), tokens: new Map(), worktrees: new Map() };
}

const EXIT_KINDS: ReadonlySet<string> = new Set<ExitKind>(['exited', 'killed', 'failed']);

function isExitKind(value: unknown): value is ExitKind {
	return typeof value === 'string' && EXIT_KINDS.has(value);
}

/** Whether `value` is a number an agent can have. */
function isId(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= FIRST_ID;
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
		case 'agent.started': {
			const { id, name, parent, cli, model, effort, worktree, folder, taskFile, tokenHash, yolo } = value;
			if (!isId(id) || typeof name !== 'string' || !isAgentName(name) || (parent !== undefined && !isId(parent)) || !isText(cli) || !isText(model) || !isText(effort)
				|| !isText(worktree) || !isText(folder) || typeof tokenHash !== 'string' || !TOKEN_HASH.test(tokenHash) || (taskFile !== undefined && !isText(taskFile))
				|| (yolo !== undefined && typeof yolo !== 'boolean')) {
				return undefined;
			}
			return {
				type: 'agent.started', id, name, ...(parent !== undefined ? { parent } : {}), cli, model, effort, worktree, folder, tokenHash, ...(taskFile !== undefined ? { taskFile } : {}),
				...(yolo !== undefined ? { yolo } : {})
			};
		}
		case 'agent.running':
		case 'task.typed':
			return isId(value.id) ? { type: value.type, id: value.id } : undefined;
		case 'agent.exited': {
			const { id, kind, reason } = value;
			return isId(id) && isExitKind(kind) && typeof reason === 'string'
				? { type: 'agent.exited', id, kind, reason }
				: undefined;
		}
		case 'worktree.made': {
			const { name, folder, repository, parentWorktree, madeBy } = value;
			return isText(name) && isText(folder) && isText(repository) && isText(parentWorktree) && (madeBy === undefined || isId(madeBy))
				? { type: 'worktree.made', name, folder, repository, parentWorktree, ...(madeBy !== undefined ? { madeBy } : {}) }
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
 * Whether an event can follow the state the ledger gave so far: an agent starts under a number above
 * every one given, as the person's or as the child of an agent started before it; any other event of an
 * agent is of one the ledger started; a worktree is made by the person or by such an agent.
 */
export function fitsState(state: WorkspaceState, event: LedgerEvent): boolean {
	switch (event.type) {
		case 'agent.started':
			return event.id > state.lastId && (event.parent === undefined || state.agents.has(event.parent));
		case 'agent.running':
		case 'task.typed':
		case 'agent.exited':
			return state.agents.has(event.id);
		case 'worktree.made':
			return event.madeBy === undefined || state.agents.has(event.madeBy);
		case 'worktree.gone':
			return true;
	}
}

/** Applies one event to the state the ledger is replayed into. */
export function applyEvent(state: WorkspaceState, event: LedgerEvent): void {
	state.seq = event.seq;
	switch (event.type) {
		case 'agent.started': {
			state.agents.set(event.id, {
				id: event.id,
				name: event.name,
				...(event.parent !== undefined ? { parent: event.parent } : {}),
				cli: event.cli,
				model: event.model,
				effort: event.effort,
				worktree: event.worktree,
				folder: event.folder,
				...(event.taskFile !== undefined ? { taskFile: event.taskFile } : {}),
				...(event.yolo !== undefined ? { yolo: event.yolo } : {}),
				state: 'starting',
				startTime: event.time
			});
			state.lastId = Math.max(state.lastId, event.id);
			state.tokens.set(event.tokenHash, event.id);
			break;
		}
		case 'agent.running': {
			const agent = state.agents.get(event.id);
			if (agent?.state === 'starting') {
				agent.state = 'running';
			}
			break;
		}
		case 'task.typed': {
			const agent = state.agents.get(event.id);
			if (agent && agent.taskFile !== undefined) {
				agent.taskTyped = true;
			}
			break;
		}
		case 'agent.exited': {
			const agent = state.agents.get(event.id);
			if (agent && agent.state !== 'exited') {
				agent.state = 'exited';
				agent.exit = { kind: event.kind, reason: event.reason, time: event.time };
			}
			for (const [hash, id] of state.tokens) {
				if (id === event.id) {
					state.tokens.delete(hash);
				}
			}
			break;
		}
		case 'worktree.made': {
			const { name, folder, repository, parentWorktree, madeBy } = event;
			state.worktrees.set(folder, { name, folder, repository, parentWorktree, ...(madeBy !== undefined ? { madeBy } : {}) });
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

/** Whether an agent has not exited: starting, or running. */
export function isLive(agent: Agent | undefined): agent is LiveAgent {
	return !!agent && agent.state !== 'exited';
}

/** An agent's parent now: the agent that started it while that one has not exited; none, the person, else. */
export function parentOf(state: WorkspaceState, agent: Agent): number | undefined {
	return agent.parent !== undefined && isLive(state.agents.get(agent.parent)) ? agent.parent : undefined;
}
