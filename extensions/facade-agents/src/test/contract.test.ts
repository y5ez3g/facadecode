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
import { settled, sleep, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { tempDir } from './util';

const TOOLS = 'Your tools: start_agent starts an agent, in any folder of this window or a new worktree, and answers with its number once it has started; list_agents lists you, the agent that started you and the agents you started - with all, every agent you reach - and the CLIs you can start; stop_agent stops an agent you reach, and can delete its worktree.';

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

	test('an agent\'s MCP server says hello: the agent is connected, and its model is given the tools - start_agent offering the agents this machine can start, and taking a model and an effort as those CLIs do, if given - and who it is, who started it, its tree, where it runs and its YOLO; the person acts as the person, reaching every agent', async () => {
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
			state: 'starting',
			tools: ['start_agent', 'list_agents', 'stop_agent'],
			cli: { type: 'string', enum: ['arg', 'told'], description: 'The CLI, or a custom agent: arg (Arg Code), told (Told Code).' },
			model: { type: 'string', description: 'The model, as that CLI\'s --model option takes it. Omitted: the CLI\'s own default.' },
			effort: { type: 'string', description: 'How hard it thinks, as that CLI takes it: low, medium, high and so on. Omitted: the CLI\'s own default.' },
			instructions: [
				'You are @planner #a2, a Told Code agent in Facade Code, started by @lead #a1; your tree is #a1\'s.',
				`You run in ${lab}: the worktree main. You are in that folder already: run commands there without cd.`,
				'Your YOLO is on: you reach every agent of this window, and the agents you start have YOLO on.',
				TOOLS
			],
			person: { name: 'human', instructions: ['You act as the person, @human, in Facade Code, and reach every agent of this window.', TOOLS] }
		});
	});

	test('the start_agent tool requires a name and the CLI, the model, the effort, the task, the folder and a new worktree left to the caller, and names no model or level of its own: the CLI is the one that knows them', () => {
		const schema = JSON.parse(JSON.stringify(contract.hello(PERSON).tools[0])).inputSchema;

		assert.deepStrictEqual({ required: schema.required, optional: Object.keys(schema.properties).filter(name => !schema.required.includes(name)), enums: [schema.properties.model.enum, schema.properties.effort.enum] }, {
			required: ['name', 'cli'],
			optional: ['model', 'effort', 'task', 'folder', 'new_worktree'],
			enums: [undefined, undefined]
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
		const arg = (model: string, folder: string, message: number) => `Arg Code, ${model}, high, YOLO on, sandbox off, connected, in ${folder}, task #m${message} (argument)`;

		assert.deepStrictEqual({ beside: { text: beside.text, data: picked(beside.data) }, inNew: inNew.text, unconfirmed: { text: unconfirmed.text, data: picked(unconfirmed.data) }, stopped: stopped.text, again: again.text, listed: listed.text.split('\n'), rows: JSON.parse(JSON.stringify(listed.data)).agents.map((row: { id: number; creator?: number }) => `${row.id}<${Object.keys(row).includes('creator') ? row.creator : 'none'}`) }, {
			beside: {
				text: `Started @tests #a2 in the worktree main: ${arg('small', lab, 2)}.`,
				data: { status: 'started', id: 2, name: 'tests', creator: 1, root: 1, cli: 'arg', model: 'small', effort: 'high', ignored: [], yolo: true, sandbox: 'off', connected: true, worktree: 'main', folder: lab, newWorktree: false, taskMessage: 2, task: 'argument' }
			},
			inNew: `Started @clamp #a3 in the new worktree clamp (a new branch): ${arg('small', clamp, 3)}.`,
			unconfirmed: {
				text: `@waits #a4 is not confirmed to have started: it has not started within 5 seconds: its CLI is open but has not connected to Facade, and may be slow, or waiting for an answer on its screen. It stays starting - Told Code, deep, high, YOLO on, no sandbox, not connected yet, in ${lab}, no task - and may start yet: look at it with list_agents, or stop it with stop_agent; do not start it again.`,
				data: { status: 'unconfirmed', id: 4, name: 'waits', creator: 1, root: 1, cli: 'told', model: 'deep', effort: 'high', ignored: [], yolo: true, sandbox: 'unavailable', connected: false, worktree: 'main', folder: lab, newWorktree: false, task: 'none' }
			},
			stopped: 'Stopped @tests #a2: its terminal closed. Its worktree stays as it is.',
			again: '@tests #a2 had ended already (stopped by @lead #a1: with stop_agent).',
			listed: [
				'You are @lead #a1, YOLO on: you reach every agent of this window.',
				'3 agents: 2 running, 1 ended',
				`@lead #a1 (you)  by @human  tree #a1  running  worktree main  started ${timeOfDay(world.agent(1).startTime)}  ${arg('large', lab, 1)}`,
				`@tests #a2  by @lead #a1  tree #a1  ended at ${timeOfDay(world.agent(2).end?.time)} (stopped by @lead #a1: with stop_agent)  worktree main  started ${timeOfDay(world.agent(2).startTime)}  ${arg('small', lab, 2)}`,
				`@clamp #a3  by @lead #a1  tree #a1  running  worktree clamp  started ${timeOfDay(world.agent(3).startTime)}  ${arg('small', clamp, 3)}`,
				'CLIs you can start: arg (Arg Code): takes Facade tools, a task, a model, an effort; told (Told Code): takes Facade tools, a task, a model, an effort.'
			],
			rows: ['1<none', '2<1', '3<1']
		});
	});

	test('with the agent framework off every call - an agent\'s or the person\'s script\'s - answers at once that it is, doing nothing', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		world.switches.framework = false;
		const off = { text: 'Facade\'s tools are off: the person turned the agent framework off (facade.orchestration.enabled). Nothing was done; the agents running run on.', isError: true, data: { code: 'UNAVAILABLE', reason: 'framework_disabled' } };
		const results = [
			await contract.call(callerOf(world.agent(1)), 'list_agents', {}, () => undefined),
			await contract.call(PERSON, 'start_agent', { name: 'more', cli: 'arg' }, () => undefined),
			await contract.call(PERSON, 'stop_agent', { agent: '#a1' }, () => undefined)
		];

		assert.deepStrictEqual({ results, launched: world.terminals.launched.length, state: world.agent(1).state }, { results: [off, off, off], launched: 1, state: 'running' });
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
			error('INVALID', 'Unknown tool send. The tools: start_agent, list_agents, stop_agent.'),
			error('INVALID', 'start_agent takes name, cli, model?, effort?, task?, folder?, new_worktree?; not color.'),
			error('INVALID', 'start_agent takes an object of arguments: name, cli, model?, effort?, task?, folder?, new_worktree?.'),
			error('INVALID', 'name is required.'),
			error('INVALID', 'task must not be empty.'),
			error('INVALID', 'task must not be empty.'),
			error('INVALID', 'model must be a string.'),
			error('INVALID', 'effort must be a string.'),
			error('INVALID', 'new_worktree must be true or false.'),
			error('INVALID', 'all must be true or false.'),
			error('INVALID', 'agent is required.'),
			error('INVALID', '@human is the person, not an agent: the tools that manage agents do not take them.'),
			error('NOT_FOUND', 'No agent is #a99: list_agents with all lists every agent you reach.'),
			error('NOT_FOUND', 'nope is neither a CLI Facade starts nor a custom agent of the person\'s. It starts: arg, told.'),
			error('FAILED', 'the ledger could not be read')
		]);
	});
});
