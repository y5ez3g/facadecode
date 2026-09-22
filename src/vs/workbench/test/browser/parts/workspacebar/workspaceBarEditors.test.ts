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

/**
 * Only the four working-set calls, because they are all this class makes. The editor part hands out
 * an id per saved set and keeps every one it is given until it is told to delete one, which is what
 * the tests below are about.
 */
class TestEditorGroups {

	private next = 0;
	readonly sets: IEditorWorkingSet[] = [];
	readonly applied: (IEditorWorkingSet | 'empty')[] = [];

	get names(): string[] { return this.sets.map(set => set.name); }

	saveWorkingSet(name: string): IEditorWorkingSet {
		const set = { id: `set-${this.next++}`, name };
		this.sets.push(set);
		return set;
	}

	getWorkingSets(): IEditorWorkingSet[] {
		return this.sets;
	}

	async applyWorkingSet(workingSet: IEditorWorkingSet | 'empty', _options?: IEditorWorkingSetOptions): Promise<boolean> {
		this.applied.push(workingSet);
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

	function editorsFor(groups: TestEditorGroups, storageService: IStorageService): WorkspaceBarEditors {
		return disposables.add(new WorkspaceBarEditors(groups as unknown as IEditorGroupsService, storageService, new NullLogService()));
	}

	test('a folder has one working set however often it is left', () => {
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());

		editors.capture('file:///a');
		editors.capture('file:///a');
		editors.capture('file:///b');
		editors.capture('file:///a');

		assert.deepStrictEqual(groups.names, ['file:///b', 'file:///a']);
	});

	test('a folder nobody has opened yet starts clean', async () => {
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());

		editors.capture('file:///a');
		await editors.restore('file:///b');
		await editors.restore('file:///a');

		assert.deepStrictEqual(groups.applied, ['empty', groups.sets[0]]);
	});

	test('what was captured outlives the window that captured it', () => {
		const groups = new TestEditorGroups();
		const storageService = storage();

		editorsFor(groups, storageService).capture('file:///a');

		// Replaced rather than added to, which it can only do having read the reference back.
		editorsFor(groups, storageService).capture('file:///a');

		assert.deepStrictEqual(groups.names, ['file:///a']);
	});

	test('references the editor part no longer has are dropped', () => {
		const groups = new TestEditorGroups();
		const storageService = storage();

		editorsFor(groups, storageService).capture('file:///a');

		// The two are stored separately, so the editor part can come up without what this points at.
		groups.sets.length = 0;
		editorsFor(groups, storageService).capture('file:///a');

		assert.deepStrictEqual(groups.names, ['file:///a']);
	});

	test('a corrupt value costs the editor sets, not the bar', () => {
		const storageService = storage();
		storageService.store('workbench.workspaceBar.editorSets', 'not json', StorageScope.WORKSPACE, StorageTarget.MACHINE);

		const groups = new TestEditorGroups();
		editorsFor(groups, storageService).capture('file:///a');

		assert.deepStrictEqual(groups.names, ['file:///a']);
	});

	test('a folder that leaves the workspace takes its working set with it', () => {
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());
		editors.capture('file:///a');
		editors.capture('file:///b');

		editors.prune(new Set(['file:///b']));

		assert.deepStrictEqual(groups.names, ['file:///b']);
	});

	test('however it left - the bar, the workspace file, or an extension', () => {
		// ⚠️ The reason pruning is keyed on what the workspace holds rather than on what the bar was
		// asked to remove: a folder can go without the bar ever being told.
		const groups = new TestEditorGroups();
		const editors = editorsFor(groups, storage());
		editors.capture('file:///a');
		editors.capture('file:///b');
		editors.capture('file:///c');

		editors.prune(new Set(['file:///b']));

		assert.deepStrictEqual(groups.names, ['file:///b']);
	});

	test('and does not come back when the window does', () => {
		const shared = storage();
		const groups = new TestEditorGroups();
		editorsFor(groups, shared).capture('file:///a');
		editorsFor(groups, shared).prune(new Set());

		const later = editorsFor(groups, shared);
		later.restore('file:///a');

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
		editors.capture('file:///a');
		editors.capture('file:///b');

		editors.prune(new Set(['file:///a', 'file:///b']));

		assert.deepStrictEqual(groups.names, ['file:///a', 'file:///b']);
	});
});
