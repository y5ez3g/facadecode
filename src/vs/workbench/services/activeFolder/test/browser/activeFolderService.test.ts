/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService, IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IHistoryService } from '../../../history/common/history.js';
import { ActiveFolderService } from '../../browser/activeFolderService.js';
import { activeFirst, foldersWithActiveFirst } from '../../common/activeFolder.js';

/** ⚠️ Built by hand, not with `toWorkspaceFolder`: that one numbers every folder 0. */
function folder(path: string, index: number): WorkspaceFolder {
	const uri = URI.file(path);
	return new WorkspaceFolder({ uri, index, name: path.slice(path.lastIndexOf('/') + 1) });
}

/** A workspace whose folder list can be changed under the service, the way an edit does. */
class TestContextService extends mock<IWorkspaceContextService>() {

	private readonly _onDidChangeWorkspaceFolders = new Emitter<never>();
	override readonly onDidChangeWorkspaceFolders = this._onDidChangeWorkspaceFolders.event as Event<never>;

	constructor(private folders: WorkspaceFolder[]) {
		super();
	}

	override getWorkspace(): IWorkspace {
		return { id: 'test', folders: this.folders, transient: false, configuration: null };
	}

	override getWorkspaceFolder(resource: URI): IWorkspaceFolder | null {
		// Longest match, so a root nested inside another answers with the inner one.
		const under = this.folders.filter(f => resource.path === f.uri.path || resource.path.startsWith(`${f.uri.path}/`));
		return under.sort((a, b) => b.uri.path.length - a.uri.path.length)[0] ?? null;
	}

	/** Re-numbers, because that is what removing a folder from a workspace does. */
	setFolders(paths: string[]): void {
		this.folders = paths.map((path, index) => folder(path, index));
		this._onDidChangeWorkspaceFolders.fire(undefined as never);
	}

	/** A `.code-workspace` can give a folder a name of its own, and someone can edit it. */
	rename(path: string, name: string): void {
		this.folders = this.folders.map(f => f.uri.path === path ? new WorkspaceFolder({ uri: f.uri, index: f.index, name }) : f);
		this._onDidChangeWorkspaceFolders.fire(undefined as never);
	}

	dispose(): void {
		this._onDidChangeWorkspaceFolders.dispose();
	}
}

class TestHistoryService extends mock<IHistoryService>() {
	constructor(private readonly root: URI | undefined) {
		super();
	}

	override getLastActiveWorkspaceRoot(): URI | undefined {
		return this.root;
	}
}

suite('Active folder - which root the window is on', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface IOptions {
		paths?: string[];
		storage?: IStorageService;
		lastActive?: URI;
	}

	function build(options: IOptions = {}): { service: ActiveFolderService; workspace: TestContextService; storage: IStorageService } {
		const paths = options.paths ?? ['/w/api', '/w/web', '/w/notes'];
		const workspace = new TestContextService(paths.map((path, index) => folder(path, index)));
		disposables.add({ dispose: () => workspace.dispose() });

		const storage = options.storage ?? disposables.add(new InMemoryStorageService());
		const fileService = new class extends mock<IFileService>() {
			override onDidChangeFileSystemProviderCapabilities = Event.None;
			override onDidChangeFileSystemProviderRegistrations = Event.None;
			override hasProvider(): boolean { return true; }
			override hasCapability(_resource: URI, capability: FileSystemProviderCapabilities): boolean {
				return capability !== FileSystemProviderCapabilities.PathCaseSensitive;
			}
		};

		const service = disposables.add(new ActiveFolderService(
			workspace,
			storage,
			disposables.add(new UriIdentityService(fileService)),
			new TestHistoryService(options.lastActive)
		));

		return { service, workspace, storage };
	}

	const active = (service: ActiveFolderService) => service.activeFolder?.uri.path;

	test('a window with no record of itself starts on the first root', () => {
		assert.strictEqual(active(build().service), '/w/api');
	});

	test('and on the root the last editor was in, when there is one', () => {
		assert.strictEqual(active(build({ lastActive: URI.file('/w/web') }).service), '/w/web');
	});

	test('a guess at a folder that is not a root is not taken', () => {
		assert.strictEqual(active(build({ lastActive: URI.file('/w/elsewhere') }).service), '/w/api');
	});

	test('what the window was on outlives it, and outranks the guess', async () => {
		const storage = disposables.add(new InMemoryStorageService());
		const before = build({ storage });
		await before.service.setActiveFolder(URI.file('/w/notes'));

		assert.strictEqual(active(build({ storage, lastActive: URI.file('/w/web') }).service), '/w/notes');
	});

	test('a remembered root that is no longer one falls back', async () => {
		const storage = disposables.add(new InMemoryStorageService());
		await build({ storage }).service.setActiveFolder(URI.file('/w/notes'));

		assert.strictEqual(active(build({ storage, paths: ['/w/api', '/w/web'] }).service), '/w/api');
	});

	test('setting it moves the window and says so once', async () => {
		const { service } = build();
		let changes = 0;
		disposables.add(service.onDidChangeActiveFolder(() => changes++));

		await service.setActiveFolder(URI.file('/w/web'));

		assert.strictEqual(active(service), '/w/web');
		assert.strictEqual(changes, 1);
	});

	test('setting it to where the window already is does nothing', async () => {
		const { service } = build();
		let changes = 0;
		disposables.add(service.onDidChangeActiveFolder(() => changes++));

		await service.setActiveFolder(URI.file('/w/api'));

		assert.strictEqual(changes, 0);
	});

	test('a folder that is not a root of this workspace is refused', async () => {
		const { service } = build();

		await assert.rejects(() => service.setActiveFolder(URI.file('/w/elsewhere')));
		assert.strictEqual(active(service), '/w/api');
	});

	test('a joiner finishes before the window moves', async () => {
		const { service } = build();
		const joiner = new DeferredPromise<void>();
		let movedWhileJoining: string | undefined;

		disposables.add(service.onWillChangeActiveFolder(e => e.join(joiner.p.then(() => {
			movedWhileJoining = active(service);
		}))));

		const switching = service.setActiveFolder(URI.file('/w/web'));
		await joiner.complete();
		await switching;

		// ⚠️ The point of the join: what the joiner saw was still the project being left.
		assert.strictEqual(movedWhileJoining, '/w/api');
		assert.strictEqual(active(service), '/w/web');
	});

	test('a joiner that throws costs its own work, not the switch', async () => {
		const { service } = build();
		disposables.add(service.onWillChangeActiveFolder(e => e.join(Promise.reject(new Error('could not put it away')))));

		await service.setActiveFolder(URI.file('/w/web'));

		assert.strictEqual(active(service), '/w/web');
	});

	test('the joiner is told where the window is going, and where from', async () => {
		const { service } = build();
		let seen: string | undefined;
		disposables.add(service.onWillChangeActiveFolder(e => { seen = `${e.from?.uri.path} -> ${e.to.uri.path}`; }));

		await service.setActiveFolder(URI.file('/w/notes'));

		assert.strictEqual(seen, '/w/api -> /w/notes');
	});

	test('the folder a move left is the previous one, while it is still a root and not where the window is', async () => {
		const { service, workspace } = build();
		const previous = () => service.previousFolder?.uri.path;
		const before = previous();
		await service.setActiveFolder(URI.file('/w/web'));
		const afterMove = previous();
		await service.setActiveFolder(URI.file('/w/notes'));
		const afterSecond = previous();
		workspace.setFolders(['/w/api', '/w/notes']);
		const gone = previous();
		// Moved from `api` to `web`, and `web` removed: the window lands on `api`, which it left
		const landedOn = build({ paths: ['/w/api', '/w/web'] });
		await landedOn.service.setActiveFolder(URI.file('/w/web'));
		landedOn.workspace.setFolders(['/w/api']);
		const whereTheWindowIs = { active: active(landedOn.service), previous: landedOn.service.previousFolder?.uri.path };

		assert.deepStrictEqual({ before, afterMove, afterSecond, gone, whereTheWindowIs }, { before: undefined, afterMove: '/w/api', afterSecond: '/w/web', gone: undefined, whereTheWindowIs: { active: '/w/api', previous: undefined } });
	});

	test('removing the active root moves to the row that took its place', async () => {
		const { service, workspace } = build();
		await service.setActiveFolder(URI.file('/w/web'));

		workspace.setFolders(['/w/api', '/w/notes']);

		// `web` was index 1; `notes` holds index 1 now, which is the row below it.
		assert.strictEqual(active(service), '/w/notes');
	});

	test('removing the last root, when that is where the window is, moves up', async () => {
		const { service, workspace } = build();
		await service.setActiveFolder(URI.file('/w/notes'));

		workspace.setFolders(['/w/api', '/w/web']);

		assert.strictEqual(active(service), '/w/web');
	});

	test('removing some other root leaves the window where it is', async () => {
		const { service, workspace } = build();
		await service.setActiveFolder(URI.file('/w/notes'));
		let changes = 0;
		disposables.add(service.onDidChangeActiveFolder(() => changes++));

		workspace.setFolders(['/w/api', '/w/notes']);

		assert.strictEqual(active(service), '/w/notes');
		assert.strictEqual(changes, 0);
	});

	test('removing every root leaves the window on none', () => {
		const { service, workspace } = build();

		workspace.setFolders([]);

		assert.strictEqual(service.activeFolder, undefined);
	});

	test('and the first root added after that is where it goes', () => {
		const { service, workspace } = build({ paths: [] });
		assert.strictEqual(service.activeFolder, undefined);

		workspace.setFolders(['/w/api', '/w/web']);

		assert.strictEqual(active(service), '/w/api');
	});

	test('a rename of the active root in the workspace file is a change', async () => {
		// ⚠️ The same root, a new object. A listener that draws the name hears about it from here,
		// not from `onDidChangeWorkspaceFolders` - the two fire in registration order.
		const { service, workspace } = build();
		let changes = 0;
		disposables.add(service.onDidChangeActiveFolder(() => changes++));

		workspace.rename('/w/api', 'the api');

		assert.strictEqual(service.activeFolder?.name, 'the api');
		assert.strictEqual(changes, 1);
	});

	test('a move is not, but the folder it reports has moved with it', async () => {
		// ⚠️ Nobody outside this service reads an index - the bar takes its order from the workspace
		// - so a reorder is not a change anyone can see. The object is still adopted, because the
		// index is what picks the neighbour when this folder is the one that goes.
		const { service, workspace } = build();
		let changes = 0;
		disposables.add(service.onDidChangeActiveFolder(() => changes++));

		workspace.setFolders(['/w/web', '/w/api', '/w/notes']);

		assert.strictEqual(service.activeFolder?.uri.path, '/w/api');
		assert.strictEqual(service.activeFolder?.index, 1);
		assert.strictEqual(changes, 0);
	});

	test('a folder added below it is not', async () => {
		const { service, workspace } = build();
		let changes = 0;
		disposables.add(service.onDidChangeActiveFolder(() => changes++));

		workspace.setFolders(['/w/api', '/w/web', '/w/notes', '/w/added']);

		assert.strictEqual(service.activeFolder?.uri.path, '/w/api');
		assert.strictEqual(changes, 0);
	});

	test('the record is per window, not per person', async () => {
		const storage = disposables.add(new InMemoryStorageService());
		await build({ storage }).service.setActiveFolder(URI.file('/w/web'));

		assert.ok(storage.get('workbench.activeFolder', StorageScope.WORKSPACE));
		assert.strictEqual(storage.get('workbench.activeFolder', StorageScope.PROFILE), undefined);
	});
});

suite('Active folder - the order a chooser offers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const folder = (path: string): IWorkspaceFolder =>
		new WorkspaceFolder({ uri: URI.file(path), index: 0, name: path.slice(path.lastIndexOf('/') + 1) });

	const api = folder('/w/api');
	const web = folder('/w/web');
	const notes = folder('/w/notes');
	const all = [api, web, notes];

	const order = (active: IWorkspaceFolder | undefined) => foldersWithActiveFirst(all, active).map(f => f.name);

	test('the folder the window is on comes first', () => {
		assert.deepStrictEqual(order(web), ['web', 'api', 'notes']);
	});

	test('and the rest keep the order the workspace has them in', () => {
		// ⚠️ That order is the `.code-workspace` file's, and people arrange it.
		assert.deepStrictEqual(order(notes), ['notes', 'api', 'web']);
	});

	test('a window already on the first folder changes nothing', () => {
		assert.deepStrictEqual(order(api), ['api', 'web', 'notes']);
	});

	test('a window on no folder changes nothing', () => {
		assert.deepStrictEqual(order(undefined), ['api', 'web', 'notes']);
	});

	test('nor does a folder that is not one of them', () => {
		assert.deepStrictEqual(order(folder('/elsewhere')), ['api', 'web', 'notes']);
	});

	test('the list handed in is not reordered in place', () => {
		foldersWithActiveFirst(all, notes);

		assert.deepStrictEqual(all.map(f => f.name), ['api', 'web', 'notes']);
	});

	suite('activeFirst - the same question asked of a list that is not folders', () => {

		test('the one that answers moves to the front, and nothing else moves', () => {
			assert.deepStrictEqual(activeFirst(['a', 'b', 'c', 'd'], x => x === 'c'), ['c', 'a', 'b', 'd']);
		});

		test('a list whose first item already answers is handed back as it is', () => {
			assert.deepStrictEqual(activeFirst(['a', 'b', 'c'], x => x === 'a'), ['a', 'b', 'c']);
		});

		test('and one where nothing answers keeps its order', () => {
			// ⚠️ Launches include the workspace\'s own `launch.json`, which belongs to no folder, and
			// the debugger takes it by index from the end. Sorting here would move it.
			assert.deepStrictEqual(activeFirst(['a', 'b', 'c'], x => x === 'z'), ['a', 'b', 'c']);
		});

		test('the list it was given is not the list it returns', () => {
			const given = ['a', 'b', 'c'];
			const back = activeFirst(given, x => x === 'b');

			assert.deepStrictEqual(given, ['a', 'b', 'c']);
			assert.deepStrictEqual(back, ['b', 'a', 'c']);
		});
	});

});
