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
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { IWorktreeService } from '../../../worktrees/browser/worktrees.js';
import '../../browser/facadeCommands.contribution.js';

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
			name: '@main (2) · Claude Code',
			// npm's Claude Code, run as the Node script it runs
			executable: 'node.exe',
			args: ['/npm/claude-code/cli.js', '--model', 'haiku'],
			env: { FACADE_PID: '2', NO_COLOR: null },
			cwd: '/lab/src',
			agent: 'claude'
		});
		const antigravity = await run('_facade.terminal.create', URI.file('/lab'), { name: '@docs (3) · Antigravity', executable: 'agy', cwd: URI.file('/lab/docs'), agent: 'agy' });
		const noLogo = await run('_facade.terminal.create', URI.file('/lab'), { name: '@tidy (4) · Gemini', executable: 'gemini', agent: 'gemini' });
		// As the extension host gives what it leaves out
		const plain = await run('_facade.terminal.create', URI.file('/lab'), null);

		assert.deepStrictEqual({ answers: [claude, antigravity, noLogo, plain], launched: launched.map(launchOf) }, {
			answers: Array(4).fill({ processId: 4242, closed: false, exitCode: undefined }),
			launched: [
				{ name: '@main (2) · Claude Code', executable: 'node.exe', args: ['/npm/claude-code/cli.js', '--model', 'haiku'], env: { FACADE_PID: '2', NO_COLOR: null }, cwd: '/lab/src', icon: 'agent-claude' },
				{ name: '@docs (3) · Antigravity', executable: 'agy', args: undefined, env: undefined, cwd: 'uri /lab/docs', icon: 'agent-antigravity' },
				{ name: '@tidy (4) · Gemini', executable: 'gemini', args: undefined, env: undefined, cwd: 'uri /lab', icon: 'robot' },
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
});
