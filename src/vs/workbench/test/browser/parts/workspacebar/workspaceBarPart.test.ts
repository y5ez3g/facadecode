/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ISerializedNode } from '../../../../../base/browser/ui/grid/grid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TitlebarStyle } from '../../../../../platform/window/common/window.js';
import { controlsOccupyColumnZero, isWorkspaceBarFirstColumn } from '../../../../browser/parts/workspacebar/workspaceBarPart.js';
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

suite('Workspace bar - where the window buttons are', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Measured on Windows: a 1444px window with 137px of buttons reports the row as 0..1307. */
	const buttonsAtTheEnd = { x: 0 };

	/** The same row with the buttons at the front, which is what a rect past zero means. */
	const buttonsAtTheFront = { x: 70 };

	const onMac = (style: TitlebarStyle, rect?: { x: number }, fullscreen = false) => controlsOccupyColumnZero(style, rect, fullscreen, true);
	const offMac = (style: TitlebarStyle, rect?: { x: number }, fullscreen = false) => controlsOccupyColumnZero(style, rect, fullscreen, false);

	test('who is allowed to answer, and what they say', () => {
		assert.deepStrictEqual([
			// macOS answers from the style alone: no rect ever arrives there, because `windowImpl.ts`
			// sets the overlay up only when `!isMacintosh`.
			onMac(TitlebarStyle.CUSTOM, undefined),		// lights over column zero: hold the row open
			onMac(TitlebarStyle.NATIVE, undefined),		// native tabs, simple fullscreen: they are above it

			// Off macOS the rect answers, wherever the buttons turn out to be.
			offMac(TitlebarStyle.CUSTOM, buttonsAtTheEnd),		// nothing over the column: start at the top
			offMac(TitlebarStyle.CUSTOM, buttonsAtTheFront),	// a window manager moved them: hold it open

			// No rect at all is `window.controlsStyle` set to `custom` or `hidden`, or a native title
			// bar. The first draws into the title bar's own far end, the second draws none, the third
			// draws outside the web contents, and none of the three reaches column zero.
			offMac(TitlebarStyle.CUSTOM, undefined),
			offMac(TitlebarStyle.NATIVE, undefined),

			// And the style does not get a say off macOS, so the `isMac` branch cannot be widened
			// into one without this failing.
			offMac(TitlebarStyle.NATIVE, buttonsAtTheFront)
		], [true, false, false, true, false, false, true]);
	});

	test('full screen takes them away, and the row above the header with them', () => {
		assert.deepStrictEqual([
			// macOS hides the traffic lights in full screen, so the 35px this column was holding
			// open for them is 35px of nothing and the header starts at the top, as on Windows.
			onMac(TitlebarStyle.CUSTOM, undefined, false),
			onMac(TitlebarStyle.CUSTOM, undefined, true),

			// And off macOS, where the rect is the one that answers: a window manager that puts the
			// buttons at the front has nowhere to put them once there is no caption row at all.
			offMac(TitlebarStyle.CUSTOM, buttonsAtTheFront, false),
			offMac(TitlebarStyle.CUSTOM, buttonsAtTheFront, true)
		], [true, false, true, false]);
	});
});
