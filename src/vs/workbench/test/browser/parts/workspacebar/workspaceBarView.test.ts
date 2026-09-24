/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IObjectTreeElement } from '../../../../../base/browser/ui/tree/tree.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarWorktree, WorkspaceBarGroup } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { carriesMark, workspaceBarRows, WorkspaceBarRow } from '../../../../browser/parts/workspacebar/workspaceBarView.js';

suite('Workspace bar - the rows it draws', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const key = (uri: URI) => uri.toString();

	function folder(path: string, index = 0): IWorkspaceFolder {
		return new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(path.lastIndexOf('/') + 1) });
	}

	function worktree(path: string, label: string, member?: IWorkspaceFolder): IWorkspaceBarWorktree {
		return { uri: URI.file(path), branch: label, label, exists: true, folder: member };
	}

	/** One line per row, a worktree indented under its repository. */
	function summary(rows: IObjectTreeElement<WorkspaceBarRow>[]): string[] {
		return rows.flatMap(row => {
			const element = row.element;
			const line = element.kind === 'folder'
				? `${element.repository ? 'repository' : 'folder'} ${element.uri.path}${element.folder ? '' : ' (not in the workspace)'}`
				: `  worktree ${element.worktree.label}`;
			const children = [...(row.children ?? [])] as IObjectTreeElement<WorkspaceBarRow>[];
			return [line, ...children.map(child => child.element.kind === 'worktree' ? `  worktree ${child.element.worktree.label}` : '?')];
		});
	}

	const notes = folder('/notes');
	const lab = folder('/lab', 1);
	const w2 = folder('/wt/w2', 2);
	const groups: WorkspaceBarGroup[] = [
		{ kind: 'folder', folder: notes },
		{ kind: 'repository', main: URI.file('/lab'), folder: lab, commonDir: URI.file('/lab/.git'), worktrees: [worktree('/wt/w2', 'w2', w2), worktree('/wt/w10', 'w10')] },
		{ kind: 'repository', main: URI.file('/api'), folder: undefined, commonDir: URI.file('/api/.git'), worktrees: [worktree('/wt/fix', 'fix', folder('/wt/fix', 3))] },
	];

	test('a repository opens onto its worktrees; a plain folder has none', () => {
		const rows = workspaceBarRows({ folders: [notes, lab, w2], groups, worktrees: true, collapsed: false });

		assert.deepStrictEqual(summary(rows), [
			'folder /notes',
			'repository /lab',
			'  worktree w2',
			'  worktree w10',
			'repository /api (not in the workspace)',
			'  worktree fix',
		]);
	});

	test('collapsed to its icons, the bar shows folder rows only', () => {
		const rows = workspaceBarRows({ folders: [notes, lab, w2], groups, worktrees: true, collapsed: true });

		assert.deepStrictEqual(summary(rows), [
			'folder /notes',
			'repository /lab',
			'repository /api (not in the workspace)',
		]);
	});

	test('switched off, or before git has been read, the bar is folders[] exactly', () => {
		const rows = workspaceBarRows({ folders: [notes, lab, w2], groups, worktrees: false, collapsed: false });

		assert.deepStrictEqual(summary(rows), [
			'folder /notes',
			'folder /lab',
			'folder /wt/w2',
		]);
	});

	test('the mark: a row\'s own folder, and a repository standing in for a worktree that cannot be seen', () => {
		const [, repository, worktreeRow] = workspaceBarRows({ folders: [notes, lab, w2], groups, worktrees: true, collapsed: false })
			.flatMap(row => [row, ...([...(row.children ?? [])] as IObjectTreeElement<WorkspaceBarRow>[])])
			.map(row => row.element);

		const onW2 = URI.file('/wt/w2');
		assert.deepStrictEqual({
			'worktree row, window on it': carriesMark(worktreeRow, onW2, false, key),
			'repository row, its worktree visible': carriesMark(repository, onW2, false, key),
			'repository row, its worktree hidden': carriesMark(repository, onW2, true, key),
			'repository row, window on the repository': carriesMark(repository, URI.file('/lab'), false, key),
			'repository row, window elsewhere, hidden': carriesMark(repository, URI.file('/notes'), true, key),
			'no folder at all': carriesMark(repository, undefined, true, key),
		}, {
			'worktree row, window on it': true,
			'repository row, its worktree visible': false,
			'repository row, its worktree hidden': true,
			'repository row, window on the repository': true,
			'repository row, window elsewhere, hidden': false,
			'no folder at all': false,
		});
	});
});
