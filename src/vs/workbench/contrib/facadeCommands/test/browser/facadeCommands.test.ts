/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
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
import { AGENT_TERMINAL_ICON } from '../../../terminalLaunchers/common/terminalLaunchers.js';
import '../../browser/facadeCommands.contribution.js';

suite('Facade commands - what the agents\' extension cannot do itself', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let steps: string[];
	let instantiationService: TestInstantiationService;

	/** As the command service runs one: a handler that throws answers with a rejection. */
	async function run(id: string, ...args: unknown[]): Promise<unknown> {
		return instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand(id)!.handler(accessor, ...args));
	}

	setup(() => {
		steps = [];
		instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IFolderTerminalsService, {
			openFor: async (folder: URI, config: IShellLaunchConfig) => {
				steps.push(`open for ${folder.path}: ${config.name} ${config.executable} ${[config.args ?? []].flat().join(' ')} robot=${config.icon === AGENT_TERMINAL_ICON}`);
				// A process that shows nothing: on Windows its id never comes.
				const silent = config.name === 'silent';
				return upcastPartial<ITerminalInstance>({ title: config.name, processId: silent ? undefined : 4242, processReady: silent ? new Promise<void>(() => { }) : Promise.resolve() });
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

	test('an agent\'s terminal is opened for its folder with the robot icon, and answered with what finds it; a folder must be a URI', async () => {
		const opened = await run('_facade.terminal.create', URI.file('/lab'), { name: '@main · Claude Code', executable: 'claude', args: ['--model', 42, 'sonnet'], agent: true });
		let notAUri: string | undefined;
		try {
			await run('_facade.terminal.create', '/lab', {});
		} catch (err) {
			notAUri = (err as Error).message;
		}

		assert.deepStrictEqual({ opened, steps, notAUri }, {
			opened: { name: '@main · Claude Code', processId: 4242 },
			steps: ['open for /lab: @main · Claude Code claude --model sonnet robot=true'],
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
});
