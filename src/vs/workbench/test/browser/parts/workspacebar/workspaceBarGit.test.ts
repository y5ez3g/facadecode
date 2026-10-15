/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { GROUPS_STORAGE_KEY, WorkspaceBarGit, WorkspaceBarGroup } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { TestStorageService } from '../../../common/workbenchTestServices.js';
import { TestPathService } from '../../workbenchTestServices.js';

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

	/** Where the product makes `/lab`'s worktrees: `<home>/.facade/worktrees/<repository>` (WT-2.1). */
	const OWN = '/home/.facade/worktrees/lab';
	const pathService = new TestPathService(URI.file('/home'));

	let fileService: FileService;
	/** The workspace's storage, which every window of the workspace in a test shares. */
	let storage: TestStorageService;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		storage = disposables.add(new TestStorageService());
	});

	/** The reader over `source`, on `files` - the in-memory disk, unless a test brings its own. */
	function reader(source: ConstructorParameters<typeof WorkspaceBarGit>[0], files: FileService = fileService): WorkspaceBarGit {
		return disposables.add(new WorkspaceBarGit(source, files, storage, pathService, disposables.add(new UriIdentityService(files))));
	}

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

	/** The workspace folders at `paths`, in that order. */
	function workspaceFolders(...paths: string[]): WorkspaceFolder[] {
		return paths.map((path, index) => new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(path.lastIndexOf('/') + 1) }));
	}

	/** The reader of a window onto `paths`, as the window makes it: its first read started, not finished. */
	function open(...paths: string[]): WorkspaceBarGit {
		return reader({ folders: workspaceFolders(...paths), onDidChange: Event.None, key: uri => uri.toString() });
	}

	async function read(...paths: string[]): Promise<{ git: WorkspaceBarGit; groups: unknown[] }> {
		const git = open(...paths);
		await git.refresh();

		return { git, groups: summary(git.groups) };
	}

	function summary(groups: readonly WorkspaceBarGroup[]): unknown[] {
		return groups.map(group => group.kind === 'folder'
			? { folder: group.folder.uri.path, ...group.foreign ? { foreign: true } : {} }
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

	test('WTA-01 WTA-02 a main checkout lists the product\'s worktrees of it, oldest first, none of them added', async () => {
		// ⚠️ A moment between each, so that each record is made at a time of its own: the order is the
		// creation time of git's record, and the in-memory disk stamps it to the millisecond.
		await repository('/lab');
		await worktree('/lab', 'w10', `${OWN}/w10`);
		await timeout(2);
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await timeout(2);
		await worktree('/lab', 'feat-x', `${OWN}/feat-x`, 'ref: refs/heads/feat/x');

		const { groups } = await read('/lab');

		assert.deepStrictEqual(groups, [{
			repository: '/lab',
			folder: '/lab',
			worktrees: [
				{ path: `${OWN}/w10`, label: 'w10', branch: 'w10', exists: true, folder: undefined },
				{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: undefined },
				{ path: `${OWN}/feat-x`, label: 'feat/x', branch: 'feat/x', exists: true, folder: undefined },
			]
		}]);
	});

	test('WTA-01 a worktree another tool made is listed under no repository: in the workspace, it is a folder of its own that offers no worktree', async () => {
		// An agent's scratch checkout of a commit, made in its own temporary folder to test it before a merge
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await timeout(2);
		await worktree('/lab', 'b162069', '/tmp/verify/b162069', 'b162069e6ad6bb3c2e2f60a2e27e8e5c1d3fa1b0');

		const { groups: alone } = await read('/lab');
		const { groups: added } = await read('/tmp/verify/b162069', '/lab');

		const lab = { repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: undefined }] };
		assert.deepStrictEqual({ alone, added }, {
			alone: [lab],
			added: [{ folder: '/tmp/verify/b162069', foreign: true }, lab],
		});
	});

	test('WTA-01 a worktree in the workspace joins its repository, which sits where its first member is', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);

		const { groups } = await read('/notes', `${OWN}/w2`, '/lab');

		assert.deepStrictEqual(groups, [
			{ folder: '/notes' },
			{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: `${OWN}/w2` }] },
		]);
	});

	test('WTA-07 a worktree added on its own still makes its repository the row, without adding the repository', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);

		const { groups } = await read(`${OWN}/w2`);

		assert.deepStrictEqual(groups, [
			{ repository: '/lab', folder: undefined, worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: `${OWN}/w2` }] },
		]);
	});

	test('WTA-03 a detached HEAD shows its short hash, and a worktree whose folder is gone is still listed', async () => {
		await repository('/lab');
		await worktree('/lab', 'probe', `${OWN}/probe`, '0123456789abcdef0123456789abcdef01234567');
		await worktree('/lab', 'gone', `${OWN}/gone`, 'ref: refs/heads/gone', false);

		const { groups } = await read('/lab');

		assert.deepStrictEqual(groups, [{
			repository: '/lab',
			folder: '/lab',
			worktrees: [
				{ path: `${OWN}/probe`, label: '0123456', branch: undefined, exists: true, folder: undefined },
				{ path: `${OWN}/gone`, label: 'gone', branch: 'gone', exists: false, folder: undefined },
			]
		}]);
	});

	test('WTA-03 a rebase or a bisect, which detaches HEAD while it runs, leaves the row on the branch it works on', async () => {
		const commit = '0123456789abcdef0123456789abcdef01234567';
		await repository('/lab');
		await worktree('/lab', 'rebasing', `${OWN}/rebasing`, commit);
		await write('/lab/.git/worktrees/rebasing/rebase-merge/head-name', 'refs/heads/fix/login');
		await timeout(2);
		await worktree('/lab', 'applying', `${OWN}/applying`, commit);
		await write('/lab/.git/worktrees/applying/rebase-apply/head-name', 'refs/heads/docs');
		await timeout(2);
		await worktree('/lab', 'bisecting', `${OWN}/bisecting`, commit);
		await write('/lab/.git/worktrees/bisecting/BISECT_START', 'perf');
		await timeout(2);
		// Begun on a detached HEAD, they have no branch to show
		await worktree('/lab', 'detached', `${OWN}/detached`, commit);
		await write('/lab/.git/worktrees/detached/rebase-merge/head-name', 'detached HEAD');
		await write('/lab/.git/worktrees/detached/BISECT_START', 'fedcba9876543210fedcba9876543210fedcba98');

		const { groups } = await read('/lab');

		assert.deepStrictEqual(groups, [{
			repository: '/lab',
			folder: '/lab',
			worktrees: [
				{ path: `${OWN}/rebasing`, label: 'fix/login', branch: 'fix/login', exists: true, folder: undefined },
				{ path: `${OWN}/applying`, label: 'docs', branch: 'docs', exists: true, folder: undefined },
				{ path: `${OWN}/bisecting`, label: 'perf', branch: 'perf', exists: true, folder: undefined },
				{ path: `${OWN}/detached`, label: '0123456', branch: undefined, exists: true, folder: undefined },
			]
		}]);
	});

	test('WTA-03 a worktree git is still making, its HEAD the all-zero placeholder, is listed once git has written what it checked out', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`, '0000000000000000000000000000000000000000');

		const { git, groups: making } = await read('/lab');
		await write('/lab/.git/worktrees/w2/HEAD', 'ref: refs/heads/w2');
		await git.refresh();

		assert.deepStrictEqual({ making, made: summary(git.groups) }, {
			making: [{ repository: '/lab', folder: '/lab', worktrees: [] }],
			made: [{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: undefined }] }],
		});
	});

	test('WTA-03 a reftable repository, whose HEAD files do not say the branch, has its worktrees named by their folders, on no branch', async () => {
		await write('/lab/.git/HEAD', 'ref: refs/heads/.invalid');
		await worktree('/lab', 'w2', `${OWN}/w2`, 'ref: refs/heads/.invalid');

		const { git, groups } = await read('/lab');

		assert.deepStrictEqual({ groups, branch: git.groups[0].kind === 'repository' ? git.groups[0].branch : 'not a repository' }, {
			groups: [{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: undefined, exists: true, folder: undefined }] }],
			branch: undefined,
		});
	});

	test('WTA-03 a worktree in the workspace whose folder was deleted by hand is one row, under its repository', async () => {
		await repository('/lab');
		await worktree('/lab', 'gone', `${OWN}/gone`, 'ref: refs/heads/gone', false);

		const { groups } = await read('/lab', `${OWN}/gone`);
		// Listed before its repository and another folder, it takes the repository's row up with it (WT-1.6).
		const { groups: listedFirst } = await read(`${OWN}/gone`, '/notes', '/lab');

		const gone = { path: `${OWN}/gone`, label: 'gone', branch: 'gone', exists: false, folder: `${OWN}/gone` };
		assert.deepStrictEqual({ groups, listedFirst }, {
			groups: [
				{ repository: '/lab', folder: '/lab', worktrees: [gone] },
			],
			listedFirst: [
				{ repository: '/lab', folder: '/lab', worktrees: [gone] },
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
		const git = reader({ folders, onDidChange: Event.None, key: uri => uri.toString() }, linked);
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
		await write('/lab/.git/worktrees/w3/gitdir', `../../../..${OWN}/w3/.git`);
		await write('/lab/.git/worktrees/w3/HEAD', 'ref: refs/heads/w3');
		await write('/lab/.git/worktrees/w3/commondir', '../..');
		await write(`${OWN}/w3/.git`, 'gitdir: ../../../../../lab/.git/worktrees/w3');

		const { groups } = await read(`${OWN}/w3`);

		assert.deepStrictEqual(groups, [
			{ repository: '/lab', folder: undefined, worktrees: [{ path: `${OWN}/w3`, label: 'w3', branch: 'w3', exists: true, folder: `${OWN}/w3` }] },
		]);
	});

	test('WTA-01 a worktree of a bare repository stays a plain row: there is no main checkout to hang it under', async () => {
		await write('/store/bare.git/HEAD', 'ref: refs/heads/main');
		await write('/store/bare.git/worktrees/b/gitdir', '/wt/b/.git');
		await write('/store/bare.git/worktrees/b/HEAD', 'ref: refs/heads/b');
		await write('/store/bare.git/worktrees/b/commondir', '../..');
		await write('/wt/b/.git', 'gitdir: /store/bare.git/worktrees/b');

		const { groups } = await read('/wt/b');

		assert.deepStrictEqual(groups, [{ folder: '/wt/b', foreign: true }]);
	});

	test('WTA-11 a read that finds what the last one found does not fire; a new worktree does', async () => {
		await repository('/lab');
		const { git } = await read('/lab');

		let fired = 0;
		disposables.add(git.onDidChange(() => fired++));

		await git.refresh();
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await git.refresh();

		assert.strictEqual(fired, 1);
	});

	test('a read overtaken by a newer one resolves once the newer one is in, so the groups are current', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		const folder = (path: string, index: number) => new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(path.lastIndexOf('/') + 1) });
		const source = { folders: [folder('/lab', 0)], onDidChange: Event.None, key: (uri: URI) => uri.toString() };
		const git = reader(source);
		await git.refresh();

		// Two reads in flight, the way a folder added to the workspace starts one and the window's move
		// onto it waits on another (`WorkspaceBarPart.show`) - the newer one over more folders, and so
		// the slower of the two, as it is when a worktree has just been added.
		const older = git.refresh();
		source.folders = ['/lab', `${OWN}/w2`, '/a', '/b', '/c', '/d', '/e', '/f'].map(folder);
		const newer = git.refresh();
		await older;
		const groupsWhenOlderResolved = summary(git.groups);
		await newer;

		assert.deepStrictEqual(groupsWhenOlderResolved, summary(git.groups));
	});

	test('WTA-11 the next window has the groups the last one read before its own first read, for everything but the bar, which waits a moment for that read (WT-3.7)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await read('/lab', `${OWN}/w2`);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		const git = open('/lab', `${OWN}/w2`);
		let fired = 0;
		disposables.add(git.onDidChange(() => fired++));
		const kept = { ready: git.ready, waiting: git.waiting, groups: summary(git.groups) };
		await git.refresh();

		// The bar waits a moment for the first read, which it then draws once
		assert.deepStrictEqual({ kept, waiting: git.waiting, fired }, {
			kept: {
				ready: true,
				waiting: true,
				groups: [{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: `${OWN}/w2` }] }]
			},
			waiting: false,
			fired: 1
		});
	});

	test('WTA-11 a first read slow in coming: the bar draws the last window\'s groups after a moment, and a first read that finds the same changes nothing (WT-3.7)', () => runWithFakedTimers({}, async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await read('/lab');
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		const home = new DeferredPromise<URI>();
		const slow = upcastPartial<IPathService>({ userHome: (() => home.p) as IPathService['userHome'] });
		const git = disposables.add(new WorkspaceBarGit({ folders: workspaceFolders('/lab'), onDidChange: Event.None, key: uri => uri.toString() }, fileService, storage, slow, disposables.add(new UriIdentityService(fileService))));
		let fired = 0;
		disposables.add(git.onDidChange(() => fired++));
		const before = git.waiting;
		await timeout(500);
		const after = { waiting: git.waiting, fired, groups: summary(git.groups) };
		home.complete(URI.file('/home'));
		await git.refresh();

		assert.deepStrictEqual({ before, after, fired }, {
			before: true,
			after: { waiting: false, fired: 1, groups: [{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: undefined }] }] },
			fired: 1
		});
	}));

	test('WTA-11 a folder that left the workspace between two windows is not on the kept groups, nor a repository none of whose folders is left', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await repository('/other');
		await read('/lab', `${OWN}/w2`, '/other');
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		const git = open('/lab');
		const drawn = summary(git.groups);
		await git.refresh();

		assert.deepStrictEqual(drawn, [
			{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: undefined }] },
		]);
	});

	test('WTA-11 a worktree another tool made, in the workspace, is kept as the folder of its own it was, which offers no worktree (WT-1.3)', async () => {
		await repository('/lab');
		await worktree('/lab', 'scratch', '/tmp/scratch');
		await read('/lab', '/tmp/scratch');
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		const git = open('/lab', '/tmp/scratch');
		const drawn = summary(git.groups);
		await git.refresh();

		assert.deepStrictEqual(drawn, [{ repository: '/lab', folder: '/lab', worktrees: [] }, { folder: '/tmp/scratch', foreign: true }]);
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
