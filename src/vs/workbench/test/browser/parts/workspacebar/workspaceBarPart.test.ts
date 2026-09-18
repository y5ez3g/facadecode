/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ISerializedNode } from '../../../../../base/browser/ui/grid/grid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isWorkspaceBarFirstColumn } from '../../../../browser/parts/workspacebar/workspaceBarPart.js';
import { Parts } from '../../../../services/layout/browser/layoutService.js';

const leaf = (type: Parts): ISerializedNode => ({ type: 'leaf', data: { type }, size: 100 });
const branch = (...data: ISerializedNode[]): ISerializedNode => ({ type: 'branch', data, size: 100 });

suite('Workspace bar - grid shape', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the shape layout.ts addresses into', () => {
		const bar = leaf(Parts.WORKSPACEBAR_PART);
		const main = branch(leaf(Parts.TITLEBAR_PART), leaf(Parts.EDITOR_PART));

		assert.deepStrictEqual([
			isWorkspaceBarFirstColumn(branch(bar, main)),	// what the workbench builds
			isWorkspaceBarFirstColumn(branch(main, bar)),	// moved: every coordinate now points wrong
			isWorkspaceBarFirstColumn(branch(leaf(Parts.SIDEBAR_PART), bar, main)),	// a level inserted before it
			isWorkspaceBarFirstColumn(branch(branch(bar), main)),	// wrapped rather than direct
			isWorkspaceBarFirstColumn(bar),	// not a branch at all
			isWorkspaceBarFirstColumn(undefined)
		], [true, false, false, false, false, false]);
	});
});
