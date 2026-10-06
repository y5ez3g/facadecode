/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Facade } from '../core/facade';
import { Caller, YOU_PID } from '../record/events';

/** How many of a CLI's models the skill and `spawn` name. */
export const MODELS_NAMED = 3;

const TOOLS = 'Your tools: spawn starts a child agent and answers with its PID once it is up; ps lists you, your parent and your children, each with its PID and state; kill ends one of your children.';

/** A CLI an agent can start children with, as the skill names it: its likeliest models first. */
export interface StartableCli {
	readonly id: string;
	readonly displayName: string;
	readonly models: readonly string[];
}

/** A few choices as a sentence lists them: `a`, `a or b`, `a, b or c`. */
export function orList(choices: readonly string[]): string {
	return choices.length > 1 ? `${choices.slice(0, -1).join(', ')} or ${choices[choices.length - 1]}` : choices.join('');
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
	const process = facade.processOf(caller);
	if (!process) {
		return ['You act as the person, @you, PID 1, in Facade Code.', TOOLS].join('\n');
	}
	const spawner = process.ppid === YOU_PID ? undefined : facade.process(process.ppid);
	return [
		`You are @${process.name}, PID ${process.pid}, ${anAgentOf(facade.cliName(process.cli))} in Facade Code, started by ${spawner ? `@${spawner.name} (PID ${spawner.pid})` : 'the person, @you (PID 1)'}.`,
		`You run in ${process.folder}: the worktree ${process.worktree}. You are in that folder already: run commands there without cd.`,
		TOOLS
	].join('\n');
}

/**
 * What a new process's first message says before its task: who it is and who started it, for a CLI
 * whose model may not see its MCP server's instructions.
 */
export function openingFor(process: { readonly pid: number; readonly name: string; readonly cliName: string }, parent: Caller): string {
	const by = parent.pid === YOU_PID ? 'the person, @you (PID 1)' : `@${parent.name} (PID ${parent.pid})`;
	return `[facade] You are @${process.name}, PID ${process.pid}, ${anAgentOf(process.cliName)} in Facade Code, started by ${by}. Your task:`;
}

/**
 * The `facade` skill every agent is handed at its launch: how Facade behaves - agents as processes, the
 * tools, the folder an agent runs in - and the CLIs this machine has to start children with. Nothing
 * about how to work: that is the person's to choose.
 */
export function facadeSkill(clis: readonly StartableCli[]): { readonly name: string; readonly description: string; readonly body: string } {
	const startable = clis.length
		? clis.map(cli => `\`${cli.id}\` (${cli.displayName}) with ${orList(cli.models.slice(0, MODELS_NAMED).map(model => `\`${model}\``))}`).join('; ')
		: 'none, for no CLI Facade starts is installed';
	return {
		name: 'facade',
		description: 'How to work in Facade Code with your children and the person, through the facade tools spawn, ps and kill. Use it when you start children, look at what they are, or end them.',
		body: [
			'# Working in Facade Code',
			'',
			'You are an agent in Facade Code: a coding agent CLI in its own terminal, in a folder of a git',
			'repository. Facade runs agents as processes: each has a PID, a parent and children. The person is',
			'PID 1: they start the first agents, and the children of an agent that exits are theirs from then',
			'on. The person can see your terminal and type into it at any time: answer them there.',
			'',
			'## The tools',
			'',
			`- \`spawn\` starts a child: \`cli\` and \`model\` are required - on this machine ${startable} - and \`prompt\` is its task.`,
			'  It works beside you, in your folder; in a worktree of your repository, by name; or with',
			'  `worktree: "new"` and a `name` in a worktree of its own, on a new branch of that name, starting',
			'  at your worktree\'s HEAD: commit what the child needs before you start it there. It answers once',
			'  the child is up, with its PID.',
			'- `ps` lists you, your parent and your children: each one\'s PID, its parent\'s PID, its state -',
			'  starting, running, or exited, how and why - its CLI and model, and its worktree. With `all`,',
			'  every agent this workspace has had.',
			'- `kill` ends one of your children, by its PID or its @name. Its worktree stays.',
			'',
			'A name is a label, which several agents can have: where more than one running agent has it, name',
			'the one you mean by its PID.',
			'',
			'## Your children',
			'',
			'- Facade tells you only what it knows for certain: whether a child is starting, running or has',
			'  exited, and how. Whether a running child works or is done, its worktree shows: the files there,',
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
