/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { freeWorktreeUri, readSetupCommands, worktreeFolderName } from '../../browser/worktrees.js';

suite('Worktrees - names, paths and setup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a branch becomes one folder name on every OS, and a device name none', () => {
		const branches = ['feat/x', 'fix\\y', 'a:b*c?d', '  w2  ', '', 'con', 'NUL.txt', 'lpt10', 'com1'];

		assert.deepStrictEqual(Object.fromEntries(branches.map(branch => [branch, worktreeFolderName(branch)])), {
			'feat/x': 'feat-x',
			'fix\\y': 'fix-y',
			'a:b*c?d': 'a-b-c-d',
			'  w2  ': 'w2',
			'': undefined,
			'con': undefined,
			'NUL.txt': undefined,
			'lpt10': 'lpt10',
			'com1': undefined,
		});
	});

	test('a taken path gets -1, -2 and so on', async () => {
		const parent = URI.file('/home/me/.facade/worktrees/lab');
		const taken = new Set(['/home/me/.facade/worktrees/lab/w2', '/home/me/.facade/worktrees/lab/w2-1']);
		const exists = async (uri: URI) => taken.has(uri.path);

		assert.deepStrictEqual([
			(await freeWorktreeUri(parent, 'w2', exists)).path,
			(await freeWorktreeUri(parent, 'w3', exists)).path,
		], [
			'/home/me/.facade/worktrees/lab/w2-2',
			'/home/me/.facade/worktrees/lab/w3',
		]);
	});

	test('setup reads the OS\'s own key first, then the shared one, in Cursor\'s format', () => {
		const both = '{ "setup-worktree": ["npm ci"], "setup-worktree-windows": ["npm.cmd ci", ".\\\\setup.ps1"] }';
		const shared = '{ // comments are allowed\n "setup-worktree": ["uv sync"], }';

		assert.deepStrictEqual({
			windows: readSetupCommands(both, true),
			unix: readSetupCommands(both, false),
			shared: readSetupCommands(shared, true),
			nothing: readSetupCommands('{ "other": 1 }', false),
			notAList: readSetupCommands('{ "setup-worktree": "npm ci" }', false),
			notStrings: readSetupCommands('{ "setup-worktree": [1, 2] }', false),
			notJson: readSetupCommands('setup-worktree: npm ci', false),
		}, {
			windows: { kind: 'lines', lines: ['npm.cmd ci', '.\\setup.ps1'] },
			unix: { kind: 'lines', lines: ['npm ci'] },
			shared: { kind: 'lines', lines: ['uv sync'] },
			nothing: { kind: 'none' },
			notAList: { kind: 'invalid' },
			notStrings: { kind: 'invalid' },
			notJson: { kind: 'invalid' },
		});
	});
});
