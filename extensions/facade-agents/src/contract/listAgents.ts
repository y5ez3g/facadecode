/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentRow } from '../core/facade';
import { agentRef, End } from '../record/events';
import { Args } from './args';
import type { ContractTool } from './tools';

/** A time as `list_agents` gives it: the time of day, on this machine's clock. */
function timeOfDay(time: number): string {
	return new Date(time).toTimeString().slice(0, 8);
}

/** How an agent ended, as the model reads it: `stopped by #a1: with stop_agent`, `exited: its CLI ended`. */
export function endText(end: End): string {
	const by = end.by === undefined ? '' : end.by === 'human' ? ' by @human' : ` by ${agentRef(end.by)}`;
	return `${end.kind}${by}: ${end.reason}`;
}

/** One line of `list_agents`, as the model reads it; `self` is the caller's number, none for the person. */
function line(row: AgentRow, self: number | undefined): string {
	const creator = row.creator === undefined ? '@human' : agentRef(row.creator);
	const state = row.end ? `ended at ${timeOfDay(row.end.time)} (${endText(row.end)})` : row.state;
	return `@${row.name} ${agentRef(row.id)}${row.id === self ? ' (you)' : ''}  by ${creator}  ${state}  ${row.cli} on ${row.model} at ${row.effort}  worktree ${row.worktree} at ${row.folder}  started ${timeOfDay(row.startTime)}`;
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
		description: 'Lists agents: you, the agent that started you, and the agents you started, those that ended too - with all, every agent of this window\'s list. Each with its name and number, as @name #a7; who started it - an agent\'s number, or @human; its state - starting, running, stopping, or ended, how and why; its CLI, model and effort; and its worktree. Whether a running agent works or waits is not Facade\'s to know: its worktree and its terminal show it.',
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
			text: rows.length ? rows.map(row => line(row, caller.id)).join('\n') : 'No agents.',
			data: { agents: rows }
		};
	}
};
