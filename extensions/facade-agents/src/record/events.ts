/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualPath } from '../base/files';
import { JsonObject } from '../base/json';

/** The person's name, `@human`: the creator of the first agents. The person has no number. */
const HUMAN = 'human';
/** Facade's own name, which no agent takes: its MCP server is called so, and what it says to an agent starts `[facade]`. */
const FACADE = 'facade';
/** The first number an agent gets; numbers then count up and are never given twice within a workspace. */
const FIRST_ID = 1;
/** Names an agent cannot take: the person's, Facade's, and words a model reads as someone else. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([HUMAN, 'you', 'me', FACADE, 'all', 'everyone', 'init', 'kernel']);
/** The letter of an agent's number, as Facade writes it: `#a7`. Each kind of number has its own, as M2's messages will, `#m7`. */
const AGENT_LETTER = 'a';
/** A number as a tool is given it, with its kind's letter or without: `#a7`, `#m7`, `#7`. */
const NUMBER_REFERENCE = /^#(?<letter>[a-z])?(?<id>\d+)$/i;
/** A number written bare, which an agent's name could also be: `a7`, `7`. */
const BARE_REFERENCE = /^(?<letter>a)?(?<id>\d+)$/i;
/** An agent as Facade's words name it: `@lint #a7`. */
const NAMED_REFERENCE = /^@(?<name>\S+)\s+#(?<letter>[a-z])?(?<id>\d+)$/i;
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
 * `starting` from its launch until it has started - its MCP server said hello, and it has its task: given
 * on its command line, typed into its terminal, or none - `running` from then on, `stopping` once Facade
 * set out to stop it, until its process ended, and `ended` once its process ended.
 */
export type AgentState = 'starting' | 'running' | 'stopping' | 'ended';

/** How an agent ended: its CLI ended by itself, it was stopped, it did not start, or nothing saw it end. */
export type EndKind = 'exited' | 'stopped' | 'failed' | 'lost';

/**
 * How an agent's task reached it: it was given none; as an argument; it is still to be typed into its
 * terminal; it was typed there; or Facade began to type it and cannot know how far it got.
 */
export type TaskDelivery = 'none' | 'argument' | 'pending' | 'typed' | 'unknown';

/** Who stopped an agent: another agent, by its number, or the person. */
export type StoppedBy = number | 'human';

/** An agent's sandbox, as its launch left it: on, off, unavailable where its CLI has none, unknown for a custom agent. */
export type SandboxState = 'on' | 'off' | 'unavailable' | 'unknown';

/** What a launch was given and its CLI's launch had no group for: left out, so not applied. */
export type Ignored = 'model' | 'effort';

/** How an agent ended, by whom where someone stopped it, why, and when. */
export interface End {
	readonly kind: EndKind;
	readonly by?: StoppedBy;
	readonly reason: string;
	readonly time: number;
	/** Its CLI's exit code, where it is known. */
	readonly exitCode?: number;
}

/** An agent: one CLI running in its own terminal, in one folder. */
export interface Agent {
	/** Its number, which no other agent of the workspace gets: #a13, as words write it (`agentRef`). */
	readonly id: number;
	/** A label, which other agents may share. */
	readonly name: string;
	/** The number of the agent that started it; none for one the person started. It never changes. */
	readonly creator?: number;
	/** The number of its tree's root: the agent the person started that it comes from, itself for that one. */
	readonly root: number;
	/** The CLI's id, or a custom agent's name. */
	readonly cli: string;
	/** Whether it is one of the person's custom agents. */
	readonly custom: boolean;
	/** The model and how hard it thinks, as its creator asked for them; none where it asked for none, and the CLI's own applies. */
	readonly model?: string;
	readonly effort?: string;
	/** What it was asked for that its launch had no group for, and was left out. */
	readonly ignored: readonly Ignored[];
	/** Its YOLO, as it started: never changes. */
	readonly yolo: boolean;
	/** Its sandbox, as its launch left it. */
	readonly sandbox: SandboxState;
	/** Whether it was launched with the agent framework's integration: Facade's server, skills and files. */
	readonly integration: boolean;
	/** The name of its worktree: its branch, or the folder's own name outside a repository. */
	readonly worktree: string;
	readonly folder: string;
	/** The number of its task's message, `#m12`; none without a task. */
	readonly taskMessage?: number;
	task: TaskDelivery;
	/** Whether its MCP server said hello to Facade. */
	connected: boolean;
	/** Its CLI's process, once its terminal runs it. */
	processId?: number;
	state: AgentState;
	/** Who set out to stop it, and why, while it is stopping. */
	stopping?: { readonly by?: StoppedBy; readonly reason: string };
	end?: End;
	readonly startTime: number;
}

/** An agent that has not ended. */
export type LiveAgent = Agent & { readonly state: 'starting' | 'running' | 'stopping' };

/** A worktree Facade made for an agent. */
export interface MadeWorktree {
	/** Its branch, which is also its name. */
	readonly name: string;
	readonly folder: string;
	/** The folder of the repository's main checkout. */
	readonly repository: string;
	/** The commit it was made at. */
	readonly commit: string;
	/** The number of the agent that started the agent it was made for; none for the person. */
	readonly madeBy?: number;
}

/** The events a workspace's ledger records; its state is what replaying them gives. */
export type LedgerEventBody =
	| {
		readonly type: 'agent.started';
		readonly id: number;
		readonly name: string;
		/** None for an agent the person started. */
		readonly creator?: number;
		/** Its tree's root; none for a root, which is its own. */
		readonly root?: number;
		readonly cli: string;
		readonly custom?: boolean;
		readonly model?: string;
		readonly effort?: string;
		readonly ignored?: readonly Ignored[];
		readonly yolo: boolean;
		readonly sandbox: SandboxState;
		readonly integration: boolean;
		readonly worktree: string;
		readonly folder: string;
		readonly taskMessage?: number;
		/** How the notice of its task reaches it: none, as an argument, or to be typed into its terminal. */
		readonly task: 'none' | 'argument' | 'pending';
		readonly tokenHash: string;
	}
	| { readonly type: 'agent.launched'; readonly id: number; readonly processId: number }
	| { readonly type: 'agent.connected' | 'task.typing' | 'task.typed' | 'agent.running'; readonly id: number }
	| { readonly type: 'agent.stopping'; readonly id: number; readonly by?: StoppedBy; readonly reason: string }
	| { readonly type: 'agent.ended'; readonly id: number; readonly kind: EndKind; readonly by?: StoppedBy; readonly reason: string; readonly exitCode?: number }
	| { readonly type: 'worktree.made' } & MadeWorktree
	| { readonly type: 'worktree.gone'; readonly folder: string }
	| { readonly type: 'list.cleared' };

/** An event as the ledger keeps it: numbered, with the time it happened. */
export type LedgerEvent = LedgerEventBody & { readonly seq: number; readonly time: number };

/** Who a call comes from: an agent, by its number, or the person, who has none. */
export interface Caller {
	/** None for the person. */
	readonly id?: number;
	readonly name: string;
}

/** The person, as a caller. */
export const PERSON: Caller = { name: HUMAN };

/** An agent's number as Facade writes it: `#a7`. */
export function agentRef(id: number): string {
	return `#${AGENT_LETTER}${id}`;
}

/** A message's number as Facade writes it: `#m12`. */
export function messageRef(id: number): string {
	return `#m${id}`;
}

/** An agent as Facade's words name it, `@lint #a7`; the person as `@human`. */
export function describe(who: Caller): string {
	return who.id === undefined ? `@${HUMAN}` : `@${who.name} ${agentRef(who.id)}`;
}

/**
 * What a tool's reference to an agent says: its number - with its name, or bare, so that it may be a
 * name as well - its name, or a number of another kind.
 */
export type AgentReference =
	| { readonly kind: 'number'; readonly id: number; readonly name?: string; readonly bare: boolean }
	| { readonly kind: 'name'; readonly name: string }
	| { readonly kind: 'other'; readonly text: string };

/**
 * Reads a tool's reference to an agent: `#a7`, `#7`, `a7` or `7` by its number; `@name` or `name` by
 * its name; `@name #a7` by both. A number with another kind's letter, `#m7`, is no agent's.
 */
export function parseAgentReference(text: string): AgentReference {
	const trimmed = text.trim();
	const numbered = NAMED_REFERENCE.exec(trimmed)?.groups ?? NUMBER_REFERENCE.exec(trimmed)?.groups;
	if (numbered) {
		if (numbered.letter !== undefined && numbered.letter.toLowerCase() !== AGENT_LETTER) {
			return { kind: 'other', text: trimmed };
		}
		return { kind: 'number', id: Number(numbered.id), ...(numbered.name !== undefined ? { name: numbered.name.toLowerCase() } : {}), bare: false };
	}
	const bare = BARE_REFERENCE.exec(trimmed)?.groups;
	if (bare) {
		return { kind: 'number', id: Number(bare.id), bare: true };
	}
	return { kind: 'name', name: trimmed.replace(/^@/, '').toLowerCase() };
}

/** What a workspace's ledger says now. */
export interface WorkspaceState {
	seq: number;
	/** The highest number given so far. */
	lastId: number;
	/** The highest message number given so far, `#m12`: a task's message, until AGENT-MESSAGES.md adds the rest. */
	lastMessageId: number;
	/** Every agent the workspace has had, by number. */
	readonly agents: Map<number, Agent>;
	/** The numbers of the agents that have not exited, by the hashes of their tokens. */
	readonly tokens: Map<string, number>;
	/** The worktrees Facade made, by folder. */
	readonly worktrees: Map<string, MadeWorktree>;
}

/** The state of a workspace with no ledger yet: no agent, the next number the first. */
export function createState(): WorkspaceState {
	return { seq: 0, lastId: FIRST_ID - 1, lastMessageId: 0, agents: new Map(), tokens: new Map(), worktrees: new Map() };
}

const END_KINDS: ReadonlySet<string> = new Set<EndKind>(['exited', 'stopped', 'failed', 'lost']);
const STARTING_TASKS: ReadonlySet<string> = new Set(['none', 'argument', 'pending']);
const SANDBOX_STATES: ReadonlySet<string> = new Set<SandboxState>(['on', 'off', 'unavailable', 'unknown']);
const IGNORABLE: ReadonlySet<string> = new Set<Ignored>(['model', 'effort']);

function isEndKind(value: unknown): value is EndKind {
	return typeof value === 'string' && END_KINDS.has(value);
}

/** Whether `value` is a number an agent can have. */
function isId(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= FIRST_ID;
}

/** Whether `value` names who stopped an agent: an agent's number, or the person. */
function isStoppedBy(value: unknown): value is StoppedBy {
	return value === HUMAN || isId(value);
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
			// A line of version 4 has neither YOLO nor sandbox, its agents at full access, and model and effort always.
			const { id, name, creator, root, cli, custom, model, effort, ignored, worktree, folder, taskMessage, task, tokenHash } = value;
			const yolo = value.yolo ?? (value.v === 4 ? true : undefined);
			const sandbox = value.sandbox ?? (value.v === 4 ? 'unknown' : undefined);
			const integration = value.integration ?? (value.v === 4 ? true : undefined);
			if (!isId(id) || typeof name !== 'string' || !isAgentName(name) || (creator !== undefined && !isId(creator)) || (root !== undefined && !isId(root)) || !isText(cli)
				|| (custom !== undefined && typeof custom !== 'boolean') || (model !== undefined && !isText(model)) || (effort !== undefined && !isText(effort))
				|| (ignored !== undefined && !(Array.isArray(ignored) && ignored.every(each => typeof each === 'string' && IGNORABLE.has(each))))
				|| typeof yolo !== 'boolean' || typeof sandbox !== 'string' || !SANDBOX_STATES.has(sandbox) || typeof integration !== 'boolean'
				|| !isText(worktree) || !isText(folder) || (taskMessage !== undefined && !isId(taskMessage)) || typeof task !== 'string' || !STARTING_TASKS.has(task)
				|| typeof tokenHash !== 'string' || !TOKEN_HASH.test(tokenHash)) {
				return undefined;
			}
			return {
				type: 'agent.started', id, name, ...(creator !== undefined ? { creator } : {}), ...(root !== undefined ? { root } : {}), cli, ...(custom ? { custom } : {}),
				...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(Array.isArray(ignored) && ignored.length ? { ignored: ignored as Ignored[] } : {}),
				yolo, sandbox: sandbox as SandboxState, integration, worktree, folder, ...(taskMessage !== undefined ? { taskMessage } : {}), task: task as 'none' | 'argument' | 'pending', tokenHash
			};
		}
		case 'agent.launched': {
			const { id, processId } = value;
			return isId(id) && typeof processId === 'number' && Number.isInteger(processId) && processId > 0 ? { type: 'agent.launched', id, processId } : undefined;
		}
		case 'agent.connected':
		case 'task.typing':
		case 'task.typed':
		case 'agent.running':
			return isId(value.id) ? { type: value.type, id: value.id } : undefined;
		case 'agent.stopping': {
			const { id, by, reason } = value;
			return isId(id) && (by === undefined || isStoppedBy(by)) && typeof reason === 'string'
				? { type: 'agent.stopping', id, ...(by !== undefined ? { by } : {}), reason }
				: undefined;
		}
		case 'agent.ended': {
			const { id, kind, by, reason, exitCode } = value;
			return isId(id) && isEndKind(kind) && (by === undefined || isStoppedBy(by)) && typeof reason === 'string' && (exitCode === undefined || (typeof exitCode === 'number' && Number.isInteger(exitCode)))
				? { type: 'agent.ended', id, kind, ...(by !== undefined ? { by } : {}), reason, ...(exitCode !== undefined ? { exitCode } : {}) }
				: undefined;
		}
		case 'worktree.made': {
			const { name, folder, repository, commit, madeBy } = value;
			return isText(name) && isText(folder) && isText(repository) && isText(commit) && (madeBy === undefined || isId(madeBy))
				? { type: 'worktree.made', name, folder, repository, commit, ...(madeBy !== undefined ? { madeBy } : {}) }
				: undefined;
		}
		case 'worktree.gone': {
			const { folder } = value;
			return isText(folder) ? { type: 'worktree.gone', folder } : undefined;
		}
		case 'list.cleared':
			return { type: 'list.cleared' };
	}
	return undefined;
}

/**
 * Whether an event can follow the state the ledger gave so far: an agent starts under a number above
 * every one given, as the person's or as an agent's the list has; any other event of an agent is of one
 * the list has, and an agent that stops another is one it has; a worktree is made by the person or by
 * such an agent.
 */
export function fitsState(state: WorkspaceState, event: LedgerEvent): boolean {
	const known = (id: number | undefined) => id === undefined || state.agents.has(id);
	switch (event.type) {
		case 'agent.started':
			return event.id > state.lastId && known(event.creator) && (event.root === undefined || event.root === event.id || event.creator !== undefined);
		case 'agent.launched':
		case 'agent.connected':
		case 'task.typing':
		case 'task.typed':
		case 'agent.running':
			return state.agents.has(event.id);
		case 'agent.stopping':
		case 'agent.ended':
			return state.agents.has(event.id) && known(event.by === HUMAN ? undefined : event.by);
		case 'worktree.made':
			return known(event.madeBy);
		case 'worktree.gone':
		case 'list.cleared':
			return true;
	}
}

/** Applies one event to the state the ledger is replayed into. */
export function applyEvent(state: WorkspaceState, event: LedgerEvent): void {
	state.seq = event.seq;
	switch (event.type) {
		case 'agent.started': {
			// A root's tree is its own; a child's, its creator's, which a line of version 4 does not say.
			const root = event.root ?? (event.creator === undefined ? event.id : state.agents.get(event.creator)?.root ?? event.creator);
			state.agents.set(event.id, {
				id: event.id,
				name: event.name,
				...(event.creator !== undefined ? { creator: event.creator } : {}),
				root,
				cli: event.cli,
				custom: event.custom ?? false,
				...(event.model !== undefined ? { model: event.model } : {}),
				...(event.effort !== undefined ? { effort: event.effort } : {}),
				ignored: event.ignored ?? [],
				yolo: event.yolo,
				sandbox: event.sandbox,
				integration: event.integration,
				worktree: event.worktree,
				folder: event.folder,
				...(event.taskMessage !== undefined ? { taskMessage: event.taskMessage } : {}),
				task: event.task,
				connected: false,
				state: 'starting',
				startTime: event.time
			});
			state.lastId = Math.max(state.lastId, event.id);
			state.lastMessageId = Math.max(state.lastMessageId, event.taskMessage ?? 0);
			state.tokens.set(event.tokenHash, event.id);
			break;
		}
		case 'agent.launched': {
			const agent = state.agents.get(event.id);
			if (isLive(agent)) {
				agent.processId = event.processId;
			}
			break;
		}
		case 'agent.connected': {
			const agent = state.agents.get(event.id);
			if (isLive(agent)) {
				agent.connected = true;
			}
			break;
		}
		case 'task.typing': {
			const agent = state.agents.get(event.id);
			if (agent?.task === 'pending') {
				agent.task = 'unknown';
			}
			break;
		}
		case 'task.typed': {
			const agent = state.agents.get(event.id);
			if (agent?.task === 'pending' || agent?.task === 'unknown') {
				agent.task = 'typed';
			}
			break;
		}
		case 'agent.running': {
			const agent = state.agents.get(event.id);
			if (agent?.state === 'starting') {
				agent.state = 'running';
			}
			break;
		}
		case 'agent.stopping': {
			const agent = state.agents.get(event.id);
			if (agent?.state === 'starting' || agent?.state === 'running') {
				agent.state = 'stopping';
				agent.stopping = { ...(event.by !== undefined ? { by: event.by } : {}), reason: event.reason };
			}
			break;
		}
		case 'agent.ended': {
			const agent = state.agents.get(event.id);
			if (agent && agent.state !== 'ended') {
				agent.state = 'ended';
				agent.stopping = undefined;
				agent.end = { kind: event.kind, ...(event.by !== undefined ? { by: event.by } : {}), reason: event.reason, time: event.time, ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}) };
			}
			for (const [hash, id] of state.tokens) {
				if (id === event.id) {
					state.tokens.delete(hash);
				}
			}
			break;
		}
		case 'worktree.made': {
			const { name, folder, repository, commit, madeBy } = event;
			state.worktrees.set(folder, { name, folder, repository, commit, ...(madeBy !== undefined ? { madeBy } : {}) });
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
		case 'list.cleared': {
			// The agents that ended leave the list, but for the creators and roots of those it keeps: they name them.
			const creators = new Set([...state.agents.values()].filter(isLive).flatMap(agent => [agent.creator, agent.root]));
			for (const agent of [...state.agents.values()]) {
				if (!isLive(agent) && !creators.has(agent.id)) {
					state.agents.delete(agent.id);
				}
			}
			break;
		}
	}
}

/** Whether an agent has not ended: starting, running, or stopping. */
export function isLive(agent: Agent | undefined): agent is LiveAgent {
	return !!agent && agent.state !== 'ended';
}
