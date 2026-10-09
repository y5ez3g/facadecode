/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DeferredPromise } from '../base/async';
import { PERSON } from '../record/events';
import { settled, sleep, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { outcomeOf, tempDir } from './util';

type World = ReturnType<typeof fakeWorld>;

/** What an agent that did not say hello in time fails with. */
const NO_HELLO = 'it did not come up within 120 seconds: its MCP server never said hello to Facade. Its CLI may have been waiting for an answer in its terminal, which was closed with it: its last lines show where it stopped';

/** Every agent the workspace has had, a line each: its number, name, parent now, and state - how it exited, once it has. */
function agents(world: World): string[] {
	return world.facade.ps(PERSON, true).map(row => `#${row.id} @${row.name} parent ${row.parent === undefined ? 'the person' : `#${row.parent}`} ${row.exit ? `${row.exit.kind}: ${row.exit.reason}` : row.state}`);
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

suite('Core: spawn, step by step', () => {

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

	test('the person starts an agent in the folder on screen: #1, named after its worktree, its CLI in a terminal of its own put in front, its first line naming its task - a message from the person - and its token in its run folder; it is up once its MCP server says hello', async () => {
		const spawned = await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Tidy the docs.', folder: lab });
		const runs = world.table.runsDir;
		const config = path.join(runs, '1.config.json');
		const messages = path.join(temp.dir, 'workspace', 'messages');

		assert.deepStrictEqual({
			spawned,
			launched: world.terminals.launched,
			config: JSON.parse(fs.readFileSync(config, 'utf8')),
			token: world.table.authenticate(fs.readFileSync(path.join(runs, '1.token'), 'utf8')),
			agents: agents(world),
			told: world.person.told
		}, {
			spawned: { id: 1, name: 'main', cli: 'arg', model: 'large', effort: 'high', worktree: 'main', folder: lab, newWorktree: false, task: 1 },
			launched: [{
				name: '@main #1 · Arg Code',
				command: 'arg',
				executable: path.join(temp.dir, 'workspace', 'bin', 'arg.exe'),
				args: ['--config', config, '--no-asking', '--read', messages, '--yes', '--model', 'large', '--effort', 'high', '--', '[facade] You are @main #a1, created by @you. Your task is #m1.'],
				env: { ARG_QUIET: '1' },
				cwd: lab,
				reveal: true,
				run: 1,
				finalScreen: path.join(temp.dir, 'workspace', 'screens', 'a1.json')
			}],
			config: { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', path.join(runs, '1.token')], env: { ELECTRON_RUN_AS_NODE: '1' } },
			token: { id: 1, name: 'main' },
			agents: ['#1 @main parent the person running'],
			told: []
		});
	});

	test('an agent\'s child starts beside it, in its folder, without coming in front, with no tool for asking with buttons, as every agent; its first line names its creator and its task, a message from it; and it is that agent\'s', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		const spawned = await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Write the tests.', name: '@Tests' });
		const launch = world.terminals.launched[1];

		assert.deepStrictEqual({ spawned, name: launch.name, questions: [world.terminals.launched[0].args.includes('--no-asking'), launch.args.includes('--no-asking')], task: launch.args[launch.args.length - 1], from: world.table.state.mail.messages.get(2)?.from, cwd: launch.cwd, reveal: launch.reveal, agents: agents(world), told: world.person.told }, {
			spawned: { id: 2, name: 'tests', cli: 'arg', model: 'small', effort: 'high', worktree: 'main', folder: lab, newWorktree: false, task: 2 },
			name: '@tests #2 · Arg Code',
			questions: [true, true],
			task: '[facade] You are @tests #a2, created by @main. Your task is #m2.',
			from: 1,
			cwd: lab,
			reveal: false,
			agents: ['#1 @main parent the person running', '#2 @tests parent #1 running'],
			told: []
		});
	});

	test('a child in a new worktree: made from its parent\'s HEAD, on a branch of its name, recorded as Facade\'s, and its CLI given the person\'s trust there - merged into the file its launch names, where its terminal\'s environment says the CLI keeps it; once there, it is not written again', async () => {
		const home = path.join(temp.dir, 'arg-home');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, environment: () => ({ ARG_HOME: home }) });
		fs.mkdirSync(home);
		fs.writeFileSync(path.join(home, 'trust.json'), '{\n  "theme": "dark"\n}\n');
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		const spawned = await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp the widths.', worktree: 'new', name: 'clamp' });
		const folder = worktreeFolder(lab, 'clamp');
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp again.', worktree: 'clamp', name: 'again' });
		const file = path.join(home, 'trust.json');

		assert.deepStrictEqual({
			spawned,
			steps: world.git.steps,
			made: world.table.madeWorktree(folder),
			trust: fs.readFileSync(file, 'utf8'),
			logged: world.logs.filter(line => line.includes(': Arg Code trust'))
		}, {
			spawned: { id: 2, name: 'clamp', cli: 'arg', model: 'small', effort: 'high', worktree: 'clamp', folder, newWorktree: true, task: 2 },
			steps: [`make clamp from aaaaaaa in ${lab}`],
			made: { name: 'clamp', folder, repository: lab, parentWorktree: 'main', madeBy: 1 },
			// The rest of the file as it was, and its layout.
			trust: `{\n  "theme": "dark",\n  "trusted": [\n    ${JSON.stringify(lab)}\n  ]\n}\n`,
			logged: [
				`Facade merged ${JSON.stringify({ trusted: [lab] })} into ${file}: Arg Code trusts ${folder} now.`,
				`${file} has ${JSON.stringify({ trusted: [lab] })} already: Arg Code trusted ${folder} before.`
			]
		});
	});

	test('a new worktree the person starts an agent in is recorded as theirs: made by no agent', async () => {
		const spawned = await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp', folder: lab });

		assert.deepStrictEqual({ spawned: spawned.id, made: world.table.madeWorktree(worktreeFolder(lab, 'clamp')) }, {
			spawned: 1,
			made: { name: 'clamp', folder: worktreeFolder(lab, 'clamp'), repository: lab, parentWorktree: 'main' }
		});
	});

	test('the trust goes where the CLI reads it as the person has it started - its launch\'s environment over the terminals\' - and a CLI this machine does not have is refused, saying why: its path setting names nothing, or its command is not on PATH', async () => {
		const terminalHome = path.join(temp.dir, 'terminal-home');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, clis: ['arg'], environment: () => ({ ARG_HOME: terminalHome }) });
		const own = path.join(temp.dir, 'own-home');
		world.settings.arg = { launch: { environment: { ARG_HOME: own } } };
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
		const unset = await outcomeOf(world.facade.spawn(PERSON, { cli: 'told', model: 'quick', effort: 'high', prompt: 'Plan.', folder: lab }));
		world.settings.told = { path: '/nowhere/told' };
		const misnamed = await outcomeOf(world.facade.spawn(PERSON, { cli: 'told', model: 'quick', effort: 'high', prompt: 'Plan.', folder: lab }));

		assert.deepStrictEqual({ own: trustIn(own), terminal: trustIn(terminalHome), unset, misnamed }, {
			own: { trusted: [lab] },
			terminal: undefined,
			unset: 'UNAVAILABLE: Facade cannot start told here: told is not on this machine\'s PATH, and facade.orchestration.told.path names no other. It starts: arg.',
			misnamed: 'UNAVAILABLE: Facade cannot start told here: facade.orchestration.told.path is "/nowhere/told", which is no file, nor a command on this machine\'s PATH. It starts: arg.'
		});
	});

	test('a CLI given its trust in its arguments is given them in a worktree Facade made, after its own way to connect, and nowhere else; a trust the person set to null is no trust: nothing is written, and the CLI asks', async () => {
		await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Lead.', folder: lab });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
		world.settings.told = { launch: { trust: null } };
		world.settings.arg = { launch: { trust: null } };
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Again.', worktree: 'clamp', name: 'again' });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Arg.', worktree: 'clamp', name: 'arg' });

		assert.deepStrictEqual({ args: world.terminals.launched.slice(0, 3).map(launch => launch.args), argTrust: trustIn(path.join(temp.dir, 'workspace', 'arg-home')) }, {
			args: [['--yes', '--model', 'deep', '--effort', 'high'], ['--trust-folder', '--yes', '--model', 'deep', '--effort', 'high'], ['--yes', '--model', 'deep', '--effort', 'high']],
			argTrust: undefined
		});
	});

	test('a child in a worktree of its parent\'s repository, by its name: named after it, and given no trust in a worktree Facade did not make', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		const spawned = await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Fix the docs.', worktree: 'docs' });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan the docs.', worktree: 'docs' });

		assert.deepStrictEqual({ spawned, argTrust: trustIn(path.join(temp.dir, 'workspace', 'arg-home')), toldArgs: world.terminals.launched[2].args }, {
			spawned: { id: 2, name: 'docs', cli: 'arg', model: 'small', effort: 'high', worktree: 'docs', folder: worktreeFolder(lab, 'docs'), newWorktree: false, task: 2 },
			argTrust: undefined,
			toldArgs: ['--yes', '--model', 'deep', '--effort', 'high']
		});
	});

	test('whatever can refuse a spawn refuses it before anything is made, and says what would be right: the CLI, the model and the effort, the name, the place', async () => {
		const plain = path.join(temp.dir, 'plain');
		const lead = { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.' };
		const refusals = [
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, cli: 'nope', folder: lab })),
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, model: ' ', folder: lab })),
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, effort: '', folder: lab })),
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, name: 'facade', folder: lab })),
			// The person, as messages may name them
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, name: '@Human', folder: lab })),
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, name: 'two words', folder: lab })),
			await outcomeOf(world.facade.spawn(PERSON, lead)),
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, worktree: 'new', folder: lab })),
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, worktree: 'nope', folder: lab })),
			await outcomeOf(world.facade.spawn(PERSON, { ...lead, worktree: 'docs', folder: plain }))
		];
		const unborn = fakeWorld(path.join(temp.dir, 'unborn'), { repositories: { [lab]: [] }, unborn: [lab] });
		try {
			refusals.push(await outcomeOf(unborn.facade.spawn(PERSON, { ...lead, worktree: 'new', name: 'clamp', folder: lab })));
		} finally {
			unborn.dispose();
		}

		assert.deepStrictEqual({ refusals, agents: agents(world), launched: world.terminals.launched.length, steps: world.git.steps }, {
			refusals: [
				'UNAVAILABLE: Facade cannot start nope here. It starts: arg, told.',
				'INVALID: model is required: one of Arg Code\'s models, as Arg Code takes it.',
				'INVALID: effort is required: how hard the child thinks, as Arg Code takes it - low, medium, high and so on.',
				'INVALID: "facade" is reserved: choose another name.',
				'INVALID: "human" is reserved: choose another name.',
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

	test('the model and the effort go to the CLI as they are, a model or level it may not have included: the CLI is the one that knows which it has; ps and the record show them', async () => {
		const spawned = await world.spawnUp(PERSON, { cli: 'told', model: ' gemini-9-flash ', effort: ' ultra ', prompt: 'Plan.', folder: lab });

		assert.deepStrictEqual({ spawned: [spawned.model, spawned.effort], args: world.terminals.launched[0].args, row: world.facade.ps(PERSON).map(row => [row.model, row.effort]), recorded: world.agent(1).effort }, {
			spawned: ['gemini-9-flash', 'ultra'],
			args: ['--yes', '--model', 'gemini-9-flash', '--effort', 'ultra'],
			row: [['gemini-9-flash', 'ultra']],
			recorded: 'ultra'
		});
	});

	test('nothing asks the person before a CLI\'s first agent: an agent\'s spawn of a CLI nobody started before starts it at once, at full access', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		const first = await outcomeOf(world.spawnUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan.' }));

		assert.deepStrictEqual({ first, agents: agents(world), told: world.person.told }, {
			first: 'fulfilled',
			agents: ['#1 @main parent the person running', '#2 @main parent #1 running'],
			told: []
		});
	});

	test('anything that fails from the launch on ends the child as failed and closes its terminal, and the spawn says why: a launch the window fails, a CLI that ends as it starts, no hello within two minutes; the person who started it hears of it from the spawn alone', async () => {
		world.terminals.failNext = 'the window has no terminal for it';
		const launchFailed = await outcomeOf(world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'One.', folder: lab }));
		const ending = world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Two.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.terminals.end('@main #2 · Arg Code', { exitCode: 2, byThePerson: false });
		const ended = await outcomeOf(settled(ending));
		const silent = outcomeOf(world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Three.', folder: lab }));
		await until(() => world.terminals.launched.length === 2);
		await sleep(120_000);
		const timedOut = await silent;
		await sleep(2_000);

		assert.deepStrictEqual({ launchFailed, ended, timedOut, agents: agents(world), typed: world.terminals.typed, told: world.person.told, notified: world.person.notified.map(each => each.text) }, {
			launchFailed: 'FAILED: Arg Code did not start as @main #a1: the window has no terminal for it',
			ended: 'FAILED: Arg Code did not start as @main #a2: its CLI ended with exit code 2',
			timedOut: `FAILED: Arg Code did not start as @main #a3: ${NO_HELLO}`,
			agents: [
				'#1 @main parent the person failed: the window has no terminal for it',
				'#2 @main parent the person failed: its CLI ended with exit code 2',
				`#3 @main parent the person failed: ${NO_HELLO}`
			],
			typed: ['@main #1 · Arg Code: [closed]', '@main #3 · Arg Code: [closed]'],
			told: [],
			notified: []
		});
	});

	test('a CLI whose first conversation has no MCP tools is up once its MCP server said hello, and the spawn answers then; its doorbell types its first line, which names its task, a moment on, and Enter after its pause: its task\'s first ring', async () => {
		const spawning = world.facade.spawn(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan the release.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.hello(1);
		const spawned = await settled(spawning);
		const atAnswer = [...world.terminals.typed];
		await sleep(2_000);
		const line = `@main #1 · Told Code: type ${JSON.stringify('[facade] You are @main #a1, created by @you. Your task is #m1.')}, Enter after 400 ms`;
		const launch = world.terminals.launched[0];

		assert.deepStrictEqual({
			spawned: [spawned.id, spawned.task],
			atAnswer,
			typed: world.terminals.typed,
			task: world.table.state.mail.messages.get(1),
			rings: world.table.state.mail.entries.get(1)?.rings,
			args: launch.args,
			agent: { pipe: launch.env.FACADE_AGENTS_PIPE, token: world.table.authenticate(launch.env.FACADE_AGENTS_TOKEN) }
		}, {
			spawned: [1, 1],
			atAnswer: [],
			typed: [line],
			task: { id: 1, to: 1, text: 'Plan the release.', length: 17, task: true, time: world.table.state.mail.messages.get(1)?.time },
			rings: 1,
			args: ['--yes', '--model', 'deep', '--effort', 'high'],
			agent: { pipe: 'pipe', token: { id: 1, name: 'main' } }
		});
	});

	test('the person\'s settings are read at each spawn, and change the next launch without a reload - its arguments and environment, the time it has to come up - and a `${name}` Facade has no value for, in the arguments or the trust, refuses the spawn before anything is made, saying which setting has it', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'One.', folder: lab });
		world.settings.arg = { launch: { arguments: { extra: ['--verbose'], effort: null }, environment: { ARG_QUIET: null, ARG_COLOR: 'never' } } };
		await world.spawnUp(PERSON, { cli: 'arg', model: 'huge', effort: 'high', prompt: 'Two.', folder: lab });
		world.settings.arg = { launch: { arguments: { extra: ['--home', '${home}'] } } };
		const inArguments = await outcomeOf(world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Three.', worktree: 'new', name: 'three', folder: lab }));
		world.settings.arg = { launch: { trust: { file: '${nowhere}/trust.json' } } };
		const inTrust = await outcomeOf(world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Three.', worktree: 'new', name: 'three', folder: lab }));
		world.settings.arg = {};
		world.timing.startTimeoutMs = 5_000;
		const slow = outcomeOf(world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Four.', folder: lab }));
		await until(() => world.terminals.launched.length === 3);
		await sleep(5_000);
		const [first, second] = world.terminals.launched;

		assert.deepStrictEqual({ first: [first.args.slice(6, 10), first.env], second: [second.args.slice(6, 9), second.env], inArguments, inTrust, made: world.git.steps, slow: await slow }, {
			first: [['--model', 'large', '--effort', 'high'], { ARG_QUIET: '1' }],
			second: [['--model', 'huge', '--verbose'], { ARG_COLOR: 'never' }],
			inArguments: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.orchestration.arg.launch.arguments.extra has ${home}, for which Facade has no value: it has ${config}, ${messagesDir}, ${screensDir}, ${model}, ${effort}, ${task}.',
			inTrust: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.orchestration.arg.launch.trust.file has ${nowhere}, for which Facade has no value: it has ${home}, ${argHome}, ${repository}.',
			made: [],
			slow: 'FAILED: Arg Code did not start as @main #a3: it did not come up within 5 seconds: its MCP server never said hello to Facade. Its CLI may have been waiting for an answer in its terminal, which was closed with it: its last lines show where it stopped'
		});
	});
});

suite('Core: ps and kill', () => {

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

	test('ps shows the caller, its parent and its children - those it spawned, exited ones too, and those that are its own now - and every agent with all; once the agent that spawned a child exited, its parent is the person', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'A.', name: 'a' });
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'B.', name: 'b' });
		await world.spawnUp(callerOf(world.agent(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'C.', name: 'c' });
		const killed = await world.facade.kill(lead, '#2');
		const seenBy = (id: number | undefined, all = false) => world.facade.ps(id === undefined ? PERSON : callerOf(world.agent(id)), all).map(row => `${row.id}<${row.parent ?? 'you'}`);

		assert.deepStrictEqual({
			killed: { ...killed, exit: { ...killed.exit, time: 0 } },
			lead: seenBy(1),
			b: seenBy(3),
			c: seenBy(4),
			person: seenBy(undefined),
			all: seenBy(3, true),
			told: world.person.told
		}, {
			killed: { id: 2, name: 'a', alreadyExited: false, exit: { kind: 'killed', reason: 'killed by @lead #a1', time: 0 } },
			lead: ['1<you', '2<1', '3<1'],
			b: ['1<you', '3<1'],
			c: ['4<you'],
			person: ['1<you', '4<you'],
			all: ['1<you', '2<1', '3<1', '4<you'],
			told: ['@a #a2 ended, and its children are yours now: @c #a4. (@c #4 · Arg Code)']
		});
	});

	test('an agent kills only its own children, and the person any; the person is nobody\'s to kill; an agent is named by its number, with or without #, by a name one running agent has, or as Facade\'s words name it, its name that number\'s; a name more than one running agent has is refused, naming them; one that exited already says how', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'One.', name: 'twin' });
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'Two.', name: 'twin' });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Alone.', name: 'solo', folder: lab });
		const solo = callerOf(world.agent(4));
		const done = (killing: Promise<{ readonly id: number; readonly alreadyExited: boolean }>) => outcomeOf(killing.then(killed => {
			if (killed.alreadyExited) {
				throw new Error(`#${killed.id} had exited already`);
			}
		}));
		const outcomes = [
			await done(world.facade.kill(solo, '#2')),
			await done(world.facade.kill(lead, '@you')),
			await done(world.facade.kill(lead, '#99')),
			await done(world.facade.kill(lead, '@nobody')),
			await done(world.facade.kill(lead, '@twin')),
			await done(world.facade.kill(lead, '@solo #2')),
			await done(world.facade.kill(lead, ' #2 ')),
			await done(world.facade.kill(lead, '2')),
			await done(world.facade.kill(lead, '@Twin #3')),
			await done(world.facade.kill(PERSON, '@solo'))
		];

		assert.deepStrictEqual({ outcomes, agents: agents(world), typed: world.terminals.typed, told: world.person.told }, {
			outcomes: [
				'REFUSED: @twin #a2 is not your child: an agent kills only its own children, and the person any. You have no running children.',
				'REFUSED: @you is the person, whom no agent ends.',
				'NOT_FOUND: No agent is #a99: ps with all lists every agent this workspace has had.',
				'NOT_FOUND: No running agent is called @nobody: name an exited one by its number, which ps with all lists.',
				'INVALID: 2 running agents are called @twin: @twin #a2, @twin #a3. Name one by its number.',
				'INVALID: #a2 is @twin, not @solo: name it by its number alone, or by its name.',
				'fulfilled',
				'#2 had exited already',
				'fulfilled',
				'fulfilled'
			],
			agents: [
				'#1 @lead parent the person running',
				'#2 @twin parent #1 killed: killed by @lead #a1',
				'#3 @twin parent #1 killed: killed by @lead #a1',
				'#4 @solo parent the person killed: killed by the person'
			],
			typed: ['@twin #2 · Arg Code: [closed]', '@twin #3 · Arg Code: [closed]', '@solo #4 · Arg Code: [closed]'],
			told: []
		});
	});

	test('a kill whose terminal would not close is recorded all the same: the call answers, and the log says why', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		world.terminals.stop = async () => {
			throw new Error('the window did not answer');
		};
		const killed = await world.facade.kill(PERSON, '#1');

		assert.deepStrictEqual({ alreadyExited: killed.alreadyExited, agents: agents(world), logged: world.logs.includes('@main #1 · Arg Code could not be closed: the window did not answer') }, {
			alreadyExited: false,
			agents: ['#1 @main parent the person killed: killed by the person'],
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

	test('a terminal the person closes is a kill by the person; one that ends by itself is an exit, with its CLI\'s exit code where that is not 0; the person hears of their own agents\' unexpected ends - an exit code other than 0 - gathered in one notification, whose Show shows each, and of no other; an agent\'s child\'s exit its parent sees in ps', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'A.', name: 'a', folder: lab });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'B.', name: 'b', folder: lab });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'C.', name: 'c' });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'D.', name: 'd', folder: lab });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'E.', name: 'e', folder: lab });
		// Their tasks fetched: none goes back as they end
		for (const id of [1, 2, 3, 4, 5]) {
			await world.fetched(id);
		}
		world.terminals.end('@c #3 · Arg Code', { exitCode: 0, byThePerson: false });
		world.terminals.end('@b #2 · Arg Code', { exitCode: 1, byThePerson: false });
		world.terminals.end('@d #4 · Arg Code', { byThePerson: false });
		world.terminals.end('@a #1 · Arg Code', { byThePerson: true });
		world.terminals.end('@e #5 · Arg Code', { exitCode: 3, byThePerson: false });
		await sleep(1_000);
		const notified = world.person.notified.map(each => [each.text, each.buttons]);
		world.person.press(world.person.notified[0]?.key ?? '', 'Show');
		await sleep(0);

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told, notified, shown: world.person.ended.map(agent => agent.terminal) }, {
			agents: [
				'#1 @a parent the person killed: the person closed its terminal',
				'#2 @b parent the person exited: its CLI ended with exit code 1',
				'#3 @c parent the person exited: its CLI ended',
				'#4 @d parent the person exited: its terminal closed',
				'#5 @e parent the person exited: its CLI ended with exit code 3'
			],
			told: [],
			notified: [['@b #a2 ended: it exited, with exit code 1. @e #a5 ended: it exited, with exit code 3.', ['Show']]],
			shown: ['@b #2 · Arg Code', '@e #5 · Arg Code']
		});
	});

	test('an agent that exits leaves its running children to the person, who is told once, with the way to the first of them; so does one that exits while its child comes up, which the child does all the same', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'A.', name: 'a' });
		const coming = world.facade.spawn(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'B.', name: 'b' });
		await until(() => world.terminals.launched.length === 3);
		world.terminals.end('@lead #1 · Arg Code', { exitCode: 0, byThePerson: false });
		world.hello(3);
		const spawned = await settled(coming);

		assert.deepStrictEqual({ spawned: spawned.id, agents: agents(world), seenByThePerson: world.facade.ps(PERSON).map(row => row.id), told: world.person.told }, {
			spawned: 3,
			agents: ['#1 @lead parent the person exited: its CLI ended', '#2 @a parent the person running', '#3 @b parent the person running'],
			seenByThePerson: [1, 2, 3],
			told: ['@lead #a1 ended, and its children are yours now: @a #a2, @b #a3. (@a #2 · Arg Code)']
		});
	});

	test('an agent that ends before its child is even started - git still asked for its worktree - leaves the child to the person all the same, who is told as it starts', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const git = new DeferredPromise<void>();
		world.git.hold = git.p;
		const coming = world.facade.spawn(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Kid.', name: 'kid', worktree: 'main' });
		await sleep(1_000);
		world.terminals.end('@lead #1 · Arg Code', { exitCode: 0, byThePerson: false });
		await sleep(1_000);
		const toldBefore = [...world.person.told];
		git.complete();
		await until(() => world.terminals.launched.length === 2);
		world.hello(2);
		const spawned = await settled(coming);

		assert.deepStrictEqual({ spawned: spawned.id, agents: agents(world), toldBefore, told: world.person.told.slice(toldBefore.length) }, {
			spawned: 2,
			agents: ['#1 @lead parent the person exited: its CLI ended', '#2 @kid parent the person running'],
			toldBefore: [],
			told: ['@lead #a1 ended while it started @kid #a2, which is yours now. (@kid #2 · Arg Code)']
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

	test('the window that comes back finds its agents again: one whose terminal is gone has exited - what the window revived under its name closed - one starting is waited for again - its hello makes it running - and one running stays so; a spawn that waited as the window went cannot say whether its child came up', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Up.', name: 'up', folder: lab });
		const slow = world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Slow.', name: 'slow', folder: lab });
		await until(() => world.terminals.launched.length === 2);
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Gone.', name: 'gone', folder: lab });
		const after = reload('@up #1 · Arg Code', '@slow #2 · Arg Code');
		const unknown = await outcomeOf(slow);
		await after.facade.recover();
		const recovered = agents(after);
		after.hello(2);

		assert.deepStrictEqual({ unknown, recovered, agents: agents(after), told: after.person.told, closedRevived: after.terminals.closedRevived }, {
			unknown: 'UNAVAILABLE: The window closed meanwhile: whether the agent came up is not known. ps says, once the window is back.',
			recovered: ['#1 @up parent the person running', '#2 @slow parent the person starting', '#3 @gone parent the person exited: its terminal was gone when Facade came back'],
			agents: ['#1 @up parent the person running', '#2 @slow parent the person running', '#3 @gone parent the person exited: its terminal was gone when Facade came back'],
			told: [],
			closedRevived: ['@gone #3 · Arg Code']
		});
	});

	test('one found starting that does not say hello within two minutes fails, and its terminal closes; no start waits to say so any more, so its creator is told: an agent by a message, the person by a notification', async () => {
		const starting = world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.hello(1);
		await settled(starting);
		await world.fetched(1);
		const child = world.facade.spawn(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Slow.', name: 'slow' });
		const root = world.facade.spawn(PERSON, { cli: 'arg', model: 'small', effort: 'high', name: 'quiet', folder: lab });
		await until(() => world.terminals.launched.length === 3);
		const after = reload('@main #1 · Arg Code', '@slow #2 · Arg Code', '@quiet #3 · Arg Code');
		await Promise.all([outcomeOf(child), outcomeOf(root)]);
		await after.facade.recover(true);
		await sleep(121_000);
		const mail = after.table.state.mail;

		assert.deepStrictEqual({
			agents: agents(after),
			creator: (mail.mailboxes.get(1) ?? []).map(id => mail.messages.get(id)).filter(message => message?.from === 'facade').map(message => message?.text),
			person: after.person.notified.map(notification => notification.text),
			told: after.person.told
		}, {
			agents: ['#1 @main parent the person running', `#2 @slow parent #1 failed: ${NO_HELLO}`, `#3 @quiet parent the person failed: ${NO_HELLO}`],
			creator: [
				`#m2 was not fetched by @slow #a2 before it ended (it did not start: ${NO_HELLO}).\nOriginal message:\nSlow.`,
				`@slow #a2 ended: it did not start: ${NO_HELLO}. It takes no more messages. Its last screen was not kept: read_screen #a2 says why.`
			],
			person: [`@quiet #a3 ended: it did not start: ${NO_HELLO}.`],
			told: []
		});
	});

	test('a start that fails as its spawn waits is said by the spawn alone: its creator is told nothing more, and its task goes back to nobody - its chat room notes it; nor is a creator told of a child starting that the person closed', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const failing = world.facade.spawn(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'Fail.', name: 'fails' });
		await until(() => world.terminals.launched.length === 2);
		const rootFailing = world.facade.spawn(PERSON, { cli: 'arg', model: 'small', effort: 'high', prompt: 'Fail too.', name: 'alone', folder: lab });
		await until(() => world.terminals.launched.length === 3);
		const closing = world.facade.spawn(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'Closed.', name: 'closed' });
		await until(() => world.terminals.launched.length === 4);
		world.terminals.end('@fails #2 · Arg Code', { exitCode: 1, byThePerson: false });
		world.terminals.end('@alone #3 · Arg Code', { exitCode: 1, byThePerson: false });
		world.terminals.end('@closed #4 · Arg Code', { byThePerson: true });
		const [failed, rootFailed, closed] = [await outcomeOf(failing), await outcomeOf(rootFailing), await outcomeOf(closing)];
		await sleep(2_000);
		const mail = world.table.state.mail;

		assert.deepStrictEqual({
			failed,
			rootFailed,
			closed,
			lead: (mail.mailboxes.get(1) ?? []).filter(id => mail.entries.get(id)?.state === 'unread').map(id => mail.messages.get(id)?.from ?? 'you'),
			returns: [...mail.returns.values()].map(returned => `${returned.known ? 'noted' : returned.as === undefined ? 'unreturned' : 'returned'}: ${returned.reason}`),
			person: world.person.notified.map(notification => notification.text)
		}, {
			failed: 'FAILED: Arg Code did not start as @fails #a2: its CLI ended with exit code 1',
			rootFailed: 'FAILED: Arg Code did not start as @alone #a3: its CLI ended with exit code 1',
			closed: 'FAILED: Arg Code did not start as @closed #a4: the person closed its terminal',
			lead: ['you'],
			returns: ['noted: it exited, with exit code 1', 'noted: it exited, with exit code 1', 'noted: stopped by @you'],
			person: []
		});
	});

	test('one running whose first line was not typed yet - the window went between its hello and its doorbell - has it typed once the window is back', async () => {
		const spawning = world.facade.spawn(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.hello(1);
		await settled(spawning);
		const after = reload('@main #1 · Told Code');
		await after.facade.recover(true);
		await sleep(3_000);

		assert.deepStrictEqual({ typed: after.terminals.typed, rings: after.table.state.mail.entries.get(1)?.rings, agents: agents(after) }, {
			typed: [
				`@main #1 · Told Code: type ${JSON.stringify('[facade] You are @main #a1, created by @you. Your task is #m1.')}, Enter after 400 ms`
			],
			rings: 1,
			agents: ['#1 @main parent the person running']
		});
	});

	test('a worktree Facade made that is gone - deleted by the person, or by git - is its no more', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
		const folder = worktreeFolder(lab, 'clamp');
		const after = reload('@main #1 · Arg Code');
		fs.rmSync(folder, { recursive: true, force: true });
		await after.facade.recover();

		assert.deepStrictEqual({ made: after.table.madeWorktree(folder), agents: agents(after) }, {
			made: undefined,
			agents: ['#1 @main parent the person running', '#2 @clamp parent #1 exited: its terminal was gone when Facade came back']
		});
	});

	test('a window the person closed - quitting Facade, or closing the window - takes its agents with it: none comes back, each is killed by the person, as a terminal they close is, and they hear nothing', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
		const after = reload();
		await after.facade.recover();

		assert.deepStrictEqual({ agents: agents(after), told: after.person.told }, {
			agents: ['#1 @main parent the person killed: the person closed its window', '#2 @clamp parent the person killed: the person closed its window'],
			told: []
		});
	});

	test('a reload that brings none of the agents\' terminals back: each ended by itself, lost, as after a crash, and nobody is told', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
		const after = reload();
		await after.facade.recover(true);

		assert.deepStrictEqual({ agents: agents(after), told: after.person.told }, {
			agents: ['#1 @main parent the person exited: its terminal was gone when Facade came back', '#2 @clamp parent the person exited: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('another workspace\'s window that takes the agents once the window that had them was closed: those gone went with that window, killed by the person, who hears nothing - though this window was reloaded', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		world.dispose();
		// A minute on, which another owner waits for
		const longAgo = new Date(Date.now() - 2 * 60_000);
		fs.utimesSync(path.join(dir, 'ledger.lock'), longAgo, longAgo);
		world = fakeWorld(dir, { repositories: { [lab]: [] }, owner: 'notes' });
		await world.facade.recover(true);

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#1 @main parent the person killed: the person closed its window'],
			told: []
		});
	});

	test('the extension host started again in the same load of the window - none of the agents\' terminals back - is no window closed: each ended by itself, lost, and nobody is told', async () => {
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, session: 'this-load' });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, session: 'this-load' });
		await world.facade.recover();

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#1 @main parent the person exited: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('Facade turned off and on again, the window staying: an agent whose terminal ended meanwhile ended by itself, lost, though none is left, and nobody is told', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		world.dispose('facade');
		world = fakeWorld(dir, { repositories: { [lab]: [] } });
		await world.facade.recover();

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#1 @main parent the person exited: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('after a crash, one whose terminal is gone ended by itself, lost, though none comes back, and nobody is told', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		await world.spawnUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
		const after = crash();
		await after.facade.recover();

		assert.deepStrictEqual({ agents: agents(after), told: after.person.told }, {
			agents: ['#1 @main parent the person exited: its terminal was gone when Facade came back', '#2 @clamp parent the person exited: its terminal was gone when Facade came back'],
			told: []
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
		of.terminals.end(`@${name} #${id} · Told Code`, { exitCode: 0, byThePerson: false });
	}

	test('the files a CLI reads from its folder are put there for its agents - kept out of git by lines in info/exclude, and a folder Facade made by a .gitignore of its own - and go once the last agent there exits', async () => {
		await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'One.', name: 'one', folder: lab });
		await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Two.', name: 'two', folder: lab });
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

	test('a .mcp.json of the person\'s own that git does not track gets Facade\'s server beside theirs, and no line in info/exclude, which would leave theirs for git to write over; it is theirs again, byte for byte, once the last agent there exits', async () => {
		const theirs = '{\n    "mcpServers": {\n        "docs": { "command": "docs-server" }\n    }\n}\n';
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'One.', folder: lab });
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
		const tracked = await outcomeOf(world.facade.spawn(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'One.', folder: lab }));
		world.git.trackedFiles.clear();
		fs.writeFileSync(mcp, 'not JSON');
		const notJson = await outcomeOf(world.facade.spawn(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Two.', folder: lab }));

		assert.deepStrictEqual({ tracked, notJson, left: listed(lab), theirs: fs.readFileSync(mcp, 'utf8'), launched: world.terminals.launched.length }, {
			tracked: `FAILED: Told Code did not start as @main #a1: Told Code is not started: ${mcp} is in the repository, and Facade would have to change it, so that a commit could take Facade's settings with it.`,
			notJson: `FAILED: Told Code did not start as @main #a2: Told Code is not started: ${mcp} is there already, and Facade does not write over it.`,
			left: ['.mcp.json'],
			theirs: 'not JSON',
			launched: 0
		});
	});

	test('the person\'s .mcp.json that they changed while agents ran keeps their change once the last agent there exits, and loses Facade\'s server; an agent started there after the change takes Facade\'s server for no part of theirs', async () => {
		fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { docs: { command: 'docs-server' } } }, undefined, 2));
		world.git.untrackedFiles.add(mcp);
		await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'One.', name: 'one', folder: lab });
		// The person adds a server of theirs while it runs.
		const merged = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { ...merged.mcpServers, lint: { command: 'lint-server' } } }, undefined, 2));
		const second = await outcomeOf(world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Two.', name: 'two', folder: lab }));
		const whileTwoRuns = Object.keys(JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers);
		exits('one', 1);
		exits('two', 2);

		assert.deepStrictEqual({ second, whileTwoRuns, after: JSON.parse(fs.readFileSync(mcp, 'utf8')) }, {
			second: 'fulfilled',
			whileTwoRuns: ['docs', 'lint', 'facade'],
			after: { mcpServers: { docs: { command: 'docs-server' }, lint: { command: 'lint-server' } } }
		});
	});

	test('the person\'s .mcp.json that is gone once the last agent there exits is kept for them beside the record, and they are told where', async () => {
		const theirs = '{ "mcpServers": {} }\n';
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'One.', folder: lab });
		fs.rmSync(mcp);
		world.terminals.end('@main #1 · Told Code', { byThePerson: true });
		const keptDir = path.join(temp.dir, 'workspace', 'kept');
		const kept = fs.readdirSync(keptDir).map(name => path.join(keptDir, name));

		assert.deepStrictEqual({ kept: kept.map(file => fs.readFileSync(file, 'utf8')), told: world.person.told }, {
			kept: [theirs],
			told: [`${mcp} was gone when its agents exited: what it held before Facade's part went in is kept at ${kept[0]}.`]
		});
	});

	test('two windows on one folder: what one window\'s agents need there stays while the other window\'s exit, and goes with the last of them', async () => {
		const injected = path.join(temp.dir, 'injected.json');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'one'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		const other = fakeWorld(path.join(temp.dir, 'two'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		try {
			await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'One.', folder: lab });
			await other.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Two.', folder: lab });
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

	test('a spawn that waits on git as the window closes starts nothing, records nothing, and says why; so does a kill', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		const git = new DeferredPromise<void>();
		world.git.hold = git.p;
		const spawning = world.facade.spawn(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan.', worktree: 'main', folder: lab });
		await sleep(1_000);
		world.facade.dispose();
		git.complete();

		assert.deepStrictEqual({ spawn: await outcomeOf(spawning), kill: await outcomeOf(world.facade.kill(PERSON, '#1')), agents: agents(world), launched: world.terminals.launched.length }, {
			spawn: 'UNAVAILABLE: The window closed meanwhile, and does nothing more: try again once it is open.',
			kill: 'UNAVAILABLE: The window closed meanwhile, and does nothing more: try again once it is open.',
			agents: ['#1 @main parent the person running'],
			launched: 1
		});
	});
});
