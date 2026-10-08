/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentRow } from '../core/facade';
import { clockOf, Mailbox } from '../core/mail';
import { Args } from './args';
import type { ContractTool } from './tools';

/** A time as `ps` gives it: the time of day, on this machine's clock. */
function timeOfDay(time: number): string {
	return new Date(time).toTimeString().slice(0, 8);
}

/**
 * An agent's mailbox as its line gives it: how many messages are unread, the oldest ten of them, each
 * with its sender and how long ago it came; how many it has fetched, and when it last fetched; and its
 * task. Nothing of an agent out of the caller's reach.
 */
function mailboxText(mailbox: Mailbox | undefined, now: number): string {
	if (!mailbox) {
		return 'out of your reach';
	}
	const unread = mailbox.unread.map(message => `#m${message.id} (${message.from}, ${Math.max(0, Math.floor((now - message.time) / 60_000))} min)`);
	return [
		unread.length ? `${unread.length + mailbox.more} unread: ${unread.join(', ')}${mailbox.more ? `, and ${mailbox.more} more` : ''}` : 'nothing unread',
		`${mailbox.fetched} fetched`,
		...(mailbox.lastFetched !== undefined ? [`last fetch ${clockOf(mailbox.lastFetched)}`] : []),
		...(mailbox.task ? [`task #m${mailbox.task.id} ${mailbox.task.state === 'delivered' ? 'fetched' : mailbox.task.state === 'returned' ? 'not fetched before it ended' : 'not fetched yet'}`] : [])
	].join('; ');
}

/** One line of `ps`, as the model reads it; `self` is the caller's number, none for the person. */
function line(row: AgentRow & { readonly mailbox: Mailbox | undefined }, self: number | undefined, now: number): string {
	const parent = row.parent === undefined ? 'the person' : `#a${row.parent}`;
	const state = row.exit ? `exited at ${timeOfDay(row.exit.time)} (${row.exit.kind}: ${row.exit.reason})` : row.state;
	return `@${row.name} #a${row.id}${row.id === self ? ' (you)' : ''}  parent ${parent}  ${state}  ${row.cli} on ${row.model} at ${row.effort}  worktree ${row.worktree} at ${row.folder}  started ${timeOfDay(row.startTime)}  mailbox: ${mailboxText(row.mailbox, now)}`;
}

/**
 * `ps`: the agents as the caller sees them - itself, its parent and its children - or every agent the
 * workspace has had. Facade says only what it knows for certain: whether an agent is starting, running
 * or has exited, how it exited, and what it has not fetched; what it is doing, its terminal shows.
 */
export const psTool: ContractTool = {
	definition: {
		name: 'ps',
		title: 'List agents',
		description: 'Lists agents: you, your parent and your children, those that exited too - with all, every agent this workspace has had. Each with its name and number, as @name #a7; its parent\'s number, or the person, who takes in the children of an agent that exits; its state - starting, running, or exited, how and why; its CLI, model and effort; its worktree; and its mailbox: the messages it has not fetched, how many it has fetched, when it last fetched, and whether it has fetched its task - whether it has your message. Whether a running agent works or waits is not Facade\'s to know: its worktree and its terminal show it.',
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
		const now = Date.now();
		// An agent whose YOLO is off sees its own tree only
		const rows = facade.ps(caller, args.boolean('all') ?? false)
			.filter(row => facade.mail.inReach(caller, row.id))
			.map(row => ({ ...row, mailbox: facade.mail.mailboxOf(row.id, caller) }));
		return {
			text: rows.length ? rows.map(row => line(row, caller.id, now)).join('\n') : 'No agents.',
			data: { agents: rows }
		};
	}
};
