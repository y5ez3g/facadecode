/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { asCodeSpan, foldersInWorkspaceFile } from '../../../../browser/parts/workspacebar/workspaceBar.js';

suite('Workspace bar - reading a workspace file', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('the folders a .code-workspace lists', () => {

		// On Windows a path from the root is on the drive of the file it is resolved against, so the file
		// is given one there - without, it would be the drive the tests happen to run from.
		const root = isWindows ? 'c:\\w' : '/w';
		const config = URI.file(join(root, 'team.code-workspace'));
		const foldersIn = (contents: string) => foldersInWorkspaceFile(contents, config, extUriBiasedIgnorePathCase).map(uri => uri.path);
		/** The path of the folder `segments` lead to from the workspace file's own folder. */
		const folder = (...segments: string[]) => URI.file(join(root, ...segments)).path;

		test('relative paths are resolved against the file, not the window', () => {
			assert.deepStrictEqual(foldersIn('{ "folders": [{ "path": "api" }, { "path": "../outside/web" }] }'), [folder('api'), folder('..', 'outside', 'web')]);
		});

		test('an absolute path and a uri entry are both taken as given', () => {
			// The path on the file's drive, on Windows; the uri exactly as written.
			assert.deepStrictEqual(foldersIn('{ "folders": [{ "path": "/elsewhere/api" }, { "uri": "file:///elsewhere/web" }] }'), [URI.file(isWindows ? 'c:\\elsewhere\\api' : '/elsewhere/api').path, '/elsewhere/web']);
		});

		test('the same folder listed twice becomes one folder', () => {
			assert.deepStrictEqual(foldersIn('{ "folders": [{ "path": "api" }, { "path": "./api" }] }'), [folder('api')]);
		});

		test('comments and trailing commas are allowed, the way the editor writes them', () => {
			assert.deepStrictEqual(foldersIn('{\n\t// the ones we work on\n\t"folders": [{ "path": "api" },],\n}'), [folder('api')]);
		});

		test('entries that name no folder are skipped, the rest are kept', () => {
			assert.deepStrictEqual(foldersIn('{ "folders": [{ "name": "no path" }, { "path": "web" }] }'), [folder('web')]);
		});

		test('settings and extensions alongside the folders are ignored', () => {
			assert.deepStrictEqual(foldersIn('{ "folders": [{ "path": "api" }], "settings": { "files.autoSave": "off" }, "extensions": { "recommendations": [] } }'), [folder('api')]);
		});

		test('a workspace file that lists no folders is empty, not an error', () => {
			assert.deepStrictEqual(foldersIn('{ "folders": [] }'), []);
		});

		test('a file that is not a workspace file throws, so the caller can open it instead', () => {
			// ⚠️ Not an empty list: dropping a broken .code-workspace has to end up opening it, which
			// is the only way to see what is wrong with it.
			assert.throws(() => foldersIn('not json'));
			assert.throws(() => foldersIn('{ "folders": "not an array" }'));
			assert.throws(() => foldersIn('[]'));
			assert.throws(() => foldersIn('{ "settings": {} }'));
		});
	});

	suite('a path inside a markdown code span', () => {

		/** What the renderer makes of it, which is the only thing that matters. */
		const rendered = (path: string) => {
			const span = asCodeSpan(path);
			const fence = span.match(/^`+/)![0];
			assert.ok(span.endsWith(fence), `unbalanced fence in ${span}`);

			let inner = span.slice(fence.length, -fence.length);
			if (inner.startsWith(' ') && inner.endsWith(' ')) {
				inner = inner.slice(1, -1);	// a span drops one space at each end when it has both
			}

			return inner;
		};

		test('an ordinary path comes back exactly as it went in', () => {
			assert.strictEqual(rendered('/Users/me/code/api'), '/Users/me/code/api');
		});

		test('the characters markdown escapes are left alone', () => {
			// ⚠️ `escapeMarkdownSyntaxTokens` would print the backslashes: inside a span one is a
			// literal, so `ios_app` would read as `ios\_app` in the dialog.
			assert.strictEqual(rendered('/Users/me/ios_app/my-folder (2)'), '/Users/me/ios_app/my-folder (2)');
			assert.strictEqual(rendered('/Users/me/c++/[wip]/a*b'), '/Users/me/c++/[wip]/a*b');
		});

		test('a backtick in the path widens the fence instead of closing the span', () => {
			assert.strictEqual(rendered('/tmp/we`ird'), '/tmp/we`ird');
			assert.strictEqual(rendered('/tmp/we``ird'), '/tmp/we``ird');
		});

		test('a path that begins or ends with one is padded off the fence', () => {
			assert.strictEqual(rendered('`start'), '`start');
			assert.strictEqual(rendered('end`'), 'end`');
		});
	});
});
