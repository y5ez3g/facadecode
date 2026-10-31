/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { checkoutOf, gitExecutableOf, GitError, hasBranch, parseWorktreeList, resolveCommit, whyNotBranchName, worktreesOf } from '../host/locations/gitRead';
import { tempDir } from './util';

/** Git for the fixtures alone: committer identity on the command line, never in a configuration file. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

suite('Git reads: discovery in disposable repositories (WORKTREES-1.1, 1.2, 4.2; VERIFICATION J01, J03)', () => {

	let temp: { dir: string; remove(): void };
	let repo: string;

	setup(() => {
		temp = tempDir('fd-gitread-');
		repo = path.join(temp.dir, 'repo');
		fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
		git(temp.dir, 'init', '-q', '-b', 'main', repo);
		git(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
	});

	teardown(() => {
		temp.remove();
	});

	test('no Git at all is told apart as missing, and a Git that fails otherwise keeps its own diagnostic - never "no repository"', async () => {
		const missing = path.join(temp.dir, 'no-such-git');
		await assert.rejects(checkoutOf(missing, repo), (err: unknown) => err instanceof GitError && err.missing);
		await assert.rejects(worktreesOf(missing, path.join(repo, '.git')), (err: unknown) => err instanceof GitError && err.missing);
		// A script stands in for Git only where the system runs one by itself: Windows runs no `#!` script, and no `.cmd` without a shell
		if (process.platform !== 'win32') {
			const failing = path.join(temp.dir, 'failing-git');
			fs.writeFileSync(failing, '#!/bin/sh\necho "fatal: detected dubious ownership in repository" >&2\nexit 128\n', { mode: 0o755 });
			await assert.rejects(checkoutOf(failing, repo), (err: unknown) => err instanceof GitError && !err.missing && err.exitCode === 128 && /dubious ownership/.test(err.message));
		}
	});

	test('a folder in no repository is in no checkout; so are a Git directory and a bare repository, which have no work tree', async () => {
		const plain = path.join(temp.dir, 'plain');
		fs.mkdirSync(plain);
		git(temp.dir, 'clone', '-q', '--bare', repo, 'bare.git');

		assert.strictEqual(await checkoutOf('git', plain), undefined);
		assert.strictEqual(await checkoutOf('git', path.join(repo, '.git')), undefined);
		assert.strictEqual(await checkoutOf('git', path.join(temp.dir, 'bare.git')), undefined);
	});

	test('a checkout\'s root is written as the folder was opened - through a link too - with the shared Git directory of its repository', async () => {
		const link = path.join(temp.dir, 'link');
		// A junction on Windows, which needs no administrator; a link elsewhere
		fs.symlinkSync(repo, link, 'junction');
		git(repo, 'worktree', 'add', '-q', '-b', 'feat', path.join(temp.dir, 'repo.worktrees', 'feat'));

		assert.deepStrictEqual(await checkoutOf('git', path.join(link, 'packages', 'app')), { root: link, gitDir: path.join(repo, '.git'), commonDir: path.join(repo, '.git') });
		assert.deepStrictEqual(await checkoutOf('git', path.join(temp.dir, 'repo.worktrees', 'feat')), {
			root: path.join(temp.dir, 'repo.worktrees', 'feat'), gitDir: path.join(repo, '.git', 'worktrees', 'feat'), commonDir: path.join(repo, '.git')
		});
	});

	test('a repository lists every registered worktree, main first: branches, detached HEADs, locked ones, and prunable ones whose directory is gone', async () => {
		const worktrees = path.join(temp.dir, 'repo.worktrees');
		git(repo, 'worktree', 'add', '-q', '-b', 'feat', path.join(worktrees, 'feat'));
		git(repo, 'worktree', 'add', '-q', '--detach', path.join(worktrees, 'loose'));
		git(repo, 'worktree', 'add', '-q', '-b', 'kept', path.join(worktrees, 'kept'));
		git(repo, 'worktree', 'lock', path.join(worktrees, 'kept'));
		git(repo, 'worktree', 'add', '-q', '-b', 'gone', path.join(worktrees, 'gone'));
		fs.rmSync(path.join(worktrees, 'gone'), { recursive: true, force: true });

		const listed = await worktreesOf('git', path.join(repo, '.git'));

		assert.deepStrictEqual(listed.map(each => [path.relative(temp.dir, each.path), each.main, each.branch, each.detached, each.locked, each.prunable]), [
			['repo', true, 'main', false, false, false],
			[path.join('repo.worktrees', 'feat'), false, 'feat', false, false, false],
			[path.join('repo.worktrees', 'gone'), false, 'gone', false, false, true],
			[path.join('repo.worktrees', 'kept'), false, 'kept', false, true, false],
			[path.join('repo.worktrees', 'loose'), false, undefined, true, false, false]
		]);
		assert.ok(listed.every(each => /^[0-9a-f]{40}$/.test(each.head ?? '')));
	});

	test('the list is read in the shared Git directory - a bare repository\'s too, whose own entry has no checkout - and any character in a path survives', async () => {
		// Windows allows no line break in a file name
		const odd = path.join(temp.dir, process.platform === 'win32' ? '中文 wt' : '中文 wt\nline');
		git(repo, 'worktree', 'add', '-q', '-b', 'feat/中文', odd);
		git(temp.dir, 'clone', '-q', '--bare', repo, 'bare.git');
		git(path.join(temp.dir, 'bare.git'), 'worktree', 'add', '-q', path.join(temp.dir, 'from-bare'), 'main');

		assert.deepStrictEqual((await worktreesOf('git', path.join(repo, '.git'))).map(each => [each.path, each.branch]), [[repo, 'main'], [odd, 'feat/中文']]);
		assert.deepStrictEqual((await worktreesOf('git', path.join(temp.dir, 'bare.git'))).map(each => [path.basename(each.path), each.bare, each.main]), [['bare.git', true, true], ['from-bare', false, false]]);
	});

	test('the porcelain list parses alike by NUL and by lines, as a Git before 2.36 writes it', () => {
		const lines = 'worktree /r\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree /r.worktrees/x\nHEAD 2222222222222222222222222222222222222222\ndetached\nprunable gitdir file points to non-existent location\n\n';
		const nul = lines.replace(/\n/g, '\0');

		assert.deepStrictEqual(parseWorktreeList(nul, true), parseWorktreeList(lines, false));
		assert.deepStrictEqual(parseWorktreeList(lines, false).map(each => [each.path, each.main, each.branch, each.detached, each.prunable]), [
			[path.normalize('/r'), true, 'main', false, false],
			[path.normalize('/r.worktrees/x'), false, undefined, true, true]
		]);
	});

	test('reads ignore a GIT_DIR or GIT_WORK_TREE the editor was started with: -C decides the repository', async () => {
		const other = path.join(temp.dir, 'other');
		git(temp.dir, 'init', '-q', '-b', 'main', other);
		const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
		process.env.GIT_DIR = path.join(other, '.git');
		process.env.GIT_WORK_TREE = other;
		try {
			assert.strictEqual((await checkoutOf('git', repo))?.commonDir, path.join(repo, '.git'));
		} finally {
			for (const [name, value] of [['GIT_DIR', saved.dir], ['GIT_WORK_TREE', saved.tree]] as const) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
		}
	});

	test('a base ref resolves at the selected checkout, a ref beginning with "-" is never an option, and branch names are Git\'s to judge', async () => {
		const head = git(repo, 'rev-parse', 'HEAD').trim();
		git(repo, 'branch', 'team/a');

		assert.deepStrictEqual([await resolveCommit('git', repo, 'HEAD'), await resolveCommit('git', repo, '-x'), await resolveCommit('git', repo, 'no-such-ref')], [head, undefined, undefined]);
		assert.deepStrictEqual([await hasBranch('git', repo, 'team/a'), await hasBranch('git', repo, 'team/b')], [true, false]);
		assert.strictEqual(await whyNotBranchName('git', repo, 'team/b'), undefined);
		assert.deepStrictEqual(await whyNotBranchName('git', repo, 'a..b'), { kind: 'branch_rejected', branch: 'a..b' });
		assert.deepStrictEqual(await whyNotBranchName('git', repo, '-x'), { kind: 'branch_rejected', branch: '-x' });
		assert.deepStrictEqual(await whyNotBranchName('git', repo, 'team'), { kind: 'branch_prefix_clash', clash: 'team/a' });
	});

	test('the Git to run is the first git.path entry that is a file, else git on the PATH (UX-4.2)', async () => {
		const configured = path.join(temp.dir, 'my-git');
		fs.writeFileSync(configured, '', { mode: 0o755 });

		assert.strictEqual(await gitExecutableOf(configured), configured);
		assert.strictEqual(await gitExecutableOf([path.join(temp.dir, 'none'), configured]), configured);
		// An entry that is no file falls back as the editor's Git integration does; this machine's PATH Git is a real one
		assert.strictEqual(await gitExecutableOf(path.join(temp.dir, 'none')), 'git');
		assert.strictEqual(await gitExecutableOf(null), 'git');
	});
});
