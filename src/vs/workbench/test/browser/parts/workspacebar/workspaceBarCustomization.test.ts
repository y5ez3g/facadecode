/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent, WorkbenchState, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { FOLDER_COLORS, FOLDER_ICONS, freeWorktreeColor, WorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';

const STORAGE_KEY = 'facade.workspaceBar.customization';

class TestFileService extends mock<IFileService>() {
	override onDidChangeFileSystemProviderCapabilities = Event.None;
	override onDidChangeFileSystemProviderRegistrations = Event.None;
	override hasProvider(): boolean { return true; }
	override hasCapability(): boolean { return true; }
}

suite('Workspace bar - what somebody has changed about a folder', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface ISetup {
		readonly service: WorkspaceBarCustomizationService;
		readonly storage: InMemoryStorageService;
		readonly folder: IWorkspaceFolder;
		/** Builds a second service over the same storage - what a reload is. */
		readonly reopen: () => WorkspaceBarCustomizationService;
		/** Folders joining the workspace, as the workspace file or the bar adds them. */
		readonly join: (...folders: IWorkspaceFolder[]) => void;
		/** Every `renameFolder` asked of the workspace file, as path and name. */
		readonly renamed: [string, string | undefined][];
		state: WorkbenchState;
	}

	function setup(stored?: string): ISetup {
		const store = disposables.add(new DisposableStore());
		const storage = store.add(new InMemoryStorageService());
		if (stored !== undefined) {
			storage.store(STORAGE_KEY, stored, StorageScope.PROFILE, 0 /* USER */);
		}

		const uriIdentityService = store.add(new UriIdentityService(new TestFileService()));
		const joining = store.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		const renamed: [string, string | undefined][] = [];
		const result = { state: WorkbenchState.WORKSPACE } as ISetup;
		const contextService = { onDidChangeWorkspaceFolders: joining.event, getWorkbenchState: () => result.state } as unknown as IWorkspaceContextService;
		const workspaceEditingService = { renameFolder: async (uri: URI, name: string | undefined) => { renamed.push([uri.path, name]); } } as unknown as IWorkspaceEditingService;
		const build = () => store.add(new WorkspaceBarCustomizationService(storage, uriIdentityService, contextService, workspaceEditingService));

		return Object.assign(result, {
			service: build(),
			storage,
			folder: new WorkspaceFolder({ uri: URI.file('/w/api'), index: 0, name: 'api' }),
			reopen: build,
			join: (...folders: IWorkspaceFolder[]) => joining.fire({ added: folders, removed: [], changed: [] }),
			renamed
		});
	}

	test('⭐ every field survives a reload, not just the ones somebody remembered', async () => {
		// ⚠️ `set` keeps its fields one named line at a time, so a field added to the type and to the
		// dialog can be accepted by the type checker and dropped on the way to storage. That is what
		// happened to `icon`: it was chosen, it was returned, and Save did nothing that could be seen.
		const { service, folder, reopen } = setup();

		service.set(folder.uri, { name: 'API', color: 'teal', icon: 'server' });

		const after = reopen().get(folder.uri);
		assert.strictEqual(after?.name, 'API');
		assert.strictEqual(after?.color, 'teal');
		assert.strictEqual(after?.icon, 'server', 'the icon did not survive');
	});

	test('one field on its own is enough to be remembered', () => {
		const { service, folder, reopen } = setup();

		service.set(folder.uri, { icon: 'rocket' });

		assert.strictEqual(reopen().get(folder.uri)?.icon, 'rocket');
	});

	test('and clearing every field forgets the folder rather than storing an empty record', () => {
		const { service, storage, folder } = setup();

		service.set(folder.uri, { name: 'API', color: 'teal', icon: 'server' });
		service.set(folder.uri, {});

		assert.strictEqual(service.get(folder.uri), undefined);
		assert.strictEqual(storage.get(STORAGE_KEY, StorageScope.PROFILE), undefined, 'an empty record was left behind');
	});

	test('⭐ a value that is no longer in the palette does not reach the renderer', () => {
		// A colour taken out of the palette, and an icon somebody hand-edited, both arrive as strings
		// that look fine. Anything not in the two lists is dropped on the way in.
		const { service, folder } = setup(JSON.stringify({
			[URI.file('/w/api').toString()]: { name: 'API', color: 'chartreuse', icon: 'nyan-cat' }
		}));

		const only = service.get(folder.uri);
		assert.strictEqual(only?.name, 'API');
		assert.strictEqual(only?.color, undefined);
		assert.strictEqual(only?.icon, undefined);
	});

	test('a stored value that is not JSON at all costs the customisations and nothing else', () => {
		const { service, folder } = setup('{ this is not json');

		assert.strictEqual(service.get(folder.uri), undefined);
		assert.strictEqual(service.nameFor(folder), 'api', 'the bar could not draw a name');
	});

	test('the display name falls back to the folder, and an empty one is not a name', () => {
		const { service, folder } = setup();

		assert.strictEqual(service.nameFor(folder), 'api');

		service.set(folder.uri, { name: '   ' });
		assert.strictEqual(service.nameFor(folder), 'api', 'whitespace was taken as a name');

		service.set(folder.uri, { name: 'API' });
		assert.strictEqual(service.nameFor(folder), 'API');
	});

	test('a default name - a worktree\'s branch - comes between a given name and the folder\'s own, and its changes are announced', () => {
		const { service, folder } = setup();
		const heard: string[] = [];
		disposables.add(service.onDidChange(uri => heard.push(uri.path)));

		service.setDefaultNames([{ uri: folder.uri, name: 'feature/login' }]);
		const byBranch = service.nameFor(folder);
		service.setDefaultNames([{ uri: folder.uri, name: 'feature/login' }]);
		service.set(folder.uri, { name: 'Login' });
		const named = service.nameFor(folder);
		service.set(folder.uri, {});
		service.setDefaultNames([]);

		assert.deepStrictEqual({ byBranch, named, own: service.nameFor(folder), heard }, {
			byBranch: 'feature/login',
			named: 'Login',
			own: 'api',
			heard: ['/w/api', '/w/api', '/w/api', '/w/api'],
		});
	});

	test('WS-22 WS-34 the name in the workspace file is the name; one kept here stands in only where the file has none', () => {
		const { service } = setup();
		const named = new WorkspaceFolder({ uri: URI.file('/w/api'), index: 0, name: 'API' });
		const unnamed = new WorkspaceFolder({ uri: URI.file('/w/web'), index: 1, name: 'web' });

		service.set(named.uri, { name: 'Kept here' });
		service.set(unnamed.uri, { name: 'Frontend' });
		service.setDefaultNames([{ uri: named.uri, name: 'feature/login' }]);

		assert.deepStrictEqual({ named: service.nameFor(named), unnamed: service.nameFor(unnamed) }, { named: 'API', unnamed: 'Frontend' });
	});

	test('WS-34 a row named while it was not in the list takes its name into folders[].name when its folder joins', async () => {
		const setupResult = setup();
		const { service, folder } = setupResult;
		service.set(folder.uri, { name: 'Login', color: 'teal' });

		setupResult.join(folder);
		await timeout(0);

		assert.deepStrictEqual({ renamed: setupResult.renamed, kept: service.get(folder.uri) }, {
			renamed: [['/w/api', 'Login']],
			kept: { name: undefined, color: 'teal', icon: undefined }
		});
	});

	test('WS-34 without a workspace file there is nowhere else to keep it, and a folder that joins named already keeps its own', async () => {
		const setupResult = setup();
		const { service, folder } = setupResult;
		const named = new WorkspaceFolder({ uri: URI.file('/w/web'), index: 1, name: 'Web App' });
		service.set(folder.uri, { name: 'Login' });
		service.set(named.uri, { name: 'Frontend' });

		setupResult.join(named);
		setupResult.state = WorkbenchState.FOLDER;
		setupResult.join(folder);
		await timeout(0);

		assert.deepStrictEqual({ renamed: setupResult.renamed, stillHere: service.get(folder.uri)?.name }, { renamed: [], stillHere: 'Login' });
	});

	test('a change is announced once, for the folder that changed', () => {
		const { service, folder } = setup();

		const heard: string[] = [];
		disposables.add(service.onDidChange(uri => heard.push(uri.toString())));

		service.set(folder.uri, { color: 'pink' });
		service.set(folder.uri, { color: 'pink' });   // the same thing again

		assert.deepStrictEqual(heard, [folder.uri.toString()], 'a no-op was announced');
	});

	test('WTA-04 a repository\'s worktree order survives a reload, is announced once, and a record it cannot read is dropped', () => {
		const { service, storage, reopen } = setup();
		const repository = URI.file('/w/api');
		const [a, b, c] = ['/wt/a', '/wt/b', '/wt/c'].map(path => URI.file(path));

		const heard: string[] = [];
		disposables.add(service.onDidChange(uri => heard.push(uri.toString())));
		service.setWorktreeOrder(repository, [b, a, c]);
		service.setWorktreeOrder(repository, [b, a, c]);   // the same thing again
		const reloaded = reopen().worktreeOrder(repository)?.map(uri => uri.path);
		service.setWorktreeOrder(repository, []);   // its last worktree deleted
		const emptied = { order: service.worktreeOrder(repository), stored: storage.get('facade.workspaceBar.worktreeOrder', StorageScope.PROFILE) };

		storage.store('facade.workspaceBar.worktreeOrder', '{not json', StorageScope.PROFILE, StorageTarget.MACHINE);

		assert.deepStrictEqual({
			reloaded,
			emptied,
			heard,
			'another repository': service.worktreeOrder(URI.file('/w/web')),
			'unreadable': reopen().worktreeOrder(repository),
			'the folder customisations untouched': service.get(repository),
		}, {
			reloaded: ['/wt/b', '/wt/a', '/wt/c'],
			emptied: { order: undefined, stored: undefined },
			heard: [repository.toString(), repository.toString()],
			'another repository': undefined,
			'unreadable': undefined,
			'the folder customisations untouched': undefined,
		});
	});

	test('WS-43 ⭐ the palettes and their labels cannot drift apart', () => {
		// ⚠️ `colorLabel` and `iconLabel` are exhaustive switches over these two lists, so a value
		// added here without a label fails the build. This asserts the shape the dialog lays out for:
		// ten of each, `folder` first because it is what an untagged row already draws.
		assert.strictEqual(FOLDER_COLORS.length, 10);
		assert.strictEqual(FOLDER_ICONS.length, 10);
		assert.strictEqual(FOLDER_ICONS[0], 'folder');
		assert.strictEqual(new Set(FOLDER_COLORS).size, FOLDER_COLORS.length, 'a colour is in the list twice');
		assert.strictEqual(new Set(FOLDER_ICONS).size, FOLDER_ICONS.length, 'an icon is in the list twice');
	});

	test('WTA-29 a new worktree takes the first colour its repository\'s others do not have, and none once all are taken', () => {
		assert.deepStrictEqual({
			first: freeWorktreeColor([]),
			next: freeWorktreeColor(['red', undefined, 'orange']),
			last: freeWorktreeColor(FOLDER_COLORS.filter(color => color !== 'pink')),
			none: freeWorktreeColor([...FOLDER_COLORS]),
		}, { first: 'red', next: 'yellow', last: 'pink', none: undefined });
	});
});
