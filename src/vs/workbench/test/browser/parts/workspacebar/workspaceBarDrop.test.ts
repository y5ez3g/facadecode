/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDraggedResourceEditorInput } from '../../../../../platform/dnd/browser/dnd.js';
import { isTheBars, splitDrop, takesThePathAsText, WorkspaceBarDropTarget } from '../../../../browser/parts/workspacebar/workspaceBarDrop.js';
import { Event } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { workbenchInstantiationService } from '../../workbenchTestServices.js';

const dropped = (...paths: string[]): IDraggedResourceEditorInput[] => paths.map(path => ({ resource: URI.file(path) }));

const opened = (editors: IDraggedResourceEditorInput[]) => editors.map(editor => editor.resource?.path);
const added = (folders: URI[]) => folders.map(uri => uri.path);
const windowed = (workspaces: URI[]) => workspaces.map(uri => uri.path);

suite('Workspace bar - drop target - what a drop from outside means', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('WS-07 a file is opened and a folder is added', () => {
		const { editors, folders } = splitDrop(dropped('/w/notes.md', '/w/api'), [undefined, [URI.file('/w/api')]]);

		assert.deepStrictEqual(opened(editors), ['/w/notes.md']);
		assert.deepStrictEqual(added(folders), ['/w/api']);
	});

	test(`WS-07 ⭐ a workspace file is a window, not a handful of folders`, () => {
		// ⭐ A `.code-workspace` carries its own `settings`, `extensions`, `launch` and `tasks`, and
		// none of those can be merged into the workspace this window already has. Taking only its
		// folders would be the dangerous half of "merge" wearing the word "add".
		const { editors, folders, workspaces } = splitDrop(dropped('/w/team.code-workspace'), ['window']);

		assert.deepStrictEqual(opened(editors), []);
		assert.deepStrictEqual(added(folders), []);
		assert.deepStrictEqual(windowed(workspaces), ['/w/team.code-workspace']);
	});

	test('and a workspace file dropped beside folders leaves those folders alone', () => {
		const { editors, folders, workspaces } = splitDrop(dropped('/w/first', '/w/team.code-workspace', '/w/last'), [
			[URI.file('/w/first')],
			'window',
			[URI.file('/w/last')]
		]);

		assert.deepStrictEqual(opened(editors), []);
		assert.deepStrictEqual(added(folders), ['/w/first', '/w/last']);
		assert.deepStrictEqual(windowed(workspaces), ['/w/team.code-workspace']);
	});

	test('WS-07 a mixed drop is both, each in the order it arrived', () => {
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

		test('WS-08 a document takes a drop as somewhere to go, until Shift says otherwise', () => {
			const at = surfaces();

			assert.strictEqual(asks(at('.mtk1')), false);
			assert.strictEqual(asks(at('.mtk1'), { shift: true }), true);
		});

		test('WS-08 Shift over a document asks for nothing when the editor is not listening', () => {
			// ⚠️ `editorDropTarget` gates its own bypass on `editor.dropIntoEditor.enabled`. Stepping
			// over a drop it is not going to take hands a folder to `ResourcesDropHandler`, which
			// opens a second window.
			const at = surfaces();

			assert.strictEqual(asks(at('.mtk1'), { shift: true, dropIntoEditor: false }), false);
		});

		test('WS-08 the terminal always asks - it is a line someone is typing', () => {
			const at = surfaces();

			assert.strictEqual(asks(at('.xterm-screen')), true);
			assert.strictEqual(asks(at('.xterm-screen'), { shift: true }), true);
			assert.strictEqual(asks(at('.terminal-wrapper')), true);
		});

		test('WS-08 a text field outside a document asks', () => {
			const at = surfaces();

			assert.strictEqual(asks(at('.settings-search')), true);
		});

		test('WS-08 a text field the editor owns does not', () => {
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

	suite('whose drop it is', () => {

		/** The bar, and the surfaces that answer an external drop for themselves. */
		function workbench() {
			const root = document.createElement('div');
			root.innerHTML = '<div class="part workspacebar"><div class="monaco-list-row">alpha</div></div>'
				+ '<div class="part editor"><div class="monaco-editor"><span class="mtk1">const a = 1;</span></div></div>'
				+ '<div class="explorer-viewlet"><div class="monaco-list-row">src</div></div>'
				+ '<div class="interactive-input-part"><div class="chat-input-container"></div></div>'
				+ '<div class="extensions-viewlet"><div class="monaco-list-row">an extension</div></div>';

			return (selector: string) => root.querySelector(selector)!;
		}

		const mine = (target: Element | null) => isTheBars({ target } as unknown as DragEvent);

		test(`⭐ a drop on the bar is the bar's`, () => {
			const at = workbench();

			assert.strictEqual(mine(at('.workspacebar .monaco-list-row')), true);
			assert.strictEqual(mine(at('.part.workspacebar')), true);
		});

		test(`⭐ and a drop anywhere else belongs to whatever is under it`, () => {
			// ⚠️ Each of these has its own answer for a file from the file manager - copy it in, attach
			// it, install it, open it - and intercepting on the body took all four away to pay for one.
			const at = workbench();

			assert.strictEqual(mine(at('.explorer-viewlet .monaco-list-row')), false);
			assert.strictEqual(mine(at('.chat-input-container')), false);
			assert.strictEqual(mine(at('.extensions-viewlet .monaco-list-row')), false);
			assert.strictEqual(mine(at('.mtk1')), false);
		});

		test('a drop on nothing is nobody\'s', () => {
			assert.strictEqual(mine(null), false);
		});
	});

	suite('and what the bar does with it', () => {

		/**
		 * The bar's own handler, far enough to say which of the two it calls.
		 *
		 * ⚠️ Through `apply` rather than a `DragEvent`: a drag carrying real file paths cannot be
		 * synthesised, which is the same instrument limit that leaves the live drop unmeasured.
		 */
		function bar() {
			const added: string[][] = [];
			const shown: string[][] = [];

			const services = workbenchInstantiationService({
				fileService: () => new class extends mock<IFileService>() {
					override onDidFilesChange = Event.None;
					override onDidChangeFileSystemProviderCapabilities = Event.None;
					override onDidChangeFileSystemProviderRegistrations = Event.None;
					override hasProvider() { return true; }
					override hasCapability() { return true; }
					override async exists() { return true; }
					override async realpath(resource: URI) { return resource; }
					override async stat(resource: URI) { return { isDirectory: !resource.path.includes('.') } as never; }
				}
			}, disposables);

			services.stub(IWorkspaceBarService, new class extends mock<IWorkspaceBarService>() {
				override async add(uris: readonly URI[]) { added.push(uris.map(uri => uri.path)); }
				override async addAndShow(uris: readonly URI[]) { shown.push(uris.map(uri => uri.path)); return { kind: 'shown' } as const; }
			});
			const target = disposables.add(services.createInstance(WorkspaceBarDropTarget));
			return { target, added, shown };
		}

		test(`⭐ a folder dropped on the bar joins the list without moving the window`, async () => {
			// ⚠️ `addAndShow` here is the whole feature undone: somebody dropping four folders onto
			// the list gets walked to the fourth. The bar is where you collect; the window is where you
			// say "show me this". Written down at the seam, and drifted back once already.
			const { target, added, shown } = bar();

			await target.apply(dropped('/w/api', '/w/web'));

			assert.deepStrictEqual(added, [['/w/api', '/w/web']], 'the folders did not join the list');
			assert.deepStrictEqual(shown, [], 'dropping on the bar moved the window');
		});
	});

});
