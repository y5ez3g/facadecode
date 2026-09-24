/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { foldersToRemove } from '../../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';

suite('Workspace bar - removing a folder', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const isEqual = (a: URI, b: URI) => a.toString() === b.toString();
	const member = (path: string) => new WorkspaceFolder({ uri: URI.file(path), index: 0, name: path });

	const repository: IWorkspaceBarRepository = {
		kind: 'repository',
		main: URI.file('/lab'),
		folder: member('/lab'),
		branch: 'main',
		commonDir: URI.file('/lab/.git'),
		worktrees: [
			{ uri: URI.file('/wt/w2'), branch: 'w2', label: 'w2', exists: true, folder: member('/wt/w2') },
			{ uri: URI.file('/wt/w10'), branch: 'w10', label: 'w10', exists: true, folder: undefined },
		]
	};

	test('a repository takes the worktrees that are in the workspace with it; anything else goes alone', () => {
		assert.deepStrictEqual({
			'repository row': foldersToRemove(URI.file('/lab'), repository, isEqual).map(uri => uri.path),
			'plain folder': foldersToRemove(URI.file('/notes'), undefined, isEqual).map(uri => uri.path),
			'a worktree itself': foldersToRemove(URI.file('/wt/w2'), repository, isEqual).map(uri => uri.path),
		}, {
			'repository row': ['/lab', '/wt/w2'],
			'plain folder': ['/notes'],
			'a worktree itself': ['/wt/w2'],
		});
	});
});
