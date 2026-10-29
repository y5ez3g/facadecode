/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';

interface IMenuItem {
	readonly command?: string;
	readonly when?: string;
}

suite('worktree menus', () => {

	test('WTA-30 git\'s own Create Worktree and Delete Worktree give way to the workspace bar\'s while its worktrees are on, and come back when they are off', () => {
		// The extension's own manifest, from `out/test` up to the extension's folder.
		const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
		const menus = manifest.contributes.menus as Record<string, IMenuItem[]>;
		const worktreeCommands = new Set(['git.createWorktree', 'git.deleteWorktree', 'git.deleteWorktree2', 'git.repositories.createWorktree', 'git.repositories.deleteWorktree']);

		const shown = Object.entries(menus).flatMap(([menu, items]) => items
			.filter(item => item.command && worktreeCommands.has(item.command) && item.when !== 'false')
			.map(item => ({ menu, command: item.command, givesWay: !!item.when?.includes('!config.facade.workspaceBar.worktrees') })));

		assert.deepStrictEqual(shown, [
			{ menu: 'commandPalette', command: 'git.createWorktree', givesWay: true },
			{ menu: 'commandPalette', command: 'git.deleteWorktree', givesWay: true },
			{ menu: 'scm/sourceControl', command: 'git.deleteWorktree2', givesWay: true },
			{ menu: 'scm/artifactGroup/context', command: 'git.repositories.createWorktree', givesWay: true },
			{ menu: 'scm/artifact/context', command: 'git.repositories.deleteWorktree', givesWay: true },
			{ menu: 'git.worktrees', command: 'git.createWorktree', givesWay: true },
			{ menu: 'git.worktrees', command: 'git.deleteWorktree2', givesWay: true }
		]);
	});
});
