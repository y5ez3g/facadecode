/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PERSON } from '../record/registry';
import { fakeWorld } from './fakes';
import { outcomeOf, tempDir } from './util';

suite('Core: starting agents, and finding them again after a reload', () => {

	let temp: { dir: string; remove(): void };
	let world: ReturnType<typeof fakeWorld>;

	setup(() => {
		temp = tempDir('facade-core-');
		world = fakeWorld(path.join(temp.dir, 'workspace'), { '/lab': 'main', '/lab-parser': 'feature/parser' });
	});

	teardown(() => {
		world.dispose();
		temp.remove();
	});

	test('the person starts an agent: named after its worktree, its CLI in a terminal of that folder, with Facade\'s server and its own token', async () => {
		const agent = await world.facade.startAgent(PERSON, { cli: 'claude', model: 'sonnet', prompt: 'Add a parser.', folder: '/lab' });
		const launched = world.terminals.launched[0];
		const configFile = path.join(world.registry.runsDir, 'main-1.mcp.json');
		const server = JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers.facade;
		const token = fs.readFileSync(server.args[server.args.indexOf('--token-file') + 1], 'utf8');

		assert.deepStrictEqual({
			agent: { name: agent.name, incarnation: agent.incarnation, cli: agent.cli, model: agent.model, worktree: agent.worktree, folder: agent.folder, parent: agent.parent, state: agent.state },
			terminal: { name: launched.name, executable: launched.executable, cwd: launched.cwd, first: launched.args[0], model: launched.args.slice(-2) },
			caller: world.registry.authenticate(token)
		}, {
			agent: { name: 'main', incarnation: 1, cli: 'claude', model: 'sonnet', worktree: 'main', folder: '/lab', parent: 'you', state: 'starting' },
			terminal: { name: '@main · Claude Code', executable: '/bin/claude', cwd: '/lab', first: 'Add a parser.', model: ['--model', 'sonnet'] },
			caller: { name: 'main', incarnation: 1 }
		});
	});

	test('a second agent in a worktree is <worktree>-2; a worktree\'s branch names its agent', async () => {
		const names: string[] = [];
		for (const folder of ['/lab', '/lab', '/lab-parser']) {
			names.push((await world.facade.startAgent(PERSON, { cli: 'claude', model: 'haiku', folder })).name);
		}

		assert.deepStrictEqual({ names, terminals: world.terminals.launched.map(each => each.name) }, {
			names: ['main', 'main-2', 'feature-parser'],
			terminals: ['@main · Claude Code', '@main-2 · Claude Code', '@feature-parser · Claude Code']
		});
	});

	test('a CLI this machine does not have is UNAVAILABLE, naming the ones it has; an empty model is INVALID', async () => {
		const outcomes = [
			await outcomeOf(world.facade.startAgent(PERSON, { cli: 'codex', model: 'gpt-5.5', folder: '/lab' })),
			await outcomeOf(world.facade.startAgent(PERSON, { cli: 'claude', model: ' ', folder: '/lab' }))
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

		const failed = await outcomeOf(world.facade.startAgent(PERSON, { cli: 'claude', model: 'sonnet', folder: '/lab' }));
		const agent = world.registry.agent('main');

		assert.deepStrictEqual({ failed, state: agent?.state, detail: agent?.stateDetail }, {
			failed: 'FAILED: claude exited as it started (exit code 1).',
			state: 'failed',
			detail: 'claude exited as it started (exit code 1).'
		});
	});

	test('an agent whose terminal ends is stopped; after a reload, the ones whose terminals are gone are stopped and the others kept', async () => {
		for (const folder of ['/lab', '/lab', '/lab-parser']) {
			await world.facade.startAgent(PERSON, { cli: 'claude', model: 'sonnet', folder });
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
