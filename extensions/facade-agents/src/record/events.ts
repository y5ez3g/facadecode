/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The person: the parent of the agents they start, with a token of their own. */
export const YOU = 'you';
/** Names no agent may take. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([YOU, 'facade', 'all', 'everyone', 'me']);

/**
 * WA-4.5:
 *
 * starting   started, not heard from yet
 * working    in a turn
 * waiting    at a question or a permission prompt in its terminal
 * idle       its turn ended; at its input box
 * stopped    its process ended, or it was stopped
 * failed     it could not start
 */
export type AgentState = 'starting' | 'working' | 'waiting' | 'idle' | 'stopped' | 'failed';

export interface Agent {
	readonly name: string;
	readonly incarnation: number;
	/** The CLI, as `claude`. */
	readonly cli: string;
	readonly model: string;
	/** Its worktree's name: `main` for a repository's own checkout, else its branch (WA-3.1). */
	readonly worktree: string;
	/** The worktree's folder, which it runs in. */
	readonly folder: string;
	/** Who started it: the person, or an agent's name (WA-4.3). */
	readonly parent: string;
	state: AgentState;
	stateDetail?: string;
	stateAt: number;
	readonly startedAt: number;
}

/**
 * What a workspace records of its agents (WORKTREE-AGENTS.md, section 10). Every change is an event
 * in the ledger first; the state is what replaying the ledger gives.
 */
export type LedgerEventBody =
	| {
		readonly type: 'agent.started';
		readonly name: string;
		readonly incarnation: number;
		readonly cli: string;
		readonly model: string;
		readonly worktree: string;
		readonly folder: string;
		readonly parent: string;
		readonly tokenHash: string;
	}
	| { readonly type: 'agent.state'; readonly name: string; readonly incarnation: number; readonly state: AgentState; readonly detail?: string };

export type LedgerEvent = LedgerEventBody & { readonly seq: number; readonly ts: number };

/** Who a call comes from. The person is `you`, incarnation 0. */
export interface Caller {
	readonly name: string;
	readonly incarnation: number;
}

export interface WorkspaceState {
	seq: number;
	/** Each name's latest incarnation. */
	readonly agents: Map<string, Agent>;
	/** A token's hash, to the incarnation it belongs to: the latest of each name only. */
	readonly tokens: Map<string, Caller>;
}

export function createState(): WorkspaceState {
	return { seq: 0, agents: new Map(), tokens: new Map() };
}

/** Applies one event of the ledger to the state it is replayed into. */
export function applyEvent(state: WorkspaceState, event: LedgerEvent): void {
	state.seq = event.seq;
	switch (event.type) {
		case 'agent.started': {
			// A new incarnation takes the name, and the one before is no longer heard (WA-4.4).
			for (const [hash, caller] of state.tokens) {
				if (caller.name === event.name) {
					state.tokens.delete(hash);
				}
			}
			state.agents.set(event.name, {
				name: event.name,
				incarnation: event.incarnation,
				cli: event.cli,
				model: event.model,
				worktree: event.worktree,
				folder: event.folder,
				parent: event.parent,
				state: 'starting',
				stateAt: event.ts,
				startedAt: event.ts
			});
			state.tokens.set(event.tokenHash, { name: event.name, incarnation: event.incarnation });
			break;
		}
		case 'agent.state': {
			const agent = state.agents.get(event.name);
			if (agent && agent.incarnation === event.incarnation) {
				agent.state = event.state;
				agent.stateDetail = event.detail;
				agent.stateAt = event.ts;
			}
			break;
		}
	}
}
