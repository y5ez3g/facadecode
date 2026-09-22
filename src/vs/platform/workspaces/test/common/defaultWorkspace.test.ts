/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DEFAULT_WORKSPACE_CONTENT, DEFAULT_WORKSPACE_FILE_NAME, defaultWorkspaceUri } from '../../common/defaultWorkspace.js';

suite('The default workspace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const userDataPath = isWindows ? 'C:\\Users\\someone\\AppData\\Roaming\\Code' : '/home/someone/.config/Code';

	test('⭐ is named with a `file` URI, whatever the caller was holding', () => {
		// ⚠️ `resolveLocalWorkspace` opens with `if (uri.scheme !== Schemas.file) { return undefined; }`
		// and says nothing. Built from `userRoamingDataHome` - which names the same directory as
		// `vscode-userdata:` - this created the workspace file, declined to open it, and left the
		// window empty with no error anywhere. Taking a path on disk is what keeps that from coming
		// back.
		assert.strictEqual(defaultWorkspaceUri(userDataPath).scheme, Schemas.file);
	});

	test('sits in the User directory, beside settings.json', () => {
		const uri = defaultWorkspaceUri(userDataPath);

		assert.strictEqual(uri.path.endsWith(`/User/${DEFAULT_WORKSPACE_FILE_NAME}`), true, uri.path);
	});

	test('is the same file every time it is asked for', () => {
		assert.strictEqual(defaultWorkspaceUri(userDataPath).toString(), defaultWorkspaceUri(userDataPath).toString());
	});

	test('⭐ carries the extension the workspace resolver insists on', () => {
		// `isWorkspacePath` checks the extension before anything else; a file named otherwise is not a
		// workspace however well formed its contents are.
		assert.strictEqual(DEFAULT_WORKSPACE_FILE_NAME.endsWith('.code-workspace'), true);
	});

	test('and is created holding a workspace with no folders in it', () => {
		const parsed = JSON.parse(DEFAULT_WORKSPACE_CONTENT);

		assert.deepStrictEqual(parsed.folders, []);
	});
});
