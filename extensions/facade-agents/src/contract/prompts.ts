/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Facade } from '../core/facade';
import { Caller, PERSON } from '../record/events';

const TOOLS = 'Your tools: spawn starts a child agent and answers with its number once its CLI has connected; ps lists you, your parent and your children, each with its number, its state and its mailbox; kill ends one of your children.';
const MESSAGES = `Messages: send_message sends a message to agents, or to the person, @${PERSON.name}, and answers at once with its number, as #m42: a reply comes to your mailbox. A line starting [facade] typed into your terminal says you have unread messages: call read_messages, and print the new ones before you act on them. Something for the person: print it whole first, then send it to @${PERSON.name}. If an agent started you, message it when you are done, stuck, or need a decision; if the person did, answer them in your terminal. Ask in plain text or by message, never with your CLI's tool for questions with buttons. Do not poll or wait for a reply: end your turn.`;
const PERSON_MESSAGES = 'Messages: send_message sends a message to agents and answers with its number, as #m42. Messages to you come as notifications; read_messages with all gives them again.';

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
		return [`You act as the person, @${PERSON.name}, in Facade Code.`, TOOLS, PERSON_MESSAGES].join('\n');
	}
	const spawner = agent.parent === undefined ? undefined : facade.agent(agent.parent);
	return [
		`You are @${agent.name} #a${agent.id}, ${anAgentOf(facade.cliName(agent.cli))} in Facade Code, started by ${spawner ? `@${spawner.name} #a${spawner.id}` : `the person, @${PERSON.name}`}.`,
		`You run in ${agent.folder}: the worktree ${agent.worktree}. You are in that folder already: run commands there without cd.`,
		TOOLS,
		MESSAGES
	].join('\n');
}

/**
 * The first line of an agent with a task, its launch argument or typed into its terminal: who it is, who
 * created it, and the number of its task, which it fetches itself. It names the task rather than
 * holding it: a model gives less weight to what a tool's result asks of it, and the task's text never
 * goes on a command line.
 */
export function firstLineFor(agent: { readonly id: number; readonly name: string }, creator: Caller, task: number): string {
	const by = creator.id === undefined ? `@${creator.name}` : `@${creator.name} #a${creator.id}`;
	return `[facade] You are @${agent.name} #a${agent.id}, created by ${by}. Your task is #m${task}. Call read_messages, read the task, then carry it out.`;
}

/**
 * The `facade` skill every agent is handed at its launch: how Facade behaves - agents, their parents and
 * children, the tools, the messages, the folder an agent runs in - and the CLIs this machine has to
 * start children with. Nothing about how to work: that is the person's to choose.
 */
export function facadeSkill(clis: readonly StartableCli[]): { readonly name: string; readonly description: string; readonly body: string } {
	const startable = clis.length
		? clis.map(cli => `\`${cli.id}\` (${cli.displayName})`).join(', ')
		: 'none, for no CLI Facade starts is installed';
	const person = `@${PERSON.name}`;
	return {
		name: 'facade',
		description: 'How to work in Facade Code with other agents and the person, through the facade tools spawn, ps and kill, send_message and read_messages. Use it when you start children, look at them, end them, message them, or get a message.',
		body: [
			'# Working in Facade Code',
			'',
			'You are an agent in Facade Code: a coding agent CLI in its own terminal, in a folder of a git',
			'repository. Each agent has a name and a number, as @name #a7, a parent and children. The person,',
			`${person}, starts the first agents, and the children of an agent that exits are theirs from then on.`,
			'A number is Facade\'s own, not a process id: only the tools below take it. The person can see your',
			'terminal and type into it at any time: answer them there.',
			'',
			'## The tools',
			'',
			`- \`spawn\` starts a child: \`cli\`, \`model\` and \`effort\` are required - on this machine ${startable} - and \`prompt\` is its task,`,
			'  which Facade sends the child as a message from you.',
			'  Facade gives the model and the effort to the CLI as they are, as its own options take them, and no',
			'  CLI checks them as it starts: a child given a model its CLI does not have comes up all the same,',
			'  then fails at its first step, on its screen, or works on the CLI\'s own default model.',
			'  It works beside you, in your folder; in a worktree of your repository, by name; or with',
			'  `worktree: "new"` and a `name` in a worktree of its own, on a new branch of that name, starting',
			'  at your worktree\'s HEAD: commit what the child needs before you start it there. It answers once',
			'  the child\'s CLI has connected to Facade, with its number and its task\'s: the child fetches its',
			'  task itself, and `ps` shows when it has.',
			'- `ps` lists you, your parent and your children: each one\'s name and number, its parent\'s number',
			'  or the person, its state - starting, running, or exited, how and why - its CLI, model and effort,',
			'  its worktree, and its mailbox: what it has not fetched yet. With `all`, every agent this workspace',
			'  has had.',
			'- `kill` ends one of your children, by its number, as #a7, or its @name. Its worktree stays.',
			'',
			'A name is a label, which several agents can have: where more than one running agent has it, name',
			'the one you mean by its number.',
			'',
			'## Messages',
			'',
			'Agents talk to each other directly, through Facade: never ask the person to pass a message on.',
			'',
			'- `send_message` sends a message to agents - by @name, by number as #a7, or as @name #a7 - or to the',
			`  person, ${person}: \`to\` takes one or several, and each gets a message of its own. It answers at once`,
			'  with each message\'s number, as #m42, and waits for no reply: a reply comes to your mailbox. To',
			'  answer a message, give its number as `reply_to`. With your YOLO off, you reach the agents of your',
			'  own tree only - the agent the person started at its top, and every agent started from it - and the',
			'  person.',
			'- When you have unread messages, a line starting `[facade]` is typed into your terminal: your doorbell.',
			'  Then call `read_messages`. With nothing, it gives your unread messages; with `ids`, messages by',
			'  number, as #m42; with `all`, every message sent to you - after your context was cleared or',
			'  compacted, say: your task is among them.',
			'- Each message comes marked: new; given before, and when; or returned. A message can come twice: one',
			'  number is one message. One given before you may have acted on already: look at the work as it is',
			'  before you do it again.',
			'- Print the new messages you fetch before you act on them, for the person, who watches your screen:',
			'  one of 500 characters or fewer as it is, with its number and its sender; a longer one as its',
			'  number, its sender and a sentence or two of what it says. Messages that come to more than 8,000',
			'  characters together are in a file, whose path the result gives: read all of it first.',
			`- Something for the person: print it whole on your screen first, then send it to ${person}.`,
			'- Do not poll, sleep or wait for a reply: it comes to your mailbox, and rings your doorbell. End your',
			'  turn.',
			'- A message to an agent that ends before it fetches it comes back to you, from Facade, with its text.',
			'  Where messages wait unfetched for the timeout - their recipient busy, or held up - Facade tells the',
			'  sender of the oldest of them, once.',
			'',
			'## Questions and reports',
			'',
			'If the person started you, they are at your terminal: answer them there, in plain text. If another',
			'agent started you, it is your creator:',
			'',
			'- Settle the ordinary choices of your task yourself.',
			'- If you need something your creator knows, message it, and go on with what does not wait on the',
			'  answer. A creator answers from what it knows, or asks its own creator in turn.',
			'- A decision only the person can make is asked by the agent working with them: in plain text in its',
			`  own terminal, and with a message to ${person} as well if they may not be watching it.`,
			`- If your creator has ended, you are the person's from then on: ask ${person}.`,
			'- When you are done or stuck, message your creator: what happened, where the result is - a file, or',
			'  a commit on your branch - what you checked, and what is left to decide. Then wait for an answer: do',
			'  not end yourself because your turn is over.',
			'',
			'Never ask with your CLI\'s own tool for questions with buttons - AskUserQuestion, request_user_input,',
			'ask_question and the like: it waits in your terminal for someone to click. Ask in plain text, or by',
			'message.',
			'',
			'## Your children',
			'',
			'- Facade tells you only what it knows for certain: whether a child is starting, running or has',
			'  exited, and how. Whether a running child works or is done, its worktree shows: the files there,',
			'  `git status` and `git log`.',
			'- Ask a child in its task to message you when it is done, saying where its result is - a file, or a',
			'  commit on its branch. Facade messages you when a child of yours ends - unless you ended it - and',
			'  when one has not fetched its task within the timeout.',
			'',
			'## Your folder',
			'',
			'- You run in your folder already: run commands there without `cd`.',
			'- Files Facade put in your folder for you are not yours to commit.'
		].join('\n')
	};
}
