/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { asCodeSpan } from '../../../../browser/parts/workspacebar/workspaceBar.js';

suite('Workspace bar - reading a workspace file', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

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
