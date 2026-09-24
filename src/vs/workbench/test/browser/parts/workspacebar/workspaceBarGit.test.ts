/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { WorkspaceBarGit, WorkspaceBarGroup } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';

/**
 * The reader against real reads: upstream's file service over an in-memory disk, with git's own files
 * written into it the way `git worktree add` writes them.
 */
suite('Workspace bar - worktrees as git records them', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: FileService;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
	});

	async function write(path: string, content: string): Promise<void> {
		await fileService.writeFile(URI.file(path), VSBuffer.fromString(`${content}\n`));
	}

	/** A main checkout at `main`, with its HEAD on `branch`. */
	async function repository(main: string, branch = 'main'): Promise<void> {
		await write(`${main}/.git/HEAD`, `ref: refs/heads/${branch}`);
	}

	/**
	 * A linked worktree of `main`, recorded under `name`, at `path`.
	 *
	 * `path` is left out of the disk when `present` is false: git's record without the folder, which is
	 * what deleting the folder by hand leaves behind.
	 */
	async function worktree(main: string, name: string, path: string, head = `ref: refs/heads/${name}`, present = true): Promise<void> {
		await write(`${main}/.git/worktrees/${name}/gitdir`, `${path}/.git`);
		await write(`${main}/.git/worktrees/${name}/HEAD`, head);
		await write(`${main}/.git/worktrees/${name}/commondir`, '../..');
		if (present) {
			await write(`${path}/.git`, `gitdir: ${main}/.git/worktrees/${name}`);
		}
	}

	async function read(...paths: string[]): Promise<{ git: WorkspaceBarGit; groups: unknown[] }> {
		const folders = paths.map((path, index) => new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(path.lastIndexOf('/') + 1) }));
		const git = disposables.add(new WorkspaceBarGit({ folders, onDidChange: Event.None, key: uri => uri.toString() }, fileService));
		await git.refresh();

		return { git, groups: summary(git.groups) };
	}

	function summary(groups: readonly WorkspaceBarGroup[]): unknown[] {
		return groups.map(group => group.kind === 'folder'
			? { folder: group.folder.uri.path }
			: {
				repository: group.main.path,
				folder: group.folder?.uri.path,
				worktrees: group.worktrees.map(worktree => ({
					path: worktree.uri.path,
					label: worktree.label,
					branch: worktree.branch,
					exists: worktree.exists,
					folder: worktree.folder?.uri.path
				}))
			});
	}

	test('a main checkout lists every worktree git records, in numeric order, none of them added', async () => {
		await repository('/lab');
		await worktree('/lab', 'w10', '/wt/w10');
		await worktree('/lab', 'w2', '/wt/w2');
		await worktree('/lab', 'feat-x', '/wt/feat-x', 'ref: refs/heads/feat/x');

		const { groups } = await read('/lab');

		assert.deepStrictEqual(groups, [{
			repository: '/lab',
			folder: '/lab',
			worktrees: [
				{ path: '/wt/feat-x', label: 'feat/x', branch: 'feat/x', exists: true, folder: undefined },
				{ path: '/wt/w2', label: 'w2', branch: 'w2', exists: true, folder: undefined },
				{ path: '/wt/w10', label: 'w10', branch: 'w10', exists: true, folder: undefined },
			]
		}]);
	});

	test('a worktree in the workspace joins its repository, which sits where its first member is', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', '/wt/w2');

		const { groups } = await read('/notes', '/wt/w2', '/lab');

		assert.deepStrictEqual(groups, [
			{ folder: '/notes' },
			{ repository: '/lab', folder: '/lab', worktrees: [{ path: '/wt/w2', label: 'w2', branch: 'w2', exists: true, folder: '/wt/w2' }] },
		]);
	});

	test('a worktree added on its own still makes its repository the row, without adding the repository', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', '/wt/w2');

		const { groups } = await read('/wt/w2');

		assert.deepStrictEqual(groups, [
			{ repository: '/lab', folder: undefined, worktrees: [{ path: '/wt/w2', label: 'w2', branch: 'w2', exists: true, folder: '/wt/w2' }] },
		]);
	});

	test('a detached HEAD shows its short hash, and a worktree whose folder is gone is still listed', async () => {
		await repository('/lab');
		await worktree('/lab', 'probe', '/wt/probe', '0123456789abcdef0123456789abcdef01234567');
		await worktree('/lab', 'gone', '/wt/gone', 'ref: refs/heads/gone', false);

		const { groups } = await read('/lab');

		assert.deepStrictEqual(groups, [{
			repository: '/lab',
			folder: '/lab',
			worktrees: [
				{ path: '/wt/probe', label: '0123456', branch: undefined, exists: true, folder: undefined },
				{ path: '/wt/gone', label: 'gone', branch: 'gone', exists: false, folder: undefined },
			]
		}]);
	});

	test('a folder without a .git of its own is a plain row, even inside a repository', async () => {
		await repository('/lab');
		await write('/lab/packages/a/package.json', '{}');
		await write('/notes/readme.md', 'notes');

		const { groups } = await read('/notes', '/lab/packages/a');

		assert.deepStrictEqual(groups, [{ folder: '/notes' }, { folder: '/lab/packages/a' }]);
	});

	test('relative paths, as worktree.useRelativePaths writes them, resolve against the file they are in', async () => {
		await repository('/lab');
		await write('/lab/.git/worktrees/w3/gitdir', '../../../../wt/w3/.git');
		await write('/lab/.git/worktrees/w3/HEAD', 'ref: refs/heads/w3');
		await write('/lab/.git/worktrees/w3/commondir', '../..');
		await write('/wt/w3/.git', 'gitdir: ../../lab/.git/worktrees/w3');

		const { groups } = await read('/wt/w3');

		assert.deepStrictEqual(groups, [
			{ repository: '/lab', folder: undefined, worktrees: [{ path: '/wt/w3', label: 'w3', branch: 'w3', exists: true, folder: '/wt/w3' }] },
		]);
	});

	test('a worktree of a bare repository stays a plain row: there is no main checkout to hang it under', async () => {
		await write('/store/bare.git/HEAD', 'ref: refs/heads/main');
		await write('/store/bare.git/worktrees/b/gitdir', '/wt/b/.git');
		await write('/store/bare.git/worktrees/b/HEAD', 'ref: refs/heads/b');
		await write('/store/bare.git/worktrees/b/commondir', '../..');
		await write('/wt/b/.git', 'gitdir: /store/bare.git/worktrees/b');

		const { groups } = await read('/wt/b');

		assert.deepStrictEqual(groups, [{ folder: '/wt/b' }]);
	});

	test('a read that finds what the last one found does not fire; a new worktree does', async () => {
		await repository('/lab');
		const { git } = await read('/lab');

		let fired = 0;
		disposables.add(git.onDidChange(() => fired++));

		await git.refresh();
		await worktree('/lab', 'w2', '/wt/w2');
		await git.refresh();

		assert.strictEqual(fired, 1);
	});
});
