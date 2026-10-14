/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IAction } from '../../../../../base/common/actions.js';
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
import { INotification, INotificationHandle, INotificationService, NotificationPriority, Severity } from '../../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IMergedEnvironmentVariableCollection } from '../../../../../platform/terminal/common/environmentVariable.js';
import { IShellLaunchConfig, ITerminalBackend } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { extUri } from '../../../../../base/common/resources.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ILifecycleService, StartupKind } from '../../../../services/lifecycle/common/lifecycle.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalConfigurationService, ITerminalContribution, ITerminalInstance, ITerminalInstanceService } from '../../../terminal/browser/terminal.js';
import { IEnvironmentVariableService } from '../../../terminal/common/environmentVariable.js';
import { ITerminalConfiguration, ITerminalProfileResolverService } from '../../../terminal/common/terminal.js';
import { IMadeWorktree, IWorktreeService } from '../../../worktrees/browser/worktrees.js';
import { FacadeAgentTerminal, IAgentKeysOptions, IAgentTerminalOptions, IAgentTypeOptions } from '../../browser/facadeAgentTerminal.js';
import '../../browser/facadeCommands.contribution.js';
import { FacadeNotifications } from '../../browser/facadeNotifications.js';
import { FacadeRunProcess, IFacadeRunsService } from '../../browser/facadeRuns.js';
import { facadeRunOf, facadeRunProperties, IFacadeRun, IPreparingRun } from '../../common/facadeRun.js';

/** A terminal as the folder terminals open one: made before its process is started, its id known once that is ready. */
class TestTerminal {

	private readonly _onDisposed = new Emitter<ITerminalInstance>();
	readonly onDisposed = this._onDisposed.event;

	private readonly _onExit = new Emitter<number | undefined>();
	readonly onExit = this._onExit.event;

	/**
	 * What the commands did to it: the signals it was sent, what was typed into it, and its closing - and what they asked
	 * of its Facade contribution, where a test keeps that here too.
	 */
	readonly done: string[] = [];

	/** Whether its process ends on a hang-up, as a CLI does. */
	endsOnHangUp = true;

	private readonly _ready = new DeferredPromise<void>();
	private _processId: number | undefined;

	isDisposed = false;
	exitCode: number | undefined;
	/** Whether it has the person's focus. */
	hasFocus = false;
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

	async sendSignal(signal: string): Promise<void> {
		this.done.push(`signal ${signal}`);
		// A kill no process can ignore
		if ((signal === 'SIGHUP' && this.endsOnHangUp) || signal === 'SIGKILL') {
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

	/** The Facade contribution of the terminal titled `title`, its calls kept in `log`: in `steps`, unless said. */
	function agentTerminal(title: string | undefined, exited = false, log = steps): FacadeAgentTerminal {
		return upcastPartial<FacadeAgentTerminal>({
			isAgent: true,
			exited,
			register: (options: IAgentTerminalOptions) => log.push(`register ${title} as ${options.run.workspace}#${options.run.id}, its final screen in ${options.finalScreen.path}`),
			read: async (lines: number) => {
				log.push(`read ${lines} of ${title}`);
				return { lines: ['> hi'], buffer: 'normal', older: false, trimmed: false, capturedAt: 1, lastOutput: undefined };
			},
			type: async (text: string, options: IAgentTypeOptions) => {
				log.push(`type ${JSON.stringify(text)} into ${title} ${JSON.stringify(options)}`);
				return { outcome: 'applied', pasted: true, entered: true };
			},
			keys: async (keys: readonly string[], options: IAgentKeysOptions) => {
				log.push(`press ${keys.join(' ')} in ${title} ${JSON.stringify(options)}`);
				return { outcome: 'applied', keysSent: keys.length };
			},
			inputState: () => ({ pending: true, lastKey: 7, busy: true }),
			closeInput: () => log.push(`close the input of ${title}`)
		});
	}

	/** What a terminal was opened with: its working directory said as the kind it was given as, its icon by its id, and the run it is marked with. */
	function launchOf(config: IShellLaunchConfig) {
		const { name, executable, args, env, cwd, icon, useShellEnvironment } = config;
		return { name, executable, args, env, cwd: URI.isUri(cwd) ? `uri ${cwd.path}` : cwd, icon: ThemeIcon.isThemeIcon(icon) ? icon.id : icon, run: facadeRunOf(config), useShellEnvironment };
	}

	setup(() => {
		steps = [];
		launched = [];
		runs = new Map();
		afterOpening = terminal => setTimeout(() => terminal.ready(4242));
		instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IActiveFolderService, { activeFolder: undefined });
		instantiationService.stub(IUriIdentityService, upcastPartial<IUriIdentityService>({ extUri }));
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
				return { worktree: URI.file(`/home/me/.facade/worktrees/lab/${branch}`), copyFailures: [] };
			},
			setupState: worktree => worktree.path === '/home/me/.facade/worktrees/lab/clamp' ? { running: 'npm ci', lines: ['added 4 packages', 'npm warn deprecated left-pad@1.3.0'] } : undefined,
			removeWorktree: async (worktree, options) => {
				steps.push(`delete ${worktree.path}${options ? ` ${JSON.stringify({ ...options, main: options.main?.path })}` : ''}`);
				if (worktree.path === '/lab') {
					throw new Error('/lab is its repository\'s main checkout, which is never deleted.');
				}
			},
			removalLoss: async (worktree, options) => {
				steps.push(`look at ${worktree.path}${options ? ` ${JSON.stringify({ ...options, main: options.main?.path })}` : ''}`);
				return worktree.path === '/home/me/.facade/worktrees/lab/clamp' ? ['build/out.js', 'logo.png (unsaved)'] : [];
			},
			terminalsInside: async worktree => worktree.path === '/home/me/.facade/worktrees/lab/clamp' ? [
				upcastPartial<ITerminalInstance>({ reconnectionProperties: facadeRunProperties({ workspace: 'a1b2', id: 2 }), exitCode: undefined }),
				upcastPartial<ITerminalInstance>({ reconnectionProperties: facadeRunProperties({ workspace: 'a1b2', id: 1 }), exitCode: 0 }),
				upcastPartial<ITerminalInstance>({ reconnectionProperties: facadeRunProperties({ workspace: 'c3d4', id: 5 }), exitCode: undefined }),
				upcastPartial<ITerminalInstance>({ exitCode: undefined }),
			] : [],
			otherWindowsAgentsIn: async worktree => worktree.path === '/home/me/.facade/worktrees/lab/clamp' ? ['@there #a7'] : []
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

	test('a worktree is made from the commit it is given, or HEAD, and answered with its folder and what could not be copied into it', async () => {
		const made = await run('_facade.worktree.create', URI.file('/lab'), 'clamp', 'a'.repeat(40), false) as IMadeWorktree;
		// As the extension host gives what it leaves out
		const fromHead = await run('_facade.worktree.create', URI.file('/lab'), 'tidy', null, null) as IMadeWorktree;

		assert.deepStrictEqual({ made: { ...made, worktree: made.worktree.path }, fromHead: fromHead.worktree.path, steps }, {
			made: { worktree: '/home/me/.facade/worktrees/lab/clamp', copyFailures: [] },
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

	test('the setup of a worktree made for an agent is answered as it stands now - the line running and the last lines of its terminal - for the start waiting on it; nothing where the window knows no setup, and a folder that is no URI is refused (O3; OR-03)', async () => {
		const running = await run('_facade.worktree.setupState', URI.file('/home/me/.facade/worktrees/lab/clamp'));
		const none = await run('_facade.worktree.setupState', URI.file('/home/me/.facade/worktrees/lab/tidy'));
		const notAUri = await failureOf('_facade.worktree.setupState', '/home/me/.facade/worktrees/lab/clamp');

		assert.deepStrictEqual({ running, none, notAUri }, {
			running: { running: 'npm ci', lines: ['added 4 packages', 'npm warn deprecated left-pad@1.3.0'] },
			none: undefined,
			notAUri: 'Unexpected type, expected \'URI\'',
		});
	});

	test('a worktree is deleted without asking, as the worktrees delete one, answered once it is gone, told what the caller knows of it - its own files by hash, its main checkout, the runs stopped in it; why it could not be is the rejection, and a folder that is no URI, or options of another shape, are refused', async () => {
		const clamp = URI.file('/home/me/.facade/worktrees/lab/clamp');
		const deleted = await run('_facade.worktree.delete', clamp);
		const told = await run('_facade.worktree.delete', clamp, { discardChanges: false, ownFiles: [{ path: '.mcp.json', sha256: 'ab'.repeat(32) }], main: URI.file('/lab'), runs: [{ workspace: 'a1b2', id: 2 }] });
		const mainCheckout = await failureOf('_facade.worktree.delete', URI.file('/lab'));
		const notAUri = await failureOf('_facade.worktree.delete', '/home/me/.facade/worktrees/lab/clamp');
		const wrongOptions = [
			await failureOf('_facade.worktree.delete', clamp, { ownFiles: ['.mcp.json'] }),
			await failureOf('_facade.worktree.delete', clamp, { main: '/lab' }),
			await failureOf('_facade.worktree.delete', clamp, { runs: [{ workspace: 'a1b2', id: 0 }] }),
		];

		assert.deepStrictEqual({ deleted, told, mainCheckout, notAUri, wrongOptions, steps }, {
			deleted: undefined,
			told: undefined,
			mainCheckout: '/lab is its repository\'s main checkout, which is never deleted.',
			notAUri: 'Unexpected type, expected \'URI\'',
			wrongOptions: Array(3).fill('Unexpected type, expected \'IRemoveWorktreeOptions\''),
			steps: [
				'delete /home/me/.facade/worktrees/lab/clamp',
				`delete /home/me/.facade/worktrees/lab/clamp {"discardChanges":false,"ownFiles":[{"path":".mcp.json","sha256":"${'ab'.repeat(32)}"}],"main":"/lab","runs":[{"workspace":"a1b2","id":2}]}`,
				'delete /lab',
			],
		});
	});

	test('what deleting a worktree would lose is looked at - for an agent\'s deletion, before any agent is stopped - and answered as the worktrees name it, the options it is deleted with applied; nothing is deleted, and options of another kind are refused (O5; OR-04)', async () => {
		const clamp = URI.file('/home/me/.facade/worktrees/lab/clamp');
		const loss = await run('_facade.worktree.removalLoss', clamp, { ownFiles: [{ path: '.mcp.json', sha256: 'ab'.repeat(32) }], main: URI.file('/lab'), runs: [{ workspace: 'a1b2', id: 2 }] });
		const nothing = await run('_facade.worktree.removalLoss', URI.file('/home/me/.facade/worktrees/lab/tidy'));
		const notABoolean = await failureOf('_facade.worktree.removalLoss', clamp, { discardChanges: 'yes' });

		assert.deepStrictEqual({ loss, nothing, notABoolean, steps }, {
			loss: ['build/out.js', 'logo.png (unsaved)'],
			nothing: [],
			notABoolean: 'Unexpected type, expected \'IRemoveWorktreeOptions\'',
			steps: [
				`look at /home/me/.facade/worktrees/lab/clamp {"ownFiles":[{"path":".mcp.json","sha256":"${'ab'.repeat(32)}"}],"main":"/lab","runs":[{"workspace":"a1b2","id":2}]}`,
				'look at /home/me/.facade/worktrees/lab/tidy',
			],
		});
	});

	test('the runs working inside a folder are those of its terminals whose processes run - an agent\'s of any record; neither one that has ended nor a terminal of nobody\'s run (X-74)', async () => {
		const inside = await run('_facade.terminal.inside', URI.file('/home/me/.facade/worktrees/lab/clamp'));
		const none = await run('_facade.terminal.inside', URI.file('/elsewhere'));
		const notAUri = await failureOf('_facade.terminal.inside', '/elsewhere');

		assert.deepStrictEqual({ inside, none, notAUri }, {
			inside: [{ workspace: 'a1b2', id: 2 }, { workspace: 'c3d4', id: 5 }],
			none: [],
			notAUri: 'Unexpected type, expected \'URI\'',
		});
	});

	test('another window\'s agents working inside a folder are named by their terminals\' titles, for an agent\'s deletion to refuse before it stops anything (N-53)', async () => {
		const elsewhere = await run('_facade.terminal.elsewhere', URI.file('/home/me/.facade/worktrees/lab/clamp'));
		const none = await run('_facade.terminal.elsewhere', URI.file('/elsewhere'));
		const notAUri = await failureOf('_facade.terminal.elsewhere', '/elsewhere');

		assert.deepStrictEqual({ elsewhere, none, notAUri }, {
			elsewhere: ['@there #a7'],
			none: [],
			notAUri: 'Unexpected type, expected \'URI\'',
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
				{ name: '@main #1 · Claude Code', executable: 'node.exe', args: ['/npm/claude-code/cli.js', '--model', 'haiku'], env: { FACADE_AGENTS_WAIT_MS: '120000', NO_COLOR: null }, cwd: '/lab/src', icon: 'agent-claude', run: { workspace: 'a1b2', id: 1 }, useShellEnvironment: true },
				{ name: '@docs #2 · Antigravity', executable: 'agy', args: undefined, env: undefined, cwd: 'uri /lab/docs', icon: 'agent-antigravity', run: undefined, useShellEnvironment: true },
				{ name: '@tidy #3 · Gemini', executable: 'gemini', args: undefined, env: undefined, cwd: 'uri /lab', icon: 'robot', run: undefined, useShellEnvironment: true },
				{ name: undefined, executable: undefined, args: undefined, env: undefined, cwd: 'uri /lab', icon: undefined, run: undefined, useShellEnvironment: true },
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

	test('the person\'s start is put in front only where they still are: moved on to another folder while it was made, the window stays there, and the terminal is held for its own (PS-15; C-WB-15; X-34)', async () => {
		instantiationService.stub(IActiveFolderService, { activeFolder: upcastPartial<IWorkspaceFolder>({ uri: URI.file('/lab') }) });
		await run('_facade.terminal.create', URI.file('/lab'), { name: 'here', reveal: true });
		instantiationService.stub(IActiveFolderService, { activeFolder: upcastPartial<IWorkspaceFolder>({ uri: URI.file('/other') }) });
		await run('_facade.terminal.create', URI.file('/lab'), { name: 'moved on', reveal: true });

		assert.deepStrictEqual(steps.filter(step => step.startsWith('reveal')), ['reveal here']);
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

	test('the window keeps the runs the agents\' extension says are live in its record - those with no terminal yet, their worktrees being made or set up, among them - for the agent button; runs of another kind, or a preparing run of another shape, are refused and nothing is kept (X-51; L3)', async () => {
		instantiationService.stub(IFacadeRunsService, 'setLive', (workspace: string, ids: readonly number[], preparing: readonly IPreparingRun[]) => {
			steps.push(`live in ${workspace}: ${ids.join(', ')}, preparing ${JSON.stringify(preparing)}`);
		});
		const making = { id: 3, name: 'lint', phase: 'creating_worktree' };
		await run('_facade.agents.live', 'a1b2', [1, 3, 4], [making, { id: 4, name: 'docs', phase: 'running_setup', folder: '/w/docs' }]);
		// As the extension host gives what it leaves out
		await run('_facade.agents.live', 'a1b2', [1], null);
		const failures = [
			await failureOf('_facade.agents.live', 7, [1]),
			await failureOf('_facade.agents.live', 'a1b2', ['1']),
			await failureOf('_facade.agents.live', 'a1b2', [3], making),
			await failureOf('_facade.agents.live', 'a1b2', [3], [{ ...making, phase: 'starting' }]),
			await failureOf('_facade.agents.live', 'a1b2', [3], [{ ...making, id: 0 }]),
			await failureOf('_facade.agents.live', 'a1b2', [3], [{ ...making, folder: 42 }]),
		];

		assert.deepStrictEqual({ steps, failures }, {
			steps: [
				'live in a1b2: 1, 3, 4, preparing [{"id":3,"name":"lint","phase":"creating_worktree"},{"id":4,"name":"docs","phase":"running_setup","folder":"/w/docs"}]',
				'live in a1b2: 1, preparing []',
			],
			failures: ['Unexpected type, expected \'string\'', 'Unexpected type, expected \'number[]\'', ...Array(4).fill('Unexpected type, expected \'IPreparingRun[]\'')],
		});
	});

	test('a run\'s process is ended as closing its tab ends it - its agent\'s input closed first, so that nothing goes into the stopping CLI (D3) - and answered once it is gone, with how it exited; one that is not gone a few seconds on, or that the window cannot find yet, is answered so; one gone already is gone', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const lead = new TestTerminal('@lead #1 · Claude Code');
		lead.agent = agentTerminal(lead.title, false, lead.done);
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
		// A stop that outlived its time escalates (X-22)
		const killed = await run('_facade.terminal.stop', { workspace: 'a1b2', id: 2 }, 'SIGKILL');
		const notASignal = await failureOf('_facade.terminal.stop', { workspace: 'a1b2', id: 2 }, 'SIGUSR1');

		// Windows has no signals: there the terminal is closed
		assert.deepStrictEqual({ stopped, notYet, waited, unknown, goneAlready, killed, notASignal, lead: lead.done, stubborn: stubborn.done }, {
			stopped: isWindows ? {} : { exitCode: 129 },
			notYet: isWindows ? {} : false,
			waited: isWindows ? 0 : 5000,
			unknown: false,
			goneAlready: {},
			killed: isWindows ? {} : { exitCode: 129 },
			notASignal: 'Unexpected type, expected \'SIGHUP | SIGTERM | SIGKILL\'',
			lead: isWindows ? ['close the input of @lead #1 · Claude Code', 'dispose'] : ['close the input of @lead #1 · Claude Code', 'signal SIGHUP'],
			stubborn: isWindows ? ['dispose', 'dispose'] : ['signal SIGHUP', 'signal SIGKILL'],
		});
	}));

	test('the environment a terminal opened in a folder gets is the window\'s resolved shell environment where terminals inherit it - the PATH a login shell sets, not the one the Dock gave the window - with the person\'s setting over it, its variables resolved, and what extensions add', async () => {
		const platformKey = isWindows ? 'windows' : isMacintosh ? 'osx' : 'linux';
		const lab: IWorkspaceFolder = upcastPartial<IWorkspaceFolder>({ uri: URI.file('/lab'), name: 'lab', index: 0 });
		// Started from the Dock: the window's own PATH is launchd's; the login shell's has the person's CLIs
		instantiationService.stub(ITerminalProfileResolverService, { getEnvironment: async () => ({ PATH: '/usr/bin:/bin', HOME: '/home/me', VSCODE_IPC_HOOK: 'gone' }) });
		instantiationService.stub(ITerminalInstanceService, { getBackend: async () => upcastPartial<ITerminalBackend>({ getShellEnvironment: async () => ({ PATH: '/home/me/.local/bin:/usr/bin:/bin', HOME: '/home/me', SHELL_ONLY: '/opt/shell' }) }) });
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
		const environmentWith = async (inheritEnv: boolean | undefined) => {
			instantiationService.stub(IConfigurationService, new TestConfigurationService({ terminal: { integrated: { inheritEnv, env: { [platformKey]: { CLAUDE_CONFIG_DIR: '${env:SHELL_ONLY}/claude', HOME: null } } } } }));
			return run('_facade.terminal.environment', URI.file('/lab/src'));
		};

		const inherited = await environmentWith(undefined);
		const notInherited = await environmentWith(false);
		const notAFolder = await failureOf('_facade.terminal.environment', '/lab');

		assert.deepStrictEqual({ inherited, notInherited, notAFolder }, {
			inherited: {
				PATH: '/home/me/.local/bin:/usr/bin:/bin',
				SHELL_ONLY: '/opt/shell',
				CLAUDE_CONFIG_DIR: '/opt/shell/claude',
				TERM_PROGRAM: 'vscode',
				TERM_PROGRAM_VERSION: '1.138.0',
				COLORTERM: 'truecolor',
				GIT_ASKPASS: '/askpass for lab',
			},
			notInherited: {
				PATH: '/usr/bin:/bin',
				CLAUDE_CONFIG_DIR: '/opt/shell/claude',
				TERM_PROGRAM: 'vscode',
				TERM_PROGRAM_VERSION: '1.138.0',
				COLORTERM: 'truecolor',
				GIT_ASKPASS: '/askpass for lab',
			},
			notAFolder: 'Unexpected type, expected \'URI\'',
		});
	});

	test('an agent\'s terminal starts from the shell environment only where terminals inherit it', async () => {
		instantiationService.stub(IConfigurationService, new TestConfigurationService({ terminal: { integrated: { inheritEnv: false } } }));

		await run('_facade.terminal.create', URI.file('/lab'), { name: '@main #1 · Claude Code', executable: 'claude', agent: 'claude' });

		assert.deepStrictEqual(launched.map(config => config.useShellEnvironment), [false]);
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

	test('the window keeps the record the extension says it has, and says it with how it was loaded - for an extension host that starts again under the same window; a record of the wrong kind is refused', async () => {
		instantiationService.stub(ILifecycleService, { startupKind: StartupKind.NewWindow });
		await run('_facade.window.record', { id: '7d65559d-36cd-4b61-8887-32334d9ad05d', owner: '444791c6003abc32' });
		const kept = await run('_facade.window.loaded') as { record?: unknown };
		const refused = await Promise.all([
			failureOf('_facade.window.record', { id: '', owner: 'x' }),
			failureOf('_facade.window.record', { id: 'x' }),
			failureOf('_facade.window.record', 'x'),
		]);
		const stillKept = await run('_facade.window.loaded') as { record?: unknown };

		assert.deepStrictEqual({ kept: kept.record, refused, stillKept: stillKept.record }, {
			kept: { id: '7d65559d-36cd-4b61-8887-32334d9ad05d', owner: '444791c6003abc32' },
			refused: Array(3).fill('Unexpected type, expected \'IFacadeWindowRecord\''),
			stillKept: { id: '7d65559d-36cd-4b61-8887-32334d9ad05d', owner: '444791c6003abc32' },
		});
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

	test('a notification Facade keeps by its key is shown - as news, or as the warning or error it says it is - and the next with that key takes its place as a new one, so that it is shown as the first was; the call answers with the button pressed, or nothing once it closed (AGENT-MESSAGES.md, M11)', async () => {
		instantiationService.stub(IHostService, { hasFocus: true });
		const { shown } = notifications();
		const first = run('_facade.notification.show', 'message:3', '@lint #a3 has something for you: one.', ['Show']);
		const second = run('_facade.notification.show', 'message:3', '@lint #a3 has something for you: two.', ['Show', 'Later'], null, 'warning');
		const other = run('_facade.notification.show', 'message:4', '@docs #a4 ended with an error.', ['Show'], null, 'error');
		press(shown[1], 'Later');
		shown[2].handle.close();

		assert.deepStrictEqual({
			answers: [await first, await second, await other],
			shown: shown.map(({ notification, closed }) => ({ message: notification.message, severity: notification.severity, buttons: notification.actions?.primary?.map(action => action.label), source: notification.source, closed }))
		}, {
			answers: [undefined, 'Later', undefined],
			shown: [
				{ message: '@lint #a3 has something for you: one.', severity: Severity.Info, buttons: ['Show'], source: 'Facade Agents', closed: true },
				{ message: '@lint #a3 has something for you: two.', severity: Severity.Warning, buttons: ['Show', 'Later'], source: 'Facade Agents', closed: true },
				{ message: '@docs #a4 ended with an error.', severity: Severity.Error, buttons: ['Show'], source: 'Facade Agents', closed: true }
			]
		});
	});

	test('a notification from an agent whose terminal has the person\'s focus, the window\'s too, goes quietly into the notification center (M9)', async () => {
		const { shown } = notifications();
		const lint = new TestTerminal('@lint #a3');
		lint.hasFocus = true;
		runs.set('a1b2#3', { terminal: lint, process: { state: 'present' } });
		instantiationService.stub(IHostService, { hasFocus: true });
		void run('_facade.notification.show', 'message:3', 'One.', ['Show'], { workspace: 'a1b2', id: 3 });
		lint.hasFocus = false;
		void run('_facade.notification.show', 'message:3', 'Two.', ['Show'], { workspace: 'a1b2', id: 3 });
		lint.hasFocus = true;
		instantiationService.stub(IHostService, { hasFocus: false });
		void run('_facade.notification.show', 'message:3', 'Three.', ['Show'], { workspace: 'a1b2', id: 3 });
		instantiationService.stub(IHostService, { hasFocus: true });
		void run('_facade.notification.show', 'message:5', 'Elsewhere.', ['Show'], { workspace: 'a1b2', id: 5 });

		assert.deepStrictEqual(shown.map(({ notification }) => `${notification.message} ${notification.priority === NotificationPriority.SILENT ? 'quiet' : 'aloud'}`), ['One. quiet', 'Two. aloud', 'Three. aloud', 'Elsewhere. aloud']);
	});

	test('a notification Facade keeps by its key is closed by that key - from the notification center too - its call answering with nothing pressed; a key with none up, or one whose notification closed, closes nothing (AGENT-LAUNCHER.md, L5; AGENT-MESSAGES.md, M11)', async () => {
		instantiationService.stub(IHostService, { hasFocus: true });
		const { shown } = notifications();
		const warning = run('_facade.notification.show', 'message:facade:3', '@late #a3 is open, but has not connected to Facade.', ['Show'], null, 'warning');
		const other = run('_facade.notification.show', 'message:4', '@docs #a4 has something for you: done.', ['Show']);
		await run('_facade.notification.close', 'message:facade:3');
		await run('_facade.notification.close', 'message:facade:3');
		await run('_facade.notification.close', 'message:facade:9');
		const failure = await failureOf('_facade.notification.close', 3);

		assert.deepStrictEqual({ answer: await warning, failure, closed: shown.map(({ notification, closed }) => `${notification.message} ${closed ? 'closed' : 'up'}`) }, {
			answer: undefined,
			failure: 'Unexpected type, expected \'string\'',
			closed: ['@late #a3 is open, but has not connected to Facade. closed', '@docs #a4 has something for you: done. up']
		});
		shown[1].handle.close();
		await other;
	});

	test('a notification is refused a key, a message, buttons, a run or a severity of the wrong kind, and none is shown', async () => {
		const { shown } = notifications();
		const failures = [
			await failureOf('_facade.notification.show', 42, 'text', []),
			await failureOf('_facade.notification.show', 'key', undefined, []),
			await failureOf('_facade.notification.show', 'key', 'text', ['Show', 2]),
			await failureOf('_facade.notification.show', 'key', 'text', ['Show'], 41),
			await failureOf('_facade.notification.show', 'key', 'text', ['Show'], null, 'fatal')
		];

		assert.deepStrictEqual({ failures, shown: shown.length }, {
			failures: ['Unexpected type, expected \'string\'', 'Unexpected type, expected \'string\'', 'Unexpected type, expected \'string[]\'', 'Unexpected type, expected \'IFacadeRun\'', 'Unexpected type, expected \'\'information\' | \'warning\' | \'error\'\''],
			shown: 0
		});
	});

	test('a terminal opened for an agent\'s run is registered as its terminal, its final screen going to its file (AGENT-DEBUGGING.md, D6)', async () => {
		await run('_facade.terminal.create', URI.file('/lab'), { name: '@lint #a3', executable: 'codex', agent: 'codex', run: { workspace: 'a1b2', id: 3 }, finalScreen: URI.file('/rec/screens/a3.json') });
		await run('_facade.terminal.create', URI.file('/lab'), { name: 'a shell' });
		const failure = await failureOf('_facade.terminal.create', URI.file('/lab'), { finalScreen: '/rec/screens/a3.json' });

		assert.deepStrictEqual({ failure, steps }, {
			failure: 'Unexpected type, expected \'IFacadeTerminalOptions\'',
			steps: ['open for /lab: @lint #a3', 'register @lint #a3 as a1b2#3', 'register @lint #a3 as a1b2#3, its final screen in /rec/screens/a3.json', 'open for /lab: a shell'],
		});
	});

	test('the terminal a run\'s own process runs in is read, typed into - a doorbell as input that needs the agent framework (M10) - pressed keys in, registered and asked what holds Facade\'s input back, by its run; none where it runs in none (D2-D5, D8)', async () => {
		const lint = new TestTerminal('@lint #a3');
		lint.agent = agentTerminal('@lint #a3');
		const gone = new TestTerminal('@gone #a5');
		gone.agent = agentTerminal('@gone #a5', true);
		runs.set('a1b2#3', { terminal: lint, process: { state: 'present' } });
		runs.set('a1b2#5', { terminal: gone, process: { state: 'present' } });
		const three = { workspace: 'a1b2', id: 3 };
		const none = { workspace: 'a1b2', id: 9 };

		const answers = {
			read: await run('_facade.terminal.read', three, 20),
			readEnded: await run('_facade.terminal.read', { workspace: 'a1b2', id: 5 }, 50),
			readNone: await run('_facade.terminal.read', none, 5),
			typed: await run('_facade.terminal.type', three, 'yes', { enter: true, enterDelayMs: 250.4, queueTimeoutMs: 120000 }),
			rung: await run('_facade.terminal.type', three, '[facade] 1 unread message', { enter: true, requiresFramework: true }),
			typedNone: await run('_facade.terminal.type', none, 'yes', { enter: true }),
			pressed: await run('_facade.terminal.keys', three, ['Down', 'Enter', 'y'], { queueTimeoutMs: null }),
			pressedNone: await run('_facade.terminal.keys', none, ['Enter'], {}),
			registered: await run('_facade.terminal.register', three, URI.file('/rec/screens/a3.json')),
			registeredNone: await run('_facade.terminal.register', none, URI.file('/rec/screens/a9.json')),
			input: await run('_facade.terminal.input', three),
			inputNone: await run('_facade.terminal.input', none),
		};
		const failures = [
			await failureOf('_facade.terminal.read', three, 0),
			await failureOf('_facade.terminal.read', three, 2001),
			await failureOf('_facade.terminal.read', 4242, 5),
			await failureOf('_facade.terminal.type', three, 42, {}),
			await failureOf('_facade.terminal.type', three, 'yes', { enterDelayMs: -1 }),
			await failureOf('_facade.terminal.type', three, 'yes', { requiresFramework: 'yes' }),
			await failureOf('_facade.terminal.keys', three, [], {}),
			await failureOf('_facade.terminal.keys', three, ['F1'], {}),
			await failureOf('_facade.terminal.keys', three, ['Enter'], { queueTimeoutMs: Number.POSITIVE_INFINITY }),
			await failureOf('_facade.terminal.register', three, '/rec/screens/a3.json'),
			await failureOf('_facade.terminal.input', '4242'),
		];

		assert.deepStrictEqual({ answers, failures, steps }, {
			answers: {
				read: { lines: ['> hi'], buffer: 'normal', older: false, trimmed: false, capturedAt: 1, lastOutput: undefined, exited: false },
				readEnded: { lines: ['> hi'], buffer: 'normal', older: false, trimmed: false, capturedAt: 1, lastOutput: undefined, exited: true },
				readNone: undefined,
				typed: { outcome: 'applied', pasted: true, entered: true },
				rung: { outcome: 'applied', pasted: true, entered: true },
				typedNone: undefined,
				pressed: { outcome: 'applied', keysSent: 3 },
				pressedNone: undefined,
				registered: true,
				registeredNone: false,
				input: { pending: true, lastKey: 7, busy: true },
				inputNone: undefined,
			},
			failures: [
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'IFacadeRun\'',
				'Unexpected type, expected \'string\'',
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'boolean\'',
				'Unexpected type, expected \'string[]\'',
				'Unexpected type, expected \'string[]\'',
				'Unexpected type, expected \'number\'',
				'Unexpected type, expected \'URI\'',
				'Unexpected type, expected \'IFacadeRun\'',
			],
			steps: [
				'read 20 of @lint #a3',
				'read 50 of @gone #a5',
				'type "yes" into @lint #a3 {"enter":true,"enterDelayMs":250,"queueTimeoutMs":120000,"requiresFramework":false}',
				'type "[facade] 1 unread message" into @lint #a3 {"enter":true,"enterDelayMs":0,"requiresFramework":true}',
				'press Down Enter y in @lint #a3 {}',
				'register @lint #a3 as a1b2#3, its final screen in /rec/screens/a3.json',
			],
		});
	});

});
