/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { EditorExtensions, IEditorFactoryRegistry, EditorCloseContext } from '../../../../common/editor.js';
import { DiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../../common/editor/sideBySideEditorInput.js';
import { IAuxiliaryWindowService } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { HeldEditorsService } from '../../../../services/heldEditors/browser/heldEditorsService.js';
import { createEditorParts, ITestInstantiationService, registerTestEditor, TestFileEditorInput, workbenchInstantiationService, workbenchTeardown } from '../../../browser/workbenchTestServices.js';

suite('Workspace bar - editors a program waits on', () => {

	const TEST_EDITOR_ID = 'workspaceBarHeldEditorsEditor';
	const TEST_EDITOR_INPUT_ID = 'workspaceBarHeldEditorsInput';

	const disposables = new DisposableStore();
	let instantiationService: ITestInstantiationService | undefined;

	setup(() => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput), new SyncDescriptor(SideBySideEditorInput)], TEST_EDITOR_INPUT_ID));
	});

	teardown(async () => {
		if (instantiationService) {
			await workbenchTeardown(instantiationService);
			instantiationService = undefined;
		}
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function input(path: string): TestFileEditorInput {
		return disposables.add(new TestFileEditorInput(URI.file(path), TEST_EDITOR_INPUT_ID));
	}

	function heldEditors(): HeldEditorsService {
		const fileService = disposables.add(new FileService(new NullLogService()));
		return new HeldEditorsService(disposables.add(new UriIdentityService(fileService)));
	}

	test('WS-50 an editor held for a waiting program stays open while another folder\'s editors are put up, and is never closed for it', async () => {
		instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		// A working set records the auxiliary windows too; this window has none.
		instantiationService.stub(IAuxiliaryWindowService, { getWindow: () => undefined });
		const parts = await createEditorParts(instantiationService, disposables);

		// The folder being gone to: one editor of its own.
		const theirs = input('/b/readme.md');
		await parts.mainPart.activeGroup.openEditor(theirs, { pinned: true });
		const theirSet = parts.saveWorkingSet('b');
		await parts.mainPart.activeGroup.closeAllEditors();

		// The folder being left: a commit message git waits on, and an ordinary file.
		const held = input('/a/.git/COMMIT_EDITMSG');
		const ordinary = input('/a/index.ts');
		const group = parts.mainPart.activeGroup;
		await group.openEditor(held, { pinned: true });
		await group.openEditor(ordinary, { pinned: true });
		const closes: { editor: EditorInput; context: EditorCloseContext }[] = [];
		disposables.add(group.onDidCloseEditor(e => closes.push({ editor: e.editor, context: e.context })));

		await parts.applyWorkingSet(theirSet, { preserveFocus: true, exclude: editor => editor === held });

		const open = parts.mainPart.groups.flatMap(g => g.editors);
		assert.deepStrictEqual({
			heldOpen: open.includes(held),
			// Put back from what was saved: an equal editor, not the same object.
			theirsOpen: open.some(editor => editor.resource?.toString() === theirs.resource.toString()),
			ordinaryOpen: open.includes(ordinary),
			heldClosed: closes.some(close => close.editor === held && close.context !== EditorCloseContext.MOVE)
		}, { heldOpen: true, theirsOpen: true, ordinaryOpen: false, heldClosed: false });

		// The editor put back from the saved set was made here, and goes with the groups.
		for (const remaining of parts.mainPart.groups) {
			await remaining.closeAllEditors();
		}
	});

	test('WS-50 held until released, on either side of a diff, however the release settles', async () => {
		const service = heldEditors();
		const message = URI.file('/a/.git/COMMIT_EDITMSG');
		const released = new DeferredPromise<void>();
		service.hold([message], released.p);

		instantiationService = workbenchInstantiationService(undefined, disposables);
		const plain = input('/a/.git/COMMIT_EDITMSG');
		const other = input('/a/index.ts');
		const diff = disposables.add(instantiationService.createInstance(DiffEditorInput, undefined, undefined, input('/a/old.ts'), input('/a/.git/COMMIT_EDITMSG'), undefined));

		const before = { plain: service.isHeld(plain), other: service.isHeld(other), diff: service.isHeld(diff) };
		released.error(new Error('the waiting program went away'));
		await released.p.catch(() => undefined);
		await Promise.resolve();

		assert.deepStrictEqual({ before, after: service.isHeld(plain) }, { before: { plain: true, other: false, diff: true }, after: false });
	});
});
