/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Agent, Caller, LedgerEvent } from '../record/events';
import { PERSON } from '../record/registry';
import { fakeWorld, worktreeFolder } from './fakes';
import { outcomeOf, sleep, tempDir } from './util';

const TRUST_SCREEN = ['Do you trust the files in this folder?', '', '❯ 1. No, exit', '  2. Yes, I trust this folder', '', 'Enter to confirm'].join('\n');

/** Waits until `test` holds, for a second at most. */
async function until(test: () => boolean): Promise<void> {
	for (let tries = 0; tries < 100 && !test(); tries++) {
		await sleep(10);
	}
}

function callerOf(agent: Agent): Caller {
	return { name: agent.name, incarnation: agent.incarnation };
}

suite('Core: starting agents, and finding them again after a reload', () => {

	let temp: { dir: string; remove(): void };
	let world: ReturnType<typeof fakeWorld>;

	setup(() => {
		temp = tempDir('facade-core-');
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { '/lab': ['feature/parser'] } });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	test('the person starts an agent: named after its worktree, its CLI in a terminal of that folder, with Facade\'s server, hooks and skill, and its own token', async () => {
		const spawned = await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', prompt: 'Add a parser.', folder: '/lab' });
		const launched = world.terminals.launched[0];
		const option = (name: string) => launched.args[launched.args.indexOf(name) + 1];
		const server = JSON.parse(fs.readFileSync(option('--mcp-config'), 'utf8')).mcpServers.facade;
		const token = fs.readFileSync(server.args[server.args.indexOf('--token-file') + 1], 'utf8');
		const hooks = JSON.parse(fs.readFileSync(option('--settings'), 'utf8')).hooks;
		const agent = world.registry.agent('main')!;

		assert.deepStrictEqual({
			spawned,
			agent: { incarnation: agent.incarnation, parent: agent.parent, state: agent.state },
			terminal: { name: launched.name, executable: launched.executable, cwd: launched.cwd, first: launched.args[0], model: launched.args.slice(-2) },
			stopHook: hooks.Stop[0].hooks[0].command,
			skill: fs.existsSync(path.join(option('--plugin-dir'), 'skills', 'facade', 'SKILL.md')),
			caller: world.registry.authenticate(token)
		}, {
			spawned: { name: 'main', cli: 'claude', cliName: 'Claude Code', model: 'sonnet', worktree: 'main', folder: '/lab', branch: undefined, madeWorktree: false },
			agent: { incarnation: 1, parent: 'you', state: 'starting' },
			terminal: { name: '@main · Claude Code', executable: '/bin/claude', cwd: '/lab', first: 'Add a parser.', model: ['--model', 'sonnet'] },
			stopHook: '/facade/hooks/main-1.cmd event:stop',
			skill: true,
			caller: { name: 'main', incarnation: 1 }
		});
	});

	test('a second agent in a worktree is <worktree>-2; a worktree\'s branch names its agent', async () => {
		const names: string[] = [];
		for (const folder of ['/lab', '/lab', worktreeFolder('/lab', 'feature/parser')]) {
			names.push((await world.facade.spawn(PERSON, { cli: 'claude', model: 'haiku', folder })).name);
		}

		assert.deepStrictEqual({ names, terminals: world.terminals.launched.map(each => each.name) }, {
			names: ['main', 'main-2', 'feature-parser'],
			terminals: ['@main · Claude Code', '@main-2 · Claude Code', '@feature-parser · Claude Code']
		});
	});

	test('a CLI this machine does not have is UNAVAILABLE, naming the ones it has; an empty model is INVALID', async () => {
		const outcomes = [
			await outcomeOf(world.facade.spawn(PERSON, { cli: 'codex', model: 'gpt-5.5', folder: '/lab' })),
			await outcomeOf(world.facade.spawn(PERSON, { cli: 'claude', model: ' ', folder: '/lab' }))
		];

		assert.deepStrictEqual({ outcomes, agents: world.registry.state.agents.size }, {
			outcomes: [
				'UNAVAILABLE: Facade cannot start codex here. It starts: claude.',
				'INVALID: model is required: one of Claude Code\'s models, as sonnet.'
			],
			agents: 0
		});
	});

	test('a launch that fails leaves the agent failed, and says why', async () => {
		world.terminals.failNext = 'claude exited as it started (exit code 1).';

		const failed = await outcomeOf(world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', folder: '/lab' }));
		const agent = world.registry.agent('main');

		assert.deepStrictEqual({ failed, state: agent?.state, detail: agent?.stateDetail }, {
			failed: 'FAILED: claude exited as it started (exit code 1).',
			state: 'failed',
			detail: 'claude exited as it started (exit code 1).'
		});
	});

	test('an agent whose terminal ends is stopped; after a reload, the ones whose terminals are gone are stopped and the others kept', async () => {
		for (const folder of ['/lab', '/lab', worktreeFolder('/lab', 'feature/parser')]) {
			await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', folder });
		}
		world.terminals.end('@main · Claude Code', 0);
		// A reload: the window gives back the terminal of main-2 only.
		world.terminals.running.delete('@feature-parser · Claude Code');
		await world.facade.recover();

		const states = [...world.registry.state.agents.values()].map(agent => `${agent.name}: ${agent.state}${agent.stateDetail ? `, ${agent.stateDetail}` : ''}`);
		assert.deepStrictEqual(states, [
			'main: stopped, its process exited with code 0',
			'main-2: starting',
			'feature-parser: stopped, its terminal is gone'
		]);
	});
});

suite('Core: parents and children', () => {

	let temp: { dir: string; remove(): void };
	let world: ReturnType<typeof fakeWorld>;
	let main: Caller;

	setup(async () => {
		temp = tempDir('facade-family-');
		world = fakeWorld(path.join(temp.dir, 'workspace'), { repositories: { '/lab': [] } });
		main = callerOf(world.registry.agent((await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', prompt: 'Lead.', folder: '/lab' })).name)!);
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	const child = async (parent: Caller, request: { worktree?: string; name?: string }) => {
		const spawned = await world.facade.spawn(parent, { cli: 'claude', model: 'haiku', prompt: 'Work.', ...request });
		return callerOf(world.registry.agent(spawned.name)!);
	};

	test('an agent starts a child beside it, in a new worktree from its HEAD, or in one that exists; each is its child', async () => {
		const beside = await world.facade.spawn(main, { cli: 'claude', model: 'haiku', prompt: 'Review.' });
		const sent = await world.facade.spawn(main, { cli: 'claude', model: 'haiku', prompt: 'Add clamp.', worktree: 'new', name: 'clamp' });
		const joining = await world.facade.spawn(main, { cli: 'claude', model: 'haiku', prompt: 'Test clamp.', worktree: 'clamp', name: 'tests' });

		assert.deepStrictEqual({
			spawned: [beside, sent, joining].map(({ name, worktree, folder, branch, madeWorktree }) => ({ name, worktree, folder, branch, madeWorktree })),
			parents: ['main-2', 'clamp', 'tests'].map(name => world.registry.agent(name)?.parent),
			made: [...world.registry.state.worktrees.values()],
			git: world.git.steps,
			asked: world.person.asked
		}, {
			spawned: [
				{ name: 'main-2', worktree: 'main', folder: '/lab', branch: undefined, madeWorktree: false },
				{ name: 'clamp', worktree: 'clamp', folder: worktreeFolder('/lab', 'clamp'), branch: 'clamp', madeWorktree: true },
				{ name: 'tests', worktree: 'clamp', folder: worktreeFolder('/lab', 'clamp'), branch: undefined, madeWorktree: false }
			],
			parents: ['main', 'main', 'main'],
			made: [{ name: 'clamp', folder: worktreeFolder('/lab', 'clamp'), repository: '/lab', parentWorktree: 'main', madeBy: 'main' }],
			git: ['make clamp from aaaaaaa in /lab'],
			asked: ['claude', 'claude']
		});
	});

	test('a new worktree needs a name; a worktree that is not there, a folder with no repository, and a stranger\'s name are refused', async () => {
		const other = callerOf(world.registry.agent((await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', folder: '/notes' })).name)!);

		const outcomes = [
			await outcomeOf(child(main, { worktree: 'new' })),
			await outcomeOf(child(main, { worktree: 'nope' })),
			await outcomeOf(child(other, { worktree: 'new', name: 'x' })),
			await outcomeOf(child(main, { name: 'notes' })),
			await outcomeOf(child(main, { name: 'Two Words' }))
		];

		assert.deepStrictEqual({ outcomes, git: world.git.steps }, {
			outcomes: [
				'INVALID: name is required with worktree "new": the new worktree\'s branch is named after the child.',
				'NOT_FOUND: No worktree of lab is called nope. Its worktrees: main.',
				'REFUSED: @notes runs in /notes, which is no repository: children start beside it (WA-3.6).',
				'REFUSED: @notes is running, and it is not your child: choose another name.',
				'INVALID: "Two Words" is not a name: use up to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.'
			],
			git: []
		});
	});

	test('when the person does not let Facade answer Claude\'s first run, a child is not sent to a new worktree, and nothing is made', async () => {
		world.person.firstRunAnswers.set('claude', false);

		const refused = await outcomeOf(child(main, { worktree: 'new', name: 'clamp' }));

		assert.deepStrictEqual({ refused, git: world.git.steps, agents: [...world.registry.state.agents.keys()] }, {
			refused: 'REFUSED: The person did not let Facade answer Claude Code\'s first-run question in the worktrees it makes, so Claude Code cannot start in one. Start the child beside you, or ask the person.',
			git: [],
			agents: ['main']
		});
	});

	test('a child started again under its name stops the one before, and its parent is not told of it', async () => {
		await child(main, { name: 'helper' });
		const again = await child(main, { name: 'helper' });

		assert.deepStrictEqual({
			again: again.incarnation,
			typed: world.terminals.typed,
			running: [...world.terminals.running],
			toMain: world.registry.pendingFor('main').map(message => message.text)
		}, {
			again: 2,
			typed: ['@helper · Claude Code: [closed]'],
			running: ['@main · Claude Code', '@helper · Claude Code (2)'],
			toMain: []
		});
	});

	test('a message goes only to a parent or a child, the person gets theirs as a notification, and one that has stopped is refused', async () => {
		const clamp = await child(main, { name: 'clamp' });
		const slug = await child(main, { name: 'slug' });
		const other = await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', folder: '/notes' });

		const outcomes = [
			await outcomeOf(world.facade.send(clamp, '@main', 'Done.')),
			await outcomeOf(world.facade.send(main, 'clamp', 'Thanks.')),
			await outcomeOf(world.facade.send(clamp, '@slug', 'Hi, sibling.')),
			await outcomeOf(world.facade.send(clamp, `@${other.name}`, 'Hi.')),
			await outcomeOf(world.facade.send(main, '@you', 'All three are merged.'))
		];
		world.terminals.end('@clamp · Claude Code', 0);
		outcomes.push(await outcomeOf(world.facade.send(main, '@clamp', 'One more thing.')));
		world.terminals.end('@main · Claude Code', 0);
		outcomes.push(await outcomeOf(world.facade.send(slug, '@main', 'Done too.')));

		assert.deepStrictEqual({ outcomes, notifications: world.person.notifications }, {
			outcomes: [
				'fulfilled',
				'fulfilled',
				'REFUSED: @slug is not your parent or one of your children. Yours: @main, your parent.',
				'REFUSED: @notes is not your parent or one of your children. Yours: @main, your parent.',
				'fulfilled',
				'REFUSED: @clamp has stopped: the message was not delivered. spawn starts it again under its name.',
				'REFUSED: Your parent @main has left: the message was not delivered. Say it in your own output, where the person sees it.'
			],
			notifications: [
				'main: All three are merged. (@main · Claude Code)',
				'facade: @main stopped: its process exited with code 0'
			]
		});
	});

	test('every session start of an agent - the start, /clear, a compaction - loads its opening, and changes nothing else', async () => {
		const clamp = await child(main, { name: 'clamp' });
		const atStart = world.facade.hook(clamp, 'start', { source: 'startup' });
		world.facade.hook(clamp, 'prompt', {});
		const afterCompaction = world.facade.hook(clamp, 'start', { source: 'compact' });
		const opening = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"You are @clamp; your parent is @main."}}';

		assert.deepStrictEqual({ atStart, afterCompaction, state: world.registry.agent('clamp')?.state }, { atStart: opening, afterCompaction: opening, state: 'working' });
	});

	test('a message reaches an agent at its Stop hook, with its next tool result, or typed into its terminal once it is idle', async () => {
		const clamp = await child(main, { name: 'clamp' });
		const ways: string[] = [];
		world.registry.onDidAppend((event: LedgerEvent) => {
			if (event.type === 'message.delivered') {
				ways.push(event.way);
			}
		});

		world.facade.hook(main, 'prompt', {});
		await world.facade.send(clamp, '@main', 'Done: clamp.');
		const atStop = world.facade.hook(main, 'stop', { stop_hook_active: false });
		await world.facade.send(clamp, '@main', 'Tests pass.');
		const withResult = world.facade.messagesFor(main).map(message => message.text);
		const idle = world.facade.hook(main, 'stop', { stop_hook_active: true });
		await world.facade.send(clamp, '@main', 'One more:\n- a test for NaN');
		await until(() => ways.length === 3);

		assert.deepStrictEqual({ atStop, withResult, idle, typed: world.terminals.typed, ways, state: world.registry.agent('main')?.state }, {
			atStop: '{"decision":"block","reason":"[from @clamp] Done: clamp."}',
			withResult: ['Tests pass.'],
			idle: '',
			typed: [
				'@main · Claude Code: "[from @clamp] One more:"',
				'@main · Claude Code: "\\u001b[200~\\n- a test for NaN\\u001b[201~"',
				'@main · Claude Code: "\\r"'
			],
			ways: ['stop', 'result', 'terminal'],
			state: 'working'
		});
	});

	test('nothing is typed while the agent works, while a prompt waits in its terminal, or while the person types there', async () => {
		const clamp = await child(main, { name: 'clamp' });
		world.facade.hook(main, 'prompt', {});
		await world.facade.send(clamp, '@main', 'While you work.');
		await sleep(100);
		const whileWorking = world.terminals.typed.length;
		world.facade.hook(main, 'stop', { stop_hook_active: false });

		world.facade.hook(main, 'notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
		await world.facade.send(clamp, '@main', 'While you wait.');
		await sleep(100);
		const atPrompt = world.terminals.typed.length;
		world.facade.hook(main, 'stop', { stop_hook_active: true });

		world.facade.hook(main, 'stop', { stop_hook_active: true });
		world.terminals.lastInput.set('@main · Claude Code', Date.now());
		await world.facade.send(clamp, '@main', 'While you type.');
		await sleep(20);
		const whileTyping = world.terminals.typed.length;
		await until(() => world.terminals.typed.length === 2);

		assert.deepStrictEqual({ whileWorking, atPrompt, whileTyping, typed: world.terminals.typed }, {
			whileWorking: 0,
			atPrompt: 0,
			whileTyping: 0,
			typed: ['@main · Claude Code: "[from @clamp] While you type."', '@main · Claude Code: "\\r"']
		});
	});

	test('a parent hears from facade when its child waits at a prompt, stops or fails, and not when it stopped the child itself', async () => {
		const clamp = await child(main, { name: 'clamp' });
		const slug = await child(main, { name: 'slug' });
		world.facade.hook(clamp, 'notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
		world.terminals.end('@clamp · Claude Code', 1);
		world.terminals.failNext = 'claude exited as it started (exit code 1).';
		await outcomeOf(child(main, { name: 'broken' }));
		await world.facade.stop(main, '@slug');

		assert.deepStrictEqual({ toMain: world.registry.pendingFor('main').map(message => `${message.from}: ${message.text}`), slug: world.registry.agent(slug.name)?.stateDetail }, {
			toMain: [
				'facade: @clamp waits in its terminal: Claude needs your permission to use Bash',
				'facade: @clamp stopped: its process exited with code 1',
				'facade: @broken failed: claude exited as it started (exit code 1).'
			],
			slug: 'stopped by @main'
		});
	});

	test('an agent stops only its own children', async () => {
		const clamp = await child(main, { name: 'clamp' });
		await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', folder: '/notes' });

		const outcomes = [
			await outcomeOf(world.facade.stop(clamp, '@main')),
			await outcomeOf(world.facade.stop(main, '@notes')),
			await outcomeOf(world.facade.stop(main, '@nobody')),
			await outcomeOf(world.facade.stop(main, '@clamp')),
			await outcomeOf(world.facade.stop(main, '@clamp'))
		];

		assert.deepStrictEqual({ outcomes, clamp: world.registry.agent('clamp')?.state }, {
			outcomes: [
				'REFUSED: @main is not your child: an agent stops only its own children. Yours: @main, your parent.',
				'REFUSED: @notes is not your child: an agent stops only its own children. Yours: the person (@you), your parent, @clamp.',
				'NOT_FOUND: No agent is called @nobody. Yours: the person (@you), your parent, @clamp.',
				'fulfilled',
				'fulfilled'
			],
			clamp: 'stopped'
		});
	});

	test('an agent types only into its children\'s terminals and terminals that are no agent\'s, reads any, and the person types anywhere', async () => {
		await child(main, { name: 'clamp' });
		const other = await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', folder: '/notes' });
		world.ide.terminals.set('build', 'npm test');
		world.ide.terminals.set('@notes · Claude Code', undefined);
		world.terminals.screens.set('@notes · Claude Code', 'Working...');

		const outcomes = [
			await outcomeOf(world.facade.sendTerminal(main, '@clamp', 'y', true)),
			await outcomeOf(world.facade.sendTerminal(main, `@${other.name}`, 'y', true)),
			await outcomeOf(world.facade.sendTerminal(main, '@notes · Claude Code', 'y', true)),
			await outcomeOf(world.facade.sendTerminal(main, 'build', 'npm test', true)),
			await outcomeOf(world.facade.sendTerminal(PERSON, '@notes', 'go on', false)),
			await outcomeOf(world.facade.sendTerminal(main, '@nobody', 'y', true))
		];
		const read = await world.facade.readTerminal(main, '@notes', 10);

		assert.deepStrictEqual({ outcomes, read, typed: world.terminals.typed, steps: world.ide.steps }, {
			outcomes: [
				'fulfilled',
				'REFUSED: @notes\'s terminal is not yours to type into: an agent types only into its own children\'s terminals and terminals that are no agent\'s.',
				'REFUSED: @notes\'s terminal is not yours to type into: an agent types only into its own children\'s terminals and terminals that are no agent\'s.',
				'fulfilled',
				'fulfilled',
				'NOT_FOUND: No agent is called @nobody.'
			],
			read: { name: '@notes · Claude Code', text: 'Working...' },
			typed: ['@clamp · Claude Code: "y"', '@clamp · Claude Code: "\\r"', '@notes · Claude Code: "go on"'],
			steps: ['type "npm test" and Enter into build']
		});
	});

	test('an agent deletes a worktree of its repository with its children in it: not main, not its own, not one with somebody else\'s agent in it', async () => {
		const clamp = await child(main, { worktree: 'new', name: 'clamp' });
		await child(main, { worktree: 'new', name: 'slug' });
		await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', folder: worktreeFolder('/lab', 'slug'), name: 'guest' });

		const outcomes = [
			await outcomeOf(world.facade.deleteWorktree(main, 'main', false)),
			await outcomeOf(world.facade.deleteWorktree(main, 'nope', false)),
			await outcomeOf(world.facade.deleteWorktree(main, 'slug', false)),
			await outcomeOf(world.facade.deleteWorktree(clamp, 'clamp', false)),
			await outcomeOf(world.facade.deleteWorktree(main, 'clamp', true))
		];
		world.terminals.end('@clamp · Claude Code');

		assert.deepStrictEqual({ outcomes, clamp: world.registry.agent('clamp')?.stateDetail, git: world.git.steps.slice(2), toMain: world.registry.pendingFor('main') }, {
			outcomes: [
				'REFUSED: main is the repository\'s own checkout: it is not deleted.',
				'NOT_FOUND: No worktree of lab is called nope. Its worktrees: main, clamp, slug.',
				'REFUSED: @guest runs in slug and is not your child: it is not yours to delete.',
				'REFUSED: You run in clamp: it is not yours to delete while you are there.',
				'fulfilled'
			],
			clamp: 'its worktree was deleted',
			git: [`delete ${worktreeFolder('/lab', 'clamp')} with force`],
			toMain: []
		});
	});

	test('Claude\'s first-run question is answered in a worktree Facade made, and nowhere else', async () => {
		world.terminals.screens.set('@beside · Claude Code', TRUST_SCREEN);
		world.terminals.screens.set('@clamp · Claude Code', TRUST_SCREEN);
		await child(main, { name: 'beside' });
		const clamp = await child(main, { worktree: 'new', name: 'clamp' });
		await until(() => world.terminals.typed.length === 2);
		world.facade.hook(clamp, 'prompt', {});

		assert.deepStrictEqual(world.terminals.typed, ['@clamp · Claude Code: "\\u001b[B"', '@clamp · Claude Code: "\\r"']);
	});
});

suite('Core: after a reload', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-reload-');
	});

	teardown(() => {
		temp.remove();
	});

	test('a message that came while the window was away is typed in once the agent is found idle again', async () => {
		const dir = path.join(temp.dir, 'workspace');
		let world = fakeWorld(dir, { repositories: { '/lab': [] } });
		const main = callerOf(world.registry.agent((await world.facade.spawn(PERSON, { cli: 'claude', model: 'sonnet', prompt: 'Lead.', folder: '/lab' })).name)!);
		const clamp = callerOf(world.registry.agent((await world.facade.spawn(main, { cli: 'claude', model: 'haiku', prompt: 'Work.', name: 'clamp' })).name)!);
		world.facade.hook(main, 'prompt', {});
		await world.facade.send(clamp, '@main', 'Done.');
		world.dispose();

		// The window reloads while @main ends its turn.
		world = fakeWorld(dir, { repositories: { '/lab': [] } });
		world.terminals.running.add('@main · Claude Code');
		world.terminals.running.add('@clamp · Claude Code');
		await world.facade.recover();
		const atStop = world.facade.hook(main, 'stop', { stop_hook_active: false });
		world.dispose();

		assert.deepStrictEqual(atStop, '{"decision":"block","reason":"[from @clamp] Done."}');
	});
});
