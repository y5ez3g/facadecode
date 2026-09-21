/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IStorageService, StorageScope, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { basename } from '../../../../../base/common/resources.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { ActiveFolderService } from '../../../../services/activeFolder/browser/activeFolderService.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ISCMViewServiceState, SCMViewService } from '../../browser/scmViewService.js';
import { ISCMProvider, ISCMRepository, ISCMRepositorySortKey, ISCMService, ISCMViewVisibleRepositoryChangeEvent } from '../../common/scm.js';

/** The repositories the git extension has opened, and nothing else the view service asks for. */
class TestSCMService extends mock<ISCMService>() {

	private readonly _onDidAddRepository = new Emitter<ISCMRepository>();
	override readonly onDidAddRepository = this._onDidAddRepository.event;

	private readonly _onDidRemoveRepository = new Emitter<ISCMRepository>();
	override readonly onDidRemoveRepository = this._onDidRemoveRepository.event;

	private readonly _repositories: ISCMRepository[] = [];
	override get repositories(): Iterable<ISCMRepository> { return this._repositories; }
	override get repositoryCount(): number { return this._repositories.length; }

	/** Only reached through an active editor, which these tests do not open. */
	override getRepository(): ISCMRepository | undefined { return undefined; }

	add(repository: ISCMRepository): void {
		this._repositories.push(repository);
		this._onDidAddRepository.fire(repository);
	}

	remove(repository: ISCMRepository): void {
		this._repositories.splice(this._repositories.indexOf(repository), 1);
		this._onDidRemoveRepository.fire(repository);
	}

	dispose(): void {
		this._onDidAddRepository.dispose();
		this._onDidRemoveRepository.dispose();
	}
}

suite('SCM view service - which repositories the window shows', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const apiFolder = URI.file('/w/api');
	const webFolder = URI.file('/w/web');
	/** Last by name, so a test can remove it without touching which repository sorts first. */
	const zedFolder = URI.file('/w/zed');
	/** In the workspace, with no repository in it: somewhere the window can be with nothing to show. */
	const notesFolder = URI.file('/w/notes');

	/** A repository rooted at `root`, carrying only what the view service reads. */
	function repository(root: URI, name: string): ISCMRepository {
		const provider = new class extends mock<ISCMProvider>() {
			override readonly id = name;
			override readonly providerId = 'git';
			override readonly label = name;
			override readonly name = name;
			override readonly rootUri = root;
		};

		return new class extends mock<ISCMRepository>() {
			override readonly id = name;
			override readonly provider = provider;
		};
	}

	interface IWindow {
		readonly view: SCMViewService;
		readonly scm: TestSCMService;
		readonly activeFolder: ActiveFolderService;
		readonly storage: TestStorageService;
		readonly folders: IWorkspaceFolder[];
		/** The repository rooted at that folder. */
		readonly repositoryIn: (folder: IWorkspaceFolder) => ISCMRepository;
		/** What the views would be showing, by name. */
		readonly onScreen: () => string[];
		/** What the person has chosen, by name, whichever folder it is in. */
		readonly chosen: () => string[];
		readonly go: (folder: IWorkspaceFolder) => Promise<void>;
		readonly remember: () => ISCMViewServiceState | undefined;
	}

	/**
	 * A window on a three-folder workspace.
	 *
	 * ⚠️ `storage` can be handed in, which is how a second window reads what the first wrote: the
	 * record of which repositories the person chose outlives the window that wrote it.
	 */
	function openWindow(options: { folders?: URI[]; repositories?: URI[]; storage?: TestStorageService } = {}): IWindow {
		const store = disposables.add(new DisposableStore());

		const workspace = new Workspace('test', (options.folders ?? [apiFolder, webFolder, notesFolder])
			.map((uri, index) => new WorkspaceFolder({ uri, index, name: basename(uri) })));
		const instantiationService = workbenchInstantiationService(undefined, disposables) as TestInstantiationService;
		instantiationService.stub(IWorkspaceContextService, new TestContextService(workspace));

		const storage = options.storage ?? store.add(new TestStorageService());
		instantiationService.stub(IStorageService, storage);

		const activeFolder = store.add(instantiationService.createInstance(ActiveFolderService));
		instantiationService.stub(IActiveFolderService, activeFolder);

		const scm = new TestSCMService();
		store.add({ dispose: () => scm.dispose() });
		instantiationService.stub(ISCMService, scm);

		for (const root of options.repositories ?? [apiFolder, webFolder]) {
			scm.add(repository(root, root.path.slice(root.path.lastIndexOf('/') + 1)));
		}

		const view = instantiationService.createInstance(SCMViewService);
		store.add({ dispose: () => view.dispose() });

		// The record is only kept once the repositories are all in, which in a real window is a
		// debounce away. Nothing here is waiting for a timer.
		view.didFinishLoadingRepositories.set(true, undefined);

		return {
			view, scm, activeFolder, storage,
			folders: workspace.folders,
			repositoryIn: folder => view.repositories.find(r => r.provider.name === basename(folder.uri))!,
			onScreen: () => view.visibleRepositories.map(r => r.provider.name),
			// ⚠️ Sorted: repositories discovered within one millisecond of each other come back in an
			// order this test has no business depending on.
			chosen: () => view.repositories.filter(r => view.isVisible(r)).map(r => r.provider.name).sort(),
			go: folder => activeFolder.setActiveFolder(folder),
			remember: () => {
				storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
				const stored = storage.get('scm:view:visibleRepositories', StorageScope.WORKSPACE);
				return stored ? JSON.parse(stored) as ISCMViewServiceState : undefined;
			}
		};
	}

	/** The names the stored record counts as chosen. */
	function rememberedAsChosen(state: ISCMViewServiceState | undefined): string[] {
		return (state?.visible ?? []).map(index => state!.all[index].split(':')[1]).sort();
	}

	test('the views show the repositories of the folder the window is on', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);

		assert.deepStrictEqual(window.onScreen(), ['api']);
	});

	test('a switch changes what they show', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);
		await window.go(window.folders[1]);

		assert.deepStrictEqual(window.onScreen(), ['web']);
	});

	test('and says so as a diff, because the views keep a tree', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);

		const events: ISCMViewVisibleRepositoryChangeEvent[] = [];
		disposables.add(window.view.onDidChangeVisibleRepositories(e => events.push(e)));

		await window.go(window.folders[1]);

		assert.strictEqual(events.length, 1);
		assert.deepStrictEqual([...events[0].added].map(r => r.provider.name), ['web']);
		assert.deepStrictEqual([...events[0].removed].map(r => r.provider.name), ['api']);
	});

	test('a folder with no repository in it shows nothing, and loses nothing', async () => {
		const window = openWindow();
		await window.go(window.folders[2]);

		assert.deepStrictEqual(window.onScreen(), []);
		assert.deepStrictEqual(window.chosen(), ['api', 'web']);
	});

	test('the active repository is the one in the folder the window is on', async () => {
		const window = openWindow();
		await window.go(window.folders[1]);

		assert.strictEqual(window.view.activeRepository.get()?.repository.provider.name, 'web');
	});

	test('and there is none while the window is on a folder without one', async () => {
		// ⚠️ What the Graph and the status bar follow. Left defined, they go on drawing the folder
		// the window has left.
		const window = openWindow();
		await window.go(window.folders[0]);
		await window.go(window.folders[2]);

		assert.strictEqual(window.view.activeRepository.get(), undefined);
	});

	test('a switch does not change what the person has chosen', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);

		assert.deepStrictEqual(window.chosen(), ['api', 'web']);
	});

	test('what is written down is the choice, not what was on screen', async () => {
		// ⭐ The record outlives the window. Writing what was on screen records the folder the
		// window was closed on as a deselection of every other folder's repository.
		const window = openWindow();
		await window.go(window.folders[1]);

		assert.deepStrictEqual(rememberedAsChosen(window.remember()), ['api', 'web']);
	});

	test('so a window that comes back still has the folders it was not on', async () => {
		const first = openWindow();
		await first.go(first.folders[1]);
		first.remember();
		first.view.dispose();

		const second = openWindow({ storage: first.storage });
		await second.go(second.folders[0]);

		assert.deepStrictEqual(second.onScreen(), ['api']);
	});

	test('a repository the person turned off stays off, and is not turned back on by a switch', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);
		window.view.toggleVisibility(window.repositoryIn(window.folders[0]), false);

		assert.deepStrictEqual(window.onScreen(), []);

		await window.go(window.folders[1]);
		assert.deepStrictEqual(window.onScreen(), ['web']);

		await window.go(window.folders[0]);
		assert.deepStrictEqual(window.onScreen(), []);
	});

	test('and that is what is written down too', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);
		window.view.toggleVisibility(window.repositoryIn(window.folders[0]), false);

		assert.deepStrictEqual(rememberedAsChosen(window.remember()), ['web']);
	});

	test('removing a repository does not turn one back on in a folder the window is not even in', async () => {
		// ⚠️ Upstream keeps something selected by asking whether anything is on screen. Narrowed, that
		// question answers "no" whenever the window is on a folder with no repository, and the answer
		// is to select the first repository there is - undoing the person's choice in a folder they
		// are not looking at.
		const window = openWindow({
			folders: [apiFolder, webFolder, zedFolder, notesFolder],
			repositories: [apiFolder, webFolder, zedFolder]
		});
		// ⚠️ By name, so that "the first repository there is" is a fact and not a race: repositories
		// discovered within one millisecond of each other sort by nothing in particular.
		window.view.toggleSortKey(ISCMRepositorySortKey.Name);

		window.view.toggleVisibility(window.repositoryIn(window.folders[0]), false);
		await window.go(window.folders[3]);

		window.scm.remove(window.repositoryIn(window.folders[2]));

		assert.deepStrictEqual(window.chosen(), ['web']);
		assert.deepStrictEqual(window.onScreen(), []);
	});
});
