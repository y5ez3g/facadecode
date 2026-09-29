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
import { StorageScope, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig, TerminalExitReason, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IActiveFolderService, IActiveFolderWillChangeEvent } from '../../../../services/activeFolder/common/activeFolder.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP, AUX_WINDOW_GROUP } from '../../../../services/editor/common/editorService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService, TerminalEditorLocation } from '../../../terminal/browser/terminal.js';
import { FolderTerminals, PARKED_STORAGE_KEY } from '../../browser/folderTerminals.js';

/** Stands in for any tab, terminal or not: all these tests read off it is where it sits. */
class TestEditor {
	constructor(readonly name: string, readonly resource: URI) { }
	asInput(): EditorInput { return this as unknown as EditorInput; }
}

/** A terminal that knows its resource, whether it persists, and whether it is still alive - and why not. */
class TestInstance {

	private readonly _onDisposed = new Emitter<ITerminalInstance>();
	readonly onDisposed = this._onDisposed.event;

	readonly resource: URI;
	readonly shellLaunchConfig: { forcePersist?: boolean } = {};

	/** Made from its name: the same for the same terminal a reload brings back, as a real one's is. */
	readonly shellIntegrationNonce: string;

	disposed = false;
	exitReason: TerminalExitReason | undefined;
	focused = false;

	target: TerminalLocation;

	constructor(readonly name: string, target = TerminalLocation.Editor) {
		this.target = target;
		this.resource = URI.from({ scheme: 'vscode-terminal', path: '/' + name });
		this.shellIntegrationNonce = 'nonce-' + name;
	}

	async focusWhenReady(): Promise<void> {
		this.focused = true;
	}

	dispose(reason = TerminalExitReason.Unknown): void {
		this.disposed = true;
		this.exitReason = reason;
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

	/** The terminal made the active one, and those put in front, in order. */
	active: string | undefined;
	readonly revealed: string[] = [];

	/** Those shown again in the panel, as one that says it is the panel's is. */
	readonly toPanel: string[] = [];

	/** The names in the background now: taken there, and not yet shown again. */
	private readonly inBackground = new Set<string>();

	override whenConnected = Promise.resolve();

	/** What `createTerminal` was asked for, in order. */
	readonly created: ICreateTerminalOptions[] = [];

	constructor(private readonly groups: TestEditorGroupsService) {
		super();
	}

	/** A terminal named by its config: in the background when it is hidden from the person, as upstream's is. */
	override async createTerminal(options?: ICreateTerminalOptions): Promise<ITerminalInstance> {
		this.created.push(options ?? {});
		const config = (options?.config ?? {}) as IShellLaunchConfig;
		const instance = new TestInstance(config.name ?? `terminal ${this.created.length}`, options?.location === TerminalLocation.Panel ? TerminalLocation.Panel : TerminalLocation.Editor);
		this.instances.push(instance.asInstance());
		if (config.hideFromUser) {
			this.inBackground.add(instance.name);
		}
		return instance.asInstance();
	}

	/** Terminals a reload brought back, in the background as upstream's `_reviveBackgroundTerminalInstances` puts them. */
	revive(instances: TestInstance[]): void {
		this.instances.push(...instances.map(instance => instance.asInstance()));
		for (const instance of instances) {
			this.inBackground.add(instance.name);
		}
	}

	override get foregroundInstances(): ITerminalInstance[] {
		return this.instances.filter(instance => !this.inBackground.has((instance as unknown as TestInstance).name));
	}

	override setActiveInstance(instance: ITerminalInstance): void {
		this.active = (instance as unknown as TestInstance).name;
	}

	override async revealTerminal(instance: ITerminalInstance): Promise<void> {
		this.revealed.push((instance as unknown as TestInstance).name);
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

		// One that says it is the panel's goes to the panel, whatever tab it is asked for
		if (named.target === TerminalLocation.Panel) {
			this.toPanel.push(named.name);
			this.inBackground.delete(named.name);
			return;
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

/**
 * The one signal this contribution listens to - the editors of the new folder are up - and moving
 * onto a folder, which the tests say the meaning of.
 */
class TestWorkspaceBarService extends mock<IWorkspaceBarService>() {

	private readonly _onDidRestoreEditors = new Emitter<void>();
	override readonly onDidRestoreEditors = this._onDidRestoreEditors.event;

	/** The folders moved onto, and what a move does. */
	readonly moves: string[] = [];
	moving: (uri: URI) => Promise<void> = async () => { };

	restored(): void { this._onDidRestoreEditors.fire(); }

	override async show(uri: URI): Promise<void> {
		this.moves.push(uri.path);
		await this.moving(uri);
	}
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

	/**
	 * The contribution and what it stands on. `reload` is a window opening again: on the storage the
	 * last one kept its state in and on the folder `opensOn`, with the terminals it had parked back in
	 * the background once the terminal service is `connected` - at once unless that is given.
	 */
	function setup(columns: TestGroup[], live: TestInstance[], floatedTabs: TestEditor[] = [], reload?: { storage: TestStorageService; revived: TestInstance[]; opensOn: IWorkspaceFolder; connected?: Promise<void> }) {
		const store = disposables.add(new DisposableStore());
		const groups = new TestEditorGroupsService(columns, floatedTabs);
		const terminals = new TestTerminalService(groups);
		terminals.instances = live.map(instance => instance.asInstance());
		terminals.revive(reload?.revived ?? []);
		if (reload?.connected) {
			terminals.whenConnected = reload.connected;
		}
		const storage = reload?.storage ?? store.add(new TestStorageService());
		const folders = new TestActiveFolderService();
		folders.activeFolder = reload?.opensOn;
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
			new TestConfigurationService(), uriIdentityService, storage, new NullLogService()
		));

		// A terminal whose tab is moved to another group stops being tracked, as upstream's is.
		for (const column of columns) {
			column.closeMovedOut = name => terminals.instances = terminals.instances.filter(instance => (instance as unknown as TestInstance).name !== name);
		}

		return { terminals, folders, context, bar, groups, folderTerminals, storage };
	}

	/** One switch, with the moment the bar says the incoming folder's editors are up. */
	async function switchTo(folders: TestActiveFolderService, bar: TestWorkspaceBarService, to: IWorkspaceFolder) {
		await folders.switchTo(to);
		bar.restored();
		await timeout(0);
	}

	/**
	 * Moving onto a folder through the bar, as the bar does it: settled once the window is on the
	 * folder, before its editors are up - which is when the test calls `bar.restored()`.
	 */
	function moveThroughTheBar(bar: TestWorkspaceBarService, folders: TestActiveFolderService, context: TestContextService): void {
		bar.moving = uri => folders.switchTo(context.folders.find(candidate => candidate.uri.path === uri.path)!);
	}

	/** Parks `parked` for alpha by moving onto beta, then closes the window: the terminals go, and the state is kept. */
	async function closeWithParked(parked: TestInstance[], alpha: IWorkspaceFolder, beta: IWorkspaceFolder) {
		const before = setup([new TestGroup(0, parked.map(tabFor))], parked);
		before.context.folders = [alpha, beta];
		before.folders.activeFolder = alpha;
		await switchTo(before.folders, before.bar, beta);

		// Taken away before the state is kept, the order that would lose them
		for (const instance of parked) {
			instance.dispose(TerminalExitReason.Shutdown);
		}
		before.storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		return before.storage;
	}

	test('a terminal opened for a folder the window is not on is held for it, and comes up when the window goes there', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const column = new TestGroup(0, []);
		const { terminals, folders, context, bar, folderTerminals } = setup([column], []);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		const names = (of: IWorkspaceFolder) => folderTerminals.terminalsOf(of.uri).map(instance => (instance as unknown as TestInstance).name);

		const agent = await folderTerminals.openFor(beta.uri, { name: 'agent' });
		const whileAway = { hidden: !!(terminals.created[0].config as IShellLaunchConfig).hideFromUser, alpha: names(alpha), beta: names(beta), tabs: column.names() };
		await switchTo(folders, bar, beta);

		assert.deepStrictEqual({ whileAway, shown: terminals.shown, tabs: column.names(), folder: folderTerminals.folderOf(agent)?.name }, {
			whileAway: { hidden: true, alpha: [], beta: ['agent'], tabs: [] },
			shown: ['agent'],
			tabs: ['agent'],
			folder: 'beta',
		});
	});

	test('a terminal opened for the folder on screen is one of its editor terminals; for a folder not in the workspace, the panel\'s', async () => {
		const alpha = folder('alpha');
		const { terminals, folders, context, folderTerminals } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha];
		folders.activeFolder = alpha;

		await folderTerminals.openFor(alpha.uri, { name: 'here' });
		await folderTerminals.openFor(URI.file('/elsewhere'), { name: 'there' });

		assert.deepStrictEqual(terminals.created.map(options => ({ name: (options.config as IShellLaunchConfig).name, location: options.location, hidden: !!(options.config as IShellLaunchConfig).hideFromUser })), [
			{ name: 'here', location: { viewColumn: ACTIVE_GROUP }, hidden: false },
			{ name: 'there', location: TerminalLocation.Panel, hidden: false },
		]);
	});

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

	test('a terminal belongs to the folder it is parked for, with a tab to the folder on screen, and in the panel to none', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const parked = new TestInstance('parked');
		const opened = new TestInstance('opened');
		const panel = new TestInstance('panel', TerminalLocation.Panel);
		const column = new TestGroup(0, [tabFor(parked)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [parked, panel]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);

		// Opened on beta, after the switch
		terminals.instances.push(opened.asInstance());
		column.tabs.push(tabFor(opened));

		const folderOf = (instance: TestInstance) => folderTerminals.folderOf(instance.asInstance())?.uri.path;
		assert.deepStrictEqual({ parked: folderOf(parked), opened: folderOf(opened), panel: folderOf(panel) }, {
			parked: '/w/alpha',
			opened: '/w/beta',
			panel: undefined,
		});
	});

	test('revealing a terminal parked for another folder moves the window onto that folder, and puts it in front once it is back', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [agent]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);
		moveThroughTheBar(bar, folders, context);

		const revealing = folderTerminals.reveal(agent.asInstance());
		await timeout(0);
		const beforeItIsBack = { revealed: [...terminals.revealed], focused: agent.focused };
		bar.restored();
		await revealing;

		assert.deepStrictEqual({ on: folders.activeFolder?.name, moves: bar.moves, beforeItIsBack, tabs: column.names(), active: terminals.active, revealed: terminals.revealed, focused: agent.focused }, {
			on: 'alpha',
			moves: ['/w/alpha'],
			beforeItIsBack: { revealed: [], focused: false },
			tabs: ['agent'],
			active: 'agent',
			revealed: ['agent'],
			focused: true,
		});
	});

	test('revealing a terminal of the folder on screen puts it in front without moving the window', async () => {
		const alpha = folder('alpha');
		const agent = new TestInstance('agent');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(agent), tabFor(shell)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [agent, shell]);
		context.folders = [alpha];
		folders.activeFolder = alpha;

		await folderTerminals.reveal(agent.asInstance());

		assert.deepStrictEqual({ moves: bar.moves, active: terminals.active, revealed: terminals.revealed, focused: agent.focused }, {
			moves: [],
			active: 'agent',
			revealed: ['agent'],
			focused: true,
		});
	});

	test('a terminal that cannot be shown again is not revealed, and stays parked for its folder', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [agent]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);
		moveThroughTheBar(bar, folders, context);
		terminals.failing.add('agent');

		const revealing = folderTerminals.reveal(agent.asInstance());
		await timeout(0);
		bar.restored();
		await revealing;

		assert.deepStrictEqual({ active: terminals.active, revealed: terminals.revealed, focused: agent.focused, parkedFor: folderTerminals.folderOf(agent.asInstance())?.uri.path }, {
			active: undefined,
			revealed: [],
			focused: false,
			parkedFor: '/w/alpha',
		});
	});

	test('moving on again before the terminal is back leaves it parked for its folder, unrevealed', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [agent]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);
		moveThroughTheBar(bar, folders, context);

		// Held half way back, while the window leaves for beta again
		terminals.blockOn = { name: 'agent', released: new DeferredPromise<void>() };
		const revealing = folderTerminals.reveal(agent.asInstance());
		await timeout(0);
		bar.restored();
		await timeout(0);
		await folders.switchTo(beta);
		terminals.blockOn.released.complete();
		await revealing;
		await timeout(0);

		assert.deepStrictEqual({ on: folders.activeFolder?.name, active: terminals.active, revealed: terminals.revealed, focused: agent.focused, parkedFor: folderTerminals.folderOf(agent.asInstance())?.uri.path }, {
			on: 'beta',
			active: undefined,
			revealed: [],
			focused: false,
			parkedFor: '/w/alpha',
		});
	});

	test('the terminals parked for a folder are parked for it again when a reload brings them back, and come back to their tabs', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const storage = await closeWithParked([new TestInstance('agent'), new TestInstance('shell')], alpha, beta);

		// Brought back as upstream brings back a background terminal: the panel's
		const agent = new TestInstance('agent', TerminalLocation.Panel);
		const shell = new TestInstance('shell', TerminalLocation.Panel);
		const column = new TestGroup(0, []);
		const { terminals, folders, context, bar, folderTerminals } = setup([column], [], [], { storage, revived: [agent, shell], opensOn: beta });
		context.folders = [alpha, beta];
		await timeout(0);

		const parkedFor = (instance: TestInstance) => folderTerminals.folderOf(instance.asInstance())?.uri.path;
		const onBeta = { agent: parkedFor(agent), shell: parkedFor(shell), tabs: column.names() };
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ onBeta, backOnAlpha: column.names(), inPanel: terminals.toPanel }, {
			onBeta: { agent: '/w/alpha', shell: '/w/alpha', tabs: [] },
			backOnAlpha: ['agent', 'shell'],
			inPanel: [],
		});
	});

	test('a reload onto the folder they were parked for shows them at once, and one that did not come back is forgotten', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const storage = await closeWithParked([new TestInstance('agent'), new TestInstance('shell')], alpha, beta);

		// The agent does not come back, as after a restart of the app
		const shell = new TestInstance('shell', TerminalLocation.Panel);
		const column = new TestGroup(0, []);
		const { context } = setup([column], [], [], { storage, revived: [shell], opensOn: alpha });
		context.folders = [alpha, beta];
		await timeout(0);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		assert.deepStrictEqual({ tabs: column.names(), kept: storage.get(PARKED_STORAGE_KEY, StorageScope.WORKSPACE) }, {
			tabs: ['shell'],
			kept: undefined,
		});
	});

	test('a parked terminal that ends is not kept for the next window, and one the window closing takes away is', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const shell = new TestInstance('shell');

		const { folders, context, bar, storage } = setup([new TestGroup(0, [tabFor(agent), tabFor(shell)])], [agent, shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);
		shell.dispose(TerminalExitReason.User);
		agent.dispose(TerminalExitReason.Shutdown);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		const kept: Record<string, { nonce: string }[]> = JSON.parse(storage.get(PARKED_STORAGE_KEY, StorageScope.WORKSPACE) ?? '{}');
		assert.deepStrictEqual(Object.values(kept).flat().map(entry => entry.nonce), ['nonce-agent']);
	});

	test('a switch still putting its folder\'s editors up when the terminals are back does not show them before it has', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const storage = await closeWithParked([new TestInstance('agent')], alpha, beta);

		const column = new TestGroup(0, []);
		const connected = new DeferredPromise<void>();
		const { folders, context, bar } = setup([column], [], [], { storage, revived: [new TestInstance('agent', TerminalLocation.Panel)], opensOn: beta, connected: connected.p });
		context.folders = [alpha, beta];

		// Onto alpha while the terminal service is still bringing them back. The working set that is
		// putting alpha's editors up would close a tab shown now, and the shell in it.
		await folders.switchTo(alpha);
		connected.complete();
		await timeout(0);
		const whileSwitching = column.names();
		bar.restored();
		await timeout(0);

		assert.deepStrictEqual({ whileSwitching, onceUp: column.names() }, { whileSwitching: [], onceUp: ['agent'] });
	});

	test('a switch that has put its folder\'s editors up by the time the terminals are back shows them at once', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const storage = await closeWithParked([new TestInstance('agent')], alpha, beta);

		const column = new TestGroup(0, []);
		const connected = new DeferredPromise<void>();
		const { folders, context, bar } = setup([column], [], [], { storage, revived: [new TestInstance('agent', TerminalLocation.Panel)], opensOn: beta, connected: connected.p });
		context.folders = [alpha, beta];

		await switchTo(folders, bar, alpha);
		connected.complete();
		await timeout(0);

		assert.deepStrictEqual(column.names(), ['agent']);
	});
});
