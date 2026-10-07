/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { excludeIn, repositoryIn, trackedIn, untrackedIn, worktreesIn } from '../host/gitCli';
import { JsonFileState } from '../host/windowState';
import { outcomeOf, tempDir } from './util';

suite('Host: Facade: Start Agent', () => {

	test('until the popup lands, the Command Palette has one command that starts an agent in the worktree on screen: Facade: Start Agent...', () => {
		const extension = path.join(__dirname, '..', '..');
		const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8'));
		const names = JSON.parse(fs.readFileSync(path.join(extension, 'package.nls.json'), 'utf8'));
		const command = (manifest.contributes?.commands ?? []).find((each: { command?: string }) => each.command === 'facade.agents.startAgent');
		const hidden = (manifest.contributes?.menus?.commandPalette ?? []).some((each: { command?: string; when?: string }) => each.command === 'facade.agents.startAgent' && each.when === 'false');

		assert.deepStrictEqual({ title: names[String(command?.title).replace(/^%|%$/g, '')], category: names[String(command?.category).replace(/^%|%$/g, '')], hidden }, { title: 'Start Agent...', category: 'Facade', hidden: false });
	});
});

suite('Host: the window\'s state, beside the record', () => {

	let temp: { dir: string; remove(): void };

	setup(() => {
		temp = tempDir('facade-window-state-');
	});

	teardown(() => {
		temp.remove();
	});

	test('what one sets, the next one made on the same file reads; a value set to undefined is gone', async () => {
		const file = path.join(temp.dir, 'workspace', 'window-state.json');
		const first = new JsonFileState(file);
		const before = first.get('pipe') ?? 'none';
		await first.update('pipe', 'b71ef6fd');
		await first.update('agents', { running: 2 });
		await first.update('gone', 1);
		await first.update('gone', undefined);

		const second = new JsonFileState(file);
		assert.deepStrictEqual(
			{ before, pipe: second.get('pipe'), agents: second.get('agents'), gone: second.get('gone') ?? 'default', inherited: second.get('toString') ?? 'none' },
			{ before: 'none', pipe: 'b71ef6fd', agents: { running: 2 }, gone: 'default', inherited: 'none' });
	});

	test('a file that does not hold an object of values starts it empty', () => {
		const file = path.join(temp.dir, 'window-state.json');
		const read = (content: string) => {
			fs.writeFileSync(file, content);
			return new JsonFileState(file).get('pipe') ?? 'none';
		};
		assert.deepStrictEqual([read('{"pipe":'), read('["pipe"]'), read('null'), read('{"pipe":"a1"}')], ['none', 'none', 'none', 'a1']);
	});
});

suite('Host: git\'s records, read with git', function () {

	this.timeout(30_000);

	let temp: { dir: string; remove(): void };
	const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

	setup(() => {
		temp = tempDir('facade-git-');
	});

	teardown(() => {
		temp.remove();
	});

	test('only a folder git says is in no repository is in none, and git tracks nothing there; a checkout on a branch with no commit yet is in one, with no HEAD, as is one whose branch git cannot read; git failing says why, and nothing is taken for none tracked', async () => {
		const plain = path.join(temp.dir, 'plain');
		const empty = path.join(temp.dir, 'empty');
		const orphan = path.join(temp.dir, 'orphan');
		const broken = path.join(temp.dir, 'broken');
		const gone = path.join(temp.dir, 'gone');
		fs.mkdirSync(plain);
		fs.mkdirSync(empty);
		git(empty, 'init', '-q');
		// A repository with a commit, on a branch with none.
		fs.mkdirSync(orphan);
		git(orphan, 'init', '-q');
		git(orphan, '-c', 'user.name=Facade', '-c', 'user.email=facade@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Start');
		git(orphan, 'checkout', '-q', '--orphan', 'new');
		// A repository with a commit, whose branch is no commit id.
		fs.mkdirSync(broken);
		git(broken, 'init', '-q', '-b', 'main');
		git(broken, '-c', 'user.name=Facade', '-c', 'user.email=facade@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Start');
		fs.writeFileSync(path.join(broken, '.git', 'refs', 'heads', 'main'), 'garbage\n');

		assert.deepStrictEqual({
			plain: await repositoryIn('git', plain),
			empty: await repositoryIn('git', empty),
			orphan: await repositoryIn('git', orphan),
			broken: await repositoryIn('git', broken),
			gone: /cannot change to/.test(await outcomeOf(repositoryIn('git', gone))),
			excludePlain: await excludeIn('git', plain),
			excludeGone: /cannot change to/.test(await outcomeOf(excludeIn('git', gone))),
			trackedPlain: [...await trackedIn('git', plain, ['.mcp.json'])],
			trackedGone: /cannot change to/.test(await outcomeOf(trackedIn('git', gone, ['.mcp.json'])))
		}, {
			plain: undefined,
			empty: { main: empty, worktree: 'main', head: undefined },
			orphan: { main: orphan, worktree: 'main', head: undefined },
			broken: { main: broken, worktree: 'main', head: undefined },
			gone: true,
			excludePlain: undefined,
			excludeGone: true,
			trackedPlain: [],
			trackedGone: true
		});
	});

	test('in a repository: its main checkout, its HEAD, where its exclude file is, and which of some files it tracks, each taken as it is', async () => {
		const lab = path.join(temp.dir, 'lab');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(lab, '.mcp.json'), '{}');
		git(lab, 'add', '.mcp.json');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '-m', 'first');
		const head = git(lab, 'rev-parse', 'HEAD').stdout.trim();

		const repository = await repositoryIn('git', lab);
		const exclude = await excludeIn('git', lab);
		assert.deepStrictEqual({
			repository: repository && { main: path.relative(temp.dir, repository.main), worktree: repository.worktree, head: repository.head === head },
			exclude: exclude && [path.relative(lab, exclude.file), path.relative(temp.dir, exclude.root)],
			tracked: [...await trackedIn('git', lab, ['.mcp.json', '.muse/hooks.json', '*.json'])]
		}, {
			repository: { main: 'lab', worktree: 'main', head: true },
			exclude: [path.join('.git', 'info', 'exclude'), 'lab'],
			tracked: ['.mcp.json']
		});
	});

	test('a bare repository has no worktree of its own: its worktrees are those checked out of it, and a file of the person\'s is looked for in them alone', async () => {
		const seed = path.join(temp.dir, 'seed');
		const bare = path.join(temp.dir, 'lab.git');
		const main = path.join(temp.dir, 'main');
		fs.mkdirSync(seed);
		git(seed, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(seed, 'tracked.json'), '{}');
		git(seed, 'add', '.');
		git(seed, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '-m', 'first');
		git(temp.dir, 'clone', '-q', '--bare', seed, bare);
		git(bare, 'worktree', 'add', '-q', main, 'main');
		fs.writeFileSync(path.join(main, '.mcp.json'), '{}');

		assert.deepStrictEqual({
			worktrees: (await worktreesIn('git', main)).map(each => path.relative(temp.dir, each.folder)),
			untracked: [...await untrackedIn('git', main, ['.mcp.json', 'tracked.json'])]
		}, {
			worktrees: ['main'],
			untracked: ['.mcp.json']
		});
	});

	test('a file of the person\'s that git neither tracks nor ignores is found in whichever worktree of the repository has it, at the same place from that worktree\'s root; one git tracks or ignores, or in a worktree whose folder is gone, is not', async () => {
		const lab = path.join(temp.dir, 'lab');
		const other = path.join(temp.dir, 'other');
		const gone = path.join(temp.dir, 'gone');
		fs.mkdirSync(path.join(lab, 'packages', 'app'), { recursive: true });
		git(lab, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(lab, 'tracked.json'), '{}');
		fs.writeFileSync(path.join(lab, 'packages', 'app', 'keep.txt'), '');
		git(lab, 'add', '.');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '-m', 'first');
		git(lab, 'worktree', 'add', '-q', '-b', 'other', other);
		git(lab, 'worktree', 'add', '-q', '-b', 'gone', gone);
		fs.rmSync(gone, { recursive: true, force: true });
		// The person's own, untracked: one in the other worktree, one in a folder of it, one they ignore.
		fs.writeFileSync(path.join(other, '.mcp.json'), '{}');
		fs.writeFileSync(path.join(other, 'packages', 'app', '.mcp.json'), '{}');
		fs.writeFileSync(path.join(other, 'ignored.json'), '{}');
		fs.writeFileSync(path.join(lab, '.gitignore'), 'ignored.json\n');
		fs.writeFileSync(path.join(other, '.gitignore'), 'ignored.json\n');

		assert.deepStrictEqual({
			root: [...await untrackedIn('git', lab, ['.mcp.json', '.muse/hooks.json', 'tracked.json', 'ignored.json'])],
			inside: [...await untrackedIn('git', path.join(lab, 'packages', 'app'), ['.mcp.json', '.muse/hooks.json'])],
			plain: [...await untrackedIn('git', temp.dir, ['.mcp.json'])]
		}, {
			root: ['.mcp.json'],
			inside: ['.mcp.json'],
			plain: []
		});
	});

	test('a worktree git still lists whose folder is left without its .git - as git removing it leaves one a process is in, on Windows - is a worktree no more: it is not among the repository\'s worktrees, nothing is looked for there, and git is not asked there', async () => {
		const lab = path.join(temp.dir, 'lab');
		const other = path.join(temp.dir, 'other');
		const emptied = path.join(temp.dir, 'emptied');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
		git(lab, 'worktree', 'add', '-q', '-b', 'other', other);
		git(lab, 'worktree', 'add', '-q', '-b', 'emptied', emptied);
		for (const entry of fs.readdirSync(emptied)) {
			fs.rmSync(path.join(emptied, entry), { recursive: true, force: true });
		}
		fs.writeFileSync(path.join(other, '.mcp.json'), '{}');

		assert.deepStrictEqual({
			listed: (await worktreesIn('git', lab)).map(each => path.relative(temp.dir, each.folder)).sort(),
			untracked: [...await untrackedIn('git', lab, ['.mcp.json'])]
		}, {
			listed: ['lab', 'other'],
			untracked: ['.mcp.json']
		});
	});

	test('a worktree whose folder is gone is not among the repository\'s worktrees either: git lists it until it is pruned', async () => {
		const lab = path.join(temp.dir, 'lab');
		const gone = path.join(temp.dir, 'gone');
		fs.mkdirSync(lab);
		git(lab, 'init', '-q', '-b', 'main');
		git(lab, '-c', 'user.name=Test', '-c', 'user.email=test@test.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
		git(lab, 'worktree', 'add', '-q', '-b', 'gone', gone);
		fs.rmSync(gone, { recursive: true, force: true });

		assert.deepStrictEqual({
			git: /prunable/.test(git(lab, 'worktree', 'list', '--porcelain').stdout),
			listed: (await worktreesIn('git', lab)).map(each => path.relative(temp.dir, each.folder))
		}, { git: true, listed: ['lab'] });
	});
});
