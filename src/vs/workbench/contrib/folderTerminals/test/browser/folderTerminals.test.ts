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
import { EditorActivation } from '../../../../../platform/editor/common/editor.js';
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
import { ITerminalInstance, ITerminalService, TerminalEditorLocation } from '../../../terminal/browser/terminal.js';
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

/** One column of tabs, in order, and the one in front. */
class TestGroup extends mock<IEditorGroup>() {

	readonly tabs: TestEditor[] = [];
	active: TestEditor | undefined;
	override isLocked = false;
	/** Tabs moved out of this group into another: upstream closes an editor in the group it leaves. */
	readonly movedOut: string[] = [];
	/** The close upstream does in the group a tab leaves; its terminal editor service then stops tracking the terminal. */
	closeMovedOut: ((name: string) => void) | undefined;

	constructor(override readonly id: number, tabs: TestEditor[]) {
		super();
		this.tabs.push(...tabs);
	}

	override get activeEditor(): EditorInput | null {
		return this.active?.asInput() ?? null;
	}

	override get count(): number {
		return this.tabs.length;
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
		if (target !== this) {
			this.movedOut.push(moved.name);
			this.closeMovedOut?.(moved.name);
		}
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

	override activeGroup: IEditorGroup;

	constructor(override readonly groups: TestGroup[]) {
		super();
		this.activeGroup = groups[0];
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
 * What this contribution uses of the terminal service, behaving as upstream's does: backgrounding
 * takes the tab away but leaves the instance on `instances`, off `foregroundInstances`, and showing
 * opens it again the way an editor opens - see `showBackgroundTerminal`.
 */
class TestTerminalService extends mock<ITerminalService>() {

	override instances: ITerminalInstance[] = [];

	readonly backgrounded: string[] = [];
	readonly shown: string[] = [];
	readonly askedFor: TerminalEditorLocation[] = [];

	/** Names that should fail to come back, and one that should block until released. */
	readonly failing = new Set<string>();
	blockOn: { name: string; released: DeferredPromise<void> } | undefined;

	/** The names in the background now: taken there, and not yet shown again. */
	private readonly inBackground = new Set<string>();

	constructor(private readonly groups: TestEditorGroupsService) {
		super();
	}

	override get foregroundInstances(): ITerminalInstance[] {
		return this.instances.filter(instance => !this.inBackground.has((instance as unknown as TestInstance).name));
	}

	override moveToBackground(instance: ITerminalInstance): void {
		const named = instance as unknown as TestInstance;
		this.backgrounded.push(named.name);
		this.inBackground.add(named.name);

		for (const part of [this.groups.main, this.groups.floated]) {
			for (const group of part.groups) {
				group.remove(named.name);
			}
		}
	}

	override async showBackgroundTerminal(instance: ITerminalInstance, _suppressSetActive?: boolean, editorOptions?: TerminalEditorLocation): Promise<void> {
		const named = instance as unknown as TestInstance;

		if (this.blockOn?.name === named.name) {
			await this.blockOn.released.p;
		}

		if (this.failing.has(named.name)) {
			throw new Error(`no editor for ${named.name}`);
		}

		this.shown.push(named.name);
		this.inBackground.delete(named.name);
		if (editorOptions) {
			this.askedFor.push({ ...editorOptions });
		}

		// As an editor opens: in the column asked for - a column number is a column, as upstream's
		// `columnToEditorGroup` reads it - or else the first, at the tab asked for or else after the one
		// in front (`workbench.editor.openPositioning`), and in front unless asked not to be.
		const part = editorOptions?.viewColumn === AUX_WINDOW_GROUP ? this.groups.floated : this.groups.main;
		const column = typeof editorOptions?.viewColumn === 'number' && editorOptions.viewColumn >= 0 ? editorOptions.viewColumn : 0;
		const group = part.groups[column] ?? part.groups[0];
		const tab = new TestEditor(named.name, named.resource);
		group.tabs.splice(editorOptions?.index ?? (group.active ? group.tabs.indexOf(group.active) + 1 : group.tabs.length), 0, tab);
		if (!editorOptions?.inactive) {
			group.active = tab;
		}
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

		const folderTerminals = store.add(new FolderTerminals(
			folders, bar, terminals, context, groups,
			new TestConfigurationService(), uriIdentityService, new NullLogService()
		));

		terminals.instances = live.map(instance => instance.asInstance());

		// A terminal whose tab is moved to another group stops being tracked, as upstream's is.
		for (const column of columns) {
			column.closeMovedOut = name => terminals.instances = terminals.instances.filter(instance => (instance as unknown as TestInstance).name !== name);
		}

		return { terminals, folders, context, bar, groups, folderTerminals };
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

	test('a folder\'s terminals are those parked for it, or while the window is on it those of the editor area', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const column = new TestGroup(0, [tabFor(one)]);

		const { folders, context, bar, folderTerminals } = setup([column], [one]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		const names = (folder: IWorkspaceFolder) => folderTerminals.terminalsOf(folder.uri).map(instance => (instance as unknown as TestInstance).name);

		const onAlpha = { alpha: names(alpha), beta: names(beta) };
		await switchTo(folders, bar, beta);

		assert.deepStrictEqual({ onAlpha, onBeta: { alpha: names(alpha), beta: names(beta) } }, {
			onAlpha: { alpha: ['one'], beta: [] },
			onBeta: { alpha: ['one'], beta: [] },
		});
	});

	test('the tab that was in front comes back in front, and the other terminals behind it', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const shell = new TestInstance('shell');
		const readme = file('readme');
		const column = new TestGroup(0, [tabFor(agent), readme, tabFor(shell)]);

		const { terminals, folders, context, bar } = setup([column], [agent, shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		/** Away and back, leaving `inFront` in front - and, while away, the file in front, as the column is then. */
		const roundTrip = async (inFront: string) => {
			column.active = column.tabs.find(tab => tab.name === inFront);
			const asked = terminals.askedFor.length;
			await switchTo(folders, bar, beta);
			column.active = readme;
			await switchTo(folders, bar, alpha);
			return { inFront: column.active?.name, tabs: column.names(), behind: terminals.askedFor.slice(asked).map(options => !!options.inactive) };
		};

		// An agent's terminal left in front comes back in front, not behind the shell opened after it.
		assert.deepStrictEqual({ agent: await roundTrip('agent'), file: await roundTrip('readme') }, {
			agent: { inFront: 'agent', tabs: ['agent', 'readme', 'shell'], behind: [false, true] },
			file: { inFront: 'readme', tabs: ['agent', 'readme', 'shell'], behind: [true, true] },
		});
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

		// Each opens straight in its own column - no group here has a tab in front - and is put back at
		// its tab within it.
		assert.deepStrictEqual([left.names(), right.names()], [['readme', 'one', 'notes'], ['two']]);
	});

	test('one that comes back into a column that is not the active one is still tracked the next time', async () => {
		// Opened straight in its own column, never moved there: a move between groups closes the editor
		// in the group it leaves, and a terminal whose editor closes stops being tracked - the next
		// switch then did not park it, and the working set killed its shell.
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const shell = new TestInstance('shell');

		const left = new TestGroup(0, [file('readme')]);
		const right = new TestGroup(1, [tabFor(agent), tabFor(shell)]);
		right.active = right.tabs[0];

		const { terminals, folders, context, bar } = setup([left, right], [agent, shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		for (let trip = 0; trip < 2; trip++) {
			await switchTo(folders, bar, beta);
			await switchTo(folders, bar, alpha);
		}

		// Asked for as `PRESERVE`: otherwise opening an editor that is not `inactive` into a group that
		// is not the active one activates that group (`handleGroupActivation`), and the column moves.
		const asked = (index: number, inactive: boolean): TerminalEditorLocation => ({ viewColumn: 1, index, preserveFocus: true, inactive, activation: EditorActivation.PRESERVE });
		assert.deepStrictEqual({
			right: right.names(),
			inFront: right.active?.name,
			parked: terminals.backgrounded,
			movedAcross: [...left.movedOut, ...right.movedOut],
			askedFor: terminals.askedFor,
		}, {
			right: ['agent', 'shell'],
			inFront: 'agent',
			parked: ['agent', 'shell', 'agent', 'shell'],
			movedAcross: [],
			askedFor: [asked(0, false), asked(1, true), asked(0, false), asked(1, true)],
		});
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

	test('terminals whose column is gone come back in their order, at the end of a column that is not locked', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');

		const left = new TestGroup(0, [file('readme')]);
		const middle = new TestGroup(1, [file('notes')]);
		const right = new TestGroup(2, [tabFor(one), tabFor(two)]);
		left.active = left.tabs[0];
		middle.active = middle.tabs[0];

		const { folders, context, bar, groups } = setup([left, middle, right], [one, two]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);

		// The layout comes back without the right column, and the active one - the middle - locked.
		groups.main.groups.splice(2, 1);
		groups.main.activeGroup = middle;
		middle.isLocked = true;

		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ left: left.names(), middle: middle.names() }, {
			left: ['readme', 'one', 'two'],
			middle: ['notes'],
		});
	});

	test('a column closed to the left of a terminal\'s own leaves it its own column', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');

		const left = new TestGroup(0, [file('readme')]);
		const middle = new TestGroup(1, [tabFor(one)]);
		const right = new TestGroup(2, [tabFor(two)]);

		const { folders, context, bar, groups } = setup([left, middle, right], [one, two]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);
		groups.main.groups.splice(0, 1);
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ middle: middle.names(), right: right.names() }, { middle: ['one'], right: ['two'] });
	});

	test('a column that is gone by the time it comes back costs the place, not the shell - or the tab in front of the active one', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');

		const left = new TestGroup(0, [file('readme')]);
		const middle = new TestGroup(1, [file('notes')]);
		const right = new TestGroup(2, [tabFor(one)]);
		middle.active = middle.tabs[0];
		right.active = right.tabs[0];

		const { terminals, folders, context, bar, groups } = setup([left, middle, right], [one]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		await switchTo(folders, bar, beta);

		// The layout comes back without the right column, the middle one active.
		groups.main.groups.splice(2, 1);
		groups.main.activeGroup = middle;

		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ shown: terminals.shown, left: left.names(), middle: middle.names(), inFront: middle.active?.name, disposed: one.disposed }, {
			shown: ['one'],
			left: ['readme'],
			middle: ['notes', 'one'],
			inFront: 'notes',
			disposed: false,
		});
	});
});
