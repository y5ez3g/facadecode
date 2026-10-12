/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualPath } from '../base/files';
import { JsonObject } from '../base/json';
import { applyMessages, clearMailboxes, createMessagesState, FACADE, fitsMessages, HUMAN, messageBodyOf, MessageEventBody, MessagesState } from './messages';
/** The first number an agent gets; numbers then count up and are never given twice within a workspace. */
const FIRST_ID = 1;
/** Names an agent cannot take: the person's, Facade's, and words a model reads as someone else. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([HUMAN, 'you', 'me', FACADE, 'all', 'everyone', 'init', 'kernel']);
/** The letter of an agent's number, as Facade writes it: `#a7`. Each kind of number has its own, as a message's, `#m7`. */
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
 * `starting` from its launch until it has started - its MCP server said hello, or, launched without Facade's
 * integration, its process runs - `running` from then on, `stopping` once Facade set out to stop it, until its
 * process ended, and `ended` once its process ended. Its task is a message, which it fetches itself
 * (AGENT-MESSAGES.md, M7): that it has started says nothing of its task.
 */
export type AgentState = 'starting' | 'running' | 'stopping' | 'ended';

/** How an agent ended: its CLI ended by itself, it was stopped, it did not start, or nothing saw it end. */
export type EndKind = 'exited' | 'stopped' | 'failed' | 'lost';

/**
 * Where a start is, once it is accepted (AGENT-ORCHESTRATION.md, O4): its worktree being made, its
 * worktree's setup running, its CLI being launched, or its CLI running and its MCP server not connected yet.
 */
export type StartPhase = 'creating_worktree' | 'running_setup' | 'launching_cli' | 'connecting';

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
	/**
	 * Whether it was started through `start_agent` - by an agent, or the person's scripts - where nobody may be
	 * watching it, not by the person from the window (AGENT-LAUNCHER.md, L4); none in a ledger from before.
	 */
	readonly unattended?: true;
	/** Its sandbox, as its launch left it. */
	readonly sandbox: SandboxState;
	/** Whether it was launched with the agent framework's integration: Facade's server, skills and files. */
	readonly integration: boolean;
	/** The name of its worktree: its branch, or the folder's own name outside a repository. */
	readonly worktree: string;
	/** Whether it runs in a folder of no Git repository: it has no worktree or branch, `worktree` being the folder's name (N-05). */
	readonly outsideGit?: true;
	/** Where it runs: for a new worktree, the folder planned for it until the worktree is made - then where it was made. */
	folder: string;
	/**
	 * Where its start is, while it is starting (AGENT-ORCHESTRATION.md, O4) - and, stopped or ended before it
	 * started, where it got to; none once it started, and none before phases were recorded.
	 */
	phase?: StartPhase;
	/** Whether its MCP server said hello to Facade. */
	connected: boolean;
	/** Its CLI's process, once its terminal runs it. */
	processId?: number;
	/** When its CLI's process was launched: by which it is told from another that got its id since. */
	launchTime?: number;
	state: AgentState;
	/** Who set out to stop it, and why, while it is stopping. */
	stopping?: { readonly by?: StoppedBy; readonly reason: string };
	end?: End;
	readonly startTime: number;
	/** When it started: its MCP server said hello, or - without Facade's integration - its process ran. */
	runningTime?: number;
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
		readonly unattended?: true;
		readonly sandbox: SandboxState;
		readonly integration: boolean;
		readonly worktree: string;
		readonly outsideGit?: true;
		readonly folder: string;
		readonly tokenHash: string;
		/** A ledger of version 5's: the number of its task's message, then kept in a file of its own. */
		readonly taskMessage?: number;
		/** Where its start begins: making its worktree, or launching its CLI; none in a ledger from before phases. */
		readonly phase?: StartPhase;
	}
	/** Its start moved on: to the phase it is in now, and - its worktree made - the folder it was made in. */
	| { readonly type: 'agent.phase'; readonly id: number; readonly phase: StartPhase; readonly folder?: string }
	| { readonly type: 'agent.launched'; readonly id: number; readonly processId: number }
	| { readonly type: 'agent.connected' | 'agent.running'; readonly id: number }
	/**
	 * A ledger of version 5: the notice of a task kept in a file of its own being typed into the agent's terminal,
	 * and typed. Nothing now: a task is a message (AGENT-MESSAGES.md, M7).
	 */
	| { readonly type: 'task.typing' | 'task.typed'; readonly id: number }
	| { readonly type: 'agent.stopping'; readonly id: number; readonly by?: StoppedBy; readonly reason: string }
	| { readonly type: 'agent.ended'; readonly id: number; readonly kind: EndKind; readonly by?: StoppedBy; readonly reason: string; readonly exitCode?: number }
	| { readonly type: 'worktree.made' } & MadeWorktree
	| { readonly type: 'worktree.gone'; readonly folder: string }
	/** A start of the window that is not a reload: the agents that ended leave the list, and their mailboxes are emptied. */
	| { readonly type: 'list.cleared' }
	| MessageEventBody;

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

/**
 * Who an agent was, kept after it left the list: its name, its tree's root and its worktree, by which the chat
 * rooms name the messages of the agents that ended before the window last started (AGENT-MESSAGES.md, M9).
 */
export interface AgentIdentity {
	readonly id: number;
	readonly name: string;
	readonly root: number;
	readonly worktree: string;
}

/** Whether `text` names the person, as a tool may: `@human`, or `human`. */
export function namesThePerson(text: string): boolean {
	const reference = parseAgentReference(text);
	return reference.kind === 'name' && reference.name === HUMAN;
}

/** What a workspace's ledger says now. */
export interface WorkspaceState {
	seq: number;
	/** The highest number given so far. */
	lastId: number;
	/** The agents of the list, by number: every agent since the window last started, and those the ones running name. */
	readonly agents: Map<number, Agent>;
	/** Every agent the workspace's ledger started, by number: those that left the list too. */
	readonly identities: Map<number, AgentIdentity>;
	/** The numbers of the agents that have not exited, by the hashes of their tokens. */
	readonly tokens: Map<string, number>;
	/** The worktrees Facade made, by folder. */
	readonly worktrees: Map<string, MadeWorktree>;
	/** The messages, and the mailboxes (AGENT-MESSAGES.md). */
	readonly mail: MessagesState;
}

/** The state of a workspace with no ledger yet: no agent and no message, the next numbers the first. */
export function createState(): WorkspaceState {
	return { seq: 0, lastId: FIRST_ID - 1, agents: new Map(), identities: new Map(), tokens: new Map(), worktrees: new Map(), mail: createMessagesState() };
}

const END_KINDS: ReadonlySet<string> = new Set<EndKind>(['exited', 'stopped', 'failed', 'lost']);
/** How a line of version 5 says the notice of an agent's task reached it. */
const STARTING_TASKS: ReadonlySet<string> = new Set(['none', 'argument', 'pending']);
const SANDBOX_STATES: ReadonlySet<string> = new Set<SandboxState>(['on', 'off', 'unavailable', 'unknown']);
const START_PHASES: ReadonlySet<string> = new Set<StartPhase>(['creating_worktree', 'running_setup', 'launching_cli', 'connecting']);
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
			// One of version 5 says how the notice of its task reached it, and the number of its task's message, kept
			// in a file of its own: the number is given no more, and the rest is nothing now (AGENT-MESSAGES.md, M7).
			const { id, name, creator, root, cli, custom, model, effort, ignored, unattended, worktree, outsideGit, folder, taskMessage, task, tokenHash, phase } = value;
			const yolo = value.yolo ?? (value.v === 4 ? true : undefined);
			const sandbox = value.sandbox ?? (value.v === 4 ? 'unknown' : undefined);
			const integration = value.integration ?? (value.v === 4 ? true : undefined);
			if (!isId(id) || typeof name !== 'string' || !isAgentName(name) || (creator !== undefined && !isId(creator)) || (root !== undefined && !isId(root)) || !isText(cli)
				|| (custom !== undefined && typeof custom !== 'boolean') || (model !== undefined && !isText(model)) || (effort !== undefined && !isText(effort))
				|| (ignored !== undefined && !(Array.isArray(ignored) && ignored.every(each => typeof each === 'string' && IGNORABLE.has(each))))
				|| typeof yolo !== 'boolean' || (unattended !== undefined && unattended !== true) || typeof sandbox !== 'string' || !SANDBOX_STATES.has(sandbox) || typeof integration !== 'boolean'
				|| typeof worktree !== 'string' || (outsideGit !== undefined && outsideGit !== true) || !isText(folder) || (taskMessage !== undefined && !isId(taskMessage)) || (task !== undefined && (typeof task !== 'string' || !STARTING_TASKS.has(task)))
				|| typeof tokenHash !== 'string' || !TOKEN_HASH.test(tokenHash) || (phase !== undefined && (typeof phase !== 'string' || !START_PHASES.has(phase)))) {
				return undefined;
			}
			return {
				type: 'agent.started', id, name, ...(creator !== undefined ? { creator } : {}), ...(root !== undefined ? { root } : {}), cli, ...(custom ? { custom } : {}),
				...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(Array.isArray(ignored) && ignored.length ? { ignored: ignored as Ignored[] } : {}),
				yolo, ...(unattended ? { unattended } : {}), sandbox: sandbox as SandboxState, integration, worktree, ...(outsideGit ? { outsideGit } : {}), folder, tokenHash,
				...(phase !== undefined ? { phase: phase as StartPhase } : {}),
				...(taskMessage !== undefined ? { taskMessage } : {})
			};
		}
		case 'agent.phase': {
			const { id, phase, folder } = value;
			return isId(id) && typeof phase === 'string' && START_PHASES.has(phase) && (folder === undefined || isText(folder))
				? { type: 'agent.phase', id, phase: phase as StartPhase, ...(folder !== undefined ? { folder } : {}) }
				: undefined;
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
	return messageBodyOf(value);
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
		case 'agent.phase':
			return state.agents.has(event.id);
		case 'agent.stopping':
		case 'agent.ended':
			// Who stopped it is a number given before - the list may have dropped that agent since (X-13)
			return state.agents.has(event.id) && (event.by === undefined || event.by === HUMAN || event.by <= state.lastId);
		case 'worktree.made':
			return known(event.madeBy);
		case 'worktree.gone':
		case 'list.cleared':
			return true;
		default:
			return fitsMessages(state.agents, state.mail, event);
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
				...(event.unattended ? { unattended: event.unattended } : {}),
				sandbox: event.sandbox,
				integration: event.integration,
				worktree: event.worktree,
				...(event.outsideGit ? { outsideGit: event.outsideGit } : {}),
				folder: event.folder,
				connected: false,
				state: 'starting',
				...(event.phase !== undefined ? { phase: event.phase } : {}),
				startTime: event.time
			});
			state.lastId = Math.max(state.lastId, event.id);
			state.identities.set(event.id, { id: event.id, name: event.name, root, worktree: event.worktree || event.folder });
			// A task's message of a ledger of version 5: its number is given no more
			if (event.taskMessage !== undefined) {
				state.mail.lastMessage = Math.max(state.mail.lastMessage, event.taskMessage);
			}
			state.tokens.set(event.tokenHash, event.id);
			break;
		}
		case 'agent.launched': {
			const agent = state.agents.get(event.id);
			if (isLive(agent)) {
				agent.processId = event.processId;
				agent.launchTime = event.time;
				if (agent.state === 'starting') {
					agent.phase = 'connecting';
				}
			}
			break;
		}
		case 'agent.phase': {
			const agent = state.agents.get(event.id);
			if (agent?.state === 'starting') {
				agent.phase = event.phase;
				if (event.folder !== undefined) {
					agent.folder = event.folder;
				}
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
		case 'task.typing':
		case 'task.typed':
			break;
		case 'agent.running': {
			const agent = state.agents.get(event.id);
			if (agent?.state === 'starting') {
				agent.state = 'running';
				agent.phase = undefined;
				agent.runningTime = event.time;
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
			// The mailboxes of the agents that ended are emptied: their messages are in the chat rooms only (M10)
			clearMailboxes(state.mail, id => isLive(state.agents.get(id)));
			// The agents that ended leave the list, but for those that name the ones it keeps: each one's whole
			// chain of creators, up to its root - not its creator alone, whose own would be a bare number (X-26).
			const named = new Set<number>();
			for (const agent of [...state.agents.values()].filter(isLive)) {
				named.add(agent.root);
				for (let id = agent.creator; id !== undefined && !named.has(id); id = state.agents.get(id)?.creator) {
					named.add(id);
				}
			}
			for (const agent of [...state.agents.values()]) {
				if (!isLive(agent) && !named.has(agent.id)) {
					state.agents.delete(agent.id);
				}
			}
			break;
		}
		default:
			applyMessages(state.mail, event, event.time);
	}
}

/** Whether an agent has not ended: starting, running, or stopping. */
export function isLive(agent: Agent | undefined): agent is LiveAgent {
	return !!agent && agent.state !== 'ended';
}
