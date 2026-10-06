/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProcessRow } from '../core/facade';
import { YOU_PID } from '../record/events';
import { Args } from './args';
import type { ContractTool } from './tools';

/** A time as `ps` gives it: the time of day, on this machine's clock. */
function timeOfDay(time: number): string {
	return new Date(time).toTimeString().slice(0, 8);
}

/** One line of `ps`, as the model reads it. */
function line(row: ProcessRow, self: number): string {
	const parent = row.ppid === YOU_PID ? '1 (the person)' : String(row.ppid);
	const state = row.exit ? `exited at ${timeOfDay(row.exit.time)} (${row.exit.kind}: ${row.exit.reason})` : row.state;
	return `PID ${row.pid}${row.pid === self ? ' (you)' : ''}  @${row.name}  parent ${parent}  ${state}  ${row.cli} on ${row.model}${row.effort ? ` at ${row.effort}` : ''}  worktree ${row.worktree} at ${row.folder}  started ${timeOfDay(row.startTime)}`;
}

/**
 * `ps`: the process table as the caller sees it - itself, its parent and its children - or every
 * process the workspace has had. Facade says only what it knows for certain: whether a process is
 * starting, running or has exited, and how it exited; what it is doing, its terminal shows.
 */
export const psTool: ContractTool = {
	definition: {
		name: 'ps',
		title: 'List agents',
		description: 'Lists agents as processes: you, your parent and your children, those that exited too - with all, every agent this workspace has had. Each with its PID; its parent\'s PID, where 1 is the person, who takes in the children of an agent that exits; its state - starting, running, or exited, how and why; its CLI, model and effort; and its worktree. Whether a running agent works or waits is not Facade\'s to know: its worktree and its terminal show it.',
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
			text: rows.length ? rows.map(row => line(row, caller.pid)).join('\n') : 'No agents.',
			data: { processes: rows }
		};
	}
};
