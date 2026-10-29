/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IReconnectionProperties, IShellLaunchConfig, ITerminalBackend, TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { IProcessDetails } from '../../../../../platform/terminal/common/terminalProcess.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { GroupModelChangeKind } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorsChangeEvent, IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { FolderTerminalEndReason, IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../terminal/browser/terminal.js';
import { FacadeRunsService } from '../../browser/facadeRuns.js';
import { facadeRunOf, facadeRunProperties, facadeRunTerminalOf, IFacadeRun, IFacadeRunTerminal } from '../../common/facadeRun.js';

let terminals = 0;

/** A terminal as far as runs go: the run it is marked with, the process running in it, and how it closed, once it has. */
class TestTerminal {

	private readonly _ready = new DeferredPromise<void>();
	private readonly _exit = new Emitter<number | undefined>();
	private readonly _disposed = new Emitter<ITerminalInstance>();
	readonly onExit = this._exit.event;
	readonly onDisposed = this._disposed.event;

	exitCode: number | undefined;
	exitReason: TerminalExitReason | undefined;
	isDisposed = false;
	/** How it was made: one that came back after a reload is made to reconnect to its process. */
	shellLaunchConfig: IShellLaunchConfig = {};
	/** What its tab in the editor area opens. */
	readonly resource = URI.from({ scheme: 'vscode-terminal', path: `/${++terminals}` });

	constructor(readonly reconnectionProperties: IReconnectionProperties | undefined, public processId: number | undefined) {
		if (processId !== undefined) {
			this._ready.complete();
		}
	}

	get processReady(): Promise<void> { return this._ready.p; }

	/** Its process ends, its terminal staying open - as a tab in the editor area does, waiting for a key. */
	exit(code: number | undefined): void {
		this._exit.fire(code);
	}

	/** It is gone from the window. */
	disposed(): void {
		this._disposed.fire(this.asInstance());
	}

	/** Its process tells its id, as on Windows it does with its first output. */
	ready(processId: number): void {
		this.processId = processId;
		this._ready.complete();
	}

	asInstance(): ITerminalInstance { return upcastPartial<ITerminalInstance>(this); }
}

/** A terminal made for agent `id` of the record `workspace`, marked so. */
function runTerminal(workspace: string, id: number, processId: number | undefined): TestTerminal {
	return new TestTerminal(facadeRunProperties({ workspace, id }), processId);
}

/** The terminal service as far as runs go: the terminals there, those that close, the active one, and the moment they are all back. */
class TestTerminalService extends mock<ITerminalService>() {

	readonly closed = new Emitter<ITerminalInstance>();
	readonly activated = new Emitter<ITerminalInstance | undefined>();
	readonly connected = new DeferredPromise<void>();

	override readonly onDidDisposeInstance = this.closed.event;
	override readonly onDidChangeActiveInstance = this.activated.event;
	override readonly whenConnected = this.connected.p;
	override instances: ITerminalInstance[] = [];
	override activeInstance: ITerminalInstance | undefined;

	override getInstanceFromResource(resource: UriComponents | undefined): ITerminalInstance | undefined {
		return resource ? this.instances.find(instance => instance.resource.toString() === URI.revive(resource).toString()) : undefined;
	}

	/** A terminal closes: gone from the window, why it went said. */
	close(terminal: TestTerminal, reason: TerminalExitReason, exitCode?: number): void {
		terminal.exitReason = reason;
		terminal.exitCode = exitCode;
		terminal.isDisposed = true;
		this.instances = this.instances.filter(instance => instance !== terminal.asInstance());
		this.closed.fire(terminal.asInstance());
		terminal.disposed();
	}

	/** A terminal is the active one. */
	activate(terminal: TestTerminal | undefined): void {
		this.activeInstance = terminal?.asInstance();
		this.activated.fire(this.activeInstance);
	}
}

suite('Facade runs - an agent\'s run on the terminal made for it', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * A load of the window, the terminals it has given; `orphans`, the processes the pty host runs for no
	 * window, which the window takes back where they are runs' - opening each for its folder, a terminal
	 * reconnected to it.
	 */
	function window(terminals: TestTerminal[], orphans: IProcessDetails[] = [], exited: IProcessDetails[] = []) {
		const listings: (boolean | undefined)[] = [];
		const terminalService = new TestTerminalService();
		terminalService.instances = terminals.map(terminal => terminal.asInstance());
		const eventually = new DeferredPromise<void>();
		const takenBack: string[] = [];
		/** Why the folder terminals ended a terminal: its folder left the workspace, or is gone from the disk. */
		const folderEnds = new Map<ITerminalInstance, FolderTerminalEndReason>();
		const contextKeyService = new MockContextKeyService();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(ITerminalService, terminalService);
		instantiationService.stub(ITerminalInstanceService, {
			getBackend: async () => upcastPartial<ITerminalBackend>({
				listProcesses: async options => {
					if (options?.exited) {
						return [...exited];
					}
					listings.push(options?.attached);
					return options?.attached ? [...orphans] : orphans.filter(each => each.isOrphan);
				}
			})
		});
		instantiationService.stub(IFolderTerminalsService, {
			openFor: async (folder: URI, config: IShellLaunchConfig) => {
				const details = config.attachPersistentProcess!;
				takenBack.push(`${folder.path}: ${details.pid}${config.name ? ` as ${config.name}` : ''}`);
				const terminal = new TestTerminal(details.reconnectionProperties, details.pid);
				terminalService.instances = [...terminalService.instances, terminal.asInstance()];
				return terminal.asInstance();
			},
			endedBecause: instance => folderEnds.get(instance)
		});
		instantiationService.stub(IContextKeyService, contextKeyService);
		instantiationService.stub(ILifecycleService, { when: (phase: LifecyclePhase) => phase === LifecyclePhase.Eventually ? eventually.p : Promise.resolve() });
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => upcastPartial<IWorkspace>({ id: 'lab-workspace' }) });
		instantiationService.stub(ILogService, new NullLogService());
		// The editor parts restored - floating windows, with their terminals, come last - and the window's state kept
		const editorsRestored = new DeferredPromise<void>();
		const editorsChanged = disposables.add(new Emitter<IEditorsChangeEvent>());
		const kept = { times: 0 };
		instantiationService.stub(IEditorGroupsService, { whenRestored: editorsRestored.p });
		instantiationService.stub(IEditorService, { onDidEditorsChange: editorsChanged.event });
		instantiationService.stub(IStorageService, { flush: async () => { kept.times++; } });
		const runs = disposables.add(instantiationService.createInstance(FacadeRunsService));

		/** The window has every terminal it had back, and has taken back what it takes back. */
		async function restored(): Promise<void> {
			terminalService.connected.complete();
			eventually.complete();
			editorsRestored.complete();
			await runs.whenRestored;
			await timeout(0);
		}
		return { runs, terminalService, contextKeyService, takenBack, restored, listings, eventually, editorsRestored, editorsChanged, kept, folderEnds };
	}

	/** A process the pty host runs for no window of this workspace's, or another's: a run's, marked so, or any other. */
	function orphan(pid: number, cwd: string, run?: IFacadeRun, workspaceId = 'lab-workspace', isOrphan = true): IProcessDetails {
		return upcastPartial<IProcessDetails>({ id: pid, pid, cwd, workspaceId, isOrphan, ...(run ? { reconnectionProperties: facadeRunProperties(run) } : {}) });
	}

	test('a run whose process exited while the window was away - reloading - as the pty host saw it, is gone with its code, not unseen; another workspace\'s exit is not this window\'s (N-14; REC-07)', async () => {
		const lab = 'a1b2';
		const exited = (id: number, exitCode: number | undefined, workspaceId = 'lab-workspace') => upcastPartial<IProcessDetails>({ id, pid: 100 + id, workspaceId, reconnectionProperties: facadeRunProperties({ workspace: lab, id }), ...(exitCode !== undefined ? { exitCode } : {}) });
		const { runs, restored } = window([], [], [exited(1, 3), exited(2, undefined), exited(4, 0, 'other-workspace')]);
		await restored();

		assert.deepStrictEqual(runs.processes(lab, [1, 2, 3, 4]), [
			{ id: 1, state: 'gone', end: { exitCode: 3, byThePerson: false } },
			{ id: 2, state: 'gone', end: { exitCode: undefined, byThePerson: false } },
			{ id: 3, state: 'gone' },
			{ id: 4, state: 'gone' }
		]);
	});

	test('a run\'s terminal that came back after a reload for a process that had ended meanwhile - it never had it - closing is no one stopping its agent: how the agent ended is the pty host\'s, its code - 128 and the signal\'s number for one killed - and unknown until the window has asked; one that did reconnect, closed by the person, is the person\'s (N-51, N-58; REC-07)', async () => {
		const lab = 'a1b2';
		const exitedDuring = runTerminal(lab, 1, undefined);
		const killedAway = runTerminal(lab, 2, undefined);
		const reconnected = runTerminal(lab, 3, 33);
		for (const [terminal, id] of [[exitedDuring, 1], [killedAway, 2], [reconnected, 3]] as const) {
			terminal.shellLaunchConfig = { attachPersistentProcess: upcastPartial<IProcessDetails>({ id, pid: 100 + id, reconnectionProperties: facadeRunProperties({ workspace: lab, id }) }) };
		}
		const exited = (id: number, exitCode: number) => upcastPartial<IProcessDetails>({ id, pid: 100 + id, workspaceId: 'lab-workspace', reconnectionProperties: facadeRunProperties({ workspace: lab, id }), exitCode });
		const { runs, terminalService, restored } = window([exitedDuring, killedAway, reconnected], [], [exited(1, 3), exited(2, 137)]);
		// Its process gone, the terminal that came back for it closes as the window comes back
		terminalService.close(exitedDuring, TerminalExitReason.User);
		const beforeAsked = runs.processes(lab, [1]);
		await restored();
		terminalService.close(killedAway, TerminalExitReason.User);
		terminalService.close(reconnected, TerminalExitReason.User);

		assert.deepStrictEqual({ beforeAsked, after: runs.processes(lab, [1, 2, 3]) }, {
			beforeAsked: [{ id: 1, state: 'unknown' }],
			after: [
				{ id: 1, state: 'gone', end: { exitCode: 3, byThePerson: false } },
				{ id: 2, state: 'gone', end: { exitCode: 137, byThePerson: false } },
				{ id: 3, state: 'gone', end: { exitCode: undefined, byThePerson: true } }
			]
		});
	});

	test('a run whose process ended - killed, with no code - its tab kept open and closed by the person after, ended by its process, not by the person; one closed while its process ran is the person\'s (C-WB-16; X-40)', async () => {
		const lab = 'a1b2';
		const killed = runTerminal(lab, 1, 11);
		const exited = runTerminal(lab, 2, 22);
		const running = runTerminal(lab, 3, 33);
		const { runs, terminalService, restored } = window([killed, exited, running]);
		[killed, exited, running].forEach((terminal, index) => runs.register(terminal.asInstance(), { workspace: lab, id: index + 1 }));
		await restored();
		killed.exit(undefined);
		exited.exit(3);
		terminalService.close(killed, TerminalExitReason.User);
		terminalService.close(exited, TerminalExitReason.User);
		terminalService.close(running, TerminalExitReason.User);

		assert.deepStrictEqual(runs.processes(lab), [
			{ id: 1, state: 'gone', end: { exitCode: undefined, byThePerson: false } },
			{ id: 2, state: 'gone', end: { exitCode: 3, byThePerson: false } },
			{ id: 3, state: 'gone', end: { exitCode: undefined, byThePerson: true } }
		]);
	});

	test('a run\'s terminal closed by an act that is not the closing of its tab says why in its end: the person\'s deletion of its worktree or removal of its folder from the workspace, by the person; its folder gone from the disk, by no one the window knows; one whose process had ended first was ended by its process (N-04; AGENT-LAUNCHER.md, L6; LA-06)', async () => {
		const lab = 'a1b2';
		const deleted = runTerminal(lab, 1, 11);
		const removed = runTerminal(lab, 2, 22);
		const gone = runTerminal(lab, 3, 33);
		const exitedFirst = runTerminal(lab, 4, 44);
		const { runs, terminalService, restored, folderEnds } = window([deleted, removed, gone, exitedFirst]);
		[deleted, removed, gone, exitedFirst].forEach((terminal, index) => runs.register(terminal.asInstance(), { workspace: lab, id: index + 1 }));
		await restored();
		runs.closingBecause(deleted.asInstance(), 'worktreeDeleted');
		folderEnds.set(removed.asInstance(), 'folderRemoved');
		folderEnds.set(gone.asInstance(), 'folderGone');
		folderEnds.set(exitedFirst.asInstance(), 'folderGone');
		exitedFirst.exit(1);
		for (const terminal of [deleted, removed, gone, exitedFirst]) {
			terminalService.close(terminal, TerminalExitReason.User);
		}

		assert.deepStrictEqual(runs.processes(lab), [
			{ id: 1, state: 'gone', end: { exitCode: undefined, byThePerson: true, reason: 'worktreeDeleted' } },
			{ id: 2, state: 'gone', end: { exitCode: undefined, byThePerson: true, reason: 'folderRemoved' } },
			{ id: 3, state: 'gone', end: { exitCode: undefined, byThePerson: false, reason: 'folderGone' } },
			{ id: 4, state: 'gone', end: { exitCode: 1, byThePerson: false } }
		]);
	});

	test('a run is the process its marked terminal started: present while that runs, with its id once told - the agents\' extension keeps it for an agent it finds again (N-79; C4-07b); gone once it ends - closed by the person, or exited, which the window says - and gone, unseen, once its terminal runs another; a number with no terminal is gone once the terminals are all back, and unknown before', async () => {
		const lab = 'a1b2';
		const closed = runTerminal(lab, 1, 11);
		const exited = runTerminal(lab, 2, 22);
		const relaunched = runTerminal(lab, 3, 33);
		const running = runTerminal(lab, 4, 44);
		// On Windows the id comes with the process's first output
		const silent = runTerminal(lab, 5, undefined);
		// Another workspace's, in this window; and a shell, which is no run
		const notes = runTerminal('c3d4', 1, 66);
		const shell = new TestTerminal(undefined, 77);
		const { runs, terminalService, restored } = window([closed, exited, relaunched, running, silent, notes, shell]);
		[closed, exited, relaunched, running, silent].forEach((terminal, index) => runs.register(terminal.asInstance(), { workspace: lab, id: index + 1 }));

		const beforeBack = runs.processes(lab, [4, 9]);
		await restored();
		terminalService.close(closed, TerminalExitReason.User);
		terminalService.close(exited, TerminalExitReason.Process, 2);
		relaunched.processId = 333;
		const silentAtFirst = runs.processes(lab, [5]);
		silent.ready(55);
		await timeout(0);

		assert.deepStrictEqual({
			beforeBack,
			silentAtFirst,
			all: runs.processes(lab),
			asked: runs.processes(lab, [4, 9]),
			terminals: [1, 3, 4, 5].map(id => runs.terminalOf({ workspace: lab, id }) === undefined ? 'none' : 'found'),
			notes: runs.processes('c3d4')
		}, {
			beforeBack: [{ id: 4, state: 'present', processId: 44 }, { id: 9, state: 'unknown' }],
			silentAtFirst: [{ id: 5, state: 'present' }],
			all: [
				{ id: 1, state: 'gone', end: { exitCode: undefined, byThePerson: true } },
				{ id: 2, state: 'gone', end: { exitCode: 2, byThePerson: false } },
				{ id: 3, state: 'gone' },
				{ id: 4, state: 'present', processId: 44 },
				{ id: 5, state: 'present', processId: 55 }
			],
			asked: [{ id: 4, state: 'present', processId: 44 }, { id: 9, state: 'gone' }],
			terminals: ['none', 'none', 'found', 'found'],
			notes: [{ id: 1, state: 'present', processId: 66 }]
		});
	});

	test('a run\'s terminal that went with the window is not ended: the window after a reload finds it by its mark, reconnected to the same process, whatever its title; one whose terminal is not back is unknown until the terminals are all back, then gone', async () => {
		const before = window([runTerminal('a1b2', 1, 11), runTerminal('a1b2', 2, 22)]);
		for (const instance of [...before.terminalService.instances]) {
			before.terminalService.close(instance as unknown as TestTerminal, TerminalExitReason.Shutdown);
		}
		const asTheWindowWent = before.runs.processes('a1b2', [1, 2]);

		// Only #1's terminal is back, reconnected to its process
		const after = window([runTerminal('a1b2', 1, 11)]);
		const comingBack = after.runs.processes('a1b2', [1, 2]);
		await after.restored();

		assert.deepStrictEqual({ asTheWindowWent, comingBack, back: after.runs.processes('a1b2', [1, 2]) }, {
			asTheWindowWent: [{ id: 1, state: 'unknown' }, { id: 2, state: 'unknown' }],
			comingBack: [{ id: 1, state: 'present', processId: 11 }, { id: 2, state: 'unknown' }],
			back: [{ id: 1, state: 'present', processId: 11 }, { id: 2, state: 'gone' }]
		});
	});

	test('a crashed window\'s floating windows come back last, their terminals with them: a run whose terminal a floating window brings back stays there - taken back as the window was past its phases, it opened in the main editor area, its floating window left empty (N-49; WIN-13)', async () => {
		const { runs, terminalService, takenBack, eventually, editorsRestored } = window([], [orphan(11, '/lab', { workspace: 'a1b2', id: 1 })]);
		terminalService.connected.complete();
		eventually.complete();
		await timeout(0);
		const beforeFloating = [...takenBack];
		// The floating window restores its tab, reconnecting to the process
		terminalService.instances = [runTerminal('a1b2', 1, 11).asInstance()];
		editorsRestored.complete();
		await runs.whenRestored;
		await timeout(0);

		assert.deepStrictEqual({ beforeFloating, takenBack, processes: runs.processes('a1b2', [1]) }, {
			beforeFloating: [],
			takenBack: [],
			processes: [{ id: 1, state: 'present', processId: 11 }]
		});
	});

	test('a window whose editor parts are not restored a while on takes back its runs\' orphans all the same, within the minute the pty host keeps them (N-49)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { runs, terminalService, takenBack, eventually } = window([], [orphan(11, '/lab', { workspace: 'a1b2', id: 1 })]);
		terminalService.connected.complete();
		eventually.complete();
		await timeout(10_000);
		await runs.whenRestored;
		await timeout(0);

		assert.deepStrictEqual({ takenBack, processes: runs.processes('a1b2', [1]) }, { takenBack: ['/lab: 11'], processes: [{ id: 1, state: 'present', processId: 11 }] });
	}));

	test('an agent\'s tab placed - opened in the editor area or a floating window, moved - is kept a moment on, not with the window\'s next save a minute later: its process outlives a crash of the window, which comes back as it was last kept; any other tab is the window\'s to keep (N-49; WIN-13)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const agent = runTerminal('a1b2', 1, 11);
		const file = new TestTerminal(undefined, 22);
		const { editorsChanged, kept } = window([agent, file]);
		const tabOf = (terminal: TestTerminal) => upcastPartial<EditorInput>({ resource: terminal.resource });
		const change = (kind: GroupModelChangeKind, terminal: TestTerminal) => editorsChanged.fire({ groupId: 1, event: { kind, editor: tabOf(terminal), editorIndex: 0 } });

		change(GroupModelChangeKind.EDITOR_ACTIVE, agent);
		change(GroupModelChangeKind.EDITOR_OPEN, file);
		await timeout(2_000);
		const others = kept.times;
		// Moved into a floating window: out of one group, into another
		change(GroupModelChangeKind.EDITOR_CLOSE, agent);
		change(GroupModelChangeKind.EDITOR_OPEN, agent);
		await timeout(2_000);

		assert.deepStrictEqual({ others, placed: kept.times }, { others: 0, placed: 1 });
	}));

	test('a window that crashed and was reopened takes back the runs of its workspace whose processes the pty host still runs for no window, each for its folder; not one the pty host revived after a restart of the app, which has no process yet, nor another workspace\'s, nor anything else', async () => {
		const { runs, takenBack, restored } = window([], [
			orphan(11, '/lab', { workspace: 'a1b2', id: 1 }),
			// Revived, not started: started, it would run its agent's CLI again
			orphan(-1, '/lab', { workspace: 'a1b2', id: 2 }),
			orphan(33, '/lab-worktrees/clamp', { workspace: 'a1b2', id: 3 }),
			orphan(44, '/lab'),
			// A window of another workspace crashed, and is not open again
			orphan(55, '/notes', { workspace: 'c3d4', id: 1 }, 'notes-workspace')
		]);
		await restored();

		assert.deepStrictEqual({ takenBack, processes: runs.processes('a1b2', [1, 2, 3]) }, {
			takenBack: ['/lab: 11', '/lab-worktrees/clamp: 33'],
			processes: [{ id: 1, state: 'present', processId: 11 }, { id: 2, state: 'gone' }, { id: 3, state: 'present', processId: 33 }]
		});
	});

	test('a run whose tab the window brought back itself after a crash - an editor tab reconnecting to its process - is not taken back a second time, which gave one process two tabs; nor one whose tab the person closed before it reconnected, whose end stands; one with no tab is taken back (N-54; REC-11)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const restoredTab = runTerminal('a1b2', 1, undefined);
		const closedTab = runTerminal('a1b2', 2, undefined);
		const { runs, terminalService, takenBack, restored } = window([restoredTab, closedTab], [orphan(11, '/lab', { workspace: 'a1b2', id: 1 }), orphan(22, '/lab', { workspace: 'a1b2', id: 2 }), orphan(33, '/lab', { workspace: 'a1b2', id: 3 })]);
		terminalService.close(closedTab, TerminalExitReason.User);
		await restored();
		restoredTab.ready(11);
		await timeout(2_100);

		assert.deepStrictEqual({ takenBack, processes: runs.processes('a1b2', [1, 2, 3]) }, {
			takenBack: ['/lab: 33'],
			processes: [{ id: 1, state: 'present', processId: 11 }, { id: 2, state: 'gone', end: { exitCode: undefined, byThePerson: true } }, { id: 3, state: 'present', processId: 33 }]
		});
	}));

	test('a run taken back after a crash reads `@name #aN` and is held for the folder it was opened for, not where its process went since; one from before the window became a workspace - another workspace id, this window\'s record - is taken back once the window knows its record (X-31; C-WB-10; C-WB-11)', async () => {
		const marked = (pid: number, cwd: string, run: IFacadeRun, opened: IFacadeRunTerminal, workspaceId = 'lab-workspace') => upcastPartial<IProcessDetails>({ id: pid, pid, cwd, workspaceId, isOrphan: true, reconnectionProperties: facadeRunProperties(run, opened) });
		const { runs, takenBack, restored } = window([], [
			marked(11, '/lab/src', { workspace: 'a1b2', id: 1 }, { name: '@lead #a1', folder: '/lab' }),
			marked(22, '/lab', { workspace: 'a1b2', id: 2 }, { name: '@before #a2', folder: '/lab' }, 'folder-workspace')
		]);
		await restored();
		const beforeKnown = [...takenBack];
		runs.setLive('a1b2', [1, 2], []);
		await timeout(10);

		assert.deepStrictEqual({ beforeKnown, takenBack }, { beforeKnown: ['/lab: 11 as @lead #a1'], takenBack: ['/lab: 11 as @lead #a1', '/lab: 22 as @before #a2'] });
	});

	test('a run whose process the pty host still runs for a window that went - reloaded again before the pty host saw it go - is neither present nor gone: the window takes it back once it is an orphan; one the pty host no longer has is gone', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const leftBehind = orphan(11, '/lab', { workspace: 'a1b2', id: 1 }, 'lab-workspace', false);
		const processes = [leftBehind, orphan(22, '/lab', { workspace: 'a1b2', id: 2 }, 'lab-workspace', false)];
		const { runs, takenBack, restored, listings } = window([], processes);
		await restored();
		const meanwhile = runs.processes('a1b2', [1, 2, 3]);

		// The pty host sees the window gone: one is an orphan now, the other has ended
		(leftBehind as { isOrphan: boolean }).isOrphan = true;
		processes.pop();
		const listed = listings.length;
		await timeout(2_100);
		const later = { takenBack: [...takenBack], processes: runs.processes('a1b2', [1, 2, 3]), listedAgain: listings.length > listed };

		assert.deepStrictEqual({ meanwhile, later, attached: listings.every(attached => attached === true) }, {
			meanwhile: [{ id: 1, state: 'unknown' }, { id: 2, state: 'unknown' }, { id: 3, state: 'gone' }],
			later: { takenBack: ['/lab: 11'], processes: [{ id: 1, state: 'present', processId: 11 }, { id: 2, state: 'gone' }, { id: 3, state: 'gone' }], listedAgain: true },
			attached: true
		});
	}));

	test('a terminal that closed as it was made - its process could not start - is a run that ended, with its exit code', () => {
		const { runs } = window([]);
		const failed = runTerminal('a1b2', 1, undefined);
		failed.exitCode = 127;
		failed.isDisposed = true;
		runs.register(failed.asInstance(), { workspace: 'a1b2', id: 1 });

		assert.deepStrictEqual(runs.processes('a1b2'), [{ id: 1, state: 'gone', end: { exitCode: 127, byThePerson: false } }]);
	});

	test('the window says whether its active terminal is a run\'s, for what its actions offer; a terminal\'s mark reads as its run, and nothing else as one', () => {
		const lead = runTerminal('a1b2', 1, 11);
		const shell = new TestTerminal(undefined, 22);
		const task = new TestTerminal({ ownerId: 'Task', data: { workspace: 'a1b2', id: 1 } }, 33);
		const { terminalService, contextKeyService } = window([lead, shell, task]);
		const answers: unknown[] = [];
		for (const terminal of [lead, shell, task, undefined]) {
			terminalService.activate(terminal);
			answers.push(contextKeyService.getContextKeyValue('facadeRunTerminal'));
		}

		assert.deepStrictEqual({ answers, runs: [lead, shell, task].map(terminal => facadeRunOf(terminal) ?? 'none') }, {
			answers: [true, false, false, false],
			runs: [{ workspace: 'a1b2', id: 1 }, 'none', 'none']
		});
	});

	test('a run\'s mark keeps what its terminal was opened with - its name, its folder, and the file its final screen goes to, which a terminal given back after a reload keeps it in before the agents\' extension registers it again (AGENT-DEBUGGING.md, D6; DB-05)', () => {
		const lab = 'a1b2';
		const opened: IFacadeRunTerminal = { name: '@lint #a3', folder: '/lab/w', finalScreen: 'file:///home/me/.facade/workspaces/lab/screens/a3.json' };
		const marked = new TestTerminal(facadeRunProperties({ workspace: lab, id: 3 }, opened), 33);
		const older = new TestTerminal(facadeRunProperties({ workspace: lab, id: 4 }, { name: '@doc #a4', folder: '/lab' }), 44);

		assert.deepStrictEqual([facadeRunTerminalOf(marked), facadeRunTerminalOf(older)], [opened, { name: '@doc #a4', folder: '/lab' }]);
	});
});
