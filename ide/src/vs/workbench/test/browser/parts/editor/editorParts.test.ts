/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ISerializedNode } from '../../../../../base/browser/ui/grid/grid.js';
import { Orientation } from '../../../../../base/browser/ui/sash/sash.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorPartUIState, isEmptiedByRestore, isGoingWithItsEditors } from '../../../../browser/parts/editor/editorPart.js';

suite('Editor parts - a floating window that comes back', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** A part's saved state: its groups, side by side, each with as many editors as given. */
	function saved(...editors: number[]): IEditorPartUIState {
		const group = (count: number, id: number): ISerializedNode => ({ type: 'leaf', size: 100, data: { id, editors: Array.from({ length: count }, () => ({ id: 'workbench.editors.terminal', value: '{}' })), mru: Array.from({ length: count }, (_, index) => index) } });
		return { serializedGrid: { root: { type: 'branch', size: 100, data: editors.map(group) }, orientation: Orientation.HORIZONTAL, width: 100, height: 100 }, activeGroup: 0, mostRecentActiveGroups: [0] };
	}
	const restored = (...empty: boolean[]) => ({ groups: empty.map(isEmpty => ({ isEmpty })) });

	test('one saved holding editors that came back with none - only agents\' tabs, their agents ended with the app - is emptied, and closed; one with an editor back, or saved empty as New Empty Editor Window makes one, is not (D10)', () => {
		assert.deepStrictEqual({
			agentsOnly: isEmptiedByRestore(saved(2, 1), restored(true, true)),
			oneBack: isEmptiedByRestore(saved(2, 1), restored(true, false)),
			savedEmpty: isEmptiedByRestore(saved(0), restored(true))
		}, {
			agentsOnly: true,
			oneBack: false,
			savedEmpty: false
		});
	});

	test('one going with its editors - each one disposed, its terminals put away as the window leaves their folder - is not kept with the folder\'s editors; one with an editor still open, or empty as the person left it, is (N-87)', () => {
		const editor = (disposed: boolean) => ({ isDisposed: () => disposed });
		assert.deepStrictEqual({
			allPutAway: isGoingWithItsEditors([{ editors: [editor(true), editor(true)] }, { editors: [editor(true)] }]),
			oneStillOpen: isGoingWithItsEditors([{ editors: [editor(true)] }, { editors: [editor(false)] }]),
			leftEmpty: isGoingWithItsEditors([{ editors: [] }])
		}, {
			allPutAway: true,
			oneStillOpen: false,
			leftEmpty: false
		});
	});
});
