/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentRow } from '../core/facade';
import { Args } from './args';
import type { ContractTool } from './tools';
import { timeOfDay } from './words';

/** One line of `ps`, as the model reads it; `self` is the caller's number, none for the person. */
function line(row: AgentRow, self: number | undefined): string {
	const parent = row.parent === undefined ? 'the person' : `#${row.parent}`;
	const state = row.exit ? `exited at ${timeOfDay(row.exit.time)} (${row.exit.kind}: ${row.exit.reason})` : row.state;
	return `@${row.name} #${row.id}${row.id === self ? ' (you)' : ''}  parent ${parent}  ${state}  ${row.cli} on ${row.model} at ${row.effort}  worktree ${row.worktree} at ${row.folder}  started ${timeOfDay(row.startTime)}`;
}

/**
 * `ps`: the agents as the caller sees them - itself, its parent and its children - or every agent the
 * workspace has had. Facade says only what it knows for certain: whether an agent is starting, running
 * or has exited, and how it exited; what it is doing, its terminal shows.
 */
export const psTool: ContractTool = {
	definition: {
		name: 'ps',
		title: 'List agents',
		description: 'Lists agents: you, your parent and your children, those that exited too - with all, every agent this workspace has had. Each with its name and number, as @name #7; its parent\'s number, or the person, who takes in the children of an agent that exits; its state - starting, running, or exited, how and why; its CLI, model and effort; and its worktree. Whether a running agent works or waits is not Facade\'s to know: its worktree and its terminal show it.',
		inputSchema: {
			type: 'object',
			properties: {
				all: { type: 'boolean', description: 'Every agent this workspace has had.' }
			},
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('ps', ['all?'], input);
		const rows = facade.ps(caller, args.boolean('all') ?? false);
		return {
			text: rows.length ? rows.map(row => line(row, caller.id)).join('\n') : 'No agents.',
			data: { agents: rows }
		};
	}
};
