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

const TOOLS = 'Your tools: start_agent starts a child agent and answers with its number once it is up; list_agents lists you, your parent and your children, each with its number and state; stop_agent stops one of your children.';

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

	test('an agent\'s MCP server says hello: the agent is running, and its model is given the tools - start_agent offering the CLIs this machine has, and taking a model and an effort as those CLIs do - and who it is, who started it, and where it runs; the person acts as the person', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const starting = world.facade.startAgent(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', name: 'planner' });
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
			tools: ['start_agent', 'list_agents', 'stop_agent'],
			cli: { type: 'string', enum: ['arg', 'told'], description: 'The CLI: arg (Arg Code), told (Told Code).' },
			model: { type: 'string', description: 'The model, as that CLI\'s --model option takes it.' },
			effort: { type: 'string', description: 'How hard it thinks, as that CLI takes it: low, medium, high and so on. The levels differ from CLI to CLI, and from model to model.' },
			instructions: [
				'You are @planner #a2, a Told Code agent in Facade Code, started by @lead #a1.',
				`You run in ${lab}: the worktree main. You are in that folder already: run commands there without cd.`,
				TOOLS
			],
			person: { name: 'human', instructions: ['You act as the person, @human, in Facade Code.', TOOLS] }
		});
	});

	test('the start_agent tool requires a model and an effort beside the CLI and the task, and names no model or level of its own: the CLI is the one that knows them', () => {
		const schema = JSON.parse(JSON.stringify(contract.hello(PERSON).tools[0])).inputSchema;

		assert.deepStrictEqual({ required: schema.required, enums: [schema.properties.model.enum, schema.properties.effort.enum] }, {
			required: ['cli', 'model', 'effort', 'task'],
			enums: [undefined, undefined]
		});
	});

	test('start_agent answers once the child is up, in words and as data; stop_agent stops a child, and says of one that exited how it did; list_agents gives the caller\'s view of the agents, a line each, and the same as data, where an agent the person started has no parent\'s number', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const beside = await call(lead, 'start_agent', { cli: 'arg', model: 'small', effort: 'high', task: 'Write the tests.', name: 'tests' });
		const inNew = await call(lead, 'start_agent', { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp the widths.', worktree: 'new', name: 'clamp' });
		const stopped = await call(lead, 'stop_agent', { agent: '@tests' });
		const again = await call(lead, 'stop_agent', { agent: '#a2' });
		const listed = await call(lead, 'list_agents', {});
		const clamp = worktreeFolder(lab, 'clamp');

		assert.deepStrictEqual({ beside, inNew: inNew.text, stopped: stopped.text, again: again.text, listed: listed.text.split('\n'), rows: JSON.parse(JSON.stringify(listed.data)).agents.map((row: { id: number; parent?: number }) => `${row.id}<${Object.keys(row).includes('parent') ? row.parent : 'none'}`) }, {
			beside: { text: `Started @tests #a2: Arg Code on small at high, in the worktree main at ${lab}. It is up and has its task.`, data: { id: 2, name: 'tests', cli: 'arg', model: 'small', effort: 'high', worktree: 'main', folder: lab, newWorktree: false } },
			inNew: `Started @clamp #a3: Arg Code on small at high, in the new worktree clamp, on the new branch clamp, at ${clamp}. It is up and has its task.`,
			stopped: 'Stopped @tests #a2: its terminal closed. Its worktree stays as it is.',
			again: '@tests #a2 had exited already (killed: stopped by @lead #a1).',
			listed: [
				`@lead #a1 (you)  parent @human  running  arg on large at high  worktree main at ${lab}  started ${timeOfDay(world.agent(1).startTime)}`,
				`@tests #a2  parent #a1  exited at ${timeOfDay(world.agent(2).exit?.time)} (killed: stopped by @lead #a1)  arg on small at high  worktree main at ${lab}  started ${timeOfDay(world.agent(2).startTime)}`,
				`@clamp #a3  parent #a1  running  arg on small at high  worktree clamp at ${clamp}  started ${timeOfDay(world.agent(3).startTime)}`
			],
			rows: ['1<none', '2<1', '3<1']
		});
	});

	test('a failure is a result the model reads, marked as an error, its data one of five codes: an unknown tool, an argument a tool does not take, one missing or of the wrong kind, and what the core refuses; anything else is FAILED', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const results = [
			await call(lead, 'send', { to: '@human' }),
			await call(lead, 'start_agent', { cli: 'arg', model: 'small', effort: 'high', task: 'Go.', color: 'red' }),
			await call(lead, 'start_agent', 'arg'),
			await call(lead, 'start_agent', { cli: 'arg', model: 'small', effort: 'high' }),
			await call(lead, 'start_agent', { cli: 'arg', model: 'small', effort: 'high', task: ' ' }),
			await call(lead, 'start_agent', { cli: 'arg', model: 7, task: 'Go.' }),
			await call(lead, 'start_agent', { cli: 'arg', model: 'small', task: 'Go.' }),
			await call(lead, 'list_agents', { all: 'yes' }),
			await call(lead, 'stop_agent', {}),
			await call(lead, 'stop_agent', { agent: '@human' }),
			await call(lead, 'stop_agent', { agent: '#a99' }),
			await call(lead, 'start_agent', { cli: 'nope', model: 'small', effort: 'high', task: 'Go.' })
		];
		world.facade.listAgents = () => {
			throw new Error('the ledger could not be read');
		};
		results.push(await call(lead, 'list_agents', {}));
		const error = (code: string, text: string) => ({ text, isError: true, data: { code } });

		assert.deepStrictEqual(results, [
			error('INVALID', 'Unknown tool send. The tools: start_agent, list_agents, stop_agent.'),
			error('INVALID', 'start_agent takes cli, model, effort, task, worktree?, name?; not color.'),
			error('INVALID', 'start_agent takes an object of arguments: cli, model, effort, task, worktree?, name?.'),
			error('INVALID', 'task is required.'),
			error('INVALID', 'task must not be empty.'),
			error('INVALID', 'model must be a string.'),
			error('INVALID', 'effort is required.'),
			error('INVALID', 'all must be true or false.'),
			error('INVALID', 'agent is required.'),
			error('INVALID', '@human is the person, not an agent.'),
			error('NOT_FOUND', 'No agent is #a99: list_agents with all lists every agent this workspace has had.'),
			error('UNAVAILABLE', 'Facade cannot start nope here. It starts: arg, told.'),
			error('FAILED', 'the ledger could not be read')
		]);
	});
});
