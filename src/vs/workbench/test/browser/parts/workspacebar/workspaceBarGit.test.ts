/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { GROUPS_STORAGE_KEY, WorkspaceBarGit, WorkspaceBarGroup } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { TestStorageService } from '../../../common/workbenchTestServices.js';

/** The in-memory disk, with links: each of `links` resolves to the path it maps to, as a disk's real path. */
class LinkedFileSystemProvider extends InMemoryFileSystemProvider {

	constructor(private readonly links: ReadonlyMap<string, string>) {
		super();
	}

	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileRealpath;
	}

	async realpath(resource: URI): Promise<string> {
		// As a disk's: what is not there has no real path.
		await this.stat(resource);
		for (const [link, target] of this.links) {
			if (resource.path === link || resource.path.startsWith(`${link}/`)) {
				return target + resource.path.slice(link.length);
			}
		}
		return resource.path;
	}
}

/**
 * The reader against real reads: upstream's file service over an in-memory disk, with git's own files
 * written into it the way `git worktree add` writes them.
 */
suite('Workspace bar - worktrees as git records them', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let fileService: FileService;
	/** The workspace's storage, which every window of the workspace in a test shares. */
	let storage: TestStorageService;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		storage = disposables.add(new TestStorageService());
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

	/** The reader of a window onto `paths`, as the window makes it: its first read started, not finished. */
	function open(...paths: string[]): WorkspaceBarGit {
		const folders = paths.map((path, index) => new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(path.lastIndexOf('/') + 1) }));
		return disposables.add(new WorkspaceBarGit({ folders, onDidChange: Event.None, key: uri => uri.toString() }, fileService, storage));
	}

	async function read(...paths: string[]): Promise<{ git: WorkspaceBarGit; groups: unknown[] }> {
		const git = open(...paths);
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

	test('WTA-01 WTA-02 a main checkout lists every worktree git records, oldest first, none of them added', async () => {
		// ⚠️ A moment between each, so that each record is made at a time of its own: the order is the
		// creation time of git's record, and the in-memory disk stamps it to the millisecond.
		await repository('/lab');
		await worktree('/lab', 'w10', '/wt/w10');
		await timeout(2);
		await worktree('/lab', 'w2', '/wt/w2');
		await timeout(2);
		await worktree('/lab', 'feat-x', '/wt/feat-x', 'ref: refs/heads/feat/x');

		const { groups } = await read('/lab');

		assert.deepStrictEqual(groups, [{
			repository: '/lab',
			folder: '/lab',
			worktrees: [
				{ path: '/wt/w10', label: 'w10', branch: 'w10', exists: true, folder: undefined },
				{ path: '/wt/w2', label: 'w2', branch: 'w2', exists: true, folder: undefined },
				{ path: '/wt/feat-x', label: 'feat/x', branch: 'feat/x', exists: true, folder: undefined },
			]
		}]);
	});

	test('WTA-01 a worktree in the workspace joins its repository, which sits where its first member is', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', '/wt/w2');

		const { groups } = await read('/notes', '/wt/w2', '/lab');

		assert.deepStrictEqual(groups, [
			{ folder: '/notes' },
			{ repository: '/lab', folder: '/lab', worktrees: [{ path: '/wt/w2', label: 'w2', branch: 'w2', exists: true, folder: '/wt/w2' }] },
		]);
	});

	test('WTA-07 a worktree added on its own still makes its repository the row, without adding the repository', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', '/wt/w2');

		const { groups } = await read('/wt/w2');

		assert.deepStrictEqual(groups, [
			{ repository: '/lab', folder: undefined, worktrees: [{ path: '/wt/w2', label: 'w2', branch: 'w2', exists: true, folder: '/wt/w2' }] },
		]);
	});

	test('WTA-03 a detached HEAD shows its short hash, and a worktree whose folder is gone is still listed', async () => {
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

	test('WTA-03 a reftable repository, whose HEAD files do not say the branch, has its worktrees named by their folders, on no branch', async () => {
		await write('/lab/.git/HEAD', 'ref: refs/heads/.invalid');
		await worktree('/lab', 'w2', '/wt/w2', 'ref: refs/heads/.invalid');

		const { git, groups } = await read('/lab');

		assert.deepStrictEqual({ groups, branch: git.groups[0].kind === 'repository' ? git.groups[0].branch : 'not a repository' }, {
			groups: [{ repository: '/lab', folder: '/lab', worktrees: [{ path: '/wt/w2', label: 'w2', branch: undefined, exists: true, folder: undefined }] }],
			branch: undefined,
		});
	});

	test('WTA-03 a worktree in the workspace whose folder was deleted by hand is one row, under its repository', async () => {
		await repository('/lab');
		await worktree('/lab', 'gone', '/wt/gone', 'ref: refs/heads/gone', false);

		const { groups } = await read('/lab', '/wt/gone');
		// Listed before its repository and another folder, it takes the repository's row up with it (WT-1.6).
		const { groups: listedFirst } = await read('/wt/gone', '/notes', '/lab');

		assert.deepStrictEqual({ groups, listedFirst }, {
			groups: [
				{ repository: '/lab', folder: '/lab', worktrees: [{ path: '/wt/gone', label: 'gone', branch: 'gone', exists: false, folder: '/wt/gone' }] },
			],
			listedFirst: [
				{ repository: '/lab', folder: '/lab', worktrees: [{ path: '/wt/gone', label: 'gone', branch: 'gone', exists: false, folder: '/wt/gone' }] },
				{ folder: '/notes' },
			],
		});
	});

	test('WTA-03 one repository added under two spellings - its own name, and a link to it - is one row, with both folders on it', async () => {
		const linked = disposables.add(new FileService(new NullLogService()));
		disposables.add(linked.registerProvider(Schemas.file, disposables.add(new LinkedFileSystemProvider(new Map([['/link-lab', '/lab']])))));
		// What reading through the link finds is what is there.
		for (const root of ['/lab', '/link-lab']) {
			await linked.writeFile(URI.file(`${root}/.git/HEAD`), VSBuffer.fromString('ref: refs/heads/main\n'));
		}
		const folders = ['/lab', '/link-lab'].map((path, index) => new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(1) }));
		const git = disposables.add(new WorkspaceBarGit({ folders, onDidChange: Event.None, key: uri => uri.toString() }, linked, storage));
		await git.refresh();

		assert.deepStrictEqual(git.groups.map(group => group.kind === 'repository'
			? { main: group.main.path, folder: group.folder?.uri.path, members: group.members.map(member => member.uri.path) }
			: { folder: group.folder.uri.path }), [
			{ main: '/lab', folder: '/lab', members: ['/lab', '/link-lab'] },
		]);
	});

	test('WTA-03 a folder whose .git names a git directory that is gone - its repository moved, or its record pruned - is a plain row', async () => {
		await write('/wt/orphan/.git', 'gitdir: /moved/.git/worktrees/orphan');

		const { groups } = await read('/wt/orphan');

		assert.deepStrictEqual(groups, [{ folder: '/wt/orphan' }]);
	});

	test('WTA-01 a folder without a .git of its own is a plain row, even inside a repository', async () => {
		await repository('/lab');
		await write('/lab/packages/a/package.json', '{}');
		await write('/notes/readme.md', 'notes');

		const { groups } = await read('/notes', '/lab/packages/a');

		assert.deepStrictEqual(groups, [{ folder: '/notes' }, { folder: '/lab/packages/a' }]);
	});

	test('WTA-03 relative paths, as worktree.useRelativePaths writes them, resolve against the file they are in', async () => {
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

	test('WTA-01 a worktree of a bare repository stays a plain row: there is no main checkout to hang it under', async () => {
		await write('/store/bare.git/HEAD', 'ref: refs/heads/main');
		await write('/store/bare.git/worktrees/b/gitdir', '/wt/b/.git');
		await write('/store/bare.git/worktrees/b/HEAD', 'ref: refs/heads/b');
		await write('/store/bare.git/worktrees/b/commondir', '../..');
		await write('/wt/b/.git', 'gitdir: /store/bare.git/worktrees/b');

		const { groups } = await read('/wt/b');

		assert.deepStrictEqual(groups, [{ folder: '/wt/b' }]);
	});

	test('WTA-11 a read that finds what the last one found does not fire; a new worktree does', async () => {
		await repository('/lab');
		const { git } = await read('/lab');

		let fired = 0;
		disposables.add(git.onDidChange(() => fired++));

		await git.refresh();
		await worktree('/lab', 'w2', '/wt/w2');
		await git.refresh();

		assert.strictEqual(fired, 1);
	});

	test('a read overtaken by a newer one resolves once the newer one is in, so the groups are current', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', '/wt/w2');
		const folder = (path: string, index: number) => new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(path.lastIndexOf('/') + 1) });
		const source = { folders: [folder('/lab', 0)], onDidChange: Event.None, key: (uri: URI) => uri.toString() };
		const git = disposables.add(new WorkspaceBarGit(source, fileService, storage));
		await git.refresh();

		// Two reads in flight, the way a folder added to the workspace starts one and the window's move
		// onto it waits on another (`WorkspaceBarPart.show`) - the newer one over more folders, and so
		// the slower of the two, as it is when a worktree has just been added.
		const older = git.refresh();
		source.folders = ['/lab', '/wt/w2', '/a', '/b', '/c', '/d', '/e', '/f'].map(folder);
		const newer = git.refresh();
		await older;
		const groupsWhenOlderResolved = summary(git.groups);
		await newer;

		assert.deepStrictEqual(groupsWhenOlderResolved, summary(git.groups));
	});

	test('WTA-11 the next window has the groups the last one read before its own first read, which finds the same and fires nothing (WT-3.7)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', '/wt/w2');
		await read('/lab', '/wt/w2');
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		const git = open('/lab', '/wt/w2');
		let fired = 0;
		disposables.add(git.onDidChange(() => fired++));
		const drawn = { ready: git.ready, groups: summary(git.groups) };
		await git.refresh();

		assert.deepStrictEqual({ drawn, fired }, {
			drawn: {
				ready: true,
				groups: [{ repository: '/lab', folder: '/lab', worktrees: [{ path: '/wt/w2', label: 'w2', branch: 'w2', exists: true, folder: '/wt/w2' }] }]
			},
			fired: 0
		});
	});

	test('WTA-11 a folder that left the workspace between two windows is not on the kept groups, nor a repository none of whose folders is left', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', '/wt/w2');
		await repository('/other');
		await read('/lab', '/wt/w2', '/other');
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		const git = open('/lab');
		const drawn = summary(git.groups);
		await git.refresh();

		assert.deepStrictEqual(drawn, [
			{ repository: '/lab', folder: '/lab', worktrees: [{ path: '/wt/w2', label: 'w2', branch: 'w2', exists: true, folder: undefined }] },
		]);
	});

	test('WTA-11 a kept record that cannot be read, or names none of the folders, is not drawn from: the bar starts flat, as with none kept', async () => {
		await repository('/lab');
		const records = [
			'{ not json',
			JSON.stringify({ kind: 'folder', folder: 'file:///lab' }),
			JSON.stringify([{ kind: 'repository', main: 7 }]),
			JSON.stringify([{ kind: 'folder', folder: 'file:///gone' }]),
			JSON.stringify([{ kind: 'folder', folder: 'file:///lab' }, { kind: 'folder', folder: 'file:////lab' }]),	// the second not a URI: URI.parse throws
		];

		const ready: boolean[] = [];
		for (const record of records) {
			storage.store(GROUPS_STORAGE_KEY, record, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			const git = open('/lab');
			ready.push(git.ready);
			await git.refresh();
		}

		assert.deepStrictEqual(ready, [false, false, false, false, false]);
	});
});
