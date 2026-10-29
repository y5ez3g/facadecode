/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { repositoryFolderOf, worktreeRepositoryOf } from '../../common/gitFiles.js';

suite('Git files - the repository a folder is a worktree of', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('one whose `.git` names a record of the repository that names it back, absolute or relative; not a main checkout, a submodule, a `.git` naming another worktree\'s record or the repository itself, nor a record outside the repository', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const files: Record<string, string> = {
			// A repository at /repo, and its worktrees /wt and - recorded with relative paths - /rel
			'/repo/.git/HEAD': 'ref: refs/heads/main',
			'/repo/.git/worktrees/wt/commondir': '../..',
			'/repo/.git/worktrees/wt/gitdir': '/wt/.git',
			'/wt/.git': 'gitdir: /repo/.git/worktrees/wt',
			'/repo/.git/worktrees/rel/commondir': '../..',
			'/repo/.git/worktrees/rel/gitdir': '../../../../rel/.git',
			'/rel/.git': 'gitdir: ../repo/.git/worktrees/rel',
			// A submodule, whose git directory has no commondir
			'/repo/sub/.git': 'gitdir: ../.git/modules/sub',
			'/repo/.git/modules/sub/HEAD': 'ref: refs/heads/main',
			// Folders that claim the repository: by /wt's record, by the repository itself, and by a record of their own
			'/impostor/.git': 'gitdir: /repo/.git/worktrees/wt',
			'/straight/.git': 'gitdir: /repo/.git',
			'/elsewhere/worktrees/odd/commondir': '/repo/.git',
			'/elsewhere/worktrees/odd/gitdir': '/odd/.git',
			'/odd/.git': 'gitdir: /elsewhere/worktrees/odd',
		};
		for (const [path, content] of Object.entries(files)) {
			await fileService.writeFile(URI.file(path), VSBuffer.fromString(content));
		}

		const repositoryOf = async (path: string) => (await worktreeRepositoryOf(fileService, extUri, URI.file(path)))?.path;
		assert.deepStrictEqual({
			worktree: await repositoryOf('/wt'),
			relative: await repositoryOf('/rel'),
			main: await repositoryOf('/repo'),
			submodule: await repositoryOf('/repo/sub'),
			impostor: await repositoryOf('/impostor'),
			straight: await repositoryOf('/straight'),
			outsideRecord: await repositoryOf('/odd'),
			noRepository: await repositoryOf('/nowhere'),
			repositoryFolder: [repositoryFolderOf(URI.file('/repo/.git')).path, repositoryFolderOf(URI.file('/srv/bare.git')).path],
		}, {
			worktree: '/repo/.git',
			relative: '/repo/.git',
			main: undefined,
			submodule: undefined,
			impostor: undefined,
			straight: undefined,
			outsideRecord: undefined,
			noRepository: undefined,
			repositoryFolder: ['/repo', '/srv/bare.git'],
		});
	});
});
