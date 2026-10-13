/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { EditorActivation } from '../../../../../platform/editor/common/editor.js';
import { FileOperationError, FileOperationResult, FileSystemProviderCapabilities, IFileService, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import { StorageScope, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { IShellLaunchConfig, TerminalExitReason, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService, ShowResult } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IActiveFolderService, IActiveFolderWillChangeEvent } from '../../../../services/activeFolder/common/activeFolder.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { AUX_WINDOW_GROUP } from '../../../../services/editor/common/editorService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService, TerminalEditorLocation } from '../../../terminal/browser/terminal.js';
import { FOLLOW_FOLDER, FolderTerminals, OPENED_FOR_STORAGE_KEY, PARKED_STORAGE_KEY } from '../../browser/folderTerminals.js';

/**
 * Stands in for any tab, terminal or not: all these tests read off it is where it sits - and, for what is
 * left of a terminal's tab after it went to the background, that its editor is disposed, and that closing it
 * would ask first unless reverted, as a terminal running a child process says.
 */
class TestEditor {
	disposed = false;
	asks = false;
	reverted = false;
	constructor(readonly name: string, readonly resource: URI) { }
	asInput(): EditorInput { return this as unknown as EditorInput; }
	isDisposed(): boolean { return this.disposed; }
	async revert(): Promise<void> { this.reverted = true; }
}

/** A terminal that knows its resource, whether it persists, and whether it is still alive - and why not. */
class TestInstance {

	private readonly _onDisposed = new Emitter<ITerminalInstance>();
	readonly onDisposed = this._onDisposed.event;

	readonly resource: URI;
	readonly shellLaunchConfig: { forcePersist?: boolean; hideFromUser?: boolean } = {};

	/** Made from its name: the same for the same terminal a reload brings back, as a real one's is. */
	readonly shellIntegrationNonce: string;

	disposed = false;
	exitReason: TerminalExitReason | undefined;
	focused = false;

	target: TerminalLocation;

	get isDisposed(): boolean { return this.disposed; }

	/** What its tab says: its name. */
	get title(): string { return this.name; }

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

	/** Tabs whose closing would have asked first, and those that refuse to close. */
	readonly asked: string[] = [];
	readonly refusing = new Set<string>();

	override async closeEditor(editor?: EditorInput): Promise<boolean> {
		const tab = editor as unknown as TestEditor | undefined;
		if (!tab || !this.tabs.includes(tab) || this.refusing.has(tab.name)) {
			return false;
		}
		if (tab.asks && !tab.reverted) {
			this.asked.push(tab.name);
			return false;
		}
		this.tabs.splice(this.tabs.indexOf(tab), 1);
		if (this.active === tab) {
			this.active = undefined;
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
	override get groups(): readonly IEditorGroup[] { return [...this.main.groups, ...this.floated.groups]; }
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

	/** Names that should fail to come back, one that should block until released, and one that should once its tab is up. */
	readonly failing = new Set<string>();

	/** Names whose showing should open nothing, as upstream's does when the editor it opens is refused. */
	readonly openingNothing = new Set<string>();

	/**
	 * Names whose tab should be left behind when they go to the background - its editor disposed, and saying
	 * closing it would ask first, as a terminal running a child process says - as upstream's group leaves it
	 * until the next turn of the event loop, and a working set put up meanwhile keeps it.
	 */
	readonly leavingTabs = new Set<string>();
	blockOn: { name: string; released: DeferredPromise<void> } | undefined;
	blockOnceUp: { name: string; released: DeferredPromise<void> } | undefined;

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

	/** What happens while a terminal is being made, which upstream takes a while over. */
	whileCreating: (() => void) | undefined;

	constructor(private readonly groups: TestEditorGroupsService) {
		super();
	}

	/** A terminal named by its config: in the background when it is hidden from the person, as upstream's is. */
	override async createTerminal(options?: ICreateTerminalOptions): Promise<ITerminalInstance> {
		this.created.push(options ?? {});
		this.whileCreating?.();
		const config = (options?.config ?? {}) as IShellLaunchConfig;
		const instance = new TestInstance(config.name ?? `terminal ${this.created.length}`, options?.location === TerminalLocation.Panel ? TerminalLocation.Panel : TerminalLocation.Editor);
		instance.shellLaunchConfig.hideFromUser = config.hideFromUser;
		this.instances.push(instance.asInstance());
		if (config.hideFromUser) {
			this.inBackground.add(instance.name);
		}
		return instance.asInstance();
	}

	/** Terminals a reload brought back, hidden and in the background as upstream's `_reviveBackgroundTerminalInstances` puts them. */
	revive(instances: TestInstance[]): void {
		this.instances.push(...instances.map(instance => instance.asInstance()));
		for (const instance of instances) {
			instance.shellLaunchConfig.hideFromUser = true;
			this.inBackground.add(instance.name);
		}
	}

	override get foregroundInstances(): ITerminalInstance[] {
		return this.instances.filter(instance => !this.inBackground.has((instance as unknown as TestInstance).name));
	}

	/** As upstream's: a terminal hidden from the person comes up as it is made the active one, wherever the window is. */
	override setActiveInstance(instance: ITerminalInstance): void {
		const named = instance as unknown as TestInstance;
		if (named.shellLaunchConfig.hideFromUser) {
			this.showBackgroundTerminal(instance);
		}
		this.active = named.name;
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
				if (!this.leavingTabs.has(named.name)) {
					group.remove(named.name);
					continue;
				}
				for (const tab of group.tabs.filter(candidate => candidate.name === named.name)) {
					tab.disposed = true;
					tab.asks = true;
				}
			}
		}
	}

	/** As upstream's: out of the editor area, into the panel. */
	override async moveToTerminalView(source?: ITerminalInstance | URI): Promise<void> {
		const named = source as unknown as TestInstance;
		for (const group of [...this.groups.main.groups, ...this.groups.floated.groups]) {
			group.remove(named.name);
		}
		named.target = TerminalLocation.Panel;
		this.toPanel.push(named.name);
	}

	override async showBackgroundTerminal(instance: ITerminalInstance, _suppressSetActive?: boolean, editorOptions?: TerminalEditorLocation): Promise<void> {
		const named = instance as unknown as TestInstance;

		if (this.blockOn?.name === named.name) {
			await this.blockOn.released.p;
		}

		// Ended meanwhile, it has left the background: there is nothing to show, as upstream's finds
		if (named.disposed) {
			return;
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

		// Out of the background, and on the terminal editor service's list, but in no tab: refused - or given
		// what is left of its tab, as a terminal has one tab (`singlePerResource`), which opens nothing
		const left = [...this.groups.main.groups, ...this.groups.floated.groups].some(group => group.tabs.some(tab => tab.disposed && tab.resource.toString() === named.resource.toString()));
		if (this.openingNothing.has(named.name) || left) {
			return;
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

		if (this.blockOnceUp?.name === named.name) {
			await this.blockOnceUp.released.p;
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
 * The signals this contribution listens to - the editors of the new folder are up, git's files were
 * read again - and moving onto a folder, which the tests say the meaning of.
 */
class TestWorkspaceBarService extends mock<IWorkspaceBarService>() {

	private readonly _onDidRestoreEditors = new Emitter<void>();
	override readonly onDidRestoreEditors = this._onDidRestoreEditors.event;

	private readonly _onDidChangeRepositories = new Emitter<void>();
	override readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

	/** The folders moved onto, and what a move does. */
	readonly moves: string[] = [];
	moving: (uri: URI) => Promise<void> = async () => { };

	/** The worktrees git lists that are not folders of the workspace: each a row of the bar all the same. */
	rows: URI[] = [];

	/** The folders of the workspace their repository has, as the bar read them. */
	members: IWorkspaceFolder[] = [];

	/** Whether folders leave through Remove Folder, which agreed to stop what runs in them, rather than a file edit. */
	removing = true;

	override isRemoving(): boolean { return this.removing; }

	restored(): void { this._onDidRestoreEditors.fire(); }

	/** Git's files read again, finding the worktrees `rows` says - none at all while worktrees are switched off. */
	read(rows: URI[]): void {
		this.rows = rows;
		this._onDidChangeRepositories.fire();
	}

	override async show(uri: URI): Promise<ShowResult> {
		this.moves.push(uri.path);
		await this.moving(uri);
		return { kind: 'shown' };
	}

	override repositoryFor(uri: URI): IWorkspaceBarRepository | undefined {
		const row = this.rows.find(candidate => candidate.path === uri.path);
		return row && { kind: 'repository', main: URI.file('/w/main'), folder: undefined, branch: 'main', members: this.members, worktrees: [{ uri: row, branch: 'p1', label: 'p1', exists: true, folder: undefined }] };
	}
}

/** What the person is told, and the buttons offered with it. */
class TestNotifications extends mock<INotificationService>() {

	readonly said: { message: string; choices: IPromptChoice[] }[] = [];

	override prompt(_severity: Severity, message: string, choices: IPromptChoice[]) {
		this.said.push({ message, choices });
		return undefined!;
	}
}

/** The disk, as far as the rows' folders go: each there, unless a test took it away or made it one that cannot be looked at. */
class TestFileService extends mock<IFileService>() {

	readonly gone = new Set<string>();
	readonly unreadable = new Set<string>();

	override async stat(resource: URI): Promise<IFileStatWithPartialMetadata> {
		// What is in a folder goes with it
		const within = (paths: Set<string>) => [...paths].some(path => resource.path === path || resource.path.startsWith(path + '/'));
		if (within(this.gone)) {
			throw new FileOperationError(`${resource.path} is not there`, FileOperationResult.FILE_NOT_FOUND);
		}
		if (within(this.unreadable)) {
			throw new Error(`${resource.path} could not be read`);
		}
		return upcastPartial<IFileStatWithPartialMetadata>({ resource, isDirectory: true });
	}
}

class TestContextService extends mock<IWorkspaceContextService>() {

	private readonly _onDidChangeFolders = new Emitter<never>();
	override readonly onDidChangeWorkspaceFolders = this._onDidChangeFolders.event as Event<never>;

	private _folders: IWorkspaceFolder[] = [];

	/** The workspace's folders: changing them says so, as a real workspace does. */
	get folders(): IWorkspaceFolder[] { return this._folders; }
	set folders(folders: IWorkspaceFolder[]) {
		this._folders = folders;
		this._onDidChangeFolders.fire(undefined as never);
	}

	override getWorkspace(): IWorkspace {
		return { id: 'test', folders: this.folders, transient: false, configuration: null } satisfies IWorkspace;
	}

	removeFolder(folder: IWorkspaceFolder): void {
		this.folders = this.folders.filter(candidate => candidate !== folder);
	}

	addFolder(folder: IWorkspaceFolder): void {
		this.folders = [...this.folders, folder];
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

		const configuration = new TestConfigurationService();
		const files = new TestFileService();
		const notifications = new TestNotifications();
		const folderTerminals = store.add(new FolderTerminals(
			folders, bar, terminals, context, groups,
			configuration, uriIdentityService, files, storage, new NullLogService(), notifications
		));

		// A terminal whose tab is moved to another group stops being tracked, as upstream's is.
		for (const column of columns) {
			column.closeMovedOut = name => terminals.instances = terminals.instances.filter(instance => (instance as unknown as TestInstance).name !== name);
		}

		return { terminals, folders, context, bar, groups, folderTerminals, storage, configuration, files, notifications };
	}

	/** The window on `target`, with its editors up, as when it opened there. */
	function onScreen(folders: TestActiveFolderService, bar: TestWorkspaceBarService, target: IWorkspaceFolder): void {
		folders.activeFolder = target;
		bar.restored();
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

	/** The setting changed, as the configuration service says when someone changes it. */
	async function setFollowFolder(configuration: TestConfigurationService, value: boolean) {
		await configuration.setUserConfiguration(FOLLOW_FOLDER, value);
		configuration.onDidChangeConfigurationEmitter.fire(upcastPartial<IConfigurationChangeEvent>({ affectsConfiguration: (key: string) => key === FOLLOW_FOLDER }));
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

		assert.deepStrictEqual({ whileAway, shown: terminals.shown, askedFor: terminals.askedFor, tabs: column.names(), folder: folderTerminals.folderOf(agent)?.path }, {
			whileAway: { hidden: true, alpha: [], beta: ['agent'], tabs: [] },
			shown: ['agent'],
			askedFor: [{ viewColumn: 0, index: 0, preserveFocus: true, inactive: true, activation: EditorActivation.PRESERVE }],
			tabs: ['agent'],
			folder: '/w/beta',
		});
	});

	test('a terminal opened for the folder on screen comes up behind the tab in front, without the focus; one for a folder neither in the workspace nor a row of the bar is the panel\'s', async () => {
		const alpha = folder('alpha');
		const code = file('code.ts');
		const column = new TestGroup(0, [code]);
		column.active = code;
		const { terminals, folders, context, bar, folderTerminals } = setup([column], []);
		context.folders = [alpha];
		onScreen(folders, bar, alpha);

		const here = await folderTerminals.openFor(alpha.uri, { name: 'here' });
		await timeout(0);
		const there = await folderTerminals.openFor(URI.file('/elsewhere'), { name: 'there' });

		assert.deepStrictEqual({
			hidden: terminals.created.map(options => !!(options.config as IShellLaunchConfig).hideFromUser),
			askedFor: terminals.askedFor,
			tabs: column.names(),
			inFront: column.active?.name,
			here: folderTerminals.folderOf(here)?.path,
			there: { location: terminals.created[1].location, folder: folderTerminals.folderOf(there)?.path },
		}, {
			hidden: [true, false],
			askedFor: [{ viewColumn: 0, index: 1, preserveFocus: true, inactive: true, activation: EditorActivation.PRESERVE }],
			tabs: ['code.ts', 'here'],
			inFront: 'code.ts',
			here: '/w/alpha',
			there: { location: TerminalLocation.Panel, folder: undefined },
		});
	});

	test('while terminals do not follow folders, a terminal opened for any folder is the panel\'s, and that folder\'s all the same', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const row = URI.file('/w/p1');
		const column = new TestGroup(0, []);
		const { terminals, folders, context, bar, folderTerminals, configuration } = setup([column], []);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		bar.rows.push(row);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		// Leaving the folder on screen would close a tab of its editor area, the shell in it with it
		await folderTerminals.openFor(alpha.uri, { name: 'here' });
		await folderTerminals.openFor(beta.uri, { name: 'beta' });
		await folderTerminals.openFor(row, { name: 'row' });
		await timeout(0);

		assert.deepStrictEqual({
			created: terminals.created.map(options => ({ location: options.location, hidden: !!(options.config as IShellLaunchConfig).hideFromUser })),
			tabs: column.names(),
			held: [alpha.uri, beta.uri, row].map(uri => folderTerminals.terminalsOf(uri).length),
		}, {
			created: [
				{ location: TerminalLocation.Panel, hidden: false },
				{ location: TerminalLocation.Panel, hidden: false },
				{ location: TerminalLocation.Panel, hidden: false },
			],
			tabs: [],
			held: [1, 1, 1],
		});
	});

	test('a terminal opened for a folder while a switch is under way comes up only once that folder\'s editors are', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const column = new TestGroup(0, []);
		const { folders, context, bar, folderTerminals } = setup([column], []);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);

		// Leaving alpha, the switch still waiting on what it joined: the window is on alpha yet, but the
		// editors the switch puts up next would close a tab shown now, and the shell in it
		const capturing = new DeferredPromise<void>();
		disposables.add(folders.onWillChangeActiveFolder(e => e.join(capturing.p)));
		const leaving = folders.switchTo(beta);
		await folderTerminals.openFor(alpha.uri, { name: 'left' });
		await timeout(0);
		const whileLeaving = column.names();
		capturing.complete();
		await leaving;

		// On beta, its editors still being put up
		await folderTerminals.openFor(beta.uri, { name: 'arrived' });
		await timeout(0);
		const whileArriving = column.names();
		bar.restored();
		await timeout(0);
		const onBeta = column.names();
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ whileLeaving, whileArriving, onBeta, backOnAlpha: column.names() }, {
			whileLeaving: [],
			whileArriving: [],
			onBeta: ['arrived'],
			backOnAlpha: ['left'],
		});
	});

	test('a terminal opened for the folder on screen while its terminals are coming back comes back with them', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, folderTerminals } = setup([column], [shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);

		// Back on alpha, with the shell held half way back
		terminals.blockOn = { name: 'shell', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, alpha);
		const agent = await folderTerminals.openFor(alpha.uri, { name: 'agent' });
		terminals.blockOn.released.complete();
		await timeout(0);

		assert.deepStrictEqual({ shown: terminals.shown, tabs: column.names(), folder: folderTerminals.folderOf(agent)?.path, alpha: folderTerminals.terminalsOf(alpha.uri).map(instance => (instance as unknown as TestInstance).name) }, {
			shown: ['shell', 'agent'],
			tabs: ['shell', 'agent'],
			folder: '/w/alpha',
			alpha: ['shell', 'agent'],
		});
	});

	test('while a folder\'s terminals are coming back, those that end are not waited for, and one opened meanwhile comes back with them', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');
		const three = new TestInstance('three');
		const column = new TestGroup(0, [tabFor(one), tabFor(two), tabFor(three)]);
		const { terminals, folders, context, bar, folderTerminals } = setup([column], [one, two, three]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);

		// Back on alpha, with the first held half way back: it ends there, the third ends before its turn,
		// and an agent opens a terminal for alpha
		terminals.blockOn = { name: 'one', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, alpha);
		one.dispose(TerminalExitReason.User);
		three.dispose(TerminalExitReason.User);
		await folderTerminals.openFor(alpha.uri, { name: 'agent' });
		terminals.blockOn.released.complete();
		await timeout(0);

		assert.deepStrictEqual({ shown: terminals.shown, tabs: column.names(), alpha: folderTerminals.terminalsOf(alpha.uri).map(instance => (instance as unknown as TestInstance).name) }, {
			shown: ['two', 'agent'],
			tabs: ['two', 'agent'],
			alpha: ['two', 'agent'],
		});
	});

	test('a terminal opened for a folder that leaves the workspace while it is made is the panel\'s', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const { terminals, folders, context, bar, folderTerminals } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);

		terminals.whileCreating = () => context.removeFolder(beta);
		const agent = await folderTerminals.openFor(beta.uri, { name: 'agent' });

		assert.deepStrictEqual({ ended: (agent as unknown as TestInstance).disposed, inPanel: terminals.toPanel, heldForBeta: folderTerminals.terminalsOf(beta.uri).length }, {
			ended: false,
			inPanel: ['agent'],
			heldForBeta: 0,
		});
	});

	test('a terminal opened for a worktree with a row and no folder in the workspace is held under the row, belongs to it, and revealing it goes there', async () => {
		const alpha = folder('alpha');
		const p1 = folder('p1');
		const column = new TestGroup(0, []);
		const { terminals, folders, context, bar, folderTerminals } = setup([column], []);
		context.folders = [alpha];
		folders.activeFolder = alpha;
		bar.rows.push(p1.uri);
		// Going to a worktree's row puts it in the workspace, then moves the window onto it
		bar.moving = async () => {
			context.addFolder(p1);
			await folders.switchTo(p1);
		};

		const agent = await folderTerminals.openFor(p1.uri, { name: 'agent' });
		const held = {
			hidden: !!(terminals.created[0].config as IShellLaunchConfig).hideFromUser,
			underItsRow: folderTerminals.terminalsOf(p1.uri).includes(agent),
			folder: folderTerminals.folderOf(agent)?.path,
			terminalsOfRow: folderTerminals.terminalsOf(p1.uri).length,
			tabs: column.names()
		};
		const revealing = folderTerminals.reveal(agent);
		await timeout(0);
		bar.restored();
		const inFront = await revealing;

		assert.deepStrictEqual({ held, inFront, moves: bar.moves, tabs: column.names(), revealed: terminals.revealed, folder: folderTerminals.folderOf(agent)?.path, joined: context.folders.map(each => each.name) }, {
			held: { hidden: true, underItsRow: true, folder: '/w/p1', terminalsOfRow: 1, tabs: [] },
			inFront: true,
			moves: ['/w/p1'],
			tabs: ['agent'],
			revealed: ['agent'],
			folder: '/w/p1',
			joined: ['alpha', 'p1'],
		});
	});

	test('a terminal held under a row outlives the workspace\'s folders changing and a reload, still under its row', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const row = URI.file('/w/p1');
		const before = setup([new TestGroup(0, [])], []);
		before.context.folders = [alpha, beta];
		before.folders.activeFolder = alpha;
		before.bar.members = [alpha];
		before.bar.rows.push(row);

		const agent = await before.folderTerminals.openFor(row, { name: 'agent' });
		before.context.removeFolder(beta);
		const afterRemoval = { ended: (agent as unknown as TestInstance).disposed, underItsRow: before.folderTerminals.terminalsOf(row).includes(agent) };

		// The window closes, and opening again brings the agent back in the background - before git's rows are read
		(agent as unknown as TestInstance).dispose(TerminalExitReason.Shutdown);
		before.storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		const revived = new TestInstance('agent', TerminalLocation.Panel);
		const after = setup([new TestGroup(0, [])], [], [], { storage: before.storage, revived: [revived], opensOn: alpha });
		after.context.folders = [alpha];
		await timeout(0);

		assert.deepStrictEqual({ afterRemoval, afterReload: { ended: revived.disposed, underItsRow: after.folderTerminals.terminalsOf(row).includes(revived.asInstance()) } }, {
			afterRemoval: { ended: false, underItsRow: true },
			afterReload: { ended: false, underItsRow: true },
		});
	});

	test('a terminal held under a row that ends is forgotten, row and all', async () => {
		const alpha = folder('alpha');
		const row = URI.file('/w/p1');
		const { folders, context, bar, folderTerminals, storage } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha];
		folders.activeFolder = alpha;
		bar.rows.push(row);

		// As deleting the worktree ends whatever works inside it
		const agent = await folderTerminals.openFor(row, { name: 'agent' });
		(agent as unknown as TestInstance).dispose(TerminalExitReason.User);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		assert.deepStrictEqual({ terminalsOfRow: folderTerminals.terminalsOf(row).length, kept: storage.get(PARKED_STORAGE_KEY, StorageScope.WORKSPACE) }, {
			terminalsOfRow: 0,
			kept: undefined,
		});
	});

	test('a row that joins the workspace is a folder like the others from then on: taking it out again ends its terminals', async () => {
		const alpha = folder('alpha');
		const p1 = folder('p1');
		const p2 = folder('p2');
		const { terminals, folders, context, bar, folderTerminals } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha];
		onScreen(folders, bar, alpha);
		bar.rows.push(p1.uri, p2.uri);

		// p1 joins once its terminal is held for it, p2 while its terminal is being made
		const first = await folderTerminals.openFor(p1.uri, { name: 'first' });
		context.addFolder(p1);
		terminals.whileCreating = () => context.addFolder(p2);
		const second = await folderTerminals.openFor(p2.uri, { name: 'second' });
		const joined = { first: folderTerminals.folderOf(first)?.path, second: folderTerminals.folderOf(second)?.path };

		// Each the next change to the folders: one in between would find the folder there
		context.removeFolder(p2);
		context.removeFolder(p1);

		assert.deepStrictEqual({ joined, ended: [first, second].map(instance => (instance as unknown as TestInstance).disposed) }, {
			joined: { first: '/w/p1', second: '/w/p2' },
			ended: [true, true],
		});
	});

	test('the terminals held under a repository\'s rows end when the last of its folders leaves the workspace, and not before', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const notes = folder('notes');
		const p1 = URI.file('/w/p1');
		const p2 = URI.file('/w/p2');
		const { folders, context, bar, folderTerminals } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha, beta, notes];
		onScreen(folders, bar, notes);
		// The repository's checkout and one of its worktrees are folders of the workspace; p1 and p2 are not
		bar.members = [alpha, beta];
		bar.rows.push(p1, p2);
		const first = await folderTerminals.openFor(p1, { name: 'first' });
		const second = await folderTerminals.openFor(p2, { name: 'second' });
		const ended = () => [first, second].map(instance => (instance as unknown as TestInstance).disposed);

		context.removeFolder(notes);
		const anotherFolderLeft = ended();
		context.removeFolder(beta);
		const oneOfItsFoldersLeft = ended();
		context.removeFolder(alpha);

		assert.deepStrictEqual({ anotherFolderLeft, oneOfItsFoldersLeft, itsLastLeft: ended(), held: [p1, p2].map(row => folderTerminals.terminalsOf(row).length) }, {
			anotherFolderLeft: [false, false],
			oneOfItsFoldersLeft: [false, false],
			itsLastLeft: [true, true],
			held: [0, 0],
		});
	});

	test('the folder on screen taken out of the workspace ends the terminals shown for it, as it ends those held for a folder that leaves - out of the editor area first; the panel\'s stay', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const shell = new TestInstance('shell');
		const panel = new TestInstance('panel', TerminalLocation.Panel);
		const { terminals, folders, context, bar, folderTerminals } = setup([new TestGroup(0, [tabFor(agent), tabFor(shell)])], [agent, shell, panel]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		const held = await folderTerminals.openFor(beta.uri, { name: 'held' });
		// Ended in its tab, a terminal's tab could outlast it, and the terminal editor service keep it
		const outFirst: boolean[] = [];
		for (const each of [agent, shell]) {
			disposables.add(each.onDisposed(() => outFirst.push(terminals.backgrounded.includes(each.name))));
		}

		// As the active folder service does when the folder it is on leaves: on to its neighbour, unannounced
		folders.activeFolder = beta;
		context.removeFolder(alpha);

		assert.deepStrictEqual({ ended: [agent, shell].map(each => [each.disposed, each.exitReason]), outFirst, panel: panel.disposed, held: (held as unknown as TestInstance).disposed }, {
			ended: [[true, TerminalExitReason.User], [true, TerminalExitReason.User]],
			outFirst: [true, true],
			panel: false,
			held: false,
		});
	});

	test('WS-55 folders that leave by an edit to the workspace file, not Remove Folder from Workspace, keep what runs in them - shown, held, opened for them - running in the panel, the window\'s now: said once, with Stop, which ends them', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const notes = folder('notes');
		const agent = new TestInstance('agent');
		const panel = new TestInstance('panel', TerminalLocation.Panel);
		const { terminals, folders, context, bar, folderTerminals, notifications } = setup([new TestGroup(0, [tabFor(agent)])], [agent, panel]);
		context.folders = [alpha, beta, notes];
		onScreen(folders, bar, alpha);
		const held = await folderTerminals.openFor(beta.uri, { name: 'held' }) as unknown as TestInstance;
		bar.removing = false;

		// One edit takes two out, the one on screen among them: the active folder service moves on, unannounced
		folders.activeFolder = notes;
		context.folders = [notes];
		await timeout(0);
		const kept = {
			ended: [agent, held, panel].map(each => each.disposed),
			inPanel: [...terminals.toPanel].sort(),
			theirs: [agent, held].map(each => folderTerminals.folderOf(each.asInstance())?.path),
			said: notifications.said.map(({ message, choices }) => `${message} [${choices.map(choice => choice.label).join(', ')}]`)
		};
		await notifications.said[0].choices[0].run();

		assert.deepStrictEqual({ ...kept, stopped: [agent, held, panel].map(each => [each.disposed, each.exitReason]) }, {
			ended: [false, false, false],
			inPanel: ['agent', 'held'],
			theirs: [undefined, undefined],
			said: ['Folder \'alpha, beta\' was removed from the workspace. Active terminals continue running in the panel: held, agent. [Stop]'],
			stopped: [[true, TerminalExitReason.User], [true, TerminalExitReason.User], [false, undefined]],
		});
	});

	test('WS-55 the last of a repository\'s folders leaving by an edit keeps the terminals held under its rows running too', async () => {
		const alpha = folder('alpha');
		const notes = folder('notes');
		const p1 = URI.file('/w/p1');
		const { terminals, folders, context, bar, folderTerminals } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha, notes];
		onScreen(folders, bar, notes);
		bar.members = [alpha];
		bar.rows.push(p1);
		const first = await folderTerminals.openFor(p1, { name: 'first' }) as unknown as TestInstance;
		bar.removing = false;

		context.removeFolder(alpha);
		await timeout(0);

		assert.deepStrictEqual({ ended: first.disposed, inPanel: terminals.toPanel, held: folderTerminals.terminalsOf(p1).length }, { ended: false, inPanel: ['first'], held: 0 });
	});

	test('WS-33 a folder taken out through Remove Folder from Workspace ends what runs in it, as its confirmation said, and says nothing more', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const { folders, context, bar, folderTerminals, notifications } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		const held = await folderTerminals.openFor(beta.uri, { name: 'held' }) as unknown as TestInstance;

		context.removeFolder(beta);

		assert.deepStrictEqual({ ended: [held.disposed, held.exitReason], said: notifications.said.length }, { ended: [true, TerminalExitReason.User], said: 0 });
	});

	test('another folder leaving ends none of the terminals shown for the folder on screen, nor does the folder on screen leaving while terminals do not follow folders', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const { folders, context, bar, configuration } = setup([new TestGroup(0, [tabFor(agent)])], [agent]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);

		context.removeFolder(beta);
		const anotherLeft = agent.disposed;
		// The editor area's terminals are then the window's
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		folders.activeFolder = undefined;
		context.removeFolder(alpha);

		assert.deepStrictEqual({ anotherLeft, notFollowing: agent.disposed }, { anotherLeft: false, notFollowing: false });
	});

	test('while terminals do not follow folders, those of the editor area are the window\'s: out of it before the folder left keeps its editors, so that none is kept with them, and back at their tabs once the next folder\'s are up', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const shell = new TestInstance('shell');
		const agentTab = tabFor(agent);
		const column = new TestGroup(0, [file('readme'), agentTab, tabFor(shell)]);
		column.active = agentTab;
		const { terminals, folders, context, bar, folderTerminals, configuration } = setup([column], [agent, shell]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		// The bar keeps the editors of the folder left once the switch has announced itself, behind what it
		// joined. A terminal still there then would be kept with them: closed when the next folder's are put
		// up, the shell in it with it - or one that asks before it closes taken along, and one a reload
		// brought back opened a second time beside itself.
		const kept: string[][] = [];
		disposables.add(folders.onWillChangeActiveFolder(e => e.join(Promise.resolve().then(() => { kept.push(column.names()); }))));
		await folders.switchTo(beta);
		const whileArriving = column.names();
		bar.restored();
		await timeout(0);
		const onBeta = { tabs: column.names(), inFront: column.active?.name, folder: folderTerminals.folderOf(agent.asInstance())?.path, beta: folderTerminals.terminalsOf(beta.uri).length };
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ kept, whileArriving, onBeta, backOnAlpha: column.names(), ended: [agent.disposed, shell.disposed], backgrounded: terminals.backgrounded }, {
			kept: [['readme'], ['readme']],
			whileArriving: ['readme'],
			onBeta: { tabs: ['readme', 'agent', 'shell'], inFront: 'agent', folder: undefined, beta: 0 },
			backOnAlpha: ['readme', 'agent', 'shell'],
			ended: [false, false],
			backgrounded: ['agent', 'shell', 'agent', 'shell'],
		});
	});

	test('while terminals do not follow folders, those on their way with the window are not ended by a folder leaving meanwhile, and a reload then brings them back with it', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const gamma = folder('gamma');
		const agent = new TestInstance('agent');
		const before = setup([new TestGroup(0, [tabFor(agent)])], [agent]);
		before.context.folders = [alpha, beta, gamma];
		onScreen(before.folders, before.bar, alpha);
		await before.configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		// On beta, its editors still being put up, when another folder leaves
		await before.folders.switchTo(beta);
		before.context.removeFolder(gamma);
		const afterRemoval = agent.disposed;

		// The window closes then, and opens again on beta
		agent.dispose(TerminalExitReason.Shutdown);
		before.storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		const revived = new TestInstance('agent', TerminalLocation.Panel);
		const column = new TestGroup(0, []);
		const after = setup([column], [], [], { storage: before.storage, revived: [revived], opensOn: beta });
		after.context.folders = [alpha, beta];
		await after.configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		await timeout(0);

		assert.deepStrictEqual({ afterRemoval, ended: revived.disposed, tabs: column.names(), folder: after.folderTerminals.folderOf(revived.asInstance())?.path }, {
			afterRemoval: false,
			ended: false,
			tabs: ['agent'],
			folder: undefined,
		});
	});

	test('while terminals do not follow folders, the folder on screen leaving takes those of the editor area along with the window, out of it until the next folder\'s editors are up', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);
		const { terminals, folders, context, bar, configuration } = setup([column], [agent]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		// The active folder service moves on to beta without announcing a switch, and the bar puts beta's
		// editors up: a tab still there would be closed by them, or opened again beside itself
		context.removeFolder(alpha);
		folders.activeFolder = beta;
		const whileMoving = column.names();
		bar.restored();
		await timeout(0);

		assert.deepStrictEqual({ whileMoving, onBeta: column.names(), backgrounded: terminals.backgrounded, ended: agent.disposed }, {
			whileMoving: [],
			onBeta: ['agent'],
			backgrounded: ['agent'],
			ended: false,
		});
	});

	test('a terminal that came along with the window while terminals did not follow folders is put away for the folder it was opened in once they do again', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const gamma = folder('gamma');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);
		const { folders, context, bar, folderTerminals, configuration } = setup([column], [agent]);
		context.folders = [alpha, beta, gamma];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		await switchTo(folders, bar, beta);
		const onBeta = column.names();

		await configuration.setUserConfiguration(FOLLOW_FOLDER, true);
		const shownFor = folderTerminals.folderOf(agent.asInstance())?.path;
		await switchTo(folders, bar, gamma);
		const onGamma = { tabs: column.names(), heldFor: folderTerminals.folderOf(agent.asInstance())?.path, beta: folderTerminals.terminalsOf(beta.uri).length };
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ onBeta, shownFor, onGamma, backOnAlpha: column.names() }, {
			onBeta: ['agent'],
			shownFor: '/w/alpha',
			onGamma: { tabs: [], heldFor: '/w/alpha', beta: 0 },
			backOnAlpha: ['agent'],
		});
	});

	test('revealing a terminal on its way with the window to the next folder puts it in front once that folder\'s editors are up, without moving the window', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);
		const { terminals, folders, context, bar, folderTerminals, configuration } = setup([column], [agent]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		await folders.switchTo(beta);
		const revealing = folderTerminals.reveal(agent.asInstance());
		await timeout(0);
		const whileSwitching = { tabs: column.names(), revealed: [...terminals.revealed] };
		bar.restored();
		const inFront = await revealing;

		assert.deepStrictEqual({ whileSwitching, inFront, moves: bar.moves, on: folders.activeFolder?.name, revealed: terminals.revealed, focused: agent.focused }, {
			whileSwitching: { tabs: [], revealed: [] },
			inFront: true,
			moves: [],
			on: 'beta',
			revealed: ['agent'],
			focused: true,
		});
	});

	test('a terminal caught by the window moving on again with its tab up but not yet back leaves the editor area with the others, and is kept once, for its folder', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, storage } = setup([column], [shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);

		// Back on alpha, the shell's tab up, and the window leaves before the shell is said to be back
		terminals.blockOnceUp = { name: 'shell', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, alpha);
		await folders.switchTo(beta);
		// Before beta's editors are put up, which would close a tab left there, the shell with it
		const whileLeaving = column.names();
		terminals.blockOnceUp.released.complete();
		await timeout(0);
		bar.restored();
		await timeout(0);
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		const kept: Record<string, { nonce: string }[]> = JSON.parse(storage.get(PARKED_STORAGE_KEY, StorageScope.WORKSPACE) ?? '{}');
		const keptOnBeta = Object.values(kept).flat().map(entry => entry.nonce);
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ whileLeaving, keptOnBeta, backOnAlpha: column.names() }, {
			whileLeaving: [],
			keptOnBeta: ['nonce-shell'],
			backOnAlpha: ['shell'],
		});
	});

	test('those on their way with the window whose showing a switch stops come with the next folder, even when its editors are up before that stop', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const gamma = folder('gamma');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);
		const { terminals, folders, context, bar, configuration } = setup([column], [agent]);
		context.folders = [alpha, beta, gamma];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		// On beta, the agent held half way back, the window goes on to gamma and its editors are up
		terminals.blockOn = { name: 'agent', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, gamma);
		terminals.blockOn.released.complete();
		await timeout(0);

		assert.deepStrictEqual({ onGamma: column.names(), ended: agent.disposed }, { onGamma: ['agent'], ended: false });
	});

	test('a terminal opened for a folder belongs to it wherever it is - in the panel too, while terminals do not follow folders - and ends when the folder leaves the workspace, or for a row its repository does', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const p1 = URI.file('/w/p1');
		const { folders, context, bar, folderTerminals, configuration } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		bar.members = [beta];
		bar.rows.push(p1);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		const here = await folderTerminals.openFor(alpha.uri, { name: 'here' });
		const row = await folderTerminals.openFor(p1, { name: 'row' });
		const ended = () => [here, row].map(each => (each as unknown as TestInstance).disposed);
		const belong = { here: folderTerminals.folderOf(here)?.path, row: folderTerminals.folderOf(row)?.path, beta: folderTerminals.terminalsOf(p1).length };

		context.removeFolder(alpha);
		const alphaLeft = ended();
		context.removeFolder(beta);

		assert.deepStrictEqual({ belong, alphaLeft, betaLeft: ended() }, {
			belong: { here: '/w/alpha', row: '/w/p1', beta: 1 },
			alphaLeft: [true, false],
			betaLeft: [true, true],
		});
	});

	test('a terminal opened for a folder is still that folder\'s after a reload - the panel\'s too - and ends when it leaves', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const before = setup([new TestGroup(0, [])], []);
		before.context.folders = [alpha, beta];
		onScreen(before.folders, before.bar, alpha);
		await before.configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		const agent = await before.folderTerminals.openFor(alpha.uri, { name: 'agent' });

		// The window closes, and opening again brings the agent back in the panel
		(agent as unknown as TestInstance).dispose(TerminalExitReason.Shutdown);
		before.storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		const revived = new TestInstance('agent', TerminalLocation.Panel);
		const after = setup([new TestGroup(0, [])], [], [], { storage: before.storage, revived: [revived], opensOn: beta });
		after.context.folders = [alpha, beta];
		await after.configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		await timeout(0);
		const belongs = after.folderTerminals.folderOf(revived.asInstance())?.path;
		after.context.removeFolder(alpha);

		assert.deepStrictEqual({ belongs, ended: revived.disposed }, { belongs: '/w/alpha', ended: true });
	});

	test('a folder of the workspace that git has no worktree at any more - its .git gone - ends the terminals opened for it, and not the person\'s own shells there, nor the folder', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { folders, context, bar, folderTerminals, files } = setup([column], [shell]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		bar.members = [alpha, beta];
		bar.rows.push(alpha.uri);
		const agent = await folderTerminals.openFor(alpha.uri, { name: 'agent' });
		await timeout(0);

		// Removed with git: its files gone, the folder left in the workspace
		files.gone.add('/w/alpha/.git');
		bar.read([]);
		await timeout(0);

		assert.deepStrictEqual({ agent: (agent as unknown as TestInstance).disposed, shell: shell.disposed, workspace: context.folders.map(each => each.name) }, {
			agent: true,
			shell: false,
			workspace: ['alpha', 'beta'],
		});
	});

	test('while terminals do not follow folders, a terminal opened for a row ends once git has removed the row\'s worktree - its .git gone', async () => {
		const alpha = folder('alpha');
		const p1 = URI.file('/w/p1');
		const { folders, context, bar, folderTerminals, files, configuration } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha];
		onScreen(folders, bar, alpha);
		bar.members = [alpha];
		bar.rows.push(p1);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		const agent = await folderTerminals.openFor(p1, { name: 'agent' });

		files.gone.add('/w/p1/.git');
		bar.read([]);
		await timeout(0);

		assert.strictEqual((agent as unknown as TestInstance).disposed, true);
	});

	test('a terminal opened for a folder in no repository is not ended by a read of git\'s files, which finds no .git there', async () => {
		const notes = folder('notes');
		const { folders, context, bar, folderTerminals, files } = setup([new TestGroup(0, [])], []);
		context.folders = [notes];
		onScreen(folders, bar, notes);
		const agent = await folderTerminals.openFor(notes.uri, { name: 'agent' });

		files.gone.add('/w/notes/.git');
		bar.read([]);
		await timeout(0);

		assert.strictEqual((agent as unknown as TestInstance).disposed, false);
	});

	test('turned on again, a terminal that came along with the window goes back at once to the folder it was opened in, out of the editor area of another', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { folders, context, bar, folderTerminals, configuration } = setup([column], [shell]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		await switchTo(folders, bar, beta);
		const onBeta = column.names();

		await setFollowFolder(configuration, true);

		assert.deepStrictEqual({ onBeta, now: column.names(), heldFor: folderTerminals.folderOf(shell.asInstance())?.path, beta: folderTerminals.terminalsOf(beta.uri).length }, {
			onBeta: ['shell'],
			now: [],
			heldFor: '/w/alpha',
			beta: 0,
		});
	});

	test('turned on again while terminals are on their way with the window, each is held for the folder it was opened in rather than shown with the next one', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { folders, context, bar, folderTerminals, configuration } = setup([column], [shell]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		await folders.switchTo(beta);
		await setFollowFolder(configuration, true);
		bar.restored();
		await timeout(0);
		const onBeta = { tabs: column.names(), heldFor: folderTerminals.folderOf(shell.asInstance())?.path };
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ onBeta, backOnAlpha: column.names() }, {
			onBeta: { tabs: [], heldFor: '/w/alpha' },
			backOnAlpha: ['shell'],
		});
	});

	test('while terminals do not follow folders, the folder on screen leaving as they come back loses none: they come with the next folder\'s editors', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const gamma = folder('gamma');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, configuration } = setup([column], [shell]);
		context.folders = [alpha, beta, gamma];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		// On beta, the shell's tab up again but not yet said to be back, beta leaves the workspace
		const released = new DeferredPromise<void>();
		terminals.blockOnceUp = { name: 'shell', released };
		await switchTo(folders, bar, beta);
		context.removeFolder(beta);
		folders.activeFolder = gamma;
		terminals.blockOnceUp = undefined;
		released.complete();
		await timeout(0);
		bar.restored();
		await timeout(0);

		assert.deepStrictEqual({ onGamma: column.names(), shown: terminals.foregroundInstances.includes(shell.asInstance()), ended: shell.disposed }, { onGamma: ['shell'], shown: true, ended: false });
	});

	test('the folder on screen leaving while a terminal is on its way back - its tab not up yet - puts it straight back once it lands: the editors the next folder puts up would close it', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const gamma = folder('gamma');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, configuration } = setup([column], [shell]);
		context.folders = [alpha, beta, gamma];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		// On beta, the shell on its way back, beta leaves the workspace before its tab is up
		const released = new DeferredPromise<void>();
		terminals.blockOn = { name: 'shell', released };
		await switchTo(folders, bar, beta);
		context.removeFolder(beta);
		folders.activeFolder = gamma;
		released.complete();
		await timeout(0);
		const landed = { tabs: column.names(), shown: terminals.foregroundInstances.includes(shell.asInstance()) };
		bar.restored();
		await timeout(0);

		assert.deepStrictEqual({ landed, onGamma: column.names(), ended: shell.disposed }, {
			landed: { tabs: [], shown: false },
			onGamma: ['shell'],
			ended: false
		});
	});

	test('while terminals do not follow folders, the last folder leaving the workspace leaves the editor area\'s terminals on screen: no folder\'s editors are put up to bring them back', async () => {
		const alpha = folder('alpha');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, configuration } = setup([column], [shell]);
		context.folders = [alpha];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		folders.activeFolder = undefined;
		context.removeFolder(alpha);
		await timeout(0);

		assert.deepStrictEqual({ tabs: column.names(), backgrounded: terminals.backgrounded, ended: shell.disposed }, { tabs: ['shell'], backgrounded: [], ended: false });
	});

	test('back on a folder whose terminals were still coming back from a move before, they all come back: the move that was stopped hides none of them', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar } = setup([column], [shell]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await switchTo(folders, bar, beta);

		// Back on alpha, the shell's tab up but not yet said to be back; away and back again, the second
		// showing held as well
		const released = new DeferredPromise<void>();
		terminals.blockOnceUp = { name: 'shell', released };
		await switchTo(folders, bar, alpha);
		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);
		terminals.blockOnceUp = undefined;
		released.complete();
		await timeout(0);
		await timeout(0);

		assert.deepStrictEqual({ tabs: column.names(), shown: terminals.foregroundInstances.includes(shell.asInstance()) }, { tabs: ['shell'], shown: true });
	});

	test('a read of git\'s files that misses a row ends nothing held under it - its folder gone from disk does, not one that cannot be looked at', async () => {
		const alpha = folder('alpha');
		const p1 = URI.file('/w/p1');
		const p2 = URI.file('/w/p2');
		const { folders, context, bar, folderTerminals, files } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha];
		onScreen(folders, bar, alpha);
		bar.members = [alpha];
		bar.rows.push(p1, p2);
		const first = await folderTerminals.openFor(p1, { name: 'first' });
		const second = await folderTerminals.openFor(p2, { name: 'second' });
		const ended = () => [first, second].map(instance => (instance as unknown as TestInstance).disposed);

		// A read that missed p1 - git was rewriting its HEAD - and one of none, as with worktrees switched off
		bar.read([p2]);
		await timeout(0);
		bar.read([]);
		await timeout(0);
		const missedByReads = ended();

		// p1's folder cannot be looked at, then it is gone: deleted outside the window
		files.unreadable.add(p1.path);
		bar.read([p2]);
		await timeout(0);
		const cannotBeLookedAt = ended();
		files.gone.add(p1.path);
		bar.read([p2]);
		await timeout(0);

		assert.deepStrictEqual({ missedByReads, cannotBeLookedAt, gone: ended(), held: [p1, p2].map(row => folderTerminals.terminalsOf(row).length) }, {
			missedByReads: [false, false],
			cannotBeLookedAt: [false, false],
			gone: [true, false],
			held: [0, 1],
		});
	});

	test('a row git no longer reads whose folder is left without its .git - as git leaves one on Windows, where a folder a process is in cannot be deleted - ends what is held under it', async () => {
		const alpha = folder('alpha');
		const p1 = URI.file('/w/p1');
		const { folders, context, bar, folderTerminals, files } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha];
		onScreen(folders, bar, alpha);
		bar.members = [alpha];
		bar.rows.push(p1);
		const agent = await folderTerminals.openFor(p1, { name: 'agent' });

		// Removed with git: its files gone, its folder left empty, held by the agent's process
		files.gone.add('/w/p1/.git');
		bar.read([]);
		await timeout(0);

		assert.deepStrictEqual({ ended: (agent as unknown as TestInstance).disposed, held: folderTerminals.terminalsOf(p1).length }, { ended: true, held: 0 });
	});

	test('a row that joined the workspace while the window was closed is that folder after a reload: taking it out then ends its terminals', async () => {
		const alpha = folder('alpha');
		const p1 = folder('p1');
		const before = setup([new TestGroup(0, [])], []);
		before.context.folders = [alpha];
		before.folders.activeFolder = alpha;
		before.bar.rows.push(p1.uri);
		const agent = await before.folderTerminals.openFor(p1.uri, { name: 'agent' });
		(agent as unknown as TestInstance).dispose(TerminalExitReason.Shutdown);
		before.storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		// Opened again with p1 one of the workspace's folders, put there while the window was closed
		const revived = new TestInstance('agent', TerminalLocation.Panel);
		const after = setup([new TestGroup(0, [])], [], [], { storage: before.storage, revived: [revived], opensOn: alpha });
		after.context.folders = [alpha, p1];
		await timeout(0);
		const parkedFor = after.folderTerminals.folderOf(revived.asInstance())?.path;
		after.context.removeFolder(p1);

		assert.deepStrictEqual({ parkedFor, ended: revived.disposed }, { parkedFor: '/w/p1', ended: true });
	});

	test('a terminal held for a folder - opened for it, or brought back by a reload - stays held when made the active terminal, as an extension\'s show() makes it', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const storage = await closeWithParked([new TestInstance('shell')], alpha, beta);
		const revived = new TestInstance('shell', TerminalLocation.Panel);
		const column = new TestGroup(0, []);
		const { terminals, context, folderTerminals } = setup([column], [], [], { storage, revived: [revived], opensOn: beta });
		context.folders = [alpha, beta];
		await timeout(0);
		const agent = await folderTerminals.openFor(alpha.uri, { name: 'agent' });

		terminals.setActiveInstance(agent);
		terminals.setActiveInstance(revived.asInstance());
		await timeout(0);

		assert.deepStrictEqual({ shown: terminals.shown, tabs: column.names(), heldForAlpha: folderTerminals.terminalsOf(alpha.uri).map(instance => (instance as unknown as TestInstance).name) }, {
			shown: [],
			tabs: [],
			heldForAlpha: ['shell', 'agent'],
		});
	});

	test('revealing a terminal while a switch is still putting its folder\'s editors up shows it once they are, not before', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const column = new TestGroup(0, []);
		const { terminals, folders, context, bar, folderTerminals } = setup([column], []);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		const agent = await folderTerminals.openFor(beta.uri, { name: 'agent' });

		// On beta, its editors still being put up: a tab shown now would be closed by them, the shell with it
		await folders.switchTo(beta);
		const revealing = folderTerminals.reveal(agent);
		await timeout(0);
		const whileSwitching = { tabs: column.names(), revealed: [...terminals.revealed] };
		bar.restored();
		const inFront = await revealing;

		assert.deepStrictEqual({ whileSwitching, inFront, tabs: column.names(), revealed: terminals.revealed, focused: (agent as unknown as TestInstance).focused }, {
			whileSwitching: { tabs: [], revealed: [] },
			inFront: true,
			tabs: ['agent'],
			revealed: ['agent'],
			focused: true,
		});
	});

	test('a folder\'s own terminals come back to their tabs before one opened for it while the window was away, which goes after them', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [file('a.ts'), file('b.ts'), tabFor(shell)]);
		const { folders, context, bar, folderTerminals } = setup([column], [shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);

		// Away: an agent opens a terminal for alpha, and alpha's b.ts is not among the editors it comes back to
		await folderTerminals.openFor(alpha.uri, { name: 'agent' });
		column.remove('b.ts');
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual(column.names(), ['a.ts', 'shell', 'agent']);
	});

	test('a folder that leaves the workspace while its terminals are coming back, and has a terminal opened for it again at once, keeps that one', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, folderTerminals } = setup([column], [shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		// alpha is a worktree, with a row still once it has left the workspace: its repository's checkout is beta
		bar.members = [beta];
		bar.rows.push(alpha.uri);
		await switchTo(folders, bar, beta);

		// Back on alpha with its shell held half way back, alpha leaves the workspace, and an agent opens a
		// terminal for it
		terminals.blockOn = { name: 'shell', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, alpha);
		context.removeFolder(alpha);
		const agent = await folderTerminals.openFor(alpha.uri, { name: 'agent' });
		terminals.blockOn.released.complete();
		await timeout(0);

		assert.deepStrictEqual({ shellEnded: shell.disposed, agentHeldFor: folderTerminals.folderOf(agent)?.path, held: folderTerminals.terminalsOf(alpha.uri).map(instance => (instance as unknown as TestInstance).name) }, {
			shellEnded: true,
			agentHeldFor: '/w/alpha',
			held: ['agent'],
		});
	});

	test('a folder whose last terminal coming back ended, taken out of the workspace and put back with a terminal opened for it, shows that one once its editors are up', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, folderTerminals } = setup([column], [shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);

		// Back on alpha with its shell held half way back: the shell ends, alpha leaves and comes back, and an
		// agent opens a terminal for it, all before the shell's showing gives up
		terminals.blockOn = { name: 'shell', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, alpha);
		shell.dispose(TerminalExitReason.User);
		context.removeFolder(alpha);
		context.addFolder(alpha);
		const agent = await folderTerminals.openFor(alpha.uri, { name: 'agent' });
		terminals.blockOn.released.complete();
		await timeout(0);
		bar.restored();
		await timeout(0);

		assert.deepStrictEqual({ tabs: column.names(), shown: terminals.foregroundInstances.includes(agent) }, { tabs: ['agent'], shown: true });
	});

	test('back on a folder before its terminals stopped coming back from the visit before, each comes back once, to one tab', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar } = setup([column], [shell]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await switchTo(folders, bar, beta);

		// Back on alpha, the shell held before its tab is up; away and back again while it is
		terminals.blockOn = { name: 'shell', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, alpha);
		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);
		terminals.blockOn.released.complete();
		for (let i = 0; i < 4; i++) {
			await timeout(0);
		}

		assert.deepStrictEqual({ tabs: column.names(), shown: terminals.foregroundInstances.includes(shell.asInstance()) }, { tabs: ['shell'], shown: true });
	});

	test('turned on again after a reload, a terminal opened for a folder that came along with the window goes back to that folder: what it was opened for is kept, though not where it came from', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const before = setup([new TestGroup(0, [])], []);
		before.context.folders = [alpha, beta];
		onScreen(before.folders, before.bar, alpha);
		const opened = await before.folderTerminals.openFor(alpha.uri, { name: 'agent' });
		await timeout(0);
		(opened as unknown as TestInstance).dispose(TerminalExitReason.Shutdown);
		before.storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);

		// Opened again on beta, the agent's tab among beta's: it came along with the window while terminals did not follow folders
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);
		const after = setup([column], [agent], [], { storage: before.storage, revived: [], opensOn: beta });
		after.context.folders = [alpha, beta];
		await after.configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		after.bar.restored();
		await timeout(0);

		await setFollowFolder(after.configuration, true);
		const turnedOn = { tabs: column.names(), heldFor: after.folderTerminals.folderOf(agent.asInstance())?.path };
		await switchTo(after.folders, after.bar, alpha);

		assert.deepStrictEqual({ turnedOn, backOnAlpha: column.names() }, {
			turnedOn: { tabs: [], heldFor: '/w/alpha' },
			backOnAlpha: ['agent'],
		});
	});

	test('a terminal opened for a folder that the person moves into another folder\'s editor area is still its own folder\'s: leaving that folder puts it away for its own, and taking that folder out of the workspace does not end it', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const gamma = folder('gamma');
		const column = new TestGroup(0, []);
		const { folders, context, bar, folderTerminals, configuration } = setup([column], []);
		context.folders = [alpha, beta, gamma];
		onScreen(folders, bar, beta);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		const agent = await folderTerminals.openFor(alpha.uri, { name: 'agent' }) as unknown as TestInstance;
		await setFollowFolder(configuration, true);

		// Moved by the person from the panel into beta's editor area
		agent.target = TerminalLocation.Editor;
		column.tabs.push(tabFor(agent));
		await switchTo(folders, bar, gamma);
		const onGamma = { tabs: column.names(), heldFor: folderTerminals.folderOf(agent.asInstance())?.path, beta: folderTerminals.terminalsOf(beta.uri).length };
		context.removeFolder(beta);
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ onGamma, ended: agent.disposed, backOnAlpha: column.names() }, {
			onGamma: { tabs: [], heldFor: '/w/alpha', beta: 0 },
			ended: false,
			backOnAlpha: ['agent'],
		});
	});

	test('turned on again on the folder a terminal was opened in, it stays on screen there', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, folderTerminals, configuration } = setup([column], [shell]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);
		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);
		const backgrounded = terminals.backgrounded.length;

		await setFollowFolder(configuration, true);

		assert.deepStrictEqual({ tabs: column.names(), putAway: terminals.backgrounded.length - backgrounded, shownFor: folderTerminals.folderOf(shell.asInstance())?.path }, {
			tabs: ['shell'],
			putAway: 0,
			shownFor: '/w/alpha',
		});
	});

	test('turned on again while those on their way with the window are being shown, they come up with the folder on screen, and revealing one does not move the window', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(shell)]);
		const { terminals, folders, context, bar, folderTerminals, configuration } = setup([column], [shell]);
		context.folders = [alpha, beta];
		onScreen(folders, bar, alpha);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		// On beta, the shell on its way with the window held half way back as following folders is turned on
		terminals.blockOn = { name: 'shell', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, beta);
		await setFollowFolder(configuration, true);
		terminals.blockOn.released.complete();
		await timeout(0);
		const inFront = await folderTerminals.reveal(shell.asInstance());

		assert.deepStrictEqual({ tabs: column.names(), inFront, moves: bar.moves, on: folders.activeFolder?.name }, {
			tabs: ['shell'],
			inFront: true,
			moves: [],
			on: 'beta',
		});
	});

	test('while terminals do not follow folders, a terminal opened in the panel for a row that joined the workspace since ends when that folder leaves it, its repository staying', async () => {
		const alpha = folder('alpha');
		const p1 = folder('p1');
		const { folders, context, bar, folderTerminals, configuration } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha];
		onScreen(folders, bar, alpha);
		bar.members = [alpha];
		bar.rows.push(p1.uri);
		await configuration.setUserConfiguration(FOLLOW_FOLDER, false);

		const agent = await folderTerminals.openFor(p1.uri, { name: 'agent' });
		context.addFolder(p1);
		const joined = folderTerminals.folderOf(agent)?.path;
		context.removeFolder(p1);

		assert.deepStrictEqual({ panel: agent.target === TerminalLocation.Panel, joined, ended: (agent as unknown as TestInstance).disposed }, { panel: true, joined: '/w/p1', ended: true });
	});

	test('a terminal held under a row that a reload brought back with nothing kept of the folder it was opened for - as an older window kept it - ends once git removed the row\'s worktree, its .git gone', async () => {
		const alpha = folder('alpha');
		const p1 = URI.file('/w/p1');
		const before = setup([new TestGroup(0, [])], []);
		before.context.folders = [alpha];
		before.folders.activeFolder = alpha;
		before.bar.members = [alpha];
		before.bar.rows.push(p1);
		const agent = await before.folderTerminals.openFor(p1, { name: 'agent' });
		(agent as unknown as TestInstance).dispose(TerminalExitReason.Shutdown);
		before.storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		before.storage.remove(OPENED_FOR_STORAGE_KEY, StorageScope.WORKSPACE);

		const revived = new TestInstance('agent', TerminalLocation.Panel);
		const after = setup([new TestGroup(0, [])], [], [], { storage: before.storage, revived: [revived], opensOn: alpha });
		after.context.folders = [alpha];
		await timeout(0);
		const heldFor = after.folderTerminals.folderOf(revived.asInstance())?.path;
		after.files.gone.add('/w/p1/.git');
		after.bar.read([]);
		await timeout(0);

		assert.deepStrictEqual({ heldFor, ended: revived.disposed, held: after.folderTerminals.terminalsOf(p1).length }, { heldFor: '/w/p1', ended: true, held: 0 });
	});

	test('a terminal that ends while it is being shown, as the window moves on again, is not put back in the background', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const { terminals, folders, context, bar, folderTerminals } = setup([new TestGroup(0, [tabFor(one)])], [one]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);

		// Back on alpha, the shell held half way back: it ends, and the window leaves again
		terminals.blockOn = { name: 'one', released: new DeferredPromise<void>() };
		await switchTo(folders, bar, alpha);
		one.dispose(TerminalExitReason.User);
		await folders.switchTo(beta);
		terminals.blockOn.released.complete();
		await timeout(0);

		assert.deepStrictEqual({ backgrounded: terminals.backgrounded, heldForAlpha: folderTerminals.terminalsOf(alpha.uri).length }, {
			backgrounded: ['one'],
			heldForAlpha: 0,
		});
	});

	test('a terminal opened as the window closes is not held', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const { terminals, folders, context, folderTerminals } = setup([new TestGroup(0, [])], []);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;

		terminals.whileCreating = () => folderTerminals.dispose();
		await folderTerminals.openFor(beta.uri, { name: 'agent' });

		assert.deepStrictEqual(folderTerminals.terminalsOf(beta.uri), []);
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

	test('one whose tab is still there when it comes back - a working set keeps the tab of a terminal running a child process until its group closes it - gets a tab of its own, and nobody is asked', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(agent), tabFor(shell)]);

		const { terminals, folders, context, bar } = setup([column], [agent, shell]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		terminals.leavingTabs.add('agent');
		const tabs = () => column.tabs.map(tab => tab.disposed ? `${tab.name}, left` : tab.name);

		await switchTo(folders, bar, beta);
		const away = tabs();
		await switchTo(folders, bar, alpha);

		// Given what was left of its tab, it would have opened nothing: in no tab, and lost to the next reload
		assert.deepStrictEqual({ away, back: tabs(), asked: column.asked, hidden: !terminals.foregroundInstances.includes(agent.asInstance()) }, {
			away: ['agent, left'],
			back: ['agent', 'shell'],
			asked: [],
			hidden: false
		});
	});

	test('one that comes back to no tab - showing it opened nothing - goes back to the background, held for its folder still, and comes back the next time', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const one = new TestInstance('one');
		const two = new TestInstance('two');
		const column = new TestGroup(0, [tabFor(one), tabFor(two)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [one, two]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		terminals.openingNothing.add('one');
		const hidden = () => [one, two].filter(instance => !terminals.foregroundInstances.includes(instance.asInstance())).map(instance => instance.name);
		const heldFor = (target: IWorkspaceFolder) => folderTerminals.terminalsOf(target.uri).map(instance => (instance as unknown as TestInstance).name);

		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);
		const first = { tabs: column.names(), hidden: hidden(), alpha: heldFor(alpha), ended: one.disposed || two.disposed };

		terminals.openingNothing.clear();
		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({ first, then: { tabs: column.names(), hidden: hidden() } }, {
			first: { tabs: [], hidden: ['one', 'two'], alpha: ['one', 'two'], ended: false },
			then: { tabs: ['one', 'two'], hidden: [] }
		});
	});

	test('what is left of a terminal\'s tab is not a tab of its own: shown again while it cannot be closed, the terminal goes back to the background rather than staying in the editor area with no tab', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [agent]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		terminals.leavingTabs.add('agent');
		column.refusing.add('agent');

		await switchTo(folders, bar, beta);
		await switchTo(folders, bar, alpha);

		assert.deepStrictEqual({
			hidden: !terminals.foregroundInstances.includes(agent.asInstance()),
			alpha: folderTerminals.terminalsOf(alpha.uri).map(instance => (instance as unknown as TestInstance).name),
			ended: agent.disposed
		}, { hidden: true, alpha: ['agent'], ended: false });
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

		const folderOf = (instance: TestInstance) => folderTerminals.folderOf(instance.asInstance())?.path;
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
		const inFront = await revealing;

		assert.deepStrictEqual({ on: folders.activeFolder?.name, moves: bar.moves, beforeItIsBack, inFront, tabs: column.names(), active: terminals.active, revealed: terminals.revealed, focused: agent.focused }, {
			on: 'alpha',
			moves: ['/w/alpha'],
			beforeItIsBack: { revealed: [], focused: false },
			inFront: true,
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

		const inFront = await folderTerminals.reveal(agent.asInstance());

		assert.deepStrictEqual({ inFront, moves: bar.moves, active: terminals.active, revealed: terminals.revealed, focused: agent.focused }, {
			inFront: true,
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
		const inFront = await revealing;

		assert.deepStrictEqual({ inFront, active: terminals.active, revealed: terminals.revealed, focused: agent.focused, parkedFor: folderTerminals.folderOf(agent.asInstance())?.path }, {
			inFront: false,
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
		const inFront = await revealing;
		await timeout(0);

		assert.deepStrictEqual({ on: folders.activeFolder?.name, inFront, active: terminals.active, revealed: terminals.revealed, focused: agent.focused, parkedFor: folderTerminals.folderOf(agent.asInstance())?.path }, {
			on: 'beta',
			inFront: false,
			active: undefined,
			revealed: [],
			focused: false,
			parkedFor: '/w/alpha',
		});
	});

	test('a terminal parked for a folder the window does not go to is not revealed, and stays parked for it', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [agent]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);

		// The bar does not move, as for a folder that is gone from disk
		const inFront = await folderTerminals.reveal(agent.asInstance());

		assert.deepStrictEqual({ inFront, moves: bar.moves, on: folders.activeFolder?.name, active: terminals.active, revealed: terminals.revealed, parkedFor: folderTerminals.folderOf(agent.asInstance())?.path }, {
			inFront: false,
			moves: ['/w/alpha'],
			on: 'beta',
			active: undefined,
			revealed: [],
			parkedFor: '/w/alpha',
		});
	});

	test('a terminal that has closed is not revealed, and the active terminal stays as it was', async () => {
		const alpha = folder('alpha');
		const agent = new TestInstance('agent');
		const shell = new TestInstance('shell');
		const column = new TestGroup(0, [tabFor(agent), tabFor(shell)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [agent, shell]);
		context.folders = [alpha];
		folders.activeFolder = alpha;
		terminals.setActiveInstance(shell.asInstance());

		agent.dispose(TerminalExitReason.Process);
		const inFront = await folderTerminals.reveal(agent.asInstance());

		assert.deepStrictEqual({ inFront, moves: bar.moves, active: terminals.active, revealed: terminals.revealed, focused: agent.focused }, {
			inFront: false,
			moves: [],
			active: 'shell',
			revealed: [],
			focused: false,
		});
	});

	test('a terminal that closes while it is brought back is not revealed', async () => {
		const alpha = folder('alpha');
		const beta = folder('beta');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);

		const { terminals, folders, context, bar, folderTerminals } = setup([column], [agent]);
		context.folders = [alpha, beta];
		folders.activeFolder = alpha;
		await switchTo(folders, bar, beta);
		moveThroughTheBar(bar, folders, context);

		// On alpha, its editors still being put up when the terminal closes
		const revealing = folderTerminals.reveal(agent.asInstance());
		await timeout(0);
		agent.dispose(TerminalExitReason.User);
		const inFront = await revealing;
		bar.restored();
		await timeout(0);

		assert.deepStrictEqual({ on: folders.activeFolder?.name, inFront, active: terminals.active, revealed: terminals.revealed, focused: agent.focused, tabs: column.names() }, {
			on: 'alpha',
			inFront: false,
			active: undefined,
			revealed: [],
			focused: false,
			tabs: [],
		});
	});

	test('a terminal that closes as it is put in front is said not to be in front', async () => {
		const alpha = folder('alpha');
		const agent = new TestInstance('agent');
		const column = new TestGroup(0, [tabFor(agent)]);

		const { terminals, folders, context, folderTerminals } = setup([column], [agent]);
		context.folders = [alpha];
		folders.activeFolder = alpha;
		agent.focusWhenReady = async () => agent.dispose(TerminalExitReason.User);

		const inFront = await folderTerminals.reveal(agent.asInstance());

		assert.deepStrictEqual({ inFront, revealed: terminals.revealed }, { inFront: false, revealed: ['agent'] });
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

		const parkedFor = (instance: TestInstance) => folderTerminals.folderOf(instance.asInstance())?.path;
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
