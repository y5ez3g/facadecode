/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Facade } from '../core/facade';
import { agentRef, Caller, describe, PERSON } from '../record/events';

const TOOLS = 'Your tools: start_agent starts an agent, in any folder of this window or a new worktree, and answers with its number once it has started; list_agents lists you, the agent that started you and the agents you started - with all, every agent you reach - and the CLIs you can start; stop_agent stops an agent you reach, and can delete its worktree.';

/** What a call that got no answer means: said where every caller reads it, its server's instructions (N-21). */
const UNANSWERED = 'A call that got no answer - cut off, its server gone - may have happened all the same: look with list_agents before calling again.';

/**
 * That an agent started through `start_agent` asks in words, never with a pick: nobody may be watching it (L4). Said
 * where every such agent reads it - its server's instructions and its task notice - not in the skill alone, which a
 * CLI may never load. A pick waiting in its terminal would take what Facade types there as its answer: Muse Code's and
 * Antigravity's question tools are picks (N-44). The person's own agent keeps its question tool: theirs to answer.
 */
const NO_PICKS = 'Ask in words, in your own terminal - never with a tool that waits for someone to pick an answer: Facade types messages into your terminal, and a pick waiting there would take them as its answer.';

/** An agent of a CLI, by the CLI's name, with its article: `a Coder agent`, `an Editor agent`. */
function anAgentOf(cliName: string): string {
	return `${/^[aeiou]/i.test(cliName) ? 'an' : 'a'} ${cliName} agent`;
}

/**
 * What an agent's MCP server tells the model as it starts (AGENT-ORCHESTRATION.md, O7): who it is, who
 * started it, its tree, where it runs, its YOLO, and what the tools do. How to work is the skill's.
 */
export function instructionsFor(facade: Facade, caller: Caller): string {
	const agent = facade.agentOf(caller);
	if (!agent) {
		return ['You act as the person, @human, in Facade Code, and reach every agent of this window.', TOOLS, UNANSWERED].join('\n');
	}
	const starter = agent.creator === undefined ? undefined : facade.agent(agent.creator);
	return [
		`You are ${describe(agent)}, ${anAgentOf(facade.cliName(agent.cli))} in Facade Code, started by ${starter ? describe(starter) : agent.creator !== undefined ? agentRef(agent.creator) : describe(PERSON)}; your tree is ${agentRef(agent.root)}'s.`,
		`You run in ${agent.folder}${agent.outsideGit ? ', a folder in no Git repository' : `: the worktree ${agent.worktree}`}. You are in that folder already: run commands there without cd.`,
		agent.yolo
			? 'Your YOLO is on: you reach every agent of this window, and the agents you start have YOLO on.'
			: 'Your YOLO is off: you reach your own tree only, and the agents you start have YOLO off too. Facade\'s tools never need anyone\'s approval.',
		TOOLS,
		UNANSWERED,
		...agent.unattended ? [NO_PICKS] : []
	].join('\n');
}

/**
 * What a new agent's task notice says before where its task is: who it is and who started it, for a CLI
 * whose model may not see its MCP server's instructions.
 */
export function openingFor(agent: { readonly id: number; readonly name: string; readonly cliName: string }, creator: Caller): string {
	return `[facade] You are ${describe(agent)}, ${anAgentOf(agent.cliName)} in Facade Code, started by ${describe(creator)}. Ask in words, never with a tool that waits for someone to pick an answer.`;
}

/**
 * The `facade` skill every agent with Facade's tools is handed at its launch (AGENT-ORCHESTRATION.md,
 * O7): how Facade behaves, with short examples. The same for every agent, whatever is installed: a folder's
 * skill is shared by the agents there, and `list_agents` names the CLIs they can start. No workflow: when to
 * commit, merge, review or stop is the person's to say, in their own skills.
 */
export function facadeSkill(): { readonly name: string; readonly description: string; readonly body: string } {
	return {
		name: 'facade',
		description: 'How to work in Facade Code with other agents and the person, through the facade tools start_agent, list_agents and stop_agent. Use it when you start agents, look at them, or stop them.',
		body: [
			'# Working in Facade Code',
			'',
			'You are an agent in Facade Code: a coding agent CLI in its own terminal, in a folder of this window.',
			'Each agent has a name and a number, as @name #a7, the agent that started it, and a tree: the agent',
			'the person, @human, started, and every agent that comes from it. Who started an agent never changes:',
			'when an agent ends, the agents it started run on. A number is Facade\'s own, not a process id.',
			'The person can see your terminal and type into it at any time: answer them there.',
			'',
			'The agents you start with Facade are separate CLIs in terminals of their own, which the person sees -',
			'not the subagents your own CLI may have.',
			'',
			'## The tools',
			'',
			'- `start_agent` starts an agent: `name` and `cli` are required - `list_agents` names the CLIs you can start -',
			'  and `model`, `effort` and `task` are optional: left out, the CLI\'s own model and effort apply. A',
			'  task is kept as a message, and the agent is told where to read it. It works in your folder; in',
			'  another folder of this window, by its absolute path; in a worktree of your repository, by the branch',
			'  checked out in it; or, with `new_worktree`, in a worktree of its own on a new branch named after it.',
			'  A new worktree starts at your commit: uncommitted changes are not in it, so commit what it needs',
			'  first. It answers once the agent has started; if it has not within the timeout, that its start is',
			'  not confirmed - the agent stays starting: look at it with `list_agents`, or stop it, but do not start',
			'  it again.',
			'  Example: `start_agent(name: "lint", cli: "codex", task: "Fix the lint errors in src/", new_worktree: true)`.',
			'- `list_agents` lists you, the agent that started you and the agents you started; with `all`, every',
			'  agent you reach. Each with its state, CLI, model and effort, YOLO and sandbox, worktree and task\'s',
			'  message - and the CLIs you can start, with what each takes.',
			'- `stop_agent` stops an agent you reach, by its number, as #a7, or its @name. With',
			'  `delete_worktree`, the agents in its worktree are stopped too and the worktree is deleted, its branch',
			'  kept; uncommitted work refuses that unless you say `discard_changes`.',
			'',
			'Your YOLO decides your reach: on, every agent of this window; off, your own tree only. The agents you',
			'start take your YOLO. Facade\'s tools never ask anyone for approval.',
			'',
			'## Working together',
			'',
			'- Agents editing at the same time work in worktrees of their own.',
			'- Read a tool\'s answer before you call it again: a start, a stop or a deletion may have happened. A call that',
			'  got no answer - cut off, its server gone - may have happened all the same: look with `list_agents` first.',
			'- Started by another agent, or by a script, nobody may be watching your terminal: do not use tools that wait for',
			'  someone to pick an answer - ask in words, in your own terminal. The person\'s own agent, which they started from',
			'  the window, may put a question up for them.',
			'- Whether a running agent works or is done, its terminal and its worktree show: the files there,',
			'  `git status` and `git log`. Facade tells you only what it knows for certain.',
			'',
			'## Your folder',
			'',
			'- You run in your folder already: run commands there without `cd`.',
			'- Files Facade put in your folder for your CLI - its MCP server, its skills - are temporary and not',
			'  yours to commit.'
		].join('\n')
	};
}
