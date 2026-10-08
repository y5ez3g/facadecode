/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DeferredPromise } from '../base/async';
import { End, PERSON } from '../record/events';
import { settled, sleep, until, useFakeClock } from './clock';
import { callerOf, fakeWorld, worktreeFolder } from './fakes';
import { outcomeOf, tempDir } from './util';

type World = ReturnType<typeof fakeWorld>;

/** Why the start of an agent that has not connected in time is not confirmed. */
const NOT_STARTED = 'it has not started within 120 seconds: its CLI is open but has not connected to Facade, and may be slow, or waiting for an answer on its screen';

/** A start's answer as the tests compare it: its time, which differs from run to run, set aside. */
function timeless<T extends { readonly startTime: number }>(facts: T): T {
	return { ...facts, startTime: 0 };
}

/** The notice an agent's CLI is given of its task: `opening`, then where its task's message is. */
function notice(world: World, opening: string, message: number): string {
	return `${opening} Your task is message #m${message}, in ${world.table.messageFileOf(message)}: read that file, then do what it says.`;
}

/** How an agent ended, as the tests write it: its kind, who stopped it, and why. */
function endOf(end: End): string {
	return `${end.kind}${end.by === undefined ? '' : end.by === 'human' ? ' by @human' : ` by #a${end.by}`}: ${end.reason}`;
}

/** Every agent of the list, a line each: its number, name, creator, and state - how it ended, once it has. */
function agents(world: World): string[] {
	return world.facade.listAgents(PERSON, true).agents.map(row => `#a${row.id} @${row.name} by ${row.creator === undefined ? '@human' : `#a${row.creator}`} ${row.end ? endOf(row.end) : row.state}`);
}

/** The person's history, as agents.log has it, a line each, without its time. */
function history(world: World): string[] {
	return fs.readFileSync(world.table.logFile, 'utf8').trimEnd().split('\n').map(line => line.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}/, ''));
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

	test('the person starts an agent from the agent menu in the folder on screen, asking nothing: #a1, named after its CLI\'s id, its CLI in a terminal of its own put in front, given no model, effort or task, its YOLO the setting\'s, and its token in its run folder; it is running once its MCP server says hello, and nothing is said to the person', async () => {
		const facts = await world.facade.startForPerson('arg', lab);
		const starting = agents(world);
		world.hello(1);
		const runs = world.table.runsDir;
		const config = path.join(runs, '1.config.json');

		assert.deepStrictEqual({
			facts: { ...timeless(facts), state: 'starting' },
			starting,
			launched: world.terminals.launched,
			config: JSON.parse(fs.readFileSync(config, 'utf8')),
			token: world.table.authenticate(fs.readFileSync(path.join(runs, '1.token'), 'utf8')),
			agents: agents(world),
			told: world.person.told
		}, {
			facts: { id: 1, name: 'arg', root: 1, cli: 'arg', custom: false, ignored: [], yolo: true, sandbox: 'off', integration: true, connected: false, worktree: 'main', folder: lab, state: 'starting', startTime: 0, task: 'none' },
			starting: ['#a1 @arg by @human starting'],
			launched: [{
				id: 1,
				name: '@arg #a1',
				command: 'arg',
				executable: path.join(temp.dir, 'workspace', 'bin', 'arg.exe'),
				args: ['--config', config, '--no-ask', '--yolo'],
				env: { ARG_QUIET: '1' },
				cwd: lab,
				reveal: true
			}],
			config: { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', path.join(runs, '1.token')], env: { ELECTRON_RUN_AS_NODE: '1' } },
			token: { id: 1, name: 'arg' },
			agents: ['#a1 @arg by @human running'],
			told: []
		});
	});

	test('a script acting as the person starts an agent as an agent does, with its task: kept as a message of its own, whose notice - who it is, and where the message is - is its CLI\'s argument; it does not come in front', async () => {
		const started = await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Tidy the docs.', folder: lab });
		const launch = world.terminals.launched[0];

		assert.deepStrictEqual({ started: timeless(started), notice: launch.args.at(-1), message: fs.readFileSync(world.table.messageFileOf(1), 'utf8'), reveal: launch.reveal }, {
			started: { status: 'started', id: 1, name: 'main', root: 1, cli: 'arg', custom: false, model: 'large', effort: 'high', ignored: [], yolo: true, sandbox: 'off', integration: true, connected: true, worktree: 'main', folder: lab, state: 'running', startTime: 0, taskMessage: 1, task: 'argument', newWorktree: false },
			notice: notice(world, '[facade] You are @main #a1, Arg Code, started by @human.', 1),
			message: 'Tidy the docs.',
			reveal: false
		});
	});

	test('an agent\'s child starts beside it, in its folder, without coming in front; its first message names its parent, and it is that agent\'s', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const started = await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Write the tests.', name: 'tests' });
		const launch = world.terminals.launched[1];

		assert.deepStrictEqual({ started: timeless(started), name: launch.name, task: launch.args[launch.args.length - 1], cwd: launch.cwd, reveal: launch.reveal, agents: agents(world), told: world.person.told }, {
			started: { status: 'started', id: 2, name: 'tests', creator: 1, root: 1, cli: 'arg', custom: false, model: 'small', effort: 'high', ignored: [], yolo: true, sandbox: 'off', integration: true, connected: true, worktree: 'main', folder: lab, state: 'running', startTime: 0, taskMessage: 2, task: 'argument', newWorktree: false },
			name: '@tests #a2',
			task: notice(world, '[facade] You are @tests #a2, Arg Code, started by @main.', 2),
			cwd: lab,
			reveal: false,
			agents: ['#a1 @main by @human running', '#a2 @tests by #a1 running'],
			told: []
		});
	});

	test('a child in a new worktree: made from its parent\'s HEAD, on a branch of its name, and recorded as Facade\'s; wherever an agent starts, its CLI is given the person\'s trust in the whole repository - merged into the file its launch names, where its terminal\'s environment says the CLI keeps it - and once there, it is not written again', async () => {
		const home = path.join(temp.dir, 'arg-home');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, environment: () => ({ ARG_HOME: home }) });
		fs.mkdirSync(home);
		fs.writeFileSync(path.join(home, 'trust.json'), '{\n  "theme": "dark"\n}\n');
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const started = await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp the widths.', newWorktree: true, name: 'clamp' });
		const folder = worktreeFolder(lab, 'clamp');
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp again.', folder: 'clamp', name: 'again' });
		const file = path.join(home, 'trust.json');

		assert.deepStrictEqual({
			started: timeless(started),
			steps: world.git.steps,
			made: world.table.madeWorktree(folder),
			trust: fs.readFileSync(file, 'utf8'),
			logged: world.logs.filter(line => line.includes(': Arg Code trust'))
		}, {
			started: { status: 'started', id: 2, name: 'clamp', creator: 1, root: 1, cli: 'arg', custom: false, model: 'small', effort: 'high', ignored: [], yolo: true, sandbox: 'off', integration: true, connected: true, worktree: 'clamp', folder, state: 'running', startTime: 0, taskMessage: 2, task: 'argument', newWorktree: true },
			steps: [`make clamp from aaaaaaa in ${lab}`],
			made: { name: 'clamp', folder, repository: lab, commit: 'a'.repeat(40), madeBy: 1 },
			// The rest of the file as it was, and its layout.
			trust: `{\n  "theme": "dark",\n  "trusted": [\n    ${JSON.stringify(lab)}\n  ]\n}\n`,
			logged: [
				`Facade merged ${JSON.stringify({ trusted: [lab] })} into ${file}: Arg Code trusts ${lab} now.`,
				`${file} has ${JSON.stringify({ trusted: [lab] })} already: Arg Code trusted ${folder} before.`,
				`${file} has ${JSON.stringify({ trusted: [lab] })} already: Arg Code trusted ${folder} before.`
			]
		});
	});

	test('a new worktree the person starts an agent in is recorded as theirs: made by no agent', async () => {
		const started = await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Clamp.', newWorktree: true, name: 'clamp', folder: lab });

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
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', newWorktree: true, name: 'clamp' });
		const unset = await outcomeOf(world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'quick', effort: 'high', task: 'Plan.', folder: lab }));
		world.settings.told = { path: '/nowhere/told' };
		const misnamed = await outcomeOf(world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'quick', effort: 'high', task: 'Plan.', folder: lab }));

		assert.deepStrictEqual({ own: trustIn(own), terminal: trustIn(terminalHome), unset, misnamed }, {
			own: { trusted: [lab] },
			terminal: undefined,
			unset: `UNAVAILABLE: Facade cannot start Told Code in ${lab}: told is not on the PATH a terminal there has, and facade.agents.told.path names no other.`,
			misnamed: `UNAVAILABLE: Facade cannot start Told Code in ${lab}: facade.agents.told.path is "/nowhere/told", which is no file, nor a command on the PATH a terminal there has.`
		});
	});

	test('a CLI given its trust in its arguments is given them wherever an agent starts, before the person\'s own arguments; a trust the person set to null is no trust: nothing is written, and the CLI asks', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', task: 'Clamp.', newWorktree: true, name: 'clamp' });
		world.settings.told = { launch: { trust: null } };
		world.settings.arg = { launch: { trust: null } };
		await world.startUp(callerOf(world.agent(1)), { cli: 'told', model: 'deep', effort: 'high', task: 'Again.', folder: 'clamp', name: 'again' });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Arg.', folder: 'clamp', name: 'arg' });

		assert.deepStrictEqual({ args: world.terminals.launched.slice(0, 3).map(launch => launch.args), argTrust: trustIn(path.join(temp.dir, 'workspace', 'arg-home')) }, {
			args: [['--model', 'deep', '--effort', 'high', '--trust-folder'], ['--model', 'deep', '--effort', 'high', '--trust-folder'], ['--model', 'deep', '--effort', 'high']],
			argTrust: undefined
		});
	});

	test('a child starts in any folder of the window: another folder of the workspace, another repository\'s, or a worktree on the workspace bar, by its absolute path; a worktree of its own repository by the branch checked out in it - main a branch like any other - and a detached one by its folder, having no branch; the window\'s folders are those the person picks from', async () => {
		const api = path.join(temp.dir, 'api');
		const notes = path.join(temp.dir, 'notes');
		fs.mkdirSync(api);
		fs.mkdirSync(notes);
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['docs', 'spike'], [api]: [] }, folders: [notes] });
		world.git.detach(lab, 'spike');
		const docs = worktreeFolder(lab, 'docs');
		const spike = worktreeFolder(lab, 'spike');
		await world.startUp(PERSON, { name: 'lead', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: docs });
		const lead = callerOf(world.agent(1));
		const places: string[] = [];
		for (const folder of [notes, api, spike, 'main', 'docs']) {
			const started = await world.startUp(lead, { name: 'child', cli: 'arg', model: 'small', effort: 'high', folder });
			places.push(`${started.worktree} at ${started.folder}, task ${started.task}`);
		}
		const detachedByBranch = await outcomeOf(world.facade.startAgent(lead, { name: 'child', cli: 'arg', model: 'small', effort: 'high', folder: 'spike' }));

		assert.deepStrictEqual({ places, detachedByBranch, folders: await world.facade.windowFolders() }, {
			places: [`notes at ${notes}, task none`, `main at ${api}, task none`, `spike at ${spike}, task none`, `main at ${lab}, task none`, `docs at ${docs}, task none`],
			detachedByBranch: `NOT_FOUND: No worktree of lab has spike checked out. Its worktrees: main at ${lab}, docs at ${docs}, spike at ${spike}.`,
			folders: [{ folder: lab, worktree: 'main' }, { folder: docs, worktree: 'docs' }, { folder: spike, worktree: 'spike' }, { folder: api, worktree: 'main' }, { folder: notes, worktree: 'notes' }]
		});
	});

	test('a new worktree starts at the caller\'s commit in the caller\'s own repository, whichever of its folders is named; in another repository, and for the person, at that repository\'s main checkout\'s', async () => {
		const api = path.join(temp.dir, 'api');
		fs.mkdirSync(api);
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['docs'], [api]: [] } });
		const docs = worktreeFolder(lab, 'docs');
		world.git.setHead(docs, 'd'.repeat(40));
		world.git.setHead(lab, 'b'.repeat(40));
		world.git.setHead(api, 'c'.repeat(40));
		await world.startUp(PERSON, { name: 'lead', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: docs });
		const lead = callerOf(world.agent(1));
		const child = { cli: 'arg', model: 'small', effort: 'high', task: 'Go.', newWorktree: true };
		await world.startUp(lead, { ...child, name: 'own' });
		await world.startUp(lead, { ...child, name: 'own-main', folder: lab });
		await world.startUp(lead, { ...child, name: 'other', folder: api });
		await world.startUp(PERSON, { ...child, name: 'persons', folder: docs });

		assert.deepStrictEqual(world.git.steps, [
			`make own from ddddddd in ${lab}`,
			`make own-main from ddddddd in ${lab}`,
			`make other from ccccccc in ${api}`,
			`make persons from bbbbbbb in ${lab}`
		]);
	});

	test('a child in a worktree Facade did not make - the person\'s, by the branch checked out in it - is given the person\'s trust in its whole repository, as anywhere; in a folder outside any repository, in that folder', async () => {
		const notes = path.join(temp.dir, 'notes');
		fs.mkdirSync(notes);
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['docs'] }, folders: [notes] });
		fs.mkdirSync(worktreeFolder(lab, 'docs'), { recursive: true });
		const home = path.join(temp.dir, 'workspace', 'arg-home');
		const started = await world.startUp(PERSON, { name: 'docs', cli: 'arg', model: 'small', effort: 'high', task: 'Fix the docs.', folder: worktreeFolder(lab, 'docs') });
		const inRepository = trustIn(home);
		await world.startUp(callerOf(world.agent(1)), { name: 'docs', cli: 'told', model: 'deep', effort: 'high', task: 'Plan the docs.', folder: 'docs' });
		await world.startUp(PERSON, { name: 'notes', cli: 'arg', model: 'small', effort: 'high', task: 'Take notes.', folder: notes });

		assert.deepStrictEqual({ started: timeless(started), inRepository, argTrust: trustIn(home), toldArgs: world.terminals.launched[1].args }, {
			started: { status: 'started', id: 1, name: 'docs', root: 1, cli: 'arg', custom: false, model: 'small', effort: 'high', ignored: [], yolo: true, sandbox: 'off', integration: true, connected: true, worktree: 'docs', folder: worktreeFolder(lab, 'docs'), state: 'running', startTime: 0, taskMessage: 1, task: 'argument', newWorktree: false },
			inRepository: { trusted: [lab] },
			argTrust: { trusted: [lab, notes] },
			toldArgs: ['--model', 'deep', '--effort', 'high', '--trust-folder']
		});
	});

	test('whatever can refuse a start refuses it before anything is made, and says what would be right: the CLI, the name - taken as it is given - and the place: a folder that is no folder of the window, a branch no worktree has checked out, or two have, and a new worktree outside any repository, on a branch that is there or that git takes for no branch, or with no commit to start at', async () => {
		const plain = path.join(temp.dir, 'plain');
		fs.mkdirSync(plain);
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['docs'] }, folders: [plain] });
		world.git.addBranch(lab, 'spike');
		world.git.addWorktree(lab, 'docs', path.join(temp.dir, 'docs-again'));
		const lead = { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab };
		const refusals = [
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, cli: 'nope' })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, name: 'facade' })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, name: 'two words' })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, name: '@Main' })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, folder: undefined })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, folder: path.join(temp.dir, 'elsewhere') })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, folder: 'docs' })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, folder: plain, newWorktree: true })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, name: 'spike', newWorktree: true })),
			await outcomeOf(world.facade.startAgent(PERSON, { ...lead, name: 'v1..2', newWorktree: true }))
		];
		await world.startUp(PERSON, { ...lead, name: 'lead' });
		const leader = callerOf(world.agent(1));
		refusals.push(
			await outcomeOf(world.facade.startAgent(leader, { ...lead, folder: 'nope' })),
			await outcomeOf(world.facade.startAgent(leader, { ...lead, folder: 'docs' }))
		);
		const unborn = fakeWorld(path.join(temp.dir, 'unborn'), { repositories: { [lab]: [] }, unborn: [lab] });
		try {
			refusals.push(await outcomeOf(unborn.facade.startAgent(PERSON, { ...lead, name: 'clamp', newWorktree: true })));
		} finally {
			unborn.dispose();
		}

		assert.deepStrictEqual({ refusals, agents: agents(world), launched: world.terminals.launched.length, steps: world.git.steps }, {
			refusals: [
				'NOT_FOUND: nope is neither a CLI Facade starts nor a custom agent of the person\'s. It starts: arg, told.',
				'INVALID: "facade" is reserved: choose another name.',
				'INVALID: "two words" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'INVALID: "@Main" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'INVALID: folder is required here: the person has no folder on screen. Name a folder of the window by its absolute path.',
				`NOT_FOUND: ${path.join(temp.dir, 'elsewhere')} is no folder of this window. Its folders: ${lab}, ${worktreeFolder(lab, 'docs')}, ${path.join(temp.dir, 'docs-again')}, ${plain}.`,
				'INVALID: docs is no absolute path, and the person has no folder on screen for it to be a branch of. Name a folder of the window by its absolute path.',
				`REFUSED: ${plain} is in no git repository, so no worktree of it can be made: start the child in the folder itself, without new_worktree.`,
				'REFUSED: lab has a branch called spike already, and a new worktree is on a new branch, named after the child: give the child another name, or start it in the worktree of spike by its folder.',
				'REFUSED: v1..2 cannot be the branch of a new worktree: git does not take "v1..2" for a branch\'s name. Give the child another name.',
				`NOT_FOUND: No worktree of lab has nope checked out. Its worktrees: main at ${lab}, docs at ${worktreeFolder(lab, 'docs')}, docs at ${path.join(temp.dir, 'docs-again')}.`,
				`INVALID: docs is checked out in 2 worktrees of lab: ${worktreeFolder(lab, 'docs')}, ${path.join(temp.dir, 'docs-again')}. Name the one you mean by its folder.`,
				`REFUSED: ${lab} has no commit for a new worktree to start at: it is on a branch with no commit yet, or one git cannot read.`
			],
			agents: ['#a1 @lead by @human running'],
			launched: 1,
			steps: []
		});
	});

	test('the model and the effort go to the CLI as they are, a model or level it may not have included: the CLI is the one that knows which it has; list_agents and the record show them', async () => {
		const started = await world.startUp(PERSON, { name: 'main', cli: 'told', model: ' gemini-9-flash ', effort: ' ultra ', task: 'Plan.', folder: lab });

		assert.deepStrictEqual({ started: [started.model, started.effort], args: world.terminals.launched[0].args, row: world.facade.listAgents(PERSON).agents.map(row => [row.model, row.effort]), recorded: world.agent(1).effort }, {
			started: ['gemini-9-flash', 'ultra'],
			args: ['--model', 'gemini-9-flash', '--effort', 'ultra', '--trust-folder'],
			row: [['gemini-9-flash', 'ultra']],
			recorded: 'ultra'
		});
	});

	test('nothing asks the person before a CLI\'s first agent: an agent\'s start of a CLI nobody started before starts it at once, with its creator\'s YOLO', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const first = await outcomeOf(world.startUp(callerOf(world.agent(1)), { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Plan.' }));

		assert.deepStrictEqual({ first, agents: agents(world), told: world.person.told }, {
			first: 'fulfilled',
			agents: ['#a1 @main by @human running', '#a2 @main by #a1 running'],
			told: []
		});
	});

	test('a launch the window fails, and a CLI that ends as it starts, end the child as failed - its terminal closed, where it has one - and start_agent says why; one that has not started within the timeout is left starting, its start not confirmed, saying why, and starts once its CLI connects; the person who started them hears of it from the start alone', async () => {
		world.terminals.failNext = 'the window has no terminal for it';
		const launchFailed = await outcomeOf(world.facade.startAgent(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'One.', folder: lab }));
		const ending = world.facade.startAgent(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Two.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.terminals.end('@main #a2', { exitCode: 2, byThePerson: false });
		const ended = await outcomeOf(settled(ending));
		const silent = world.facade.startAgent(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Three.', folder: lab });
		await until(() => world.terminals.launched.length === 2);
		await sleep(120_000);
		const { status, why } = await settled(silent);
		const whileUnconfirmed = agents(world);
		world.hello(3);

		assert.deepStrictEqual({ launchFailed, ended, timedOut: { status, why }, whileUnconfirmed, agents: agents(world), typed: world.terminals.typed, told: world.person.told }, {
			launchFailed: 'FAILED: Arg Code did not start as @main #a1: the window has no terminal for it',
			ended: 'FAILED: Arg Code did not start as @main #a2: its CLI ended with exit code 2',
			timedOut: { status: 'unconfirmed', why: NOT_STARTED },
			whileUnconfirmed: [
				'#a1 @main by @human failed: the window has no terminal for it',
				'#a2 @main by @human failed: its CLI ended with exit code 2',
				'#a3 @main by @human starting'
			],
			agents: [
				'#a1 @main by @human failed: the window has no terminal for it',
				'#a2 @main by @human failed: its CLI ended with exit code 2',
				'#a3 @main by @human running'
			],
			typed: [],
			told: []
		});
	});

	test('a CLI told of its task in its terminal is typed its notice - its opening, and where its task\'s message is - once its MCP server said hello, and Enter after its pause - each delay as its launch had it, the settings changed since or not; start_agent answers after that', async () => {
		const starting = world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Plan the release.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		const beforeHello = [...world.terminals.typed];
		world.settings.told = { launch: { taskDelay: 60_000, enterDelay: 60_000 } };
		world.hello(1);
		await until(() => world.terminals.typed.length > 0);
		const beforeEnter = [...world.terminals.typed];
		const started = await settled(starting);
		const line = `@main #a1: ${JSON.stringify(notice(world, '[facade] You are @main #a1, Told Code, started by @human.', 1))}`;
		const launch = world.terminals.launched[0];

		assert.deepStrictEqual({
			beforeHello,
			beforeEnter,
			typed: world.terminals.typed,
			task: fs.readFileSync(world.table.messageFileOf(1), 'utf8'),
			plan: JSON.parse(fs.readFileSync(world.table.launchFileOf(1), 'utf8')),
			args: launch.args,
			agent: { pipe: launch.env.FACADE_AGENTS_PIPE, token: world.table.authenticate(launch.env.FACADE_AGENTS_TOKEN) },
			delivered: world.agent(1).task,
			id: started.id
		}, {
			beforeHello: [],
			beforeEnter: [line],
			typed: [line, `@main #a1: ${JSON.stringify('\r')}`],
			task: 'Plan the release.',
			// Without Facade's own variables, which carry its token.
			plan: { program: launch.executable, args: launch.args, cwd: lab, environment: {}, enterDelay: 400, taskDelay: 0 },
			args: ['--model', 'deep', '--effort', 'high', '--trust-folder'],
			agent: { pipe: 'pipe', token: { id: 1, name: 'main' } },
			delivered: 'typed',
			id: 1
		});
	});

	test('the person\'s settings are read at each start, and change the next launch without a reload - its arguments and environment, the time it has to come up - and a `${name}` Facade has no value for, in the arguments or the trust, refuses the spawn before anything is made, saying which setting has it', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'One.', folder: lab });
		world.settings.arg = { launch: { arguments: { extra: ['--verbose'], effort: null }, environment: { ARG_QUIET: null, ARG_COLOR: 'never' } } };
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'huge', effort: 'high', task: 'Two.', folder: lab });
		world.settings.arg = { launch: { arguments: { extra: ['--home', '${home}'] } } };
		const inArguments = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Three.', newWorktree: true, name: 'three', folder: lab }));
		world.settings.arg = { launch: { trust: { file: '${nowhere}/trust.json' } } };
		const inTrust = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Three.', newWorktree: true, name: 'three', folder: lab }));
		world.settings.arg = {};
		world.timing.startTimeoutMs = 5_000;
		const slow = world.facade.startAgent(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Four.', folder: lab });
		await until(() => world.terminals.launched.length === 3);
		await sleep(5_000);
		const [first, second] = world.terminals.launched;

		const from = (args: readonly string[], count: number) => args.slice(args.indexOf('--model'), args.indexOf('--model') + count);

		assert.deepStrictEqual({ first: [from(first.args, 4), first.env], second: [from(second.args, 3), second.env], inArguments, inTrust, made: world.git.steps, slow: (await settled(slow)).why }, {
			first: [['--model', 'large', '--effort', 'high'], { ARG_QUIET: '1' }],
			second: [['--model', 'huge', '--verbose'], { ARG_COLOR: 'never' }],
			inArguments: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.agents.arg.launch.arguments.extra has ${home}, for which Facade has no value: it has ${config}, ${model}, ${effort}, ${task}.',
			inTrust: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.agents.arg.launch.trust.file has ${nowhere}, for which Facade has no value: it has ${home}, ${argHome}, ${repository}.',
			made: [],
			slow: 'it has not started within 5 seconds: its CLI is open but has not connected to Facade, and may be slow, or waiting for an answer on its screen'
		});
	});

	test('a setting of the person\'s that is wrong - of the wrong kind, or a key the launch does not have - refuses every start of its CLI before anything is made, naming each: Facade never takes its own value in its place', async () => {
		world.settings.arg = { launch: { arguments: { modle: ['-m'], model: ['-m', 4] }, trust: { arguments: ['--trust'], file: '/elsewhere/trust.json' }, enterDelay: 'fast' } };
		const refused = await outcomeOf(world.facade.startAgent(PERSON, { name: 'clamp', cli: 'arg', model: 'large', effort: 'high', task: 'Clamp.', newWorktree: true, folder: lab }));

		assert.deepStrictEqual({ refused, launched: world.terminals.launched.length, steps: world.git.steps, agents: agents(world), trust: trustIn(path.join(temp.dir, 'workspace', 'arg-home')) }, {
			refused: 'UNAVAILABLE: Facade cannot start Arg Code until the person puts its settings right: facade.agents.arg.launch.arguments has modle, which is no group of Arg Code\'s arguments: it has warmUp, connect, quiet, questions, messages, yoloOn, yoloOff, model, effort, extra, task; facade.agents.arg.launch.arguments.model is ["-m",4], which is neither a list of text nor null; facade.agents.arg.launch.trust has arguments and a file: a trust is given one way or the other; facade.agents.arg.launch.enterDelay is "fast", which is no whole number of milliseconds from 0 to 60000. Show Agent Launch shows them.',
			launched: 0,
			steps: [],
			agents: [],
			trust: undefined
		});
	});

	test('the person\'s YOLO is read as a start is accepted: on, the agent is given its CLI\'s yoloOn arguments, off its yoloOff - those running keeping theirs - and an agent\'s child takes its creator\'s, whatever the setting says by then; set to what is no switch, every start of the person\'s is refused before anything is made, naming it', async () => {
		await world.startUp(PERSON, { name: 'on', cli: 'arg', folder: lab });
		world.switches.yolo = false;
		await world.startUp(PERSON, { name: 'off', cli: 'arg', folder: lab });
		world.switches.yolo = true;
		await world.startUp(callerOf(world.agent(2)), { name: 'child', cli: 'arg' });
		world.switches.yolo = 'yes';
		const wrong = await outcomeOf(world.facade.startAgent(PERSON, { name: 'wrong', cli: 'arg', folder: lab }));

		assert.deepStrictEqual({ yolo: world.terminals.launched.map(launch => launch.args.filter(arg => arg === '--yolo' || arg === '--sandbox')), recorded: [1, 2, 3].map(id => world.agent(id).yolo), wrong, agents: agents(world) }, {
			yolo: [['--yolo'], ['--sandbox'], ['--sandbox']],
			recorded: [true, false, false],
			wrong: 'UNAVAILABLE: Facade starts no agent until the person puts this setting right: facade.agents.yolo is "yes", which is neither true nor false.',
			agents: ['#a1 @on by @human running', '#a2 @off by @human running', '#a3 @child by #a2 running']
		});
	});

	test('a CLI is found as its terminal will find it, in the environment a terminal in its folder has: the program found there is the one started; one found nowhere there refuses the start before anything is made', async () => {
		const elsewhere = path.join(temp.dir, 'elsewhere', 'arg');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, environment: folder => ({ PATH: folder }), locate: (cli, env) => cli === 'arg' && env.PATH === lab ? elsewhere : undefined });
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', folder: lab });
		const refused = await outcomeOf(world.facade.startAgent(PERSON, { name: 'plan', cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', newWorktree: true, folder: lab }));

		assert.deepStrictEqual({ started: world.terminals.launched.map(launch => launch.executable), refused, steps: world.git.steps, agents: agents(world) }, {
			started: [elsewhere],
			refused: `UNAVAILABLE: Facade cannot start Told Code in ${lab}: told is not on the PATH a terminal there has, and facade.agents.told.path names no other.`,
			steps: [],
			agents: ['#a1 @main by @human running']
		});
	});

	test('a task of any length is kept whole as a message of its own; the CLI\'s argument is only the notice that says where it is: a task is never cut short, and never on a command line', async () => {
		const task = `${'Clamp every width. '.repeat(7_000)}Done.`;
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task, folder: lab });
		const { args } = world.terminals.launched[0];

		assert.deepStrictEqual({ argument: args[args.length - 1], whole: fs.readFileSync(world.table.messageFileOf(1), 'utf8') === task, delivered: world.agent(1).task }, {
			argument: notice(world, '[facade] You are @main #a1, Arg Code, started by @human.', 1),
			whole: true,
			delivered: 'argument'
		});
	});

	test('on Windows, a CLI started through cmd.exe never has its task on its command line, where cmd.exe could read it as commands: its argument is the notice that says where the task\'s message is', async function () {
		if (process.platform !== 'win32') {
			this.skip();
		}
		const shim = path.join(temp.dir, 'bin', 'arg.cmd');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, locate: () => shim });
		const task = 'Print %PATH% & "quote" it ^ | < > ! ( )';
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task, folder: lab });
		const { executable, args } = world.terminals.launched[0];

		assert.deepStrictEqual({ executable, argument: args[args.length - 1], file: fs.readFileSync(world.table.messageFileOf(1), 'utf8'), delivered: world.agent(1).task }, {
			executable: shim,
			argument: notice(world, '[facade] You are @main #a1, Arg Code, started by @human.', 1),
			file: task,
			delivered: 'argument'
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
		const seenBy = (id: number | undefined, all = false) => world.facade.listAgents(id === undefined ? PERSON : callerOf(world.agent(id)), all).agents.map(row => `${row.id}<${row.creator ?? 'human'}`);

		assert.deepStrictEqual({
			stopped: { id: stopped.agent.id, alreadyEnded: stopped.alreadyEnded, end: stopped.agent.end && { ...stopped.agent.end, time: 0 } },
			lead: seenBy(1),
			b: seenBy(3),
			c: seenBy(4),
			person: seenBy(undefined),
			all: seenBy(3, true),
			told: world.person.told
		}, {
			stopped: { id: 2, alreadyEnded: false, end: { kind: 'stopped', by: 1, reason: 'with stop_agent', time: 0 } },
			lead: ['1<human', '2<1', '3<1'],
			b: ['1<human', '3<1'],
			c: ['2<1', '4<2'],
			person: ['1<human'],
			all: ['1<human', '2<1', '3<1', '4<2'],
			told: []
		});
	});

	test('an agent stops any agent it reaches - with YOLO on, every agent of the window - and @human any; the person is nobody\'s to stop; an agent is named by its number, as #a7, #7, a7 or 7, by a name one agent that has not ended has, or as Facade\'s words name it, its name that number\'s; a name more than one such agent has is refused, naming them; one that ended already says how', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'One.', name: 'twin' });
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'Two.', name: 'twin' });
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Alone.', name: 'solo', folder: lab });
		const solo = callerOf(world.agent(4));
		const done = (stopping: Promise<{ readonly agent: { readonly id: number }; readonly alreadyEnded: boolean }>) => outcomeOf(stopping.then(stopped => {
			if (stopped.alreadyEnded) {
				throw new Error(`#a${stopped.agent.id} had ended already`);
			}
		}));
		const outcomes = [
			await done(world.facade.stopAgent(lead, '@twin')),
			await done(world.facade.stopAgent(solo, '#a2')),
			await done(world.facade.stopAgent(lead, '@human')),
			await done(world.facade.stopAgent(lead, '#a99')),
			await done(world.facade.stopAgent(lead, '@nobody')),
			await done(world.facade.stopAgent(lead, '@solo #a2')),
			await done(world.facade.stopAgent(lead, ' #a2 ')),
			await done(world.facade.stopAgent(lead, '2')),
			await done(world.facade.stopAgent(lead, '@twin')),
			await done(world.facade.stopAgent(lead, '@Twin #a3')),
			await done(world.facade.stopAgent(PERSON, '@solo'))
		];

		assert.deepStrictEqual({ outcomes, agents: agents(world), typed: world.terminals.typed, told: world.person.told }, {
			outcomes: [
				'INVALID: 2 agents that have not ended are called @twin: @twin #a2, @twin #a3. Name one by its number.',
				'fulfilled',
				'INVALID: @human is the person, not an agent: the tools that manage agents do not take them.',
				'NOT_FOUND: No agent is #a99: list_agents with all lists every agent you reach.',
				'NOT_FOUND: No agent you reach is called @nobody: list_agents with all lists them.',
				'INVALID: #a2 is @twin, not @solo: name it by its number alone, or by its name.',
				'#a2 had ended already',
				'#a2 had ended already',
				'fulfilled',
				'#a3 had ended already',
				'fulfilled'
			],
			agents: [
				'#a1 @lead by @human running',
				'#a2 @twin by #a1 stopped by #a4: with stop_agent',
				'#a3 @twin by #a1 stopped by #a1: with stop_agent',
				'#a4 @solo by @human stopped by @human: with stop_agent'
			],
			typed: ['@twin #a2: [closed]', '@twin #a3: [closed]', '@solo #a4: [closed]'],
			told: []
		});
	});

	test('with YOLO off an agent reaches its own tree only - its creator, its children, its siblings and theirs, ended ones too - and is refused any other, saying why; with YOLO on it reaches every agent of the window; a child takes its creator\'s YOLO, whatever the setting says by then', async () => {
		world.switches.yolo = false;
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'A.', name: 'a' });
		world.switches.yolo = true;
		await world.startUp(lead, { cli: 'arg', task: 'B.', name: 'b' });
		await world.startUp(PERSON, { cli: 'arg', task: 'Other.', name: 'other', folder: lab });
		const a = callerOf(world.agent(2));
		const seenByA = world.facade.listAgents(a, true).agents.map(row => row.id);
		const outcomes = [
			await outcomeOf(world.facade.stopAgent(a, '#a4')),
			await outcomeOf(world.facade.stopAgent(a, '@other')),
			await outcomeOf(world.facade.stopAgent(a, '#a3')),
			await outcomeOf(world.facade.stopAgent(callerOf(world.agent(4)), '#a2'))
		];

		assert.deepStrictEqual({ yolo: [1, 2, 3, 4].map(id => world.agent(id).yolo), roots: [1, 2, 3, 4].map(id => world.agent(id).root), seenByA, outcomes }, {
			yolo: [false, false, false, true],
			roots: [1, 1, 1, 4],
			seenByA: [1, 2, 3],
			outcomes: [
				'REFUSED: @other #a4 is outside your tree: your YOLO is off, and you reach only your own tree - the agents that come from the agent the person started that you come from.',
				'NOT_FOUND: No agent you reach is called @other: list_agents with all lists them.',
				'fulfilled',
				'fulfilled'
			]
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
			'INVALID: #m7 is not an agent\'s number but a message\'s: agents are numbered #a1, #a2 and on.',
			'INVALID: @human is the person, not an agent: the tools that manage agents do not take them.'
		]);
	});

	test('a stop whose process does not end in time answers pending, the agent left stopping, and its worktree stays; its end is recorded, stopped by whom it says, once its process does end', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', task: 'Lead.', folder: lab });
		world.timing.startTimeoutMs = 2_000;
		world.terminals.stubborn = true;
		const stopping = outcomeOf(world.facade.stopAgent(PERSON, '#a1'));
		await sleep(3_000);
		const pending = await stopping;
		const meanwhile = agents(world);
		world.terminals.stubborn = false;
		world.terminals.end('@main #a1', { byThePerson: false });

		assert.deepStrictEqual({ pending, meanwhile, agents: agents(world), told: world.person.told }, {
			pending: 'UNAVAILABLE: @main #a1 is still stopping: its process has not ended within 2 seconds. Facade goes on stopping it; list_agents shows when it has ended.',
			meanwhile: ['#a1 @main by @human stopping'],
			agents: ['#a1 @main by @human stopped by @human: with stop_agent'],
			told: []
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

	test('a terminal the person closes is a stop by the person, of which they are not told; one that ends by itself is an exit, with its CLI\'s exit code where it is known, and the person hears of their own child\'s; an agent\'s child\'s exit its creator sees in list_agents', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'A.', name: 'a', folder: lab });
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'B.', name: 'b', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'C.', name: 'c' });
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'D.', name: 'd', folder: lab });
		world.terminals.end('@c #a3', { exitCode: 0, byThePerson: false });
		world.terminals.end('@b #a2', { exitCode: 1, byThePerson: false });
		world.terminals.end('@d #a4', { byThePerson: false });
		world.terminals.end('@a #a1', { byThePerson: true });

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: [
				'#a1 @a by @human stopped by @human: its tab was closed',
				'#a2 @b by @human exited: its CLI ended with exit code 1',
				'#a3 @c by #a1 exited: its CLI ended with exit code 0',
				'#a4 @d by @human exited: its terminal closed'
			],
			told: ['@b #a2 exited: its CLI ended with exit code 1. (#a2\'s terminal)', '@d #a4 exited: its terminal closed. (#a4\'s terminal)']
		});
	});

	test('an agent that exits leaves the agents it started running, itself still their creator: nobody takes them in, and nobody is told of them - nor of an exit with code 0; one that exits while its child comes up leaves the child to come up all the same', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'A.', name: 'a' });
		const coming = world.facade.startAgent(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'B.', name: 'b' });
		await until(() => world.terminals.launched.length === 3);
		world.terminals.end('@lead #a1', { exitCode: 0, byThePerson: false });
		world.hello(3);
		const started = await settled(coming);

		assert.deepStrictEqual({ started: started.id, agents: agents(world), seenByThePerson: world.facade.listAgents(PERSON).agents.map(row => row.id), told: world.person.told }, {
			started: 3,
			agents: ['#a1 @lead by @human exited: its CLI ended with exit code 0', '#a2 @a by #a1 running', '#a3 @b by #a1 running'],
			seenByThePerson: [1],
			told: []
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

	/**
	 * The window closes and opens again - reloaded, or quit and started again, as `recover` is told - and
	 * the one after finds the terminals named still running.
	 */
	function reopen(...running: string[]): World {
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
		const after = reopen('@up #a1', '@slow #a2');
		const unknown = await outcomeOf(slow);
		await after.facade.recover(true);
		const recovered = agents(after);
		after.hello(2);

		assert.deepStrictEqual({ unknown, recovered, agents: agents(after), told: after.person.told }, {
			unknown: 'UNAVAILABLE: The window closed meanwhile: whether the agent came up is not known. list_agents says, once the window is back.',
			recovered: ['#a1 @up by @human running', '#a2 @slow by @human starting', '#a3 @gone by @human lost: its terminal was gone when Facade came back'],
			agents: ['#a1 @up by @human running', '#a2 @slow by @human running', '#a3 @gone by @human lost: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('one found starting is let start: it stays starting while its CLI has not connected, however long, and starts once it does; nothing is closed, and nobody is told', async () => {
		const starting = world.facade.startAgent(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Slow.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		const after = reopen('@main #a1');
		await outcomeOf(starting);
		await after.facade.recover(true);
		await sleep(600_000);
		const stillStarting = agents(after);
		after.hello(1);

		assert.deepStrictEqual({ stillStarting, agents: agents(after), typed: after.terminals.typed, told: after.person.told }, {
			stillStarting: ['#a1 @main by @human starting'],
			agents: ['#a1 @main by @human running'],
			typed: [],
			told: []
		});
	});

	test('one running but not yet told of its task - the window went between its hello and the line - is told once the window is back, with the delays its launch had', async () => {
		const starting = world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', folder: lab });
		await until(() => world.terminals.launched.length === 1);
		world.hello(1);
		const after = reopen('@main #a1');
		after.settings.told = { launch: { enterDelay: 60_000 } };
		await outcomeOf(starting);
		await after.facade.recover(true);
		await sleep(1_000);
		assert.deepStrictEqual({ typed: after.terminals.typed, task: after.agent(1).task, agents: agents(after) }, {
			typed: [
				`@main #a1: ${JSON.stringify(notice(after, '[facade] You are @main #a1, Told Code, started by @human.', 1))}`,
				`@main #a1: ${JSON.stringify('\r')}`
			],
			task: 'typed',
			agents: ['#a1 @main by @human running']
		});
	});

	test('a worktree Facade made that is gone - deleted by the person, or by git - is its no more', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', newWorktree: true, name: 'clamp' });
		const folder = worktreeFolder(lab, 'clamp');
		const after = reopen('@main #a1');
		fs.rmSync(folder, { recursive: true, force: true });
		await after.facade.recover(true);

		assert.deepStrictEqual({ made: after.table.madeWorktree(folder), agents: agents(after) }, {
			made: undefined,
			agents: ['#a1 @main by @human running', '#a2 @clamp by #a1 lost: its terminal was gone when Facade came back']
		});
	});

	test('a window the person closed - quitting Facade, or closing the window - takes its agents with it: none comes back, each is stopped as the window went, and the person hears nothing; the window after begins a new list, the log keeping them', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', newWorktree: true, name: 'clamp' });
		const after = reopen();
		await after.facade.recover();

		assert.deepStrictEqual({ agents: agents(after), ends: history(after).filter(line => line.startsWith('ended')), told: after.person.told }, {
			agents: [],
			ends: ['ended    @main #a1  stopped: its window went', 'ended    @clamp #a2  stopped: its window went'],
			told: []
		});
	});

	test('a reload that brings none of the agents\' terminals back: nothing saw them end, so each is lost, as after a crash, and nobody is told, as of any lost agent', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', newWorktree: true, name: 'clamp' });
		const after = reopen();
		await after.facade.recover(true);

		assert.deepStrictEqual({ agents: agents(after), told: after.person.told }, {
			agents: ['#a1 @main by @human lost: its terminal was gone when Facade came back', '#a2 @clamp by #a1 lost: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('another workspace\'s window that takes the agents once the window that had them was closed: those gone went with that window, stopped as it went, and the person hears nothing - though this window was reloaded', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
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

	test('the extension host started again in the same load of the window - none of the agents\' terminals back - is no window closed: each is lost, and nobody is told', async () => {
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, session: 'this-load' });
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, session: 'this-load' });
		await world.facade.recover();

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#a1 @main by @human lost: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('Facade turned off and on again, the window staying: an agent whose terminal ended meanwhile is lost, nothing having seen it end, and nobody is told; the list stays', async () => {
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, session: 'this-load' });
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		world.dispose('facade');
		world = fakeWorld(dir, { repositories: { [lab]: [] }, session: 'this-load' });
		await world.facade.recover();

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#a1 @main by @human lost: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('after a crash, one whose terminal is gone is lost, though none comes back, and nobody is told of a lost agent; the window after begins a new list, the log keeping them', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', model: 'small', effort: 'high', task: 'Clamp.', newWorktree: true, name: 'clamp' });
		const after = crash();
		await after.facade.recover();

		assert.deepStrictEqual({ agents: agents(after), ends: history(after).filter(line => line.startsWith('ended')), told: after.person.told }, {
			agents: [],
			ends: ['ended    @main #a1  lost: its terminal was gone when Facade came back', 'ended    @clamp #a2  lost: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('quitting and starting again begins a new list - the agents since, numbered on from the last - which a reload keeps; the log has every start and end, of this list and those before, in order, each agent named as Facade names it', async () => {
		await world.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'Test.', name: 'tests' });
		await world.startUp(lead, { cli: 'arg', model: 'small', effort: 'high', task: 'Lint.', name: 'lint' });
		await world.facade.stopAgent(lead, '@tests');
		world.terminals.end('@lint #a3', { exitCode: 1, byThePerson: false });
		const reloaded = reopen('@lead #a1');
		await reloaded.facade.recover(true);
		const keptByTheReload = agents(reloaded);
		const started = reopen();
		await started.facade.recover();
		const newList = agents(started);
		await started.startUp(PERSON, { cli: 'arg', model: 'large', effort: 'high', task: 'Again.', name: 'again', folder: lab });

		assert.deepStrictEqual({ keptByTheReload, newList, list: agents(started), history: history(started) }, {
			keptByTheReload: ['#a1 @lead by @human running', '#a2 @tests by #a1 stopped by #a1: with stop_agent', '#a3 @lint by #a1 exited: its CLI ended with exit code 1'],
			newList: [],
			list: ['#a4 @again by @human running'],
			history: [
				`started  @lead #a1  arg large high  YOLO on  by @human  in ${lab}`,
				`started  @tests #a2  arg small high  YOLO on  by @lead #a1  in ${lab}`,
				`started  @lint #a3  arg small high  YOLO on  by @lead #a1  in ${lab}`,
				'ended    @tests #a2  stopped by @lead #a1: with stop_agent',
				'ended    @lint #a3  exited: its CLI ended with exit code 1',
				'ended    @lead #a1  stopped: its window went',
				`started  @again #a4  arg large high  YOLO on  by @human  in ${lab}`
			]
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
		of.terminals.end(`@${name} #a${id}`, { exitCode: 0, byThePerson: false });
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
		await world.startUp(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
		const merged = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		const excluded = fs.readFileSync(exclude, 'utf8');
		exits('main', 1);

		assert.deepStrictEqual({ servers: Object.keys(merged.mcpServers), excluded, after: fs.readFileSync(mcp, 'utf8') === theirs, logged: world.logs.includes(`${mcp} is the person's: Facade's part is added to it while agents use it.`) }, {
			servers: ['docs', 'facade'],
			excluded: '/.told/skills/facade/SKILL.md\n',
			after: true,
			logged: true
		});
	});

	test('a file Facade would put there that git tracks gets Facade\'s part beside what it holds and no line in info/exclude - its change shows in git diff while agents use it, never hidden - and is as it was, byte for byte, once the last agent there ends; one of the person\'s it cannot add its part to refuses the start before anything is made, saying why', async () => {
		const tracked = '{}';
		fs.writeFileSync(mcp, tracked);
		world.git.trackedFiles.add(mcp);
		await world.startUp(PERSON, { name: 'main', cli: 'told', task: 'One.', folder: lab });
		const whileItRuns = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		const excluded = fs.readFileSync(exclude, 'utf8');
		exits('main', 1);
		const after = fs.readFileSync(mcp, 'utf8');
		world.git.trackedFiles.clear();
		fs.writeFileSync(mcp, 'not JSON');
		const notJson = await outcomeOf(world.facade.startAgent(PERSON, { name: 'other', cli: 'told', task: 'Two.', folder: lab }));

		assert.deepStrictEqual({ servers: Object.keys(whileItRuns.mcpServers), excluded, after, notJson, theirs: fs.readFileSync(mcp, 'utf8'), launched: world.terminals.launched.length, agents: agents(world) }, {
			servers: ['facade'],
			excluded: '/.told/skills/facade/SKILL.md\n',
			after: tracked,
			notJson: `REFUSED: Told Code is not started: ${mcp} is there already, and Facade does not write over it.`,
			theirs: 'not JSON',
			launched: 1,
			agents: ['#a1 @main by @human exited: its CLI ended with exit code 0']
		});
	});

	test('agents that need the same files share them; one that needs other content in a file other agents use is refused before it starts, naming the file - in any window', async () => {
		const injected = path.join(temp.dir, 'injected.json');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'one'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		const other = fakeWorld(path.join(temp.dir, 'two'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected, skill: '# Working in Facade Code, as another build has it' });
		try {
			await world.startUp(PERSON, { name: 'one', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
			const shared = await outcomeOf(world.startUp(PERSON, { name: 'two', cli: 'told', model: 'deep', effort: 'high', task: 'Two.', folder: lab }));
			const refused = await outcomeOf(other.facade.startAgent(PERSON, { name: 'three', cli: 'told', model: 'deep', effort: 'high', task: 'Three.', folder: lab }));

			assert.deepStrictEqual({ shared, refused, others: agents(other), skill: fs.readFileSync(path.join(lab, '.told', 'skills', 'facade', 'SKILL.md'), 'utf8').endsWith('# Working in Facade Code\n') }, {
				shared: 'fulfilled',
				refused: `REFUSED: Told Code is not started: ${path.join(lab, '.told', 'skills', 'facade', 'SKILL.md')} holds what Facade put there for other agents, which use it, and this one needs other content in it.`,
				others: [],
				skill: true
			});
		} finally {
			other.dispose();
		}
	});

	test('copies first: a put that fails part way takes back what it wrote, and the start fails; one cut short as its window went - recorded, not marked done - is taken back by the next window', async () => {
		// The exclude file cannot be written: the put fails once the files are in.
		fs.mkdirSync(exclude, { recursive: true });
		const failed = await outcomeOf(world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab }));
		const afterFailure = { left: listed(lab), record: fs.existsSync(path.join(temp.dir, 'workspace', 'injected.json')) };
		fs.rmSync(exclude, { recursive: true });
		// What a window that went left: the record of its put, and the one file it wrote of it.
		const content = '{ "half": "written" }';
		fs.writeFileSync(mcp, content);
		fs.writeFileSync(path.join(temp.dir, 'workspace', 'injected.json'), JSON.stringify({
			folders: { [lab]: { users: [], files: { '.mcp.json': { hash: crypto.createHash('sha256').update(content).digest('hex') } }, made: [], lines: [], writing: { files: { '.mcp.json': {} }, made: [], lines: [] } } },
			added: {}
		}));
		const after = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git') });
		world.dispose();
		world = after;
		await after.facade.recover();

		assert.deepStrictEqual({ failed, afterFailure, left: listed(lab), record: fs.existsSync(path.join(temp.dir, 'workspace', 'injected.json')), logged: after.logs.filter(line => line.includes('as its window went')) }, {
			failed: `FAILED: Told Code did not start as @main #a1: Told Code is not started: what Facade puts into ${lab} could not be written, and what was is taken back: EISDIR: illegal operation on a directory, read`,
			afterFailure: { left: [], record: false },
			left: [],
			record: false,
			logged: [`What Facade was putting into ${lab} as its window went is taken back.`]
		});
	});

	test('the files stay while any agent that uses them may run: through a reload, with Facade off, and however long; an agent of another workspace keeps them while its process runs, and they go once it is gone', async () => {
		const injected = path.join(temp.dir, 'injected.json');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'one'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		let other = fakeWorld(path.join(temp.dir, 'two'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		try {
			await world.startUp(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
			const processId = world.terminals.processes.get(1);
			const user = JSON.parse(fs.readFileSync(injected, 'utf8')).folders[lab].users;
			// The window reloads, the agent running on; another window comes and goes meanwhile.
			const terminals = world.terminals;
			world.dispose();
			await other.facade.recover();
			const whileReloading = listed(lab).length;
			world = fakeWorld(path.join(temp.dir, 'one'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
			world.terminals.running.add('@main #a1');
			await world.facade.recover(true);
			await sleep(3_600_000);
			other.dispose();
			other = fakeWorld(path.join(temp.dir, 'two'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
			await other.facade.recover();
			const anHourOn = listed(lab).length;
			// Its process goes with nobody there to see it end: the other window takes the files back.
			world.dispose();
			terminals.end('@main #a1');
			other.dispose();
			other = fakeWorld(path.join(temp.dir, 'two'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
			await other.facade.recover();

			assert.deepStrictEqual({ user, processRecorded: world.agent(1).processId === processId, whileReloading, anHourOn, after: listed(lab), record: fs.existsSync(injected) }, {
				user: [{ workspace: path.join(temp.dir, 'one'), id: 1, processId }],
				processRecorded: true,
				whileReloading: 6,
				anHourOn: 6,
				after: [],
				record: false
			});
		} finally {
			other.dispose();
		}
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
		await world.startUp(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
		fs.rmSync(mcp);
		world.terminals.end('@main #a1', { byThePerson: true });
		const keptDir = path.join(temp.dir, 'workspace', 'kept');
		const kept = fs.readdirSync(keptDir).map(name => path.join(keptDir, name));

		assert.deepStrictEqual({ kept: kept.map(file => fs.readFileSync(file, 'utf8')), told: world.person.told }, {
			kept: [theirs],
			told: [`${mcp} was gone when its agents ended: what it held before Facade's part went in is kept at ${kept[0]}.`]
		});
	});

	test('two windows on one folder: what one window\'s agents need there stays while the other window\'s end, and goes with the last of them', async () => {
		const injected = path.join(temp.dir, 'injected.json');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'one'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		const other = fakeWorld(path.join(temp.dir, 'two'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git'), injected });
		try {
			await world.startUp(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
			await other.startUp(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Two.', folder: lab });
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
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Lead.', folder: lab });
		const git = new DeferredPromise<void>();
		world.git.hold = git.p;
		const starting = world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', folder: lab });
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

suite('Core: the person\'s own agents', () => {

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

	test('the person\'s start from the agent menu answers once its terminal runs; should its CLI not connect in time, it stays starting and the person is told once, with a way to its terminal - its later connection needs no word', async () => {
		world.timing.startTimeoutMs = 5_000;
		const facts = await world.facade.startForPerson('arg', lab);
		await sleep(5_000);
		const told = [...world.person.told];
		const meanwhile = agents(world);
		world.hello(1);
		await sleep(1_000);

		assert.deepStrictEqual({ state: facts.state, told, meanwhile, after: agents(world), toldAfter: world.person.told }, {
			state: 'starting',
			told: ['@arg #a1 is open, but has not connected to Facade: it has no Facade tools yet. It may be slow, or waiting for an answer on its screen. (#a1\'s terminal)'],
			meanwhile: ['#a1 @arg by @human starting'],
			after: ['#a1 @arg by @human running'],
			toldAfter: told
		});
	});

	test('a script acting as the person that names no folder starts its agent in the folder on screen, and the branch it names is one checked out in that folder\'s repository', async () => {
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['docs'] }, activeFolder: lab });
		const here = await world.startUp(PERSON, { name: 'here', cli: 'arg' });
		const byBranch = await world.startUp(PERSON, { name: 'docs', cli: 'arg', folder: 'docs' });

		assert.deepStrictEqual([here.folder, byBranch.folder], [lab, worktreeFolder(lab, 'docs')]);
	});

	test('with the agent framework off the person\'s agent starts without Facade\'s integration - no server, skills or files in its folder, no group of the framework\'s - and is running once its process runs; turned on again, the next one has it', async () => {
		world.switches.framework = false;
		const off = await world.facade.startForPerson('told', lab);
		const offFiles = listed(lab);
		world.switches.framework = true;
		await world.facade.startForPerson('told', lab);

		assert.deepStrictEqual({ off: [off.integration, world.agent(1).state], offArgs: world.terminals.launched[0].args, offFiles, on: [world.agent(2).integration, world.agent(2).state], onFiles: listed(lab).includes('.mcp.json') }, {
			off: [false, 'running'],
			offArgs: ['--trust-folder'],
			offFiles: [],
			on: [true, 'starting'],
			onFiles: true
		});
	});
});

suite('Core: stopping an agent and deleting its worktree', () => {

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

	test('delete_worktree stops every agent in the worktree, whoever started it, then deletes the worktree, keeping its branch; work that would be lost - uncommitted or untracked files, unsaved editors - refuses it, listing them, with nothing stopped, unless the call says to discard it; discard_changes alone is refused', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		const clamp = worktreeFolder(lab, 'clamp');
		await world.startUp(PERSON, { cli: 'arg', task: 'Help.', name: 'helper', folder: clamp });
		world.git.changes.set(clamp, { files: ['src/clamp.ts', 'notes.md'], unsaved: ['src/width.ts'] });
		const discardAlone = await outcomeOf(world.facade.stopAgent(lead, '#a2', { discardChanges: true }));
		const refused = await outcomeOf(world.facade.stopAgent(lead, '#a2', { deleteWorktree: true }));
		const whileRefused = agents(world);
		const deleted = await world.facade.stopAgent(lead, '#a2', { deleteWorktree: true, discardChanges: true });

		assert.deepStrictEqual({
			discardAlone,
			refused,
			whileRefused,
			deleted: { alreadyEnded: deleted.alreadyEnded, stopped: deleted.stopped.map(each => each.id), worktree: deleted.worktree },
			agents: agents(world),
			steps: world.git.steps,
			exists: fs.existsSync(clamp),
			made: world.table.madeWorktree(clamp),
			told: world.person.told
		}, {
			discardAlone: 'INVALID: discard_changes says what to do with the changes in a worktree being deleted: give it with delete_worktree.',
			refused: `REFUSED: ${clamp} has work that deleting it would lose: 2 uncommitted or untracked files (src/clamp.ts, notes.md) and 1 unsaved editor (src/width.ts). Nothing was stopped. Commit what should stay, or call again with discard_changes: true to lose it.`,
			whileRefused: ['#a1 @lead by @human running', '#a2 @clamp by #a1 running', '#a3 @helper by @human running'],
			deleted: { alreadyEnded: false, stopped: [2, 3], worktree: { folder: clamp, deleted: true } },
			agents: [
				'#a1 @lead by @human running',
				'#a2 @clamp by #a1 stopped by #a1: with stop_agent, its worktree being deleted',
				'#a3 @helper by @human stopped by #a1: with stop_agent, its worktree being deleted'
			],
			steps: [`make clamp from aaaaaaa in ${lab}`, `delete ${clamp}`],
			exists: false,
			made: undefined,
			told: ['@helper #a3 was stopped by @lead #a1. (#a3\'s terminal)']
		});
	});

	test('delete_worktree never deletes a main checkout - the agent alone stops, and the answer says why; a caller whose YOLO is off is refused a worktree that holds an agent outside its tree, nothing stopped; a deletion git refuses says why, the agents stopped; an ended agent can be named again to delete its worktree', async () => {
		world.switches.yolo = false;
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		const clamp = worktreeFolder(lab, 'clamp');
		world.switches.yolo = true;
		await world.startUp(PERSON, { cli: 'arg', task: 'Other.', name: 'other', folder: clamp });
		const outOfTree = await outcomeOf(world.facade.stopAgent(lead, '#a2', { deleteWorktree: true }));
		const inMain = await world.facade.stopAgent(PERSON, '#a1', { deleteWorktree: true });
		world.git.failDelete = 'git could not remove the folder: a process has it open';
		const failed = await world.facade.stopAgent(PERSON, '#a2', { deleteWorktree: true });
		world.git.failDelete = undefined;
		const again = await world.facade.stopAgent(PERSON, '#a2', { deleteWorktree: true });

		assert.deepStrictEqual({
			outOfTree,
			inMain: { stopped: inMain.stopped.map(each => each.id), worktree: inMain.worktree },
			failed: { stopped: failed.stopped.map(each => each.id), worktree: failed.worktree },
			again: { alreadyEnded: again.alreadyEnded, stopped: again.stopped.map(each => each.id), worktree: again.worktree },
			agents: agents(world)
		}, {
			outOfTree: `REFUSED: ${clamp} has @other #a3 in it, outside your tree: your YOLO is off, and you reach only your own tree. Nothing was stopped.`,
			inMain: { stopped: [1], worktree: { folder: lab, deleted: false, why: 'it is its repository\'s main checkout, which is never deleted' } },
			failed: { stopped: [2, 3], worktree: { folder: clamp, deleted: false, why: 'git could not remove the folder: a process has it open' } },
			again: { alreadyEnded: true, stopped: [], worktree: { folder: clamp, deleted: true } },
			agents: [
				'#a1 @lead by @human stopped by @human: with stop_agent',
				'#a2 @clamp by #a1 stopped by @human: with stop_agent, its worktree being deleted',
				'#a3 @other by @human stopped by @human: with stop_agent, its worktree being deleted'
			]
		});
	});
});

suite('Core: custom agents', () => {

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

	test('a custom agent starts as a built-in does, by its name, from the person or an agent: its launch is the person\'s alone - each group they filled in given where it applies, none of Facade\'s - and ${mcpConfig} names a file of its run with Facade\'s server; what its launch has no group for is not given: a model or an effort is left out, recorded and said, and a task is refused before anything is made', async () => {
		world.custom.review = { path: 'review', launch: { arguments: { connect: ['--mcp', '${mcpConfig}'], yoloOn: ['--auto'], task: ['--prompt', '${task}'] } } };
		world.custom.plain = { path: 'plain' };
		await world.facade.startForPerson('review', lab);
		world.hello(1);
		const lead = callerOf(world.agent(1));
		const child = await world.startUp(lead, { name: 'reviewer', cli: 'review', model: 'big', effort: 'high', task: 'Review.' });
		const refused = await outcomeOf(world.facade.startAgent(lead, { name: 'plain', cli: 'plain', task: 'Do it.' }));
		const plain = await world.facade.startAgent(lead, { name: 'plain', cli: 'plain' });
		const runs = world.table.runsDir;

		assert.deepStrictEqual({
			personArgs: world.terminals.launched[0].args,
			server: JSON.parse(fs.readFileSync(path.join(runs, '1.mcp.json'), 'utf8')).mcpServers.facade.args,
			child: { ignored: child.ignored, model: child.model, effort: child.effort, args: world.terminals.launched[1].args },
			refused,
			plain: { status: plain.status, integration: plain.integration, state: plain.state, args: world.terminals.launched[2].args },
			startable: world.facade.startable().filter(each => each.custom)
		}, {
			personArgs: ['--mcp', path.join(runs, '1.mcp.json'), '--auto'],
			server: ['/facade/shim.js', 'mcp', '--pipe', 'pipe', '--token-file', path.join(runs, '1.token')],
			child: { ignored: ['model', 'effort'], model: 'big', effort: 'high', args: ['--mcp', path.join(runs, '2.mcp.json'), '--auto', '--prompt', notice(world, '[facade] You are @reviewer #a2, review, started by @review.', 1)] },
			refused: 'REFUSED: plain cannot be given a task: its launch in facade.agents.custom.plain.launch has no connect group, so it cannot read Facade\'s messages. Start it without a task, or ask the person to fill that in.',
			plain: { status: 'started', integration: false, state: 'running', args: [] },
			startable: [
				{ id: 'review', displayName: 'review', custom: true, integration: true, task: true, model: false, effort: false },
				{ id: 'plain', displayName: 'plain', custom: true, integration: false, task: false, model: false, effort: false }
			]
		});
	});

	test('a custom agent whose settings are wrong - no program, a name a built-in has, a part a launch does not have - is listed for the person, and refused to every start, naming each', async () => {
		world.custom.arg = { path: 'arg' };
		world.custom.broken = { launch: { arguments: { tsak: ['--x'] } } };
		const outcomes = [
			await outcomeOf(world.facade.startAgent(PERSON, { name: 'one', cli: 'broken', folder: lab })),
			await outcomeOf(world.facade.startForPerson('arg', lab))
		];

		assert.deepStrictEqual({ outcomes, startable: world.facade.startable().map(each => each.id) }, {
			outcomes: [
				'UNAVAILABLE: Facade cannot start broken until the person puts its settings right: facade.agents.custom.broken.path is not set: a custom agent needs the program to start; facade.agents.custom.broken.launch.arguments has tsak, which is no group of broken\'s arguments: it has warmUp, connect, quiet, questions, messages, yoloOn, yoloOff, model, effort, extra, task. Show Agent Launch shows them.',
				'fulfilled'
			],
			startable: ['arg', 'told']
		});
	});
});
