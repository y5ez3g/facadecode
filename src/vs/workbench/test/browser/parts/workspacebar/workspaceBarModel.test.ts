/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { WorkspaceBarModel } from '../../../../browser/parts/workspacebar/workspaceBarModel.js';

/**
 * Two things the model asks a file system: whether a folder is there, and what a path really is.
 *
 * `links` is what `realpath` answers with, so a test can say "`/tmp` is the same place as
 * `/private/tmp`" the way macOS does.
 */
class TestFileService extends mock<IFileService>() {

	override onDidChangeFileSystemProviderCapabilities = Event.None;
	override onDidChangeFileSystemProviderRegistrations = Event.None;

	/** Paths that are not on disk. Everything else is. */
	readonly missing = new Set<string>();

	constructor(private readonly links = new Map<string, string>()) {
		super();
	}

	override async exists(resource: URI): Promise<boolean> {
		return !this.missing.has(resource.path);
	}

	override hasProvider(): boolean { return true; }

	override hasCapability(_resource: URI, capability: FileSystemProviderCapabilities): boolean {
		// Case-insensitive, like the file systems this bar is used on.
		return capability !== FileSystemProviderCapabilities.PathCaseSensitive;
	}

	override async realpath(resource: URI): Promise<URI | undefined> {
		if (this.missing.has(resource.path)) {
			throw new Error(`ENOENT: ${resource.path}`);
		}

		for (const [from, to] of this.links) {
			if (resource.path === from || resource.path.startsWith(`${from}/`)) {
				return resource.with({ path: to + resource.path.slice(from.length) });
			}
		}

		return resource;
	}
}

/** A workspace whose folder list can be changed, by the bar or by anything else. */
class TestContextService extends mock<IWorkspaceContextService>() {

	private readonly _onDidChangeWorkspaceFolders = new Emitter<never>();
	override readonly onDidChangeWorkspaceFolders = this._onDidChangeWorkspaceFolders.event as Event<never>;

	private folders: WorkspaceFolder[] = [];

	constructor(paths: string[] = []) {
		super();
		this.setPaths(paths);
	}

	override getWorkspace(): IWorkspace {
		return { id: 'test', folders: this.folders, transient: false, configuration: null };
	}

	setPaths(paths: string[]): void {
		this.folders = paths.map((path, index) => new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(path.lastIndexOf('/') + 1) }));
		this._onDidChangeWorkspaceFolders.fire(undefined as never);
	}

	get paths(): string[] {
		return this.folders.map(folder => folder.uri.path);
	}

	dispose(): void {
		this._onDidChangeWorkspaceFolders.dispose();
	}
}

/**
 * Stands in for the real one, applying what it is told to the workspace.
 *
 * ⚠️ It de-duplicates against the workspace but not within one call, which is what upstream does:
 * `doUpdateFolders` works out what is already there once, before its loop.
 */
class TestWorkspaceEditingService extends mock<IWorkspaceEditingService>() {

	calls = 0;

	constructor(private readonly workspace: TestContextService) {
		super();
	}

	override async addFolders(folders: { uri: URI }[]): Promise<void> {
		this.calls++;
		const paths = this.workspace.paths;
		this.workspace.setPaths([...paths, ...folders.map(folder => folder.uri.path).filter(path => !paths.includes(path))]);
	}

	override async removeFolders(folders: URI[]): Promise<void> {
		this.calls++;
		const leaving = new Set(folders.map(folder => folder.path));
		this.workspace.setPaths(this.workspace.paths.filter(path => !leaving.has(path)));
	}
}

suite('Workspace bar - the folder list', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface IOptions {
		links?: Map<string, string>;
		paths?: string[];
		missing?: string[];
	}

	function buildModel(options: IOptions = {}): { model: WorkspaceBarModel; disk: TestFileService; workspace: TestContextService; editing: TestWorkspaceEditingService } {
		const disk = new TestFileService(options.links);
		for (const path of options.missing ?? []) {
			disk.missing.add(path);
		}

		const workspace = new TestContextService(options.paths);
		disposables.add({ dispose: () => workspace.dispose() });
		const editing = new TestWorkspaceEditingService(workspace);

		const model = disposables.add(new WorkspaceBarModel(
			workspace,
			editing,
			disk,
			disposables.add(new UriIdentityService(disk))
		));

		return { model, disk, workspace, editing };
	}

	function modelWith(options: IOptions = {}): WorkspaceBarModel {
		return buildModel(options).model;
	}

	const paths = (model: WorkspaceBarModel) => model.folders.map((folder: IWorkspaceFolder) => folder.uri.path);

	test('the rows are the folders the workspace already has', () => {
		assert.deepStrictEqual(paths(modelWith({ paths: ['/w/api', '/w/web'] })), ['/w/api', '/w/web']);
	});

	test('folders arrive in the order they were given', async () => {
		const model = modelWith();

		await model.add([URI.file('/w/api'), URI.file('/w/web'), URI.file('/w/notes')]);

		assert.deepStrictEqual(paths(model), ['/w/api', '/w/web', '/w/notes']);
	});

	test('several at once is one edit to the workspace', async () => {
		const { model, editing } = buildModel();

		await model.add([...Array(9)].map((_, i) => URI.file(`/w/p${i}`)));

		assert.strictEqual(model.folders.length, 9);
		assert.strictEqual(editing.calls, 1);
	});

	test('the same directory under two spellings is one row', async () => {
		// macOS: /tmp is a symlink to /private/tmp.
		const model = modelWith({ links: new Map([['/tmp', '/private/tmp']]) });

		await model.add([URI.file('/tmp/api')]);
		await model.add([URI.file('/private/tmp/api')]);

		assert.deepStrictEqual(paths(model), ['/tmp/api']);
	});

	test('and the row keeps the spelling it was asked for, whichever way round', async () => {
		const model = modelWith({ links: new Map([['/tmp', '/private/tmp']]) });

		await model.add([URI.file('/private/tmp/api')]);
		await model.add([URI.file('/tmp/api')]);

		assert.deepStrictEqual(paths(model), ['/private/tmp/api']);
	});

	test(`⭐ a folder is written down the way it was named, not the way it resolves`, async () => {
		// ⭐ The path goes in a `.code-workspace`, and the entry is relative to that file. Resolving
		// `/tmp/api` to `/private/tmp/api` beside a workspace file in `/tmp` turns a sibling into
		// `../../private/tmp/api`, where upstream would have written `api`. Following the symlink is
		// how the bar knows which folder this is; it is not a licence to rewrite the person's file.
		const { model, workspace } = buildModel({ links: new Map([['/tmp', '/private/tmp']]) });

		await model.add([URI.file('/tmp/cmp/delta')]);

		assert.deepStrictEqual(workspace.paths, ['/tmp/cmp/delta']);
	});

	test('a folder the workspace was opened with is recognised under its other spelling', async () => {
		// ⚠️ The listed folder never came through `add`, so nothing has resolved it. Comparing a
		// resolved candidate against a raw list is how one directory gets two rows.
		const model = modelWith({ paths: ['/tmp/api'], links: new Map([['/tmp', '/private/tmp']]) });

		const added = await model.add([URI.file('/private/tmp/api')]);

		assert.deepStrictEqual(added, []);
		assert.deepStrictEqual(paths(model), ['/tmp/api']);
	});

	test('and `resolve` answers with that row, not with the spelling it was asked about', async () => {
		const model = modelWith({ paths: ['/tmp/api'], links: new Map([['/tmp', '/private/tmp']]) });

		assert.strictEqual((await model.resolve(URI.file('/private/tmp/api')))?.uri.path, '/tmp/api');
		assert.strictEqual(await model.resolve(URI.file('/w/elsewhere')), undefined);
	});

	test('case is not identity on a file system that ignores it', async () => {
		const model = modelWith();

		await model.add([URI.file('/w/API')]);
		await model.add([URI.file('/w/api')]);

		assert.deepStrictEqual(paths(model), ['/w/API']);
	});

	test('the same folder twice in one batch is one row', async () => {
		// ⚠️ Ours to prevent: upstream compares each folder against the workspace as it was before
		// the call, so a batch carrying one folder twice writes it twice.
		const model = modelWith();

		const added = await model.add([URI.file('/w/api'), URI.file('/w/api')]);

		assert.strictEqual(added.length, 1);
		assert.deepStrictEqual(paths(model), ['/w/api']);
	});

	test('a folder the workspace already has is not added again, and costs no edit', async () => {
		const { model, editing } = buildModel({ paths: ['/w/api'] });

		const added = await model.add([URI.file('/w/api')]);

		assert.deepStrictEqual(added, []);
		assert.strictEqual(editing.calls, 0);
	});

	test('a folder that is not on disk is marked, not dropped', async () => {
		const model = modelWith({ missing: ['/w/gone'] });
		await model.add([URI.file('/w/here'), URI.file('/w/gone')]);
		await model.refreshAvailability();

		assert.deepStrictEqual(paths(model), ['/w/here', '/w/gone']);
		assert.strictEqual(model.isUnavailable(model.folders[0]), false);
		assert.strictEqual(model.isUnavailable(model.folders[1]), true);
	});

	test('a folder that comes back stops being marked', async () => {
		const { model, disk } = buildModel({ missing: ['/w/gone'] });
		await model.add([URI.file('/w/gone')]);
		await model.refreshAvailability();
		assert.strictEqual(model.isUnavailable(model.folders[0]), true);

		// A disk plugged back in, or a worktree made again under the same name.
		disk.missing.clear();
		await model.refreshAvailability();

		assert.strictEqual(model.isUnavailable(model.folders[0]), false);
	});

	test('a removed folder leaves the workspace and the rest keep their order', async () => {
		const model = modelWith({ paths: ['/w/api', '/w/web', '/w/notes'] });

		const removed = await model.remove([URI.file('/w/web')]);

		assert.deepStrictEqual(removed.map(folder => folder.uri.path), ['/w/web']);
		assert.deepStrictEqual(paths(model), ['/w/api', '/w/notes']);
	});

	test('however the folder was spelled', async () => {
		const model = modelWith({ paths: ['/private/tmp/api'], links: new Map([['/tmp', '/private/tmp']]) });

		await model.remove([URI.file('/private/tmp/API')]);

		assert.deepStrictEqual(paths(model), []);
	});

	test('removing something that is not there changes nothing, and costs no edit', async () => {
		const { model, editing } = buildModel({ paths: ['/w/api'] });

		assert.deepStrictEqual(await model.remove([URI.file('/w/elsewhere')]), []);
		assert.deepStrictEqual(paths(model), ['/w/api']);
		assert.strictEqual(editing.calls, 0);
	});

	test('a folder that comes back is not still marked from last time', async () => {
		const model = modelWith({ missing: ['/w/gone'] });
		await model.add([URI.file('/w/gone')]);
		await model.refreshAvailability();
		assert.strictEqual(model.isUnavailable(model.folders[0]), true);

		await model.remove([URI.file('/w/gone')]);
		await model.add([URI.file('/w/gone')]);

		assert.strictEqual(model.isUnavailable(model.folders[0]), false);
	});

	test('a folder that is not there yet still goes in under the name it was given', async () => {
		const model = modelWith({ links: new Map([['/tmp', '/private/tmp']]), missing: ['/tmp/later'] });

		await model.add([URI.file('/tmp/later')]);

		assert.deepStrictEqual(paths(model), ['/tmp/later']);
	});

	test('and once it exists, its other spelling still finds it', async () => {
		// ⚠️ A `.code-workspace` can list folders nobody has cloned yet. The row is compared as it
		// stands each time, so the day the folder appears is the day the symlink starts resolving -
		// nothing was frozen on the way in.
		const { model, disk } = buildModel({ links: new Map([['/tmp', '/private/tmp']]), missing: ['/tmp/later'] });
		await model.add([URI.file('/tmp/later')]);

		disk.missing.clear();
		await model.add([URI.file('/private/tmp/later')]);

		assert.deepStrictEqual(paths(model), ['/tmp/later']);
	});

	test('a folder whose parents are all missing keeps the spelling it arrived with', async () => {
		const model = modelWith({ missing: ['/gone', '/gone/deeper', '/gone/deeper/here'] });

		await model.add([URI.file('/gone/deeper/here')]);

		assert.deepStrictEqual(paths(model), ['/gone/deeper/here']);
	});

	test('an edit made anywhere else redraws the bar', async () => {
		// The extension API, or someone typing in the `.code-workspace` file.
		const { model, workspace } = buildModel({ paths: ['/w/api'] });
		let changes = 0;
		disposables.add(model.onDidChange(() => changes++));

		workspace.setPaths(['/w/api', '/w/added-elsewhere']);

		assert.deepStrictEqual(paths(model), ['/w/api', '/w/added-elsewhere']);
		assert.strictEqual(changes, 1);
	});
});
