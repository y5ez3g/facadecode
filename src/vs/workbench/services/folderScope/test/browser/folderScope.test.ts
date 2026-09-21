/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { ActiveFolderService } from '../../../activeFolder/browser/activeFolderService.js';
import { IActiveFolderService } from '../../../activeFolder/common/activeFolder.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { FolderScopeService } from '../../browser/folderScopeService.js';
import { FolderScope } from '../../common/folderScope.js';

/** A workspace whose folder list can change while the window is open. */
class MutableContextService extends TestContextService {

	private readonly _onDidChangeFolders = new Emitter<IWorkspaceFoldersChangeEvent>();
	override get onDidChangeWorkspaceFolders(): Event<IWorkspaceFoldersChangeEvent> { return this._onDidChangeFolders.event; }

	set(folders: WorkspaceFolder[]): void {
		const before = this.getWorkspace().folders;
		this.setWorkspace(new Workspace('test', folders));
		this._onDidChangeFolders.fire({
			added: folders.filter(folder => !before.some(had => had.uri.toString() === folder.uri.toString())),
			removed: before.filter(had => !folders.some(folder => folder.uri.toString() === had.uri.toString())),
			changed: []
		});
	}

	dispose(): void {
		this._onDidChangeFolders.dispose();
	}
}

suite('Folder scope - how wide the window is looking', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const api = URI.file('/w/api');
	const web = URI.file('/w/web');

	interface IWindow {
		readonly scope: FolderScopeService;
		readonly activeFolder: ActiveFolderService;
		readonly storage: TestStorageService;
		readonly folders: WorkspaceFolder[];
		readonly workspace: MutableContextService;
		/** The folders a search would cover, by name. */
		readonly covered: () => string[];
	}

	/** A window on a two-folder workspace. `storage` carries a record a previous window left. */
	function openWindow(options: { storage?: TestStorageService; folders?: URI[] } = {}): IWindow {
		const store = disposables.add(new DisposableStore());

		const folders = (options.folders ?? [api, web])
			.map((uri, index) => new WorkspaceFolder({ uri, index, name: basename(uri) }));
		const instantiationService = workbenchInstantiationService(undefined, disposables) as TestInstantiationService;
		const workspace = new MutableContextService(new Workspace('test', folders));
		store.add({ dispose: () => workspace.dispose() });
		instantiationService.stub(IWorkspaceContextService, workspace);

		const storage = options.storage ?? store.add(new TestStorageService());
		instantiationService.stub(IStorageService, storage);

		const activeFolder = store.add(instantiationService.createInstance(ActiveFolderService));
		instantiationService.stub(IActiveFolderService, activeFolder);

		const scope = store.add(instantiationService.createInstance(FolderScopeService));

		return {
			scope, activeFolder, storage, folders, workspace,
			covered: () => scope.folders().map(folder => folder.name)
		};
	}

	test('a search covers the folder the window is on', async () => {
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[1]);

		assert.deepStrictEqual(window.covered(), ['web']);
	});

	test('and follows the window to another folder', async () => {
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[1]);
		await window.activeFolder.setActiveFolder(window.folders[0]);

		assert.deepStrictEqual(window.covered(), ['api']);
	});

	test('widened, it covers every folder the workspace holds', async () => {
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[0]);
		window.scope.setScope(FolderScope.Workspace);

		assert.deepStrictEqual(window.covered(), ['api', 'web']);
	});

	test('a window on no folder at all covers everything, rather than nothing', async () => {
		// ⚠️ A search that answered with nothing there is a search that silently finds nothing.
		const window = openWindow({ folders: [] });

		assert.strictEqual(window.activeFolder.activeFolder, undefined);
		assert.deepStrictEqual(window.scope.folders().length, 0);
	});

	test('the surfaces hear about a move, because it changes what they cover', async () => {
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[0]);

		let changes = 0;
		disposables.add(window.scope.onDidChangeScope(() => changes++));

		await window.activeFolder.setActiveFolder(window.folders[1]);

		assert.strictEqual(changes, 1);
	});

	test('but not while widened, because then it does not', async () => {
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[0]);
		window.scope.setScope(FolderScope.Workspace);

		let changes = 0;
		disposables.add(window.scope.onDidChangeScope(() => changes++));

		await window.activeFolder.setActiveFolder(window.folders[1]);

		assert.strictEqual(changes, 0);
	});

	test('widening says so once, and again on the way back', async () => {
		const window = openWindow();
		let changes = 0;
		disposables.add(window.scope.onDidChangeScope(() => changes++));

		window.scope.setScope(FolderScope.Workspace);
		window.scope.setScope(FolderScope.Workspace);
		window.scope.setScope(FolderScope.Folder);

		assert.strictEqual(changes, 2);
	});

	test('a widening outlives the window that made it', async () => {
		// ⭐ A scope that resets on the next run is a scope nobody can use.
		const first = openWindow();
		first.scope.setScope(FolderScope.Workspace);

		const second = openWindow({ storage: first.storage });
		await second.activeFolder.setActiveFolder(second.folders[0]);

		assert.deepStrictEqual(second.covered(), ['api', 'web']);
	});

	test('and so does narrowing back', async () => {
		const first = openWindow();
		first.scope.setScope(FolderScope.Workspace);
		first.scope.setScope(FolderScope.Folder);

		const second = openWindow({ storage: first.storage });
		await second.activeFolder.setActiveFolder(second.folders[0]);

		assert.deepStrictEqual(second.covered(), ['api']);
	});

	test('a file is covered when it is inside a folder the window is looking at', async () => {
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[0]);

		assert.strictEqual(window.scope.covers(URI.file('/w/api/src/index.ts')), true);
		assert.strictEqual(window.scope.covers(URI.file('/w/web/src/index.ts')), false);
	});

	test('and once widened, one in any of them is', async () => {
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[0]);
		window.scope.setScope(FolderScope.Workspace);

		assert.strictEqual(window.scope.covers(URI.file('/w/web/src/index.ts')), true);
	});

	test('a file the workspace does not hold at all is covered either way', async () => {
		// ⭐ Nothing can be narrowed away by a folder it was never in, and widening would not bring
		// it back - widening only ever reaches the folders the workspace has.
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[0]);

		assert.strictEqual(window.scope.covers(URI.file('/elsewhere/index.ts')), true);

		window.scope.setScope(FolderScope.Workspace);
		assert.strictEqual(window.scope.covers(URI.file('/elsewhere/index.ts')), true);
	});

	test('and in a window with no folders, everything is', async () => {
		const window = openWindow({ folders: [] });

		assert.strictEqual(window.scope.covers(URI.file('/anywhere/index.ts')), true);
	});

	test(`⭐ a folder leaving the workspace is a change of scope, and says so`, async () => {
		// ⚠️ What `folders()` and `covers()` answer changes when the workspace's list does, not only
		// when the window moves or somebody widens. A view that is not told goes on drawing the answer
		// to a question that has been changed underneath it.
		const window = openWindow();
		window.scope.setScope(FolderScope.Workspace);

		let fired = 0;
		disposables.add(window.scope.onDidChangeScope(() => fired++));

		window.workspace.set([window.folders[0]]);

		assert.strictEqual(fired, 1);
		assert.deepStrictEqual(window.covered(), ['api']);
	});

	test('and so is one arriving', async () => {
		const window = openWindow({ folders: [api] });
		window.scope.setScope(FolderScope.Workspace);

		let fired = 0;
		disposables.add(window.scope.onDidChangeScope(() => fired++));

		window.workspace.set([
			new WorkspaceFolder({ uri: api, index: 0, name: basename(api) }),
			new WorkspaceFolder({ uri: web, index: 1, name: basename(web) })
		]);

		assert.strictEqual(fired, 1);
		assert.deepStrictEqual(window.covered(), ['api', 'web']);
	});

	test(`⭐ and a file that was hidden becomes a file from outside, which is never hidden`, async () => {
		// ⚠️ `covers` lets through anything the workspace does not hold at all. Taking a folder out
		// moves every file in it from one side of that rule to the other, without anybody moving.
		const window = openWindow();
		await window.activeFolder.setActiveFolder(window.folders[0]);
		const inWeb = URI.file('/w/web/index.ts');

		assert.strictEqual(window.scope.covers(inWeb), false);

		let fired = 0;
		disposables.add(window.scope.onDidChangeScope(() => fired++));
		window.workspace.set([window.folders[0]]);

		assert.strictEqual(window.scope.covers(inWeb), true);
		assert.strictEqual(fired, 1, 'nothing told the views the answer had changed');
	});

});
