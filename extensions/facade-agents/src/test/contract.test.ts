/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Contract } from '../contract/tools';
import { Caller, PERSON } from '../record/events';
import { ToolResult } from '../transport/protocol';
import { settled, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { tempDir } from './util';

const TOOLS = 'Your tools: spawn starts a child agent and answers with its number once it is up; ps lists you, your parent and your children, each with its number and state; kill ends one of your children. read_screen reads an agent\'s screen as its terminal draws it.';

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
			tools: ['spawn', 'ps', 'kill', 'read_screen'],
			cli: { type: 'string', enum: ['arg', 'told'], description: 'The CLI: arg (Arg Code), told (Told Code).' },
			model: { type: 'string', description: 'The model, as that CLI\'s --model option takes it.' },
			effort: { type: 'string', description: 'How hard it thinks, as that CLI takes it: low, medium, high and so on. The levels differ from CLI to CLI, and from model to model.' },
			instructions: [
				'You are @planner #2, a Told Code agent in Facade Code, started by @lead #1.',
				`You run in ${lab}: the worktree main. You are in that folder already: run commands there without cd.`,
				TOOLS
			],
			person: { name: 'you', instructions: ['You act as the person, @you, in Facade Code.', TOOLS] }
		});
	});

	test('the spawn tool requires a model and an effort beside the CLI and the task, and names no model or level of its own: the CLI is the one that knows them', () => {
		const spawn = JSON.parse(JSON.stringify(contract.hello(PERSON).tools[0])).inputSchema;

		assert.deepStrictEqual({ required: spawn.required, enums: [spawn.properties.model.enum, spawn.properties.effort.enum] }, {
			required: ['cli', 'model', 'effort', 'prompt'],
			enums: [undefined, undefined]
		});
	});

	test('spawn answers once the child is up, in words and as data; kill ends a child, and says of one that exited how it did; ps gives the caller\'s view of the agents, a line each, and the same as data, where an agent the person started has no parent\'s number', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const beside = await call(lead, 'spawn', { cli: 'arg', model: 'small', effort: 'high', prompt: 'Write the tests.', name: 'tests' });
		const inNew = await call(lead, 'spawn', { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp the widths.', worktree: 'new', name: 'clamp' });
		const killed = await call(lead, 'kill', { agent: '@tests' });
		const again = await call(lead, 'kill', { agent: '#2' });
		const ps = await call(lead, 'ps', {});
		const clamp = worktreeFolder(lab, 'clamp');

		assert.deepStrictEqual({ beside, inNew: inNew.text, killed: killed.text, again: again.text, ps: ps.text.split('\n'), rows: JSON.parse(JSON.stringify(ps.data)).agents.map((row: { id: number; parent?: number }) => `${row.id}<${Object.keys(row).includes('parent') ? row.parent : 'none'}`) }, {
			beside: { text: `Started @tests #2: Arg Code on small at high, in the worktree main at ${lab}. It is up and has its task.`, data: { id: 2, name: 'tests', cli: 'arg', model: 'small', effort: 'high', worktree: 'main', folder: lab, newWorktree: false } },
			inNew: `Started @clamp #3: Arg Code on small at high, in the new worktree clamp, on the new branch clamp, at ${clamp}. It is up and has its task.`,
			killed: 'Killed @tests #2: its terminal closed. Its worktree stays as it is.',
			again: '@tests #2 had exited already (killed: killed by @lead #1).',
			ps: [
				`@lead #1 (you)  parent the person  running  arg on large at high  worktree main at ${lab}  started ${timeOfDay(world.agent(1).startTime)}`,
				`@tests #2  parent #1  exited at ${timeOfDay(world.agent(2).exit?.time)} (killed: killed by @lead #1)  arg on small at high  worktree main at ${lab}  started ${timeOfDay(world.agent(2).startTime)}`,
				`@clamp #3  parent #1  running  arg on small at high  worktree clamp at ${clamp}  started ${timeOfDay(world.agent(3).startTime)}`
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
			error('INVALID', 'Unknown tool send. The tools: spawn, ps, kill, read_screen.'),
			error('INVALID', 'spawn takes cli, model, effort, prompt, worktree?, name?; not color.'),
			error('INVALID', 'spawn takes an object of arguments: cli, model, effort, prompt, worktree?, name?.'),
			error('INVALID', 'prompt is required.'),
			error('INVALID', 'prompt must not be empty.'),
			error('INVALID', 'model must be a string.'),
			error('INVALID', 'effort is required.'),
			error('INVALID', 'all must be true or false.'),
			error('INVALID', 'agent is required.'),
			error('REFUSED', '@you is the person, whom no agent ends.'),
			error('NOT_FOUND', 'No agent is #99: ps with all lists every agent this workspace has had.'),
			error('UNAVAILABLE', 'Facade cannot start nope here. It starts: arg, told.'),
			error('FAILED', 'the ledger could not be read')
		]);
	});
});
