/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentFacts, Facade, sandboxText, StartableCli } from '../core/facade';
import { clockOf, Mailbox } from '../core/mail';
import { agentRef, AgentState, describe, End, messageRef } from '../record/events';
import { Args } from './args';
import type { ContractTool } from './tools';
import { timeOfDay } from './words';

/** The states a summary counts, in its order. */
const STATES: readonly AgentState[] = ['starting', 'running', 'stopping', 'ended'];

/**
 * An agent's mailbox as its line gives it (AGENT-MESSAGES.md, M3): how many messages are unread, the oldest
 * ten of them, each with its sender and how long ago it came; how many it has fetched, and when it last
 * fetched; and its task. Not a guess at what it is doing: what it has not fetched, only.
 */
function mailboxText(mailbox: Mailbox, now: number): string {
	const unread = mailbox.unread.map(message => `${messageRef(message.id)} (from ${message.from}, ${Math.max(0, Math.floor((now - message.time) / 60_000))} min ago)`);
	return [
		unread.length ? `${unread.length + mailbox.more} unread: ${unread.join(', ')}${mailbox.more ? `, and ${mailbox.more} more` : ''}` : 'no unread messages',
		`${mailbox.fetched} fetched`,
		...(mailbox.lastFetched !== undefined ? [`last fetched at ${clockOf(mailbox.lastFetched)}`] : []),
		...(mailbox.task ? [`task ${messageRef(mailbox.task.id)} ${mailbox.task.state === 'delivered' ? 'fetched' : mailbox.task.state === 'returned' ? 'returned without being fetched before the run ended' : 'not yet fetched'}`] : [])
	].join('; ');
}

/** How an agent ended, as the model reads it: `stopped by @lead #a1: with stop_agent`, `exited: its CLI ended with exit code 1`. */
export function endText(facade: Facade, end: End): string {
	return `${end.kind}${end.by === undefined ? '' : ` by ${facade.whoIs(end.by)}`}: ${end.reason}`;
}

/** A model or an effort as the model reads it: as asked for, the CLI's own where none was, unknown where it was left out. */
function asked(value: string | undefined, ignored: boolean, what: string): string {
	return ignored ? `${what} unknown (${value} not applied)` : value ?? `CLI default ${what}`;
}

/**
 * An agent's facts as the model reads them: its CLI, model and effort, YOLO and sandbox, whether it is
 * connected to Facade, and its task's message (M7).
 */
export function factsText(facade: Facade, facts: AgentFacts): string {
	return [
		...facts.phase ? [`phase ${facts.phase}`] : [],
		`${facade.cliName(facts.cli)}${facts.custom ? ' (custom)' : ''}`,
		asked(facts.model, facts.ignored.includes('model'), 'model'),
		asked(facts.effort, facts.ignored.includes('effort'), 'effort'),
		`YOLO ${facts.yolo ? 'on' : 'off'}, ${sandboxText(facts.sandbox)}`,
		...facts.state === 'ended' ? [] : [!facts.integration ? 'Facade tools not configured' : facts.connected ? 'connected to Facade' : facts.state === 'starting' ? 'not yet connected to Facade' : 'disconnected from Facade: its MCP server is gone'],
		`folder ${facts.folder}`,
		facts.taskMessage !== undefined ? `task ${messageRef(facts.taskMessage)}` : 'no task'
	].join(', ');
}

/** One line of `list_agents`, as the model reads it; `self` is the caller's number, none for the person. */
function line(facade: Facade, row: AgentFacts, self: number | undefined, now: number): string {
	const state = row.end ? `ended at ${timeOfDay(row.end.time)} (${endText(facade, row.end)}${row.end.exitCode !== undefined ? `, exit code ${row.end.exitCode}` : ''})` : row.state;
	return `@${row.name} ${agentRef(row.id)}${row.id === self ? ' (you)' : ''}  creator ${facade.whoIs(row.creator)}  tree ${agentRef(row.root)}  ${state}  ${row.outsideGit ? `folder ${row.folder} (not a Git repository)` : `worktree ${row.worktree}`}${setupText(row.setup)}  started ${timeOfDay(row.startTime)}  ${factsText(facade, row)}${row.mailbox ? `  mailbox: ${mailboxText(row.mailbox, now)}` : ''}`;
}

/** How the setup of an agent's new worktree went, as its row says it, where one ran or should have (O11). */
function setupText(setup: AgentFacts['setup']): string {
	switch (setup) {
		case 'succeeded': return ', setup succeeded';
		case 'submitted': return ', setup submitted; completion unknown';
		case 'invalid': return ', setup file unreadable; setup did not run';
		default: return '';
	}
}

/** The line a list opens with: how many agents, and how many in each state - `3 agents: 1 starting, 2 running`. */
function summary(rows: readonly AgentFacts[]): string {
	const counts = STATES.map(state => [state, rows.filter(row => row.state === state).length] as const).filter(([, count]) => count > 0);
	return `${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}${counts.length ? `: ${counts.map(([state, count]) => `${count} ${state}`).join(', ')}` : ''}`;
}

/** A CLI an agent can start, as the model reads it: what its launch takes. */
function cliLine(cli: StartableCli): string {
	const takes = [cli.integration ? 'Facade tools' : '', cli.task ? 'task' : '', cli.model ? 'model' : '', cli.effort ? 'effort' : ''].filter(Boolean);
	return `${cli.id}${cli.custom ? ' (custom)' : ` (${cli.displayName})`}: supports ${takes.length ? takes.join(', ') : 'none of Facade tools, task, model, or effort'}`;
}

/**
 * `list_agents` (AGENT-ORCHESTRATION.md, O6): the agents as the caller sees them - itself, its creator and
 * the agents it started - or every agent it reaches, with the CLIs it can start. Facade says only what it
 * knows for certain: whether an agent is starting, running, stopping or has ended, and how it ended; what it
 * is doing, its terminal shows.
 */
export const listAgentsTool: ContractTool = {
	findsClis: true,
	definition: {
		name: 'list_agents',
		title: 'List agents',
		description: 'Inspect runs, delivery, and available CLIs. Defaults to you, your creator, and immediate children, including ended runs. all:true includes every reachable run: this window with YOLO on, your tree with YOLO off. Includes identity/tree, lifecycle/exit, CLI/options, YOLO/sandbox, connection, location/setup, timestamps, and mailbox history. Running does not prove activity or completion; check reports and work evidence.',
		inputSchema: {
			type: 'object',
			properties: {
				all: { type: 'boolean', default: false, description: 'Include every reachable run.' }
			},
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('list_agents', ['all?'], input);
		const all = args.boolean('all') ?? false;
		const listed = facade.listAgents(caller, all);
		const now = Date.now();
		const who = caller.id === undefined
			? 'You are @human and can reach every agent in this window.'
			: `You are ${describe(caller)}. YOLO ${listed.yolo ? 'on: you can reach every agent in this window' : 'off: you can reach only your own tree'}.`;
		return {
			text: [
				who,
				listed.agents.length ? summary(listed.agents) : 'No agents in this selection.',
				...listed.agents.map(row => line(facade, row, caller.id, now)),
				`CLIs you can start: ${listed.clis.length ? listed.clis.map(cliLine).join('; ') : 'none on this machine'}.`
			].join('\n'),
			// Who asks and what it reaches, and how many in each state: as data, as the text says them (O6)
			data: {
				caller: caller.id === undefined ? { name: 'human' } : { id: caller.id, name: caller.name },
				reach: caller.id === undefined || listed.yolo ? 'window' : 'tree',
				counts: Object.fromEntries(STATES.map(state => [state, listed.agents.filter(row => row.state === state).length])),
				...listed,
				all
			}
		};
	}
};
