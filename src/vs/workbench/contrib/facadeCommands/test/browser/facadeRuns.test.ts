/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IStorageService, StorageScope, WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { FacadeRunsService, RUNS_STORAGE_KEY } from '../../browser/facadeRuns.js';

/** A terminal as far as runs go: its nonce, the process running in it, and how it closed, once it has. */
class TestTerminal {

	private readonly _ready = new DeferredPromise<void>();

	exitCode: number | undefined;
	exitReason: TerminalExitReason | undefined;
	isDisposed = false;

	constructor(readonly shellIntegrationNonce: string, public processId: number | undefined) {
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

/** The terminal service as far as runs go: the terminals there, those that close, and the moment they are all back. */
class TestTerminalService extends mock<ITerminalService>() {

	readonly closed = new Emitter<ITerminalInstance>();
	readonly connected = new DeferredPromise<void>();

	override readonly onDidDisposeInstance = this.closed.event;
	override readonly whenConnected = this.connected.p;
	override instances: ITerminalInstance[] = [];

	/** A terminal closes: gone from the window, why it went said. */
	close(terminal: TestTerminal, reason: TerminalExitReason, exitCode?: number): void {
		terminal.exitReason = reason;
		terminal.exitCode = exitCode;
		terminal.isDisposed = true;
		this.instances = this.instances.filter(instance => instance !== terminal.asInstance());
		this.closed.fire(terminal.asInstance());
	}
}

suite('Facade runs - an agent\'s run on the terminal made for it', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/** A load of the window over `storage`, the terminals it has given as they come back. */
	function windowOver(storage: TestStorageService, ...terminals: TestTerminal[]) {
		const terminalService = new TestTerminalService();
		terminalService.instances = terminals.map(terminal => terminal.asInstance());
		const eventually = new DeferredPromise<void>();
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(ITerminalService, terminalService);
		instantiationService.stub(IStorageService, storage);
		instantiationService.stub(ILifecycleService, { when: (phase: LifecyclePhase) => phase === LifecyclePhase.Eventually ? eventually.p : Promise.resolve() });
		const runs = disposables.add(instantiationService.createInstance(FacadeRunsService));

		/** The window has every terminal it had back. */
		async function restored(): Promise<void> {
			terminalService.connected.complete();
			eventually.complete();
			await runs.whenRestored;
		}
		return { runs, terminalService, restored };
	}

	/** What was kept of the runs: each by its number, with its terminal's nonce and its process. */
	function kept(storage: TestStorageService): string[] {
		const stored: { id: number; nonce: string; processId?: number }[] = JSON.parse(storage.get(RUNS_STORAGE_KEY, StorageScope.WORKSPACE) ?? '[]');
		return stored.map(({ id, nonce, processId }) => `#${id} ${nonce} ${processId}`);
	}

	test('a run is the process its terminal started for it: present while that runs; gone once it ends - closed by the person, or exited, which the window says - and gone, unseen, once its terminal runs another; a number never registered is gone once the terminals are all back, and unknown before', async () => {
		const storage = disposables.add(new TestStorageService());
		const closed = new TestTerminal('closed', 11);
		const exited = new TestTerminal('exited', 22);
		const relaunched = new TestTerminal('relaunched', 33);
		const running = new TestTerminal('running', 44);
		// On Windows the id comes with the process's first output
		const silent = new TestTerminal('silent', undefined);
		// Another workspace's, in this window
		const notes = new TestTerminal('notes', 66);
		const { runs, terminalService, restored } = windowOver(storage, closed, exited, relaunched, running, silent, notes);
		const lab = 'a1b2';
		[closed, exited, relaunched, running, silent].forEach((terminal, index) => runs.register(terminal.asInstance(), { workspace: lab, id: index + 1 }));
		runs.register(notes.asInstance(), { workspace: 'c3d4', id: 1 });

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
			terminals: [1, 3, 4].map(id => runs.terminalOf({ workspace: lab, id }) === undefined ? 'none' : 'found'),
			kept: kept(storage)
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
			terminals: ['none', 'none', 'found'],
			kept: ['#4 running 44', '#5 silent 55', '#1 notes 66']
		});
	});

	test('a run whose process may run on is kept for the window after: through a reload its terminal comes back with the same nonce and process, and it is present as soon as it is back; one whose terminal is not back is unknown until the terminals are all back, then gone, and kept no more; one that went with the window is not ended', async () => {
		const storage = disposables.add(new TestStorageService());
		const before = windowOver(storage, new TestTerminal('lead', 11), new TestTerminal('tests', 22));
		const [lead, tests] = before.terminalService.instances;
		before.runs.register(lead, { workspace: 'a1b2', id: 1 });
		before.runs.register(tests, { workspace: 'a1b2', id: 2 });
		await before.restored();
		// The window reloads, its terminals going with it
		for (const instance of [...before.terminalService.instances]) {
			before.terminalService.close(instance as unknown as TestTerminal, TerminalExitReason.Shutdown);
		}
		const asTheWindowWent = before.runs.processes('a1b2');
		storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
		const keptByTheReload = kept(storage);

		// Only the lead's terminal comes back, reconnected to its process
		const after = windowOver(storage, new TestTerminal('lead', 11));
		const comingBack = after.runs.processes('a1b2');
		await after.restored();

		assert.deepStrictEqual({ asTheWindowWent, keptByTheReload, comingBack, back: after.runs.processes('a1b2'), kept: kept(storage) }, {
			asTheWindowWent: [{ id: 1, state: 'unknown' }, { id: 2, state: 'unknown' }],
			keptByTheReload: ['#1 lead 11', '#2 tests 22'],
			comingBack: [{ id: 1, state: 'present' }, { id: 2, state: 'unknown' }],
			back: [{ id: 1, state: 'present' }, { id: 2, state: 'gone' }],
			kept: ['#1 lead 11']
		});
	});

	test('a terminal that closed as it was made - its process could not start - is a run that ended, with its exit code', async () => {
		const storage = disposables.add(new TestStorageService());
		const { runs } = windowOver(storage);
		const failed = new TestTerminal('failed', undefined);
		failed.exitCode = 127;
		failed.isDisposed = true;
		runs.register(failed.asInstance(), { workspace: 'a1b2', id: 1 });

		assert.deepStrictEqual({ processes: runs.processes('a1b2'), kept: kept(storage) }, {
			processes: [{ id: 1, state: 'gone', end: { exitCode: 127, byThePerson: false } }],
			kept: []
		});
	});
});
