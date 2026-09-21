/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHistoryService } from '../../../../services/history/common/history.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { WorkspaceBarEditors } from '../../../../browser/parts/workspacebar/workspaceBarEditors.js';
import { WorkspaceBarModel } from '../../../../browser/parts/workspacebar/workspaceBarModel.js';
import { WorkspaceBarSwitcher } from '../../../../browser/parts/workspacebar/workspaceBarSwitcher.js';
import { ActiveFolderService } from '../../../../services/activeFolder/browser/activeFolderService.js';
import { IEditorGroupsService, IEditorWorkingSet, IEditorWorkingSetOptions } from '../../../../services/editor/common/editorGroupsService.js';

/**
 * The editor part, modelled far enough to tell a switch that went wrong from one that went right.
 *
 * ⚠️ It remembers **what is on screen**, because that is what the bug is about: `saveWorkingSet`
 * reads the live part, so a capture taken while a restore is still in flight writes the folder that
 * is leaving into the slot of the folder that is arriving. A stub that only counts calls cannot see
 * that happen.
 */
class TestEditorGroups {

	private next = 0;
	private onScreen: string = 'nothing';

	readonly saved: { key: string; held: string }[] = [];
	readonly applied: string[] = [];

	/** Set to hold a restore open, so a second switch can be made to overlap it. */
	pending: DeferredPromise<void> | undefined;

	private readonly sets = new Map<string, IEditorWorkingSet>();

	saveWorkingSet(name: string): IEditorWorkingSet {
		const set = { id: `set-${this.next++}`, name };
		this.sets.set(set.id, set);
		this.saved.push({ key: name, held: this.onScreen });
		return set;
	}

	getWorkingSets(): IEditorWorkingSet[] {
		return [...this.sets.values()];
	}

	async applyWorkingSet(workingSet: IEditorWorkingSet | 'empty', _options?: IEditorWorkingSetOptions): Promise<boolean> {
		if (this.pending) {
			await this.pending.p;
		}

		const name = workingSet === 'empty' ? 'empty' : workingSet.name;
		this.applied.push(name);
		this.onScreen = name;
		return true;
	}

	async deleteWorkingSet(workingSet: IEditorWorkingSet): Promise<boolean> {
		return this.sets.delete(workingSet.id);
	}

	/** Pretends somebody opened a tab in whatever folder is showing. */
	type(what: string): void {
		this.onScreen = what;
	}
}

/** A workspace whose folder list - and folder names - can change under the window. */
class TestContextService extends mock<IWorkspaceContextService>() {

	private readonly _onDidChangeWorkspaceFolders = new Emitter<never>();
	override readonly onDidChangeWorkspaceFolders = this._onDidChangeWorkspaceFolders.event as Event<never>;

	private folders: WorkspaceFolder[] = [];

	constructor(paths: string[]) {
		super();
		this.set(paths.map(path => ({ path, name: path.slice(path.lastIndexOf('/') + 1) })));
	}

	override getWorkspace(): IWorkspace {
		return { id: 'test', folders: this.folders, transient: false, configuration: null };
	}

	set(folders: { path: string; name: string }[]): void {
		this.folders = folders.map((folder, index) => new WorkspaceFolder({ uri: URI.file(folder.path), index, name: folder.name }));
		this._onDidChangeWorkspaceFolders.fire(undefined as never);
	}

	dispose(): void {
		this._onDidChangeWorkspaceFolders.dispose();
	}
}

class TestFileService extends mock<IFileService>() {
	override onDidChangeFileSystemProviderCapabilities = Event.None;
	override onDidChangeFileSystemProviderRegistrations = Event.None;
	override async exists(): Promise<boolean> { return true; }
	override hasProvider(): boolean { return true; }
	override hasCapability(): boolean { return true; }
	override async realpath(resource: URI): Promise<URI | undefined> { return resource; }
}

suite('Workspace bar - switching, as one piece of work', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface IWindow {
		readonly switcher: WorkspaceBarSwitcher;
		readonly groups: TestEditorGroups;
		readonly workspace: TestContextService;
		readonly folders: readonly IWorkspaceFolder[];
		readonly go: (folder: IWorkspaceFolder) => Promise<void>;
	}

	function openWindow(paths: string[] = ['/w/a', '/w/b', '/w/c']): IWindow {
		const store = disposables.add(new DisposableStore());

		const workspace = new TestContextService(paths);
		store.add({ dispose: () => workspace.dispose() });

		const fileService = new TestFileService();
		const uriIdentityService = store.add(new UriIdentityService(fileService));
		const storageService = store.add(new InMemoryStorageService());
		const logService = new NullLogService();

		const historyService = new class extends mock<IHistoryService>() {
			override getLastActiveWorkspaceRoot(): URI | undefined { return undefined; }
		};
		const activeFolderService = store.add(new ActiveFolderService(workspace, storageService, uriIdentityService, historyService));

		const groups = new TestEditorGroups();
		const editors = store.add(new WorkspaceBarEditors(groups as unknown as IEditorGroupsService, storageService, logService));

		// ⚠️ The switcher only asks the model to re-read what is reachable, so nothing here edits the
		// workspace; an editing service that is never called is the honest stand-in.
		const model = store.add(new WorkspaceBarModel(
			workspace,
			new class extends mock<IWorkspaceEditingService>() { },
			fileService,
			uriIdentityService
		));

		const switcher = store.add(new WorkspaceBarSwitcher(
			model,
			editors,
			activeFolderService,
			fileService,
			new class extends mock<INotificationService>() { override error() { } } as INotificationService,
			logService,
			uriIdentityService
		));

		return {
			switcher, groups, workspace,
			folders: workspace.getWorkspace().folders,
			go: folder => activeFolderService.setActiveFolder(folder)
		};
	}

	test('⭐ renaming the folder the window is on does not put its old editors back', async () => {
		// ⚠️ `reconcile` fires the same event for "the window moved" and "this root was renamed",
		// because the name is drawn in the title and the explorer's header. Restoring on the second
		// one throws away the tabs that are on screen and puts back whatever was saved last time -
		// or nothing at all, for a folder that has never been left.
		const window = openWindow();
		await window.go(window.folders[0]);
		window.groups.type('what the person has open');

		const applied = window.groups.applied.length;
		window.workspace.set([{ path: '/w/a', name: 'renamed' }, { path: '/w/b', name: 'b' }, { path: '/w/c', name: 'c' }]);
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.strictEqual(window.groups.applied.length, applied, 'a rename restored something');
	});

	test('and the window is still on that folder afterwards', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);

		window.workspace.set([{ path: '/w/a', name: 'renamed' }, { path: '/w/b', name: 'b' }, { path: '/w/c', name: 'c' }]);
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.strictEqual(window.switcher.active?.path, '/w/a');
	});
	test(`⭐ a second switch does not capture the folder it is leaving under the wrong name`, async () => {
		// ⚠️ `switchTo` resolves as soon as the active folder has moved - the restore that follows is
		// started and not waited for. So a switch can be complete, and awaited, while the editors of
		// the folder it arrived at are still not on screen. Switching again then captures whatever is
		// there, which is the folder before last, and writes it into this folder's slot.
		const window = openWindow();
		await window.go(window.folders[0]);
		window.groups.type('a-tabs');

		window.groups.pending = new DeferredPromise<void>();
		await window.go(window.folders[1]);          // b: complete, but its editors are still coming
		const toC = window.go(window.folders[2]);    // c: must not capture b from a screen holding a

		window.groups.pending.complete();
		window.groups.pending = undefined;
		await toC;

		const forB = window.groups.saved.filter(save => save.key.endsWith('/w/b'));
		assert.strictEqual(forB.length, 1, 'b was never captured on the way out');
		assert.notStrictEqual(forB[0].held, 'a-tabs', 'b was saved holding the previous folder\'s editors');
	});

	test('and the editors that end up on screen are the ones the window ended on', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);

		window.groups.pending = new DeferredPromise<void>();
		await window.go(window.folders[1]);
		const toC = window.go(window.folders[2]);
		window.groups.pending.complete();
		window.groups.pending = undefined;
		await toC;
		await new Promise(resolve => setTimeout(resolve, 0));

		const last = window.groups.applied[window.groups.applied.length - 1];
		assert.ok(last.endsWith('/w/c') || last === 'empty', `ended showing ${last}`);
		assert.strictEqual(window.switcher.active?.path, '/w/c');
	});
});
