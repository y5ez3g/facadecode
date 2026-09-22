/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { repositoryBelongsToFolder } from '../../browser/util.js';

suite('SCM - which folder a repository belongs to', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const belongs = (root: string | undefined, folder: string | undefined) =>
		repositoryBelongsToFolder(
			root === undefined ? undefined : URI.file(root),
			folder === undefined ? undefined : URI.file(folder),
			extUriBiasedIgnorePathCase);

	test('the folder is the repository root, which is the ordinary case', () => {
		assert.strictEqual(belongs('/w/api', '/w/api'), true);
	});

	test('a folder inside the repository belongs to it', () => {
		// One root of a monorepo, checked out whole and added to the workspace on its own.
		assert.strictEqual(belongs('/w/mono', '/w/mono/packages/api'), true);
	});

	test('a repository inside the folder belongs to it', () => {
		// ⚠️ The other direction, which is what a submodule is. Testing only one of the two hides it.
		assert.strictEqual(belongs('/w/api/vendor/lib', '/w/api'), true);
	});

	test('a repository somewhere else does not', () => {
		assert.strictEqual(belongs('/w/web', '/w/api'), false);
	});

	test('and a sibling whose name merely starts the same does not', () => {
		// ⚠️ A prefix test on strings says yes here. `isEqualOrParent` walks path segments.
		assert.strictEqual(belongs('/w/api-v2', '/w/api'), false);
	});

	test('a repository with no root belongs to every folder', () => {
		// A provider that is not file-backed. Hiding it would take away something the workspace
		// never scoped in the first place.
		assert.strictEqual(belongs(undefined, '/w/api'), true);
	});

	test('and every repository belongs to a window with no folder', () => {
		assert.strictEqual(belongs('/w/api', undefined), true);
	});

	test('case is not identity on a file system that ignores it', () => {
		assert.strictEqual(belongs('/w/API', '/w/api'), true);
	});
});
