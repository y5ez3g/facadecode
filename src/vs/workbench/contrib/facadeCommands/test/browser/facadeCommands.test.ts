/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';
import { ITerminalLauncherService } from '../../../terminalLaunchers/browser/terminalLauncherService.js';
import { AGENT_TERMINAL_ICON } from '../../../terminalLaunchers/common/terminalLaunchers.js';
import { IWorktreeService } from '../../../worktrees/browser/worktrees.js';
import { TerminalInputTracker } from '../../browser/facadeTerminals.js';
import '../../browser/facadeCommands.contribution.js';

suite('Facade commands - what the agents\' extension cannot do itself', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let steps: string[];
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

	setup(() => {
		steps = [];
		instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorktreeService, {
			makeWorktree: async (main, branch, options) => {
				steps.push(`make ${main.path} ${branch} ${options?.startPoint} ${options?.show}`);
				return URI.file(`/home/me/.facade/worktrees/lab/${branch}`);
			},
			removeWorktree: async (worktree, options) => { steps.push(`delete ${worktree.path} ${options?.force}`); }
		});
		instantiationService.stub(IFolderTerminalsService, {
			reveal: async instance => { steps.push(`reveal ${instance.title}`); },
			openFor: async (folder: URI, config: IShellLaunchConfig) => {
				steps.push(`open for ${folder.path}: ${config.name} ${config.executable} ${[config.args ?? []].flat().join(' ')} robot=${config.icon === AGENT_TERMINAL_ICON}`);
				// A process that shows nothing: on Windows its id never comes.
				const silent = config.name === 'silent';
				return upcastPartial<ITerminalInstance>({ title: config.name, processId: silent ? undefined : 4242, processReady: silent ? new Promise<void>(() => { }) : Promise.resolve() });
			}
		});
		instantiationService.stub(ITerminalLauncherService, {
			keepName: (instance, name) => { steps.push(`keep the name ${name} of ${instance.processId}`); }
		});
	});

	test('the folder the window is on is answered as it is, and nothing in an empty window', async () => {
		instantiationService.stub(IActiveFolderService, { activeFolder: upcastPartial<IWorkspaceFolder>({ uri: URI.file('/lab') }) });
		const onScreen = await run('_facade.folder.active') as URI;
		instantiationService.stub(IActiveFolderService, { activeFolder: undefined });
		const empty = await run('_facade.folder.active');

		assert.deepStrictEqual({ onScreen: onScreen.path, empty }, { onScreen: '/lab', empty: undefined });
	});

	test('a worktree is made from the commit it is given and answered with its folder, deleted with force only when asked, and refused without a branch', async () => {
		const made = await run('_facade.worktree.create', URI.file('/lab'), 'clamp', 'a'.repeat(40), false) as { path: string; branch: string };
		await run('_facade.worktree.delete', URI.file('/home/me/.facade/worktrees/lab/clamp'), true);
		const noBranch = await failureOf('_facade.worktree.create', URI.file('/lab'), ' ');

		assert.deepStrictEqual({ branch: made.branch, path: URI.file(made.path).path, steps, noBranch }, {
			branch: 'clamp',
			path: '/home/me/.facade/worktrees/lab/clamp',
			steps: [
				`make /lab clamp ${'a'.repeat(40)} false`,
				'delete /home/me/.facade/worktrees/lab/clamp true',
			],
			noBranch: 'branch must be a branch name.',
		});
	});

	test('an agent\'s terminal is opened for its folder with the robot icon, keeps its name across a reload, and is answered with what finds it; a folder must be a URI', async () => {
		const opened = await run('_facade.terminal.create', URI.file('/lab'), { name: '@main · Claude Code', executable: 'claude', args: ['--model', 42, 'sonnet'], agent: true });
		const notAUri = await failureOf('_facade.terminal.create', '/lab', {});

		assert.deepStrictEqual({ opened, steps, notAUri }, {
			opened: { name: '@main · Claude Code', processId: 4242 },
			steps: ['open for /lab: @main · Claude Code claude --model sonnet robot=true', 'keep the name @main · Claude Code of 4242'],
			notAUri: 'folder must be a URI.',
		});
	});

	test('a terminal whose process has shown nothing is answered without its id after a few seconds, and a string is its whole command line', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const opened = await run('_facade.terminal.create', URI.file('/lab'), { name: 'silent', executable: 'cmd.exe', args: '/d /s /c ""a b.exe" "run""' });

		assert.deepStrictEqual({ opened, steps }, {
			opened: { name: 'silent', processId: undefined },
			steps: ['open for /lab: silent cmd.exe /d /s /c ""a b.exe" "run"" robot=false'],
		});
	}));

	test('a terminal\'s last lines are read by its process id, blank lines at the bottom left out; one that is not there reads as nothing', async () => {
		const bottomUp = ['', '', '3 passing  ', 'npm test', '> lab@1.0.0 test'];
		const xterm = upcastPartial<XtermTerminal>({ getBufferReverseIterator: () => bottomUp.values() });
		instantiationService.stub(ITerminalService, { instances: [upcastPartial<ITerminalInstance>({ processId: 4242, xterm })] });

		const all = await run('_facade.terminal.read', 4242);
		const last = await run('_facade.terminal.read', 4242, 1);
		const missing = await run('_facade.terminal.read', 7, 10);

		assert.deepStrictEqual({ all, last, missing }, { all: '> lab@1.0.0 test\nnpm test\n3 passing', last: '3 passing', missing: undefined });
	});

	test('a terminal is put in front by its process id, through its folder\'s row; one that is not there is said to be missing', async () => {
		instantiationService.stub(ITerminalService, { instances: [upcastPartial<ITerminalInstance>({ title: '@clamp · Claude Code', processId: 4242 })] });

		const shown = await run('_facade.terminal.reveal', 4242);
		const missing = await run('_facade.terminal.reveal', 7);

		assert.deepStrictEqual({ shown, missing, steps }, { shown: true, missing: false, steps: ['reveal @clamp · Claude Code'] });
	});

	test('when the person last typed into a terminal is known once they have, by its process id', async () => {
		const typed = store.add(new Emitter<string>());
		const instance = upcastPartial<ITerminalInstance>({
			instanceId: 1,
			processId: 4242,
			xtermReadyPromise: Promise.resolve(upcastPartial<XtermTerminal>({ raw: upcastPartial<XtermTerminal['raw']>({ onData: typed.event }) }))
		});
		instantiationService.stub(ITerminalService, { instances: [instance], onDidCreateInstance: Event.None, onDidDisposeInstance: Event.None });
		store.add(instantiationService.createInstance(TerminalInputTracker));
		await instance.xtermReadyPromise;

		const before = await run('_facade.terminal.lastInput', 4242);
		const startedAt = Date.now();
		typed.fire('y');
		const after = await run('_facade.terminal.lastInput', 4242) as number;

		assert.deepStrictEqual({ before, known: after >= startedAt, other: await run('_facade.terminal.lastInput', 7) }, { before: undefined, known: true, other: undefined });
	});
});
