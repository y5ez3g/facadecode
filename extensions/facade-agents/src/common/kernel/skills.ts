/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Kernel } from './kernel';
import { FACADE } from './model';

/*
 * The process skills (L2-PLAN, step 29): how a team runs, written for the agents, not built into
 * Facade. One text each, three ways in: `protocol/<skill>` pages in the notebook, which every agent
 * can read and the person can edit; a Claude plugin made from those pages for every Claude that
 * Facade starts; and the MCP server's instructions, which say where they are.
 */

export interface Skill {
	readonly name: string;
	/** When to use it: what Claude matches a request against. */
	readonly description: string;
	readonly body: string;
}

export const PROTOCOL_FOLDER = 'protocol';

export const SKILLS: readonly Skill[] = [
	{
		name: 'team',
		description: 'Lead a team of agents through Facade Code to reach a coding goal: plan tasks in the notebook, start agents for them, wait for their results, check and merge their branches, and ask the person (@you) before anything reaches main. Use when told to lead, to use the team skill, or to split a goal across agents.',
		body: `# Lead a team

You take a goal to a merged, tested result by handing tasks to other agents. You plan, start agents,
answer them, check their work and merge it. The person is @you: they decide what reaches main.

## 1. Know where you stand

- Call \`whoami\` and \`who\`. The spawn tool's description lists the agents installed here.
- Pick a short id for this effort, such as \`p1\`. Call \`join\` with \`#p1\`. Its pages live under \`p1/\`.
- Your folder is where you integrate. If it is on a branch of its own (not main), that branch is the
	integration branch. If it is on main, leave that checkout alone - it may be the person's: make an
	integration worktree, \`git worktree add -b p1 <a new folder next to yours>\`, and merge there.

## 2. Plan

- Read the code you need. Split the goal into tasks that do not touch the same files, so they can be
	done in parallel. Two or three tasks are plenty; fewer when the goal is small.
- \`write\` \`p1/plan\`: the goal, and for each task its id, what to do, the files it may change, the
	command that tests it, and which agent does it.
- For each task, \`write\` \`p1/tasks/<task>\`: the goal, the files it may change, the test command,
	the result page to write (\`p1/results/<task>\`), and that it reports to you.
- When the goal is large or unclear, \`send\` @you the plan's path and \`recv\` with \`wait_sec\` for
	their answer before you start anyone. For a small, clear goal, go on.

## 3. Start the agents

For each task, \`spawn\`:

\`\`\`
agent:    codex, claude, or another installed agent; claude:sonnet picks a model
where:    { branch: "p1-<task>" }       a new worktree, starting from your HEAD
name:     "<task>"                       such as f1
groups:   ["p1"]
text:     "Use the work skill (read protocol/work). Your task is in p1/tasks/<task>."
\`\`\`

Each agent runs as its own UI in a terminal under its worktree's row, where the person can watch it
and type to it. \`who\` shows each agent's folder. Codex cannot commit (its sandbox keeps .git
read-only): you commit its work for it (step 5).

## 4. Wait

Call \`recv\` with \`wait_sec: 600\`, again and again, until every task has reported. Messages from
the agents and Facade's notices arrive there: an agent started, finished its turn, stopped or failed.
Do not end your turn while agents work for you.

- A question: answer it with \`send\`, \`reply_to\` its number.
- An agent failed or stopped without reporting: use the supervise skill (read protocol/supervise).
- An agent that finished its turn still gets what you \`send\` it: Facade tells it in its terminal.

## 5. Check and merge each result

When an agent reports done:

1. \`read\` its result page.
2. In its folder: \`git -C <folder> status --porcelain\`. If it left changes uncommitted, commit them
	there: \`git -C <folder> add -A\` then \`git -C <folder> commit -m "<task>: <what it does>"\`.
3. In your folder: \`git merge --no-ff --no-commit p1-<task>\`, then run the tests.
	- They pass: \`git commit -m "Merge p1-<task>: <what it does>"\`.
	- They fail, or the merge conflicts: \`git merge --abort\`, and \`send\` the agent what failed. It
	fixes it on its branch and reports again. A small conflict you may resolve yourself instead.
4. \`write\` a line to \`p1/log\` with \`mode: "append"\`: the task, its commit, merged.

Merge, never rebase. Never \`reset --hard\` or force-push.

## 6. Finish

- With every task merged and the tests passing on your branch, \`write\` \`p1/summary\`: what was done,
	by whom, the tests and their result, the branch.
- \`send\` @you: a short summary, the summary page, and the question "Merge p1 into main?". Then
	\`recv\` with \`wait_sec\` for the answer.
- On yes: find the folder that has main checked out (\`git worktree list\`). If it has uncommitted
	changes, do not touch it: tell @you. Otherwise \`git -C <that folder> merge --no-ff <your branch>\`,
	run the tests there, and tell @you the result.
- \`stop\` agents that are still running for this effort.`
	},
	{
		name: 'work',
		description: 'Do a task handed to you through Facade Code: read the task page, do it in your own folder, test it, commit it, write the result page and report to whoever gave it to you. Use when told to use the work skill, or when your first message points to a task page.',
		body: `# Work on a task

1. \`whoami\`: your name, your folder, who started you, and your first message.
2. \`read\` the task page it names. If you were asked to pick a task from a list, take one first:
	\`write\` \`<id>/owner/<task>\` with your name and \`mode: "create"\`. If that is refused, someone
	has it: pick another.
3. Do the task in your folder. Change only the files the task allows. If the task is unclear or
	impossible, \`send\` the one who started you a short question and \`recv\` with \`wait_sec: 600\` for
	the answer.
4. Run the test command the task names, or the project's tests.
5. Commit on your branch: \`git add -A\`, then \`git commit -m "<task>: <what it does>"\`. If git
	refuses because the repository is read-only for you (a sandbox), leave the changes uncommitted:
	whoever merges commits them.
6. \`write\` the result page the task names (\`<id>/results/<task>\` if it names none):
	- what you did, in a few lines;
	- your folder and branch;
	- the commit (\`git rev-parse HEAD\`), or "uncommitted";
	- the files you changed;
	- the test command and the last lines of its output;
	- anything left open.
7. \`send\` the one who started you: "Done: <result page>", or "Blocked: <why>".
8. End your turn. If messages come later, such as a fix to make, \`recv\` them and carry on from step 3.`
	},
	{
		name: 'review',
		description: 'Review a branch or a set of commits for a teammate through Facade Code, and leave findings in the notebook. Use when told to use the review skill or to review someone\'s work.',
		body: `# Review

1. \`whoami\`, then \`read\` the page that says what to review: a branch, a range of commits, and what
	to look at in particular.
2. Look with git: \`git log --oneline <base>..<branch>\`, \`git diff <base>...<branch>\`. Read the files
	around the changes. Run the tests if they are quick.
3. \`write\` each finding to the review page you were given (\`<id>/reviews/<your name>\` if none),
	with \`mode: "append"\`:
	\`- [blocker|major|minor|nit] <file>:<line> — what is wrong, and what to do instead\`.
	Blockers are bugs, broken tests, or changes outside the task. Say so if there is nothing to fix.
4. \`send\` the one who asked: "Review done: <n> blockers, <n> majors — <page>".

Do not change the code under review unless you are asked to.`
	},
	{
		name: 'supervise',
		description: 'Handle an agent that failed, stopped too early, waits at a prompt, or went quiet, while leading through Facade Code. Use when a notice says an agent failed or stopped, or when an agent you started does not report.',
		body: `# Supervise

When Facade's notice says an agent **failed** or **stopped** before it reported:

1. Look at what it left: \`who\` for its state and last words, its task and result pages,
	\`git -C <its folder> status\` and \`git -C <its folder> log --oneline -5\`.
2. Choose one:
	- **Retry**: \`spawn\` again with the same name and the same text. The new one keeps the name's
	messages and continues in a folder you give it: its old one with \`where: { folder }\`.
	- **Switch agent**: the same, with another agent, when this one failed twice.
	- **Take over**: do the rest yourself in its folder.
3. The same task failing twice more: stop retrying. \`send\` @you what happened and what you propose.

When an agent is **waiting** in its terminal, it waits for the person: \`send\` @you which agent and
what it asks. When an agent you started goes **quiet** for long while it works, \`send\` it a
message asking where it stands.`
	},
	{
		name: 'notebook',
		description: 'Conventions for the shared notebook of Facade Code: page layout, logs, results, and changing a page others write. Use when writing or organizing pages for a team.',
		body: `# The notebook's conventions

Pages are paths, grouped by effort:

\`\`\`
<id>/plan              the goal, the tasks, who does what
<id>/tasks/<task>      one task: goal, files it may change, test command, result page
<id>/owner/<task>      who took a task from a pool (written with mode "create")
<id>/results/<task>    what was done: folder, branch, commit, files, test output
<id>/reviews/<name>    findings
<id>/log               one line per event; append only
<id>/summary           the outcome
protocol/<skill>       the skills, this one included
\`\`\`

- Logs are only appended to (\`mode: "append"\`).
- A result names a commit, or says "uncommitted", and shows the tests' output.
- To change a page others write: \`read\` it, then \`write\` with \`if_version\` set to the version you
	read. If it is refused, merge your change into the text you get back and write again.
- A page you \`read\` tells you once, through \`recv\`, when someone else changes it: read it again.
- Long content belongs in pages; messages carry the path.
- A page worth keeping after the effort (a design, a decision) goes into the repository as a file,
	committed like any other.`
	},
	{
		name: 'resume',
		description: 'Get back to work after your context was compacted, or when you were started again under the same name, in Facade Code. Use when you have lost track of what you were doing.',
		body: `# Resume

1. \`whoami\`: who you are, your folder, your first message, how many messages wait.
2. \`recv\`: the messages since you last took them. They were kept for you.
3. \`read\` the pages your first message and the messages point to: the plan, your task, results.
4. In your folder: \`git status\` and \`git log --oneline -5\`: what you already did.
5. Carry on from there. Do not redo what the pages and git say is done.`
	},
	{
		name: 'etiquette',
		description: 'How to talk to the person and to other agents in Facade Code: when to ask @you, how long messages should be, and who to tell what. Use whenever you send messages.',
		body: `# Talking in Facade

- **Short messages.** One purpose each. Put anything long in a page and send its path.
- **@you is the person.** Ask them what is theirs to decide: merging into main, changing the goal,
	anything destructive outside your own worktree, spending much more than planned. Do not ask them
	what you can find out yourself.
- **Answer the message.** Use \`reply_to\` with the number of the message you answer.
- **Tell the one who started you** when you finish, when you are blocked, and when your plan changes.
	Do not wait in silence.
- **A group is for everyone in it.** Send to one @name when it concerns one participant.
- **Notices are Facade's.** Messages from Facade say that a page you read changed or that an agent
	started, finished its turn, stopped or failed. They need no answer.`
	}
];

/** A skill as a page, and as Claude's SKILL.md: the same text. */
export function skillText(skill: Skill): string {
	return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`;
}

/**
 * Writes the skills' pages. A page Facade wrote, or none, gets Facade's current text; a page the
 * person or an agent changed stays as they left it.
 */
export function writeProtocolPages(kernel: Kernel, skills: readonly Skill[] = SKILLS): void {
	const facade = { name: FACADE, incarnation: 0 };
	for (const skill of skills) {
		const page = `${PROTOCOL_FOLDER}/${skill.name}`;
		kernel.syncPage(page);
		const info = kernel.state.pages.get(page);
		const text = skillText(skill);
		if (info && !info.deleted && info.author !== FACADE) {
			continue;
		}
		if (info && !info.deleted && info.hash === crypto.createHash('sha256').update(text, 'utf8').digest('hex')) {
			continue;
		}
		kernel.write(facade, page, text);
	}
}

/**
 * A Claude plugin holding the skills as they are in the notebook now, named by its content so a
 * running Claude keeps the version it started with. Returns its folder.
 */
export function writeSkillsPlugin(root: string, kernel: Kernel, skills: readonly Skill[] = SKILLS): string {
	const files: Record<string, string> = {
		'.claude-plugin/plugin.json': JSON.stringify({
			name: 'facade',
			version: '1.0.0',
			description: 'How to work with the person and other agents in Facade Code: lead a team, work on a task, review, supervise, and keep the shared notebook.',
			author: { name: 'Facade Code' }
		}, undefined, '\t')
	};
	for (const skill of skills) {
		const page = kernel.state.pages.get(`${PROTOCOL_FOLDER}/${skill.name}`);
		let text = skillText(skill);
		if (page && !page.deleted) {
			try {
				text = fs.readFileSync(path.join(kernel.notesDir, PROTOCOL_FOLDER, `${skill.name}.md`), 'utf8');
			} catch {
				// The page's file went; Facade's own text stands in.
			}
		}
		files[`skills/${skill.name}/SKILL.md`] = text;
	}
	const hash = crypto.createHash('sha256');
	for (const [name, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
		hash.update(name).update('\0').update(content).update('\0');
	}
	const version = hash.digest('hex').slice(0, 12);
	const dir = path.join(root, version, 'facade');
	if (!fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
		const staging = `${dir}.${process.pid}.tmp`;
		fs.rmSync(staging, { recursive: true, force: true });
		for (const [name, content] of Object.entries(files)) {
			const target = path.join(staging, name);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		fs.rmSync(dir, { recursive: true, force: true });
		fs.renameSync(staging, dir);
	}
	return dir;
}
