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
import { IShellLaunchConfig, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IFolderCustomization, IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { AGENT_TERMINAL_ICON } from '../../../terminalLaunchers/common/terminalLaunchers.js';
import { IWorktreeService } from '../../../worktrees/browser/worktrees.js';
import '../../browser/facadeCommands.contribution.js';

suite('Facade commands - the IDE for the agents\' extension', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let steps: string[];
	let customizations: Map<string, IFolderCustomization>;
	let instantiationService: TestInstantiationService;

	/** As the command service runs one: a handler that throws answers with a rejection. */
	async function run(id: string, ...args: unknown[]): Promise<unknown> {
		return instantiationService.invokeFunction(accessor => CommandsRegistry.getCommand(id)!.handler(accessor, ...args));
	}

	setup(() => {
		steps = [];
		customizations = new Map();
		instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceBarCustomizationService, {
			get: uri => customizations.get(uri.path),
			set: (uri, customization) => {
				customizations.set(uri.path, customization);
				steps.push(`customize ${uri.path} ${JSON.stringify(customization)}`);
			}
		});
		instantiationService.stub(IWorkspaceBarService, {
			show: async uri => { steps.push(`show ${uri.path}`); },
			remove: async uris => { steps.push(`remove ${uris.map(uri => uri.path).join(', ')}`); },
			setNotes: notes => { steps.push(`notes ${notes.map(({ uri, note }) => `${uri.path} ${note}`).join(', ')}`); }
		});
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
	});

	test('a terminal is put in front by its process id, through its folder\'s row; one that is not there is said to be missing', async () => {
		instantiationService.stub(ITerminalService, { instances: [upcastPartial<ITerminalInstance>({ title: '@f2 · Codex', processId: 4242 })] });

		const shown = await run('_facade.terminal.reveal', 4242);
		const missing = await run('_facade.terminal.reveal', 7);

		assert.deepStrictEqual({ shown, missing, steps }, { shown: true, missing: false, steps: ['reveal @f2 · Codex'] });
	});

	test('a row\'s name, colour and icon are set field by field, what is not given is kept, and a colour the bar has no name for is refused', async () => {
		const row = URI.file('/lab');
		customizations.set('/lab', { name: 'Lab', color: 'red' });

		await run('_facade.row.set', row, { color: 'blue' });
		await run('_facade.row.set', row, { name: '' });
		const refused = await run('_facade.row.set', row, { color: 'plaid' }).then(() => 'set', (err: Error) => err.message);

		assert.deepStrictEqual({ steps, refused }, {
			steps: [
				'customize /lab {"name":"Lab","color":"blue"}',
				'customize /lab {"color":"blue"}',
			],
			refused: 'color is one of the bar\'s colours, not plaid.',
		});
	});

	test('a worktree is made with the commit and the answer the extension needs, and deleted with force only when asked', async () => {
		const made = await run('_facade.worktree.create', URI.file('/lab'), 'p1-f2', 'a'.repeat(40), false) as { path: string; branch: string };
		await run('_facade.worktree.delete', URI.file('/home/me/.facade/worktrees/lab/p1-f2'), true);
		const noBranch = await run('_facade.worktree.create', URI.file('/lab'), '').then(() => 'made', (err: Error) => err.message);

		assert.deepStrictEqual({ branch: made.branch, path: URI.file(made.path).path, steps, noBranch }, {
			branch: 'p1-f2',
			path: '/home/me/.facade/worktrees/lab/p1-f2',
			steps: [
				`make /lab p1-f2 ${'a'.repeat(40)} false`,
				'delete /home/me/.facade/worktrees/lab/p1-f2 true',
			],
			noBranch: 'branch must be a branch name.',
		});
	});

	test('an agent\'s terminal is opened for its folder with the robot icon, and answered with what finds it', async () => {
		const opened = await run('_facade.terminal.create', URI.file('/home/me/.facade/worktrees/lab/p1-f2'), { name: '@f2 · Codex', executable: 'codex', args: ['exec', 42], agent: true });
		await run('_facade.row.notes', [{ folder: URI.file('/lab'), note: '$(robot) f2 working' }, { folder: URI.file('/lab/p1-f3') }]);
		await run('_facade.folder.show', URI.file('/lab'));
		const notAUri = await run('_facade.folder.show', '/lab').then(() => 'shown', (err: Error) => err.message);

		assert.deepStrictEqual({ opened, steps, notAUri }, {
			opened: { name: '@f2 · Codex', processId: 4242 },
			steps: [
				'open for /home/me/.facade/worktrees/lab/p1-f2: @f2 · Codex codex exec robot=true',
				'notes /lab $(robot) f2 working, /lab/p1-f3 ',
				'show /lab',
			],
			notAUri: 'folder must be a URI.',
		});
	});

	test('every terminal is listed with where it is: a tab, the panel, or held in the background for a folder or a row', async () => {
		const terminal = (title: string, processId: number, target: TerminalLocation) => upcastPartial<ITerminalInstance>({ title, processId, target, shellLaunchConfig: {} });
		const tab = terminal('pwsh', 1, TerminalLocation.Editor);
		const panel = terminal('bash', 2, TerminalLocation.Panel);
		const agent = terminal('@f2 · Codex', 3, TerminalLocation.Editor);
		instantiationService.stub(ITerminalService, { instances: [tab, panel, agent], foregroundInstances: [tab, panel] });
		instantiationService.stub(IFolderTerminalsService, {
			folderOf: instance => instance === tab ? upcastPartial<IWorkspaceFolder>({ uri: URI.file('/lab') }) : undefined,
			rowOf: instance => instance === agent ? URI.file('/home/me/.facade/worktrees/lab/p1-f2') : undefined
		});

		const listed = await run('_facade.terminal.list') as { name: string; processId: number; folder?: string; where: string }[];

		assert.deepStrictEqual(listed.map(({ name, processId, folder, where }) => ({ name, processId, folder: folder && URI.file(folder).path, where })), [
			{ name: 'pwsh', processId: 1, folder: '/lab', where: 'tab' },
			{ name: 'bash', processId: 2, folder: undefined, where: 'panel' },
			{ name: '@f2 · Codex', processId: 3, folder: '/home/me/.facade/worktrees/lab/p1-f2', where: 'background' },
		]);
	});

	test('a terminal whose process has shown nothing is answered without its id after a few seconds, and a string is its whole command line', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const opened = await run('_facade.terminal.create', URI.file('/lab'), { name: 'silent', executable: 'cmd.exe', args: '/d /s /c ""a b.exe" "run""' });

		assert.deepStrictEqual({ opened, steps }, {
			opened: { name: 'silent', processId: undefined },
			steps: ['open for /lab: silent cmd.exe /d /s /c ""a b.exe" "run"" robot=false'],
		});
	}));
});
