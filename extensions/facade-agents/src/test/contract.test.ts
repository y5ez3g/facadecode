/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Contract } from '../contract/tools';
import { Caller, PERSON } from '../record/events';
import { ResultListener } from '../transport/pipe';
import { ToolResult } from '../transport/protocol';
import { settled, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { tempDir } from './util';

const TOOLS = 'Your tools: spawn starts a child agent and answers with its number once its CLI has connected; ps lists you, your parent and your children, each with its number, its state and its mailbox; kill ends one of your children. read_screen reads an agent\'s screen as its terminal draws it; type_text types a line into its terminal and press_keys presses keys there, as the person does, for its CLI\'s own interface.';
const MESSAGES = 'Messages: send_message sends a message to agents, or to the person, @you, and answers at once with its number, as #m42: a reply comes to your mailbox. A line starting [facade] typed into your terminal says you have unread messages: call read_messages, and print the new ones before you act on them. Something for the person: print it whole first, then send it to @you. If an agent started you, message it when you are done, stuck, or need a decision; if the person did, answer them in your terminal. Ask in plain text or by message, never with your CLI\'s tool for questions with buttons. Do not poll or wait for a reply: end your turn.';
const PERSON_MESSAGES = 'Messages: send_message sends a message to agents and answers with its number, as #m42. Messages to you come as notifications; read_messages with all gives them again.';

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

	/**
	 * A tool call, answered as its caller's client gets it, its result written to that client: a child it
	 * starts says hello through the contract once its terminal is launched.
	 */
	async function call(caller: Caller, tool: string, args: unknown): Promise<ToolResult> {
		const launched = world.terminals.launched.length;
		const listeners: ResultListener[] = [];
		let over = false;
		const calling = contract.call(caller, tool, args, () => undefined, listener => listeners.push(listener));
		void calling.then(() => over = true);
		await until(() => over || world.terminals.launched.length > launched);
		if (!over) {
			contract.hello(callerOf(world.agent(world.table.state.lastId)));
		}
		const result = await settled(calling);
		for (const listener of listeners) {
			listener(true);
		}
		return result;
	}

	/** A time as ps gives it. */
	function timeOfDay(time: number | undefined): string {
		return new Date(time ?? 0).toTimeString().slice(0, 8);
	}

	test('an agent\'s MCP server says hello: the agent is running, and its model is given the tools - spawn offering the CLIs this machine has, and taking a model and an effort as those CLIs do - and who it is, who started it, and where it runs; the person acts as the person', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const starting = world.facade.spawn(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan.', name: 'planner' });
		await until(() => world.terminals.launched.length === 2);
		const hello = contract.hello(callerOf(world.agent(2)));
		const state = world.agent(2).state;
		await settled(starting);
		const tools = JSON.parse(JSON.stringify(hello.tools));
		const person = contract.hello(PERSON);

		assert.deepStrictEqual({
			name: hello.name,
			state,
			tools: tools.map((tool: { name: string }) => tool.name),
			cli: tools[0].inputSchema.properties.cli,
			model: tools[0].inputSchema.properties.model,
			effort: tools[0].inputSchema.properties.effort,
			instructions: hello.instructions.split('\n'),
			person: { name: person.name, instructions: person.instructions.split('\n') }
		}, {
			name: 'planner',
			state: 'running',
			tools: ['spawn', 'ps', 'kill', 'send_message', 'read_messages', 'read_screen', 'type_text', 'press_keys'],
			cli: { type: 'string', enum: ['arg', 'told'], description: 'The CLI: arg (Arg Code), told (Told Code).' },
			model: { type: 'string', description: 'The model, as that CLI\'s --model option takes it.' },
			effort: { type: 'string', description: 'How hard it thinks, as that CLI takes it: low, medium, high and so on. The levels differ from CLI to CLI, and from model to model.' },
			instructions: [
				'You are @planner #a2, a Told Code agent in Facade Code, started by @lead #a1.',
				`You run in ${lab}: the worktree main. You are in that folder already: run commands there without cd.`,
				TOOLS,
				MESSAGES
			],
			person: { name: 'you', instructions: ['You act as the person, @you, in Facade Code.', TOOLS, PERSON_MESSAGES] }
		});
	});

	test('the spawn tool requires a model and an effort beside the CLI and the task, and names no model or level of its own: the CLI is the one that knows them', () => {
		const spawn = JSON.parse(JSON.stringify(contract.hello(PERSON).tools[0])).inputSchema;

		assert.deepStrictEqual({ required: spawn.required, enums: [spawn.properties.model.enum, spawn.properties.effort.enum] }, {
			required: ['cli', 'model', 'effort', 'prompt'],
			enums: [undefined, undefined]
		});
	});

	test('spawn answers once the child\'s CLI has connected, with its task\'s number, in words and as data; kill ends a child, and says of one that exited how it did; ps gives the caller\'s view of the agents, a line each with its mailbox, and the same as data, where an agent the person started has no parent\'s number', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const beside = await call(lead, 'spawn', { cli: 'arg', model: 'small', effort: 'high', prompt: 'Write the tests.', name: 'tests' });
		const inNew = await call(lead, 'spawn', { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp the widths.', worktree: 'new', name: 'clamp' });
		const killed = await call(lead, 'kill', { agent: '@tests' });
		const again = await call(lead, 'kill', { agent: '#2' });
		const ps = await call(lead, 'ps', {});
		const clamp = worktreeFolder(lab, 'clamp');

		assert.deepStrictEqual({ beside, inNew: inNew.text, killed: killed.text, again: again.text, ps: ps.text.split('\n'), rows: JSON.parse(JSON.stringify(ps.data)).agents.map((row: { id: number; parent?: number }) => `${row.id}<${Object.keys(row).includes('parent') ? row.parent : 'none'}`) }, {
			beside: { text: `Started @tests #a2: Arg Code on small at high, in the worktree main at ${lab}. Its CLI has connected to Facade. Its task is message #m2, which it fetches itself: ps shows when it has.`, data: { id: 2, name: 'tests', cli: 'arg', model: 'small', effort: 'high', worktree: 'main', folder: lab, newWorktree: false, task: 2 } },
			inNew: `Started @clamp #a3: Arg Code on small at high, in the new worktree clamp, on the new branch clamp, at ${clamp}. Its CLI has connected to Facade. Its task is message #m3, which it fetches itself: ps shows when it has.`,
			killed: 'Killed @tests #a2: its terminal closed. Its worktree stays as it is.',
			again: '@tests #a2 had exited already (killed: killed by @lead #a1).',
			// The task @tests had not fetched went back to @lead as it ended
			ps: [
				`@lead #a1 (you)  parent the person  running  arg on large at high  worktree main at ${lab}  started ${timeOfDay(world.agent(1).startTime)}  mailbox: 2 unread: #m1 (@you, 0 min), #m4 (Facade, 0 min); 0 fetched; task #m1 not fetched yet`,
				`@tests #a2  parent #a1  exited at ${timeOfDay(world.agent(2).exit?.time)} (killed: killed by @lead #a1)  arg on small at high  worktree main at ${lab}  started ${timeOfDay(world.agent(2).startTime)}  mailbox: nothing unread; 0 fetched; task #m2 not fetched before it ended`,
				`@clamp #a3  parent #a1  running  arg on small at high  worktree clamp at ${clamp}  started ${timeOfDay(world.agent(3).startTime)}  mailbox: 1 unread: #m3 (@lead #a1, 0 min); 0 fetched; task #m3 not fetched yet`
			],
			rows: ['1<none', '2<1', '3<1']
		});
	});

	test('a failure is a result the model reads, marked as an error, its data one of five codes: an unknown tool, an argument a tool does not take, one missing or of the wrong kind, and what the core refuses; anything else is FAILED', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const results = [
			await call(lead, 'send', { to: '@you' }),
			await call(lead, 'spawn', { cli: 'arg', model: 'small', effort: 'high', prompt: 'Go.', color: 'red' }),
			await call(lead, 'spawn', 'arg'),
			await call(lead, 'spawn', { cli: 'arg', model: 'small', effort: 'high' }),
			await call(lead, 'spawn', { cli: 'arg', model: 'small', effort: 'high', prompt: ' ' }),
			await call(lead, 'spawn', { cli: 'arg', model: 7, prompt: 'Go.' }),
			await call(lead, 'spawn', { cli: 'arg', model: 'small', prompt: 'Go.' }),
			await call(lead, 'ps', { all: 'yes' }),
			await call(lead, 'kill', {}),
			await call(lead, 'kill', { agent: '@you' }),
			await call(lead, 'kill', { agent: '#99' }),
			await call(lead, 'spawn', { cli: 'nope', model: 'small', effort: 'high', prompt: 'Go.' })
		];
		world.facade.ps = () => {
			throw new Error('the ledger could not be read');
		};
		results.push(await call(lead, 'ps', {}));
		const error = (code: string, text: string) => ({ text, isError: true, data: { code } });

		assert.deepStrictEqual(results, [
			error('INVALID', 'Unknown tool send. The tools: spawn, ps, kill, send_message, read_messages, read_screen, type_text, press_keys.'),
			error('INVALID', 'spawn takes cli, model, effort, prompt, worktree?, name?; not color.'),
			error('INVALID', 'spawn takes an object of arguments: cli, model, effort, prompt, worktree?, name?.'),
			error('INVALID', 'prompt is required.'),
			error('INVALID', 'prompt must not be empty.'),
			error('INVALID', 'model must be a string.'),
			error('INVALID', 'effort is required.'),
			error('INVALID', 'all must be true or false.'),
			error('INVALID', 'agent is required.'),
			error('REFUSED', '@you is the person, whom no agent ends.'),
			error('NOT_FOUND', 'No agent is #a99: ps with all lists every agent this workspace has had.'),
			error('UNAVAILABLE', 'Facade cannot start nope here. It starts: arg, told.'),
			error('FAILED', 'the ledger could not be read')
		]);
	});
});
