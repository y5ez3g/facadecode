/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IReconnectionProperties, IShellLaunchConfig, ITerminalBackend, TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { IProcessDetails } from '../../../../../platform/terminal/common/terminalProcess.js';
import { IWorkspace, IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../terminal/browser/terminal.js';
import { FacadeRunsService } from '../../browser/facadeRuns.js';
import { facadeRunOf, facadeRunProperties, IFacadeRun } from '../../common/facadeRun.js';

/** A terminal as far as runs go: the run it is marked with, the process running in it, and how it closed, once it has. */
class TestTerminal {

	private readonly _ready = new DeferredPromise<void>();

	exitCode: number | undefined;
	exitReason: TerminalExitReason | undefined;
	isDisposed = false;

	constructor(readonly reconnectionProperties: IReconnectionProperties | undefined, public processId: number | undefined) {
		if (processId !== undefined) {
			this._ready.complete();
		}
	}

	get processReady(): Promise<void> { return this._ready.p; }

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

	/** A terminal closes: gone from the window, why it went said. */
	close(terminal: TestTerminal, reason: TerminalExitReason, exitCode?: number): void {
		terminal.exitReason = reason;
		terminal.exitCode = exitCode;
		terminal.isDisposed = true;
		this.instances = this.instances.filter(instance => instance !== terminal.asInstance());
		this.closed.fire(terminal.asInstance());
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
	function window(terminals: TestTerminal[], orphans: IProcessDetails[] = []) {
		const terminalService = new TestTerminalService();
		terminalService.instances = terminals.map(terminal => terminal.asInstance());
		const eventually = new DeferredPromise<void>();
		const takenBack: string[] = [];
		const contextKeyService = new MockContextKeyService();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(ITerminalService, terminalService);
		instantiationService.stub(ITerminalInstanceService, { getBackend: async () => upcastPartial<ITerminalBackend>({ listProcesses: async () => orphans }) });
		instantiationService.stub(IFolderTerminalsService, {
			openFor: async (folder: URI, config: IShellLaunchConfig) => {
				const details = config.attachPersistentProcess!;
				takenBack.push(`${folder.path}: ${details.pid}`);
				const terminal = new TestTerminal(details.reconnectionProperties, details.pid);
				terminalService.instances = [...terminalService.instances, terminal.asInstance()];
				return terminal.asInstance();
			}
		});
		instantiationService.stub(IContextKeyService, contextKeyService);
		instantiationService.stub(ILifecycleService, { when: (phase: LifecyclePhase) => phase === LifecyclePhase.Eventually ? eventually.p : Promise.resolve() });
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => upcastPartial<IWorkspace>({ id: 'lab-workspace' }) });
		instantiationService.stub(ILogService, new NullLogService());
		const runs = disposables.add(instantiationService.createInstance(FacadeRunsService));

		/** The window has every terminal it had back, and has taken back what it takes back. */
		async function restored(): Promise<void> {
			terminalService.connected.complete();
			eventually.complete();
			await runs.whenRestored;
			await timeout(0);
		}
		return { runs, terminalService, contextKeyService, takenBack, restored };
	}

	/** A process the pty host runs for no window of this workspace's, or another's: a run's, marked so, or any other. */
	function orphan(pid: number, cwd: string, run?: IFacadeRun, workspaceId = 'lab-workspace'): IProcessDetails {
		return upcastPartial<IProcessDetails>({ id: pid, pid, cwd, workspaceId, isOrphan: true, ...(run ? { reconnectionProperties: facadeRunProperties(run) } : {}) });
	}

	test('a run is the process its marked terminal started: present while that runs; gone once it ends - closed by the person, or exited, which the window says - and gone, unseen, once its terminal runs another; a number with no terminal is gone once the terminals are all back, and unknown before', async () => {
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
			beforeBack: [{ id: 4, state: 'present' }, { id: 9, state: 'unknown' }],
			silentAtFirst: [{ id: 5, state: 'present' }],
			all: [
				{ id: 1, state: 'gone', end: { exitCode: undefined, byThePerson: true } },
				{ id: 2, state: 'gone', end: { exitCode: 2, byThePerson: false } },
				{ id: 3, state: 'gone' },
				{ id: 4, state: 'present' },
				{ id: 5, state: 'present' }
			],
			asked: [{ id: 4, state: 'present' }, { id: 9, state: 'gone' }],
			terminals: ['none', 'none', 'found', 'found'],
			notes: [{ id: 1, state: 'present' }]
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
			comingBack: [{ id: 1, state: 'present' }, { id: 2, state: 'unknown' }],
			back: [{ id: 1, state: 'present' }, { id: 2, state: 'gone' }]
		});
	});

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
			processes: [{ id: 1, state: 'present' }, { id: 2, state: 'gone' }, { id: 3, state: 'present' }]
		});
	});

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
});
