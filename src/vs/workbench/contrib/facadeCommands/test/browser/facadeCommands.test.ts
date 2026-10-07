/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IProcessEnvironment, isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/index.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IMergedEnvironmentVariableCollection } from '../../../../../platform/terminal/common/environmentVariable.js';
import { IShellLaunchConfig, ITerminalBackend } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { ILifecycleService, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalConfigurationService, ITerminalInstance, ITerminalInstanceService } from '../../../terminal/browser/terminal.js';
import { IEnvironmentVariableService } from '../../../terminal/common/environmentVariable.js';
import { ITerminalConfiguration, ITerminalProfileResolverService } from '../../../terminal/common/terminal.js';
import { IWorktreeService } from '../../../worktrees/browser/worktrees.js';
import '../../browser/facadeCommands.contribution.js';
import { FacadeRunProcess, IFacadeRunsService } from '../../browser/facadeRuns.js';
import { facadeRunOf, IFacadeRun } from '../../common/facadeRun.js';

/** A terminal as the folder terminals open one: made before its process is started, its id known once that is ready. */
class TestTerminal {

	private readonly _onDisposed = new Emitter<ITerminalInstance>();
	readonly onDisposed = this._onDisposed.event;

	private readonly _onExit = new Emitter<number | undefined>();
	readonly onExit = this._onExit.event;

	/** What the commands did to it: the signals it was sent, what was typed into it, and its closing. */
	readonly done: string[] = [];

	/** Whether its process ends on a hang-up, as a CLI does. */
	endsOnHangUp = true;

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

	async sendSignal(signal: string): Promise<void> {
		this.done.push(`signal ${signal}`);
		if (signal === 'SIGHUP' && this.endsOnHangUp) {
			// Its process exits, and its terminal closes after it
			setTimeout(() => {
				this._onExit.fire(129);
				this.close(129);
			});
		}
	}

	async sendText(text: string, shouldExecute: boolean): Promise<void> {
		this.done.push(`type ${JSON.stringify(text)}${shouldExecute ? ' and run it' : ''}`);
	}

	dispose(): void {
		this.done.push('dispose');
		this.close(undefined);
	}

	asInstance(): ITerminalInstance { return this as unknown as ITerminalInstance; }
}

suite('Facade commands - what the agents\' extension cannot do itself', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let steps: string[];
	let launched: IShellLaunchConfig[];
	/** The terminal of each run, and what the window knows of its process, by `workspace#id`. */
	let runs: Map<string, { terminal?: TestTerminal; process: FacadeRunProcess }>;
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

	/** What a terminal was opened with: its working directory said as the kind it was given as, its icon by its id, and the run it is marked with. */
	function launchOf(config: IShellLaunchConfig) {
		const { name, executable, args, env, cwd, icon } = config;
		return { name, executable, args, env, cwd: URI.isUri(cwd) ? `uri ${cwd.path}` : cwd, icon: ThemeIcon.isThemeIcon(icon) ? icon.id : icon, run: facadeRunOf(config) };
	}

	setup(() => {
		steps = [];
		launched = [];
		runs = new Map();
		afterOpening = terminal => setTimeout(() => terminal.ready(4242));
		instantiationService = store.add(new TestInstantiationService());
		const keyOf = (run: IFacadeRun) => `${run.workspace}#${run.id}`;
		instantiationService.stub(IFacadeRunsService, upcastPartial<IFacadeRunsService>({
			whenRestored: Promise.resolve(),
			register: (instance, run) => {
				steps.push(`register ${instance.title} as ${keyOf(run)}`);
			},
			terminalOf: run => runs.get(keyOf(run))?.terminal?.asInstance(),
			processes: (workspace, ids) => (ids ?? []).map(id => ({ id, ...runs.get(keyOf({ workspace, id }))?.process ?? { state: 'gone' as const } }))
		}));
		instantiationService.stub(IWorktreeService, {
			makeWorktree: async (main, branch, options) => {
				steps.push(`make ${main.path} ${branch} ${options?.startPoint} ${options?.show}`);
				return URI.file(`/home/me/.facade/worktrees/lab/${branch}`);
			},
			removeWorktree: async worktree => {
				steps.push(`delete ${worktree.path}`);
				if (worktree.path === '/lab') {
					throw new Error('/lab is its repository\'s main checkout, which is never deleted.');
				}
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

	test('a worktree is deleted without asking, as the worktrees delete one, answered once it is gone; why it could not be is the rejection, and a folder that is no URI is refused', async () => {
		const deleted = await run('_facade.worktree.delete', URI.file('/home/me/.facade/worktrees/lab/clamp'));
		const mainCheckout = await failureOf('_facade.worktree.delete', URI.file('/lab'));
		const notAUri = await failureOf('_facade.worktree.delete', '/home/me/.facade/worktrees/lab/clamp');

		assert.deepStrictEqual({ deleted, mainCheckout, notAUri, steps }, {
			deleted: undefined,
			mainCheckout: '/lab is its repository\'s main checkout, which is never deleted.',
			notAUri: 'Unexpected type, expected \'URI\'',
			steps: ['delete /home/me/.facade/worktrees/lab/clamp', 'delete /lab'],
		});
	});

	test('a terminal is opened for its folder as it is described - an agent\'s drawn as its CLI, and marked with its run - and answered once its process is ready', async () => {
		const claude = await run('_facade.terminal.create', URI.file('/lab'), {
			name: '@main #1 · Claude Code',
			// npm's Claude Code, run as the Node script it runs
			executable: 'node.exe',
			args: ['/npm/claude-code/cli.js', '--model', 'haiku'],
			env: { FACADE_AGENTS_WAIT_MS: '120000', NO_COLOR: null },
			cwd: '/lab/src',
			agent: 'claude',
			run: { workspace: 'a1b2', id: 1 }
		});
		const antigravity = await run('_facade.terminal.create', URI.file('/lab'), { name: '@docs #2 · Antigravity', executable: 'agy', cwd: URI.file('/lab/docs'), agent: 'agy' });
		const noLogo = await run('_facade.terminal.create', URI.file('/lab'), { name: '@tidy #3 · Gemini', executable: 'gemini', agent: 'gemini' });
		// As the extension host gives what it leaves out
		const plain = await run('_facade.terminal.create', URI.file('/lab'), null);

		assert.deepStrictEqual({ answers: [claude, antigravity, noLogo, plain], launched: launched.map(launchOf), registered: steps.filter(step => step.startsWith('register')) }, {
			answers: Array(4).fill({ processId: 4242, closed: false, exitCode: undefined }),
			registered: ['register @main #1 · Claude Code as a1b2#1'],
			launched: [
				{ name: '@main #1 · Claude Code', executable: 'node.exe', args: ['/npm/claude-code/cli.js', '--model', 'haiku'], env: { FACADE_AGENTS_WAIT_MS: '120000', NO_COLOR: null }, cwd: '/lab/src', icon: 'agent-claude', run: { workspace: 'a1b2', id: 1 } },
				{ name: '@docs #2 · Antigravity', executable: 'agy', args: undefined, env: undefined, cwd: 'uri /lab/docs', icon: 'agent-antigravity', run: undefined },
				{ name: '@tidy #3 · Gemini', executable: 'gemini', args: undefined, env: undefined, cwd: 'uri /lab', icon: 'robot', run: undefined },
				{ name: undefined, executable: undefined, args: undefined, env: undefined, cwd: 'uri /lab', icon: undefined, run: undefined },
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
				{ run: 'a1b2#1' },
				// A run's number is an agent's: from 1 up
				{ run: { workspace: 'a1b2', id: 0 } },
			].map(options => failureOf('_facade.terminal.create', URI.file('/lab'), options))),
		];

		assert.deepStrictEqual({ failures, steps }, {
			failures: ['Unexpected type, expected \'URI\'', ...Array(11).fill('Unexpected type, expected \'IFacadeTerminalOptions\'')],
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

	test('a run\'s terminal is put in front, and answered with whether it is in front; one whose process runs in none is not', async () => {
		runs.set('a1b2#3', { terminal: new TestTerminal('@clamp #3 · Claude Code'), process: { state: 'present' } });

		const shown = await run('_facade.terminal.reveal', { workspace: 'a1b2', id: 3 });
		instantiationService.stub(IFolderTerminalsService, 'reveal', async (instance: ITerminalInstance) => {
			steps.push(`reveal ${instance.title}`);
			return false;
		});
		const notInFront = await run('_facade.terminal.reveal', { workspace: 'a1b2', id: 3 });
		const gone = await run('_facade.terminal.reveal', { workspace: 'a1b2', id: 4 });
		const notARun = await failureOf('_facade.terminal.reveal', 4242);

		assert.deepStrictEqual({ shown, notInFront, gone, notARun, steps }, {
			shown: true,
			notInFront: false,
			gone: false,
			notARun: 'Unexpected type, expected \'IFacadeRun\'',
			steps: ['reveal @clamp #3 · Claude Code', 'reveal @clamp #3 · Claude Code'],
		});
	});

	test('the window says what it knows of the processes of the runs it is asked of, in their order', async () => {
		runs.set('a1b2#1', { process: { state: 'present' } });
		runs.set('a1b2#2', { process: { state: 'gone', end: { exitCode: 1, byThePerson: false } } });
		runs.set('a1b2#3', { process: { state: 'unknown' } });

		const known = await run('_facade.terminal.processes', 'a1b2', [3, 1, 2]);
		const failures = [
			await failureOf('_facade.terminal.processes', 7),
			await failureOf('_facade.terminal.processes', 'a1b2', ['1']),
		];

		assert.deepStrictEqual({ known, failures }, {
			known: [{ id: 3, state: 'unknown' }, { id: 1, state: 'present' }, { id: 2, state: 'gone', end: { exitCode: 1, byThePerson: false } }],
			failures: ['Unexpected type, expected \'string\'', 'Unexpected type, expected \'number[]\''],
		});
	});

	test('a run\'s process is ended as closing its tab ends it, and answered once it is gone; one that is not gone a few seconds on, or that the window cannot find yet, is answered so; one gone already is gone', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const lead = new TestTerminal('@lead #1 · Claude Code');
		const stubborn = new TestTerminal('@stubborn #2 · Codex');
		stubborn.endsOnHangUp = false;
		runs.set('a1b2#1', { terminal: lead, process: { state: 'present' } });
		runs.set('a1b2#2', { terminal: stubborn, process: { state: 'present' } });
		runs.set('a1b2#3', { process: { state: 'unknown' } });

		const stopped = await run('_facade.terminal.stop', { workspace: 'a1b2', id: 1 });
		const started = Date.now();
		const notYet = await run('_facade.terminal.stop', { workspace: 'a1b2', id: 2 });
		const waited = Date.now() - started;
		const unknown = await run('_facade.terminal.stop', { workspace: 'a1b2', id: 3 });
		const goneAlready = await run('_facade.terminal.stop', { workspace: 'a1b2', id: 4 });

		// Windows has no signals: there the terminal is closed
		assert.deepStrictEqual({ stopped, notYet, waited, unknown, goneAlready, lead: lead.done, stubborn: stubborn.done }, {
			stopped: true,
			notYet: isWindows,
			waited: isWindows ? 0 : 5000,
			unknown: false,
			goneAlready: true,
			lead: isWindows ? ['dispose'] : ['signal SIGHUP'],
			stubborn: isWindows ? ['dispose'] : ['signal SIGHUP'],
		});
	}));

	test('text is typed into a run\'s terminal as it is, and answered once it is passed on; into none where its process runs in none', async () => {
		const lead = new TestTerminal('@lead #1 · Antigravity');
		runs.set('a1b2#1', { terminal: lead, process: { state: 'present' } });

		const typed = [
			await run('_facade.terminal.type', { workspace: 'a1b2', id: 1 }, '[facade] Your task is in /runs/1.task.md'),
			await run('_facade.terminal.type', { workspace: 'a1b2', id: 1 }, '\r'),
			await run('_facade.terminal.type', { workspace: 'a1b2', id: 2 }, 'nobody'),
		];
		const notText = await failureOf('_facade.terminal.type', { workspace: 'a1b2', id: 1 }, 42);

		assert.deepStrictEqual({ typed, notText, done: lead.done }, {
			typed: [true, true, false],
			notText: 'Unexpected type, expected \'string\'',
			done: ['type "[facade] Your task is in /runs/1.task.md"', 'type "\\r"'],
		});
	});

	test('the environment a terminal opened in a folder gets is the window\'s, with the person\'s setting over it - its variables resolved - and what extensions add', async () => {
		const platformKey = isWindows ? 'windows' : isMacintosh ? 'osx' : 'linux';
		const lab: IWorkspaceFolder = upcastPartial<IWorkspaceFolder>({ uri: URI.file('/lab'), name: 'lab', index: 0 });
		instantiationService.stub(ITerminalProfileResolverService, { getEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/me', VSCODE_IPC_HOOK: 'gone' }) });
		instantiationService.stub(ITerminalInstanceService, { getBackend: async () => upcastPartial<ITerminalBackend>({ getShellEnvironment: async () => ({ SHELL_ONLY: '/opt/shell' }) }) });
		instantiationService.stub(IConfigurationService, new TestConfigurationService({ terminal: { integrated: { env: { [platformKey]: { CLAUDE_CONFIG_DIR: '${env:SHELL_ONLY}/claude', HOME: null } } } } }));
		instantiationService.stub(IConfigurationResolverService, {
			resolveWithEnvironment: async (env: IProcessEnvironment, folder: IWorkspaceFolder | undefined, value: string) => value.replace(/\$\{env:(?<name>[^}]+)\}/g, (_, name: string) => env[name] ?? '')
		});
		instantiationService.stub(IEnvironmentVariableService, {
			mergedCollection: upcastPartial<IMergedEnvironmentVariableCollection>({
				applyToProcessEnvironment: async (env: IProcessEnvironment, scope: { workspaceFolder?: IWorkspaceFolder } | undefined) => {
					env.GIT_ASKPASS = `/askpass for ${scope?.workspaceFolder?.name}`;
				}
			})
		});
		instantiationService.stub(IWorkspaceContextService, { getWorkspaceFolder: () => lab });
		instantiationService.stub(IActiveFolderService, { activeFolder: undefined });
		instantiationService.stub(IProductService, { version: '1.138.0' });
		instantiationService.stub(ITerminalConfigurationService, { config: upcastPartial<ITerminalConfiguration>({ detectLocale: 'off' }) });

		const env = await run('_facade.terminal.environment', URI.file('/lab/src'));
		const notAFolder = await failureOf('_facade.terminal.environment', '/lab');

		assert.deepStrictEqual({ env, notAFolder }, {
			env: {
				PATH: '/usr/bin',
				CLAUDE_CONFIG_DIR: '/opt/shell/claude',
				TERM_PROGRAM: 'vscode',
				TERM_PROGRAM_VERSION: '1.138.0',
				COLORTERM: 'truecolor',
				GIT_ASKPASS: '/askpass for lab',
			},
			notAFolder: 'Unexpected type, expected \'URI\'',
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

	test('the window says once it has its terminals back, as the runs know it', async () => {
		const restored = new DeferredPromise<void>();
		instantiationService.stub(IFacadeRunsService, upcastPartial<IFacadeRunsService>({ whenRestored: restored.p }));
		let back = false;
		const waiting = run('_facade.terminal.whenRestored').then(() => back = true);
		await timeout(0);
		const atFirst = back;
		restored.complete();
		await waiting;

		assert.deepStrictEqual({ atFirst, back }, { atFirst: false, back: true });
	});
});
