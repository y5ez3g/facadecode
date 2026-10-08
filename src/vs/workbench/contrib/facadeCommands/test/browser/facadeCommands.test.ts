/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IAction } from '../../../../../base/common/actions.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotification, INotificationHandle, INotificationService, NotificationPriority } from '../../../../../platform/notification/common/notification.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ILifecycleService, LifecyclePhase, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { IWorktreeService } from '../../../worktrees/browser/worktrees.js';
import '../../browser/facadeCommands.contribution.js';
import { FacadeNotifications } from '../../browser/facadeNotifications.js';
import { FacadePersonInput, partsOf } from '../../browser/facadePersonInput.js';

/** A terminal as the folder terminals open one: made before its process is started, its id known once that is ready. */
class TestTerminal {

	private readonly _onDisposed = new Emitter<ITerminalInstance>();
	readonly onDisposed = this._onDisposed.event;

	private readonly _ready = new DeferredPromise<void>();
	private _processId: number | undefined;

	isDisposed = false;
	exitCode: number | undefined;

	constructor(readonly title: string | undefined) { }

	get processId(): number | undefined { return this._processId; }

	/** As a real terminal's: undefined once it has closed, its process manager let go of. */
	get processReady(): Promise<void> | undefined { return this.isDisposed ? undefined : this._ready.p; }

	/** Its process ready, with its id. */
	ready(processId: number): void {
		this._processId = processId;
		this._ready.complete();
	}

	/** Closed, as a terminal whose process could not start closes. */
	close(exitCode: number | undefined): void {
		this.exitCode = exitCode;
		this.isDisposed = true;
		this._onDisposed.fire(this.asInstance());
	}

	asInstance(): ITerminalInstance { return this as unknown as ITerminalInstance; }
}

suite('Facade commands - what the agents\' extension cannot do itself', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let steps: string[];
	let launched: IShellLaunchConfig[];
	/** What becomes of each terminal once it is made: by default its process is ready a moment later. */
	let afterOpening: (terminal: TestTerminal) => void;
	let instantiationService: TestInstantiationService;

	/** As the command service runs one: a handler that throws answers with a rejection. */
	async function run(id: string, ...args: unknown[]): Promise<unknown> {
		return instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand(id)!.handler(accessor, ...args));
	}

	/** The message a command failed with, or undefined when it did not. */
	async function failureOf(id: string, ...args: unknown[]): Promise<string | undefined> {
		try {
			await run(id, ...args);
			return undefined;
		} catch (err) {
			return (err as Error).message;
		}
	}

	/** Runs `work` with the unexpected errors it reports kept, by their messages, rather than failing the test. */
	async function reportingTo(reported: string[], work: () => Promise<unknown>): Promise<unknown> {
		const originalHandler = errorHandler.getUnexpectedErrorHandler();
		setUnexpectedErrorHandler(error => reported.push((error as Error).message));
		try {
			const result = await work();
			await timeout(0);
			return result;
		} finally {
			setUnexpectedErrorHandler(originalHandler);
		}
	}

	/** What a terminal was opened with: its working directory said as the kind it was given as, its icon by its id. */
	function launchOf({ name, executable, args, env, cwd, icon }: IShellLaunchConfig) {
		return { name, executable, args, env, cwd: URI.isUri(cwd) ? `uri ${cwd.path}` : cwd, icon: ThemeIcon.isThemeIcon(icon) ? icon.id : icon };
	}

	setup(() => {
		steps = [];
		launched = [];
		afterOpening = terminal => setTimeout(() => terminal.ready(4242));
		instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorktreeService, {
			makeWorktree: async (main, branch, options) => {
				steps.push(`make ${main.path} ${branch} ${options?.startPoint} ${options?.show}`);
				return URI.file(`/home/me/.facade/worktrees/lab/${branch}`);
			}
		});
		instantiationService.stub(IFolderTerminalsService, {
			reveal: async instance => {
				steps.push(`reveal ${instance.title}`);
				return true;
			},
			openFor: async (folder: URI, config: IShellLaunchConfig) => {
				steps.push(`open for ${folder.path}: ${config.name}`);
				launched.push(config);
				const terminal = new TestTerminal(config.name);
				afterOpening(terminal);
				return terminal.asInstance();
			}
		});
	});

	test('the folder the window is on is answered as it is, and nothing in an empty window', async () => {
		instantiationService.stub(IActiveFolderService, { activeFolder: upcastPartial<IWorkspaceFolder>({ uri: URI.file('/lab') }) });
		const onScreen = await run('_facade.folder.active') as URI;
		instantiationService.stub(IActiveFolderService, { activeFolder: undefined });
		const empty = await run('_facade.folder.active');

		assert.deepStrictEqual({ onScreen: onScreen.path, empty }, { onScreen: '/lab', empty: undefined });
	});

	test('a worktree is made from the commit it is given, or HEAD, and answered with its folder', async () => {
		const made = await run('_facade.worktree.create', URI.file('/lab'), 'clamp', 'a'.repeat(40), false);
		// As the extension host gives what it leaves out
		const fromHead = await run('_facade.worktree.create', URI.file('/lab'), 'tidy', null, null);

		assert.deepStrictEqual({ made: URI.isUri(made) ? made.path : made, fromHead: URI.isUri(fromHead) ? fromHead.path : fromHead, steps }, {
			made: '/home/me/.facade/worktrees/lab/clamp',
			fromHead: '/home/me/.facade/worktrees/lab/tidy',
			steps: [`make /lab clamp ${'a'.repeat(40)} false`, 'make /lab tidy undefined undefined'],
		});
	});

	test('a worktree is refused arguments of the wrong kind, and none is made', async () => {
		const failures = [
			await failureOf('_facade.worktree.create', '/lab', 'clamp'),
			await failureOf('_facade.worktree.create', URI.file('/lab')),
			await failureOf('_facade.worktree.create', URI.file('/lab'), 42),
			await failureOf('_facade.worktree.create', URI.file('/lab'), 'clamp', 42),
			await failureOf('_facade.worktree.create', URI.file('/lab'), 'clamp', undefined, 'yes'),
		];

		assert.deepStrictEqual({ failures, steps }, {
			failures: [
				'Unexpected type, expected \'URI\'',
				'Unexpected type, expected \'string\'',
				'Unexpected type, expected \'string\'',
				'Unexpected type, expected \'string\'',
				'Unexpected type, expected \'boolean\'',
			],
			steps: [],
		});
	});

	test('a terminal is opened for its folder as it is described - an agent\'s drawn as its CLI - and answered once its process is ready', async () => {
		const claude = await run('_facade.terminal.create', URI.file('/lab'), {
			name: '@main #1 · Claude Code',
			// npm's Claude Code, run as the Node script it runs
			executable: 'node.exe',
			args: ['/npm/claude-code/cli.js', '--model', 'haiku'],
			env: { FACADE_AGENTS_WAIT_MS: '120000', NO_COLOR: null },
			cwd: '/lab/src',
			agent: 'claude'
		});
		const antigravity = await run('_facade.terminal.create', URI.file('/lab'), { name: '@docs #2 · Antigravity', executable: 'agy', cwd: URI.file('/lab/docs'), agent: 'agy' });
		const noLogo = await run('_facade.terminal.create', URI.file('/lab'), { name: '@tidy #3 · Gemini', executable: 'gemini', agent: 'gemini' });
		// As the extension host gives what it leaves out
		const plain = await run('_facade.terminal.create', URI.file('/lab'), null);

		assert.deepStrictEqual({ answers: [claude, antigravity, noLogo, plain], launched: launched.map(launchOf) }, {
			answers: Array(4).fill({ processId: 4242, closed: false, exitCode: undefined }),
			launched: [
				{ name: '@main #1 · Claude Code', executable: 'node.exe', args: ['/npm/claude-code/cli.js', '--model', 'haiku'], env: { FACADE_AGENTS_WAIT_MS: '120000', NO_COLOR: null }, cwd: '/lab/src', icon: 'agent-claude' },
				{ name: '@docs #2 · Antigravity', executable: 'agy', args: undefined, env: undefined, cwd: 'uri /lab/docs', icon: 'agent-antigravity' },
				{ name: '@tidy #3 · Gemini', executable: 'gemini', args: undefined, env: undefined, cwd: 'uri /lab', icon: 'robot' },
				{ name: undefined, executable: undefined, args: undefined, env: undefined, cwd: 'uri /lab', icon: undefined },
			],
		});
	});

	test('a terminal is refused a folder or options of the wrong kind, and none is opened', async () => {
		const failures = [
			await failureOf('_facade.terminal.create', '/lab', {}),
			await failureOf('_facade.terminal.create', URI.file('/lab'), 'claude'),
			...await Promise.all([
				{ name: 1 },
				{ executable: ['claude'] },
				{ args: ['--model', 42] },
				// A whole command line, which only Windows takes
				{ args: '--model haiku' },
				{ env: { DEPTH: 2 } },
				{ cwd: 42 },
				{ agent: true },
				{ reveal: 1 },
			].map(options => failureOf('_facade.terminal.create', URI.file('/lab'), options))),
		];

		assert.deepStrictEqual({ failures, steps }, {
			failures: ['Unexpected type, expected \'URI\'', ...Array(9).fill('Unexpected type, expected \'IFacadeTerminalOptions\'')],
			steps: [],
		});
	});

	test('a terminal asked to be revealed is put in front once it is open, and answered all the same when it is not', async () => {
		const shown = await run('_facade.terminal.create', URI.file('/lab'), { name: 'shown', reveal: true });

		instantiationService.stub(IFolderTerminalsService, 'reveal', async (instance: ITerminalInstance) => {
			steps.push(`reveal ${instance.title}`);
			return false;
		});
		const notInFront = await run('_facade.terminal.create', URI.file('/lab'), { name: 'not in front', reveal: true });

		// Not waited for: it waits for the window to go to the terminal's folder
		instantiationService.stub(IFolderTerminalsService, 'reveal', (instance: ITerminalInstance) => {
			steps.push(`reveal ${instance.title}`);
			return new Promise<boolean>(() => { });
		});
		const stillGoing = await run('_facade.terminal.create', URI.file('/lab'), { name: 'still going', reveal: true });

		instantiationService.stub(IFolderTerminalsService, 'reveal', async () => { throw new Error('the folder has gone'); });
		const reported: string[] = [];
		const failed = await reportingTo(reported, () => run('_facade.terminal.create', URI.file('/lab'), { name: 'failed', reveal: true }));

		assert.deepStrictEqual({ answers: [shown, notInFront, stillGoing, failed], reported, steps }, {
			answers: Array(4).fill({ processId: 4242, closed: false, exitCode: undefined }),
			reported: ['the folder has gone'],
			steps: [
				'open for /lab: shown', 'reveal shown',
				'open for /lab: not in front', 'reveal not in front',
				'open for /lab: still going', 'reveal still going',
				'open for /lab: failed',
			],
		});
	});

	test('a terminal whose process has shown nothing is answered without its id after a few seconds', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		// On Windows the id comes with the process's first output
		afterOpening = () => { };
		const started = Date.now();
		const opened = await run('_facade.terminal.create', URI.file('/lab'), { name: 'silent', executable: 'cmd.exe' });

		assert.deepStrictEqual({ opened, waited: Date.now() - started }, {
			opened: { processId: undefined, closed: false, exitCode: undefined },
			waited: 5000,
		});
	}));

	test('a terminal that closes before its process is ready is answered at once, as closed', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		// Its process could not start: the terminal says why, and closes a moment after it was made
		afterOpening = terminal => setTimeout(() => terminal.close(2));
		const started = Date.now();
		const whileWaiting = await run('_facade.terminal.create', URI.file('/lab'), { name: '@main · Codex', executable: 'codex', agent: 'codex' });
		const waited = Date.now() - started;

		// Closed by the time it is looked at, nothing left of it to wait on
		afterOpening = terminal => terminal.close(undefined);
		const before = await run('_facade.terminal.create', URI.file('/lab'), { name: '@clamp · Codex', executable: 'codex', agent: 'codex' });

		assert.deepStrictEqual({ whileWaiting, waited, before }, {
			whileWaiting: { processId: undefined, closed: true, exitCode: 2 },
			waited: 0,
			before: { processId: undefined, closed: true, exitCode: undefined },
		});
	}));

	test('a terminal is put in front by the id of the process running in it, and answered with whether it is in front', async () => {
		instantiationService.stub(ITerminalService, {
			instances: [
				// An ended process's id, which another process can have been given since
				upcastPartial<ITerminalInstance>({ title: 'ended', processId: 4242, exitCode: 0 }),
				upcastPartial<ITerminalInstance>({ title: '@clamp · Claude Code', processId: 4242, exitCode: undefined }),
				// A remote machine's process and this one's, under one id
				upcastPartial<ITerminalInstance>({ title: 'remote', processId: 7, exitCode: undefined }),
				upcastPartial<ITerminalInstance>({ title: 'local', processId: 7, exitCode: undefined }),
			]
		});

		const shown = await run('_facade.terminal.reveal', 4242);
		instantiationService.stub(IFolderTerminalsService, 'reveal', async (instance: ITerminalInstance) => {
			steps.push(`reveal ${instance.title}`);
			return false;
		});
		const notInFront = await run('_facade.terminal.reveal', 4242);
		const twoRunIt = await run('_facade.terminal.reveal', 7);
		const noneRunsIt = await run('_facade.terminal.reveal', 99);
		const notAnId = await failureOf('_facade.terminal.reveal', '4242');

		assert.deepStrictEqual({ shown, notInFront, twoRunIt, noneRunsIt, notAnId, steps }, {
			shown: true,
			notInFront: false,
			twoRunIt: false,
			noneRunsIt: false,
			notAnId: 'Unexpected type, expected \'number\'',
			steps: ['reveal @clamp · Claude Code', 'reveal @clamp · Claude Code'],
		});
	});

	test('the window says how it was loaded: an id of this load\'s own, the same each time it is asked, and whether a reload of the window before loaded it, as VS Code tells itself', async () => {
		const answers: { id: string; reloaded: boolean }[] = [];
		for (const startupKind of [StartupKind.NewWindow, StartupKind.ReloadedWindow, StartupKind.ReopenedWindow]) {
			instantiationService.stub(ILifecycleService, { startupKind });
			answers.push(await run('_facade.window.loaded') as { id: string; reloaded: boolean });
		}

		assert.deepStrictEqual({
			reloaded: answers.map(answer => answer.reloaded),
			oneId: new Set(answers.map(answer => answer.id)).size === 1 && /^[0-9a-f-]{36}$/.test(answers[0].id)
		}, { reloaded: [false, true, false], oneId: true });
	});

	test('the window says once it has its terminals back: those reconnected to their processes, and the editor area\'s restored', async () => {
		const connected = new DeferredPromise<void>();
		const restored = new DeferredPromise<void>();
		const phases: LifecyclePhase[] = [];
		instantiationService.stub(ITerminalService, { whenConnected: connected.p });
		instantiationService.stub(ILifecycleService, {
			when: (phase: LifecyclePhase) => {
				phases.push(phase);
				return restored.p;
			}
		});
		let back = false;
		const waiting = run('_facade.terminal.whenRestored').then(() => back = true);
		await timeout(0);
		const atFirst = back;
		connected.complete();
		await timeout(0);
		const connectedOnly = back;
		restored.complete();
		await waiting;

		assert.deepStrictEqual({ atFirst, connectedOnly, back, phases }, { atFirst: false, connectedOnly: false, back: true, phases: [LifecyclePhase.Restored] });
	});

	const ESC = String.fromCharCode(27);
	const ENTER = String.fromCharCode(13);

	/** A terminal as input reaches it: the person's keys and pastes, and the text programs send it, each told as input data. */
	class InputTerminal {

		private readonly _onDidInputData = store.add(new Emitter<string>());
		readonly onDidInputData = this._onDidInputData.event;
		private readonly _onDisposed = store.add(new Emitter<ITerminalInstance>());
		readonly onDisposed = this._onDisposed.event;
		exitCode: number | undefined;

		constructor(readonly processId: number) { }

		/** As the person types or pastes, or the terminal answers a program on its own. */
		typed(data: string): void {
			this._onDidInputData.fire(data);
		}

		/** As a program sends it text: told as input data once it is written. */
		async sendText(text: string): Promise<void> {
			await Promise.resolve();
			this._onDidInputData.fire(text);
		}

		asInstance(): ITerminalInstance {
			return upcastPartial<ITerminalInstance>(this);
		}
	}

	/** Tracks the person's input in `terminals`, as the window does. */
	function trackInput(...terminals: InputTerminal[]): void {
		instantiationService.stub(ITerminalService, { instances: terminals.map(terminal => terminal.asInstance()), onDidCreateInstance: Event.None });
		store.add(instantiationService.createInstance(FacadePersonInput));
	}

	/** What `_facade.terminal.input` answers for `processId`, its last key as the milliseconds since `start`. */
	async function inputAt(processId: unknown, start = 0): Promise<unknown> {
		const input = await run('_facade.terminal.input', processId) as { pending: boolean; lastKey: number | undefined } | undefined;
		return input && { pending: input.pending, lastKey: input.lastKey === undefined ? undefined : input.lastKey - start };
	}

	test('a line is pending from a character the person types or pastes until they press Enter or Ctrl+C there; another key counts only while one is pending', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const lead = new InputTerminal(41);
		trackInput(lead);
		const start = Date.now();
		const inputOf = (processId: number) => inputAt(processId, start);
		const steps: unknown[] = [await inputOf(41)];
		lead.typed('f');
		steps.push(await inputOf(41));
		await timeout(1000);
		lead.typed(`${ESC}[D`);
		steps.push(await inputOf(41));
		lead.typed(ENTER);
		await timeout(1000);
		lead.typed(`${ESC}[A`);
		steps.push(await inputOf(41));
		lead.typed(`${ESC}[200~pas${ENTER}ted${ENTER}${ESC}[201~`);
		steps.push(await inputOf(41));
		lead.typed(String.fromCharCode(3));
		steps.push(await inputOf(41));

		assert.deepStrictEqual(steps, [
			{ pending: false, lastKey: undefined },
			{ pending: true, lastKey: 0 },
			{ pending: true, lastKey: 1000 },
			{ pending: false, lastKey: 1000 },
			{ pending: true, lastKey: 2000 },
			{ pending: false, lastKey: 2000 }
		]);
	}));

	test('what the terminal answers a program with on its own is no typing, a line pending or not: a cursor position, focus, attributes, a color', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const lead = new InputTerminal(41);
		trackInput(lead);
		const start = Date.now();
		const answers = `${ESC}[I${ESC}[12;5R${ESC}[?62;c${ESC}]10;rgb:ffff/ffff/ffff${ESC}\\${ESC}[?1u`;
		lead.typed(answers);
		const idle = await inputAt(41, start);
		lead.typed('x');
		await timeout(1000);
		lead.typed(answers);

		assert.deepStrictEqual({ idle, pending: await inputAt(41, start) }, {
			idle: { pending: false, lastKey: undefined },
			pending: { pending: true, lastKey: 0 }
		});
	}));

	test('what Facade types is not the person\'s, though its Enter sends what they typed along with it; what another program sends - a dropped path, a keybinding\'s sequence - is theirs', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const lead = new InputTerminal(41);
		trackInput(lead);
		const start = Date.now();
		const inputOf = (processId: number) => inputAt(processId, start);
		const typed = await run('_facade.terminal.type', 41, '[facade] 1 unread message: #m2 from @lint #a2. Call read_messages.');
		const afterLine = await inputOf(41);
		lead.typed('half');
		await run('_facade.terminal.type', 41, ENTER);
		const afterEnter = await inputOf(41);
		await lead.sendText(`${ESC}[200~C:\\lab\\notes.md${ESC}[201~`);
		const afterDrop = await inputOf(41);

		assert.deepStrictEqual({ typed, afterLine, afterEnter, afterDrop, nowhere: await run('_facade.terminal.type', 99, 'x') }, {
			typed: true,
			afterLine: { pending: false, lastKey: undefined },
			afterEnter: { pending: false, lastKey: 0 },
			afterDrop: { pending: true, lastKey: 0 },
			nowhere: false
		});
	}));

	test('a terminal is found by the id of the process running in it: not one whose process ended, which another can have since; nor is one tracked before the window looks', async () => {
		const ended = new InputTerminal(43);
		ended.exitCode = 0;
		const created = store.add(new Emitter<ITerminalInstance>());
		const instances = [ended.asInstance()];
		instantiationService.stub(ITerminalService, { instances, onDidCreateInstance: created.event });
		store.add(instantiationService.createInstance(FacadePersonInput));
		const later = new InputTerminal(42);
		instances.push(later.asInstance());
		created.fire(later.asInstance());
		later.typed('b');
		ended.typed('x');

		assert.deepStrictEqual({ later: (await inputAt(42) as { pending: boolean }).pending, ended: await inputAt(43), none: await inputAt(99), notAnId: await failureOf('_facade.terminal.input', '42') }, {
			later: true,
			ended: undefined,
			none: undefined,
			notAnId: 'Unexpected type, expected \'number\''
		});
	});

	test('keys as the kitty keyboard protocol and win32 input mode send them: Enter sends the line, Shift+Enter breaks it, Ctrl+C drops it, a character is text, a key let go is none', () => {
		const kitty = ['13u', '13;2u', '99;5u', '97u', '97;1:3u', '27u', '57399u'].map(params => partsOf(`${ESC}[${params}`)[0]);
		const win32 = ['13;28;13;1;0;1_', '13;28;13;1;16;1_', '67;46;3;1;8;1_', '65;30;97;1;0;1_', '65;30;97;0;0;1_', '81;16;64;1;9;1_', '37;75;0;1;0;1_'].map(params => partsOf(`${ESC}[${params}`)[0]);

		assert.deepStrictEqual({ kitty, win32 }, {
			kitty: ['submit', 'text', 'submit', 'text', 'none', 'key', 'key'],
			win32: ['submit', 'text', 'submit', 'text', 'none', 'text', 'key']
		});
	});

	/** The notification service, as far as Facade's notifications use it: each one shown, and whether it closed. */
	function notifications(): { readonly shown: { readonly notification: INotification; readonly handle: INotificationHandle; closed: boolean }[] } {
		const shown: { readonly notification: INotification; readonly handle: INotificationHandle; closed: boolean }[] = [];
		instantiationService.stub(INotificationService, {
			notify: (notification: INotification) => {
				const onDidClose = store.add(new Emitter<void>());
				const entry = {
					notification,
					closed: false,
					handle: upcastPartial<INotificationHandle>({
						onDidClose: onDidClose.event,
						close: () => {
							entry.closed = true;
							onDidClose.fire();
						}
					})
				};
				shown.push(entry);
				return entry.handle;
			}
		});
		store.add(instantiationService.createInstance(FacadeNotifications));
		return { shown };
	}

	/** Presses a notification's button, as the person does: its action runs, and the notification closes. */
	function press(entry: { readonly notification: INotification; readonly handle: INotificationHandle }, label: string): void {
		entry.notification.actions?.primary?.find((action: IAction) => action.label === label)?.run();
		entry.handle.close();
	}

	test('a notification Facade keeps by its key is shown, and the next with that key takes its place as a new one, so that it is shown as the first was; the call answers with the button pressed, or nothing once it closed', async () => {
		instantiationService.stub(IHostService, { hasFocus: true });
		const { shown } = notifications();
		const first = run('_facade.notification.show', 'message:3', '@lint #a3 has something for you: one.', ['Show']);
		const second = run('_facade.notification.show', 'message:3', '@lint #a3 has something for you: two.', ['Show', 'Later']);
		const other = run('_facade.notification.show', 'message:4', '@docs #a4 has something for you: done.', ['Show']);
		press(shown[1], 'Later');
		shown[2].handle.close();

		assert.deepStrictEqual({
			answers: [await first, await second, await other],
			shown: shown.map(({ notification, closed }) => ({ message: notification.message, buttons: notification.actions?.primary?.map(action => action.label), source: notification.source, closed }))
		}, {
			answers: [undefined, 'Later', undefined],
			shown: [
				{ message: '@lint #a3 has something for you: one.', buttons: ['Show'], source: 'Facade Agents', closed: true },
				{ message: '@lint #a3 has something for you: two.', buttons: ['Show', 'Later'], source: 'Facade Agents', closed: true },
				{ message: '@docs #a4 has something for you: done.', buttons: ['Show'], source: 'Facade Agents', closed: true }
			]
		});
	});

	test('a notification from an agent whose terminal has the person\'s focus, the window\'s too, goes quietly into the notification center', async () => {
		const { shown } = notifications();
		const terminal = { processId: 41, exitCode: undefined, hasFocus: true };
		instantiationService.stub(ITerminalService, { instances: [upcastPartial<ITerminalInstance>(terminal)] });
		instantiationService.stub(IHostService, { hasFocus: true });
		void run('_facade.notification.show', 'message:3', 'One.', ['Show'], 41);
		terminal.hasFocus = false;
		void run('_facade.notification.show', 'message:3', 'Two.', ['Show'], 41);
		terminal.hasFocus = true;
		instantiationService.stub(IHostService, { hasFocus: false });
		void run('_facade.notification.show', 'message:3', 'Three.', ['Show'], 41);
		instantiationService.stub(IHostService, { hasFocus: true });
		void run('_facade.notification.show', 'message:5', 'Elsewhere.', ['Show'], 99);

		assert.deepStrictEqual(shown.map(({ notification }) => `${notification.message} ${notification.priority === NotificationPriority.SILENT ? 'quiet' : 'aloud'}`), ['One. quiet', 'Two. aloud', 'Three. aloud', 'Elsewhere. aloud']);
	});

	test('a notification is refused a key, a message, buttons or a process id of the wrong kind, and none is shown', async () => {
		const { shown } = notifications();
		const failures = [
			await failureOf('_facade.notification.show', 42, 'text', []),
			await failureOf('_facade.notification.show', 'key', undefined, []),
			await failureOf('_facade.notification.show', 'key', 'text', ['Show', 2]),
			await failureOf('_facade.notification.show', 'key', 'text', ['Show'], '41')
		];

		assert.deepStrictEqual({ failures, shown: shown.length }, {
			failures: ['Unexpected type, expected \'string\'', 'Unexpected type, expected \'string\'', 'Unexpected type, expected \'string[]\'', 'Unexpected type, expected \'number\''],
			shown: 0
		});
	});
});
