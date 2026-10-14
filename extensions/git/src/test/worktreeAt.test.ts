/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { execFile, execFileSync, spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorktreeAt, deleteWorktreeAt, folderPath, isWorktreeIncluded, IWorktreeGit, parseWorktreeInclude, prepareWorktreeBaseAt } from '../worktreeAt';

/**
 * What every git in these tests runs with: none of this machine's own configuration - a global
 * `commit.gpgSign`, hooks path or default branch changes what they measure - nor any `GIT_` variable
 * of the process running them, such as the repository of a hook that runs them, and its messages in
 * English, as `Git.exec` asks for them.
 */
const environment = {
	...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))),
	GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANGUAGE: 'en', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8'
};

/** Real git, the way the command centre's `Git.exec` runs it: an argument array, never a shell. */
const git: IWorktreeGit = {
	exec: (cwd, args, options) => new Promise((resolve, reject) => {
		execFile('git', args, { cwd, env: { ...environment, ...options?.env } }, (error, stdout, stderr) => {
			if (error) {
				// As `Git.exec`'s `GitError` carries them: what git wrote, and the code it exited with.
				reject(Object.assign(new Error(stderr || error.message), { stderr, exitCode: error.code }));
				return;
			}
			resolve({ stdout });
		});
	})
};

suite('worktreeAt', () => {

	let dir: string;
	let main: string;

	function run(cwd: string, ...args: string[]): string {
		return execFileSync('git', args, { cwd, encoding: 'utf8', env: environment }).trim();
	}

	function write(file: string, content: string): void {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	}

	setup(() => {
		// The real path: git records worktrees by theirs, and the temp folder is a link on macOS
		// (`/var` to `/private/var`) and can be a short name on Windows.
		dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'worktreeAt-')));
		main = path.join(dir, 'main');

		write(path.join(main, '.gitignore'), 'node_modules/\n.env\n*.local.json\nsecrets/\n');
		write(path.join(main, 'tracked.txt'), 'tracked\n');
		write(path.join(main, 'apps', 'web', 'index.js'), 'web\n');
		run(main, 'init', '-q', '-b', 'main');
		run(main, 'add', '.');
		run(main, '-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-q', '-m', 'init');

		// Ignored, and not: what .worktreeinclude chooses from.
		write(path.join(main, '.env'), 'SECRET=1\n');
		write(path.join(main, 'app.local.json'), '{}\n');
		write(path.join(main, 'secrets', 'key.txt'), 'key\n');
		write(path.join(main, 'node_modules', 'dep', 'index.js'), 'dep\n');
		write(path.join(main, 'apps', 'web', '.env'), 'WEB=1\n');
		write(path.join(main, 'scratch.txt'), 'untracked, not ignored\n');
	});

	teardown(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('WTA-20 .worktreeinclude is read the way gitignore reads a pattern file', () => {
		const rules = parseWorktreeInclude('# local config\n.env\n*.local.json\nsecrets/\n/build/cache\n!keep.local.json\n');
		const cases: [string, boolean][] = [['.env', false], ['apps/web/.env', false], ['a/b/app.local.json', false], ['keep.local.json', false], ['secrets', true], ['secrets', false], ['build/cache', true], ['src/build/cache', true], ['secrets/key.txt', false], ['README.md', false]];

		assert.deepStrictEqual(Object.fromEntries(cases.map(([file, isDirectory]) => [`${file}${isDirectory ? '/' : ''}`, isWorktreeIncluded(rules, file, isDirectory)])), {
			'.env': true,
			'apps/web/.env': true,
			'a/b/app.local.json': true,
			'keep.local.json': false,
			'secrets/': true,
			'secrets': false,
			'build/cache/': true,
			'src/build/cache/': false,
			'secrets/key.txt': true,
			'README.md': false,
		});
	});

	test('WTA-20 creates the worktree on a new branch and copies what is both ignored and included', async () => {
		write(path.join(main, '.worktreeinclude'), '.env\n*.local.json\nsecrets/\n');
		const worktree = path.join(dir, 'worktrees', 'main', 'feat-a');

		const result = await createWorktreeAt(git, main, worktree, 'feat/a');

		assert.deepStrictEqual({
			result,
			branch: run(worktree, 'branch', '--show-current'),
			files: Object.fromEntries(['.env', 'app.local.json', 'secrets/key.txt', 'apps/web/.env', 'node_modules/dep/index.js', 'scratch.txt', 'tracked.txt']
				.map(file => [file, existsSync(path.join(worktree, file))]))
		}, {
			result: { kind: 'created', copyFailures: [], hookFailure: undefined },
			branch: 'feat/a',
			files: {
				'.env': true,
				'app.local.json': true,
				'secrets/key.txt': true,
				'apps/web/.env': true,
				'node_modules/dep/index.js': false,
				'scratch.txt': false,
				'tracked.txt': true,
			}
		});
	});

	test('WTA-28 making a worktree adds no ignore entry and no setting, to the checkout or the worktree: only git\'s own record of it changes', async () => {
		write(path.join(main, '.worktreeinclude'), '.env\n');
		const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : undefined;
		// Every file in the checkout, ignored ones included
		const checkout = () => ({
			gitignore: read(path.join(main, '.gitignore')),
			exclude: read(path.join(main, '.git', 'info', 'exclude')),
			files: run(main, 'status', '--porcelain', '--ignored', '--untracked-files=all')
		});
		const before = checkout();
		const worktree = path.join(dir, 'worktrees', 'main', 'feat-a');

		const result = await createWorktreeAt(git, main, worktree, 'feat/a');

		assert.deepStrictEqual({
			result: result.kind,
			checkout: checkout(),
			worktree: run(worktree, 'status', '--porcelain', '--untracked-files=all'),
			settings: [main, worktree].map(folder => existsSync(path.join(folder, '.vscode'))),
			recorded: existsSync(path.join(main, '.git', 'worktrees', 'feat-a'))
		}, {
			result: 'created',
			checkout: before,
			worktree: '',
			settings: [false, false],
			recorded: true
		});
	});

	test('WTA-28 a worktree whose paths are longer than this machine\'s git can write is made, or fails in git\'s words - never taken for made', async () => {
		// With no system or global configuration (`environment`), so `core.longpaths` is git's own default
		const deep = path.join('a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'file.txt');
		write(path.join(main, deep), 'deep\n');
		run(main, 'add', '--', deep);
		run(main, '-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-q', '-m', 'deep');
		const worktree = path.join(dir, 'worktrees', 'w'.repeat(60));
		const recorded = `${run(main, 'version')}, ${os.platform()}, core.longpaths ${run(main, 'config', '--default', 'unset', 'core.longpaths')}, longest path ${path.join(worktree, deep).length} characters`;

		const result = await createWorktreeAt(git, main, worktree, 'feat/long');

		if (result.kind === 'created') {
			assert.ok(existsSync(path.join(worktree, deep)), `made, but its deepest file is not there (${recorded})`);
		} else {
			assert.match(result.message, /too long/i, `failed, but not in git's words about the path (${recorded}): ${result.message}`);
		}
	});

	test('WTA-18 creates the worktree at a given commit, and refuses a start point that is not a full commit id', async () => {
		const first = run(main, 'rev-parse', 'HEAD');
		write(path.join(main, 'later.txt'), 'later\n');
		run(main, 'add', 'later.txt');
		run(main, '-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-q', '-m', 'later');
		const worktree = path.join(dir, 'worktrees', 'main', 'at-first');

		const result = await createWorktreeAt(git, main, worktree, 'at/first', first);
		const refused = await createWorktreeAt(git, main, path.join(dir, 'worktrees', 'main', 'refused'), 'refused', '--orphan');

		assert.deepStrictEqual({
			result,
			head: run(worktree, 'rev-parse', 'HEAD'),
			later: existsSync(path.join(worktree, 'later.txt')),
			refused: refused.kind === 'error' && refused.code
		}, {
			result: { kind: 'created', copyFailures: [], hookFailure: undefined },
			head: first,
			later: false,
			refused: 'InvalidArgument'
		});
	});

	test('WTA-20 WTA-31 .worktreeinclude never copies through a link: not one it names, nor one inside a folder it names', async () => {
		// Junctions on Windows, which need no privilege to make; links elsewhere.
		const outside = path.join(dir, 'outside');
		write(path.join(outside, 'private.txt'), 'private\n');
		symlinkSync(outside, path.join(main, '.cache'), 'junction');
		symlinkSync(outside, path.join(main, 'secrets', 'outside'), 'junction');
		write(path.join(main, '.gitignore'), 'node_modules/\n.env\n*.local.json\nsecrets/\n.cache\n');
		write(path.join(main, '.worktreeinclude'), '.cache\nsecrets/\n');
		const worktree = path.join(dir, 'worktrees', 'links');

		const result = await createWorktreeAt(git, main, worktree, 'links');

		assert.deepStrictEqual({
			result,
			files: Object.fromEntries(['.cache', 'secrets/key.txt', 'secrets/outside'].map(file => [file, existsSync(path.join(worktree, file))]))
		}, {
			result: { kind: 'created', copyFailures: [], hookFailure: undefined },
			files: { '.cache': false, 'secrets/key.txt': true, 'secrets/outside': false }
		});
	});

	test('WTA-19 git lfs checkout runs in the new worktree, and no Git LFS is no failure', async () => {
		const worktree = path.join(dir, 'worktrees', 'lfs');
		const lfs: string[][] = [];
		// Git without Git LFS installed: `git lfs` is not a command it knows.
		const withoutLfs: IWorktreeGit = {
			exec: (cwd, args, options) => {
				if (args[0] === 'lfs') {
					lfs.push([cwd, ...args]);
					return Promise.reject(Object.assign(new Error('not a git command'), { stderr: `git: 'lfs' is not a git command. See 'git --help'.` }));
				}
				return git.exec(cwd, args, options);
			}
		};

		const result = await createWorktreeAt(withoutLfs, main, worktree, 'lfs');

		assert.deepStrictEqual({ result, lfs }, {
			result: { kind: 'created', copyFailures: [], hookFailure: undefined },
			lfs: [[worktree, 'lfs', 'checkout']],
		});
	});

	test('WTA-19 a create that fails takes the branch it made with it, so the same name can be tried again', async () => {
		// A folder already at the path: git makes the branch, then refuses the path.
		const taken = path.join(dir, 'worktrees', 'taken');
		write(path.join(taken, 'keep.txt'), 'keep\n');

		const failed = await createWorktreeAt(git, main, taken, 'again');
		const branchAfterFailure = run(main, 'branch', '--list', 'again');
		const retried = await createWorktreeAt(git, main, path.join(dir, 'worktrees', 'free'), 'again');

		assert.deepStrictEqual({ failed: failed.kind, branchAfterFailure, retried: retried.kind, kept: existsSync(path.join(taken, 'keep.txt')) }, {
			failed: 'error',
			branchAfterFailure: '',
			retried: 'created',
			kept: true,
		});
	});

	test('WTA-19 a worktree whose post-checkout hook failed is made all the same, as git keeps it, and the hook\'s failure said', async () => {
		const hook = path.join(main, '.git', 'hooks', 'post-checkout');
		write(hook, '#!/bin/sh\necho "the hook says no" >&2\nexit 3\n');
		chmodSync(hook, 0o755);
		const worktree = path.join(dir, 'worktrees', 'hooked');

		const result = await createWorktreeAt(git, main, worktree, 'hooked');

		assert.deepStrictEqual({
			kind: result.kind,
			hookFailure: result.kind === 'created' && !!result.hookFailure?.includes('the hook says no'),
			listed: run(main, 'worktree', 'list').includes('hooked'),
			branch: run(main, 'branch', '--list', '--format=%(refname:short)', 'hooked'),
		}, {
			kind: 'created',
			hookFailure: true,
			listed: true,
			branch: 'hooked',
		});
	});

	test('WTA-19 a create that fails leaves alone a branch that was there before it', async () => {
		// Not checked out anywhere, and merged: `branch -d` would take it.
		run(main, 'branch', 'kept');
		const taken = path.join(dir, 'worktrees', 'taken');
		write(path.join(taken, 'keep.txt'), 'keep\n');

		const failed = await createWorktreeAt(git, main, taken, 'kept');

		assert.deepStrictEqual({ failed: failed.kind, branch: run(main, 'branch', '--list', '--format=%(refname:short)', 'kept') }, {
			failed: 'error',
			branch: 'kept',
		});
	});

	test('WTA-19 a branch that already exists is returned as an error, not thrown', async () => {
		await createWorktreeAt(git, main, path.join(dir, 'worktrees', 'one'), 'taken');

		const result = await createWorktreeAt(git, main, path.join(dir, 'worktrees', 'two'), 'taken');

		// The code the bar keys "Go There" on, although upstream's own match for it misses the
		// lower-case sentence git writes now; and git's reason, without the progress line before it.
		assert.deepStrictEqual(result.kind === 'error' ? { code: result.code, message: result.message } : result, {
			code: 'BranchAlreadyExists',
			message: `a branch named 'taken' already exists`
		});
	});

	test('check names what would be lost; remove refuses it; force removes it and keeps the branch', async () => {
		const worktree = path.join(dir, 'worktrees', 'dirty');
		await createWorktreeAt(git, main, worktree, 'dirty');
		write(path.join(worktree, 'tracked.txt'), 'changed\n');
		write(path.join(worktree, 'new.txt'), 'new\n');

		const check = await deleteWorktreeAt(git, main, worktree, 'check');
		const remove = await deleteWorktreeAt(git, main, worktree, 'remove');
		const force = await deleteWorktreeAt(git, main, worktree, 'force');

		assert.deepStrictEqual({
			check: check.kind === 'checked' ? [...check.files].sort() : check,
			remove: remove.kind,
			force,
			folder: existsSync(worktree),
			branch: run(main, 'branch', '--list', 'dirty'),
		}, {
			check: ['new.txt', 'tracked.txt'],
			remove: 'error',
			force: { kind: 'removed' },
			folder: false,
			branch: 'dirty',
		});
	});

	test('a directory something still has open is waited out, not left behind', async () => {
		const worktree = path.join(dir, 'worktrees', 'busy');
		await createWorktreeAt(git, main, worktree, 'busy');

		// A process whose working directory is the worktree, as a shell's is: on Windows git then deletes
		// the files and its record, and fails on the directory with "Permission denied".
		const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { cwd: worktree });
		const exited = new Promise(resolve => holder.on('exit', resolve));

		const result = await deleteWorktreeAt(git, main, worktree, 'remove');
		await exited;

		assert.deepStrictEqual({ result, folder: existsSync(worktree), listed: run(main, 'worktree', 'list').includes('busy') }, {
			result: { kind: 'removed' },
			folder: false,
			listed: false,
		});
	});

	test('a directory git let go of but could not delete is deleted - also when it is named through a link', async () => {
		// What git does on Windows while a shell being killed still has the directory open: it deletes
		// the files and the record, then fails on the directory itself (WORKTREE.md WT-4.5).
		const letGo = (worktree: string): IWorktreeGit => ({
			exec: async (cwd, args, options) => {
				const answer = await git.exec(cwd, args, options);
				if (args[0] === 'worktree' && args[1] === 'remove') {
					write(path.join(worktree, 'left.txt'), 'left\n');
					throw Object.assign(new Error('failed'), { stderr: `error: failed to delete '${worktree}': Permission denied` });
				}
				return answer;
			}
		});
		const direct = path.join(dir, 'worktrees', 'direct');
		await createWorktreeAt(git, main, direct, 'direct');
		const linked = path.join(dir, 'worktrees', 'linked');
		await createWorktreeAt(git, main, linked, 'linked');
		// The same worktree through a junction to its folder, which git lists by its real path.
		const link = path.join(dir, 'link');
		symlinkSync(path.join(dir, 'worktrees'), link, 'junction');
		const throughLink = path.join(link, 'linked');

		const results = [await deleteWorktreeAt(letGo(direct), main, direct, 'remove'), await deleteWorktreeAt(letGo(throughLink), main, throughLink, 'remove')];

		assert.deepStrictEqual({ results, direct: existsSync(direct), linked: existsSync(linked), listed: run(main, 'worktree', 'list').split('\n').length }, {
			results: [{ kind: 'removed' }, { kind: 'removed' }],
			direct: false,
			linked: false,
			listed: 1,
		});
	});

	test('a remove git fails with the worktree still on its list deletes nothing of it', async () => {
		const worktree = path.join(dir, 'worktrees', 'held');
		await createWorktreeAt(git, main, worktree, 'held');
		// Git refusing before it has done anything - a lock of its own, say.
		const refusing: IWorktreeGit = {
			exec: (cwd, args, options) => args[0] === 'worktree' && args[1] === 'remove'
				? Promise.reject(Object.assign(new Error('failed'), { stderr: 'fatal: cannot remove a locked working tree', exitCode: 128 }))
				: git.exec(cwd, args, options)
		};

		const result = await deleteWorktreeAt(refusing, main, worktree, 'force');

		assert.deepStrictEqual({ result: result.kind, folder: existsSync(path.join(worktree, 'tracked.txt')), listed: run(main, 'worktree', 'list').includes('held') }, {
			result: 'error',
			folder: true,
			listed: true,
		});
	});

	test('a folder git never listed as a worktree, or the main checkout, is refused and left alone', async () => {
		const plain = path.join(dir, 'plain');
		write(path.join(plain, 'keep.txt'), 'keep\n');

		const results = [await deleteWorktreeAt(git, main, plain, 'force'), await deleteWorktreeAt(git, main, main, 'force')];

		assert.deepStrictEqual({
			results: results.map(result => result.kind),
			plain: existsSync(path.join(plain, 'keep.txt')),
			main: existsSync(path.join(main, 'tracked.txt')),
		}, {
			results: ['error', 'error'],
			plain: true,
			main: true,
		});
	});

	suite('a folder with nothing to start a worktree from', () => {

		// The first commit is made in the person's name, which a machine running tests may not have:
		// handed to git as each command runs, rather than written into this process's environment.
		const identity = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' };
		const named: IWorktreeGit = { exec: (cwd, args, options) => git.exec(cwd, args, { ...options, env: { ...identity, ...options?.env } }) };

		test('WTA-16 no repository: counted without being touched, then its files are the first commit, and a worktree can be made', async () => {
			const folder = path.join(dir, 'plain');
			write(path.join(folder, '.gitignore'), 'node_modules/\n.env\n');
			write(path.join(folder, 'index.js'), 'index\n');
			write(path.join(folder, 'src', 'a.js'), 'a\n');
			write(path.join(folder, '.env'), 'SECRET=1\n');
			write(path.join(folder, 'node_modules', 'dep', 'index.js'), 'dep\n');

			const inspected = await prepareWorktreeBaseAt(named, folder, 'inspect');
			const touched = existsSync(path.join(folder, '.git'));
			const initialized = await prepareWorktreeBaseAt(named, folder, 'initialize', 'a');
			const committed = run(folder, 'ls-files').split('\n').sort();
			const created = await createWorktreeAt(named, folder, path.join(dir, 'worktrees', 'plain-a'), 'a');

			assert.deepStrictEqual({ inspected, touched, initialized, committed, created: created.kind, again: await prepareWorktreeBaseAt(named, folder, 'inspect') }, {
				inspected: { kind: 'uninitialized', files: 3, identity: true, enclosing: undefined },
				touched: false,
				initialized: { kind: 'ready' },
				committed: ['.gitignore', 'index.js', 'src/a.js'],
				created: 'created',
				again: { kind: 'ready' },
			});
		});

		test('WTA-16 a repository with no commit is unborn until its files are committed; one with a commit is ready', async () => {
			const folder = path.join(dir, 'unborn');
			write(path.join(folder, 'readme.md'), 'readme\n');
			run(folder, 'init', '-q', '-b', 'main');

			const inspected = await prepareWorktreeBaseAt(named, folder, 'inspect');
			const initialized = await prepareWorktreeBaseAt(named, folder, 'initialize', 'a');

			assert.deepStrictEqual({ inspected, initialized, log: run(folder, 'log', '--format=%s'), main: await prepareWorktreeBaseAt(named, main, 'inspect') }, {
				inspected: { kind: 'unborn', files: 1, identity: true },
				initialized: { kind: 'ready' },
				log: 'Initial commit',
				main: { kind: 'ready' },
			});
		});

		test('WTA-16 a repository with history whose HEAD is on a branch without commits is refused, not given a first commit', async () => {
			run(main, 'checkout', '-q', '--orphan', 'pages');

			const inspected = await prepareWorktreeBaseAt(named, main, 'inspect');
			const initialized = await prepareWorktreeBaseAt(named, main, 'initialize', 'a');

			assert.deepStrictEqual({
				inspected: inspected.kind === 'error' ? inspected.code : inspected,
				initialized: initialized.kind === 'error' ? initialized.code : initialized,
				commitsOnPages: run(main, 'rev-list', '--all', '--count'),
			}, {
				inspected: 'UnbornBranch',
				initialized: 'UnbornBranch',
				commitsOnPages: '1',
			});
		});

		test('WTA-16 without a name and email to commit with, it is said while nothing has changed yet', async () => {
			// Git with no identity to give: `git var` fails as it does on a machine with none configured.
			const nameless: IWorktreeGit = { exec: (cwd, args, options) => args[0] === 'var' ? Promise.reject(new Error('unable to auto-detect email address')) : named.exec(cwd, args, options) };
			const folder = path.join(dir, 'nameless');
			write(path.join(folder, 'index.js'), 'index\n');

			const inspected = await prepareWorktreeBaseAt(nameless, folder, 'inspect');
			const initialized = await prepareWorktreeBaseAt(nameless, folder, 'initialize', 'a');

			assert.deepStrictEqual({ inspected, initialized: initialized.kind === 'error' ? initialized.code : initialized, touched: existsSync(path.join(folder, '.git')) }, {
				inspected: { kind: 'uninitialized', files: 1, identity: false, enclosing: undefined },
				initialized: 'NoIdentity',
				touched: false,
			});
		});

		test('WTA-16 a name and email that an includeIf gives only once there is a repository do not stop it, and the first commit is theirs', async () => {
			const folder = path.join(dir, 'conditional');
			write(path.join(folder, 'index.js'), 'index\n');
			const identity = path.join(dir, 'identity.gitconfig');
			write(identity, '[user]\n\tname = conditional\n\temail = conditional@test\n');
			// This machine's configuration: who commits depends on where the repository is, and is never guessed.
			const global = path.join(dir, 'global.gitconfig');
			write(global, `[user]\n\tuseConfigOnly = true\n[includeIf "gitdir:${folder.replace(/\\/g, '/')}/"]\n\tpath = ${identity.replace(/\\/g, '/')}\n`);
			const conditional: IWorktreeGit = { exec: (cwd, args, options) => git.exec(cwd, args, { ...options, env: { GIT_CONFIG_GLOBAL: global, ...options?.env } }) };

			const inspected = await prepareWorktreeBaseAt(conditional, folder, 'inspect');
			const initialized = await prepareWorktreeBaseAt(conditional, folder, 'initialize', 'a');

			assert.deepStrictEqual({ inspected, initialized, author: run(folder, 'log', '--format=%an') }, {
				inspected: { kind: 'uninitialized', files: 1, identity: undefined, enclosing: undefined },
				initialized: { kind: 'ready' },
				author: 'conditional',
			});
		});

		test('WTA-16 a branch git would refuse, or the one the first commit goes on, is said before anything changes', async () => {
			// `main` straight after `git init -b main` made it: the worktree's `-b` would find it taken.
			const initial: IWorktreeGit = { exec: (cwd, args, options) => named.exec(cwd, args[0] === 'init' ? [...args, '-b', 'main'] : args, options) };
			const folder = path.join(dir, 'names');
			write(path.join(folder, 'index.js'), 'index\n');

			const refused = [await prepareWorktreeBaseAt(initial, folder, 'initialize', 'my feature'), await prepareWorktreeBaseAt(initial, folder, 'initialize', 'main')];

			assert.deepStrictEqual({ refused: refused.map(result => result.kind === 'error' ? result.code : result.kind), touched: existsSync(path.join(folder, '.git')) }, {
				refused: ['InvalidBranchName', 'InitialBranch'],
				touched: false,
			});
		});

		test('WTA-16 a commit that fails takes the new repository with it; one that was there keeps what it had', async () => {
			// A hook that refuses, a key that is not there: the commit fails after `init` and `add`.
			const refusing: IWorktreeGit = { exec: (cwd, args, options) => args[0] === 'commit' ? Promise.reject(Object.assign(new Error('hook refused'), { stderr: 'error: hook refused' })) : named.exec(cwd, args, options) };
			const fresh = path.join(dir, 'fresh');
			const unborn = path.join(dir, 'kept');
			write(path.join(fresh, 'index.js'), 'index\n');
			write(path.join(unborn, 'index.js'), 'index\n');
			run(unborn, 'init', '-q');

			const results = [await prepareWorktreeBaseAt(refusing, fresh, 'initialize', 'a'), await prepareWorktreeBaseAt(refusing, unborn, 'initialize', 'a')];

			assert.deepStrictEqual({ results, fresh: existsSync(path.join(fresh, '.git')), kept: existsSync(path.join(unborn, '.git')) }, {
				results: [{ kind: 'error', code: undefined, message: 'hook refused' }, { kind: 'error', code: undefined, message: 'hook refused' }],
				fresh: false,
				kept: true,
			});
		});

		test('WTA-16 inside another repository: said to be, and counted without being touched; a .git git cannot read is refused', async () => {
			const nested = path.join(main, 'packages', 'app');
			write(path.join(nested, 'index.js'), 'index\n');
			const broken = path.join(main, 'packages', 'broken');
			mkdirSync(path.join(broken, '.git'), { recursive: true });
			// A repository git will not open, as it answers for one somebody else owns.
			const doubted: IWorktreeGit = {
				exec: (cwd, args, options) => cwd === main && args[0] === 'rev-parse'
					? Promise.reject(Object.assign(new Error('dubious'), { gitErrorCode: 'NotASafeGitRepository', stderr: `fatal: detected dubious ownership in repository at '${main}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${main}` }))
					: named.exec(cwd, args, options)
			};

			const inspected = await prepareWorktreeBaseAt(named, nested, 'inspect');
			const refused = await prepareWorktreeBaseAt(named, broken, 'inspect');
			const owned = await prepareWorktreeBaseAt(doubted, main, 'inspect');

			assert.deepStrictEqual({
				inspected: inspected.kind === 'uninitialized' ? {
					files: inspected.files,
					enclosing: !!inspected.enclosing && path.resolve(inspected.enclosing).toLowerCase() === path.resolve(main).toLowerCase(),
					// Spelled the OS's way, where git writes `/` on Windows too.
					normalized: inspected.enclosing === path.normalize(inspected.enclosing ?? '')
				} : inspected,
				refused: refused.kind === 'error' ? refused.code : refused,
				owned,
				touched: existsSync(path.join(nested, '.git')),
			}, {
				inspected: { files: 1, enclosing: true, normalized: true },
				refused: 'UnreadableGitDirectory',
				owned: { kind: 'error', code: 'NotASafeGitRepository', message: `detected dubious ownership in repository at '${main}'` },
				touched: false,
			});
		});
	});

	test('a path that is not absolute, a folder that is not a file URI, or a mode that is not one, is refused before git is asked anything', async () => {
		const asked: string[][] = [];
		const watching: IWorktreeGit = { exec: (cwd, args, options) => { asked.push(args); return git.exec(cwd, args, options); } };

		const results = [
			await deleteWorktreeAt(watching, main, 'feat', 'remove'),
			await createWorktreeAt(watching, 'main', path.join(dir, 'worktrees', 'x'), 'x'),
			// Rooted, but on whichever drive is current: not absolute on Windows, and not at all elsewhere.
			await createWorktreeAt(watching, main, '\\worktrees\\x', 'x'),
			await prepareWorktreeBaseAt(watching, main, 'nuke' as 'inspect'),
			await prepareWorktreeBaseAt(watching, folderPath({ scheme: 'vscode-remote', fsPath: main }), 'inspect'),
			await prepareWorktreeBaseAt(watching, folderPath(undefined), 'inspect'),
		];

		assert.deepStrictEqual({ codes: results.map(result => result.kind === 'error' ? result.code : result.kind), asked, file: folderPath({ scheme: 'file', fsPath: main }) }, {
			codes: ['InvalidArgument', 'InvalidArgument', 'InvalidArgument', 'InvalidArgument', 'InvalidArgument', 'InvalidArgument'],
			asked: [],
			file: main,
		});
	});

	test('a worktree whose folder was deleted by hand has nothing to lose, and is forgotten - it alone, and without force', async () => {
		const worktree = path.join(dir, 'worktrees', 'gone');
		const unmounted = path.join(dir, 'worktrees', 'unmounted');
		await createWorktreeAt(git, main, worktree, 'gone');
		await createWorktreeAt(git, main, unmounted, 'unmounted');
		rmSync(worktree, { recursive: true, force: true });
		// Another one missing just now - on a drive that is not mounted, say - which is not being deleted.
		rmSync(unmounted, { recursive: true, force: true });
		// What git is asked to remove with: git checks a folder it can see for changes unless forced.
		const removes: string[][] = [];
		const recording: IWorktreeGit = {
			exec: (cwd, args, options) => {
				if (args[0] === 'worktree' && args[1] === 'remove') {
					removes.push(args.filter(arg => arg !== worktree));
				}
				return git.exec(cwd, args, options);
			}
		};

		const check = await deleteWorktreeAt(git, main, worktree, 'check');
		const remove = await deleteWorktreeAt(recording, main, worktree, 'remove');
		const listed = run(main, 'worktree', 'list');

		assert.deepStrictEqual({ check, remove, removes, gone: listed.includes('gone'), unmounted: listed.includes('unmounted') }, {
			check: { kind: 'checked', files: [], submodules: false },
			remove: { kind: 'removed' },
			removes: [['worktree', 'remove', '--']],
			gone: false,
			unmounted: true,
		});
	});

	test('a worktree with a submodule checked out is said to have one, which git removes only by force', async () => {
		const library = path.join(dir, 'library');
		write(path.join(library, 'lib.txt'), 'lib\n');
		run(library, 'init', '-q', '-b', 'main');
		run(library, 'add', '.');
		run(library, '-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-q', '-m', 'lib');
		// A local path is a `file` URL, which git clones a submodule from only when told it may.
		run(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'libs/library');
		run(main, '-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-q', '-m', 'library');
		const worktree = path.join(dir, 'worktrees', 'modules');
		await createWorktreeAt(git, main, worktree, 'modules');

		const declared = await deleteWorktreeAt(git, main, worktree, 'check');
		run(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
		const checkedOut = await deleteWorktreeAt(git, main, worktree, 'check');
		const remove = await deleteWorktreeAt(git, main, worktree, 'remove');
		const force = await deleteWorktreeAt(git, main, worktree, 'force');

		assert.deepStrictEqual({ declared, checkedOut, remove: remove.kind, force, folder: existsSync(worktree) }, {
			declared: { kind: 'checked', files: [], submodules: false },
			checkedOut: { kind: 'checked', files: [], submodules: true },
			remove: 'error',
			force: { kind: 'removed' },
			folder: false,
		});
	});
});
