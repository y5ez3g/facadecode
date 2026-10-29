/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { suite, test } from 'node:test';
import { getVersion } from '../git.ts';

suite('git', () => {
	test('getVersion reads the commit of a checkout and of a worktree of git\'s, whose .git is a file, with their branches loose and packed', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-version-'));
		// Away from the person's own git configuration: no signing, no hooks
		const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
		const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
		try {
			const main = path.join(root, 'main');
			const worktree = path.join(root, 'worktree');
			fs.mkdirSync(main);
			git(main, 'init', '-q', '-b', 'main');
			git(main, 'commit', '-q', '--allow-empty', '-m', 'first');
			git(main, 'worktree', 'add', '-q', '-b', 'topic', worktree);
			git(worktree, 'commit', '-q', '--allow-empty', '-m', 'second');

			const mainIde = path.join(main, 'ide');
			const worktreeIde = path.join(worktree, 'ide');
			fs.mkdirSync(mainIde);
			fs.mkdirSync(worktreeIde);
			const loose = { main: getVersion(main), worktree: getVersion(worktree), mainIde: getVersion(mainIde), worktreeIde: getVersion(worktreeIde) };
			git(main, 'pack-refs', '--all');
			const packed = { main: getVersion(main), worktree: getVersion(worktree), mainIde: getVersion(mainIde), worktreeIde: getVersion(worktreeIde) };

			const heads = { main: git(main, 'rev-parse', 'HEAD'), worktree: git(worktree, 'rev-parse', 'HEAD'), mainIde: git(mainIde, 'rev-parse', 'HEAD'), worktreeIde: git(worktreeIde, 'rev-parse', 'HEAD') };
			assert.deepStrictEqual({ loose, packed }, { loose: heads, packed: heads });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
