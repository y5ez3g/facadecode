/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { facadeSkill, firstLineFor } from '../contract/prompts';
import { Contract } from '../contract/tools';
import { Caller, PERSON } from '../record/events';
import { ToolResult } from '../transport/protocol';
import { settled, sleep, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { tempDir } from './util';

const TOOLS = 'Tools: start_agent launches a separate CLI in a window folder or new worktree; started confirms launch readiness, not task completion. list_agents shows runs, mailboxes, and available CLIs: you, your creator, and your immediate children by default, or every reachable run with all:true. stop_agent ends a run and can delete its worktree. read_screen inspects a CLI; type_text and press_keys send terminal input and normally return the resulting screen.';
const MESSAGES = 'Use send_message for tasks, questions, answers, and reports. It records each message and returns its ID without waiting for a reply. On a [facade] unread-message notice, call read_messages and show new messages in your terminal before acting. Repeated reads keep the same IDs; track which work you have handled. Before messaging @human, print the full text here. Continue independent work after sending. If you need a reply to proceed, end this turn and leave your CLI running. Agent replies trigger a doorbell; do not poll or sleep for them.';
/** Whom each agent asks (M8): a child its creator; one the person started from the UI the person; one their script started @human. */
const ASK_CREATOR = 'Use send_message to send questions to your creator and report when you finish or become blocked.';
const ASK_IN_TERMINAL = 'The person started you from the window. Communicate with them here using your CLI\'s normal interaction.';
const ASK_HUMAN = 'A script started you. Use send_message to send questions and reports to @human.';
const PERSON_MESSAGES = 'send_message records messages to agents and returns their IDs. Messages addressed to @human appear as notifications. Use read_messages with all:true to retrieve that inbox again.';
const UNANSWERED = 'A call with no result may already have taken effect. Before retrying, inspect starts or stops with list_agents and terminal input with read_screen. Resend a message only if you establish that it was not recorded.';
const NO_PICKS = 'Your terminal may be unattended. Ask through Facade messages. Do not use blocking question or choice tools: they may consume a terminal doorbell as an answer.';

suite('Contract: what the model sees, and what it gets back', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let world: ReturnType<typeof fakeWorld>;
	let contract: Contract;

	setup(() => {
		temp = tempDir('facade-contract-');
		lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
		contract = new Contract(world.facade);
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	/** A tool call, answered as its caller's client gets it: a child it starts says hello through the contract once its terminal is launched. */
	async function call(caller: Caller, tool: string, args: unknown): Promise<ToolResult> {
		const launched = world.terminals.launched.length;
		let over = false;
		const calling = contract.call(caller, tool, args, () => undefined);
		void calling.then(() => over = true);
		await until(() => over || world.terminals.launched.length > launched);
		if (!over) {
			contract.hello(callerOf(world.agent(world.table.state.lastId)));
		}
		return settled(calling);
	}

	/** A time as list_agents gives it. */
	function timeOfDay(time: number | undefined): string {
		return new Date(time ?? 0).toTimeString().slice(0, 8);
	}

	test('an agent\'s MCP server says hello: the agent is connected - started, running - and its model is given the tools - start_agent offering the agents this machine can start, and taking a model and an effort as those CLIs do, if given - and who it is, who started it, its tree, where it runs and its YOLO; one another agent or a script started is told to ask in words, never with a pick, and the person\'s own, from the window, is not: its question tool is theirs to answer (L4); the person acts as the person, reaching every agent', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const starting = world.facade.startAgent(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', name: 'planner' });
		await until(() => world.terminals.launched.length === 2);
		const hello = contract.hello(callerOf(world.agent(2)));
		const state = world.agent(2).state;
		await settled(starting);
		const tools = JSON.parse(JSON.stringify(hello.tools));
		const person = contract.hello(PERSON);
		await world.facade.startForPerson('arg', lab);
		const own = contract.hello(callerOf(world.agent(3)));
		const script = contract.hello(callerOf(world.agent(1)));

		assert.deepStrictEqual({
			name: hello.name,
			state,
			tools: tools.map((tool: { name: string }) => tool.name),
			cli: tools[0].inputSchema.properties.cli,
			model: tools[0].inputSchema.properties.model,
			effort: tools[0].inputSchema.properties.effort,
			instructions: hello.instructions.split('\n'),
			own: own.instructions.split('\n'),
			script: script.instructions.split('\n').slice(4),
			person: { name: person.name, instructions: person.instructions.split('\n') }
		}, {
			name: 'planner',
			// Its first line, typed by its doorbell, comes after: started is that it connected (O3; M7)
			state: 'running',
			tools: ['start_agent', 'list_agents', 'stop_agent', 'send_message', 'read_messages', 'read_screen', 'type_text', 'press_keys'],
			// Open: one installed or added later is startable all the same (X-39; C-CORE-23)
			cli: { type: 'string', description: 'CLI ID or custom agent name. Available when listed: arg (Arg Code), told (Told Code). Use list_agents to refresh availability and supported options.' },
			model: { type: 'string', description: 'Value for the CLI\'s --model option. Omit to use its default.' },
			effort: { type: 'string', description: 'CLI reasoning effort, such as low, medium, or high. Omit to use its default. Does not require model.' },
			instructions: [
				'You are @planner #a2, a Told Code agent in Facade Code. Creator: @lead #a1. Tree root: #a1.',
				`Working directory: ${lab} (worktree main). You are already in this directory; no cd is needed to start work here.`,
				'YOLO is on. You can reach every agent in this window. Children inherit YOLO on.',
				TOOLS,
				MESSAGES,
				ASK_CREATOR,
				UNANSWERED,
				NO_PICKS
			],
			own: [
				'You are @arg #a3, an Arg Code agent in Facade Code. Creator: @human. Tree root: #a3.',
				`Working directory: ${lab} (worktree main). You are already in this directory; no cd is needed to start work here.`,
				'YOLO is on. You can reach every agent in this window. Children inherit YOLO on.',
				TOOLS,
				MESSAGES,
				ASK_IN_TERMINAL,
				UNANSWERED
			],
			// Started by the person's script through start_agent: nobody may be watching it (M8)
			script: [MESSAGES, ASK_HUMAN, UNANSWERED, NO_PICKS],
			person: { name: 'human', instructions: ['You act as @human in Facade Code and can reach every agent in this window.', TOOLS, PERSON_MESSAGES, UNANSWERED] }
		});
	});

	test('an agent\'s first line names it, its creator - an agent by its number, the person as @human - what it is told of its preparation, and its task\'s number, which it fetches itself: never the task\'s text; with no task, its opening alone; each says to send its questions and its report to its creator - @human for a root of the person\'s script - with send_message, never only on its screen, never with a pick (M7; L4, L9; LV-01)', () => {
		assert.deepStrictEqual([
			firstLineFor({ id: 2, name: 'lint' }, { id: 1, name: 'lead' }, 3),
			firstLineFor({ id: 1, name: 'lead' }, PERSON, 1, 'Its setup is not known to have finished.'),
			firstLineFor({ id: 4, name: 'idle' }, { id: 1, name: 'lead' }, undefined)
		], [
			'[facade] You are @lint #a2, created by @lead #a1. Your task is #m3. Call read_messages to fetch it, then carry it out. Use send_message to send questions and your report to @lead #a1; terminal output alone does not reach them. Do not use blocking question or choice tools.',
			'[facade] You are @lead #a1, created by @human. Its setup is not known to have finished. Your task is #m1. Call read_messages to fetch it, then carry it out. Use send_message to send questions and your report to @human; terminal output alone does not reach them. Do not use blocking question or choice tools.',
			'[facade] You are @idle #a4, created by @lead #a1. Use send_message to send questions and your report to @lead #a1; terminal output alone does not reach them. Do not use blocking question or choice tools.'
		]);
	});

	test('with YOLO off, an agent is told Facade\'s tools never need approval only where its launch\'s exemption is Facade\'s own; else what Facade knew of its launch - a setting of the person\'s that refuses them, a launch of theirs that may ask - and of one Facade did not launch in this load of the window, as the skill says, only that Facade adds no approval of its own (L4, rule 4; LA-11)', async () => {
		const plain = path.join(temp.dir, 'plain');
		fs.mkdirSync(plain);
		const dir = path.join(temp.dir, 'workspace');
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, folders: [plain], environment: folder => folder === plain ? { ARG_DENY: '/home/.arg/settings.json' } : {} });
		contract = new Contract(world.facade);
		world.switches.yolo = false;
		world.custom.review = { path: 'review', launch: { arguments: { connect: ['--mcp', '${mcpConfig}'] } } };
		await world.startUp(PERSON, { cli: 'arg', task: 'Own.', name: 'own', folder: lab });
		await world.startUp(PERSON, { cli: 'arg', task: 'Denied.', name: 'denied', folder: plain });
		await world.facade.startForPerson('review', lab);
		world.settings.arg = { launch: { arguments: { yoloOff: ['--sandbox'] } } };
		await world.startUp(PERSON, { cli: 'arg', task: 'Changed.', name: 'changed', folder: lab });
		const said = (id: number) => contract.hello(callerOf(world.agent(id))).instructions.split('\n')[2].replace(/^YOLO is off\. You can reach only your own tree\. Children inherit YOLO off\. /, '');
		const launched = [1, 2, 3, 4].map(said);
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, folders: [plain] });
		world.terminals.running.add('@own #a1');
		await world.facade.recover(true);
		contract = new Contract(world.facade);

		assert.deepStrictEqual({ launched, afterReload: said(1), skill: facadeSkill().body.split('\n').filter(line => line.includes('adds no approval requirement')) }, {
			launched: [
				'Your CLI allows Facade tools without approval.',
				'User settings cause your CLI to deny some Facade tools: /home/.arg/settings.json denies mcp__facade.',
				'Your custom CLI launch may require approval to use Facade tools.',
				'Your CLI may require approval to use Facade tools: the launch\'s yoloOff group differs from Facade\'s defaults for allowing tools without approval.'
			],
			afterReload: 'Facade itself does not require approval for its tools.',
			skill: ['tree. Children inherit your YOLO. Facade itself adds no approval requirement;']
		});
	});

	test('the skill has an agent whose creator has ended send its questions and its report to the nearest agent above it that runs, or to @human: an agent\'s terminal is one the person may not be watching (M8)', () => {
		const body = facadeSkill().body.replace(/\s+/g, ' ');
		const orphan = /If your creator has ended[^.]*\./.exec(body)?.[0] ?? '';

		assert.deepStrictEqual({ nearest: /follow creator IDs to the nearest running ancestor/.test(orphan), person: orphan.includes('contact `@human` if none remains') }, { nearest: true, person: true });
	});

	test('the start_agent tool requires a name and the CLI, the model, the effort, the task, the folder and a new worktree left to the caller, and names no model or level of its own: the CLI is the one that knows them', () => {
		const schema = JSON.parse(JSON.stringify(contract.hello(PERSON).tools[0])).inputSchema;

		assert.deepStrictEqual({ required: schema.required, optional: Object.keys(schema.properties).filter(name => !schema.required.includes(name)), enums: [schema.properties.model.enum, schema.properties.effort.enum] }, {
			required: ['name', 'cli'],
			optional: ['model', 'effort', 'task', 'folder', 'new_worktree'],
			enums: [undefined, undefined]
		});
	});

	test('an agent in a folder of no Git repository is said to be there, not in a worktree named after the folder: in start_agent\'s answer, in list_agents, in words and as data, and in what its model is told as it starts - through a reopening of the record too (N-05)', async () => {
		const plain = path.join(temp.dir, 'plain');
		fs.mkdirSync(plain);
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, folders: [plain] });
		contract = new Contract(world.facade);
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const started = await call(lead, 'start_agent', { name: 'notes', cli: 'arg', task: 'Take notes.', folder: plain });
		const listed = await call(lead, 'list_agents', {});
		const row = (name: string) => (listed.text ?? '').split('\n').find(line => line.startsWith(`@${name} `)) ?? '';
		const told = contract.hello(callerOf(world.agent(2))).instructions.split('\n')[1];
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, folders: [plain] });

		assert.deepStrictEqual({
			started: (started.text ?? '').split('\n')[0],
			notes: [row('notes').includes(`folder ${plain} (not a Git repository)`), row('notes').includes('worktree')],
			lead: row('lead').includes('worktree main'),
			data: (listed.data as { agents: { name: string; outsideGit?: boolean }[] }).agents.map(each => [each.name, each.outsideGit ?? false]),
			told,
			reopened: world.table.get(2)?.outsideGit
		}, {
			started: `Started @notes #a2 in ${plain} (not a Git repository).`,
			notes: [true, false],
			lead: true,
			data: [['lead', false], ['notes', true]],
			told: `Working directory: ${plain} (not a Git repository). You are already in this directory; no cd is needed to start work here.`,
			reopened: true
		});
	});

	test('stop_agent says what became of an agent\'s folder in one sentence each: an agent in no Git repository has a folder, not a worktree (N-57); a deletion the window refused says the window\'s words once, Facade\'s own reason is put in a sentence of its own (N-52)', async () => {
		const plain = path.join(temp.dir, 'plain');
		fs.mkdirSync(plain);
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, folders: [plain] });
		contract = new Contract(world.facade);
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await call(lead, 'start_agent', { name: 'notes', cli: 'arg', task: 'Notes.', folder: plain });
		await call(lead, 'start_agent', { name: 'w', cli: 'arg', task: 'W.', new_worktree: true });
		await call(lead, 'start_agent', { name: 'here', cli: 'arg', task: 'Here.', folder: lab });
		const outsideGit = await call(lead, 'stop_agent', { agent: '@notes' });
		world.git.failDelete = '~/.facade/worktrees/lab/w was not deleted: an agent of another window is working inside it, @there #a9. Stop it in that window first.';
		const refused = await call(lead, 'stop_agent', { agent: '@w', delete_worktree: true });
		const mainCheckout = await call(lead, 'stop_agent', { agent: '@here', delete_worktree: true });

		assert.deepStrictEqual({ outsideGit: outsideGit.text, refused: refused.text, mainCheckout: mainCheckout.text }, {
			outsideGit: 'Stopped @notes #a2: its terminal closed. Its folder is unchanged.',
			refused: 'Stopped @w #a3: its terminal closed. ~/.facade/worktrees/lab/w was not deleted: an agent of another window is working inside it, @there #a9. Stop it in that window first.',
			mainCheckout: `Stopped @here #a4: its terminal closed. ${lab} was not deleted: it is the repository's main checkout, which cannot be deleted.`
		});
	});

	test('an effort given with a model whose name may carry one - Antigravity\'s - is given to the CLI as every value is, and recorded unknown, the start saying the model\'s may apply instead; an effort alone is given and recorded as it is (O3; N-64, AS-13; OR-01)', async () => {
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, toldModelCarriesEffort: true });
		contract = new Contract(world.facade);
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const both = await call(lead, 'start_agent', { name: 'both', cli: 'told', model: 'flash-high', effort: 'low' });
		const alone = await call(lead, 'start_agent', { name: 'alone', cli: 'told', effort: 'low' });
		const args = (n: number) => world.terminals.launched[n].args.filter(arg => ['--model', '--effort', 'flash-high', 'low'].includes(arg));

		assert.deepStrictEqual({ both: both.text, bothData: (both.data as { ignored: string[] }).ignored, bothArgs: args(1), alone: (alone.data as { effort?: string; ignored: string[] }), aloneArgs: args(2) }, {
			both: `Started @both #a2 in worktree main.\nTold Code, flash-high, effort unknown (low not applied), YOLO on, no sandbox, connected to Facade, folder ${lab}, no task.\nThe requested effort was passed to Told Code, but model flash-high may specify an overriding effort. The actual effort is unknown.`,
			bothData: ['effort'],
			bothArgs: ['--model', 'flash-high', '--effort', 'low'],
			alone: { ...(alone.data as object), effort: 'low', ignored: [] },
			aloneArgs: ['--effort', 'low']
		});
	});

	test('start_agent answers once the child has started, in words and as data - and, where its start is not confirmed in time, why, the child left starting; stop_agent stops a child, and says of one that exited how it did; list_agents gives the caller\'s view of the agents - how many in each state, then a line each - and the same as data, where an agent the person started has no parent\'s number', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const beside = await call(lead, 'start_agent', { name: 'tests', cli: 'arg', model: 'small', effort: 'high', task: 'Write the tests.' });
		const inNew = await call(lead, 'start_agent', { name: 'clamp', cli: 'arg', model: 'small', effort: 'high', task: 'Clamp the widths.', new_worktree: true });
		const stopped = await call(lead, 'stop_agent', { agent: '@tests' });
		const again = await call(lead, 'stop_agent', { agent: '#a2' });
		const listed = await call(lead, 'list_agents', {});
		const clamp = worktreeFolder(lab, 'clamp');
		world.timing.startTimeoutMs = 5_000;
		const starting = contract.call(lead, 'start_agent', { name: 'waits', cli: 'told', model: 'deep', effort: 'high', folder: lab }, () => undefined);
		await until(() => world.terminals.launched.length === 4);
		await sleep(5_000);
		const unconfirmed = await settled(starting);

		const facts = ['status', 'id', 'name', 'creator', 'root', 'cli', 'model', 'effort', 'ignored', 'yolo', 'sandbox', 'connected', 'worktree', 'folder', 'newWorktree', 'taskMessage', 'task'];
		const picked = (data: unknown) => Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(data))).filter(([key]) => facts.includes(key)));
		const arg = (model: string, folder: string, message: number) => `Arg Code, ${model}, high, YOLO on, sandbox off, connected to Facade, folder ${folder}, task #m${message}`;
		const fetches = (message: number) => `\nThe child must fetch task #m${message} itself. Launch readiness does not confirm task retrieval; list_agents shows delivery.`;

		assert.deepStrictEqual({ beside: { text: beside.text, data: picked(beside.data) }, inNew: inNew.text, unconfirmed: { text: unconfirmed.text, data: picked(unconfirmed.data) }, stopped: stopped.text, again: again.text, listed: listed.text.split('\n'), rows: JSON.parse(JSON.stringify(listed.data)).agents.map((row: { id: number; creator?: number }) => `${row.id}<${Object.keys(row).includes('creator') ? row.creator : 'none'}`) }, {
			beside: {
				text: `Started @tests #a2 in worktree main.\n${arg('small', lab, 2)}.${fetches(2)}`,
				data: { status: 'started', id: 2, name: 'tests', creator: 1, root: 1, cli: 'arg', model: 'small', effort: 'high', ignored: [], yolo: true, sandbox: 'off', connected: true, worktree: 'main', folder: lab, newWorktree: false, taskMessage: 2 }
			},
			inNew: `Started @clamp #a3 in new worktree clamp on a new branch.\n${arg('small', clamp, 3)}.${fetches(3)}`,
			unconfirmed: {
				text: `Start unconfirmed for @waits #a4: after 5 seconds, the CLI is open but has not connected to Facade; it may be slow or waiting at a prompt.\nphase connecting, Told Code, deep, high, YOLO on, no sandbox, not yet connected to Facade, folder ${lab}, no task.\nThis start is still pending. Inspect #a4 with list_agents or read_screen, or cancel it with stop_agent. Do not start a duplicate.`,
				data: { status: 'unconfirmed', id: 4, name: 'waits', creator: 1, root: 1, cli: 'told', model: 'deep', effort: 'high', ignored: [], yolo: true, sandbox: 'unavailable', connected: false, worktree: 'main', folder: lab, newWorktree: false }
			},
			stopped: 'Stopped @tests #a2: its terminal closed. Its worktree is unchanged.',
			again: '@tests #a2 had already ended (stopped by @lead #a1: with stop_agent).',
			listed: [
				'You are @lead #a1. YOLO on: you can reach every agent in this window.',
				'3 agents: 2 running, 1 ended',
				// Each with its mailbox (M3): @tests' task went back to @lead as it ended unfetched, in #m4 (M6)
				`@lead #a1 (you)  creator @human  tree #a1  running  worktree main  started ${timeOfDay(world.agent(1).startTime)}  ${arg('large', lab, 1)}  mailbox: 2 unread: #m1 (from @human, 0 min ago), #m4 (from Facade, 0 min ago); 0 fetched; task #m1 not yet fetched`,
				`@tests #a2  creator @lead #a1  tree #a1  ended at ${timeOfDay(world.agent(2).end?.time)} (stopped by @lead #a1: with stop_agent)  worktree main  started ${timeOfDay(world.agent(2).startTime)}  ${arg('small', lab, 2).replace(', connected to Facade', '')}  mailbox: no unread messages; 0 fetched; task #m2 returned without being fetched before the run ended`,
				`@clamp #a3  creator @lead #a1  tree #a1  running  worktree clamp  started ${timeOfDay(world.agent(3).startTime)}  ${arg('small', clamp, 3)}  mailbox: 1 unread: #m3 (from @lead #a1, 0 min ago); 0 fetched; task #m3 not yet fetched`,
				'CLIs you can start: arg (Arg Code): supports Facade tools, task, model, effort; told (Told Code): supports Facade tools, task, model, effort.'
			],
			rows: ['1<none', '2<1', '3<1']
		});
	});

	test('with the agent framework off every call - an agent\'s or the person\'s script\'s - answers at once that it is, doing nothing', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		world.switches.framework = false;
		const off = { text: 'Facade tools are disabled by facade.orchestration.enabled. This call had no effect; existing agents keep running.', isError: true, data: { code: 'UNAVAILABLE', reason: 'framework_disabled' } };
		const results = [
			await contract.call(callerOf(world.agent(1)), 'list_agents', {}, () => undefined),
			await contract.call(PERSON, 'start_agent', { name: 'more', cli: 'arg' }, () => undefined),
			await contract.call(PERSON, 'stop_agent', { agent: '#a1' }, () => undefined)
		];

		assert.deepStrictEqual({ results, launched: world.terminals.launched.length, state: world.agent(1).state }, { results: [off, off, off], launched: 1, state: 'running' });
	});

	test('list_agents says in its data, as in its text, who asks, what it reaches, and how many agents are in each state (O6)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Go.', name: 'child' });
		await world.facade.stopAgent(lead, '#a2');
		const of = async (caller: Caller) => {
			const { caller: who, reach, counts } = (await call(caller, 'list_agents', { all: true })).data as { caller: unknown; reach: unknown; counts: unknown };
			return { who, reach, counts };
		};

		assert.deepStrictEqual({ lead: await of(lead), person: await of(PERSON) }, {
			lead: { who: { id: 1, name: 'lead' }, reach: 'window', counts: { starting: 0, running: 1, stopping: 0, ended: 1 } },
			person: { who: { name: 'human' }, reach: 'window', counts: { starting: 0, running: 1, stopping: 0, ended: 1 } }
		});
	});

	test('each call looks for the CLIs this machine has again first, where a terminal finds them: one installed since, or taken away, shows at the next call (X-39; LS-07)', async () => {
		const before = world.refreshes.count;
		await call(PERSON, 'list_agents', {});
		await call(PERSON, 'list_agents', {});

		assert.deepStrictEqual(world.refreshes.count - before, 2);
	});

	test('a task is kept as it was written, its spaces and line breaks too; one with nothing in it is refused (X-56; C-CORE-27)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const result = await call(callerOf(world.agent(1)), 'start_agent', { name: 'exact', cli: 'arg', task: '  a\n' });
		const blank = await call(callerOf(world.agent(1)), 'start_agent', { name: 'blank', cli: 'arg', task: ' \n ' });
		const message = (result.data as { readonly taskMessage?: number } | undefined)?.taskMessage;
		const sent = message === undefined ? undefined : world.table.state.mail.messages.get(message);

		assert.deepStrictEqual({ kept: sent && world.table.messages.textOf(sent), blank: blank.text }, {
			kept: '  a\n',
			blank: 'Argument \'task\' must not be empty.'
		});
	});

	test('stop_agent says of a child whose start it stopped as its worktree was being made - no terminal yet - that its start was stopped, and that git may still make its worktree: not that its terminal closed (O4; OR-05)', async () => {
		let made = () => { };
		world.git.making = new Promise<void>(resolve => made = resolve);
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const starting = contract.call(lead, 'start_agent', { name: 'clamp', cli: 'arg', task: 'Clamp.', new_worktree: true }, () => undefined);
		await until(() => world.table.get(2)?.phase === 'creating_worktree');
		const stopped = await call(lead, 'stop_agent', { agent: '#a2' });
		made();
		await starting;

		assert.deepStrictEqual({ text: stopped.text, startStopped: (stopped.data as { startStopped?: string }).startStopped }, {
			text: 'Stopped @clamp #a2: startup was stopped during worktree creation, before the CLI launched. Git may still finish creating its worktree; the worktree and branch will be kept.',
			startStopped: 'creating_worktree'
		});
	});

	test('stop_agent says of a child whose start it stopped as its worktree was set up - no terminal yet - that its start was stopped, its worktree staying: not that its terminal closed (O4; OR-05)', async () => {
		world.git.setup = new Promise(() => { });
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const starting = contract.call(lead, 'start_agent', { name: 'clamp', cli: 'arg', task: 'Clamp.', new_worktree: true }, () => undefined);
		await until(() => world.table.get(2)?.phase === 'running_setup');
		const stopped = await call(lead, 'stop_agent', { agent: '#a2' });
		await starting;

		assert.deepStrictEqual({ text: stopped.text, startStopped: (stopped.data as { startStopped?: string }).startStopped }, {
			text: 'Stopped @clamp #a2: startup was stopped during worktree setup, before the CLI launched. Its worktree is unchanged.',
			startStopped: 'running_setup'
		});
	});

	test('a start that failed once its agent had a number answers with what a start that started does - its name, creator, CLI, the model and effort asked for and applied, its folder and worktree, YOLO, sandbox, connection and task - status failed, in words and as data, with the agent, its outcome, the phase it had got to and the worktree made for it, which stays, in its folder (AGENT-ORCHESTRATION.md, O3, O2; OR-02)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		world.terminals.failNext = 'the window has no terminal for it';
		const result = await call(callerOf(world.agent(1)), 'start_agent', { name: 'clamp', cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', new_worktree: true });
		const { startTime, end } = world.agent(2);
		const clamp = worktreeFolder(lab, 'clamp');

		assert.deepStrictEqual({ isError: result.isError, text: result.text, data: result.data }, {
			isError: true,
			text: `Arg Code did not start as @clamp #a2: the window has no terminal for it.\nRun facts: Arg Code, small, high, YOLO on, sandbox off, folder ${clamp}, task #m2.\nWorktree clamp was created at ${clamp}; the worktree and branch have been kept. To reuse it, start an agent with folder set to this path. Delete it only if it is no longer needed.`,
			data: {
				code: 'FAILED', outcome: 'failed', agent: 2, phase: 'launching_cli', status: 'failed', newWorktree: true,
				id: 2, name: 'clamp', creator: 1, root: 1, cli: 'arg', custom: false, model: 'small', effort: 'high', ignored: [], yolo: true, sandbox: 'off', integration: true, connected: false,
				worktree: 'clamp', folder: clamp, state: 'ended', setup: 'none', startTime, taskMessage: 2, end
			}
		});
	});

	test('a start not confirmed while its worktree\'s setup runs - no terminal of its own yet - says where that setup is: the line running and the last lines of its setup terminal, in words and as data, for its creator to tell a slow install from one waiting on a prompt (AGENT-ORCHESTRATION.md, O3, O4; OR-03)', async () => {
		world.timing.startTimeoutMs = 5_000;
		world.git.setup = new Promise(() => { });
		const clamp = worktreeFolder(lab, 'clamp');
		world.git.setupStates.set(clamp, { running: 'npm ci', lines: ['npm ci', 'npm ERR! need auth: run npm login', 'Username:'] });
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const starting = contract.call(callerOf(world.agent(1)), 'start_agent', { name: 'clamp', cli: 'arg', task: 'Clamp.', new_worktree: true }, () => undefined);
		await sleep(6_000);
		const result = await starting;

		assert.deepStrictEqual({ text: result.text.slice(result.text.indexOf('Worktree setup is running')), settingUp: (result.data as { settingUp?: unknown }).settingUp, phase: (result.data as { phase?: string }).phase }, {
			text: ':',
			settingUp: { running: 'npm ci', lines: ['npm ci', 'npm ERR! need auth: run npm login', 'Username:'] },
			phase: 'running_setup'
		});
	});

	test('a failure is a result the model reads, marked as an error, its data one of five codes: an unknown tool, an argument a tool does not take, one missing or of the wrong kind, and what the core refuses; anything else is FAILED', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const results = [
			await call(lead, 'send', { to: '@human' }),
			await call(lead, 'start_agent', { name: 'go', cli: 'arg', model: 'small', effort: 'high', task: 'Go.', color: 'red' }),
			await call(lead, 'start_agent', 'arg'),
			await call(lead, 'start_agent', { cli: 'arg', model: 'small', effort: 'high', task: 'Go.' }),
			await call(lead, 'start_agent', { name: 'go', cli: 'arg', model: 'small', effort: 'high', task: ' ' }),
			await call(lead, 'start_agent', { name: 'go', cli: 'arg', model: 'small', effort: 'high', task: '' }),
			await call(lead, 'start_agent', { name: 'go', cli: 'arg', model: 7, task: 'Go.' }),
			await call(lead, 'start_agent', { name: 'go', cli: 'arg', effort: 5, task: 'Go.' }),
			await call(lead, 'start_agent', { name: 'go', cli: 'arg', model: 'small', effort: 'high', new_worktree: 'yes' }),
			await call(lead, 'list_agents', { all: 'yes' }),
			await call(lead, 'stop_agent', {}),
			await call(lead, 'stop_agent', { agent: '@human' }),
			await call(lead, 'stop_agent', { agent: '#a99' }),
			await call(lead, 'start_agent', { name: 'go', cli: 'nope', model: 'small', effort: 'high', task: 'Go.' })
		];
		world.facade.listAgents = () => {
			throw new Error('the ledger could not be read');
		};
		results.push(await call(lead, 'list_agents', {}));
		const error = (code: string, text: string) => ({ text, isError: true, data: { code } });

		assert.deepStrictEqual(results, [
			error('INVALID', 'Unknown tool \'send\'. Available tools: start_agent, list_agents, stop_agent, send_message, read_messages, read_screen, type_text, press_keys.'),
			error('INVALID', 'Unknown arguments for start_agent: color. Accepted arguments (? = optional): name, cli, model?, effort?, task?, folder?, new_worktree?.'),
			error('INVALID', 'Provide a JSON arguments object for start_agent. Accepted arguments (? = optional): name, cli, model?, effort?, task?, folder?, new_worktree?.'),
			error('INVALID', 'Argument \'name\' is required.'),
			error('INVALID', 'Argument \'task\' must not be empty.'),
			error('INVALID', 'Argument \'task\' must not be empty.'),
			error('INVALID', 'Argument \'model\' must be a string.'),
			error('INVALID', 'Argument \'effort\' must be a string.'),
			error('INVALID', 'Argument \'new_worktree\' must be a boolean.'),
			error('INVALID', 'Argument \'all\' must be a boolean.'),
			error('INVALID', 'Argument \'agent\' is required.'),
			error('REFUSED', '@human is the person and has no agent run to stop, read, or type into. Use send_message to contact them.'),
			error('NOT_FOUND', 'No agent has ID #a99. Call list_agents with all:true to see every reachable run.'),
			{ text: 'Unknown CLI or custom agent \'nope\'. Available to start: arg, told.', isError: true, data: { code: 'INVALID', phase: 'validating' } },
			error('FAILED', 'the ledger could not be read')
		]);
	});

	test('a start is validating until its agent is recorded: its caller hears so as the call is accepted, and one refused meanwhile says so in its data - the phase, and no agent: nothing was made for it (AGENT-ORCHESTRATION.md, O4, O2; OR-18)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const heard: string[] = [];
		const result = await contract.call(callerOf(world.agent(1)), 'start_agent', { name: 'go', cli: 'arg', task: 'Go.', folder: path.join(temp.dir, 'elsewhere') }, message => heard.push(message));

		assert.deepStrictEqual({ heard, isError: result.isError, data: result.data, agents: [...world.table.state.agents.keys()] }, {
			heard: ['Validating @go; no run has been recorded yet.'],
			isError: true,
			data: { code: 'NOT_FOUND', phase: 'validating' },
			agents: [1]
		});
	});
});
