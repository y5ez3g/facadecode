/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDraggedResourceEditorInput } from '../../../../../platform/dnd/browser/dnd.js';
import { splitDrop, takesThePathAsText } from '../../../../browser/parts/workspacebar/workspaceBarDrop.js';

const dropped = (...paths: string[]): IDraggedResourceEditorInput[] => paths.map(path => ({ resource: URI.file(path) }));

const opened = (editors: IDraggedResourceEditorInput[]) => editors.map(editor => editor.resource?.path);
const added = (folders: URI[]) => folders.map(uri => uri.path);

suite('Workspace bar - drop target - what a drop from outside means', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a file is opened and a folder is added', () => {
		const { editors, folders } = splitDrop(dropped('/w/notes.md', '/w/api'), [undefined, [URI.file('/w/api')]]);

		assert.deepStrictEqual(opened(editors), ['/w/notes.md']);
		assert.deepStrictEqual(added(folders), ['/w/api']);
	});

	test('a workspace file becomes every folder it lists', () => {
		const { editors, folders } = splitDrop(dropped('/w/team.code-workspace'), [[URI.file('/w/api'), URI.file('/w/web')]]);

		assert.deepStrictEqual(opened(editors), []);
		assert.deepStrictEqual(added(folders), ['/w/api', '/w/web']);
	});

	test('a workspace file expands where it was dropped, not at the end', () => {
		const { folders } = splitDrop(dropped('/w/first', '/w/team.code-workspace', '/w/last'), [
			[URI.file('/w/first')],
			[URI.file('/w/api'), URI.file('/w/web')],
			[URI.file('/w/last')]
		]);

		assert.deepStrictEqual(added(folders), ['/w/first', '/w/api', '/w/web', '/w/last']);
	});

	test('a mixed drop is both, each in the order it arrived', () => {
		const { editors, folders } = splitDrop(dropped('/w/a', '/w/one.md', '/w/b', '/w/two.md', '/w/c'), [
			[URI.file('/w/a')], undefined, [URI.file('/w/b')], undefined, [URI.file('/w/c')]
		]);

		assert.deepStrictEqual(opened(editors), ['/w/one.md', '/w/two.md']);
		assert.deepStrictEqual(added(folders), ['/w/a', '/w/b', '/w/c']);
	});

	test('an item that stands for an empty list of folders adds nothing', () => {
		const { editors, folders } = splitDrop(dropped('/w/empty'), [[]]);

		assert.deepStrictEqual(opened(editors), []);
		assert.deepStrictEqual(added(folders), []);
	});

	test('nothing dropped is nothing done', () => {
		const { editors, folders } = splitDrop([], []);

		assert.strictEqual(editors.length, 0);
		assert.strictEqual(folders.length, 0);
	});

	suite('drops that are asking for the path as text', () => {

		/** A workbench with the three surfaces that ask, and one that does not. */
		function surfaces() {
			const root = document.createElement('div');
			root.innerHTML = '<div class="monaco-editor">'
				+ '<span class="mtk1">const a = 1;</span>'
				+ '<textarea class="ime-text-area"></textarea>'
				+ '<div class="find-widget"><input class="input" /></div>'
				+ '</div>'
				+ '<div class="terminal-wrapper"><canvas class="xterm-screen"></canvas></div>'
				+ '<div class="search-view"><input class="settings-search" /></div>';

			return (selector: string) => root.querySelector(selector)!;
		}

		const asks = (target: Element | null, options: { shift?: boolean; dropIntoEditor?: boolean } = {}) =>
			takesThePathAsText({ target, shiftKey: !!options.shift } as unknown as DragEvent, options.dropIntoEditor ?? true);

		test('a document takes a drop as somewhere to go, until Shift says otherwise', () => {
			const at = surfaces();

			assert.strictEqual(asks(at('.mtk1')), false);
			assert.strictEqual(asks(at('.mtk1'), { shift: true }), true);
		});

		test('Shift over a document asks for nothing when the editor is not listening', () => {
			// ⚠️ `editorDropTarget` gates its own bypass on `editor.dropIntoEditor.enabled`. Stepping
			// over a drop it is not going to take hands a folder to `ResourcesDropHandler`, which
			// opens a second window.
			const at = surfaces();

			assert.strictEqual(asks(at('.mtk1'), { shift: true, dropIntoEditor: false }), false);
		});

		test('the terminal always asks - it is a line someone is typing', () => {
			const at = surfaces();

			assert.strictEqual(asks(at('.xterm-screen')), true);
			assert.strictEqual(asks(at('.xterm-screen'), { shift: true }), true);
			assert.strictEqual(asks(at('.terminal-wrapper')), true);
		});

		test('a text field outside a document asks', () => {
			const at = surfaces();

			assert.strictEqual(asks(at('.settings-search')), true);
		});

		test('a text field the editor owns does not', () => {
			// ⚠️ The editor keeps helpers in its own DOM, and everything inside it that is stepped
			// over reaches `editorDropTarget`, which opens a second window for a folder.
			const at = surfaces();

			assert.strictEqual(asks(at('.ime-text-area')), false);
			assert.strictEqual(asks(at('.find-widget .input')), false);
		});

		test('a drop on nothing asks for nothing', () => {
			assert.strictEqual(asks(null), false);
		});
	});
});
