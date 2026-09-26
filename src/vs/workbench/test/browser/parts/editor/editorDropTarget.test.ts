/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDndService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { CodeDataTransfers, LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { DraggedEditorIdentifier } from '../../../../browser/dnd.js';
import { IEditorGroupView } from '../../../../browser/parts/editor/editor.js';
import { EditorDropTarget } from '../../../../browser/parts/editor/editorDropTarget.js';
import { EditorExtensions, EditorInputCapabilities, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { GroupDirection, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { createEditorParts, ITestInstantiationService, registerTestEditor, TestFileEditorInput, workbenchInstantiationService, workbenchTeardown } from '../../workbenchTestServices.js';

suite('Editor drop target - editors that take dropped files', () => {

	const TEST_EDITOR_ID = 'MyTestEditorForEditorDropTarget';
	const TEST_EDITOR_INPUT_ID = 'testEditorInputForEditorDropTarget';

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

	/** Whether a drag of `data` entering `group` puts the "open here" overlay over it. */
	function overlayOver(group: IEditorGroupView, data: Record<string, string>): boolean {
		const dataTransfer = new DataTransfer();
		for (const [type, value] of Object.entries(data)) {
			dataTransfer.setData(type, value);
		}

		group.element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
		const overlay = !!group.element.querySelector('#monaco-workbench-editor-drop-overlay');
		group.element.dispatchEvent(new DragEvent('dragend', { bubbles: true }));

		return overlay;
	}

	test('files dragged over an editor that takes them get no overlay; over any other editor, or an editor being moved over it, they do', async () => {
		instantiationService = workbenchInstantiationService({ configurationService: () => new TestConfigurationService({ editor: { dropIntoEditor: { enabled: true } } }) }, disposables);
		instantiationService.stub(ITreeViewsDnDService, {});
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		const parts = await createEditorParts(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, parts);
		// The part made its own before the groups service above was in place, and finds no group; this one does.
		disposables.add(instantiationService.createInstance(EditorDropTarget, parts.testMainPart, parts.testMainPart.getContainer()!, Object.create(null)));

		// Standing in for a terminal in the editor area, which says it takes them.
		const terminal = disposables.add(new TestFileEditorInput(URI.file('/terminal'), TEST_EDITOR_INPUT_ID));
		terminal.capabilities = EditorInputCapabilities.TakesDroppedFiles;
		const text = disposables.add(new TestFileEditorInput(URI.file('/text.txt'), TEST_EDITOR_INPUT_ID));

		const terminalGroup = parts.testMainPart.activeGroup;
		await terminalGroup.openEditor(terminal);
		const textGroup = parts.testMainPart.addGroup(terminalGroup, GroupDirection.RIGHT);
		await textGroup.openEditor(text);

		const files = { [CodeDataTransfers.FILES]: JSON.stringify(['/a.txt']) };
		const filesOverTheTerminal = overlayOver(terminalGroup, files);
		const filesOverText = overlayOver(textGroup, files);

		const editorTransfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();
		editorTransfer.setData([new DraggedEditorIdentifier({ editor: text, groupId: textGroup.id })], DraggedEditorIdentifier.prototype);
		const editorOverTheTerminal = overlayOver(terminalGroup, {});
		editorTransfer.clearData(DraggedEditorIdentifier.prototype);

		assert.deepStrictEqual({ filesOverTheTerminal, filesOverText, editorOverTheTerminal }, {
			filesOverTheTerminal: false,
			filesOverText: true,
			editorOverTheTerminal: true,
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
