/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { FOLDER_COLORS, FOLDER_ICONS, WorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';

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
	}

	function setup(stored?: string): ISetup {
		const store = disposables.add(new DisposableStore());
		const storage = store.add(new InMemoryStorageService());
		if (stored !== undefined) {
			storage.store(STORAGE_KEY, stored, StorageScope.PROFILE, 0 /* USER */);
		}

		const uriIdentityService = store.add(new UriIdentityService(new TestFileService()));
		const build = () => store.add(new WorkspaceBarCustomizationService(storage, uriIdentityService));

		return {
			service: build(),
			storage,
			folder: new WorkspaceFolder({ uri: URI.file('/w/api'), index: 0, name: 'api' }),
			reopen: build
		};
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

	test('a change is announced once, for the folder that changed', () => {
		const { service, folder } = setup();

		const heard: string[] = [];
		disposables.add(service.onDidChange(uri => heard.push(uri.toString())));

		service.set(folder.uri, { color: 'pink' });
		service.set(folder.uri, { color: 'pink' });   // the same thing again

		assert.deepStrictEqual(heard, [folder.uri.toString()], 'a no-op was announced');
	});

	test('⭐ the palettes and their labels cannot drift apart', () => {
		// ⚠️ `colorLabel` and `iconLabel` are exhaustive switches over these two lists, so a value
		// added here without a label fails the build. This asserts the shape the dialog lays out for:
		// ten of each, `folder` first because it is what an untagged row already draws.
		assert.strictEqual(FOLDER_COLORS.length, 10);
		assert.strictEqual(FOLDER_ICONS.length, 10);
		assert.strictEqual(FOLDER_ICONS[0], 'folder');
		assert.strictEqual(new Set(FOLDER_COLORS).size, FOLDER_COLORS.length, 'a colour is in the list twice');
		assert.strictEqual(new Set(FOLDER_ICONS).size, FOLDER_ICONS.length, 'an icon is in the list twice');
	});
});
