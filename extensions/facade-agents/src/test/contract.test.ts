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

const TOOLS = 'Your tools: spawn starts a child agent and answers with its PID once it is up; ps lists you, your parent and your children, each with its PID and state; kill ends one of your children.';

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
			contract.hello(callerOf(world.process(world.table.state.lastPid)));
		}
		return settled(calling);
	}

	/** A time as ps gives it. */
	function timeOfDay(time: number | undefined): string {
		return new Date(time ?? 0).toTimeString().slice(0, 8);
	}

	test('a process\'s MCP server says hello: the process is running, and its model is given the tools - spawn offering the CLIs this machine has, with their first models - and who it is, who started it, and where it runs; the person acts as the person', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', prompt: 'Lead.', name: 'lead', folder: lab });
		const starting = world.facade.spawn(callerOf(world.process(2)), { cli: 'told', model: 'deep', prompt: 'Plan.', name: 'planner' });
		await until(() => world.terminals.launched.length === 2);
		const hello = contract.hello(callerOf(world.process(3)));
		const state = world.process(3).state;
		await settled(starting);
		const tools = JSON.parse(JSON.stringify(hello.tools));
		const person = contract.hello(PERSON);

		assert.deepStrictEqual({
			name: hello.name,
			state,
			tools: tools.map((tool: { name: string }) => tool.name),
			cli: tools[0].inputSchema.properties.cli,
			model: tools[0].inputSchema.properties.model,
			instructions: hello.instructions.split('\n'),
			person: { name: person.name, instructions: person.instructions.split('\n') }
		}, {
			name: 'planner',
			state: 'running',
			tools: ['spawn', 'ps', 'kill'],
			cli: { type: 'string', enum: ['arg', 'told'], description: 'The CLI: arg (Arg Code), told (Told Code).' },
			model: { type: 'string', description: 'One of that CLI\'s models, as small or large for arg; quick or deep for told.' },
			instructions: [
				'You are @planner, PID 3, a Told Code agent in Facade Code, started by @lead (PID 2).',
				`You run in ${lab}: the worktree main. You are in that folder already: run commands there without cd.`,
				TOOLS
			],
			person: { name: 'you', instructions: ['You act as the person, @you, PID 1, in Facade Code.', TOOLS] }
		});
	});

	test('spawn answers once the child is up, in words and as data; kill ends a child, and says of one that exited how it did; ps gives the caller\'s view of the table, a line each, and the same as data', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.process(2));
		const beside = await call(lead, 'spawn', { cli: 'arg', model: 'small', prompt: 'Write the tests.', name: 'tests' });
		const inNew = await call(lead, 'spawn', { cli: 'arg', model: 'small', prompt: 'Clamp the widths.', worktree: 'new', name: 'clamp' });
		const killed = await call(lead, 'kill', { agent: '@tests' });
		const again = await call(lead, 'kill', { agent: '3' });
		const ps = await call(lead, 'ps', {});
		const clamp = worktreeFolder(lab, 'clamp');

		assert.deepStrictEqual({ beside, inNew: inNew.text, killed: killed.text, again: again.text, ps: ps.text.split('\n'), rows: JSON.parse(JSON.stringify(ps.data)).processes.map((row: { pid: number }) => row.pid) }, {
			beside: { text: `Started @tests, PID 3: Arg Code on small, in the worktree main at ${lab}. It is up and has its task.`, data: { pid: 3, name: 'tests', cli: 'arg', model: 'small', worktree: 'main', folder: lab, newWorktree: false } },
			inNew: `Started @clamp, PID 4: Arg Code on small, in the new worktree clamp, on the new branch clamp, at ${clamp}. It is up and has its task.`,
			killed: 'Killed @tests, PID 3: its terminal closed. Its worktree stays as it is.',
			again: '@tests, PID 3, had exited already (killed: killed by @lead (PID 2)).',
			ps: [
				`PID 2 (you)  @lead  parent 1 (the person)  running  arg on large  worktree main at ${lab}  started ${timeOfDay(world.process(2).startTime)}`,
				`PID 3  @tests  parent 2  exited at ${timeOfDay(world.process(3).exit?.time)} (killed: killed by @lead (PID 2))  arg on small  worktree main at ${lab}  started ${timeOfDay(world.process(3).startTime)}`,
				`PID 4  @clamp  parent 2  running  arg on small  worktree clamp at ${clamp}  started ${timeOfDay(world.process(4).startTime)}`
			],
			rows: [2, 3, 4]
		});
	});

	test('a failure is a result the model reads, marked as an error, its data one of five codes: an unknown tool, an argument a tool does not take, one missing or of the wrong kind, and what the core refuses; anything else is FAILED', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.process(2));
		const results = [
			await call(lead, 'send', { to: '@you' }),
			await call(lead, 'spawn', { cli: 'arg', model: 'small', prompt: 'Go.', color: 'red' }),
			await call(lead, 'spawn', 'arg'),
			await call(lead, 'spawn', { cli: 'arg', model: 'small' }),
			await call(lead, 'spawn', { cli: 'arg', model: 'small', prompt: ' ' }),
			await call(lead, 'spawn', { cli: 'arg', model: 7, prompt: 'Go.' }),
			await call(lead, 'ps', { all: 'yes' }),
			await call(lead, 'kill', {}),
			await call(lead, 'kill', { agent: '1' }),
			await call(lead, 'kill', { agent: '99' }),
			await call(lead, 'spawn', { cli: 'nope', model: 'small', prompt: 'Go.' })
		];
		world.facade.ps = () => {
			throw new Error('the ledger could not be read');
		};
		results.push(await call(lead, 'ps', {}));
		const error = (code: string, text: string) => ({ text, isError: true, data: { code } });

		assert.deepStrictEqual(results, [
			error('INVALID', 'Unknown tool send. The tools: spawn, ps, kill.'),
			error('INVALID', 'spawn takes cli, model, prompt, worktree?, name?; not color.'),
			error('INVALID', 'spawn takes an object of arguments: cli, model, prompt, worktree?, name?.'),
			error('INVALID', 'prompt is required.'),
			error('INVALID', 'prompt must not be empty.'),
			error('INVALID', 'model must be a string.'),
			error('INVALID', 'all must be true or false.'),
			error('INVALID', 'agent is required.'),
			error('REFUSED', 'PID 1 is the person, whom no agent ends.'),
			error('NOT_FOUND', 'No process has PID 99: ps with all lists every process this workspace has had.'),
			error('UNAVAILABLE', 'Facade cannot start nope here. It starts: arg, told.'),
			error('FAILED', 'the ledger could not be read')
		]);
	});
});
