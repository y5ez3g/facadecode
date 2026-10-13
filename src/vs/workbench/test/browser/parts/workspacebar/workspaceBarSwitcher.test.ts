/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createFileSystemProviderError, FileSystemProviderErrorCode, IFileService, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
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
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';

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
	readonly groups = [{ whenRestored: Promise.resolve() }];

	readonly saved: { key: string; held: string }[] = [];
	readonly applied: string[] = [];

	/** Set to hold a restore open, so a second switch can be made to overlap it. */
	pending: DeferredPromise<void> | undefined;

	/** Set to make the next capture throw, or the next restore be declined. */
	failCapture = false;
	declineRestore = false;

	private readonly sets = new Map<string, IEditorWorkingSet>();

	saveWorkingSet(name: string): IEditorWorkingSet {
		if (this.failCapture) {
			throw new Error('the editors could not be read');
		}
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

		if (this.declineRestore) {
			return false;
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
	/** Paths whose read fails, with what it fails with. Everything else is there. */
	readonly failing = new Map<string, Error>();
	override async exists(): Promise<boolean> { return true; }
	override async stat(resource: URI): Promise<IFileStatWithPartialMetadata> {
		const failure = this.failing.get(resource.path);
		if (failure) {
			throw failure;
		}
		return upcastPartial<IFileStatWithPartialMetadata>({ resource, isDirectory: true });
	}
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
		/** The parts the window was told to focus, in order. */
		readonly focused: Parts[];
		/** The element standing for each part where work is done, in the page so focus can reach it. */
		readonly containers: Map<Parts, HTMLElement>;
		/** What the window told the person, in order. */
		readonly said: string[];
		readonly disk: TestFileService;
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
		const editors = store.add(new WorkspaceBarEditors(groups as unknown as IEditorGroupsService, storageService, logService, { getEditors: () => [] } as unknown as IEditorService, uriIdentityService, { createModelReference: async () => ({ object: {}, dispose: () => { } }) } as unknown as ITextModelService));

		// ⚠️ The switcher only asks the model to re-read what is reachable, so nothing here edits the
		// workspace; an editing service that is never called is the honest stand-in.
		const model = store.add(new WorkspaceBarModel(
			workspace,
			new class extends mock<IWorkspaceEditingService>() { },
			fileService,
			uriIdentityService
		));

		const focused: Parts[] = [];
		const containers = new Map<Parts, HTMLElement>();
		for (const part of [Parts.EDITOR_PART, Parts.PANEL_PART]) {
			const element = mainWindow.document.createElement('div');
			element.appendChild(mainWindow.document.createElement('input'));
			mainWindow.document.body.appendChild(element);
			containers.set(part, element);
			store.add({ dispose: () => element.remove() });
		}
		const layoutService = new class extends mock<IWorkbenchLayoutService>() {
			override getContainer(_window: Window, part?: Parts): HTMLElement {
				return part ? containers.get(part)! : mainWindow.document.body;
			}
			override focusPart(part: Parts): void { focused.push(part); }
		};

		const said: string[] = [];
		const switcher = store.add(new WorkspaceBarSwitcher(
			model,
			editors,
			activeFolderService,
			fileService,
			new class extends mock<INotificationService>() {
				override error(message: string) { said.push(message); return undefined!; }
				override info(message: string) { said.push(message); return undefined!; }
			} as INotificationService,
			logService,
			uriIdentityService,
			layoutService
		));

		return {
			switcher, groups, workspace, focused, containers, said,
			disk: fileService,
			folders: workspace.getWorkspace().folders,
			go: folder => activeFolderService.setActiveFolder(folder)
		};
	}

	test('WS-57 the latest request wins: one still waiting is cancelled without running, one running finishes first, and the window ends on the last', async () => {
		const window = openWindow(['/w/a', '/w/b', '/w/c', '/w/d']);
		await window.go(window.folders[0]);

		window.groups.pending = new DeferredPromise<void>();
		const toB = window.switcher.switchTo(window.folders[1].uri);
		await new Promise(resolve => setTimeout(resolve, 0));
		const toC = window.switcher.switchTo(window.folders[2].uri);
		const toD = window.switcher.switchTo(window.folders[3].uri);
		window.groups.pending.complete();
		window.groups.pending = undefined;

		assert.deepStrictEqual({
			results: [(await toB).kind, (await toC).kind, (await toD).kind],
			ended: window.switcher.active?.path,
			neverShown: window.groups.applied.some(applied => applied.endsWith('/w/c'))
		}, { results: ['shown', 'cancelled', 'shown'], ended: '/w/d', neverShown: false });
	});

	test('WS-15 asking for the folder the window is on does nothing: nothing kept, nothing put back, nothing said', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);
		let changes = 0;
		disposables.add(window.switcher.onDidChangeActive(() => changes++));
		const before = { saved: window.groups.saved.length, applied: window.groups.applied.length };

		const result = await window.switcher.switchTo(window.folders[0].uri);

		assert.deepStrictEqual({ result: result.kind, saved: window.groups.saved.length - before.saved, applied: window.groups.applied.length - before.applied, changes }, { result: 'shown', saved: 0, applied: 0, changes: 0 });
	});

	test('WS-58 a capture that fails keeps the window where it was; a restore that fails stays on the folder asked for, and both say so', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);

		window.groups.failCapture = true;
		const capture = await window.switcher.switchTo(window.folders[1].uri);
		const afterCapture = window.switcher.active?.path;
		window.groups.failCapture = false;

		window.groups.declineRestore = true;
		const restore = await window.switcher.switchTo(window.folders[2].uri);
		window.groups.declineRestore = false;

		assert.deepStrictEqual({ capture: capture.kind, afterCapture, restore: restore.kind, afterRestore: window.switcher.active?.path }, {
			capture: 'failed', afterCapture: '/w/a', restore: 'failed', afterRestore: '/w/c'
		});
	});

	test('WS-61 a folder added for a switch that does not happen is said to be in the workspace, with its path; after a restore that fails the window is on it, and that is not said', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);
		const [, b, c] = window.folders.map(folder => folder.uri);

		window.groups.failCapture = true;
		const stayed = await window.switcher.switchTo(b, [b]);
		window.groups.failCapture = false;

		window.groups.declineRestore = true;
		const moved = await window.switcher.switchTo(c, [c]);
		window.groups.declineRestore = false;

		assert.deepStrictEqual({ stayed: stayed.kind, moved: moved.kind, on: window.switcher.active?.path, added: window.said.filter(message => /added/i.test(message)) }, {
			stayed: 'failed', moved: 'failed', on: '/w/c',
			added: [`Folder '${b.fsPath}' was added to the workspace, but could not be switched to.`]
		});
	});

	test('WS-61 several added for one switch are all named, with the folder the window could not get to', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);
		const [, b, c] = window.folders.map(folder => folder.uri);

		window.groups.failCapture = true;
		await window.switcher.switchTo(c, [b, c]);
		window.groups.failCapture = false;

		assert.deepStrictEqual(window.said.filter(message => /added/i.test(message)), [`Added folders to the workspace: ${b.fsPath}, ${c.fsPath}. Failed to switch to '${c.fsPath}'.`]);
	});

	test('WS-63 a folder that cannot be read is said to be unreadable, not gone, and one that is gone is said to be gone; the window stays where it was', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);
		const [, b, c] = window.folders.map(folder => folder.uri);
		window.disk.failing.set(b.path, createFileSystemProviderError('connection lost', FileSystemProviderErrorCode.Unavailable));
		window.disk.failing.set(c.path, createFileSystemProviderError('nothing there', FileSystemProviderErrorCode.FileNotFound));

		const unreadable = await window.switcher.switchTo(b);
		const gone = await window.switcher.switchTo(c);

		assert.deepStrictEqual({ unreadable: unreadable.kind, gone: gone.kind, on: window.switcher.active?.path, said: window.said }, {
			unreadable: 'failed', gone: 'failed', on: '/w/a',
			said: [`Failed to read folder '${b.fsPath}': connection lost`, `Folder '${c.fsPath}' no longer exists on disk.`]
		});
	});

	test('WS-52 the focus goes back where it was when the folder was left, and to the editor on a first visit', async () => {
		const window = openWindow();
		await window.go(window.folders[0]);
		// What focusing a terminal sends; dispatched, as a test window need not have the system's focus.
		window.containers.get(Parts.PANEL_PART)!.firstChild!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

		await window.switcher.switchTo(window.folders[1].uri);
		await window.switcher.switchTo(window.folders[0].uri);

		assert.deepStrictEqual(window.focused, [Parts.EDITOR_PART, Parts.PANEL_PART]);
	});

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
