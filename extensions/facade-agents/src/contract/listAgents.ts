/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentFacts, Facade, sandboxText, StartableCli } from '../core/facade';
import { agentRef, AgentState, describe, End, messageRef } from '../record/events';
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

/** A model or an effort as the model reads it: as asked for, the CLI's own where none was, unknown where it was left out. */
function asked(value: string | undefined, ignored: boolean, what: string): string {
	return ignored ? `${what} unknown (${value} not applied)` : value ?? `its own ${what}`;
}

/**
 * An agent's facts as the model reads them: its CLI, model and effort, YOLO and sandbox, whether it is
 * connected to Facade, and its task's message.
 */
export function factsText(facade: Facade, facts: AgentFacts): string {
	return [
		...facts.phase ? [`phase ${facts.phase}`] : [],
		`${facade.cliName(facts.cli)}${facts.custom ? ' (custom)' : ''}`,
		asked(facts.model, facts.ignored.includes('model'), 'model'),
		asked(facts.effort, facts.ignored.includes('effort'), 'effort'),
		`YOLO ${facts.yolo ? 'on' : 'off'}, ${sandboxText(facts.sandbox)}`,
		...facts.state === 'ended' ? [] : [!facts.integration ? 'no Facade tools' : facts.connected ? 'connected' : facts.state === 'starting' ? 'not connected yet' : 'not connected: its MCP server is gone'],
		`in ${facts.folder}`,
		facts.taskMessage !== undefined ? `task ${messageRef(facts.taskMessage)} (${facts.task})` : 'no task'
	].join(', ');
}

/** One line of `list_agents`, as the model reads it; `self` is the caller's number, none for the person. */
function line(facade: Facade, row: AgentFacts, self: number | undefined): string {
	const state = row.end ? `ended at ${timeOfDay(row.end.time)} (${endText(facade, row.end)}${row.end.exitCode !== undefined ? `, exit code ${row.end.exitCode}` : ''})` : row.state;
	return `@${row.name} ${agentRef(row.id)}${row.id === self ? ' (you)' : ''}  by ${facade.whoIs(row.creator)}  tree ${agentRef(row.root)}  ${state}  ${row.outsideGit ? `folder ${row.folder} (in no Git repository)` : `worktree ${row.worktree}`}  started ${timeOfDay(row.startTime)}  ${factsText(facade, row)}`;
}

/** The line a list opens with: how many agents, and how many in each state - `3 agents: 1 starting, 2 running`. */
function summary(rows: readonly AgentFacts[]): string {
	const counts = STATES.map(state => [state, rows.filter(row => row.state === state).length] as const).filter(([, count]) => count > 0);
	return `${rows.length} ${rows.length === 1 ? 'agent' : 'agents'}${counts.length ? `: ${counts.map(([state, count]) => `${count} ${state}`).join(', ')}` : ''}`;
}

/** A CLI an agent can start, as the model reads it: what its launch takes. */
function cliLine(cli: StartableCli): string {
	const takes = [cli.integration ? 'Facade tools' : '', cli.task ? 'a task' : '', cli.model ? 'a model' : '', cli.effort ? 'an effort' : ''].filter(Boolean);
	return `${cli.id}${cli.custom ? ' (custom)' : ` (${cli.displayName})`}: takes ${takes.length ? takes.join(', ') : 'none of Facade tools, a task, a model or an effort'}`;
}

/**
 * `list_agents` (AGENT-ORCHESTRATION.md, O6): the agents as the caller sees them - itself, its creator and
 * the agents it started - or every agent it reaches, with the CLIs it can start. Facade says only what it
 * knows for certain: whether an agent is starting, running, stopping or has ended, and how it ended; what it
 * is doing, its terminal shows.
 */
export const listAgentsTool: ContractTool = {
	definition: {
		name: 'list_agents',
		title: 'List agents',
		description: 'Lists agents: you, the agent that started you, and the agents you started, those that ended too - with all, every agent you reach: every agent of this window with your YOLO on, your own tree with it off. First who you are and how many there are in each state, then each with its name and number, as @name #a7; who started it, an agent or @human, and its tree; its state - starting, running, stopping, or ended, how, by whom and with what exit code; its CLI, model and effort; its YOLO and sandbox; whether it is connected to Facade; its worktree; and its task\'s message. Then the CLIs you can start, and what each takes. Whether a running agent works or waits is not Facade\'s to know: its worktree and its terminal show it.',
		inputSchema: {
			type: 'object',
			properties: {
				all: { type: 'boolean', description: 'Every agent you reach.' }
			},
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('list_agents', ['all?'], input);
		const all = args.boolean('all') ?? false;
		const listed = facade.listAgents(caller, all);
		const who = caller.id === undefined
			? 'You are @human, and reach every agent.'
			: `You are ${describe(caller)}, YOLO ${listed.yolo ? 'on: you reach every agent of this window' : 'off: you reach your own tree'}.`;
		return {
			text: [
				who,
				listed.agents.length ? summary(listed.agents) : 'No agents.',
				...listed.agents.map(row => line(facade, row, caller.id)),
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
