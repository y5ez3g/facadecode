/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { execFile, execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWorktreeAt, deleteWorktreeAt, isWorktreeIncluded, IWorktreeGit, parseWorktreeInclude } from '../worktreeAt';

/** Real git, the way the command centre's `Git.exec` runs it: an argument array, never a shell. */
const git: IWorktreeGit = {
	exec: (cwd, args, options) => new Promise((resolve, reject) => {
		execFile('git', args, { cwd, env: { ...process.env, ...options?.env } }, (error, stdout, stderr) => {
			if (error) {
				reject(Object.assign(new Error(stderr || error.message), { stderr }));
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
		return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
	}

	function write(file: string, content: string): void {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	}

	setup(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), 'worktreeAt-'));
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

	test('.worktreeinclude is read the way gitignore reads a pattern file', () => {
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

	test('creates the worktree on a new branch and copies what is both ignored and included', async () => {
		write(path.join(main, '.worktreeinclude'), '.env\n*.local.json\nsecrets/\n');
		const worktree = path.join(dir, 'worktrees', 'main', 'feat-a');

		const result = await createWorktreeAt(git, main, worktree, 'feat/a');

		assert.deepStrictEqual({
			result,
			branch: run(worktree, 'branch', '--show-current'),
			files: Object.fromEntries(['.env', 'app.local.json', 'secrets/key.txt', 'apps/web/.env', 'node_modules/dep/index.js', 'scratch.txt', 'tracked.txt']
				.map(file => [file, existsSync(path.join(worktree, file))]))
		}, {
			result: { kind: 'created', path: worktree, copyFailures: [] },
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

	test('a branch that already exists is answered as an error, not thrown', async () => {
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
			check: check.kind === 'dirty' ? [...check.files].sort() : check,
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
		// the files and its record and fails on the directory with "Permission denied" (found live).
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

	test('a worktree whose folder was deleted by hand has nothing to lose, and is pruned', async () => {
		const worktree = path.join(dir, 'worktrees', 'gone');
		await createWorktreeAt(git, main, worktree, 'gone');
		rmSync(worktree, { recursive: true, force: true });

		const check = await deleteWorktreeAt(git, main, worktree, 'check');
		const remove = await deleteWorktreeAt(git, main, worktree, 'remove');

		assert.deepStrictEqual({ check, remove, listed: run(main, 'worktree', 'list').includes('gone') }, {
			check: { kind: 'dirty', files: [] },
			remove: { kind: 'removed' },
			listed: false,
		});
	});
});
