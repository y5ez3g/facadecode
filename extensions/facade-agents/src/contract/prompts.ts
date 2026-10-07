/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Facade } from '../core/facade';
import { Caller, describe, PERSON } from '../record/events';

const TOOLS = 'Your tools: start_agent starts a child agent and answers with its number once it is up; list_agents lists you, the agent that started you and the agents you started, each with its number and state; stop_agent stops one of your children.';

/** A CLI an agent can start children with, as the skill names it. */
export interface StartableCli {
	readonly id: string;
	readonly displayName: string;
}

/** An agent of a CLI, by the CLI's name, with its article: `a Coder agent`, `an Editor agent`. */
function anAgentOf(cliName: string): string {
	return `${/^[aeiou]/i.test(cliName) ? 'an' : 'a'} ${cliName} agent`;
}

/**
 * What an agent's MCP server tells the model as it starts: who it is, who started it, where it runs, and
 * what the tools do. Nothing about how to work: that is the skill's.
 */
export function instructionsFor(facade: Facade, caller: Caller): string {
	const agent = facade.agentOf(caller);
	if (!agent) {
		return ['You act as the person, @human, in Facade Code.', TOOLS].join('\n');
	}
	const starter = agent.creator === undefined ? undefined : facade.agent(agent.creator);
	return [
		`You are ${describe(agent)}, ${anAgentOf(facade.cliName(agent.cli))} in Facade Code, started by ${describe(starter ?? PERSON)}.`,
		`You run in ${agent.folder}: the worktree ${agent.worktree}. You are in that folder already: run commands there without cd.`,
		TOOLS
	].join('\n');
}

/**
 * What a new agent's first message says before its task: who it is and who started it, for a CLI
 * whose model may not see its MCP server's instructions.
 */
export function openingFor(agent: { readonly id: number; readonly name: string; readonly cliName: string }, creator: Caller): string {
	return `[facade] You are ${describe(agent)}, ${anAgentOf(agent.cliName)} in Facade Code, started by ${describe(creator)}. Your task:`;
}

/**
 * The `facade` skill every agent is handed at its launch: how Facade behaves - agents, who started them
 * and whom they started, the tools, the folder an agent runs in - and the CLIs this machine has to start children
 * with. Nothing about how to work: that is the person's to choose.
 */
export function facadeSkill(clis: readonly StartableCli[]): { readonly name: string; readonly description: string; readonly body: string } {
	const startable = clis.length
		? clis.map(cli => `\`${cli.id}\` (${cli.displayName})`).join(', ')
		: 'none, for no CLI Facade starts is installed';
	return {
		name: 'facade',
		description: 'How to work in Facade Code with your children and the person, through the facade tools start_agent, list_agents and stop_agent. Use it when you start children, look at what they are, or stop them.',
		body: [
			'# Working in Facade Code',
			'',
			'You are an agent in Facade Code: a coding agent CLI in its own terminal, in a folder of a git',
			'repository. Each agent has a name and a number, as @name #a7, the agent that started it, and the',
			'agents it starts. The person, @human, starts the first agents. Who started an agent never changes:',
			'when an agent ends, the agents it started run on.',
			'A number is Facade\'s own, not a process id: only the tools below take it. The person can see your',
			'terminal and type into it at any time: answer them there.',
			'',
			'## The tools',
			'',
			`- \`start_agent\` starts a child: \`cli\`, \`model\` and \`effort\` are required - on this machine ${startable} - and \`task\` is its task.`,
			'  Facade gives the model and the effort to the CLI as they are, as its own options take them, and no',
			'  CLI checks them as it starts: a child given a model its CLI does not have comes up all the same,',
			'  then fails at its first step, on its screen, or works on the CLI\'s own default model.',
			'  It works beside you, in your folder; in a worktree of your repository, by name; or with',
			'  `worktree: "new"` and a `name` in a worktree of its own, on a new branch of that name, starting',
			'  at your worktree\'s HEAD: commit what the child needs before you start it there. It answers once',
			'  the child is up, with its number.',
			'- `list_agents` lists you, the agent that started you and the agents you started: each one\'s',
			'  name and number, who started it, its state - starting, running, stopping, or ended, how and why -',
			'  its CLI, model and effort, and its worktree. With `all`, every agent of this window\'s list.',
			'- `stop_agent` stops one of your children, by its number, as #a7, or its @name. Its worktree stays.',
			'',
			'A name is a label, which several agents can have: where more than one running agent has it, name',
			'the one you mean by its number.',
			'',
			'## Your children',
			'',
			'- Facade tells you only what it knows for certain: whether a child is starting, running, stopping',
			'  or has ended, and how. Whether a running child works or is done, its worktree shows: the files there,',
			'  `git status` and `git log`.',
			'- Agents do not message each other yet: give a child a task it can finish on its own, and say',
			'  where its result should be - a file, or a commit on its branch.',
			'',
			'## Your folder',
			'',
			'- You run in your folder already: run commands there without `cd`.',
			'- Files Facade put in your folder for you are not yours to commit.'
		].join('\n')
	};
}
