/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentRow, Facade } from '../core/facade';
import { agentRef, AgentState, End } from '../record/events';
import { Args } from './args';
import type { ContractTool } from './tools';

/** The states a summary counts, in its order. */
const STATES: readonly AgentState[] = ['starting', 'running', 'stopping', 'ended'];

/** A time as `list_agents` gives it: the time of day, on this machine's clock. */
function timeOfDay(time: number): string {
	return new Date(time).toTimeString().slice(0, 8);
}

/** How an agent ended, as the model reads it: `stopped by @lead #a1: with stop_agent`, `exited: its CLI ended with exit code 1`. */
export function endText(facade: Facade, end: End): string {
	return `${end.kind}${end.by === undefined ? '' : ` by ${facade.whoIs(end.by)}`}: ${end.reason}`;
}

/** One line of `list_agents`, as the model reads it; `self` is the caller's number, none for the person. */
function line(facade: Facade, row: AgentRow, self: number | undefined): string {
	const state = row.end ? `ended at ${timeOfDay(row.end.time)} (${endText(facade, row.end)})` : row.state;
	return `@${row.name} ${agentRef(row.id)}${row.id === self ? ' (you)' : ''}  by ${facade.whoIs(row.creator)}  ${state}  ${row.cli} ${row.model} ${row.effort}  worktree ${row.worktree} at ${row.folder}  started ${timeOfDay(row.startTime)}  task ${row.task}`;
}

/** The line a list opens with: how many agents, and how many in each state - `3 agents: 1 starting, 2 running`. */
function summary(rows: readonly AgentRow[]): string {
	const counts = STATES.map(state => [state, rows.filter(row => row.state === state).length] as const).filter(([, count]) => count > 0);
	return `${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}: ${counts.map(([state, count]) => `${count} ${state}`).join(', ')}`;
}

/**
 * `list_agents`: the agents as the caller sees them - itself, its creator and the agents it started - or
 * every agent of the list. Facade says only what it knows for certain: whether an agent is starting,
 * running, stopping or has ended, and how it ended; what it is doing, its terminal shows.
 */
export const listAgentsTool: ContractTool = {
	definition: {
		name: 'list_agents',
		title: 'List agents',
		description: 'Lists agents: you, the agent that started you, and the agents you started, those that ended too - with all, every agent of this window\'s list. First how many there are in each state, then each with its name and number, as @name #a7; who started it - an agent, or @human; its state - starting, running, stopping, or ended, how and why; its CLI, model and effort; its worktree; and how its task reached it. Whether a running agent works or waits is not Facade\'s to know: its worktree and its terminal show it.',
		inputSchema: {
			type: 'object',
			properties: {
				all: { type: 'boolean', description: 'Every agent of this window\'s list.' }
			},
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('list_agents', ['all?'], input);
		const rows = facade.listAgents(caller, args.boolean('all') ?? false);
		return {
			text: rows.length ? [summary(rows), ...rows.map(row => line(facade, row, caller.id))].join('\n') : 'No agents.',
			data: { agents: rows }
		};
	}
};
