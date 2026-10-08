/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { ILifecycleService, LifecyclePhase, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalContribution, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { IWorktreeService } from '../../../worktrees/browser/worktrees.js';
import { FacadeAgentTerminal, IAgentKeysOptions, IAgentTerminalOptions, IAgentTypeOptions } from '../../browser/facadeAgentTerminal.js';
import '../../browser/facadeCommands.contribution.js';

/** A terminal as the folder terminals open one: made before its process is started, its id known once that is ready. */
class TestTerminal {

	private readonly _onDisposed = new Emitter<ITerminalInstance>();
	readonly onDisposed = this._onDisposed.event;

	private readonly _ready = new DeferredPromise<void>();
	private _processId: number | undefined;

	isDisposed = false;
	exitCode: number | undefined;
	/** Its Facade contribution, as a test makes it. */
	agent: ITerminalContribution | undefined;

	constructor(readonly title: string | undefined) { }

	getContribution<T extends ITerminalContribution>(id: string): T | null { return (id === FacadeAgentTerminal.ID ? this.agent ?? null : null) as T | null; }

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

	/** A terminal of the window titled `title` as it was opened, with its Facade contribution. */
	function windowTerminal(title: string, processId: number | undefined, exitCode: number | undefined, isAgent = true): ITerminalInstance {
		const agent: ITerminalContribution = agentTerminal(title, isAgent, exitCode !== undefined);
		return upcastPartial<ITerminalInstance>({
			title,
			shellLaunchConfig: { name: title },
			processId,
			exitCode,
			isDisposed: false,
			getContribution: <T extends ITerminalContribution>(id: string) => (id === FacadeAgentTerminal.ID ? agent : null) as T | null
		});
	}

	/** The Facade contribution of the terminal titled `title`, its calls kept in `steps`. */
	function agentTerminal(title: string | undefined, isAgent = true, exited = false): FacadeAgentTerminal {
		return upcastPartial<FacadeAgentTerminal>({
			isAgent,
			exited,
			register: (options: IAgentTerminalOptions) => steps.push(`register ${title} as #${options.run}, its final screen in ${options.finalScreen.path}`),
			read: async (lines: number) => {
				steps.push(`read ${lines} of ${title}`);
				return { lines: ['> hi'], buffer: 'normal', older: false, trimmed: false, capturedAt: 1, lastOutput: undefined };
			},
			type: async (text: string, options: IAgentTypeOptions) => {
				steps.push(`type ${JSON.stringify(text)} into ${title} ${JSON.stringify(options)}`);
				return { outcome: 'applied', pasted: true, entered: true };
			},
			keys: async (keys: readonly string[], options: IAgentKeysOptions) => {
				steps.push(`press ${keys.join(' ')} in ${title} ${JSON.stringify(options)}`);
				return { outcome: 'applied', keysSent: keys.length };
			}
		});
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
				terminal.agent = agentTerminal(config.name);
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

	test('a terminal opened for an agent\'s run is registered as its terminal, its final screen going to its file', async () => {
		await run('_facade.terminal.create', URI.file('/lab'), { name: '@lint #3 - Codex', executable: 'codex', agent: 'codex', run: 3, finalScreen: URI.file('/rec/screens/a3.json') });
		await run('_facade.terminal.create', URI.file('/lab'), { name: 'a shell' });
		const failures = await Promise.all([{ run: '3' }, { finalScreen: '/rec/screens/a3.json' }].map(options => failureOf('_facade.terminal.create', URI.file('/lab'), options)));

		assert.deepStrictEqual({ failures, steps }, {
			failures: Array(2).fill('Unexpected type, expected \'IFacadeTerminalOptions\''),
			steps: ['open for /lab: @lint #3 - Codex', 'register @lint #3 - Codex as #3, its final screen in /rec/screens/a3.json', 'open for /lab: a shell'],
		});
	});

	test('an agent\'s terminal is read, typed into, pressed keys in and registered by its process\'s id, or its name before it has one; a terminal no agent\'s is only read', async () => {
		instantiationService.stub(ITerminalService, {
			instances: [
				windowTerminal('@lint #3 - Codex', 4242, undefined),
				windowTerminal('ended', 4242, 1),
				windowTerminal('@new #4 - Antigravity', undefined, undefined),
				windowTerminal('@gone #5 - Codex', 77, 0),
				windowTerminal('a shell', 5151, undefined, false),
			]
		});

		const answers = {
			read: await run('_facade.terminal.read', 4242, 20, '@lint #3 - Codex'),
			readEnded: await run('_facade.terminal.read', 77, 50),
			readByName: await run('_facade.terminal.read', null, 5, '@new #4 - Antigravity'),
			readNone: await run('_facade.terminal.read', 99, 5),
			typed: await run('_facade.terminal.type', 4242, 'yes', { enter: true, enterDelayMs: 250.4, queueTimeoutMs: 120000 }),
			pressed: await run('_facade.terminal.keys', 4242, ['Down', 'Enter', 'y'], { queueTimeoutMs: null }),
			typedIntoShell: await run('_facade.terminal.type', 5151, 'ls', { enter: true }),
			pressedInShell: await run('_facade.terminal.keys', 5151, ['Enter'], {}),
			registered: await run('_facade.terminal.register', null, { run: 4, finalScreen: URI.file('/rec/screens/a4.json') }, '@new #4 - Antigravity'),
			registeredNone: await run('_facade.terminal.register', 99, { run: 9, finalScreen: URI.file('/rec/screens/a9.json') }),
		};
		const failures = [
			await failureOf('_facade.terminal.read', 4242, 0),
			await failureOf('_facade.terminal.read', 4242, 2001),
			await failureOf('_facade.terminal.read', '4242', 5),
			await failureOf('_facade.terminal.type', 4242, 42, {}),
			await failureOf('_facade.terminal.type', 4242, 'yes', { enterDelayMs: -1 }),
			await failureOf('_facade.terminal.keys', 4242, [], {}),
			await failureOf('_facade.terminal.keys', 4242, ['F1'], {}),
			await failureOf('_facade.terminal.keys', 4242, ['Enter'], { queueTimeoutMs: Number.POSITIVE_INFINITY }),
			await failureOf('_facade.terminal.register', 4242, { run: 3 }),
			await failureOf('_facade.terminal.register', 4242, { run: 3, finalScreen: '/rec/screens/a3.json' }),
		];

		assert.deepStrictEqual({ answers, failures, steps }, {
			answers: {
				read: { lines: ['> hi'], buffer: 'normal', older: false, trimmed: false, capturedAt: 1, lastOutput: undefined, exited: false },
				readEnded: { lines: ['> hi'], buffer: 'normal', older: false, trimmed: false, capturedAt: 1, lastOutput: undefined, exited: true },
				readByName: { lines: ['> hi'], buffer: 'normal', older: false, trimmed: false, capturedAt: 1, lastOutput: undefined, exited: false },
				readNone: undefined,
				typed: { outcome: 'applied', pasted: true, entered: true },
				pressed: { outcome: 'applied', keysSent: 3 },
				typedIntoShell: undefined,
				pressedInShell: undefined,
				registered: true,
				registeredNone: false,
			},
			failures: [
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'string\'',
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'string[]\'',
				'Unexpected type, expected \'string[]\'',
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'IAgentTerminalOptions\'',
				'Unexpected type, expected \'IAgentTerminalOptions\'',
			],
			steps: [
				'read 20 of @lint #3 - Codex',
				'read 50 of @gone #5 - Codex',
				'read 5 of @new #4 - Antigravity',
				'type "yes" into @lint #3 - Codex {"enter":true,"enterDelayMs":250,"queueTimeoutMs":120000}',
				'press Down Enter y in @lint #3 - Codex {}',
				'register @new #4 - Antigravity as #4, its final screen in /rec/screens/a4.json',
			],
		});
	});
});
