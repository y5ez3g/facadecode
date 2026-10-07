/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DeferredPromise } from '../base/async';
import { endText } from '../contract/listAgents';
import { PERSON } from '../record/events';
import { settled, sleep, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { outcomeOf, tempDir } from './util';

type World = ReturnType<typeof fakeWorld>;

/** What an agent that did not say hello in time fails with. */
const NO_HELLO = 'it did not come up within 120 seconds: its MCP server never said hello to Facade, so its CLI may be waiting for an answer in its terminal';

/** Every agent of the list, a line each: its number, name, creator, and state - how it ended, once it has. */
function agents(world: World): string[] {
	return world.facade.listAgents(PERSON, true).map(row => `#a${row.id} @${row.name} by ${row.creator === undefined ? '@human' : `#a${row.creator}`} ${row.end ? endText(row.end) : row.state}`);
}

/** What a folder holds, folders and files, by their paths in it with forward slashes. */
function listed(folder: string): string[] {
	return fs.readdirSync(folder, { recursive: true, encoding: 'utf8' }).map(each => each.split(path.sep).join('/')).sort();
}

/** What Arg Code's trust file holds, in `home`: undefined where there is none. */
function trustIn(home: string): unknown {
	const file = path.join(home, 'trust.json');
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

suite('Core: starting an agent, step by step', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-core-');
		lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['docs'] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	test('the person starts an agent in the folder on screen: #a1, named after its worktree, its CLI in a terminal of its own put in front, its first message the opening and then the task, and its token in its run folder; it is up once its MCP server says hello', async () => {
		const started = await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Tidy the docs.', folder: lab });
		const runs = world.table.runsDir;
		const config = path.join(runs, '1.config.json');

		assert.deepStrictEqual({
			started,
			launched: world.terminals.launched,
			config: JSON.parse(fs.readFileSync(config, 'utf8')),
			token: world.table.authenticate(fs.readFileSync(path.join(runs, '1.token'), 'utf8')),
			agents: agents(world),
			told: world.person.told
		}, {
			started: { id: 1, name: 'main', cli: 'arg', model: 'large', effort: 'high', worktree: 'main', folder: lab, newWorktree: false },
			launched: [{
				name: '@main #a1 · Arg Code',
				command: 'arg',
				executable: path.join(temp.dir, 'workspace', 'bin', 'arg.exe'),
				args: ['--config', config, '--model', 'large', '--effort', 'high', '--', '[facade] You are @main #a1, Arg Code, started by @human.\n\nTidy the docs.'],
				env: { ARG_QUIET: '1' },
				cwd: lab,
				reveal: true
			}],
			config: { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', path.join(runs, '1.token')], env: { ELECTRON_RUN_AS_NODE: '1' } },
			token: { id: 1, name: 'main' },
			agents: ['#a1 @main by @human running'],
			told: []
		});
	});

	test('an agent\'s child starts beside it, in its folder, without coming in front; its first message names its parent, and it is that agent\'s', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const started = await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Write the tests.', name: '@Tests' });
		const launch = world.terminals.launched[1];

		assert.deepStrictEqual({ started, name: launch.name, task: launch.args[launch.args.length - 1], cwd: launch.cwd, reveal: launch.reveal, agents: agents(world), told: world.person.told }, {
			started: { id: 2, name: 'tests', cli: 'arg', model: 'small', effort: 'high', worktree: 'main', folder: lab, newWorktree: false },
			name: '@tests #a2 · Arg Code',
			task: '[facade] You are @tests #a2, Arg Code, started by @main.\n\nWrite the tests.',
			cwd: lab,
			reveal: false,
			agents: ['#a1 @main by @human running', '#a2 @tests by #a1 running'],
			told: []
		});
	});

	test('a child in a new worktree: made from its parent\'s HEAD, on a branch of its name, recorded as Facade\'s, and its CLI given the person\'s trust there - merged into the file its launch names, where its terminal\'s environment says the CLI keeps it; once there, it is not written again', async () => {
		const home = path.join(temp.dir, 'arg-home');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, environment: () => ({ ARG_HOME: home }) });
		fs.mkdirSync(home);
		fs.writeFileSync(path.join(home, 'trust.json'), '{\n  "theme": "dark"\n}\n');
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const started = await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp the widths.', worktree: 'new', name: 'clamp' });
		const folder = worktreeFolder(lab, 'clamp');
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp again.', worktree: 'clamp', name: 'again' });
		const file = path.join(home, 'trust.json');

		assert.deepStrictEqual({
			started,
			steps: world.git.steps,
			made: world.table.madeWorktree(folder),
			trust: fs.readFileSync(file, 'utf8'),
			logged: world.logs.filter(line => line.includes(': Arg Code trust'))
		}, {
			started: { id: 2, name: 'clamp', cli: 'arg', model: 'small', effort: 'high', worktree: 'clamp', folder, newWorktree: true },
			steps: [`make clamp from aaaaaaa in ${lab}`],
			made: { name: 'clamp', folder, repository: lab, commit: 'a'.repeat(40), madeBy: 1 },
			// The rest of the file as it was, and its layout.
			trust: `{\n  "theme": "dark",\n  "trusted": [\n    ${JSON.stringify(lab)}\n  ]\n}\n`,
			logged: [
				`Facade merged ${JSON.stringify({ trusted: [lab] })} into ${file}: Arg Code trusts ${folder} now.`,
				`${file} has ${JSON.stringify({ trusted: [lab] })} already: Arg Code trusted ${folder} before.`
			]
		});
	});

	test('a new worktree the person starts an agent in is recorded as theirs: made by no agent', async () => {
		const started = await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Clamp.', worktree: 'new', name: 'clamp', folder: lab });

		assert.deepStrictEqual({ started: started.id, made: world.table.madeWorktree(worktreeFolder(lab, 'clamp')) }, {
			started: 1,
			made: { name: 'clamp', folder: worktreeFolder(lab, 'clamp'), repository: lab, commit: 'a'.repeat(40) }
		});
	});

	test('the trust goes where the CLI reads it as the person has it started - its launch\'s environment over the terminals\' - and a CLI this machine does not have is refused, saying why: its path setting names nothing, or its command is not on PATH', async () => {
		const terminalHome = path.join(temp.dir, 'terminal-home');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, clis: ['arg'], environment: () => ({ ARG_HOME: terminalHome }) });
		const own = path.join(temp.dir, 'own-home');
		world.settings.arg = { launch: { environment: { ARG_HOME: own } } };
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', worktree: 'new', name: 'clamp' });
		const unset = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'told', model: 'quick', effort: 'high', task: 'Plan.', folder: lab }));
		world.settings.told = { path: '/nowhere/told' };
		const misnamed = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'told', model: 'quick', effort: 'high', task: 'Plan.', folder: lab }));

		assert.deepStrictEqual({ own: trustIn(own), terminal: trustIn(terminalHome), unset, misnamed }, {
			own: { trusted: [lab] },
			terminal: undefined,
			unset: 'UNAVAILABLE: Facade cannot start told here: told is not on this machine\'s PATH, and facade.orchestration.told.path names no other. It starts: arg.',
			misnamed: 'UNAVAILABLE: Facade cannot start told here: facade.orchestration.told.path is "/nowhere/told", which is no file, nor a command on this machine\'s PATH. It starts: arg.'
		});
	});

	test('a CLI given its trust in its arguments is given them in a worktree Facade made, after its own way to connect, and nowhere else; a trust the person set to null is no trust: nothing is written, and the CLI asks', async () => {
		await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', task: 'Clamp.', worktree: 'new', name: 'clamp' });
		world.settings.told = { launch: { trust: null } };
		world.settings.arg = { launch: { trust: null } };
		await world.startUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', task: 'Again.', worktree: 'clamp', name: 'again' });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Arg.', worktree: 'clamp', name: 'arg' });

		assert.deepStrictEqual({ args: world.terminals.launched.slice(0, 3).map(launch => launch.args), argTrust: trustIn(path.join(temp.dir, 'workspace', 'arg-home')) }, {
			args: [['--model', 'deep', '--effort', 'high'], ['--trust-folder', '--model', 'deep', '--effort', 'high'], ['--model', 'deep', '--effort', 'high']],
			argTrust: undefined
		});
	});

	test('a child in a worktree of its parent\'s repository, by its name: named after it, and given no trust in a worktree Facade did not make', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const started = await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Fix the docs.', worktree: 'docs' });
		await world.startUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', task: 'Plan the docs.', worktree: 'docs' });

		assert.deepStrictEqual({ started, argTrust: trustIn(path.join(temp.dir, 'workspace', 'arg-home')), toldArgs: world.terminals.launched[2].args }, {
			started: { id: 2, name: 'docs', cli: 'arg', model: 'small', effort: 'high', worktree: 'docs', folder: worktreeFolder(lab, 'docs'), newWorktree: false },
			argTrust: undefined,
			toldArgs: ['--model', 'deep', '--effort', 'high']
		});
	});

	test('whatever can refuse a start refuses it before anything is made, and says what would be right: the CLI, the model and the effort, the name, the place', async () => {
		const plain = path.join(temp.dir, 'plain');
		const lead = { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.' };
		const refusals = [
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, cli: 'nope', folder: lab })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, model: ' ', folder: lab })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, effort: '', folder: lab })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, name: 'facade', folder: lab })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, name: 'two words', folder: lab })),
			await outcomeOf(world.facade.startAgent(PERSON, lead)),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, worktree: 'new', folder: lab })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, worktree: 'nope', folder: lab })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, worktree: 'docs', folder: plain }))
		];
		const unborn = fakeWorld(path.join(temp.dir, 'unborn'), { repositories: { [lab]: [] }, unborn: [lab] });
		try {
			refusals.push(await outcomeOf(unborn.facade.startAgent(PERSON, { ...lead, worktree: 'new', name: 'clamp', folder: lab })));
		} finally {
			unborn.dispose();
		}

		assert.deepStrictEqual({ refusals, agents: agents(world), launched: world.terminals.launched.length, steps: world.git.steps }, {
			refusals: [
				'UNAVAILABLE: Facade cannot start nope here. It starts: arg, told.',
				'INVALID: model is required: one of Arg Code\'s models, as Arg Code takes it.',
				'INVALID: effort is required: how hard the child thinks, as Arg Code takes it - low, medium, high and so on.',
				'INVALID: "facade" is reserved: choose another name.',
				'INVALID: "two words" is not a name: use up to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'INVALID: The person has no folder of their own: start an agent with Facade: Start Agent, in the folder on screen.',
				'INVALID: name is required with worktree "new": the new worktree\'s branch is named after the child.',
				'NOT_FOUND: No worktree of lab is called nope. Its worktrees: main, docs.',
				`REFUSED: ${plain} is in no git repository, so it has no worktrees: start the child there, without worktree.`,
				`REFUSED: ${lab} is on a branch with no commit yet, or one git cannot read: a new worktree starts at a commit.`
			],
			agents: [],
			launched: 0,
			steps: []
		});
	});

	test('the model and the effort go to the CLI as they are, a model or level it may not have included: the CLI is the one that knows which it has; list_agents and the record show them', async () => {
		const started = await world.startUp(PERSON, { cli: 'told', model: ' gemini-9-flash ', effort: ' ultra ', task: 'Plan.', folder: lab });

		assert.deepStrictEqual({ started: [started.model, started.effort], args: world.terminals.launched[0].args, row: world.facade.listAgents(PERSON).map(row => [row.model, row.effort]), recorded: world.agent(1).effort }, {
			started: ['gemini-9-flash', 'ultra'],
			args: ['--model', 'gemini-9-flash', '--effort', 'ultra'],
			row: [['gemini-9-flash', 'ultra']],
			recorded: 'ultra'
		});
	});

	test('nothing asks the person before a CLI\'s first agent: an agent\'s start of a CLI nobody started before starts it at once, at full access', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const first = await outcomeOf(world.startUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', task: 'Plan.' }));

		assert.deepStrictEqual({ first, agents: agents(world), told: world.person.told }, {
			first: 'fulfilled',
			agents: ['#a1 @main by @human running', '#a2 @main by #a1 running'],
			told: []
		});
	});

	test('anything that fails from the launch on ends the child as failed and closes its terminal, and start_agent says why: a launch the window fails, a CLI that ends as it starts, no hello within two minutes; the person who started it hears of it from the spawn alone', async () => {
		world.terminals.failNext = 'the window has no terminal for it';
		const launchFailed = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'One.', folder: lab }));
		const ending = world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Two.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.terminals.end('@main #a2 · Arg Code', { exitCode: 2, byThePerson: false });
		const ended = await outcomeOf(settled(ending));
		const silent = outcomeOf(world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Three.', folder: lab }));
		await until(() => world.terminals.launched.length === 2);
		await sleep(120_000);
		const timedOut = await silent;

		assert.deepStrictEqual({ launchFailed, ended, timedOut, agents: agents(world), typed: world.terminals.typed, told: world.person.told }, {
			launchFailed: 'FAILED: Arg Code did not start as @main #a1: the window has no terminal for it',
			ended: 'FAILED: Arg Code did not start as @main #a2: its CLI ended with exit code 2',
			timedOut: `FAILED: Arg Code did not start as @main #a3: ${NO_HELLO}`,
			agents: [
				'#a1 @main by @human failed: the window has no terminal for it',
				'#a2 @main by @human failed: its CLI ended with exit code 2',
				`#a3 @main by @human failed: ${NO_HELLO}`
			],
			typed: ['@main #a1 · Arg Code: [closed]', '@main #a3 · Arg Code: [closed]'],
			told: []
		});
	});

	test('a CLI told of its task in its terminal is typed the line that names its task file once its MCP server said hello, and Enter after its pause; start_agent answers after that', async () => {
		const starting = world.facade.startAgent(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Plan the release.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		const beforeHello = [...world.terminals.typed];
		world.hello(1);
		await until(() => world.terminals.typed.length > 0);
		const beforeEnter = [...world.terminals.typed];
		const started = await settled(starting);
		const taskFile = path.join(world.table.runsDir, '1.task.md');
		const line = `@main #a1 · Told Code: ${JSON.stringify(`[facade] Your task is in ${taskFile}: read that file, then do what it says.`)}`;
		const launch = world.terminals.launched[0];

		assert.deepStrictEqual({
			beforeHello,
			beforeEnter,
			typed: world.terminals.typed,
			task: fs.readFileSync(taskFile, 'utf8'),
			args: launch.args,
			agent: { pipe: launch.env.FACADE_AGENTS_PIPE, token: world.table.authenticate(launch.env.FACADE_AGENTS_TOKEN) },
			delivered: world.agent(1).task,
			id: started.id
		}, {
			beforeHello: [],
			beforeEnter: [line],
			typed: [line, `@main #a1 · Told Code: ${JSON.stringify('\r')}`],
			task: '[facade] You are @main #a1, Told Code, started by @human.\n\nPlan the release.',
			args: ['--model', 'deep', '--effort', 'high'],
			agent: { pipe: 'pipe', token: { id: 1, name: 'main' } },
			delivered: 'typed',
			id: 1
		});
	});

	test('the person\'s settings are read at each start, and change the next launch without a reload - its arguments and environment, the time it has to come up - and a `${name}` Facade has no value for, in the arguments or the trust, refuses the spawn before anything is made, saying which setting has it', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'One.', folder: lab });
		world.settings.arg = { launch: { arguments: { extra: ['--verbose'], effort: null }, environment: { ARG_QUIET: null, ARG_COLOR: 'never' } } };
		await world.startUp(PERSON, { cli: 'arg', model: 'huge', effort: 'high', task: 'Two.', folder: lab });
		world.settings.arg = { launch: { arguments: { extra: ['--home', '${home}'] } } };
		const inArguments = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Three.', worktree: 'new', name: 'three', folder: lab }));
		world.settings.arg = { launch: { trust: { file: '${nowhere}/trust.json' } } };
		const inTrust = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Three.', worktree: 'new', name: 'three', folder: lab }));
		world.settings.arg = {};
		world.timing.startTimeoutMs = 5_000;
		const slow = outcomeOf(world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Four.', folder: lab }));
		await until(() => world.terminals.launched.length === 3);
		await sleep(5_000);
		const [first, second] = world.terminals.launched;

		assert.deepStrictEqual({ first: [first.args.slice(2, 6), first.env], second: [second.args.slice(2, 5), second.env], inArguments, inTrust, made: world.git.steps, slow: await slow }, {
			first: [['--model', 'large', '--effort', 'high'], { ARG_QUIET: '1' }],
			second: [['--model', 'huge', '--verbose'], { ARG_COLOR: 'never' }],
			inArguments: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.orchestration.arg.launch.arguments.extra has ${home}, for which Facade has no value: it has ${config}, ${model}, ${effort}, ${task}.',
			inTrust: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.orchestration.arg.launch.trust.file has ${nowhere}, for which Facade has no value: it has ${home}, ${argHome}, ${repository}.',
			made: [],
			slow: 'FAILED: Arg Code did not start as @main #a3: it did not come up within 5 seconds: its MCP server never said hello to Facade, so its CLI may be waiting for an answer in its terminal'
		});
	});
});

suite('Core: list_agents and stop_agent', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-core-');
		lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	test('list_agents shows the caller, its creator and the agents it started, ended ones too, and every agent with all; an agent whose creator ended keeps it as its creator, and nobody takes it in', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'A.', name: 'a' });
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'B.', name: 'b' });
		await world.startUp(callerOf(world.agent(2)), { cli: 'arg', model: 'small', effort: 'high', task: 'C.', name: 'c' });
		const stopped = await world.facade.stopAgent(lead, '#a2');
		const seenBy = (id: number | undefined, all = false) => world.facade.listAgents(id === undefined ? PERSON : callerOf(world.agent(id)), all).map(row => `${row.id}<${row.creator ?? 'human'}`);

		assert.deepStrictEqual({
			stopped: { ...stopped, end: { ...stopped.end, time: 0 } },
			lead: seenBy(1),
			b: seenBy(3),
			c: seenBy(4),
			person: seenBy(undefined),
			all: seenBy(3, true),
			told: world.person.told
		}, {
			stopped: { id: 2, name: 'a', alreadyEnded: false, end: { kind: 'stopped', by: 1, reason: 'with stop_agent', time: 0 } },
			lead: ['1<human', '2<1', '3<1'],
			b: ['1<human', '3<1'],
			c: ['2<1', '4<2'],
			person: ['1<human'],
			all: ['1<human', '2<1', '3<1', '4<2'],
			told: []
		});
	});

	test('an agent stops only its own children, and @human any; the person is nobody\'s to stop; an agent is named by its number, as #a7, #7, a7 or 7, by a name one running agent has, or as Facade\'s words name it, its name that number\'s; a name more than one running agent has is refused, naming them; one that exited already says how', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'One.', name: 'twin' });
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'Two.', name: 'twin' });
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Alone.', name: 'solo', folder: lab });
		const solo = callerOf(world.agent(4));
		const done = (stopping: Promise<{ readonly id: number; readonly alreadyEnded: boolean }>) => outcomeOf(stopping.then(stopped => {
			if (stopped.alreadyEnded) {
				throw new Error(`#a${stopped.id} had exited already`);
			}
		}));
		const outcomes = [
			await done(world.facade.stopAgent(solo, '#a2')),
			await done(world.facade.stopAgent(lead, '@human')),
			await done(world.facade.stopAgent(lead, '#a99')),
			await done(world.facade.stopAgent(lead, '@nobody')),
			await done(world.facade.stopAgent(lead, '@twin')),
			await done(world.facade.stopAgent(lead, '@solo #a2')),
			await done(world.facade.stopAgent(lead, ' #a2 ')),
			await done(world.facade.stopAgent(lead, '2')),
			await done(world.facade.stopAgent(lead, '@Twin #a3')),
			await done(world.facade.stopAgent(PERSON, '@solo'))
		];

		assert.deepStrictEqual({ outcomes, agents: agents(world), typed: world.terminals.typed, told: world.person.told }, {
			outcomes: [
				'REFUSED: @twin #a2 is not your child: an agent stops only its own children, and @human any. You have no running children.',
				'INVALID: @human is the person, not an agent.',
				'NOT_FOUND: No agent is #a99: list_agents with all lists every agent this workspace has had.',
				'NOT_FOUND: No running agent is called @nobody: name an ended one by its number, which list_agents with all lists.',
				'INVALID: 2 running agents are called @twin: @twin #a2, @twin #a3. Name one by its number.',
				'INVALID: #a2 is @twin, not @solo: name it by its number alone, or by its name.',
				'fulfilled',
				'#a2 had exited already',
				'fulfilled',
				'fulfilled'
			],
			agents: [
				'#a1 @lead by @human running',
				'#a2 @twin by #a1 stopped by #a1: with stop_agent',
				'#a3 @twin by #a1 stopped by #a1: with stop_agent',
				'#a4 @solo by @human stopped by @human: with stop_agent'
			],
			typed: ['@twin #a2 · Arg Code: [closed]', '@twin #a3 · Arg Code: [closed]', '@solo #a4 · Arg Code: [closed]'],
			told: []
		});
	});

	test('a reference names an agent as #a7, #7, a7, 7, @name or @name #a7; a number of another kind, the person, and a bare number that an agent that has not exited is also called are refused, saying what they could be', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		for (const name of ['b', 'c', 'd', 'e', 'f', 'a3']) {
			await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'Wait.', name });
		}

		const outcomes: string[] = [];
		for (const reference of ['#a2', '#3', '4', 'a5', '@f #a6', 'a3', '#m7', '@human']) {
			outcomes.push(await outcomeOf(world.facade.stopAgent(lead, reference)));
		}

		assert.deepStrictEqual(outcomes, [
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'INVALID: a3 could be #a3 or the name of @a3 #a7: write #a3, or the name with its number.',
			'INVALID: #m7 is not an agent\'s number: agents are numbered #a1, #a2 and on.',
			'INVALID: @human is the person, not an agent.'
		]);
	});

	test('a stop whose terminal would not close is recorded all the same: the call answers, and the log says why', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		world.terminals.stop = async () => {
			throw new Error('the window did not answer');
		};
		const stopped = await world.facade.stopAgent(PERSON, '#a1');

		assert.deepStrictEqual({ alreadyEnded: stopped.alreadyEnded, agents: agents(world), logged: world.logs.includes('@main #a1 · Arg Code could not be closed: the window did not answer') }, {
			alreadyEnded: false,
			agents: ['#a1 @main by @human stopped by @human: with stop_agent'],
			logged: true
		});
	});
});

suite('Core: exits', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-core-');
		lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	test('a terminal the person closes is a stop by the person, of which they are not told; one that ends by itself is an exit, with its CLI\'s exit code where that is not 0, and the person hears of their own child\'s; an agent\'s child\'s exit its creator sees in list_agents', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'A.', name: 'a', folder: lab });
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'B.', name: 'b', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'C.', name: 'c' });
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'D.', name: 'd', folder: lab });
		world.terminals.end('@c #a3 · Arg Code', { exitCode: 0, byThePerson: false });
		world.terminals.end('@b #a2 · Arg Code', { exitCode: 1, byThePerson: false });
		world.terminals.end('@d #a4 · Arg Code', { byThePerson: false });
		world.terminals.end('@a #a1 · Arg Code', { byThePerson: true });

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: [
				'#a1 @a by @human stopped by @human: its tab was closed',
				'#a2 @b by @human exited: its CLI ended with exit code 1',
				'#a3 @c by #a1 exited: its CLI ended',
				'#a4 @d by @human exited: its terminal closed'
			],
			told: ['@b #a2 exited: its CLI ended with exit code 1.', '@d #a4 exited: its terminal closed.']
		});
	});

	test('an agent that exits leaves the agents it started running, itself still their creator: nobody takes them in, and nobody is told of them; one that exits while its child comes up leaves the child to come up all the same', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'A.', name: 'a' });
		const coming = world.facade.startAgent(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'B.', name: 'b' });
		await until(() => world.terminals.launched.length === 3);
		world.terminals.end('@lead #a1 · Arg Code', { exitCode: 0, byThePerson: false });
		world.hello(3);
		const started = await settled(coming);

		assert.deepStrictEqual({ started: started.id, agents: agents(world), seenByThePerson: world.facade.listAgents(PERSON).map(row => row.id), told: world.person.told }, {
			started: 3,
			agents: ['#a1 @lead by @human exited: its CLI ended', '#a2 @a by #a1 running', '#a3 @b by #a1 running'],
			seenByThePerson: [1],
			told: ['@lead #a1 exited: its CLI ended.']
		});
	});
});

suite('Core: after a reload', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let dir: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-core-');
		lab = path.join(temp.dir, 'lab');
		dir = path.join(temp.dir, 'workspace');
		fs.mkdirSync(lab);
		world = fakeWorld(dir, { repositories: { [lab]: [] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	/** The window reloads: the one before closes, and the one after finds the terminals named still running. */
	function reload(...running: string[]): World {
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] } });
		for (const name of running) {
			world.terminals.running.add(name);
		}
		return world;
	}

	/** The window crashes: the one after finds the lock the one before held, its process gone, and none of its terminals. */
	function crash(): World {
		world.dispose();
		fs.writeFileSync(path.join(dir, 'ledger.lock'), '424242 0123456789ab');
		world = fakeWorld(dir, { repositories: { [lab]: [] }, isRunning: () => false });
		return world;
	}

	test('the window that comes back finds its agents again: one whose terminal is gone is lost, one starting is waited for again - its hello brings it up - and one running stays so; a start that waited as the window went cannot say whether its child came up', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Up.', name: 'up', folder: lab });
		const slow = world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Slow.', name: 'slow', folder: lab });
		await until(() => world.terminals.launched.length === 2);
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Gone.', name: 'gone', folder: lab });
		const after = reload('@up #a1 · Arg Code', '@slow #a2 · Arg Code');
		const unknown = await outcomeOf(slow);
		await after.facade.recover();
		const recovered = agents(after);
		after.hello(2);

		assert.deepStrictEqual({ unknown, recovered, agents: agents(after), told: after.person.told }, {
			unknown: 'UNAVAILABLE: The window closed meanwhile: whether the agent came up is not known. list_agents says, once the window is back.',
			recovered: ['#a1 @up by @human running', '#a2 @slow by @human starting', '#a3 @gone by @human lost: its terminal was gone when Facade came back'],
			agents: ['#a1 @up by @human running', '#a2 @slow by @human running', '#a3 @gone by @human lost: its terminal was gone when Facade came back'],
			told: ['@gone #a3 was lost: its terminal was gone when Facade came back.']
		});
	});

	test('one found starting that does not say hello within two minutes fails, and its terminal closes; the person hears it did not start, no start being there to tell them', async () => {
		const starting = world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Slow.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		const after = reload('@main #a1 · Arg Code');
		await outcomeOf(starting);
		await after.facade.recover();
		await sleep(120_000);

		assert.deepStrictEqual({ agents: agents(after), typed: after.terminals.typed, told: after.person.told }, {
			agents: [`#a1 @main by @human failed: ${NO_HELLO}`],
			typed: ['@main #a1 · Arg Code: [closed]'],
			told: [`@main #a1 did not start: ${NO_HELLO}.`]
		});
	});

	test('one running but not yet told of its task - the window went between its hello and the line - is told once the window is back', async () => {
		const starting = world.facade.startAgent(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.hello(1);
		const after = reload('@main #a1 · Told Code');
		await outcomeOf(starting);
		await after.facade.recover();
		await sleep(1_000);
		const taskFile = path.join(after.table.runsDir, '1.task.md');

		assert.deepStrictEqual({ typed: after.terminals.typed, task: after.agent(1).task, agents: agents(after) }, {
			typed: [
				`@main #a1 · Told Code: ${JSON.stringify(`[facade] Your task is in ${taskFile}: read that file, then do what it says.`)}`,
				`@main #a1 · Told Code: ${JSON.stringify('\r')}`
			],
			task: 'typed',
			agents: ['#a1 @main by @human running']
		});
	});

	test('a worktree Facade made that is gone - deleted by the person, or by git - is its no more', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', worktree: 'new', name: 'clamp' });
		const folder = worktreeFolder(lab, 'clamp');
		const after = reload('@main #a1 · Arg Code');
		fs.rmSync(folder, { recursive: true, force: true });
		await after.facade.recover();

		assert.deepStrictEqual({ made: after.table.madeWorktree(folder), agents: agents(after) }, {
			made: undefined,
			agents: ['#a1 @main by @human running', '#a2 @clamp by #a1 lost: its terminal was gone when Facade came back']
		});
	});

	test('a window the person closed - quitting Facade, or closing the window - takes its agents with it: none comes back, each is stopped as the window went, and the person hears nothing', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', worktree: 'new', name: 'clamp' });
		const after = reload();
		await after.facade.recover();

		assert.deepStrictEqual({ agents: agents(after), told: after.person.told }, {
			agents: ['#a1 @main by @human stopped: its window went', '#a2 @clamp by #a1 stopped: its window went'],
			told: []
		});
	});

	test('a reload that brings none of the agents\' terminals back: nothing saw them end, so each is lost, as after a crash, and the person hears of their own', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', worktree: 'new', name: 'clamp' });
		const after = reload();
		await after.facade.recover(true);

		assert.deepStrictEqual({ agents: agents(after), told: after.person.told }, {
			agents: ['#a1 @main by @human lost: its terminal was gone when Facade came back', '#a2 @clamp by #a1 lost: its terminal was gone when Facade came back'],
			told: ['@main #a1 was lost: its terminal was gone when Facade came back.']
		});
	});

	test('another workspace\'s window that takes the agents once the window that had them was closed: those gone went with that window, stopped as it went, and the person hears nothing - though this window was reloaded', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		world.dispose();
		// A minute on, which another owner waits for
		const longAgo = new Date(Date.now() - 2 * 60_000);
		fs.utimesSync(path.join(dir, 'ledger.lock'), longAgo, longAgo);
		world = fakeWorld(dir, { repositories: { [lab]: [] }, owner: 'notes' });
		await world.facade.recover(true);

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#a1 @main by @human stopped: its window went'],
			told: []
		});
	});

	test('the extension host started again in the same load of the window - none of the agents\' terminals back - is no window closed: each is lost, and the person hears of it', async () => {
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, session: 'this-load' });
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, session: 'this-load' });
		await world.facade.recover();

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#a1 @main by @human lost: its terminal was gone when Facade came back'],
			told: ['@main #a1 was lost: its terminal was gone when Facade came back.']
		});
	});

	test('Facade turned off and on again, the window staying: an agent whose terminal ended meanwhile is lost, nothing having seen it end, and the person hears of it', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		world.dispose('facade');
		world = fakeWorld(dir, { repositories: { [lab]: [] } });
		await world.facade.recover();

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#a1 @main by @human lost: its terminal was gone when Facade came back'],
			told: ['@main #a1 was lost: its terminal was gone when Facade came back.']
		});
	});

	test('after a crash, one whose terminal is gone is lost, though none comes back: the person hears of an agent of theirs, and not of the agents it started', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', worktree: 'new', name: 'clamp' });
		const after = crash();
		await after.facade.recover();

		assert.deepStrictEqual({ agents: agents(after), told: after.person.told }, {
			agents: ['#a1 @main by @human lost: its terminal was gone when Facade came back', '#a2 @clamp by #a1 lost: its terminal was gone when Facade came back'],
			told: ['@main #a1 was lost: its terminal was gone when Facade came back.']
		});
	});
});

suite('Core: what Facade puts into a folder', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let mcp: string;
	let exclude: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-core-');
		lab = path.join(temp.dir, 'lab');
		mcp = path.join(lab, '.mcp.json');
		exclude = path.join(temp.dir, 'git', 'lab', 'info', 'exclude');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git') });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	/** As the agent's terminal ends by itself. */
	function exits(name: string, id: number, of = world): void {
		of.terminals.end(`@${name} #a${id} · Told Code`, { exitCode: 0, byThePerson: false });
	}

	test('the files a CLI reads from its folder are put there for its agents - kept out of git by lines in info/exclude, and a folder Facade made by a .gitignore of its own - and go once the last agent there ends', async () => {
		await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'One.', name: 'one', folder: lab });
		await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Two.', name: 'two', folder: lab });
		const whileTheyRun = listed(lab);
		const excluded = fs.readFileSync(exclude, 'utf8');
		const server = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		exits('one', 1);
		const whileOneRuns = listed(lab);
		exits('two', 2);

		assert.deepStrictEqual({ whileTheyRun, excluded, server, whileOneRuns, after: listed(lab), excludedAfter: fs.readFileSync(exclude, 'utf8'), record: fs.existsSync(path.join(temp.dir, 'workspace', 'injected.json')) }, {
			whileTheyRun: ['.mcp.json', '.told', '.told/.gitignore', '.told/skills', '.told/skills/facade', '.told/skills/facade/SKILL.md'],
			excluded: '/.mcp.json\n/.told/skills/facade/SKILL.md\n',
			server: { mcpServers: { facade: { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--agent'] } } },
			whileOneRuns: whileTheyRun,
			after: [],
			excludedAfter: '',
			record: false
		});
	});

	test('a .mcp.json of the person\'s own that git does not track gets Facade\'s server beside theirs, and no line in info/exclude, which would leave theirs for git to write over; it is theirs again, byte for byte, once the last agent there ends', async () => {
		const theirs = '{\n    "mcpServers": {\n        "docs": { "command": "docs-server" }\n    }\n}\n';
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
		const merged = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		const excluded = fs.readFileSync(exclude, 'utf8');
		exits('main', 1);

		assert.deepStrictEqual({ servers: Object.keys(merged.mcpServers), excluded, after: fs.readFileSync(mcp, 'utf8') === theirs, logged: world.logs.includes(`${mcp} is the person's: Facade's part is added to it while agents run there.`) }, {
			servers: ['docs', 'facade'],
			excluded: '/.told/skills/facade/SKILL.md\n',
			after: true,
			logged: true
		});
	});

	test('a file Facade would put there that git tracks, or one of the person\'s it cannot add its part to, refuses the launch with why, and nothing is put there', async () => {
		fs.writeFileSync(mcp, '{}');
		world.git.trackedFiles.add(mcp);
		const tracked = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab }));
		world.git.trackedFiles.clear();
		fs.writeFileSync(mcp, 'not JSON');
		const notJson = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Two.', folder: lab }));

		assert.deepStrictEqual({ tracked, notJson, left: listed(lab), theirs: fs.readFileSync(mcp, 'utf8'), launched: world.terminals.launched.length }, {
			tracked: `FAILED: Told Code did not start as @main #a1: Told Code is not started: ${mcp} is in the repository, and Facade would have to change it, so that a commit could take Facade's settings with it.`,
			notJson: `FAILED: Told Code did not start as @main #a2: Told Code is not started: ${mcp} is there already, and Facade does not write over it.`,
			left: ['.mcp.json'],
			theirs: 'not JSON',
			launched: 0
		});
	});

	test('the person\'s .mcp.json that they changed while agents ran keeps their change once the last agent there ends, and loses Facade\'s server; an agent started there after the change takes Facade\'s server for no part of theirs', async () => {
		fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { docs: { command: 'docs-server' } } }, undefined, 2));
		world.git.untrackedFiles.add(mcp);
		await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'One.', name: 'one', folder: lab });
		// The person adds a server of theirs while it runs.
		const merged = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { ...merged.mcpServers, lint: { command: 'lint-server' } } }, undefined, 2));
		const second = await outcomeOf(world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Two.', name: 'two', folder: lab }));
		const whileTwoRuns = Object.keys(JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers);
		exits('one', 1);
		exits('two', 2);

		assert.deepStrictEqual({ second, whileTwoRuns, after: JSON.parse(fs.readFileSync(mcp, 'utf8')) }, {
			second: 'fulfilled',
			whileTwoRuns: ['docs', 'lint', 'facade'],
			after: { mcpServers: { docs: { command: 'docs-server' }, lint: { command: 'lint-server' } } }
		});
	});

	test('the person\'s .mcp.json that is gone once the last agent there ends is kept for them beside the record, and they are told where', async () => {
		const theirs = '{ "mcpServers": {} }\n';
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
		fs.rmSync(mcp);
		world.terminals.end('@main #a1 · Told Code', { byThePerson: true });
		const keptDir = path.join(temp.dir, 'workspace', 'kept');
		const kept = fs.readdirSync(keptDir).map(name => path.join(keptDir, name));

		assert.deepStrictEqual({ kept: kept.map(file => fs.readFileSync(file, 'utf8')), told: world.person.told }, {
			kept: [theirs],
			told: [`${mcp} was gone when its agents exited: what it held before Facade's part went in is kept at ${kept[0]}.`]
		});
	});

	test('two windows on one folder: what one window\'s agents need there stays while the other window\'s end, and goes with the last of them', async () => {
		const injected = path.join(temp.dir, 'injected.json');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'one'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		const other = fakeWorld(path.join(temp.dir, 'two'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		try {
			await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
			await other.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Two.', folder: lab });
			const whileBothRun = listed(lab);
			exits('main', 1);
			const whileTheOtherRuns = listed(lab);
			exits('main', 1, other);

			assert.deepStrictEqual({ whileTheOtherRuns: whileTheOtherRuns.length === whileBothRun.length && whileBothRun.includes('.mcp.json'), after: listed(lab), record: fs.existsSync(injected) }, {
				whileTheOtherRuns: true,
				after: [],
				record: false
			});
		} finally {
			other.dispose();
		}
	});
});

suite('Core: when the window closes', () => {

	useFakeClock();

	let temp: { dir: string; remove(): void };
	let lab: string;
	let world: World;

	setup(() => {
		temp = tempDir('facade-core-');
		lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	test('a start that waits on git as the window closes starts nothing, records nothing, and says why; so does a stop', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const git = new DeferredPromise<void>();
		world.git.hold = git.p;
		const starting = world.facade.startAgent(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', worktree: 'main', folder: lab });
		await sleep(1_000);
		world.facade.dispose();
		git.complete();

		assert.deepStrictEqual({ spawn: await outcomeOf(starting), kill: await outcomeOf(world.facade.stopAgent(PERSON, '#a1')), agents: agents(world), launched: world.terminals.launched.length }, {
			spawn: 'UNAVAILABLE: The window closed meanwhile, and does nothing more: try again once it is open.',
			kill: 'UNAVAILABLE: The window closed meanwhile, and does nothing more: try again once it is open.',
			agents: ['#a1 @main by @human running'],
			launched: 1
		});
	});
});
