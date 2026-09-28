/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ISerializedNode } from '../../../../../base/browser/ui/grid/grid.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { isWorkspaceBarFirstInMiddleRow } from '../../../../browser/parts/workspacebar/workspaceBarPart.js';
import { Parts, shouldShowCustomTitleBar } from '../../../../services/layout/browser/layoutService.js';

const leaf = (type: Parts): ISerializedNode => ({ type: 'leaf', data: { type }, size: 100 });
const branch = (...data: ISerializedNode[]): ISerializedNode => ({ type: 'branch', data, size: 100 });

suite('Workspace bar - grid shape', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the shape layout.ts addresses into', () => {
		const bar = leaf(Parts.WORKSPACEBAR_PART);
		const title = leaf(Parts.TITLEBAR_PART);
		const banner = leaf(Parts.BANNER_PART);
		const status = leaf(Parts.STATUSBAR_PART);
		const rest = leaf(Parts.EDITOR_PART);
		const grid = (middle: ISerializedNode) => branch(title, banner, middle, status);

		assert.deepStrictEqual([
			isWorkspaceBarFirstInMiddleRow(grid(branch(bar, rest))),	// what the workbench builds
			isWorkspaceBarFirstInMiddleRow(grid(branch(rest, bar))),	// moved along: [2, 1] is no longer the first free column
			isWorkspaceBarFirstInMiddleRow(grid(branch(branch(bar), rest))),	// wrapped rather than direct
			isWorkspaceBarFirstInMiddleRow(branch(bar, branch(title, rest, status))),	// the old shape: a column of the root
			isWorkspaceBarFirstInMiddleRow(branch(title, branch(bar, rest), status)),	// a row missing above it: [2] is the status bar
			isWorkspaceBarFirstInMiddleRow(bar),	// not a branch at all
			isWorkspaceBarFirstInMiddleRow(undefined)
		], [true, false, false, false, false, false, false]);
	});
});

suite('Workspace bar - its toggle keeps the title bar', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** A native title bar and menu, and nothing upstream counts as title bar content. */
	const settings = (customTitleBarVisibility: string) => new TestConfigurationService({
		window: { titleBarStyle: 'native', menuStyle: 'native', commandCenter: false, customTitleBarVisibility },
		workbench: {
			layoutControl: { enabled: false },
			activityBar: { location: 'default' },
			editor: { editorActionsLocation: 'default', showTabs: 'multiple' }
		}
	});

	test('the main window\'s is never empty, because the toggle is in it', () => {
		// Stock hides the custom title bar here as empty, which took the bar's only toggle with it
		assert.strictEqual(shouldShowCustomTitleBar(settings('auto'), mainWindow), true);
	});

	test('asking for no custom title bar still gets none', () => {
		assert.strictEqual(shouldShowCustomTitleBar(settings('never'), mainWindow), false);
	});
});
