/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DeferredPromise } from '../base/async';
import { readCliConfig } from '../clis/config';
import { FacadeError } from '../core/errors';
import { Injections } from '../core/injections';
import { SetupOutcome } from '../core/ports';
import { Caller, End, PERSON } from '../record/events';
import { writeIdentity } from '../record/identity';
import { settled, sleep, until, useFakeClock } from './clock';
import { argCli, callerOf, endFakeProcess, fakeWorld, isFakeProcessRunning, startFakeProcess, worktreeFolder } from './fakes';
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

	test('the person starts an agent from the agent menu in the folder on screen, asking nothing: #a1, named after its CLI\'s id, its CLI in a terminal of its own put in front, given no model, effort or task, its YOLO the setting\'s, with its launch alone - its question tool its own, for the person to answer (L4) - and its token in its run folder; it is running once its MCP server says hello, and nothing is said to the person', async () => {
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
			facts: { id: 1, name: 'arg', root: 1, cli: 'arg', custom: false, ignored: [], yolo: true, sandbox: 'off', integration: true, connected: false, worktree: 'main', folder: lab, state: 'starting', phase: 'connecting', startTime: 0, task: 'none' },
			starting: ['#a1 @arg by @human starting'],
			launched: [{
				id: 1,
				name: '@arg #a1',
				command: 'arg',
				executable: path.join(temp.dir, 'workspace', 'bin', 'arg.exe'),
				args: ['--config', config, '--yolo'],
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
			steps: [`make clamp from aaaaaaa in ${lab}`, `set up ${folder}`],
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
			detachedByBranch: `NOT_FOUND: No worktree of lab has spike checked out. Its worktrees: main at ${lab}, docs at ${docs}, spike at ${spike}. A folder is named by its absolute path; a worktree on a detached HEAD, by its folder.`,
			folders: [{ folder: lab, worktree: 'main' }, { folder: docs, worktree: 'docs' }, { folder: spike, worktree: 'spike' }, { folder: api, worktree: 'main' }, { folder: notes, worktree: 'notes' }]
		});
	});

	test('a new worktree starts at the caller\'s commit in the caller\'s own repository, whichever of its folders is named; in another repository - and for the person with no folder on screen - at that repository\'s main checkout\'s', async () => {
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

		assert.deepStrictEqual(world.git.steps.filter(step => step.startsWith('make')), [
			`make own from ddddddd in ${lab}`,
			`make own-main from ddddddd in ${lab}`,
			`make other from ccccccc in ${api}`,
			`make persons from bbbbbbb in ${lab}`
		]);
	});

	test('the person\'s new worktree starts at the commit of the checkout on their screen - a worktree of the repository, not its main checkout - and in another repository at that one\'s main checkout\'s (O3; N-06)', async () => {
		const api = path.join(temp.dir, 'api');
		fs.mkdirSync(api);
		const docs = worktreeFolder(lab, 'docs');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['docs'], [api]: [] }, activeFolder: docs });
		world.git.setHead(docs, 'd'.repeat(40));
		world.git.setHead(lab, 'b'.repeat(40));
		world.git.setHead(api, 'c'.repeat(40));
		const child = { cli: 'arg', model: 'small', effort: 'high', task: 'Go.', newWorktree: true };
		await world.startUp(PERSON, { ...child, name: 'here' });
		await world.startUp(PERSON, { ...child, name: 'main-named', folder: lab });
		await world.startUp(PERSON, { ...child, name: 'other', folder: api });

		assert.deepStrictEqual(world.git.steps.filter(step => step.startsWith('make')), [
			`make here from ddddddd in ${lab}`,
			`make main-named from ddddddd in ${lab}`,
			`make other from ccccccc in ${api}`
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
				'INVALID: nope is neither a CLI Facade starts nor a custom agent of the person\'s. It starts: arg, told.',
				'INVALID: "facade" is reserved: choose another name.',
				'INVALID: "two words" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'INVALID: "@Main" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'INVALID: folder is required here: the person has no folder on screen. Name a folder of the window by its absolute path.',
				`NOT_FOUND: ${path.join(temp.dir, 'elsewhere')} is no folder of this window. Its folders: ${lab}, ${worktreeFolder(lab, 'docs')}, ${path.join(temp.dir, 'docs-again')}, ${plain}.`,
				'INVALID: docs is no absolute path, and the person has no folder on screen for it to be a branch of. Name a folder of the window by its absolute path.',
				`REFUSED: ${plain} is in no git repository, so no worktree of it can be made: start the child in the folder itself, without new_worktree.`,
				'REFUSED: lab has a branch called spike already, and a new worktree is on a new branch, named after the child: give the child another name, or start it in the worktree of spike by its folder.',
				'REFUSED: v1..2 cannot be the branch of a new worktree: git does not take "v1..2" for a branch\'s name. Give the child another name.',
				`NOT_FOUND: No worktree of lab has nope checked out. Its worktrees: main at ${lab}, docs at ${worktreeFolder(lab, 'docs')}, docs at ${path.join(temp.dir, 'docs-again')}. A folder is named by its absolute path; a worktree on a detached HEAD, by its folder.`,
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

	test('the notice of a task is typed as one line, the person\'s typing held back from its start to its Enter; stopped in between, the hold ends with no Enter typed (PS-14; X-43)', async () => {
		world.settings.told = { launch: { enterDelay: 2_000 } };
		world.terminals.stubborn = true;
		const starting = outcomeOf(world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', folder: lab }));
		await until(() => world.terminals.launched.length === 1);
		world.hello(1);
		await until(() => world.terminals.lines.length === 1);
		const stopping = outcomeOf(world.facade.stopAgent(PERSON, '#a1'));
		await sleep(3_000);
		const lines = [...world.terminals.lines];
		const typed = world.terminals.typed.map(each => each.replace(/: ".*"$/, ': "…"'));
		world.terminals.stubborn = false;
		await settled(stopping);
		await settled(starting);

		assert.deepStrictEqual({ lines, typed }, { lines: ['@main #a1: begin', '@main #a1: end'], typed: ['@main #a1: "…"'] });
	});

	test('with YOLO off, a start whose exemption the person took away - a deny rule of theirs, or the group of Facade\'s launch that carries it changed - says so in its result and the log, never that it works; with YOLO on, nothing (L4, rule 4; X-38; YO-09)', async () => {
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, environment: () => ({ ARG_DENY: '/home/.arg/settings.json' }) });
		const on = await world.startUp(PERSON, { name: 'on', cli: 'arg', task: 'One.', folder: lab });
		world.switches.yolo = false;
		const denied = await world.startUp(PERSON, { name: 'denied', cli: 'arg', task: 'Two.', folder: lab });
		world.settings.arg = { launch: { arguments: { yoloOff: ['--sandbox'] } } };
		const both = await world.startUp(PERSON, { name: 'both', cli: 'arg', task: 'Three.', folder: lab });

		assert.deepStrictEqual({ notes: [on.notes ?? [], denied.notes, both.notes], logged: world.logs.filter(line => line.includes('Facade\'s tools:')) }, {
			notes: [[], [
				'With YOLO off, Arg Code refuses Facade\'s tools: /home/.arg/settings.json denies mcp__facade.'
			], [
				'With YOLO off, Arg Code refuses Facade\'s tools: /home/.arg/settings.json denies mcp__facade.',
				'With YOLO off, Arg Code may ask for approval before Facade\'s tools: its launch\'s yoloOff group is changed from Facade\'s, which lets its server through.'
			]],
			logged: [
				'@denied #a2: With YOLO off, Arg Code refuses Facade\'s tools: /home/.arg/settings.json denies mcp__facade.',
				'@both #a3: With YOLO off, Arg Code refuses Facade\'s tools: /home/.arg/settings.json denies mcp__facade.',
				'@both #a3: With YOLO off, Arg Code may ask for approval before Facade\'s tools: its launch\'s yoloOff group is changed from Facade\'s, which lets its server through.'
			]
		});
	});

	test('a CLI told of its task in its terminal that is stopped before its notice is typed is typed nothing after its stop, however long its process takes to end (C-CORE-19; X-43)', async () => {
		world.settings.told = { launch: { taskDelay: 2_000 } };
		world.terminals.stubborn = true;
		const starting = outcomeOf(world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', folder: lab }));
		await until(() => world.terminals.launched.length === 1);
		world.hello(1);
		await sleep(1_000);
		const stopping = outcomeOf(world.facade.stopAgent(PERSON, '#a1'));
		await sleep(5_000);
		const typed = [...world.terminals.typed];
		const state = world.table.get(1)?.state;
		world.terminals.stubborn = false;
		await settled(stopping);
		await settled(starting);

		assert.deepStrictEqual({ typed, state }, { typed: [], state: 'stopping' });
	});

	test('a CLI told of its task in its terminal whose terminal goes as its notice is about to be typed - its CLI ending, the window telling of it after - fails its start with how it ended, never answering that it stays starting (N-80; C4-09)', async () => {
		world.settings.told = { launch: { taskDelay: 2_000 } };
		const starting = outcomeOf(world.facade.startAgent(PERSON, { name: 'main', cli: 'told', model: 'deep', effort: 'high', task: 'Plan.', folder: lab }));
		await until(() => world.terminals.launched.length === 1);
		world.hello(1);
		await sleep(1_000);
		// Gone from the window before its notice is typed; the window tells of its end only after the typing failed
		world.terminals.lose('@main #a1');
		await sleep(1_500);
		world.terminals.endLost('@main #a1', { byThePerson: false, exitCode: 0 });
		const outcome = await starting;

		assert.deepStrictEqual({ outcome, agents: agents(world), typed: world.terminals.typed }, {
			outcome: 'FAILED: Told Code did not start as @main #a1: its CLI ended with exit code 0',
			agents: ['#a1 @main by @human failed: its CLI ended with exit code 0'],
			typed: []
		});
	});

	test('an agent started through start_agent - by another agent, or by the person\'s script - runs with its launch\'s unattended part, where nobody may be watching, and is recorded so; the person\'s own, from the window, with its launch alone (L4)', async () => {
		await world.facade.startForPerson('arg', lab);
		world.hello(1);
		await world.startUp(PERSON, { cli: 'arg', task: 'Script.', name: 'scripted', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', task: 'Child.', name: 'child' });
		const asked = world.terminals.launched.map(launch => `${launch.name} ${launch.args.includes('--no-ask') ? 'asks in words' : 'may put a question up'}`);

		assert.deepStrictEqual({ asked, unattended: [1, 2, 3].map(id => world.agent(id).unattended ?? false) }, {
			asked: ['@arg #a1 may put a question up', '@scripted #a2 asks in words', '@child #a3 asks in words'],
			unattended: [false, true, true]
		});
	});

	test('an agent started through start_agent with no task, of a CLI that keeps its question tool and takes its notice as its argument - Muse Code - is given its opening alone, which tells it to ask in words: nothing else it is sure to read does; one with a task its task\'s notice; the person\'s own nothing, at its prompt (L4; N-71)', async () => {
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, argKeepsQuestions: true });
		await world.facade.startForPerson('arg', lab);
		world.hello(1);
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', name: 'idle' });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', task: 'Work.', name: 'busy' });
		const last = world.terminals.launched.map(launch => launch.args.includes('--') ? launch.args[launch.args.length - 1] : 'at its prompt');

		assert.deepStrictEqual(last, [
			'at its prompt',
			'[facade] You are @idle #a2, Arg Code, started by @arg.',
			notice(world, '[facade] You are @busy #a3, Arg Code, started by @arg.', 1)
		]);
	});

	test('the person\'s history says what each agent\'s terminal runs, as it is launched: its command line, what its launch sets in its environment, and the files its arguments name - its settings - as written; its token\'s file by its path, never the token (N-76; UI-14)', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', model: 'large', effort: 'high', task: 'Plan.', folder: lab });
		const token = fs.readFileSync(path.join(world.table.runsDir, '1.token'), 'utf8').trim();

		assert.deepStrictEqual({ history: history(world).map(line => line.split(world.table.dir).join('…')), token: fs.readFileSync(world.table.logFile, 'utf8').includes(token) }, {
			history: [
				`started  @main #a1  arg large high  YOLO on  by @human  in ${lab}`,
				'launched @main #a1  …/bin/arg.exe --config …/runs/1.config.json --no-ask --yolo --model large --effort high -- "[facade] You are @main #a1, Arg Code, started by @human. Your task is message #m1, in …/messages/1.md: read that file, then do what it says."  environment ARG_QUIET=1  …/runs/1.config.json {"command":"/facade/facade","args":["/facade/shim.js","mcp","--pipe","pipe","--token-file","…/runs/1.token"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}',
				'connected @main #a1',
				'running  @main #a1'
			],
			token: false
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
			// The token's file, never the token: every process the agent starts inherits its environment
			agent: { pipe: launch.env.FACADE_AGENTS_PIPE, tokenIsAFile: path.isAbsolute(launch.env.FACADE_AGENTS_TOKEN ?? ''), token: world.table.authenticate(fs.readFileSync(launch.env.FACADE_AGENTS_TOKEN ?? '', 'utf8').trim()) },
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
			agent: { pipe: 'pipe', tokenIsAFile: true, token: { id: 1, name: 'main' } },
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
			inTrust: 'UNAVAILABLE: Arg Code cannot be started as its settings are: facade.agents.arg.launch.trust.file has ${nowhere}, for which Facade has no value: it has ${home}, ${folder}, ${repository}, ${argHome}.',
			made: [],
			slow: 'it has not started within 5 seconds: its CLI is open but has not connected to Facade, and may be slow, or waiting for an answer on its screen'
		});
	});

	test('what would refuse a start - a ${name} in a group of either YOLO, or one only a model gives, the person\'s own configuration Facade\'s server would mix with - is said for Show Agent Launch, once each, allocating and making nothing; a launch with none says none (L9; X-38)', async () => {
		const own = path.join(temp.dir, 'workspace', 'arg-home', 'own.conf');
		const cli = argCli(path.join(temp.dir, 'workspace', 'arg-home'));
		const installed = () => ({ cli, config: readCliConfig(cli, name => world.settings.arg?.[name]), executable: '/bin/arg' });
		const none = await world.facade.launchProblems(installed(), lab);
		world.settings.arg = { launch: { arguments: { yoloOff: ['--sandbox', '${nowhere}'], model: ['--model', '${model}', '${size}'] } } };
		fs.mkdirSync(path.dirname(own), { recursive: true });
		fs.writeFileSync(own, '[facade]');
		const problems = await world.facade.launchProblems(installed(), lab);

		assert.deepStrictEqual({ none, problems, allocated: [...world.table.state.agents.keys()], steps: world.git.steps }, {
			none: [],
			problems: [
				'Arg Code cannot be started as its settings are: facade.agents.arg.launch.arguments.model has ${size}, for which Facade has no value: it has ${config}, ${model}, ${effort}, ${task}.',
				`Arg Code cannot be started: ${own} has a server of its own named facade.`,
				'Arg Code cannot be started as its settings are: facade.agents.arg.launch.arguments.yoloOff has ${nowhere}, for which Facade has no value: it has ${config}, ${model}, ${effort}, ${task}.'
			],
			allocated: [],
			steps: []
		});
	});

	test('the person\'s own configuration of a CLI that its launch would mix Facade\'s server into refuses its start before anything is allocated or made, naming the file; without Facade\'s server it starts (X-47)', async () => {
		const own = path.join(temp.dir, 'workspace', 'arg-home', 'own.conf');
		fs.mkdirSync(path.dirname(own), { recursive: true });
		fs.writeFileSync(own, '[facade]');
		const refused = await outcomeOf(world.facade.startAgent(PERSON, { name: 'clamp', cli: 'arg', task: 'Clamp.', newWorktree: true, folder: lab }));
		const allocated = [...world.table.state.agents.keys()];
		world.settings.arg = { launch: { arguments: { connect: null } } };
		await world.startUp(PERSON, { name: 'plain', cli: 'arg', folder: lab });

		assert.deepStrictEqual({ refused, allocated, steps: world.git.steps, agents: agents(world) }, {
			refused: `UNAVAILABLE: Arg Code cannot be started: ${own} has a server of its own named facade.`,
			allocated: [],
			steps: [],
			agents: ['#a1 @plain by @human running']
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

	test('a stop of an agent whose own process is gone, though the window cannot close a terminal of it - one of a window that went, not taken back - finishes at once: the agent ended, stopped, not left stopping until a later window looks (run 4: WIN-03, WIN-04)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'One.', name: 'one', folder: lab });
		world.terminals.stubborn = true;
		world.timing.startTimeoutMs = 5_000;
		endFakeProcess(world.terminals.processes.get(1)!);
		const stopped = await settled(outcomeOf(world.facade.stopAgent(PERSON, '#a1')), 1_000);

		assert.deepStrictEqual({ stopped, end: world.table.get(1)?.end?.kind }, { stopped: 'fulfilled', end: 'stopped' });
	});

	test('an agent is connected while an MCP server that said hello for it runs: a second one under its token that ends - a client of its own, or its server started anew - leaves it connected while the first runs; once none runs, it is not (N-77; J-03)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const connected = () => world.facade.listAgents(PERSON).agents.find(row => row.id === 1)?.connected;
		const [own, second] = [startFakeProcess(), startFakeProcess()];
		world.facade.connected(lead, own);
		world.facade.connected(lead, second);
		const both = connected();
		endFakeProcess(second);
		const secondGone = connected();
		endFakeProcess(own);

		assert.deepStrictEqual({ both, secondGone, noneLeft: connected() }, { both: true, secondGone: true, noneLeft: false });
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
				'NOT_FOUND: No agent is both @solo and #a2: #a2 is @twin. Name it by its number alone, or by its name.',
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
				'REFUSED: #a4 is outside your tree: your YOLO is off, and you reach only your own tree - the agents that come from the agent the person started that you come from.',
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

	test('a stop whose process does not end in time answers pending, and its worktree stays; Facade goes on stopping it, and its end is recorded, stopped by whom it says, once its process does end', async () => {
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
			meanwhile: ['#a1 @main by @human stopped by @human: with stop_agent'],
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

	test('a terminal the person closes is a stop by the person, of which they are not told; one that ends by itself is an exit, with its CLI\'s exit code where it is known, and the person hears of their own child\'s, as of a failure (N-73); an agent\'s child\'s exit its creator sees in list_agents', async () => {
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
			told: ['error: @b #a2 exited: its CLI ended with exit code 1. (#a2\'s terminal)', 'error: @d #a4 exited: its terminal closed. (#a4\'s terminal)']
		});
	});

	test('an agent whose process went with the window\'s terminal host - restarted, which ends it with -1, no exit of any CLI\'s - is lost, not exited, and nobody is told (N-58; TM-17)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'A.', name: 'a', folder: lab });
		world.terminals.end('@a #a1', { exitCode: -1, byThePerson: false });

		assert.deepStrictEqual({ agents: agents(world), told: world.person.told }, {
			agents: ['#a1 @a by @human lost: the window\'s terminal host restarted, ending its process'],
			told: []
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

	test('an agent that comes back with no terminal while its own process runs on - a CLI that ignored the hang-up its terminal\'s going sent it - is ended by its process, its end recorded once it is gone, not before (LA-15; N-24)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'One.', name: 'one', folder: lab });
		const pid = world.terminals.processes.get(1)!;
		const launchTime = world.table.get(1)!.launchTime!;
		const after = reopen();
		after.processStarts.set(pid, launchTime);
		after.ignoringTermination.add(pid);
		await after.facade.recover(true);
		const meanwhile = after.table.get(1)?.state;
		await sleep(6_000);
		await until(() => after.table.get(1)?.state === 'ended');

		assert.deepStrictEqual({ meanwhile, killed: after.killed, end: after.table.get(1)?.end?.kind }, { meanwhile: 'running', killed: [`${pid} SIGTERM`, `${pid} SIGKILL`], end: 'lost' });
	});

	test('an agent whose terminal the window made, the window going before Facade heard its process - a reload between the two - comes back with the process the window has, recorded: never a run without one (N-79; C4-07b)', async () => {
		let open: () => void = () => undefined;
		world.terminals.hold = new Promise<void>(resolve => open = resolve);
		const starting = outcomeOf(world.facade.startAgent(PERSON, { cli: 'arg', task: 'One.', name: 'one', folder: lab }));
		await until(() => world.table.get(1)?.phase === 'launching_cli');
		const after = reopen('@one #a1');
		after.terminals.processes.set(1, 4242);
		open();
		await starting;
		await after.facade.recover(true);
		const launched = after.table.get(1);

		assert.deepStrictEqual({ state: launched?.state, processId: launched?.processId }, { state: 'starting', processId: 4242 });
	});

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

	test('one whose process the window saw end while Facade was away ended as it did - its CLI with its exit code, its tab closed by the person - not lost; one killed - the window writes 128 and the signal - is lost, saying by which signal, no exit of its CLI\'s (D11; N-58); nobody is told', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Three.', name: 'three', folder: lab });
		await world.startUp(PERSON, { cli: 'arg', task: 'Closed.', name: 'closed', folder: lab });
		await world.startUp(PERSON, { cli: 'arg', task: 'Gone.', name: 'gone', folder: lab });
		await world.startUp(PERSON, { cli: 'arg', task: 'Killed.', name: 'killed', folder: lab });
		const after = reopen();
		after.terminals.seenEnds.set(1, { exitCode: 3, byThePerson: false });
		after.terminals.seenEnds.set(2, { byThePerson: true });
		after.terminals.seenEnds.set(4, { exitCode: 137, byThePerson: false });
		await after.facade.recover(true);

		assert.deepStrictEqual({ agents: agents(after), told: after.person.told }, {
			agents: [
				'#a1 @three by @human exited: its CLI ended with exit code 3 while Facade was away',
				'#a2 @closed by @human stopped by @human: its tab was closed',
				'#a3 @gone by @human lost: its terminal was gone when Facade came back',
				process.platform === 'win32' ? '#a4 @killed by @human exited: its CLI ended with exit code 137 while Facade was away' : '#a4 @killed by @human lost: its CLI was killed (signal 9) while Facade was away'
			],
			told: []
		});
	});

	test('the window coming back asks after every agent at once: the tool calls wait for it, so however many agents there are, they wait the while it takes to answer for one', async () => {
		for (const name of ['one', 'two', 'three']) {
			await world.startUp(PERSON, { cli: 'arg', task: 'Go.', name, folder: lab });
		}
		const after = reopen('@one #a1', '@two #a2', '@three #a3');
		let answer = () => { };
		after.terminals.answering = new Promise<void>(resolve => answer = resolve);
		const recovering = after.facade.recover(true);
		await sleep(0);
		const asking = after.terminals.mostAsking;
		answer();
		await recovering;

		assert.deepStrictEqual({ asking, agents: agents(after) }, {
			asking: 3,
			agents: ['#a1 @one by @human running', '#a2 @two by @human running', '#a3 @three by @human running']
		});
	});

	test('one the window cannot tell of as it comes back is asked after again, a while on: found, it goes on as it was; gone, it is lost, and nobody is told', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Up.', name: 'up', folder: lab });
		await world.startUp(PERSON, { cli: 'arg', task: 'Gone.', name: 'gone', folder: lab });
		const after = reopen('@up #a1');
		after.terminals.untold.add(1);
		after.terminals.untold.add(2);
		await after.facade.recover(true);
		const meanwhile = agents(after);
		after.terminals.untold.clear();
		await sleep(15_000);

		assert.deepStrictEqual({ meanwhile, agents: agents(after), told: after.person.told }, {
			meanwhile: ['#a1 @up by @human running', '#a2 @gone by @human running'],
			agents: ['#a1 @up by @human running', '#a2 @gone by @human lost: its terminal was gone when Facade came back'],
			told: []
		});
	});

	test('one found starting is let start: it stays starting while its CLI has not connected, and starts once it does; nothing is closed; once the time its start had is over, the person is told once that theirs is not confirmed, as before the reload (AGENT-LAUNCHER.md, L5)', async () => {
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
			told: ['warning: @main #a1 is open, but has not connected to Facade: it has no Facade tools yet. It may be slow, or waiting for an answer on its screen. (#a1\'s terminal)']
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

	test('an untitled workspace\'s window that went - quit, or closed, its workspace not saved - leaves a record no window opens again: the next window to start records its agents ended, stopped as their window went; not one whose process runs on, nor those of a record closed a moment ago, by a window reloading; nobody is told (N-63; WIN-15)', async () => {
		const untitled = (id: string) => {
			const record = path.join(temp.dir, id);
			writeIdentity(record, `untitled:${id}`);
			return record;
		};
		const [left, reloading] = [untitled('1791579943707'), untitled('1791579955555')];
		const leftWindow = fakeWorld(left, { repositories: { [lab]: [] }, owner: 'left' });
		await leftWindow.startUp(PERSON, { name: 'gone', cli: 'arg', task: 'One.', folder: lab });
		await leftWindow.startUp(PERSON, { name: 'runs', cli: 'arg', task: 'Two.', folder: lab });
		endFakeProcess(leftWindow.terminals.processes.get(1)!);
		leftWindow.dispose();
		// A minute on, past a reload's
		const longAgo = new Date(Date.now() - 2 * 60_000);
		fs.utimesSync(path.join(left, 'ledger.lock'), longAgo, longAgo);
		const reloadingWindow = fakeWorld(reloading, { repositories: { [lab]: [] }, owner: 'reloading' });
		await reloadingWindow.startUp(PERSON, { name: 'back', cli: 'arg', task: 'Three.', folder: lab });
		endFakeProcess(reloadingWindow.terminals.processes.get(1)!);
		reloadingWindow.dispose();

		const after = reopen();
		await after.facade.recover();
		const [leftRecord, reloadingRecord] = [fakeWorld(left, { owner: 'left' }), fakeWorld(reloading, { owner: 'reloading' })];
		const found = { left: agents(leftRecord), reloading: agents(reloadingRecord), told: after.person.told };
		leftRecord.dispose();
		reloadingRecord.dispose();

		assert.deepStrictEqual(found, {
			left: ['#a1 @gone by @human stopped: its window went', '#a2 @runs by @human running'],
			reloading: ['#a1 @back by @human running'],
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

	test('a window that comes back after its renderer crashed - an agent of it came back - begins no new list: an agent that had ended stays listed (L12; N-36; REC-12)', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', task: 'Lead.', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', task: 'Clamp.', name: 'clamp' });
		world.terminals.end('@clamp #a2', { byThePerson: false, exitCode: 0 });
		fs.writeFileSync(path.join(dir, 'ledger.lock'), '424242 0123456789ab');
		world.dispose();
		world = fakeWorld(dir, { repositories: { [lab]: [] }, isRunning: pid => pid !== 424242 });
		world.terminals.running.add('@main #a1');
		await world.facade.recover();

		assert.deepStrictEqual(agents(world), ['#a1 @main by @human running', '#a2 @clamp by #a1 exited: its CLI ended with exit code 0']);
	});

	test('a start cut by a crash as its worktree was made, which git finished making after the window went: the window after records the worktree as the one made for it, and its end says where it stays (LC-renderer_crash-creating_worktree)', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', task: 'Lead.', folder: lab });
		world.git.making = new Promise<void>(() => { });
		const starting = outcomeOf(world.facade.startAgent(callerOf(world.agent(1)), { cli: 'arg', task: 'Clamp.', newWorktree: true, name: 'clamp' }));
		await until(() => world.table.get(2)?.phase === 'creating_worktree');
		const clamp = worktreeFolder(lab, 'clamp');
		const after = crash();
		void starting;
		// git, which the window went without, finishes
		after.git.addWorktree(lab, 'clamp', clamp);
		after.terminals.running.add('@main #a1');
		await after.facade.recover();

		assert.deepStrictEqual({ agents: agents(after), made: after.table.madeWorktree(clamp)?.name }, {
			agents: ['#a1 @main by @human running', `#a2 @clamp by #a1 failed: its start was cut as the window went, as its worktree was made, before its CLI was launched; its worktree stays, at ${clamp}`],
			made: 'clamp'
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

	test('quitting and starting again begins a new list - the agents since, numbered on from the last - which a reload keeps; the log has every start, launch, connection, start completed and end, of this list and those before, in order, each agent named as Facade names it - the lifecycle audit log (L5; PS-01; N-81)', async () => {
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

		// Each launch's line by its agent alone: what it holds is another test's
		assert.deepStrictEqual({ keptByTheReload, newList, list: agents(started), history: history(started).map(line => line.replace(/^(launched \S+ \S+) {2}.*$/, '$1')) }, {
			keptByTheReload: ['#a1 @lead by @human running', '#a2 @tests by #a1 stopped by #a1: with stop_agent', '#a3 @lint by #a1 exited: its CLI ended with exit code 1'],
			newList: [],
			list: ['#a4 @again by @human running'],
			history: [
				`started  @lead #a1  arg large high  YOLO on  by @human  in ${lab}`,
				'launched @lead #a1',
				'connected @lead #a1',
				'running  @lead #a1',
				`started  @tests #a2  arg small high  YOLO on  by @lead #a1  in ${lab}`,
				'launched @tests #a2',
				'connected @tests #a2',
				'running  @tests #a2',
				`started  @lint #a3  arg small high  YOLO on  by @lead #a1  in ${lab}`,
				'launched @lint #a3',
				'connected @lint #a3',
				'running  @lint #a3',
				'ended    @tests #a2  stopped by @lead #a1: with stop_agent',
				'ended    @lint #a3  exited: its CLI ended with exit code 1',
				'ended    @lead #a1  stopped: its window went',
				`started  @again #a4  arg large high  YOLO on  by @human  in ${lab}`,
				'launched @again #a4',
				'connected @again #a4',
				'running  @again #a4'
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

	test('the files a CLI reads from its folder are put there for its agents - kept out of git by lines in info/exclude where they are in a folder of Facade\'s own name, and a folder Facade made by a .gitignore of its own; .mcp.json, a name of the person\'s too, shows - and go once the last agent there ends (X-12)', async () => {
		await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'One.', name: 'one', folder: lab });
		await world.startUp(PERSON, { cli: 'told', model: 'deep', effort: 'high', task: 'Two.', name: 'two', folder: lab });
		const whileTheyRun = listed(lab);
		const excluded = fs.readFileSync(exclude, 'utf8');
		const ignoredWhileTheyRun = fs.readFileSync(path.join(lab, '.told', '.gitignore'), 'utf8');
		const server = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		exits('one', 1);
		const whileOneRuns = listed(lab);
		exits('two', 2);

		assert.deepStrictEqual({ whileTheyRun, excluded, ignored: ignoredWhileTheyRun, server, whileOneRuns, after: listed(lab), excludedAfter: fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : 'gone', record: fs.existsSync(path.join(temp.dir, 'workspace', 'injected.json')) }, {
			whileTheyRun: ['.mcp.json', '.told', '.told/.gitignore', '.told/skills', '.told/skills/facade', '.told/skills/facade/SKILL.md'],
			// No line for .mcp.json: it would hide the person's own in every worktree (O10; X-12)
			excluded: '/.told/skills/facade/SKILL.md\n',
			// Facade's own files alone: what an agent adds beside them is its work, which git shows.
			ignored: '/.gitignore\n/skills/facade/SKILL.md\n',
			server: { mcpServers: { facade: { command: '/facade/facade', args: ['/facade/shim.js', 'mcp', '--agent'] } } },
			whileOneRuns: whileTheyRun,
			after: [],
			// It had none: the one Facade made goes with its lines (X-65)
			excludedAfter: 'gone',
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

	test('a child in a new worktree whose base commit has a .mcp.json that cannot take Facade\'s part is refused before anything is made - no number, no branch, no folder - as in an existing folder; one that can take it is merged into (X-30)', async () => {
		await world.startUp(PERSON, { name: 'lead', cli: 'arg', task: 'Lead.', folder: lab });
		const lead = callerOf(world.agent(1));
		world.git.committed.set('.mcp.json', '{ "mcpServers": { "facade": { "command": "the-project-s-own" } } }');
		const refused = await outcomeOf(world.facade.startAgent(lead, { name: 'conflict', cli: 'told', task: 'Go.', newWorktree: true }));
		const afterRefusal = { agents: agents(world), steps: world.git.steps.filter(step => step.startsWith('make')), folder: fs.existsSync(worktreeFolder(lab, 'conflict')) };
		world.git.committed.set('.mcp.json', '{ "mcpServers": { "docs": { "command": "docs-server" } } }');
		const merged = await world.startUp(lead, { name: 'merged', cli: 'told', task: 'Go.', newWorktree: true });

		assert.deepStrictEqual({ refused, afterRefusal, merged: merged.status }, {
			refused: `REFUSED: Told Code is not started: ${path.join(worktreeFolder(lab, 'conflict'), '.mcp.json')} is in the commit its worktree would start at, and Facade does not write over it. Nothing was made.`,
			afterRefusal: { agents: ['#a1 @lead by @human running'], steps: [], folder: false },
			merged: 'started'
		});
	});

	test('info/exclude is as it was once the last agent there ends: the person\'s last line without its line break again, and one Facade had to make gone; files Facade makes in the project have a project file\'s permissions (X-65)', async function () {
		fs.mkdirSync(path.dirname(exclude), { recursive: true });
		fs.writeFileSync(exclude, '# mine\n*.log');
		await world.startUp(PERSON, { name: 'one', cli: 'told', task: 'One.', folder: lab });
		const whileUsed = fs.readFileSync(exclude, 'utf8');
		const skillMode = fs.statSync(path.join(lab, '.told', 'skills', 'facade', 'SKILL.md')).mode & 0o777;
		exits('one', 1);
		const unended = fs.readFileSync(exclude, 'utf8');
		fs.rmSync(exclude);
		await world.startUp(PERSON, { name: 'two', cli: 'told', task: 'Two.', folder: lab });
		const made = fs.existsSync(exclude);
		exits('two', 2);

		assert.deepStrictEqual({ whileUsed, unended, made, gone: !fs.existsSync(exclude), skillMode: process.platform === 'win32' || skillMode === (0o666 & ~process.umask()) }, {
			whileUsed: '# mine\n*.log\n/.told/skills/facade/SKILL.md\n',
			unended: '# mine\n*.log',
			made: true,
			gone: true,
			skillMode: true
		});
	});

	test('a file of the person\'s that Facade put its part into is put back byte for byte once the last agent there ends - a byte that is no UTF-8, a number past 2^53 and all (X-62; INJ-19)', async () => {
		const theirs = Buffer.concat([Buffer.from('{\n\t"mcpServers": {\n\t\t"mine": { "command": "true", "note": "caf\\u00e9 '), Buffer.from([0xff]), Buffer.from('" }\n\t},\n\t"big": 12345678901234567890\n}\n')]);
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.startUp(PERSON, { name: 'main', cli: 'told', task: 'One.', folder: lab });
		exits('main', 1);

		assert.deepStrictEqual(fs.readFileSync(mcp).equals(theirs), true);
	});

	test('a symbolic link where Facade would write - to a file outside the folder, a dangling one, or a folder of Facade\'s - refuses the start, naming it, and stays as it was: nothing written through it, nothing over it (X-63; INJ-20)', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const outside = path.join(temp.dir, 'outside.json');
		fs.writeFileSync(outside, '{}');
		const attempt = async (name: string) => outcomeOf(world.facade.startAgent(PERSON, { name, cli: 'told', task: 'One.', folder: lab }));
		fs.symlinkSync(outside, mcp);
		const toOutside = await attempt('one');
		fs.rmSync(mcp);
		fs.symlinkSync(path.join(temp.dir, 'nowhere.json'), mcp);
		const dangling = await attempt('two');
		const danglingKept = fs.readlinkSync(mcp);
		fs.rmSync(mcp);
		fs.mkdirSync(path.join(temp.dir, 'elsewhere'));
		fs.symlinkSync(path.join(temp.dir, 'elsewhere'), path.join(lab, '.told'));
		const linkedFolder = await attempt('three');

		assert.deepStrictEqual({ toOutside, dangling, danglingKept, linkedFolder, outside: fs.readFileSync(outside, 'utf8'), elsewhere: fs.readdirSync(path.join(temp.dir, 'elsewhere')), agents: world.table.state.agents.size }, {
			toOutside: `REFUSED: Told Code is not started: ${mcp} is a symbolic link, and Facade writes nothing through one, nor over it.`,
			dangling: `REFUSED: Told Code is not started: ${mcp} is a symbolic link, and Facade writes nothing through one, nor over it.`,
			danglingKept: path.join(temp.dir, 'nowhere.json'),
			linkedFolder: `REFUSED: Told Code is not started: ${path.join(lab, '.told')} is a symbolic link, and Facade writes nothing through one, nor over it.`,
			outside: '{}',
			elsewhere: [],
			agents: 0
		});
	});

	test('an earlier build\'s record - its windows as holders - is read, a copy kept beside it, and what it put there taken back once no window holds it; a record no build can read is moved aside, never written over (X-11; INJ-18)', async () => {
		const injected = path.join(temp.dir, 'workspace', 'injected.json');
		const mcpText = '{ "mcpServers": { "facade": { "command": "/old/facade" } } }';
		fs.writeFileSync(mcp, mcpText);
		fs.writeFileSync(injected, JSON.stringify({ folders: { [lab]: { holders: [path.join(temp.dir, 'gone-window')], files: { '.mcp.json': { hash: crypto.createHash('sha256').update(mcpText).digest('hex') } }, made: [], lines: [] } }, added: {} }));
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git') });
		await world.facade.recover();
		const afterEarlier = { mcp: fs.existsSync(mcp), kept: fs.readdirSync(path.dirname(injected)).filter(name => name.endsWith('.earlier')).length };
		fs.writeFileSync(injected, '{ not json');
		await world.startUp(PERSON, { name: 'main', cli: 'told', task: 'One.', folder: lab });
		const unread = fs.readdirSync(path.dirname(injected)).filter(name => name.endsWith('.unread'));

		assert.deepStrictEqual({ afterEarlier, unread: unread.map(name => fs.readFileSync(path.join(path.dirname(injected), name), 'utf8')) }, {
			afterEarlier: { mcp: false, kept: 1 },
			unread: ['{ not json']
		});
	});

	/** What `kept/` beside the injection record holds: each file's content, in order. */
	function keptFiles(): string[] {
		const kept = path.join(temp.dir, 'workspace', 'kept');
		return fs.existsSync(kept) ? fs.readdirSync(kept).sort().map(name => fs.readFileSync(path.join(kept, name), 'utf8')) : [];
	}

	/** Sets the record of what Facade put into `lab` as `change` leaves it - as a window killed at that point left it - and starts the window again. */
	async function killedAt(change: (entry: { users: unknown[]; writing?: unknown }) => void): Promise<void> {
		const injected = path.join(temp.dir, 'workspace', 'injected.json');
		const record = JSON.parse(fs.readFileSync(injected, 'utf8'));
		change(record.folders[Object.keys(record.folders)[0]]);
		fs.writeFileSync(injected, JSON.stringify(record));
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, gitDir: path.join(temp.dir, 'git') });
		await world.facade.recover();
	}

	test('a window killed after it put its part into the person\'s file, which they edited then: what the file held before is kept, and they are told once - Facade\'s part taken out where it is still there, their change kept (C-INJ-03; X-64)', async () => {
		const theirs = '{\n    "mcpServers": {\n        "docs": { "command": "docs-server" }\n    }\n}\n';
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.startUp(PERSON, { name: 'one', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
		const merged = JSON.parse(fs.readFileSync(mcp, 'utf8'));
		fs.writeFileSync(mcp, JSON.stringify({ ...merged, mine: true }, undefined, 4));
		await killedAt(entry => {
			entry.users = [];
			entry.writing = { files: { '.mcp.json': { before: Buffer.from(theirs).toString('base64') } }, made: [], lines: [] };
		});

		assert.deepStrictEqual({ file: JSON.parse(fs.readFileSync(mcp, 'utf8')), kept: keptFiles(), told: world.person.told.map(text => text.replace(/kept at .*$/, 'kept at …')) }, {
			file: { mcpServers: { docs: { command: 'docs-server' } }, mine: true },
			kept: [theirs],
			told: [`warning: ${mcp} changed after Facade's part went in, as its window went: what it held before is kept at …`]
		});
	});

	test('a window killed after it put the person\'s file back as it was, before it wrote down that it had: the next takes it back again without telling anyone it changed (C-INJ-04; X-64)', async () => {
		const theirs = '{\n    "mcpServers": {\n        "docs": { "command": "docs-server" }\n    }\n}\n';
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.startUp(PERSON, { name: 'one', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
		const whileItRan = fs.readFileSync(path.join(temp.dir, 'workspace', 'injected.json'), 'utf8');
		exits('one', 1);
		await until(() => fs.readFileSync(mcp, 'utf8') === theirs);
		fs.writeFileSync(path.join(temp.dir, 'workspace', 'injected.json'), whileItRan);
		await killedAt(entry => {
			entry.users = [];
		});

		assert.deepStrictEqual({ file: fs.readFileSync(mcp, 'utf8'), kept: keptFiles(), told: world.person.told }, { file: theirs, kept: [], told: [] });
	});

	test('a file of the person\'s that Facade\'s part went into, deleted by them, then written anew by a later start: what it held before is kept, and said, not lost - and at the end the file Facade wrote goes (C-INJ-09; X-64)', async () => {
		const theirs = '{\n    "mcpServers": {\n        "docs": { "command": "docs-server" }\n    }\n}\n';
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.startUp(PERSON, { name: 'one', cli: 'told', model: 'deep', effort: 'high', task: 'One.', folder: lab });
		fs.rmSync(mcp);
		await world.startUp(PERSON, { name: 'two', cli: 'told', model: 'deep', effort: 'high', task: 'Two.', folder: lab });
		const told = [...world.person.told];
		exits('one', 1);
		exits('two', 2);
		await until(() => !fs.existsSync(mcp));

		assert.deepStrictEqual({ kept: keptFiles(), told: told.map(text => text.replace(/kept at .*$/, 'kept at …')), gone: !fs.existsSync(mcp) }, {
			kept: [theirs],
			told: [`warning: ${mcp} was gone when another agent started there: what it held before Facade's part went in is kept at …`],
			gone: true
		});
	});

	test('the record says which files Facade wrote are as it wrote them, with their hashes - one of the person\'s it merged its part into with what it held before - and which someone changed since (X-23, X-73)', async () => {
		const theirs = '{\n    "mcpServers": {\n        "docs": { "command": "docs-server" }\n    }\n}\n';
		fs.writeFileSync(mcp, theirs);
		world.git.untrackedFiles.add(mcp);
		await world.startUp(PERSON, { name: 'main', cli: 'told', task: 'One.', folder: lab });
		const injections = new Injections(path.join(temp.dir, 'workspace', 'injected.json'), () => undefined, () => undefined, () => true);
		const hashOf = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(lab, file))).digest('hex');
		const unchanged = [...injections.ownedUnchanged(lab)].sort((a, b) => a.path.localeCompare(b.path));
		const written = [
			{ path: '.mcp.json', sha256: hashOf('.mcp.json'), theirs: Buffer.from(theirs).toString('base64') },
			{ path: '.told/.gitignore', sha256: hashOf('.told/.gitignore') },
			{ path: '.told/skills/facade/SKILL.md', sha256: hashOf('.told/skills/facade/SKILL.md') }
		];
		fs.appendFileSync(path.join(lab, '.told', 'skills', 'facade', 'SKILL.md'), 'Mine.\n');

		assert.deepStrictEqual({ unchanged, edited: injections.editedSince(lab) }, { unchanged: written, edited: ['.told/skills/facade/SKILL.md'] });
	});

	test('deleting a worktree counts what Facade put there as O5 has it: a file of the person\'s it merged its part into is no one\'s work only over what the commit has - one git does not track is theirs (C-INJ-20) - and an edit to a file of Facade\'s own, which info/exclude keeps out of git status, is work; both refuse before anyone is stopped (X-23, X-73)', async () => {
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['clean', 'mine', 'edited'] }, gitDir: path.join(temp.dir, 'git') });
		const at = (branch: string) => worktreeFolder(lab, branch);
		const theirs = '{\n    "mcpServers": {\n        "docs": { "command": "docs-server" }\n    }\n}\n';
		// clean: committed as it is, on a branch of its own; mine: the person's, never committed
		const cleanHead = 'c'.repeat(40);
		world.git.setHead(at('clean'), cleanHead);
		fs.writeFileSync(path.join(at('clean'), '.mcp.json'), theirs);
		world.git.trackedFiles.add(path.join(at('clean'), '.mcp.json'));
		world.git.committed.set(`${cleanHead}:.mcp.json`, theirs);
		fs.writeFileSync(path.join(at('mine'), '.mcp.json'), theirs);
		world.git.untrackedFiles.add(path.join(at('mine'), '.mcp.json'));
		for (const branch of ['clean', 'mine', 'edited']) {
			await world.startUp(PERSON, { name: branch, cli: 'told', task: 'Go.', folder: at(branch) });
		}
		// git status while the agents run: Facade's part in the person's files; Facade's own file excluded
		world.git.changes.set(at('clean'), { files: ['.mcp.json'], unsaved: [], submodules: [] });
		world.git.changes.set(at('mine'), { files: ['.mcp.json'], unsaved: [], submodules: [] });
		// Its part out, the committed file is as the commit has it again
		const cleanAgain = world.terminals.onDidEnd(id => {
			if (id === 1) {
				world.git.changes.delete(at('clean'));
			}
		});
		fs.appendFileSync(path.join(at('edited'), '.mcp.json'), '\n');

		const mine = await outcomeOf(world.facade.stopAgent(PERSON, '#a2', { deleteWorktree: true }));
		const edited = await outcomeOf(world.facade.stopAgent(PERSON, '#a3', { deleteWorktree: true }));
		const whileRefused = agents(world);
		const clean = await world.facade.stopAgent(PERSON, '#a1', { deleteWorktree: true });
		cleanAgain.dispose();

		const refusal = (branch: string) => `REFUSED: ${at(branch)} has work that deleting it would lose: 1 uncommitted or untracked file (.mcp.json). Nothing was stopped. Commit what should stay, or call again with discard_changes: true to lose it.`;
		assert.deepStrictEqual({ mine, edited, whileRefused, clean: clean.worktree }, {
			mine: refusal('mine'),
			edited: refusal('edited'),
			whileRefused: ['#a1 @clean by @human running', '#a2 @mine by @human running', '#a3 @edited by @human running'],
			clean: { folder: at('clean'), deleted: true }
		});
	});

	test('as the last agent ends, Facade takes out only its own part of a file someone changed: of an .mcp.json it made, a server the person added stays - and with nothing of theirs left it goes; one whose Facade entry they changed is left as it is, a copy kept and said once - of the one Facade made, and of the person\'s own (O10; X-28, X-29; INJ-06, INJ-07, INJ-16)', async () => {
		const kept = path.join(temp.dir, 'workspace', 'kept');
		const startAndEnd = async (name: string, change: (json: { mcpServers: { [name: string]: { command?: string } } }) => void) => {
			await world.startUp(PERSON, { name, cli: 'told', task: 'One.', folder: lab });
			const json = JSON.parse(fs.readFileSync(mcp, 'utf8'));
			change(json);
			fs.writeFileSync(mcp, JSON.stringify(json, undefined, '\t'));
			exits(name, world.table.state.lastId);
			const after = fs.existsSync(mcp) ? JSON.parse(fs.readFileSync(mcp, 'utf8')) : 'gone';
			fs.rmSync(mcp, { force: true });
			return after;
		};
		const added = await startAndEnd('added', json => json.mcpServers.mine = { command: 'true' });
		const facadeEdited = await startAndEnd('edited', json => json.mcpServers.facade.command = 'my-own-server');
		const keptOfMade = fs.existsSync(kept) ? fs.readdirSync(kept).length : 0;
		fs.writeFileSync(mcp, '{\n\t"mcpServers": {\n\t\t"docs": { "command": "docs-server" }\n\t}\n}\n');
		world.git.untrackedFiles.add(mcp);
		const theirsEdited = await startAndEnd('theirs', json => json.mcpServers.facade.command = 'my-own-server');
		const keptCopies = fs.readdirSync(kept).sort();

		assert.deepStrictEqual({
			added,
			facadeEdited: facadeEdited.mcpServers.facade.command,
			keptOfMade,
			theirsEdited: [Object.keys(theirsEdited.mcpServers), theirsEdited.mcpServers.facade.command],
			lastKept: JSON.parse(fs.readFileSync(path.join(kept, keptCopies.at(-1)!), 'utf8')),
			said: world.logs.filter(line => line.includes('Facade\'s own entry in it was changed')).length
		}, {
			added: { mcpServers: { mine: { command: 'true' } } },
			facadeEdited: 'my-own-server',
			keptOfMade: 1,
			theirsEdited: [['docs', 'facade'], 'my-own-server'],
			lastKept: { mcpServers: { docs: { command: 'docs-server' } } },
			said: 2
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

	test('a worktree another window\'s agent works in - known by what Facade put there for it - is not deleted from this one while that agent runs: refused before anyone is stopped; once it has ended, it is (X-10, SP-18)', async () => {
		const injected = path.join(temp.dir, 'injected.json');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'one'), { repositories: { [lab]: ['w'] }, gitDir: path.join(temp.dir, 'git'), injected });
		const other = fakeWorld(path.join(temp.dir, 'two'), { repositories: { [lab]: ['w'] }, gitDir: path.join(temp.dir, 'git'), injected });
		try {
			const w = worktreeFolder(lab, 'w');
			await world.startUp(PERSON, { name: 'here', cli: 'told', model: 'deep', effort: 'high', task: 'Here.', folder: w });
			await other.startUp(PERSON, { name: 'there', cli: 'told', model: 'deep', effort: 'high', task: 'There.', folder: w });
			const refused = await outcomeOf(world.facade.stopAgent(PERSON, '#a1', { deleteWorktree: true }));
			const whileRefused = agents(world);
			exits('there', 1, other);
			const deleted = await world.facade.stopAgent(PERSON, '#a1', { deleteWorktree: true });

			assert.deepStrictEqual({ refused, whileRefused, deleted: deleted.worktree }, {
				refused: `REFUSED: ${w} has an agent of another window working in it - #a1 of its list - which this call does not stop. Nothing was stopped. Stop it in that window first.`,
				whileRefused: ['#a1 @here by @human running'],
				deleted: { folder: w, deleted: true }
			});
		} finally {
			other.dispose();
		}
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
			told: [`warning: ${mcp} was gone when its agents ended: what it held before Facade's part went in is kept at ${kept[0]}.`]
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

	test('the core stops past a subscription that throws as it is let go: it throws nothing, and its log says so (C4: deactivation)', () => {
		world.terminals.disposeThrows = true;
		world.facade.dispose();

		assert.deepStrictEqual(world.logs.filter(line => line.startsWith('Stopping Facade agents')), ['Stopping Facade agents: the window is gone']);
	});

	test('a worktree git finished making as the window closed is recorded, for the next window to know of, and so is its run, recorded as its start was accepted; nothing is started in it, and the call cannot say whether its child came up', async () => {
		await world.startUp(PERSON, { name: 'main', cli: 'arg', task: 'Lead.', folder: lab });
		const lead = callerOf(world.agent(1));
		const made = new DeferredPromise<void>();
		world.git.making = made.p;
		const starting = world.facade.startAgent(lead, { name: 'clamp', cli: 'arg', task: 'Clamp.', newWorktree: true });
		await until(() => world.git.steps.length === 1);
		world.facade.dispose();
		made.complete();
		const clamp = worktreeFolder(lab, 'clamp');

		assert.deepStrictEqual({ answer: await outcomeOf(starting), recorded: world.table.madeWorktree(clamp)?.name, launched: world.terminals.launched.length, agents: agents(world) }, {
			answer: 'UNAVAILABLE: The window closed meanwhile: whether the agent came up is not known. list_agents says, once the window is back.',
			recorded: 'clamp',
			launched: 1,
			agents: ['#a1 @main by @human running', '#a2 @clamp by #a1 starting']
		});
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

	test('the person\'s start from the agent menu answers once its terminal runs; should its CLI not connect in time, it stays starting and the person is warned once, with a way to its terminal - its later connection needs no word', async () => {
		world.timing.startTimeoutMs = 5_000;
		const facts = await world.facade.startForPerson('arg', lab);
		await sleep(5_000);
		const told = [...world.person.told];
		const meanwhile = agents(world);
		world.hello(1);
		await sleep(1_000);

		assert.deepStrictEqual({ state: facts.state, told, meanwhile, after: agents(world), toldAfter: world.person.told }, {
			state: 'starting',
			told: ['warning: @arg #a1 is open, but has not connected to Facade: it has no Facade tools yet. It may be slow, or waiting for an answer on its screen. (#a1\'s terminal)'],
			meanwhile: ['#a1 @arg by @human starting'],
			after: ['#a1 @arg by @human running'],
			toldAfter: told
		});
	});

	test('the person\'s start whose CLI ends before it connects - an option it does not know, a login run out - failed, and the person is told, as of a failure (N-73), with a way to its terminal: nobody waits for that start\'s answer once its terminal runs', async () => {
		const facts = await world.facade.startForPerson('arg', lab);
		world.terminals.end('@arg #a1', { exitCode: 1, byThePerson: false });

		assert.deepStrictEqual({ state: facts.state, agents: agents(world), told: world.person.told }, {
			state: 'starting',
			agents: ['#a1 @arg by @human failed: its CLI ended with exit code 1'],
			told: ['error: @arg #a1 did not start: its CLI ended with exit code 1. (#a1\'s terminal)']
		});
	});

	test('a script acting as the person that names no folder starts its agent in the folder on screen, and the branch it names is one checked out in that folder\'s repository', async () => {
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: ['docs'] }, activeFolder: lab });
		const here = await world.startUp(PERSON, { name: 'here', cli: 'arg' });
		const byBranch = await world.startUp(PERSON, { name: 'docs', cli: 'arg', folder: 'docs' });

		assert.deepStrictEqual([here.folder, byBranch.folder], [lab, worktreeFolder(lab, 'docs')]);
	});

	test('a task refused says why: the person\'s launch without the group a task needs, or the agent framework off - not the one for the other (X-55)', async () => {
		world.settings.arg = { launch: { arguments: { task: null } } };
		const withoutGroup = await outcomeOf(world.facade.startAgent(PERSON, { name: 'one', cli: 'arg', task: 'Go.', folder: lab }));
		world.settings.arg = {};
		world.switches.framework = false;
		const frameworkOff = await outcomeOf(world.facade.startAgent(PERSON, { name: 'two', cli: 'arg', task: 'Go.', folder: lab }));

		assert.deepStrictEqual({ withoutGroup, frameworkOff }, {
			withoutGroup: 'REFUSED: Arg Code cannot be given a task: its launch in facade.agents.arg.launch has no task group. Start it without a task, or ask the person to fill that in.',
			frameworkOff: 'REFUSED: Arg Code cannot be given a task while the agent framework is off.'
		});
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
		world.git.changes.set(clamp, { files: ['src/clamp.ts', 'notes.md'], unsaved: ['src/width.ts'], submodules: [] });
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
			steps: [`make clamp from aaaaaaa in ${lab}`, `set up ${clamp}`, `delete ${clamp}`],
			exists: false,
			made: undefined,
			told: ['information: @helper #a3 was stopped by @lead #a1. (#a3\'s terminal)']
		});
	});

	test('an agent\'s delete_worktree of one of the window\'s folders is refused, nothing stopped: deleting it would change the person\'s window; the person\'s own deletes it', async () => {
		const folders: string[] = [];
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, folders });
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		const clamp = worktreeFolder(lab, 'clamp');
		folders.push(clamp);
		const refused = await outcomeOf(world.facade.stopAgent(lead, '#a2', { deleteWorktree: true }));
		const before = agents(world);
		const deleted = await world.facade.stopAgent(PERSON, '#a2', { deleteWorktree: true });

		assert.deepStrictEqual({ refused, before, worktree: deleted.worktree, exists: fs.existsSync(clamp) }, {
			refused: `REFUSED: ${clamp} is one of this window's folders, so an agent does not delete it: that would change the person's window. Nothing was stopped. Stop the agents without delete_worktree, or ask the person to remove the folder from the window first.`,
			before: ['#a1 @lead by @human running', '#a2 @clamp by #a1 running'],
			worktree: { folder: clamp, deleted: true },
			exists: false
		});
	});

	test('work that comes while the agents in a worktree stop - an edit a CLI finished as it ended, a build\'s output - keeps the worktree: the agents are stopped, and the call is refused, as an error, saying what deleting it would lose and whom it stopped (X-23)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		const clamp = worktreeFolder(lab, 'clamp');
		const late = world.terminals.onDidEnd(() => world.git.changes.set(clamp, { files: ['build/out.js'], unsaved: [], submodules: [] }));
		let refused: unknown;
		try {
			await world.facade.stopAgent(lead, '#a2', { deleteWorktree: true });
		} catch (err) {
			refused = { code: (err as FacadeError).code, message: (err as FacadeError).message, outcome: (err as FacadeError).outcome };
		}
		late.dispose();

		assert.deepStrictEqual({ refused, agents: agents(world), steps: world.git.steps, exists: fs.existsSync(clamp) }, {
			refused: {
				code: 'REFUSED',
				message: `${clamp} was not deleted: work came into it as its agents stopped, which deleting it would lose: 1 uncommitted or untracked file (build/out.js). Stopped meanwhile: @clamp #a2. Commit what should stay, or call again with discard_changes: true to lose it.`,
				outcome: { agent: 2, worktree: clamp, stopped: [2] }
			},
			agents: ['#a1 @lead by @human running', '#a2 @clamp by #a1 stopped by #a1: with stop_agent, its worktree being deleted'],
			steps: [`make clamp from aaaaaaa in ${lab}`, `set up ${clamp}`],
			exists: true
		});
	});

	test('a stop whose process outlives its time answers that it is still stopping, and goes on: termination, then a kill it cannot ignore; its end recorded as the stop\'s (X-22)', async () => {
		world.timing.startTimeoutMs = 5_000;
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', folder: lab });
		world.terminals.stubborn = true;
		const stopping = outcomeOf(world.facade.stopAgent(lead, '#a2'));
		await sleep(6_000);
		const answer = await stopping;
		await sleep(100);

		assert.deepStrictEqual({ answer, escalated: world.terminals.signals.filter(signal => !signal.endsWith('SIGHUP')), agents: agents(world) }, {
			answer: 'UNAVAILABLE: @clamp #a2 is still stopping: its process has not ended within 5 seconds. Facade goes on stopping it; list_agents shows when it has ended.',
			escalated: ['#a2 SIGTERM', '#a2 SIGKILL'],
			agents: ['#a1 @lead by @human running', '#a2 @clamp by #a1 stopped by #a1: with stop_agent']
		});
	});

	test('a deletion git got as far as forgetting, its folder left - a file it could not delete - is finished by a retry against the ended agent: what is left holding only what its branch has, it goes; holding more, it is refused, named, unless discarded (AGENT-ORCHESTRATION.md, O5; SP-14)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		const clamp = worktreeFolder(lab, 'clamp');
		world.git.failDelete = `EPERM: operation not permitted, unlink '${clamp}/index.js'`;
		world.git.failAfterForgetting = true;
		const failed = await world.facade.stopAgent(lead, '#a2', { deleteWorktree: true });
		world.git.failDelete = undefined;
		world.git.leftoverWork.set(clamp, ['notes.md']);
		const holdingMore = await outcomeOf(world.facade.stopAgent(lead, '#a2', { deleteWorktree: true }));
		world.git.leftoverWork.delete(clamp);
		const finished = await world.facade.stopAgent(lead, '#a2', { deleteWorktree: true });

		assert.deepStrictEqual({ failed: failed.worktree, holdingMore, finished: finished.worktree, gone: fs.existsSync(clamp), recorded: world.table.madeWorktree(clamp), told: world.git.deletions.get(clamp)?.leftover }, {
			failed: { folder: clamp, deleted: false, why: `EPERM: operation not permitted, unlink '${clamp}/index.js'` },
			holdingMore: `REFUSED: ${clamp} has work that deleting it would lose: what a deletion left of it holds 1 file its branch clamp does not hold as it is (notes.md). Nothing was stopped. Commit what should stay, or call again with discard_changes: true to lose it.`,
			finished: { folder: clamp, deleted: true },
			gone: false,
			recorded: undefined,
			told: true
		});
	});

	test('an agent whose CLI exits as it is stopped is recorded stopped, with its code - the stop\'s own answer, or its CLI exiting by itself while the stop waits (B8; N-19)', async () => {
		world.timing.startTimeoutMs = 5_000;
		await world.startUp(PERSON, { cli: 'arg', task: 'One.', name: 'one', folder: lab });
		await world.startUp(PERSON, { cli: 'arg', task: 'Two.', name: 'two', folder: lab });
		world.terminals.exitCodes.set(1, 3);
		await world.facade.stopAgent(PERSON, '#a1');
		world.terminals.stubborn = true;
		const stopping = outcomeOf(world.facade.stopAgent(PERSON, '#a2'));
		await sleep(1_000);
		world.terminals.end('@two #a2', { byThePerson: false, exitCode: 0 });
		await sleep(1_000);
		await stopping;

		assert.deepStrictEqual([1, 2].map(id => world.table.get(id)?.end && { kind: world.table.get(id)!.end!.kind, exitCode: world.table.get(id)!.end!.exitCode }), [
			{ kind: 'stopped', exitCode: 3 },
			{ kind: 'stopped', exitCode: 0 }
		]);
	});

	test('a stop the window says is done - it has no terminal for the agent - while the agent\'s own process runs on is not recorded as done: it answers still stopping, and goes on by the process itself, its end recorded once it is gone (N-24)', async () => {
		world.timing.startTimeoutMs = 5_000;
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const pid = world.terminals.processes.get(1)!;
		world.processStarts.set(pid, world.table.get(1)!.launchTime!);
		world.terminals.lose('@lead #a1');
		const stopping = outcomeOf(world.facade.stopAgent(PERSON, '#a1'));
		await sleep(6_000);
		const answer = await stopping;
		await until(() => world.table.get(1)?.state === 'ended');

		assert.deepStrictEqual({ answer, killed: world.killed, agents: agents(world) }, {
			answer: 'UNAVAILABLE: @lead #a1 is still stopping: its process has not ended within 5 seconds. Facade goes on stopping it; list_agents shows when it has ended.',
			killed: [`${pid} SIGTERM`],
			agents: ['#a1 @lead by @human stopped by @human: with stop_agent']
		});
	});

	test('the person closing an agent\'s tab while its CLI runs on - it ignores the hang-up - is a stop that finishes once the process has ended: terminated, then killed, and only then recorded stopped by them (N-24; LC-close-stopping)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const pid = world.terminals.processes.get(1)!;
		world.processStarts.set(pid, world.table.get(1)!.launchTime!);
		world.ignoringTermination.add(pid);
		world.terminals.end('@lead #a1', { byThePerson: true }, true);
		const meanwhile = world.table.get(1)?.state;
		await sleep(6_000);
		await until(() => world.table.get(1)?.state === 'ended');

		assert.deepStrictEqual({ meanwhile, killed: world.killed, agents: agents(world) }, {
			meanwhile: 'running',
			killed: [`${pid} SIGTERM`, `${pid} SIGKILL`],
			agents: ['#a1 @lead by @human stopped by @human: its tab was closed']
		});
	});

	test('a process that got an agent\'s id after its own ended is not the agent\'s: the window\'s word stands, and nothing is sent it (N-24)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const pid = world.terminals.processes.get(1)!;
		// Started a minute after the agent was launched: another program's
		world.processStarts.set(pid, world.table.get(1)!.launchTime! + 60_000);
		world.terminals.lose('@lead #a1');
		const stopped = await world.facade.stopAgent(PERSON, '#a1');

		assert.deepStrictEqual({ state: stopped.agent.state, killed: world.killed }, { state: 'ended', killed: [] });
	});

	test('an agent whose worktree the person deleted is recorded as stopped by them because its worktree was deleted - not as if they closed its tab (N-04)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		world.terminals.end('@clamp #a2', { byThePerson: true, reason: 'worktreeDeleted' });

		assert.deepStrictEqual(agents(world), ['#a1 @lead by @human running', '#a2 @clamp by #a1 stopped by @human: its worktree was deleted']);
	});

	test('two deletions of a worktree at once are one: the second joins the first and answers as it does, and no start goes into the worktree meanwhile (X-10)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		const clamp = worktreeFolder(lab, 'clamp');
		const first = world.facade.stopAgent(lead, '#a2', { deleteWorktree: true });
		const second = world.facade.stopAgent(PERSON, '#a2', { deleteWorktree: true });
		const meanwhile = await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', name: 'late', folder: clamp }));
		const [one, two] = await Promise.all([first, second]);

		assert.deepStrictEqual({ one: one.worktree, two: two.worktree, meanwhile, deletions: world.git.steps.filter(step => step.startsWith('delete')) }, {
			one: { folder: clamp, deleted: true },
			two: { folder: clamp, deleted: true },
			meanwhile: `REFUSED: ${clamp} is being deleted: no agent starts there.`,
			deletions: [`delete ${clamp}`]
		});
	});

	test('a stop that comes while a start opens its terminal ends the start: the terminal is closed once it is open, never left running, and the start says why; a second stop of an agent stopping joins the first, which says who stopped it and why', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		let open = () => { };
		world.terminals.hold = new Promise<void>(resolve => open = resolve);
		const start = outcomeOf(world.facade.startAgent(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', folder: lab }));
		await sleep(0);
		const stop = world.facade.stopAgent(lead, '#a2');
		const joined = world.facade.stopAgent(PERSON, '#a2');
		await sleep(0);
		open();
		world.terminals.hold = undefined;
		const [stopped] = await Promise.all([stop, joined]);

		assert.deepStrictEqual({ start: await start, stopped: stopped.agent.end?.reason, running: [...world.terminals.running], agents: agents(world) }, {
			start: 'FAILED: Arg Code did not start as @clamp #a2: it was stopped with stop_agent',
			stopped: 'with stop_agent',
			running: ['@lead #a1'],
			agents: ['#a1 @lead by @human running', '#a2 @clamp by #a1 stopped by #a1: with stop_agent']
		});
	});

	test('a stop\'s time counts from its acceptance: a launch it waits for to open its terminal is within it, and past it the stop answers that it is still stopping - the terminal closed once it opens, the end recorded as the stop\'s (X-15)', async () => {
		world.timing.startTimeoutMs = 5_000;
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		let open = () => { };
		world.terminals.hold = new Promise<void>(resolve => open = resolve);
		const start = outcomeOf(world.facade.startAgent(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', folder: lab }));
		await sleep(0);
		const stop = outcomeOf(world.facade.stopAgent(lead, '#a2'));
		await sleep(6_000);
		const answered = await Promise.race([stop, sleep(0).then(() => 'no answer yet')]);
		open();
		world.terminals.hold = undefined;
		await sleep(100);

		assert.deepStrictEqual({ answered, start: await start, running: [...world.terminals.running], agents: agents(world) }, {
			answered: 'UNAVAILABLE: @clamp #a2 is still stopping: its process has not ended within 5 seconds. Facade goes on stopping it; list_agents shows when it has ended.',
			start: 'FAILED: Arg Code did not start as @clamp #a2: it was stopped with stop_agent',
			running: ['@lead #a1'],
			agents: ['#a1 @lead by @human running', '#a2 @clamp by #a1 stopped by #a1: with stop_agent']
		});
	});

	test('an agent of another window working in a worktree - seen by the window, with nothing of Facade\'s put there for it - refuses an agent\'s deletion of it, named, before anyone is stopped; once it has gone, it is deleted (N-53, SP-18)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		await world.startUp(callerOf(world.agent(1)), { cli: 'arg', task: 'W.', name: 'w', newWorktree: true });
		const w = worktreeFolder(lab, 'w');
		world.terminals.working.set(w, { elsewhere: ['@sp18o #a270'] });
		const refused = await outcomeOf(world.facade.stopAgent(callerOf(world.agent(1)), '#a2', { deleteWorktree: true }));
		const whileRefused = agents(world);
		world.terminals.working.delete(w);
		const deleted = await world.facade.stopAgent(callerOf(world.agent(1)), '#a2', { deleteWorktree: true });

		assert.deepStrictEqual({ refused, whileRefused, deleted: deleted.worktree }, {
			refused: `REFUSED: ${w} has an agent of another window working in it - @sp18o #a270 - which this call does not stop. Nothing was stopped. Stop it in that window first.`,
			whileRefused: ['#a1 @lead by @human running', '#a2 @w by #a1 running'],
			deleted: { folder: w, deleted: true }
		});
	});

	test('an agent working in a worktree it was not started in - its CLI, or a shell it runs, cd\'d there, as its processes say - is one of its agents: out of a YOLO-off caller\'s reach it refuses the deletion, named, nobody stopped; a YOLO-on caller stops it too and names it; one of another record the window sees there refuses it (X-74)', async () => {
		world.switches.yolo = false;
		await world.startUp(PERSON, { cli: 'arg', task: 'B.', name: 'b', folder: lab });
		const b = callerOf(world.agent(1));
		await world.startUp(b, { cli: 'arg', task: 'B1.', name: 'b1', newWorktree: true });
		await world.startUp(b, { cli: 'arg', task: 'B2.', name: 'b2', folder: lab });
		const w = worktreeFolder(lab, 'b1');
		world.switches.yolo = true;
		await world.startUp(PERSON, { cli: 'arg', task: 'X.', name: 'x', folder: lab });
		// x's CLI ran a shell that cd'd into w: its terminal still says where it started, its processes say where it is
		world.processFolders.set(world.terminals.processes.get(4)!, [lab, path.join(w, 'src')]);
		// y's terminal, a shell's, is seen in w by the window
		await world.startUp(PERSON, { cli: 'arg', task: 'Y.', name: 'y', folder: lab });
		world.terminals.working.set(w, { agents: [5], others: 0 });
		const b2 = callerOf(world.agent(3));
		const refused = await outcomeOf(world.facade.stopAgent(b2, '#a2', { deleteWorktree: true }));
		const whileRefused = agents(world);
		world.terminals.working.set(w, { agents: [5], others: 1 });
		const foreign = await outcomeOf(world.facade.stopAgent(PERSON, '#a2', { deleteWorktree: true }));
		world.terminals.working.set(w, { agents: [5], others: 0 });
		const deleted = await world.facade.stopAgent(PERSON, '#a2', { deleteWorktree: true });

		assert.deepStrictEqual({ refused, whileRefused, foreign, stopped: deleted.stopped.map(each => each.id), worktree: deleted.worktree, told: world.git.deletions.get(w)?.agents, agents: agents(world) }, {
			refused: `REFUSED: ${w} has @x #a4 (started in ${lab}), @y #a5 (started in ${lab}) working in it, outside your tree: your YOLO is off, and you reach only your own tree. Nothing was stopped.`,
			whileRefused: ['#a1 @b by @human running', '#a2 @b1 by #a1 running', '#a3 @b2 by #a1 running', '#a4 @x by @human running', '#a5 @y by @human running'],
			foreign: `REFUSED: ${w} has an agent working in it that is not of this window's list, which deleting it would end unasked. Nothing was stopped. Stop it first.`,
			stopped: [2, 4, 5],
			worktree: { folder: w, deleted: true },
			told: [2, 4, 5],
			agents: [
				'#a1 @b by @human running',
				'#a2 @b1 by #a1 stopped by @human: with stop_agent, its worktree being deleted',
				'#a3 @b2 by #a1 running',
				'#a4 @x by @human stopped by @human: with stop_agent, its worktree being deleted',
				'#a5 @y by @human stopped by @human: with stop_agent, its worktree being deleted'
			]
		});
	});

	test('a worktree with submodules is refused unless the call says to discard, naming them, nobody stopped - their commits not pushed would go with it; the deletion is told the main checkout, for a window whose bar knows no repository (X-14, X-41)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		const clamp = worktreeFolder(lab, 'clamp');
		world.git.changes.set(clamp, { files: [], unsaved: [], submodules: ['vendor/lib'] });
		const refused = await outcomeOf(world.facade.stopAgent(lead, '#a2', { deleteWorktree: true }));
		const whileRefused = agents(world);
		const deleted = await world.facade.stopAgent(lead, '#a2', { deleteWorktree: true, discardChanges: true });

		assert.deepStrictEqual({ refused, whileRefused, worktree: deleted.worktree, main: world.git.deletions.get(clamp)?.main }, {
			refused: `REFUSED: ${clamp} has work that deleting it would lose: 1 submodule (vendor/lib), with any of its commits not pushed. Nothing was stopped. Commit what should stay, or call again with discard_changes: true to lose it.`,
			whileRefused: ['#a1 @lead by @human running', '#a2 @clamp by #a1 running'],
			worktree: { folder: clamp, deleted: true },
			main: lab
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
			outOfTree: `REFUSED: ${clamp} has @other #a3 working in it, outside your tree: your YOLO is off, and you reach only your own tree. Nothing was stopped.`,
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

	test('a custom agent whose settings are wrong - no program, a name a built-in has, a part a launch does not have - is listed for the person, and refused to every start, naming each; chosen from the agent menu, one named as a built-in is never starts the built-in in its place', async () => {
		world.custom.arg = { path: '/opt/arg-dev/bin/arg' };
		world.custom.broken = { launch: { arguments: { tsak: ['--x'] } } };
		const outcomes = [
			await outcomeOf(world.facade.startAgent(PERSON, { name: 'one', cli: 'broken', folder: lab })),
			await outcomeOf(world.facade.startForPerson('arg', lab, true)),
			await outcomeOf(world.facade.startForPerson('arg', lab))
		];

		assert.deepStrictEqual({ outcomes, startable: world.facade.startable().map(each => each.id), launched: world.terminals.launched.map(each => [each.name, each.executable]) }, {
			outcomes: [
				'UNAVAILABLE: Facade cannot start broken until the person puts its settings right: facade.agents.custom.broken.path is not set: a custom agent needs the program to start; facade.agents.custom.broken.launch.arguments has tsak, which is no group of broken\'s arguments: it has warmUp, connect, quiet, questions, messages, yoloOn, yoloOff, model, effort, extra, task. Show Agent Launch shows them.',
				'UNAVAILABLE: Facade cannot start arg until the person puts its settings right: facade.agents.custom.arg: arg is a built-in\'s id, by which agents start it: give the custom agent another name. Show Agent Launch shows them.',
				'fulfilled'
			],
			startable: ['arg', 'told'],
			launched: [['@arg #a1', world.terminals.launched[0]?.executable]]
		});
	});

	test('a custom agent named as no agent can be - a reserved name, or not a name - is refused in one sentence: each reason a clause in the list of what is wrong (N-56)', async () => {
		world.custom.human = { path: '/bin/human' };
		world.custom['a b'] = { path: '/bin/ab' };
		const outcomes = [
			await outcomeOf(world.facade.startForPerson('human', lab)),
			await outcomeOf(world.facade.startForPerson('a b', lab))
		];

		assert.deepStrictEqual(outcomes, [
			'UNAVAILABLE: Facade cannot start human until the person puts its settings right: facade.agents.custom.human: "human" is reserved: choose another name. Show Agent Launch shows them.',
			'UNAVAILABLE: Facade cannot start a b until the person puts its settings right: facade.agents.custom.a b: "a b" is not a name: use up to 40 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit. Show Agent Launch shows them.'
		]);
	});

	test('what list_agents offers an agent is what it can start: a built-in whose settings are wrong is left out, as a custom agent\'s are, and so is a custom agent whose program a terminal does not find, once Facade has looked; one it finds is listed (C-LAUNCH-16; X-39)', async () => {
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, locate: cli => cli === 'gone' ? undefined : `/bin/${cli}` });
		world.settings.arg = { launch: { arguments: { modle: ['-m'] } } };
		world.custom.found = { path: 'found' };
		world.custom.gone = { path: 'gone' };
		const before = world.facade.startable().map(each => each.id);
		await world.facade.refreshClis();

		assert.deepStrictEqual({ before, after: world.facade.startable().map(each => each.id) }, { before: ['told', 'found', 'gone'], after: ['told', 'found'] });
	});
});

suite('Core: a start in a new worktree, phase by phase (AGENT-ORCHESTRATION.md, O4 and O9)', () => {

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

	/** A lead in A, and a child of it starting in a new worktree `clamp`, its call under way. */
	async function leadStarting(): Promise<{ lead: Caller; starting: Promise<string>; clamp: string }> {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const starting = outcomeOf(world.facade.startAgent(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true }));
		return { lead, starting, clamp: worktreeFolder(lab, 'clamp') };
	}

	test('a folder named that the window does not have: one that is there, or a file, is refused - it exists, out of reach - and one that is not there is not found (O2)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const outside = path.join(temp.dir, 'outside');
		fs.mkdirSync(outside);
		const file = path.join(lab, 'notes.md');
		fs.writeFileSync(file, 'notes\n');
		const codes = await Promise.all([outside, file, path.join(temp.dir, 'nowhere')].map(async folder => (await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', name: 'x', folder }))).split(':')[0]));

		assert.deepStrictEqual({ codes, agents: agents(world) }, { codes: ['REFUSED', 'REFUSED', 'NOT_FOUND'], agents: ['#a1 @lead by @human running'] });
	});

	test('a folder of the window gone from the disk keeps no start elsewhere from working, and one named there is not found, by name - not git\'s words; a worktree deleted by hand, its agent ended, is said to be gone (X-37)', async () => {
		const gone = path.join(temp.dir, 'notes');
		fs.mkdirSync(gone);
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, folders: [gone] });
		fs.rmSync(gone, { recursive: true });
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const there = await world.startUp(lead, { cli: 'arg', task: 'Go.', name: 'here', newWorktree: true });
		const named = await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', name: 'gone', folder: gone }));
		await world.facade.stopAgent(lead, '#a2');
		fs.rmSync(there.folder, { recursive: true });
		const deleted = await world.facade.stopAgent(lead, '#a2', { deleteWorktree: true });

		assert.deepStrictEqual({ there: there.status, named, worktree: deleted.worktree, made: world.table.madeWorktree(there.folder) }, {
			there: 'started',
			named: `NOT_FOUND: ${gone} is a folder of this window that is not on the disk any more: no agent starts there. Its folders: ${lab}, ${there.folder}.`,
			worktree: { folder: there.folder, deleted: false, why: 'its folder is gone already: there is nothing left to delete' },
			made: undefined
		});
	});

	test('an agent whose MCP server ended - it said which process it is - is listed running and not connected; its server saying hello again, it is connected (O6)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const connected = () => world.facade.listAgents(PERSON, true).agents.map(agent => `${agent.state} ${agent.connected}`);
		const server = startFakeProcess();
		world.facade.connected(lead, server);
		const whileItRuns = connected();
		endFakeProcess(server);
		const once = connected();
		world.facade.connected(lead, startFakeProcess());

		assert.deepStrictEqual({ whileItRuns, once, again: connected() }, {
			whileItRuns: ['running true'],
			once: ['running false'],
			again: ['running true']
		});
	});

	test('a model or an effort no CLI can be given as it is - one a CLI would read as an option of its own, a NUL, half of a character - is refused before anything is made; one joined to its option, as --model=-x, goes as it is (L10; X-08, N-10)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const refused = [
			await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', name: 'dash', model: '-x' })),
			await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', name: 'flag', effort: '--disable-sandbox' })),
			await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', name: 'nul', model: 'a\0b' })),
			await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', name: 'half', effort: 'x\uD800' }))
		];
		const allocated = [...world.table.state.agents.keys()];
		world.settings.arg = { launch: { arguments: { model: ['--model=${model}'] } } };
		const joined = await world.startUp(lead, { cli: 'arg', name: 'joined', model: '-x' });

		assert.deepStrictEqual({ refused, allocated, joined: joined.status, args: world.terminals.launched.at(-1)?.args.filter(arg => arg.startsWith('--model')) }, {
			refused: [
				'INVALID: The model -x starts with a dash: Arg Code would read it as an option of its own, not as the model. Give it without the leading dash.',
				'INVALID: The effort --disable-sandbox starts with a dash: Arg Code would read it as an option of its own, not as the effort. Give it without the leading dash.',
				'INVALID: The model has a character no CLI can be given as it is - a NUL, or half of one written as two: give it as plain text.',
				'INVALID: The effort has a character no CLI can be given as it is - a NUL, or half of one written as two: give it as plain text.'
			],
			allocated: [1],
			joined: 'started',
			args: ['--model=-x']
		});
	});

	test('a new worktree whose folder is taken on disk is made beside it, with -1, on the branch named as asked - and the start says where, and why (WT-2.3; O3; AS-11)', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const lead = callerOf(world.agent(1));
		const taken = worktreeFolder(lab, 'clamp');
		fs.mkdirSync(taken, { recursive: true });
		const started = await world.startUp(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });

		assert.deepStrictEqual({ folder: started.folder, worktree: started.worktree, notes: started.notes }, {
			folder: `${taken}-1`,
			worktree: 'clamp',
			notes: [`Its worktree is at ${taken}-1: ${taken} was taken.`]
		});
	});

	test('two starts on one new branch at once: the first is accepted, the second refused at once - before a number is allocated for it, nothing half-made - though git has not made the branch yet; once the worktree is made, the branch exists and says so (AS-21)', async () => {
		let turn = () => { };
		world.git.queued = new Promise<void>(resolve => turn = resolve);
		const { lead, starting, clamp } = await leadStarting();
		await until(() => world.table.get(2) !== undefined);
		const second = await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true }));
		const allocated = [...world.table.state.agents.keys()];
		turn();
		world.git.queued = undefined;
		await until(() => world.table.madeWorktree(clamp) !== undefined);
		const after = await outcomeOf(world.facade.startAgent(lead, { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true }));
		world.hello(2);
		await starting;

		assert.deepStrictEqual({ second, allocated, after }, {
			second: `REFUSED: lab has a branch called clamp being made already, for another start: give the child another name.`,
			allocated: [1, 2],
			after: `REFUSED: lab has a branch called clamp already, and a new worktree is on a new branch, named after the child: give the child another name, or start it in the worktree of clamp by its folder.`
		});
	});

	test('it is recorded as it is accepted: listed starting while its worktree is made, phase creating_worktree, at the folder planned for it; stopped then, it ends stopped by its caller, the worktree git finishes making stays, its setup is stopped, and no CLI is ever launched', async () => {
		let made = () => { };
		world.git.making = new Promise<void>(resolve => made = resolve);
		const { lead, starting, clamp } = await leadStarting();
		await until(() => world.table.get(2) !== undefined);
		const listed = world.facade.listAgents(lead).agents.find(agent => agent.id === 2);
		const stopped = await world.facade.stopAgent(lead, '#a2');
		made();
		const answer = await starting;
		// The worktree git finishes making is recorded as it is made, after the answer
		await until(() => world.git.steps.length === 2);

		assert.deepStrictEqual({ listed: listed && { state: listed.state, phase: listed.phase, folder: listed.folder }, stopped: stopped.agent.state, answer, agents: agents(world), launched: world.terminals.launched.length, made: world.table.madeWorktree(clamp)?.name, steps: world.git.steps }, {
			listed: { state: 'starting', phase: 'creating_worktree', folder: clamp },
			stopped: 'ended',
			answer: 'FAILED: Arg Code did not start as @clamp #a2: it was stopped with stop_agent',
			agents: ['#a1 @lead by @human running', '#a2 @clamp by #a1 stopped by #a1: with stop_agent'],
			launched: 1,
			made: 'clamp',
			steps: [`make clamp from aaaaaaa in ${lab}`, `stop setup ${clamp}`]
		});
	});

	test('stopped while its worktree\'s setup runs, it ends stopped by its caller, its setup terminal closed with it, the worktree staying, no CLI ever launched (O4)', async () => {
		world.git.setup = new Promise<SetupOutcome>(() => { });
		const { lead, starting, clamp } = await leadStarting();
		await until(() => world.table.get(2)?.phase === 'running_setup');
		const stopped = await world.facade.stopAgent(lead, '#a2');

		assert.deepStrictEqual({ stopped: stopped.agent.state, answer: await starting, launched: world.terminals.launched.length, steps: world.git.steps, made: world.table.madeWorktree(clamp)?.name }, {
			stopped: 'ended',
			answer: `FAILED: Arg Code did not start as @clamp #a2: it was stopped with stop_agent. The worktree clamp was made for it, at ${clamp}, and stays, with its branch: start an agent there by its folder, or delete it.`,
			launched: 1,
			steps: [`make clamp from aaaaaaa in ${lab}`, `set up ${clamp}`, `stop setup ${clamp}`],
			made: 'clamp'
		});
	});

	test('the person deleting its worktree while its setup runs stops it first, by the person: its setup stopped, no CLI ever launched in the folder going; an agent elsewhere goes on (N-34)', async () => {
		world.git.setup = new Promise<SetupOutcome>(() => { });
		const { starting, clamp } = await leadStarting();
		await until(() => world.table.get(2)?.phase === 'running_setup');
		await world.facade.worktreeDeleting(clamp);

		assert.deepStrictEqual({ answer: await starting, agents: agents(world), launched: world.terminals.launched.length, steps: world.git.steps }, {
			answer: `FAILED: Arg Code did not start as @clamp #a2: it was stopped as its worktree was deleted. The worktree clamp was made for it, at ${clamp}, and stays, with its branch: start an agent there by its folder, or delete it.`,
			agents: ['#a1 @lead by @human running', '#a2 @clamp by #a1 stopped by @human: as its worktree was deleted'],
			launched: 1,
			steps: [`make clamp from aaaaaaa in ${lab}`, `set up ${clamp}`, `stop setup ${clamp}`]
		});
	});

	test('its time counts from its acceptance: a setup still running when it is over answers unconfirmed, phase running_setup, and the person is not told; the setup done, its CLI starts - the same run - and it comes up', async () => {
		world.timing.startTimeoutMs = 5_000;
		let setUp = (_outcome: SetupOutcome) => { };
		world.git.setup = new Promise<SetupOutcome>(resolve => setUp = resolve);
		const { starting } = await leadStarting();
		await sleep(6_000);
		const answer = await starting;
		const meanwhile = { phase: world.table.get(2)?.phase, launched: world.terminals.launched.length };
		setUp({ kind: 'succeeded' });
		await until(() => world.terminals.launched.length === 2);
		world.hello(2);

		assert.deepStrictEqual({ answer, meanwhile, agents: agents(world), told: world.person.told }, {
			answer: 'fulfilled',
			meanwhile: { phase: 'running_setup', launched: 1 },
			agents: ['#a1 @lead by @human running', '#a2 @clamp by #a1 running'],
			told: []
		});
	});

	test('the answer that its start is not confirmed says the phase it is in', async () => {
		world.timing.startTimeoutMs = 5_000;
		world.git.setup = new Promise<SetupOutcome>(() => { });
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const starting = world.facade.startAgent(callerOf(world.agent(1)), { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true });
		await sleep(6_000);
		const started = await starting;

		assert.deepStrictEqual({ status: started.status, phase: started.phase, why: started.why }, {
			status: 'unconfirmed',
			phase: 'running_setup',
			why: 'it has not started within 5 seconds: its worktree\'s setup is still running'
		});
	});

	test('a setup that fails fails the start before its CLI: the line, its exit code and its output, the worktree kept and named; one sent without shell integration starts it, the answer and the child\'s notice saying its completion is not known; what could not be copied and a failed hook are in the answer', async () => {
		world.git.setup = { kind: 'failed', line: 'npm ci', exitCode: 7, output: 'npm ERR! missing script\n' };
		const { starting, clamp } = await leadStarting();
		const failed = await starting;
		const launchedAfterFailure = world.terminals.launched.length;

		world.git.setup = { kind: 'submitted' };
		world.git.copyFailures = ['x.secret'];
		world.git.hookFailure = 'the hook says no';
		const started = await world.startUp(callerOf(world.agent(1)), { cli: 'arg', task: 'Go.', name: 'typed', newWorktree: true });
		const notice = world.terminals.launched.at(-1)?.args.find(arg => arg.includes('Your task is message')) ?? '';

		assert.deepStrictEqual({ failed, launchedAfterFailure, made: world.table.madeWorktree(clamp)?.name, notes: started.notes, noticeSays: /setup was sent without shell integration: whether it finished is not known/.test(notice) }, {
			failed: `FAILED: Arg Code did not start as @clamp #a2: its worktree's setup failed - \`npm ci\` exited with code 7: npm ERR! missing script. The worktree clamp was made for it, at ${clamp}, and stays, with its branch: start an agent there by its folder, or delete it.`,
			launchedAfterFailure: 1,
			made: 'clamp',
			notes: [
				'What .worktreeinclude names could not all be copied into its worktree: x.secret.',
				'A git hook failed as its worktree was made: the hook says no',
				'Its worktree\'s setup was sent without shell integration: whether it finished, or how, is not known.'
			],
			noticeSays: true
		});
	});

	test('a trust file its CLI\'s trust cannot be merged into refuses a start in a new worktree before the worktree is made', async () => {
		await world.startUp(PERSON, { cli: 'arg', task: 'Lead.', name: 'lead', folder: lab });
		const home = path.join(temp.dir, 'workspace', 'arg-home');
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(path.join(home, 'trust.json'), '{ "trusted": "not a list" }\n');
		const answer = await outcomeOf(world.facade.startAgent(callerOf(world.agent(1)), { cli: 'arg', task: 'Clamp.', name: 'clamp', newWorktree: true }));

		assert.deepStrictEqual({ refused: /^FAILED: .*trust\.json could not be read, or is not as Arg Code writes it/.test(answer), steps: world.git.steps, agents: agents(world) }, {
			refused: true,
			steps: [],
			agents: ['#a1 @lead by @human running']
		});
	});

	test('Facade starting again in this very window - its extension host restarted - finds a start cut before its CLI failed too, saying so; but the window did not go, and its setup terminal is left to run, the person\'s (WIN-03)', async () => {
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, session: 'this-load' });
		world.git.setup = new Promise<SetupOutcome>(() => { });
		const { clamp } = await leadStarting();
		await until(() => world.table.get(2)?.phase === 'running_setup');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, session: 'this-load' });
		world.terminals.running.add('@lead #a1');
		await world.facade.recover(false);

		assert.deepStrictEqual({ agents: agents(world), steps: world.git.steps }, {
			agents: ['#a1 @lead by @human running', `#a2 @clamp by #a1 failed: its start was cut as Facade started again in this window, as its worktree was set up, before its CLI was launched; its worktree stays, at ${clamp}, its setup going on in its terminal`],
			steps: []
		});
	});

	test('Facade starting again in this very window after its extension host was killed - no word of its going in the ledger, the window remembering its record - leaves the setup terminal of a start it cut to run, as after a restart (WIN-18)', async () => {
		world.git.setup = new Promise<SetupOutcome>(() => { });
		const { clamp } = await leadStarting();
		await until(() => world.table.get(2)?.phase === 'running_setup');
		world.dispose();
		// Killed: its lock left behind, its process gone
		fs.writeFileSync(path.join(temp.dir, 'workspace', 'ledger.lock'), '424242 0123456789ab');
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] }, isRunning: pid => pid !== 424242 && isFakeProcessRunning(pid) });
		world.terminals.running.add('@lead #a1');
		await world.facade.recover(true, true);

		assert.deepStrictEqual({ agents: agents(world), steps: world.git.steps }, {
			agents: ['#a1 @lead by @human running', `#a2 @clamp by #a1 failed: its start was cut as Facade started again in this window, as its worktree was set up, before its CLI was launched; its worktree stays, at ${clamp}, its setup going on in its terminal`],
			steps: []
		});
	});

	test('a start cut before its CLI was launched is failed as Facade comes back, though the window cannot tell of any process: it has none to ask after; it stayed starting for good (N-60; WIN-04)', async () => {
		world.git.setup = new Promise<SetupOutcome>(() => { });
		const { clamp } = await leadStarting();
		await until(() => world.table.get(2)?.phase === 'running_setup');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
		world.terminals.running.add('@lead #a1');
		world.terminals.untold.add(1);
		world.terminals.untold.add(2);
		await world.facade.recover(true);

		assert.deepStrictEqual({ agents: agents(world), steps: world.git.steps, launched: world.terminals.launched.length }, {
			agents: ['#a1 @lead by @human running', `#a2 @clamp by #a1 failed: its start was cut as the window went, as its worktree was set up, before its CLI was launched; its worktree stays, at ${clamp}`],
			steps: [`stop setup ${clamp}`],
			launched: 0
		});
	});

	test('the window coming back finds a start cut before its CLI - its worktree made, its setup running - failed, saying so and where its worktree stays, its setup stopped; no CLI is launched', async () => {
		world.git.setup = new Promise<SetupOutcome>(() => { });
		const { clamp } = await leadStarting();
		await until(() => world.table.get(2)?.phase === 'running_setup');
		world.dispose();
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { [lab]: [] } });
		world.terminals.running.add('@lead #a1');
		await world.facade.recover(true);

		assert.deepStrictEqual({ agents: agents(world), steps: world.git.steps, launched: world.terminals.launched.length }, {
			agents: ['#a1 @lead by @human running', `#a2 @clamp by #a1 failed: its start was cut as the window went, as its worktree was set up, before its CLI was launched; its worktree stays, at ${clamp}`],
			steps: [`stop setup ${clamp}`],
			launched: 0
		});
	});
});
