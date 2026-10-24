/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { NullFileSystemProvider } from '../../../../../platform/files/test/common/nullFileSystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { PutAwayEditorsService } from '../../browser/putAwayEditorsService.js';

suite('Put away editors', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('the unsaved editors put away with a folder of a Windows host are still its own once the remote\'s file system registers after the window came up, which ignores case where the window took paths to keep it (REMOTE.md R7)', () => {
		const repo = URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+win', path: '/c:/Users/me/repo' });
		const draft = URI.from({ scheme: Schemas.untitled, path: 'Untitled-1' });
		const storage = disposables.add(new InMemoryStorageService());

		// The window before: it put the draft away with the folder
		const before = disposables.add(new FileService(new NullLogService()));
		disposables.add(before.registerProvider(Schemas.vscodeRemote, new NullFileSystemProvider()));
		disposables.add(new PutAwayEditorsService(storage, disposables.add(new UriIdentityService(before)), before)).set(repo, [draft]);

		// Reloaded: up before the remote's file system is
		const fileService = disposables.add(new FileService(new NullLogService()));
		const putAway = disposables.add(new PutAwayEditorsService(storage, disposables.add(new UriIdentityService(fileService)), fileService));
		const loaded = putAway.get(repo).map(resource => resource.toString());
		let changes = 0;
		disposables.add(putAway.onDidChange(() => changes++));
		disposables.add(fileService.registerProvider(Schemas.vscodeRemote, new NullFileSystemProvider()));

		assert.deepStrictEqual({
			loaded,
			registered: putAway.get(repo).map(resource => resource.toString()),
			anyCase: putAway.get(repo.with({ path: '/c:/users/me/repo' })).map(resource => resource.toString()),
			folders: putAway.folders().length,
			changes
		}, {
			loaded: ['untitled:Untitled-1'],
			registered: ['untitled:Untitled-1'],
			anyCase: ['untitled:Untitled-1'],
			folders: 1,
			changes: 1
		});
	});
});
