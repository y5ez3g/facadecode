/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FileService } from '../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { DEFAULT_WORKSPACE_CONTENT, DEFAULT_WORKSPACE_FILE_NAME, defaultWorkspaceUri, ensureDefaultWorkspace } from '../../common/defaultWorkspace.js';

suite('The default workspace', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

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

	test('WS-01 and is created holding a workspace with no folders in it', () => {
		const parsed = JSON.parse(DEFAULT_WORKSPACE_CONTENT);

		assert.deepStrictEqual(parsed.folders, []);
	});

	/** Where the user data directory is on `disk()`: without a drive letter, whose root `mkdirp` takes for granted. */
	const onDisk = '/someone/Facade Code';

	/** A disk of its own, and the warnings logged against it. */
	function disk() {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		const warnings: string[] = [];
		const logService = new class extends NullLogService {
			override warn(message: string) { warnings.push(message); }
		};
		const read = async () => (await fileService.readFile(defaultWorkspaceUri(onDisk))).value.toString();
		return { fileService, logService, warnings, read };
	}

	test('WS-02 one that is missing is written, holding no folders, and is the one opened', async () => {
		const { fileService, logService, warnings, read } = disk();

		const opened = await ensureDefaultWorkspace(fileService, logService, onDisk);

		assert.deepStrictEqual({ opened: opened?.toString(), content: await read(), warnings }, {
			opened: defaultWorkspaceUri(onDisk).toString(), content: DEFAULT_WORKSPACE_CONTENT, warnings: []
		});
	});

	test('WS-02 one that is there is opened as it is', async () => {
		const { fileService, logService, read } = disk();
		const content = '{ "folders": [{ "path": "api" }] }';
		await fileService.writeFile(defaultWorkspaceUri(onDisk), VSBuffer.fromString(content));

		const opened = await ensureDefaultWorkspace(fileService, logService, onDisk);

		assert.deepStrictEqual({ opened: opened?.toString(), content: await read() }, { opened: defaultWorkspaceUri(onDisk).toString(), content });
	});

	test('WS-02 a directory in its place is not opened - it would open as a folder - and why is logged; the directory is left alone', async () => {
		const { fileService, logService, warnings } = disk();
		await fileService.createFolder(defaultWorkspaceUri(onDisk));

		const opened = await ensureDefaultWorkspace(fileService, logService, onDisk);

		assert.deepStrictEqual({
			opened,
			stillADirectory: (await fileService.stat(defaultWorkspaceUri(onDisk))).isDirectory,
			why: warnings.map(warning => warning.includes(defaultWorkspaceUri(onDisk).fsPath) && warning.includes('is a directory'))
		}, { opened: undefined, stillADirectory: true, why: [true] });
	});
});
