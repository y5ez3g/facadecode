/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IActiveFolderService, IActiveFolderWillChangeEvent } from '../../../../services/activeFolder/common/activeFolder.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { AUX_WINDOW_GROUP } from '../../../../services/editor/common/editorService.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { FolderTerminals } from '../../browser/folderTerminals.js';

/** Stands in for any tab, terminal or not: all these tests read off it is where it sits. */
class TestEditor {
	constructor(readonly name: string, readonly resource: URI) { }
	asInput(): EditorInput { return this as unknown as EditorInput; }
}

/** A terminal that knows its resource, whether it persists, and whether it is still alive. */
class TestInstance {

	private readonly _onDisposed = new Emitter<ITerminalInstance>();
	readonly onDisposed = this._onDisposed.event;

	readonly resource: URI;
	readonly target = TerminalLocation.Editor;
	readonly shellLaunchConfig: { forcePersist?: boolean } = {};

	disposed = false;

	constructor(readonly name: string) {
		this.resource = URI.from({ scheme: 'vscode-terminal', path: '/' + name });
	}

	dispose(): void {
		this.disposed = true;
		this._onDisposed.fire(this as unknown as ITerminalInstance);
	}

	asInstance(): ITerminalInstance { return this as unknown as ITerminalInstance; }
}

/** One column of tabs, in order. */
class TestGroup extends mock<IEditorGroup>() {

	readonly tabs: TestEditor[] = [];

	constructor(override readonly id: number, tabs: TestEditor[]) {
		super();
		this.tabs.push(...tabs);
	}

	override findEditors(resource: URI): EditorInput[] {
		return this.tabs.filter(tab => tab.resource.toString() === resource.toString()).map(tab => tab.asInput());
	}

	override getIndexOfEditor(editor: EditorInput): number {
		return this.tabs.indexOf(editor as unknown as TestEditor);
	}

	override moveEditor(editor: EditorInput, target: IEditorGroup, options?: { index?: number }): boolean {
		const from = this.tabs.indexOf(editor as unknown as TestEditor);
		if (from < 0 || options?.index === undefined) {
			return false;
		}

		const [moved] = this.tabs.splice(from, 1);
		(target as unknown as TestGroup).tabs.splice(options.index, 0, moved);
		return true;
	}

	remove(name: string): void {
		const at = this.tabs.findIndex(tab => tab.name === name);
		if (at >= 0) {
			this.tabs.splice(at, 1);
		}
	}

	names(): string[] {
		return this.tabs.map(tab => tab.name);
	}
}

class TestPart extends mock<IEditorPart>() {

	constructor(override readonly groups: TestGroup[]) {
		super();
	}

	override getGroups(): readonly IEditorGroup[] { return this.groups; }
}

class TestEditorGroupsService extends mock<IEditorGroupsService>() {

	readonly main: TestPart;
	readonly floated: TestPart;

	constructor(columns: TestGroup[], floatedTabs: TestEditor[] = []) {
		super();
		this.main = new TestPart(columns);
		this.floated = new TestPart([new TestGroup(99, floatedTabs)]);
	}

	override get mainPart(): IEditorPart { return this.main as unknown as IEditorPart; }
	override get parts(): readonly IEditorPart[] { return [this.main, this.floated] as unknown as IEditorPart[]; }
}

/**
 * The two calls this contribution makes, behaving as upstream's do: backgrounding takes the tab
 * away but leaves the instance on `instances`, and showing puts it back at the end of whichever
 * window it was asked for.
 */
class TestTerminalService extends mock<ITerminalService>() {

	override instances: ITerminalInstance[] = [];

	readonly backgrounded: string[] = [];
	readonly shown: string[] = [];
	readonly askedFor: { preserveFocus?: boolean; viewColumn?: unknown }[] = [];

	/** Names that should fail to come back, and one that should block until released. */
	readonly failing = new Set<string>();
	blockOn: { name: string; released: DeferredPromise<void> } | undefined;

	constructor(private readonly groups: TestEditorGroupsService) {
		super();
	}

	override moveToBackground(instance: ITerminalInstance): void {
		const named = instance as unknown as TestInstance;
		this.backgrounded.push(named.name);

		for (const part of [this.groups.main, this.groups.floated]) {
			for (const group of part.groups) {
				group.remove(named.name);
			}
		}
	}

	override async showBackgroundTerminal(instance: ITerminalInstance, _suppressSetActive?: boolean, editorOptions?: { preserveFocus?: boolean; viewColumn?: unknown }): Promise<void> {
		const named = instance as unknown as TestInstance;

		if (this.blockOn?.name === named.name) {
			await this.blockOn.released.p;
		}

		if (this.failing.has(named.name)) {
			throw new Error(`no editor for ${named.name}`);
		}

		this.shown.push(named.name);
		this.askedFor.push({ preserveFocus: editorOptions?.preserveFocus, viewColumn: editorOptions?.viewColumn });

		const part = editorOptions?.viewColumn === AUX_WINDOW_GROUP ? this.groups.floated : this.groups.main;
		part.groups[0].tabs.push(new TestEditor(named.name, named.resource));
	}
}

class TestActiveFolderService extends mock<IActiveFolderService>() {

	private readonly _onWillChange = new Emitter<IActiveFolderWillChangeEvent>();
	override readonly onWillChangeActiveFolder = this._onWillChange.event;

	private readonly _onDidChange = new Emitter<void>();
	override readonly onDidChangeActiveFolder = this._onDidChange.event;

	override activeFolder: IWorkspaceFolder | undefined;

	async switchTo(to: IWorkspaceFolder): Promise<void> {
		const joins: Promise<void>[] = [];
		this._onWillChange.fire({ from: this.activeFolder, to, join: promise => { joins.push(promise); } });
		await Promise.all(joins);

		this.activeFolder = to;
		this._onDidChange.fire();
	}
}

/** Only the one signal this contribution listens to: the editors of the new folder are up. */
class TestWorkspaceBarService extends mock<IWorkspaceBarService>() {

	private readonly _onDidRestoreEditors = new Emitter<void>();
	override readonly onDidRestoreEditors = this._onDidRestoreEditors.event;

	restored(): void { this._onDidRestoreEditors.fire(); }
}

class TestContextService extends mock<IWorkspaceContextService>() {

	private readonly _onDidChangeFolders = new Emitter<never>();
	override readonly onDidChangeWorkspaceFolders = this._onDidChangeFolders.event as Event<never>;

	folders: IWorkspaceFolder[] = [];

	override getWorkspace(): IWorkspace {
		return { id: 'test', folders: this.folders, transient: false, configuration: null } satisfies IWorkspace;
	}

	removeFolder(folder: IWorkspaceFolder): void {
		this.folders = this.folders.filter(candidate => candidate !== folder);
		this._onDidChangeFolders.fire(undefined as never);
	}
}

suite('Folder terminals - a terminal outlives leaving its folder', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const folder = (name: string): IWorkspaceFolder => new WorkspaceFolder({ uri: URI.file('/w/' + name), name, index: 0 });
	const file = (name: string) => new TestEditor(name, URI.file('/w/' + name));
	const tabFor = (instance: TestInstance) => new TestEditor(instance.name, instance.resource);

	function setup(columns: TestGroup[], live: TestInstance[], floatedTabs: TestEditor[] = []) {
		const store = disposables.add(new DisposableStore());
		const groups = new TestEditorGroupsService(columns, floatedTabs);
		const terminals = new TestTerminalService(groups);
		const folders = new TestActiveFolderService();
		const context = new TestContextService();
		const bar = new TestWorkspaceBarService();
		const uriIdentityService: IUriIdentityService = store.add(new UriIdentityService(new class extends mock<IFileService>() {
			override onDidChangeFileSystemProviderRegistrations = Event.None;
			override onDidChangeFileSystemProviderCapabilities = Event.None;
			override hasProvider() { return true; }

			// Case-insensitive, like the file systems this window is used on.
			override hasCapability(_resource: URI, capability: FileSystemProviderCapabilities): boolean {
				return capability !== FileSystemProviderCapabilities.PathCaseSensitive;
			}
		}));

		store.add(new FolderTerminals(
			folders, bar, terminals, context, groups,
			new TestConfigurationService(), uriIdentityService, new NullLogService()
		));

		terminals.instances = live.map(instance => instance.asInstance());

		return { terminals, folders, context, bar, groups };
	}

	/** One switch, with the moment the bar says the incoming folder's editors are up. */
	async function switchTo(folders: TestActiveFolderService, bar: TestWorkspaceBarService, to: IWorkspaceFolder) {
		await folders.switchTo(to);
		bar.restored();
		await timeout(0);
	}

	test('switching away parks them alive, and switching back brings the same ones', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');
		const column = new TestGroup(0, [tabFor(one), tabFor(two)]);

		const { terminals, folders, context, bar } = setup([column], [one, two]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);

		assert.deepStrictEqual([
			terminals.backgrounded,			// taken out of the editor area
			column.names(),					// and no tab left behind
			one.disposed || two.disposed	// but neither shell was ended
		], [['one', 'two'], [], false]);

		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual([terminals.shown, column.names()], [['one', 'two'], ['one', 'two']]);
	});

	test('each one comes back to the column and the tab it was at', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');

		// A terminal between two files in the first column, and one alone in the second.
		const left = new TestGroup(0, [file('readme'), tabFor(one), file('notes')]);
		const right = new TestGroup(1, [tabFor(two)]);

		const { folders, context, bar } = setup([left, right], [one, two]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);

		// Both arrive at the end of the first column and are moved from there, so this also says the
		// move can cross columns.
		assert.deepStrictEqual([left.names(), right.names()], [['readme', 'one', 'notes'], ['two']]);
	});

	test('a floated terminal is parked too, and comes back floated', async () => {
		// A folder switch closes every auxiliary editor part - `EditorParts.applyState` force-closes
		// their editors and then the part - so a floated terminal dies exactly like a docked one.
		const alpha = folder('alpha');
		const beta = folder('beta');
		const floated = new TestInstance('floated');

		const { terminals, folders, context, bar, groups } = setup([new TestGroup(0, [])], [floated], [tabFor(floated)]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual([
			terminals.backgrounded,
			terminals.askedFor.map(asked => asked.viewColumn === AUX_WINDOW_GROUP),
			groups.floated.groups[0].names(),
			floated.disposed
		], [['floated'], [true], ['floated'], false]);
	});

	test('parked shells are asked to persist, and stop being asked once they are back', async () => {
		// `setTerminalLayoutInfo` only writes down backgrounded terminals carrying `forcePersist`, so
		// without this a reload throws away exactly the shells this class exists to keep.
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');

		const { folders, context, bar } = setup([new TestGroup(0, [tabFor(one)])], [one]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);
		const whileParked = one.shellLaunchConfig.forcePersist;

		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual([whileParked, one.shellLaunchConfig.forcePersist], [true, undefined]);
	});

	test('one that will not come back stays recorded rather than becoming a stray shell', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');
		const column = new TestGroup(0, [tabFor(one), tabFor(two)]);

		const { terminals, folders, context, bar } = setup([column], [one, two]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		terminals.failing.add('one');

		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);

		// Nothing came back, and nothing was ended: the shells are still held for another try.
		assert.deepStrictEqual([terminals.shown, one.disposed, two.disposed], [[], false, false]);

		terminals.failing.clear();
		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual(terminals.shown, ['one', 'two']);
	});

	test('a switch arriving mid-restore leaves the rest parked instead of opening them elsewhere', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');
		const column = new TestGroup(0, [tabFor(one), tabFor(two)]);

		const { terminals, folders, context, bar } = setup([column], [one, two]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);

		// Come back, but hold the first terminal half way.
		terminals.blockOn = { name: 'one', released: new DeferredPromise<void>() };
		const returning = folders.switchTo(alpha).then(() => bar.restored());
		await timeout(0);

		// While it is held, the window leaves again. Releasing must not open `two` into beta.
		await folders.switchTo(beta);
		terminals.blockOn.released.complete();
		await returning;
		await timeout(0);

		// `one` was already in flight and does land, so it is put straight back rather than left
		// showing in beta; `two` was never started. Both are still held for alpha.
		assert.deepStrictEqual([terminals.shown, terminals.backgrounded, column.names()], [
			['one'],
			['one', 'two', 'one'],
			[]
		]);

		// And alpha gets both of them back when the window returns to it.
		await switchTo(folders, bar, alpha);
		assert.deepStrictEqual([terminals.shown, column.names()], [['one', 'one', 'two'], ['one', 'two']]);
	});

	test('a parked shell that exits on its own is not handed back', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');
		const column = new TestGroup(0, [tabFor(one), tabFor(two)]);

		const { terminals, folders, context, bar } = setup([column], [one, two]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);
		one.dispose();	// the shell exited while nobody was looking at it
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual([terminals.shown, column.names()], [['two'], ['two']]);
	});

	test('a folder taken out of the workspace does not leave live shells behind', async () => {
		// The case the active folder service says it will not announce: no will-change fires, so
		// without pruning these would be shells with no tab and no way back to one.
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');

		const { folders, context, bar } = setup([new TestGroup(0, [tabFor(one)])], [one]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);
		context.removeFolder(alpha);

		assert.strictEqual(one.disposed, true);
	});

	test('the caret is asked to stay where the switch left it', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');

		const { terminals, folders, context, bar } = setup([new TestGroup(0, [tabFor(one)])], [one]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);

		// Measured before this was asked for: focus was in the side bar before a switch and in a
		// terminal's `xterm-helper-textarea` after it.
		assert.deepStrictEqual(terminals.askedFor.map(asked => asked.preserveFocus), [true]);
	});

	test('a column that is gone by the time it comes back costs the place, not the shell', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');

		const left = new TestGroup(0, [file('readme')]);
		const right = new TestGroup(1, [tabFor(one)]);

		const { terminals, folders, context, bar, groups } = setup([left, right], [one]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);

		// The layout comes back with one column where there were two.
		groups.main.groups.splice(1, 1);

		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual([terminals.shown, left.names(), one.disposed], [['one'], ['readme', 'one'], false]);
	});
});
