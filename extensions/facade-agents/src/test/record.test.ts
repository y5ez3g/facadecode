/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { YOU } from '../record/events';
import { LEDGER_FILE, Ledger, LedgerLockedError } from '../record/ledger';
import { agentName, nameOfWorktree } from '../record/names';
import { workspaceDir } from '../record/paths';
import { AgentRegistry, NewAgent, PERSON, YOU_TOKEN_FILE } from '../record/registry';
import { JsonFileState } from '../record/windowState';
import { tempDir } from './util';

function inWorktree(name: string, worktree = 'main'): NewAgent {
	return { name, cli: 'claude', model: 'sonnet', worktree, folder: '/lab', parent: YOU };
}

suite('Record: agents, their names and their tokens', () => {

	let temp: { dir: string; remove(): void };
	let registry: AgentRegistry;

	setup(() => {
		temp = tempDir('facade-registry-');
		registry = AgentRegistry.open({ dir: temp.dir });
	});

	teardown(() => {
		registry.dispose();
		temp.remove();
	});

	test('an agent takes its worktree\'s name, the next ones -2 and -3 while those run, and a stopped one\'s name is taken again', () => {
		const start = () => {
			const name = registry.nameFor('main');
			registry.add(inWorktree(name));
			return name;
		};
		const first = [start(), start(), start()];
		registry.setState('main-2', 1, 'stopped', 'its terminal closed');
		const again = start();

		assert.deepStrictEqual({ first, again, incarnation: registry.agent('main-2')?.incarnation }, { first: ['main', 'main-2', 'main-3'], again: 'main-2', incarnation: 2 });
	});

	test('a worktree\'s name makes an agent\'s: lower case, a branch\'s slashes as dashes, never one Facade keeps', () => {
		const refusal = (text: string) => {
			try {
				return `taken as ${agentName(text)}`;
			} catch (err) {
				return (err as Error).message;
			}
		};

		assert.deepStrictEqual({
			fromWorktrees: ['main', 'Feature/Parser-2', '.hidden', 'you', ''].map(nameOfWorktree),
			nameFor: registry.nameFor('Feature/Parser-2'),
			given: ['you', 'two words', '@Clamp'].map(refusal)
		}, {
			fromWorktrees: ['main', 'feature-parser-2', 'hidden', 'agent', 'agent'],
			nameFor: 'feature-parser-2',
			given: [
				'"you" is reserved; choose another name.',
				'"two words" is not a name: use up to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit.',
				'taken as clamp'
			]
		});
	});

	test('each incarnation\'s token is written to its run folder; a new incarnation\'s takes over, and a stopped one does not come back', () => {
		const first = registry.add(inWorktree('main'));
		registry.setState('main', 1, 'stopped');
		const second = registry.add(inWorktree('main'));
		registry.setState('main', 1, 'working');

		assert.deepStrictEqual({
			files: [first.tokenFile, second.tokenFile].map(file => path.relative(temp.dir, file)),
			written: fs.readFileSync(second.tokenFile, 'utf8') === second.token,
			first: registry.authenticate(first.token),
			second: registry.authenticate(second.token),
			person: registry.authenticate(registry.youToken),
			stranger: registry.authenticate('nobody'),
			state: registry.agent('main')?.state
		}, {
			files: [path.join('runs', 'main-1.token'), path.join('runs', 'main-2.token')],
			written: true,
			first: undefined,
			second: { name: 'main', incarnation: 2 },
			person: PERSON,
			stranger: undefined,
			state: 'starting'
		});
	});
});

suite('Record: on disk', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-ledger-');
	});

	teardown(() => {
		temp.remove();
	});

	test('a reload loses nothing: agents, their states, their tokens and the person\'s', () => {
		let registry = AgentRegistry.open({ dir: temp.dir });
		const added = registry.add(inWorktree('main'));
		registry.setState('main', 1, 'stopped', 'its terminal closed');
		const youToken = registry.youToken;
		registry.dispose();

		registry = AgentRegistry.open({ dir: temp.dir });
		const agent = registry.agent('main');
		const reloaded = {
			agent: agent && { cli: agent.cli, worktree: agent.worktree, folder: agent.folder, model: agent.model, parent: agent.parent, state: agent.state, detail: agent.stateDetail },
			token: registry.authenticate(added.token),
			youToken: registry.youToken === youToken,
			youTokenFile: fs.existsSync(path.join(temp.dir, YOU_TOKEN_FILE))
		};
		registry.dispose();

		assert.deepStrictEqual(reloaded, {
			agent: { cli: 'claude', worktree: 'main', folder: '/lab', model: 'sonnet', parent: YOU, state: 'stopped', detail: 'its terminal closed' },
			token: { name: 'main', incarnation: 1 },
			youToken: true,
			youTokenFile: true
		});
	});

	test('a last line cut short by a crash is dropped, and the file is repaired', () => {
		let registry = AgentRegistry.open({ dir: temp.dir });
		registry.add(inWorktree('main'));
		const seq = registry.state.seq;
		registry.dispose();
		const file = path.join(temp.dir, LEDGER_FILE);
		fs.appendFileSync(file, '{"v":1,"seq":2,"type":"agent.st');

		registry = AgentRegistry.open({ dir: temp.dir });
		const afterCrash = registry.state.seq;
		registry.setState('main', 1, 'stopped');
		registry.dispose();
		registry = AgentRegistry.open({ dir: temp.dir });

		assert.deepStrictEqual({ afterCrash, state: registry.agent('main')?.state, endsWell: fs.readFileSync(file, 'utf8').endsWith('}\n') }, { afterCrash: seq, state: 'stopped', endsWell: true });
		registry.dispose();
	});

	test('a second window is refused while the first is alive, and takes over once it is gone', () => {
		const lock = path.join(temp.dir, 'ledger.lock');
		fs.writeFileSync(lock, '424242');
		let refused: string | undefined;
		try {
			Ledger.open(temp.dir, Date.now, () => true);
		} catch (err) {
			refused = err instanceof LedgerLockedError ? err.message : `not refused: ${err}`;
		}
		Ledger.open(temp.dir, Date.now, () => false).close();

		assert.deepStrictEqual({ refused, lockLeft: fs.existsSync(lock) }, {
			refused: 'Another Facade window (process 424242) has this workspace\'s ledger open.',
			lockLeft: false
		});
	});

	test('a workspace is found by its first folder, whatever the case of its path on Windows', () => {
		const folder = path.join(temp.dir, 'My Repo');
		fs.mkdirSync(folder);
		const dir = workspaceDir('/root', folder);

		assert.deepStrictEqual({
			named: /^My_Repo-[0-9a-f]{12}$/.test(path.basename(dir)),
			again: workspaceDir('/root', folder) === dir,
			otherCase: process.platform === 'win32' ? workspaceDir('/root', folder.toUpperCase()) === dir : true,
			another: workspaceDir('/root', temp.dir) === dir
		}, { named: true, again: true, otherCase: true, another: false });
	});

	test('the window\'s state: what one sets, the next one made on the same file reads; a value set to undefined is gone', async () => {
		const file = path.join(temp.dir, 'workspace', 'window-state.json');
		const first = new JsonFileState(file);
		const before = first.get('pipe', 'none');
		await first.update('pipe', 'b71ef6fd');
		await first.update('pids', { '@lead · Claude Code': 4242 });
		await first.update('gone', 1);
		await first.update('gone', undefined);

		const second = new JsonFileState(file);
		assert.deepStrictEqual(
			{ before, pipe: second.get('pipe', 'none'), pids: second.get('pids', {}), gone: second.get('gone', 'default') },
			{ before: 'none', pipe: 'b71ef6fd', pids: { '@lead · Claude Code': 4242 }, gone: 'default' });
	});

	test('the window\'s state: a file that does not hold an object of values starts it empty', () => {
		const file = path.join(temp.dir, 'window-state.json');
		const read = (content: string) => {
			fs.writeFileSync(file, content);
			return new JsonFileState(file).get('pipe', 'none');
		};
		assert.deepStrictEqual([read('{"pipe":'), read('["pipe"]'), read('null'), read('{"pipe":"a1"}')], ['none', 'none', 'none', 'a1']);
	});
});
