/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode, IStat } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { GROUPS_STORAGE_KEY, IDeletedWorktree, WorkspaceBarGit, WorkspaceBarGroup } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
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

/** The in-memory disk, where a path can be made one that fails to be read, as a disk's can: an I/O error, a share not answering. */
class FailingFileSystemProvider extends InMemoryFileSystemProvider {

	/** The paths whose `stat` fails. */
	readonly failing = new Set<string>();

	override async stat(resource: URI): Promise<IStat> {
		if (this.failing.has(resource.path)) {
			throw createFileSystemProviderError('EIO: i/o error', FileSystemProviderErrorCode.Unknown);
		}
		return super.stat(resource);
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
	/** The disk under `fileService`. */
	let disk: FailingFileSystemProvider;
	/** The workspace's storage, which every window of the workspace in a test shares. */
	let storage: TestStorageService;

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		disk = disposables.add(new FailingFileSystemProvider());
		disposables.add(fileService.registerProvider(Schemas.file, disk));
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

	/**
	 * The reader of a window onto `paths` that takes deleted worktrees out of its folders as the bar does, or - `takes`
	 * false - does not, or - 'fails' - fails as it tries; and what it was handed each time.
	 */
	function openTakingOut(paths: string[], takes: boolean | 'fails' = true): { git: WorkspaceBarGit; handed: unknown[] } {
		const changed = disposables.add(new Emitter<void>());
		const handed: unknown[] = [];
		const source = {
			folders: workspaceFolders(...paths),
			onDidChange: changed.event,
			key: (uri: URI) => uri.toString(),
			removeDeleted: async (deleted: readonly IDeletedWorktree[]) => {
				handed.push(deleted.map(({ folder, main }) => ({ folder: folder.uri.path, main: main?.path })));
				if (takes === 'fails') {
					throw new Error('The workspace could not be edited');
				}
				if (takes) {
					source.folders = source.folders.filter(folder => !deleted.some(gone => gone.folder === folder));
					changed.fire();
				}
				return takes;
			}
		};
		return { git: reader(source), handed };
	}

	/** Once what a read set going is done: the removal it handed over, and the read that starts. */
	async function idle(git: WorkspaceBarGit): Promise<void> {
		await timeout(0);
		await git.refresh();
	}

	async function read(...paths: string[]): Promise<{ git: WorkspaceBarGit; groups: unknown[] }> {
		const git = open(...paths);
		await git.refresh();

		return { git, groups: summary(git.groups) };
	}

	function summary(groups: readonly WorkspaceBarGroup[]): unknown[] {
		return groups.map(group => group.kind === 'folder'
			? { folder: group.folder.uri.path, ...group.foreign ? { foreign: true } : {}, ...group.leaving ? { leaving: true } : {} }
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

	test('WTA-03 a worktree git no longer records leaves the workspace, drawn nowhere until it has: never a folder of its own (WT-3.8)', async () => {
		await repository('/lab');
		await worktree('/lab', 'removed', `${OWN}/removed`);
		await timeout(2);
		await worktree('/lab', 'emptied', `${OWN}/emptied`);
		await timeout(2);
		await worktree('/lab', 'kept', `${OWN}/kept`);
		await worktree('/lab', 'scratch', '/tmp/scratch');
		await write('/notes/readme.md', 'notes');
		const { git, handed } = openTakingOut(['/lab', `${OWN}/removed`, `${OWN}/emptied`, `${OWN}/kept`, '/tmp/scratch', '/notes']);
		await git.refresh();

		// `git worktree remove`; the same where a process is in the folder on Windows, which leaves it without its
		// `.git`; another tool removing its own, which is a folder, as any folder deleted by hand: those stay, marked as
		// not on disk (W9.3)
		const drawn: unknown[] = [];
		disposables.add(git.onDidChange(() => drawn.push(summary(git.groups))));
		await fileService.del(URI.file(`${OWN}/removed`), { recursive: true });
		await fileService.del(URI.file('/lab/.git/worktrees/removed'), { recursive: true });
		await fileService.del(URI.file(`${OWN}/emptied/.git`));
		await fileService.del(URI.file('/lab/.git/worktrees/emptied'), { recursive: true });
		await fileService.del(URI.file('/tmp/scratch'), { recursive: true });
		await fileService.del(URI.file('/lab/.git/worktrees/scratch'), { recursive: true });
		await fileService.del(URI.file('/notes'), { recursive: true });
		await git.refresh();
		await idle(git);

		const lab = { repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/kept`, label: 'kept', branch: 'kept', exists: true, folder: `${OWN}/kept` }] };
		assert.deepStrictEqual({ handed, drawn }, {
			handed: [[{ folder: `${OWN}/removed`, main: '/lab' }, { folder: `${OWN}/emptied`, main: '/lab' }]],
			drawn: [
				[lab, { folder: `${OWN}/removed`, leaving: true }, { folder: `${OWN}/emptied`, leaving: true }, { folder: '/tmp/scratch', foreign: true }, { folder: '/notes' }],
				[lab, { folder: '/tmp/scratch', foreign: true }, { folder: '/notes' }],
			],
		});
	});

	test('WTA-03 a worktree deleted while the window was closed leaves the workspace, told by the kept groups; with none kept, nothing tells its repository, and it stays a folder, marked as not on disk (WT-3.8)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await read('/lab', `${OWN}/w2`);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		await fileService.del(URI.file('/lab/.git/worktrees/w2'), { recursive: true });
		await fileService.del(URI.file(`${OWN}/w2`), { recursive: true });
		const kept = openTakingOut(['/lab', `${OWN}/w2`]);
		await kept.git.refresh();

		// A repository of its folder's name that does not record it is no evidence: two of one name share that folder
		storage.remove(GROUPS_STORAGE_KEY, StorageScope.WORKSPACE);
		const none = openTakingOut(['/lab', `${OWN}/w2`]);
		await none.git.refresh();

		assert.deepStrictEqual({ kept: kept.handed, none: { handed: none.handed, groups: summary(none.git.groups) } }, {
			kept: [[{ folder: `${OWN}/w2`, main: '/lab' }]],
			none: { handed: [], groups: [{ repository: '/lab', folder: '/lab', worktrees: [] }, { folder: `${OWN}/w2` }] },
		});
	});

	test('WTA-03 a deleted worktree that could not leave, or whose leaving failed, is drawn in its place, marked, and not handed over again', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		const kept = openTakingOut(['/lab', `${OWN}/w2`], false);
		const failed = openTakingOut(['/lab', `${OWN}/w2`], 'fails');
		await kept.git.refresh();
		await failed.git.refresh();
		await fileService.del(URI.file('/lab/.git/worktrees/w2'), { recursive: true });
		await fileService.del(URI.file(`${OWN}/w2`), { recursive: true });
		const originalHandler = errorHandler.getUnexpectedErrorHandler();
		const reported: string[] = [];
		setUnexpectedErrorHandler(error => reported.push((error as Error).message));
		try {
			for (const { git } of [kept, failed]) {
				await git.refresh();
				await idle(git);
				await git.refresh();
			}
		} finally {
			setUnexpectedErrorHandler(originalHandler);
		}

		const handed = [[{ folder: `${OWN}/w2`, main: '/lab' }]];
		const groups = [{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: false, folder: `${OWN}/w2` }] }];
		assert.deepStrictEqual({ kept: { handed: kept.handed, groups: summary(kept.git.groups) }, failed: { handed: failed.handed, groups: summary(failed.git.groups) }, reported }, {
			kept: { handed, groups },
			failed: { handed, groups },
			reported: ['The workspace could not be edited'],
		});
	});

	test('WTA-03 a deleted worktree that cannot leave, whose repository has no other row - a window on it alone - is drawn under its repository, marked, its folder gone or left without its .git: never nowhere, nor a folder of its own (WT-3.8)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await worktree('/lab', 'w3', `${OWN}/w3`);
		const gone = openTakingOut([`${OWN}/w2`], false);
		const emptied = openTakingOut([`${OWN}/w3`], false);
		await gone.git.refresh();
		await emptied.git.refresh();
		// Removed by git: one with its folder, the other's folder left without its `.git`, as on Windows
		await fileService.del(URI.file('/lab/.git/worktrees/w2'), { recursive: true });
		await fileService.del(URI.file(`${OWN}/w2`), { recursive: true });
		await fileService.del(URI.file('/lab/.git/worktrees/w3'), { recursive: true });
		await fileService.del(URI.file(`${OWN}/w3/.git`));
		for (const { git } of [gone, emptied]) {
			await git.refresh();
			await idle(git);
			await git.refresh();
		}

		const marked = (name: string) => [{ repository: '/lab', folder: undefined, worktrees: [{ path: `${OWN}/${name}`, label: name, branch: name, exists: false, folder: `${OWN}/${name}` }] }];
		assert.deepStrictEqual({ gone: { handed: gone.handed, groups: summary(gone.git.groups) }, emptied: { handed: emptied.handed, groups: summary(emptied.git.groups) } }, {
			gone: { handed: [[{ folder: `${OWN}/w2`, main: '/lab' }]], groups: marked('w2') },
			emptied: { handed: [[{ folder: `${OWN}/w3`, main: '/lab' }]], groups: marked('w3') },
		});
	});

	test('WTA-03 a deleted worktree that could not leave is not handed over again in the next window either: drawn in its place, marked, at once (WT-3.8)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		const first = openTakingOut([`${OWN}/w2`], false);
		await first.git.refresh();
		await fileService.del(URI.file('/lab/.git/worktrees/w2'), { recursive: true });
		await fileService.del(URI.file(`${OWN}/w2`), { recursive: true });
		await first.git.refresh();
		await idle(first.git);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		const next = openTakingOut([`${OWN}/w2`], false);
		const drawn: unknown[] = [];
		disposables.add(next.git.onDidChange(() => drawn.push(summary(next.git.groups))));
		await next.git.refresh();

		const marked = [{ repository: '/lab', folder: undefined, worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: false, folder: `${OWN}/w2` }] }];
		assert.deepStrictEqual({ handed: next.handed, drawn }, { handed: [], drawn: [marked] });
	});

	test('WTA-03 a worktree of Facade\'s deleted by hand while worktrees were switched off is marked under its repository once they are on again, never a folder of its own (WT-1.9, WT-9.1)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		let shown = true;
		const folders = workspaceFolders(`${OWN}/w2`);
		const git = reader({ get folders() { return shown ? folders : []; }, onDidChange: Event.None, key: uri => uri.toString() });
		await git.refresh();
		shown = false;
		await git.refresh();
		await fileService.del(URI.file(`${OWN}/w2`), { recursive: true });
		shown = true;
		await git.refresh();

		assert.deepStrictEqual(summary(git.groups), [{ repository: '/lab', folder: undefined, worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: false, folder: `${OWN}/w2` }] }]);
	});

	test('WTA-03 a folder inside one of Facade\'s worktrees, gone with a checkout that has no such folder, is a folder of its own, marked as not on disk: nothing says git dropped it, and it does not leave (W9.3)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await write(`${OWN}/w2/pkg/index.ts`, '');
		const { git, handed } = openTakingOut([`${OWN}/w2/pkg`]);
		await git.refresh();
		await fileService.del(URI.file(`${OWN}/w2/pkg`), { recursive: true });
		await git.refresh();
		await idle(git);

		assert.deepStrictEqual({ handed, groups: summary(git.groups) }, { handed: [], groups: [{ folder: `${OWN}/w2/pkg` }] });
	});

	test('WTA-03 a worktree whose repository cannot be reached is drawn where it was, marked, and back as it was once the repository is; nothing leaves (WT-3.8)', async () => {
		await repository('/drive/lab');
		await worktree('/drive/lab', 'w2', `${OWN}/w2`);
		await read('/drive/lab', `${OWN}/w2`);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		// The drive the repository is on, not mounted
		const files = ['/drive/lab/.git/HEAD', '/drive/lab/.git/worktrees/w2/gitdir', '/drive/lab/.git/worktrees/w2/HEAD', '/drive/lab/.git/worktrees/w2/commondir'];
		const contents = await Promise.all(files.map(async file => (await fileService.readFile(URI.file(file))).value.toString()));
		await fileService.del(URI.file('/drive'), { recursive: true });
		const { git, handed } = openTakingOut(['/drive/lab', `${OWN}/w2`]);
		await git.refresh();
		const away = summary(git.groups);

		for (let index = 0; index < files.length; index++) {
			await fileService.writeFile(URI.file(files[index]), VSBuffer.fromString(contents[index]));
		}
		await git.refresh();

		const lab = (exists: boolean) => [{ repository: '/drive/lab', folder: '/drive/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists, folder: `${OWN}/w2` }] }];
		assert.deepStrictEqual({ handed, away, back: summary(git.groups) }, { handed: [], away: lab(false), back: lab(true) });
	});

	test('WTA-03 a repository that cannot be reached is looked for again after ten seconds, then less often each time it is still not there (WT-3.8)', () => runWithFakedTimers({}, async () => {
		await repository('/drive/lab');
		await worktree('/drive/lab', 'w2', `${OWN}/w2`);
		await read('/drive/lab', `${OWN}/w2`);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		const files = ['/drive/lab/.git/HEAD', '/drive/lab/.git/worktrees/w2/gitdir', '/drive/lab/.git/worktrees/w2/HEAD', '/drive/lab/.git/worktrees/w2/commondir'];
		const contents = await Promise.all(files.map(async file => (await fileService.readFile(URI.file(file))).value.toString()));
		await fileService.del(URI.file('/drive'), { recursive: true });
		const { git } = openTakingOut(['/drive/lab', `${OWN}/w2`]);
		await git.refresh();
		// Looked for at ten seconds, and not there: next at thirty
		await timeout(12_000);
		for (let index = 0; index < files.length; index++) {
			await fileService.writeFile(URI.file(files[index]), VSBuffer.fromString(contents[index]));
		}
		await timeout(13_000);
		const at25 = summary(git.groups);
		const back = Event.toPromise(git.onDidChange);
		await timeout(6_000);
		await back;

		const lab = (exists: boolean) => [{ repository: '/drive/lab', folder: '/drive/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists, folder: `${OWN}/w2` }] }];
		assert.deepStrictEqual({ at25, at31: summary(git.groups) }, { at25: lab(false), at31: lab(true) });
	}));

	test('WTA-03 a read that misses a file of a record git is writing takes nothing out, and draws the worktree where it was', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		const { git, handed } = openTakingOut(['/lab', `${OWN}/w2`]);
		await git.refresh();
		// Neither its HEAD nor its `commondir` there for a moment
		await fileService.del(URI.file('/lab/.git/worktrees/w2/HEAD'));
		await fileService.del(URI.file('/lab/.git/worktrees/w2/commondir'));
		await git.refresh();

		assert.deepStrictEqual({ handed, groups: summary(git.groups) }, {
			handed: [],
			groups: [{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder: `${OWN}/w2` }] }],
		});
	});

	test('WTA-03 a record a killed `git worktree add` left, its HEAD all zeros for good, keeps no worktree of its repository from leaving (WT-3.8)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await worktree('/lab', 'stale', '/tmp/verify/stale', '0'.repeat(40));
		const { git, handed } = openTakingOut(['/lab', `${OWN}/w2`]);
		await git.refresh();
		await fileService.del(URI.file('/lab/.git/worktrees/w2'), { recursive: true });
		await fileService.del(URI.file(`${OWN}/w2`), { recursive: true });
		await git.refresh();
		await idle(git);

		assert.deepStrictEqual({ handed, groups: summary(git.groups) }, {
			handed: [[{ folder: `${OWN}/w2`, main: '/lab' }]],
			groups: [{ repository: '/lab', folder: '/lab', worktrees: [] }],
		});
	});

	test('WTA-03 a worktree whose record git is rewriting, its folder gone, stays in its place and is marked once its folder has stayed gone (WT-3.8)', () => runWithFakedTimers({}, async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		const { git, handed } = openTakingOut(['/lab', `${OWN}/w2`]);
		await git.refresh();
		await fileService.del(URI.file('/lab/.git/worktrees/w2/HEAD'));
		await fileService.del(URI.file(`${OWN}/w2`), { recursive: true });
		await git.refresh();
		await timeout(1000);
		await git.refresh();

		assert.deepStrictEqual({ handed, groups: summary(git.groups) }, {
			handed: [],
			groups: [{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: false, folder: `${OWN}/w2` }] }],
		});
	}));

	test('WTA-03 a main checkout whose .git cannot be read for a moment stays its repository\'s row, its worktree in the workspace or not: never taken out, nor drawn as a worktree (WT-3.8)', async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		const both = openTakingOut(['/lab', `${OWN}/w2`]);
		const alone = openTakingOut(['/lab']);
		await both.git.refresh();
		await alone.git.refresh();
		disk.failing.add('/lab/.git');
		await both.git.refresh();
		await alone.git.refresh();
		await idle(both.git);
		await idle(alone.git);

		const lab = (folder: string | undefined) => [{ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: true, folder }] }];
		assert.deepStrictEqual({ both: { handed: both.handed, groups: summary(both.git.groups) }, alone: { handed: alone.handed, groups: summary(alone.git.groups) } }, {
			both: { handed: [], groups: lab(`${OWN}/w2`) },
			alone: { handed: [], groups: lab(undefined) },
		});
	});

	test('WTA-03 a worktree deleted by hand that nothing kept tells the repository of but its folder\'s name is told by the one of that name that records it: marked in its place, not taken out (WT-1.9); with that one not in the window, nothing tells, and it stays a folder of its own', async () => {
		await repository('/a/lab');
		await repository('/b/lab');
		await worktree('/b/lab', 'w2', `${OWN}/w2`, 'ref: refs/heads/w2', false);
		const both = openTakingOut(['/a/lab', '/b/lab', `${OWN}/w2`]);
		const other = openTakingOut(['/a/lab', `${OWN}/w2`]);
		await both.git.refresh();
		await other.git.refresh();
		await idle(both.git);
		await idle(other.git);

		const aLab = { repository: '/a/lab', folder: '/a/lab', worktrees: [] };
		assert.deepStrictEqual({ both: { handed: both.handed, groups: summary(both.git.groups) }, other: { handed: other.handed, groups: summary(other.git.groups) } }, {
			both: { handed: [], groups: [aLab, { repository: '/b/lab', folder: '/b/lab', worktrees: [{ path: `${OWN}/w2`, label: 'w2', branch: 'w2', exists: false, folder: `${OWN}/w2` }] }] },
			other: { handed: [], groups: [aLab, { folder: `${OWN}/w2` }] },
		});
	});

	test('WTA-03 a worktree git removes is never drawn marked on its way out, its folder gone a moment before its record; one deleted by hand is marked once it has stayed gone (WT-3.8)', () => runWithFakedTimers({}, async () => {
		await repository('/lab');
		await worktree('/lab', 'w2', `${OWN}/w2`);
		await timeout(2);
		await worktree('/lab', 'w3', `${OWN}/w3`);
		const git = open('/lab');
		await git.refresh();
		const drawn: unknown[] = [];
		disposables.add(git.onDidChange(() => drawn.push(summary(git.groups))));

		await fileService.del(URI.file(`${OWN}/w2`), { recursive: true });
		await fileService.del(URI.file(`${OWN}/w3`), { recursive: true });
		await git.refresh();
		await fileService.del(URI.file('/lab/.git/worktrees/w2'), { recursive: true });
		await git.refresh();
		await timeout(1000);
		await git.refresh();

		const w3 = (exists: boolean) => ({ repository: '/lab', folder: '/lab', worktrees: [{ path: `${OWN}/w3`, label: 'w3', branch: 'w3', exists, folder: undefined }] });
		assert.deepStrictEqual(drawn, [[w3(true)], [w3(false)]]);
	}));

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

	test('WTA-03 a folder whose .git names a git directory that is gone - its repository moved, or its record pruned - is a plain row where nothing takes it out', async () => {
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

	test('WTA-01 a worktree Facade made of a bare repository stays a plain row: there is no main checkout to hang it under', async () => {
		const b = '/home/.facade/worktrees/bare.git/b';
		await write('/store/bare.git/HEAD', 'ref: refs/heads/main');
		await write('/store/bare.git/worktrees/b/gitdir', `${b}/.git`);
		await write('/store/bare.git/worktrees/b/HEAD', 'ref: refs/heads/b');
		await write('/store/bare.git/worktrees/b/commondir', '../..');
		await write(`${b}/.git`, 'gitdir: /store/bare.git/worktrees/b');

		const { groups } = await read(b);

		assert.deepStrictEqual(groups, [{ folder: b }]);
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
