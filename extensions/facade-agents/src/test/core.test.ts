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

/** What a process that did not say hello in time fails with. */
const NO_HELLO = 'it did not come up within 120 seconds: its MCP server never said hello to Facade, so its CLI may be waiting for an answer in its terminal';

/** Every process the workspace has had, a line each: its PID, name, parent now, and state - how it exited, once it has. */
function processes(world: World): string[] {
	return world.facade.ps(PERSON, true).map(row => `${row.pid} @${row.name} ppid ${row.ppid} ${row.exit ? `${row.exit.kind}: ${row.exit.reason}` : row.state}`);
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

	test('the person starts an agent in the folder on screen: PID 2, named after its worktree, its CLI in a terminal of its own put in front, its first message the opening and then the task, and its token in its run folder; it is up once its MCP server says hello', async () => {
		const spawned = await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Tidy the docs.', folder: lab });
		const runs = world.table.runsDir;
		const config = path.join(runs, '2.config.json');

		assert.deepStrictEqual({
			spawned,
			launched: world.terminals.launched,
			config: JSON.parse(fs.readFileSync(config, 'utf8')),
			token: world.table.authenticate(fs.readFileSync(path.join(runs, '2.token'), 'utf8')),
			processes: processes(world),
			told: world.person.told
		}, {
			spawned: { pid: 2, name: 'main', cli: 'arg', model: 'large', effort: 'high', worktree: 'main', folder: lab, newWorktree: false },
			launched: [{
				name: '@main (2) · Arg Code',
				command: 'arg',
				executable: path.join(temp.dir, 'workspace', 'bin', 'arg.exe'),
				args: ['--config', config, '--model', 'large', '--effort', 'high', '--', '[facade] You are @main, PID 2, Arg Code, started by @you.\n\nTidy the docs.'],
				env: { ARG_QUIET: '1' },
				cwd: lab,
				reveal: true
			}],
			config: { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', path.join(runs, '2.token')], env: { ELECTRON_RUN_AS_NODE: '1' } },
			token: { pid: 2, name: 'main' },
			processes: ['2 @main ppid 1 running'],
			told: []
		});
	});

	test('an agent\'s child starts beside it, in its folder, without coming in front; its first message names its parent, and it is that agent\'s', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		const spawned = await world.spawnUp(callerOf(world.process(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Write the tests.', name: '@Tests' });
		const launch = world.terminals.launched[1];

		assert.deepStrictEqual({ spawned, name: launch.name, task: launch.args[launch.args.length - 1], cwd: launch.cwd, reveal: launch.reveal, processes: processes(world), told: world.person.told }, {
			spawned: { pid: 3, name: 'tests', cli: 'arg', model: 'small', effort: 'high', worktree: 'main', folder: lab, newWorktree: false },
			name: '@tests (3) · Arg Code',
			task: '[facade] You are @tests, PID 3, Arg Code, started by @main.\n\nWrite the tests.',
			cwd: lab,
			reveal: false,
			processes: ['2 @main ppid 1 running', '3 @tests ppid 2 running'],
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
		const spawned = await world.spawnUp(callerOf(world.process(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp the widths.', worktree: 'new', name: 'clamp' });
		const folder = worktreeFolder(lab, 'clamp');
		await world.spawnUp(callerOf(world.process(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp again.', worktree: 'clamp', name: 'again' });
		const file = path.join(home, 'trust.json');

		assert.deepStrictEqual({
			spawned,
			steps: world.git.steps,
			made: world.table.madeWorktree(folder),
			trust: fs.readFileSync(file, 'utf8'),
			logged: world.logs.filter(line => line.includes(': Arg Code trust'))
		}, {
			spawned: { pid: 3, name: 'clamp', cli: 'arg', model: 'small', effort: 'high', worktree: 'clamp', folder, newWorktree: true },
			steps: [`make clamp from aaaaaaa in ${lab}`],
			made: { name: 'clamp', folder, repository: lab, parentWorktree: 'main', madeBy: 2 },
			// The rest of the file as it was, and its layout.
			trust: `{\n  "theme": "dark",\n  "trusted": [\n    ${JSON.stringify(lab)}\n  ]\n}\n`,
			logged: [
				`Facade merged ${JSON.stringify({ trusted: [lab] })} into ${file}: Arg Code trusts ${folder} now.`,
				`${file} has ${JSON.stringify({ trusted: [lab] })} already: Arg Code trusted ${folder} before.`
			]
		});
	});

	test('the trust goes where the CLI reads it as the person has it started - its launch\'s environment over the terminals\' - and a CLI this machine does not have is refused, saying why: its path setting names nothing, or its command is not on PATH', async () => {
		const terminalHome = path.join(temp.dir, 'terminal-home');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, clis: ['arg'], environment: () => ({ ARG_HOME: terminalHome }) });
		const own = path.join(temp.dir, 'own-home');
		world.settings.arg = { launch: { environment: { ARG_HOME: own } } };
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		await world.spawnUp(callerOf(world.process(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
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
		await world.spawnUp(callerOf(world.process(2)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
		world.settings.told = { launch: { trust: null } };
		world.settings.arg = { launch: { trust: null } };
		await world.spawnUp(callerOf(world.process(2)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Again.', worktree: 'clamp', name: 'again' });
		await world.spawnUp(callerOf(world.process(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Arg.', worktree: 'clamp', name: 'arg' });

		assert.deepStrictEqual({ args: world.terminals.launched.slice(0, 3).map(launch => launch.args), argTrust: trustIn(path.join(temp.dir, 'workspace', 'arg-home')) }, {
			args: [['--model', 'deep', '--effort', 'high'], ['--trust-folder', '--model', 'deep', '--effort', 'high'], ['--model', 'deep', '--effort', 'high']],
			argTrust: undefined
		});
	});

	test('a child in a worktree of its parent\'s repository, by its name: named after it, and given no trust in a worktree Facade did not make', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		const spawned = await world.spawnUp(callerOf(world.process(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Fix the docs.', worktree: 'docs' });
		await world.spawnUp(callerOf(world.process(2)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan the docs.', worktree: 'docs' });

		assert.deepStrictEqual({ spawned, argTrust: trustIn(path.join(temp.dir, 'workspace', 'arg-home')), toldArgs: world.terminals.launched[2].args }, {
			spawned: { pid: 3, name: 'docs', cli: 'arg', model: 'small', effort: 'high', worktree: 'docs', folder: worktreeFolder(lab, 'docs'), newWorktree: false },
			argTrust: undefined,
			toldArgs: ['--model', 'deep', '--effort', 'high']
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

		assert.deepStrictEqual({ refusals, processes: processes(world), launched: world.terminals.launched.length, steps: world.git.steps }, {
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
			processes: [],
			launched: 0,
			steps: []
		});
	});

	test('the model and the effort go to the CLI as they are, a model or level it may not have included: the CLI is the one that knows which it has; ps and the record show them', async () => {
		const spawned = await world.spawnUp(PERSON, { cli: 'told', model: ' gemini-9-flash ', effort: ' ultra ', prompt: 'Plan.', folder: lab });

		assert.deepStrictEqual({ spawned: [spawned.model, spawned.effort], args: world.terminals.launched[0].args, row: world.facade.ps(PERSON).map(row => [row.model, row.effort]), recorded: world.process(2).effort }, {
			spawned: ['gemini-9-flash', 'ultra'],
			args: ['--model', 'gemini-9-flash', '--effort', 'ultra'],
			row: [['gemini-9-flash', 'ultra']],
			recorded: 'ultra'
		});
	});

	test('nothing asks the person before a CLI\'s first agent: an agent\'s spawn of a CLI nobody started before starts it at once, at full access', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		const first = await outcomeOf(world.spawnUp(callerOf(world.process(2)), { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan.' }));

		assert.deepStrictEqual({ first, processes: processes(world), told: world.person.told }, {
			first: 'fulfilled',
			processes: ['2 @main ppid 1 running', '3 @main ppid 2 running'],
			told: []
		});
	});

	test('anything that fails from the launch on ends the child as failed and closes its terminal, and the spawn says why: a launch the window fails, a CLI that ends as it starts, no hello within two minutes; the person who started it hears of it from the spawn alone', async () => {
		world.terminals.failNext = 'the window has no terminal for it';
		const launchFailed = await outcomeOf(world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'One.', folder: lab }));
		const ending = world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Two.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.terminals.end('@main (3) · Arg Code', { exitCode: 2, byThePerson: false });
		const ended = await outcomeOf(settled(ending));
		const silent = outcomeOf(world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Three.', folder: lab }));
		await until(() => world.terminals.launched.length === 2);
		await sleep(120_000);
		const timedOut = await silent;

		assert.deepStrictEqual({ launchFailed, ended, timedOut, processes: processes(world), typed: world.terminals.typed, told: world.person.told }, {
			launchFailed: 'FAILED: Arg Code did not start as @main (PID 2): the window has no terminal for it',
			ended: 'FAILED: Arg Code did not start as @main (PID 3): its CLI ended with exit code 2',
			timedOut: `FAILED: Arg Code did not start as @main (PID 4): ${NO_HELLO}`,
			processes: [
				'2 @main ppid 1 failed: the window has no terminal for it',
				'3 @main ppid 1 failed: its CLI ended with exit code 2',
				`4 @main ppid 1 failed: ${NO_HELLO}`
			],
			typed: ['@main (2) · Arg Code: [closed]', '@main (4) · Arg Code: [closed]'],
			told: []
		});
	});

	test('a CLI told of its task in its terminal is typed the line that names its task file once its MCP server said hello, and Enter after its pause; the spawn answers after that', async () => {
		const spawning = world.facade.spawn(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan the release.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		const beforeHello = [...world.terminals.typed];
		world.hello(2);
		await until(() => world.terminals.typed.length > 0);
		const beforeEnter = [...world.terminals.typed];
		const spawned = await settled(spawning);
		const taskFile = path.join(world.table.runsDir, '2.task.md');
		const line = `@main (2) · Told Code: ${JSON.stringify(`[facade] Your task is in ${taskFile}: read that file, then do what it says.`)}`;
		const launch = world.terminals.launched[0];

		assert.deepStrictEqual({
			beforeHello,
			beforeEnter,
			typed: world.terminals.typed,
			task: fs.readFileSync(taskFile, 'utf8'),
			args: launch.args,
			agent: { pipe: launch.env.FACADE_AGENTS_PIPE, token: world.table.authenticate(launch.env.FACADE_AGENTS_TOKEN) },
			taskTyped: world.process(2).taskTyped,
			pid: spawned.pid
		}, {
			beforeHello: [],
			beforeEnter: [line],
			typed: [line, `@main (2) · Told Code: ${JSON.stringify('\r')}`],
			task: '[facade] You are @main, PID 2, Told Code, started by @you.\n\nPlan the release.',
			args: ['--model', 'deep', '--effort', 'high'],
			agent: { pipe: 'pipe', token: { pid: 2, name: 'main' } },
			taskTyped: true,
			pid: 2
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

		assert.deepStrictEqual({ first: [first.args.slice(2, 6), first.env], second: [second.args.slice(2, 5), second.env], inArguments, inTrust, made: world.git.steps, slow: await slow }, {
			first: [['--model', 'large', '--effort', 'high'], { ARG_QUIET: '1' }],
			second: [['--model', 'huge', '--verbose'], { ARG_COLOR: 'never' }],
			inArguments: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.orchestration.arg.launch.arguments.extra has ${home}, for which Facade has no value: it has ${config}, ${model}, ${effort}, ${task}.',
			inTrust: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.orchestration.arg.launch.trust.file has ${nowhere}, for which Facade has no value: it has ${home}, ${argHome}, ${repository}.',
			made: [],
			slow: 'FAILED: Arg Code did not start as @main (PID 4): it did not come up within 5 seconds: its MCP server never said hello to Facade, so its CLI may be waiting for an answer in its terminal'
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

	test('ps shows the caller, its parent and its children - those it spawned, exited ones too, and those that are its own now - and every process with all; once the process that spawned a child exited, its parent is the person', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.process(2));
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'A.', name: 'a' });
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'B.', name: 'b' });
		await world.spawnUp(callerOf(world.process(3)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'C.', name: 'c' });
		const killed = await world.facade.kill(lead, '3');
		const seenBy = (pid: number, all = false) => world.facade.ps(pid === 1 ? PERSON : callerOf(world.process(pid)), all).map(row => `${row.pid}<${row.ppid}`);

		assert.deepStrictEqual({
			killed: { ...killed, exit: { ...killed.exit, time: 0 } },
			lead: seenBy(2),
			b: seenBy(4),
			c: seenBy(5),
			person: seenBy(1),
			all: seenBy(4, true),
			told: world.person.told
		}, {
			killed: { pid: 3, name: 'a', alreadyExited: false, exit: { kind: 'killed', reason: 'killed by @lead (PID 2)', time: 0 } },
			lead: ['2<1', '3<2', '4<2'],
			b: ['2<1', '4<2'],
			c: ['5<1'],
			person: ['2<1', '5<1'],
			all: ['2<1', '3<2', '4<2', '5<1'],
			told: ['@a (PID 3) exited, and its children are yours now: @c (PID 5). (@c (5) · Arg Code)']
		});
	});

	test('an agent kills only its own children, and the person any; PID 1 is nobody\'s to kill; a name more than one running process has is refused, naming them; one that exited already says how', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.process(2));
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'One.', name: 'twin' });
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'Two.', name: 'twin' });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Alone.', name: 'solo', folder: lab });
		const solo = callerOf(world.process(5));
		const done = (killing: Promise<{ readonly pid: number; readonly alreadyExited: boolean }>) => outcomeOf(killing.then(killed => {
			if (killed.alreadyExited) {
				throw new Error(`PID ${killed.pid} had exited already`);
			}
		}));
		const outcomes = [
			await done(world.facade.kill(solo, '3')),
			await done(world.facade.kill(lead, '1')),
			await done(world.facade.kill(lead, '99')),
			await done(world.facade.kill(lead, '@nobody')),
			await done(world.facade.kill(lead, '@twin')),
			await done(world.facade.kill(lead, ' 3 ')),
			await done(world.facade.kill(lead, '3')),
			await done(world.facade.kill(lead, '@Twin')),
			await done(world.facade.kill(PERSON, '@solo'))
		];

		assert.deepStrictEqual({ outcomes, processes: processes(world), typed: world.terminals.typed, told: world.person.told }, {
			outcomes: [
				'REFUSED: @twin (PID 3) is not your child: an agent kills only its own children, and the person any. You have no running children.',
				'REFUSED: PID 1 is the person, whom no agent ends.',
				'NOT_FOUND: No process has PID 99: ps with all lists every process this workspace has had.',
				'NOT_FOUND: No running process is called @nobody: name an exited one by its PID, which ps with all lists.',
				'INVALID: 2 running processes are called @twin: @twin (PID 3), @twin (PID 4). Name one by its PID.',
				'fulfilled',
				'PID 3 had exited already',
				'fulfilled',
				'fulfilled'
			],
			processes: [
				'2 @lead ppid 1 running',
				'3 @twin ppid 2 killed: killed by @lead (PID 2)',
				'4 @twin ppid 2 killed: killed by @lead (PID 2)',
				'5 @solo ppid 1 killed: killed by the person'
			],
			typed: ['@twin (3) · Arg Code: [closed]', '@twin (4) · Arg Code: [closed]', '@solo (5) · Arg Code: [closed]'],
			told: []
		});
	});

	test('a kill whose terminal would not close is recorded all the same: the call answers, and the log says why', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		world.terminals.stop = async () => {
			throw new Error('the window did not answer');
		};
		const killed = await world.facade.kill(PERSON, '2');

		assert.deepStrictEqual({ alreadyExited: killed.alreadyExited, processes: processes(world), logged: world.logs.includes('@main (2) · Arg Code could not be closed: the window did not answer') }, {
			alreadyExited: false,
			processes: ['2 @main ppid 1 killed: killed by the person'],
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

	test('a terminal the person closes is a kill by the person, of which they are not told; one that ends by itself is an exit with its code, and the person hears of their own child\'s; an agent\'s child\'s exit its parent sees in ps', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'A.', name: 'a', folder: lab });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'B.', name: 'b', folder: lab });
		await world.spawnUp(callerOf(world.process(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'C.', name: 'c' });
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'D.', name: 'd', folder: lab });
		world.terminals.end('@c (4) · Arg Code', { exitCode: 0, byThePerson: false });
		world.terminals.end('@b (3) · Arg Code', { exitCode: 1, byThePerson: false });
		world.terminals.end('@d (5) · Arg Code', { byThePerson: false });
		world.terminals.end('@a (2) · Arg Code', { byThePerson: true });

		assert.deepStrictEqual({ processes: processes(world), told: world.person.told }, {
			processes: [
				'2 @a ppid 1 killed: the person closed its terminal',
				'3 @b ppid 1 exited: its CLI ended with exit code 1',
				'4 @c ppid 1 exited: its CLI ended with exit code 0',
				'5 @d ppid 1 exited: its terminal closed'
			],
			told: ['@b (PID 3) exited: its CLI ended with exit code 1.', '@d (PID 5) exited: its terminal closed.']
		});
	});

	test('an agent that exits leaves its running children to the person, who is told once, with the way to the first of them; so does one that exits while its child comes up, which the child does all the same', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.process(2));
		await world.spawnUp(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'A.', name: 'a' });
		const coming = world.facade.spawn(lead, { cli: 'arg', model: 'small', effort: 'high', prompt: 'B.', name: 'b' });
		await until(() => world.terminals.launched.length === 3);
		world.terminals.end('@lead (2) · Arg Code', { exitCode: 0, byThePerson: false });
		world.hello(4);
		const spawned = await settled(coming);

		assert.deepStrictEqual({ spawned: spawned.pid, processes: processes(world), seenByThePerson: world.facade.ps(PERSON).map(row => row.pid), told: world.person.told }, {
			spawned: 4,
			processes: ['2 @lead ppid 1 exited: its CLI ended with exit code 0', '3 @a ppid 1 running', '4 @b ppid 1 running'],
			seenByThePerson: [2, 3, 4],
			told: [
				'@lead (PID 2) exited: its CLI ended with exit code 0.',
				'@lead (PID 2) exited, and its children are yours now: @a (PID 3), @b (PID 4). (@a (3) · Arg Code)'
			]
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

	test('the window that comes back finds its processes again: one whose terminal is gone has exited, one starting is waited for again - its hello makes it running - and one running stays so; a spawn that waited as the window went cannot say whether its child came up', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Up.', name: 'up', folder: lab });
		const slow = world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Slow.', name: 'slow', folder: lab });
		await until(() => world.terminals.launched.length === 2);
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Gone.', name: 'gone', folder: lab });
		const after = reload('@up (2) · Arg Code', '@slow (3) · Arg Code');
		const unknown = await outcomeOf(slow);
		await after.facade.recover();
		const recovered = processes(after);
		after.hello(3);

		assert.deepStrictEqual({ unknown, recovered, processes: processes(after), told: after.person.told }, {
			unknown: 'UNAVAILABLE: The window closed meanwhile: whether the agent came up is not known. ps says, once the window is back.',
			recovered: ['2 @up ppid 1 running', '3 @slow ppid 1 starting', '4 @gone ppid 1 exited: its terminal was gone when the window came back'],
			processes: ['2 @up ppid 1 running', '3 @slow ppid 1 running', '4 @gone ppid 1 exited: its terminal was gone when the window came back'],
			told: ['@gone (PID 4) exited: its terminal was gone when the window came back.']
		});
	});

	test('one found starting that does not say hello within two minutes fails, and its terminal closes; the person hears of it, no spawn being there to tell them', async () => {
		const starting = world.facade.spawn(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Slow.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		const after = reload('@main (2) · Arg Code');
		await outcomeOf(starting);
		await after.facade.recover();
		await sleep(120_000);

		assert.deepStrictEqual({ processes: processes(after), typed: after.terminals.typed, told: after.person.told }, {
			processes: [`2 @main ppid 1 failed: ${NO_HELLO}`],
			typed: ['@main (2) · Arg Code: [closed]'],
			told: [`@main (PID 2) exited: ${NO_HELLO}.`]
		});
	});

	test('one running but not yet told of its task - the window went between its hello and the line - is told once the window is back', async () => {
		const spawning = world.facade.spawn(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Plan.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.hello(2);
		const after = reload('@main (2) · Told Code');
		await outcomeOf(spawning);
		await after.facade.recover();
		await sleep(1_000);
		const taskFile = path.join(after.table.runsDir, '2.task.md');

		assert.deepStrictEqual({ typed: after.terminals.typed, taskTyped: after.process(2).taskTyped, processes: processes(after) }, {
			typed: [
				`@main (2) · Told Code: ${JSON.stringify(`[facade] Your task is in ${taskFile}: read that file, then do what it says.`)}`,
				`@main (2) · Told Code: ${JSON.stringify('\r')}`
			],
			taskTyped: true,
			processes: ['2 @main ppid 1 running']
		});
	});

	test('a worktree Facade made that is gone - deleted by the person, or by git - is its no more', async () => {
		await world.spawnUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', prompt: 'Lead.', folder: lab });
		await world.spawnUp(callerOf(world.process(2)), { cli: 'arg', model: 'small', effort: 'high', prompt: 'Clamp.', worktree: 'new', name: 'clamp' });
		const folder = worktreeFolder(lab, 'clamp');
		const after = reload('@main (2) · Arg Code');
		fs.rmSync(folder, { recursive: true, force: true });
		await after.facade.recover();

		assert.deepStrictEqual({ made: after.table.madeWorktree(folder), processes: processes(after) }, {
			made: undefined,
			processes: ['2 @main ppid 1 running', '3 @clamp ppid 2 exited: its terminal was gone when the window came back']
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
	function exits(name: string, pid: number, of = world): void {
		of.terminals.end(`@${name} (${pid}) · Told Code`, { exitCode: 0, byThePerson: false });
	}

	test('the files a CLI reads from its folder are put there for its agents - kept out of git by lines in info/exclude, and a folder Facade made by a .gitignore of its own - and go once the last agent there exits', async () => {
		await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'One.', name: 'one', folder: lab });
		await world.spawnUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', prompt: 'Two.', name: 'two', folder: lab });
		const whileTheyRun = listed(lab);
		const excluded = fs.readFileSync(exclude, 'utf8');
		const server = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		exits('one', 2);
		const whileOneRuns = listed(lab);
		exits('two', 3);

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
		exits('main', 2);

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
			tracked: `FAILED: Told Code did not start as @main (PID 2): Told Code is not started: ${mcp} is in the repository, and Facade would have to change it, so that a commit could take Facade's settings with it.`,
			notJson: `FAILED: Told Code did not start as @main (PID 3): Told Code is not started: ${mcp} is there already, and Facade does not write over it.`,
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
		exits('one', 2);
		exits('two', 3);

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
		world.terminals.end('@main (2) · Told Code', { byThePerson: true });
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
			exits('main', 2);
			const whileTheOtherRuns = listed(lab);
			exits('main', 2, other);

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

		assert.deepStrictEqual({ spawn: await outcomeOf(spawning), kill: await outcomeOf(world.facade.kill(PERSON, '2')), processes: processes(world), launched: world.terminals.launched.length }, {
			spawn: 'UNAVAILABLE: The window closed meanwhile, and does nothing more: try again once it is open.',
			kill: 'UNAVAILABLE: The window closed meanwhile, and does nothing more: try again once it is open.',
			processes: ['2 @main ppid 1 running'],
			launched: 1
		});
	});
});
