/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { WorkspaceBarEditors } from '../../../../browser/parts/workspacebar/workspaceBarEditors.js';
import { IEditorGroupsService, IEditorWorkingSet, IEditorWorkingSetOptions } from '../../../../services/editor/common/editorGroupsService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { TextResourceEditorInput } from '../../../../common/editor/textResourceEditorInput.js';
import { workbenchInstantiationService } from '../../workbenchTestServices.js';

/**
 * Only the four working-set calls, because they are all this class makes. The editor part hands out
 * an id per saved set and keeps every one it is given until it is told to delete one, which is what
 * the tests below are about.
 */
class TestEditorGroups {

	private next = 0;
	readonly sets: IEditorWorkingSet[] = [];
	readonly applied: (IEditorWorkingSet | 'empty')[] = [];
	readonly options: (IEditorWorkingSetOptions | undefined)[] = [];
	/** The groups after a working set is applied: each says when its active editor has its contents. */
	groups: { whenRestored: Promise<void> }[] = [{ whenRestored: Promise.resolve() }];

	get names(): string[] { return this.sets.map(set => set.name); }

	saveWorkingSet(name: string): IEditorWorkingSet {
		const set = { id: `set-${this.next++}`, name };
		this.sets.push(set);
		return set;
	}

	getWorkingSets(): IEditorWorkingSet[] {
		return this.sets;
	}

	async applyWorkingSet(workingSet: IEditorWorkingSet | 'empty', options?: IEditorWorkingSetOptions): Promise<boolean> {
		this.applied.push(workingSet);
		this.options.push(options);
		return true;
	}

	async deleteWorkingSet(workingSet: IEditorWorkingSet): Promise<boolean> {
		const at = this.sets.findIndex(set => set.id === workingSet.id);
		if (at === -1) {
			return false;
		}

		this.sets.splice(at, 1);
		return true;
	}
}

suite('Workspace bar - folder editors', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function storage(): IStorageService {
		return disposables.add(new InMemoryStorageService());
	}

	/** A text model service that hands out references and says which it gave out and which came back. */
	function models() {
		const held: string[] = [];
		const released: string[] = [];
		const service = {
			createModelReference: async (resource: URI) => {
				held.push(resource.path);
				return { object: {}, dispose: () => { released.push(resource.path); } };
			}
		} as unknown as ITextModelService;
		return { held, released, service };
	}

	function editorsFor(groups: TestEditorGroups, storageService: IStorageService, open: EditorInput[] = [], textModelService: ITextModelService = models().service): WorkspaceBarEditors {
		const uriIdentityService = disposables.add(new UriIdentityService(disposables.add(new FileService(new NullLogService()))));
		const editorService = { getEditors: () => open.map(editor => ({ editor, groupId: 1 })) } as unknown as IEditorService;
		return disposables.add(new WorkspaceBarEditors(groups as unknown as IEditorGroupsService, storageService, new NullLogService(), editorService, uriIdentityService, textModelService));
	}

	test('WS-52 putting a folder\'s editors up is done once each group\'s editor has its contents, so the focus has somewhere to go', async () => {
		const groups = new TestEditorGroups();
		const resolved = new DeferredPromise<void>();
		groups.groups = [{ whenRestored: Promise.resolve() }, { whenRestored: resolved.p }];
		const editors = editorsFor(groups, storage());

		let done = false;
		const restored = editors.restore(URI.parse('file:///b')).then(() => { done = true; });
		await timeout(0);
		const before = done;
		resolved.complete();
		await restored;

		assert.deepStrictEqual({ before, after: done }, { before: false, after: true });
	});

	test('W13 a folder\'s open text files stay loaded while it is out of sight, and are let go once its editors are back, or once it leaves', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		const text = disposables.add(instantiationService.createInstance(TextResourceEditorInput, URI.file('/w/a/x.ts'), undefined, undefined, undefined, undefined));
		const a = URI.parse('file:///w/a');
		const b = URI.parse('file:///w/b');

		const back = models();
		const comesBack = editorsFor(new TestEditorGroups(), storage(), [text], back.service);
		comesBack.capture(a);
		await comesBack.restore(b);
		await timeout(0);
		const away = { held: [...back.held], released: [...back.released] };
		comesBack.capture(b);
		await comesBack.restore(a);
		await timeout(0);

		const gone = models();
		const leaves = editorsFor(new TestEditorGroups(), storage(), [text], gone.service);
		leaves.capture(a);
		await leaves.restore(b);
		await timeout(0);
		leaves.prune(new Set(['file:///w/b']));

		assert.deepStrictEqual({ away, back: back.released, gone: gone.released }, {
			away: { held: ['/w/a/x.ts'], released: [] },
			// a's let go once its own editors are up; b's - the same file, open there too - kept while b is away
			back: ['/w/a/x.ts'],
			gone: ['/w/a/x.ts']
		});
	});

	test('a folder has one working set however often it is left', () => {
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());

		editors.capture(URI.parse('file:///a'));
		editors.capture(URI.parse('file:///a'));
		editors.capture(URI.parse('file:///b'));
		editors.capture(URI.parse('file:///a'));

		assert.deepStrictEqual(groups.names, ['file:///b', 'file:///a']);
	});

	test('a folder nobody has opened yet starts clean', async () => {
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());

		editors.capture(URI.parse('file:///a'));
		await editors.restore(URI.parse('file:///b'));
		await editors.restore(URI.parse('file:///a'));

		assert.deepStrictEqual(groups.applied, ['empty', groups.sets[0]]);
	});

	test('what was captured outlives the window that captured it', () => {
		const groups = new TestEditorGroups();
		const storageService = storage();

		editorsFor(groups, storageService).capture(URI.parse('file:///a'));

		// Replaced rather than added to, which it can only do having read the reference back.
		editorsFor(groups, storageService).capture(URI.parse('file:///a'));

		assert.deepStrictEqual(groups.names, ['file:///a']);
	});

	test('references the editor part no longer has are dropped', () => {
		const groups = new TestEditorGroups();
		const storageService = storage();

		editorsFor(groups, storageService).capture(URI.parse('file:///a'));

		// The two are stored separately, so the editor part can come up without what this points at.
		groups.sets.length = 0;
		editorsFor(groups, storageService).capture(URI.parse('file:///a'));

		assert.deepStrictEqual(groups.names, ['file:///a']);
	});

	test('a corrupt value costs the editor sets, not the bar', () => {
		const storageService = storage();
		storageService.store('workbench.workspaceBar.editorSets', 'not json', StorageScope.WORKSPACE, StorageTarget.MACHINE);

		const groups = new TestEditorGroups();
		editorsFor(groups, storageService).capture(URI.parse('file:///a'));

		assert.deepStrictEqual(groups.names, ['file:///a']);
	});

	test('a folder that leaves the workspace takes its working set with it', () => {
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());
		editors.capture(URI.parse('file:///a'));
		editors.capture(URI.parse('file:///b'));

		editors.prune(new Set(['file:///b']));

		assert.deepStrictEqual(groups.names, ['file:///b']);
	});

	test('however it left - the bar, the workspace file, or an extension', () => {
		// ⚠️ The reason pruning is keyed on what the workspace holds rather than on what the bar was
		// asked to remove: a folder can go without the bar ever being told.
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());
		editors.capture(URI.parse('file:///a'));
		editors.capture(URI.parse('file:///b'));
		editors.capture(URI.parse('file:///c'));

		editors.prune(new Set(['file:///b']));

		assert.deepStrictEqual(groups.names, ['file:///b']);
	});

	test('and does not come back when the window does', () => {
		const shared = storage();
		const groups = new TestEditorGroups();
		editorsFor(groups, shared).capture(URI.parse('file:///a'));
		editorsFor(groups, shared).prune(new Set());

		const later = editorsFor(groups, shared);
		later.restore(URI.parse('file:///a'));

		assert.deepStrictEqual(groups.applied, ['empty']);
	});

	test('a folder nobody opened has nothing to prune', () => {
		const groups = new TestEditorGroups();

		editorsFor(groups, storage()).prune(new Set(['file:///never']));

		assert.deepStrictEqual(groups.names, []);
	});

	test('pruning nothing does not touch the sets that are staying', () => {
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());
		editors.capture(URI.parse('file:///a'));
		editors.capture(URI.parse('file:///b'));

		editors.prune(new Set(['file:///a', 'file:///b']));

		assert.deepStrictEqual(groups.names, ['file:///a', 'file:///b']);
	});
});
