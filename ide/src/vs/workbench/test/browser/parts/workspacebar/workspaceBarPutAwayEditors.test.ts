/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { WorkspaceBarEditors } from '../../../../browser/parts/workspacebar/workspaceBarEditors.js';
import { EditorExtensions, EditorsOrder, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IAuxiliaryWindowService } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { EditorService } from '../../../../services/editor/browser/editorService.js';
import { IHeldEditorsService } from '../../../../services/heldEditors/common/heldEditors.js';
import { IPutAwayEditorsService } from '../../../../services/putAwayEditors/common/putAwayEditors.js';
import { UntitledTextEditorInput } from '../../../../services/untitled/common/untitledTextEditorInput.js';
import { UntitledTextEditorInputSerializer } from '../../../../services/untitled/common/untitledTextEditorHandler.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { createEditorParts, ITestInstantiationService, registerTestEditor, TestFileEditorInput, workbenchInstantiationService, workbenchTeardown } from '../../workbenchTestServices.js';

suite('Workspace bar - unsaved editors put away with their folder', () => {

	const TEST_EDITOR_ID = 'workspaceBarPutAwayEditor';
	const TEST_EDITOR_INPUT_ID = 'workspaceBarPutAwayInput';

	const disposables = new DisposableStore();
	let instantiationService: ITestInstantiationService | undefined;

	setup(() => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput)], TEST_EDITOR_INPUT_ID));
	});

	teardown(async () => {
		if (instantiationService) {
			await workbenchTeardown(instantiationService);
			instantiationService = undefined;
		}
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** An editor of `path` with no verified way back once closed: a notebook's or a custom editor's, say. */
	function other(path: string, dirty = false): TestFileEditorInput {
		const editor = disposables.add(new TestFileEditorInput(URI.file(path), TEST_EDITOR_INPUT_ID));
		editor.dirty = dirty;
		return editor;
	}

	async function window() {
		const services = instantiationService = workbenchInstantiationService(undefined, disposables);
		const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);
		services.invokeFunction(accessor => registry.start(accessor));
		// After `start`, so this window's instantiation service makes the serializer
		disposables.add(registry.registerEditorSerializer(UntitledTextEditorInput.ID, UntitledTextEditorInputSerializer));
		// A working set records the auxiliary windows too; this window has none.
		services.stub(IAuxiliaryWindowService, { getWindow: () => undefined });
		const parts = await createEditorParts(services, disposables);
		services.stub(IEditorGroupsService, parts);
		const editorService = disposables.add(services.createInstance(EditorService, undefined));
		services.stub(IEditorService, editorService);
		services.stub(IHeldEditorsService, { isHeld: () => false });
		const untitled = services.invokeFunction(accessor => accessor.get(IUntitledTextEditorService));

		return {
			parts,
			editors: disposables.add(services.createInstance(WorkspaceBarEditors)),
			putAway: services.invokeFunction(accessor => accessor.get(IPutAwayEditorsService)),
			untitled,
			/** Every editor on screen, by its file. */
			onScreen: () => editorService.getEditors(EditorsOrder.SEQUENTIAL).map(({ editor }) => editor.resource?.path ?? '').sort(),
			/** The untitled editors on screen with unsaved changes. */
			unsavedOnScreen: () => editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => editor instanceof UntitledTextEditorInput && editor.isDirty()).map(({ editor }) => editor.resource?.path ?? '').sort(),
			/** An untitled editor with unsaved changes, open in the folder the window is on. */
			draft: async (text: string) => {
				const draft = disposables.add(services.createInstance(UntitledTextEditorInput, untitled.create()));
				await parts.mainPart.activeGroup.openEditor(draft, { pinned: true });
				(await draft.resolve()).textEditorModel?.setValue(text);
				return draft;
			},
			close: async () => {
				for (const group of parts.mainPart.groups) {
					for (const editor of group.editors) {
						if (editor instanceof TestFileEditorInput) {
							editor.dirty = false;
						}
					}
					await group.closeAllEditors();
				}
			}
		};
	}

	test('WS-17 a working set applied with putAway closes an unsaved editor without asking, saving or reverting it; one it leaves out stays on screen', async () => {
		const { parts, close } = await window();
		const away = other('/w/a/draft.ts', true);
		const stays = other('/w/a/notes.ipynb', true);
		await parts.mainPart.activeGroup.openEditor(away, { pinned: true });
		await parts.mainPart.activeGroup.openEditor(stays, { pinned: true });

		await parts.applyWorkingSet('empty', { preserveFocus: true, putAway: editor => editor === away });

		const open = parts.mainPart.groups.flatMap(group => group.editors);
		assert.deepStrictEqual(
			{ awayOpen: open.includes(away), staysOpen: open.includes(stays), awayUnsaved: away.isDirty(), saved: away.gotSaved, reverted: away.gotReverted },
			{ awayOpen: false, staysOpen: true, awayUnsaved: true, saved: false, reverted: false });

		await close();
	});

	test('WS-17 leaving a folder puts its unsaved untitled editor away, unsaved and without a question, and coming back brings it back; an editor with no way back follows the window', async () => {
		const { parts, editors, putAway, untitled, onScreen, unsavedOnScreen, draft: open, close } = await window();
		const a = URI.file('/w/a');
		const b = URI.file('/w/b');

		const draft = await open('an unsaved draft');
		await parts.mainPart.activeGroup.openEditor(other('/w/a/notes.ipynb', true), { pinned: true });

		editors.capture(a);
		await editors.restore(b);
		const inB = { onScreen: onScreen(), heldByA: putAway.get(a).map(resource => resource.toString()), draftUnsaved: untitled.get(draft.resource)?.isDirty() };

		editors.capture(b);
		await editors.restore(a);
		const backInA = { onScreen: onScreen(), unsaved: unsavedOnScreen(), heldByA: putAway.get(a).length, heldByB: putAway.get(b).length };

		assert.deepStrictEqual({ inB, backInA }, {
			inB: { onScreen: ['/w/a/notes.ipynb'], heldByA: [draft.resource.toString()], draftUnsaved: true },
			backInA: { onScreen: ['/w/a/notes.ipynb', draft.resource.path], unsaved: [draft.resource.path], heldByA: 0, heldByB: 0 }
		});

		await close();
		await untitled.get(draft.resource)?.revert();
	});

	test('WS-55 a window moved on because the folder it was on left the workspace captured nothing, and keeps that folder\'s unsaved editors on screen', async () => {
		const { editors, untitled, onScreen, unsavedOnScreen, draft: open, close } = await window();
		const draft = await open('an unsaved draft');

		// The folder the window was on left: the window goes to another without a capture on the way out
		await editors.restore(URI.file('/w/b'));

		assert.deepStrictEqual({ onScreen: onScreen(), unsaved: unsavedOnScreen() }, { onScreen: [draft.resource.path], unsaved: [draft.resource.path] });

		await close();
		await untitled.get(draft.resource)?.revert();
	});

	test('WS-55 a folder that leaves the workspace by anything but Remove Folder from Workspace brings what it had put away into the folder the window is on; one Remove Folder from Workspace takes leaves it to that', async () => {
		const { editors, putAway, untitled, onScreen, unsavedOnScreen, draft: open, close } = await window();
		const a = URI.file('/w/a');
		const b = URI.file('/w/b');
		const c = URI.file('/w/c');

		// A draft put away with `a`, another with `c`; the window on `b`.
		const inA = await open('a draft in a');
		editors.capture(a);
		await editors.restore(c);
		const inC = await open('a draft in c');
		editors.capture(c);
		await editors.restore(b);
		const away = onScreen();

		// `a` leaves by a workspace file edit, `c` through Remove Folder, which asks about its own unsaved editors
		await editors.prune([b], folder => folder.path === '/w/c');

		assert.deepStrictEqual({ away, onScreen: onScreen(), unsaved: unsavedOnScreen(), held: putAway.folders().length, cStillUnsaved: untitled.get(inC.resource)?.isDirty() }, {
			away: [],
			onScreen: [inA.resource.path],
			unsaved: [inA.resource.path],
			held: 0,
			cStillUnsaved: true
		});

		await close();
		await untitled.get(inA.resource)?.revert();
		await untitled.get(inC.resource)?.revert();
	});
});
