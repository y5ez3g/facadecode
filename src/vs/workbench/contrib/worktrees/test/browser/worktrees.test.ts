/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { Schemas } from '../../../../../base/common/network.js';
import { posix } from '../../../../../base/common/path.js';
import { OS } from '../../../../../base/common/platform.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { RawWorkbenchListFocusContextKey } from '../../../../../platform/list/browser/listService.js';
import { IConfirmation, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileContent, IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, IPromptChoice } from '../../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { ICommandDetectionCapability, ITerminalCapabilityStore, ITerminalCommand } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService, IWorkspaceTrustRequestService, IWorkspaceTrustUriInfo } from '../../../../../platform/workspace/common/workspaceTrust.js';
// For the keys every focused list has, which the bar's own have to win over.
import '../../../../browser/actions/listCommands.js';
import { WorkspaceBarContextMenu, WorkspaceBarFocusContext, WorkspaceBarRowExpansionContext, WorkspaceBarRowKindContext } from '../../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { INewWorktreeAnswer, IWorkspaceBarDialogService } from '../../../../browser/parts/workspacebar/workspaceBarCustomize.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { DeleteWorktreeAction, freeWorktreeName, freeWorktreeUri, NewWorktreeAction, readSetupCommands, worktreeFolderName, WorktreeService } from '../../browser/worktrees.js';

suite('Worktrees - names, paths and setup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a branch becomes one folder name on every OS, and a device name none', () => {
		const branches = ['feat/x', 'fix\\y', 'a:b*c?d', '  w2  ', '', 'con', 'NUL.txt', 'lpt10', 'com1'];

		assert.deepStrictEqual(Object.fromEntries(branches.map(branch => [branch, worktreeFolderName(branch)])), {
			'feat/x': 'feat-x',
			'fix\\y': 'fix-y',
			'a:b*c?d': 'a-b-c-d',
			'  w2  ': 'w2',
			'': undefined,
			'con': undefined,
			'NUL.txt': undefined,
			'lpt10': 'lpt10',
			'com1': undefined,
		});
	});

	test('a taken path gets -1, -2 and so on, and the dialog names the folder that will be made', async () => {
		const parent = URI.file('/home/me/.facade/worktrees/lab');
		const taken = new Set(['/home/me/.facade/worktrees/lab/w2', '/home/me/.facade/worktrees/lab/w2-1']);
		const exists = async (uri: URI) => taken.has(uri.path);
		const said = (name: string) => freeWorktreeName(name, candidate => taken.has(`${parent.path}/${candidate}`));

		assert.deepStrictEqual({
			made: [(await freeWorktreeUri(parent, 'w2', exists)).path, (await freeWorktreeUri(parent, 'w3', exists)).path],
			said: [said('w2'), said('w3')],
		}, {
			made: ['/home/me/.facade/worktrees/lab/w2-2', '/home/me/.facade/worktrees/lab/w3'],
			said: ['w2-2', 'w3'],
		});
	});

	test('setup reads the OS\'s own key first, then the shared one, in Cursor\'s format', () => {
		const both = '{ "setup-worktree": ["npm ci"], "setup-worktree-windows": ["npm.cmd ci", ".\\\\setup.ps1"] }';
		const shared = '{ // comments are allowed\n "setup-worktree": ["uv sync"], }';

		assert.deepStrictEqual({
			windows: readSetupCommands(both, true),
			unix: readSetupCommands(both, false),
			shared: readSetupCommands(shared, true),
			nothing: readSetupCommands('{ "other": 1 }', false),
			noneForThisOs: readSetupCommands('{ "setup-worktree-windows": [], "setup-worktree": ["npm ci"] }', true),
			notAList: readSetupCommands('{ "setup-worktree": "npm ci" }', false),
			notStrings: readSetupCommands('{ "setup-worktree": [1, 2] }', false),
			notJson: readSetupCommands('setup-worktree: npm ci', false),
		}, {
			windows: { kind: 'lines', lines: ['npm.cmd ci', '.\\setup.ps1'] },
			unix: { kind: 'lines', lines: ['npm ci'] },
			shared: { kind: 'lines', lines: ['uv sync'] },
			nothing: { kind: 'none' },
			noneForThisOs: { kind: 'none' },
			notAList: { kind: 'invalid' },
			notStrings: { kind: 'invalid' },
			notJson: { kind: 'invalid' },
		});
	});
});

suite('Worktrees - making and deleting one', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const main = URI.file('/lab');
	const w2 = URI.file('/home/me/.facade/worktrees/lab/w2');
	const w3 = URI.file('/home/me/.facade/worktrees/lab/w3');

	/** What the service did that anybody would notice, in the order it did it. */
	let steps: string[];
	/** What the git extension returns for each command, by the command and its first string argument. */
	let answers: Map<string, unknown>;
	/** The git extension's commands that are not there, as when it is not running. */
	let missingCommands: Set<string>;
	let confirmations: IConfirmation[];
	let prompted: IPromptChoice[];
	let repository: IWorkspaceBarRepository;
	let savedOrder: URI[] | undefined;
	let answer: INewWorktreeAnswer | undefined;
	/** The files on disk, by path: `.facade/worktrees.json` of a worktree or a repository. */
	let files: Map<string, string>;
	/** How long a new terminal's shell integration is waited for (`terminal.integrated.shellIntegration.timeout`). */
	let shellIntegrationTimeout: number;
	/** The terminal setup runs in, once there is one. */
	let setupShell: DeferredPromise<ISetupTerminal>;
	let terminals: ITerminalInstance[];
	/** The terminals of the worktree's editor area, whatever they started in (`IFolderTerminalsService`). */
	let editorAreaTerminals: ITerminalInstance[];
	let trust: { enabled: boolean; trusted: boolean; granted: boolean };
	let instantiationService: TestInstantiationService;

	function terminal(name: string, cwd: string, options?: { readonly remoteAuthority?: string; readonly running?: boolean }): ITerminalInstance {
		return upcastPartial<ITerminalInstance>({
			cwd,
			initialCwd: cwd,
			remoteAuthority: options?.remoteAuthority,
			hasChildProcesses: !!options?.running,
			dispose: () => { steps.push(`close ${name}`); }
		});
	}

	/** The terminal setup runs in, and the shell in it, which does what the test says when it says so. */
	interface ISetupTerminal {
		readonly instance: ITerminalInstance;
		/** Every line sent to it, with the id it was run with; none for a line typed ahead. */
		readonly sent: { readonly line: string; readonly id: string | undefined }[];
		/** Shell integration lighting up, a moment after the shell starts. */
		integrate(): void;
		/** The shell saying a command finished: the one run with `id`, or with none, one of somebody else's. */
		finish(id: string | undefined): void;
		/** Resolves once `count` lines have been sent. */
		whenSent(count: number): Promise<void>;
	}

	function setupTerminal(): ISetupTerminal {
		const added = store.add(new Emitter<ICommandDetectionCapability>());
		const finished = store.add(new Emitter<ITerminalCommand>());
		const disposed = store.add(new Emitter<ITerminalInstance>());
		const onDidSend = store.add(new Emitter<void>());
		const detection = upcastPartial<ICommandDetectionCapability>({ onCommandFinished: finished.event });
		let integrated = false;
		const sent: { line: string; id: string | undefined }[] = [];
		const send = (line: string, id: string | undefined) => {
			sent.push({ line, id });
			onDidSend.fire();
		};

		return {
			instance: upcastPartial<ITerminalInstance>({
				isDisposed: false,
				hasRemoteAuthority: false,
				onDisposed: disposed.event,
				capabilities: upcastPartial<ITerminalCapabilityStore>({
					get: (() => integrated ? detection : undefined) as ITerminalCapabilityStore['get'],
					onDidAddCommandDetectionCapability: added.event
				}),
				runCommand: async (line, _execute, id) => send(line, id),
				sendText: async line => send(line, undefined)
			}),
			sent,
			integrate: () => {
				integrated = true;
				added.fire(detection);
			},
			finish: id => finished.fire(upcastPartial<ITerminalCommand>({ id })),
			whenSent: async count => {
				if (sent.length < count) {
					await Event.toPromise(Event.filter(onDidSend.event, () => sent.length >= count));
				}
			}
		};
	}

	/** The lines setup sent, and how. */
	function sentLines(shell: ISetupTerminal): string[] {
		return shell.sent.map(({ line, id }) => `${id ? 'run' : 'type'} ${line}`);
	}

	/** Every argument the git extension is sent, a URI as its path. */
	function describeCommand(id: string, args: unknown[]): string {
		return [id, ...args.map(arg => URI.isUri(arg) ? arg.path : String(arg))].join(' ');
	}

	setup(() => {
		steps = [];
		answers = new Map();
		missingCommands = new Set();
		confirmations = [];
		prompted = [];
		savedOrder = undefined;
		answer = undefined;
		files = new Map();
		shellIntegrationTimeout = 60000;
		setupShell = new DeferredPromise<ISetupTerminal>();
		terminals = [terminal('its terminal', '/home/me/.facade/worktrees/lab/w2/src'), terminal('another', '/lab')];
		editorAreaTerminals = [];
		trust = { enabled: false, trusted: true, granted: false };
		repository = { kind: 'repository', main, folder: undefined, branch: 'main', members: [], worktrees: [{ uri: w2, branch: 'w2', label: 'w2', exists: true, folder: undefined }] };

		const restored = store.add(new Emitter<void>());
		instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceBarService, {
			onDidRestoreEditors: restored.event,
			folderForCommand: () => undefined,
			repositoryFor: () => repository,
			show: async uri => {
				steps.push(`show ${uri.path}`);
				restored.fire();
			},
			remove: async uris => { steps.push(`remove ${uris.map(uri => uri.path).join(', ')}`); },
			setExpanded: uri => { steps.push(`open ${uri.path}`); },
			whenListed: async uri => { steps.push(`listed ${uri.path}`); }
		});
		instantiationService.stub(IWorkspaceBarCustomizationService, {
			get: () => undefined,
			set: (uri, customization) => { steps.push(`customize ${uri.path} ${JSON.stringify(customization)}`); },
			worktreeOrder: () => savedOrder,
			setWorktreeOrder: (_repository, worktrees) => { steps.push(`order ${worktrees.map(uri => uri.path).join(', ')}`); }
		});
		instantiationService.stub(IWorkspaceBarDialogService, {
			showNewWorktreeDialog: async () => {
				steps.push('ask');
				return answer;
			}
		});
		instantiationService.stub(IConfigurationService, {
			getValue: ((key: string) => key === TerminalSettingId.ShellIntegrationTimeout ? shellIntegrationTimeout : undefined) as IConfigurationService['getValue']
		});
		instantiationService.stub(IActiveFolderService, { activeFolder: upcastPartial<IWorkspaceFolder>({ uri: w2 }) });
		instantiationService.stub(ICommandService, {
			executeCommand: async <T>(id: string, ...args: unknown[]) => {
				steps.push(describeCommand(id, args));
				if (missingCommands.has(id)) {
					throw new Error(`command '${id}' not found`);
				}
				return answers.get(`${id} ${args.find(arg => typeof arg === 'string')}`) as T;
			}
		});
		instantiationService.stub(IDialogService, {
			confirm: async confirmation => {
				steps.push('confirm');
				confirmations.push(confirmation);
				return { confirmed: true };
			}
		});
		instantiationService.stub(INotificationService, {
			error: message => { steps.push(`error: ${message}`); },
			warn: message => { steps.push(`warn: ${message}`); },
			info: message => { steps.push(`info: ${message}`); },
			prompt: (_severity, message, choices) => {
				steps.push(`prompt: ${message}`);
				prompted.push(...choices);
				return upcastPartial<INotificationHandle>({});
			}
		});
		instantiationService.stub(IFolderTerminalsService, { terminalsOf: () => editorAreaTerminals });
		instantiationService.stub(ITerminalService, {
			get instances() { return terminals; },
			createTerminal: async () => {
				const shell = setupTerminal();
				setupShell.complete(shell);
				return shell.instance;
			},
			setActiveInstance: () => { },
			revealTerminal: async () => { }
		});
		instantiationService.stub(IProgressService, { withProgress: async (_options, task) => task({ report: () => { } }) });
		instantiationService.stub(IFileService, {
			hasCapability: () => true,
			resolve: (() => Promise.reject(new Error('not there'))) as IFileService['resolve'],
			exists: async () => false,
			readFile: async uri => {
				const content = files.get(uri.path);
				if (content === undefined) {
					throw new Error('not there');
				}
				return upcastPartial<IFileContent>({ value: VSBuffer.fromString(content) });
			}
		});
		instantiationService.stub(IPathService, {
			userHome: (() => Promise.resolve(URI.file('/home/me'))) as IPathService['userHome'],
			path: Promise.resolve(posix),
			fileURI: async path => URI.file(path)
		});
		instantiationService.stub(IWorkspaceTrustEnablementService, { isWorkspaceTrustEnabled: () => trust.enabled });
		instantiationService.stub(IWorkspaceTrustManagementService, {
			isWorkspaceTrusted: () => trust.trusted,
			getUriTrustInfo: async uri => upcastPartial<IWorkspaceTrustUriInfo>({ uri, trusted: trust.trusted }),
			setUrisTrust: async (uris, trusted) => { steps.push(`${trusted ? 'trust' : 'untrust'} ${uris.map(uri => uri.path).join(', ')}`); }
		});
		instantiationService.stub(IWorkspaceTrustRequestService, {
			requestWorkspaceTrust: async () => {
				steps.push('ask for trust');
				trust.trusted ||= trust.granted;
				return trust.granted;
			}
		});
		instantiationService.stub(ILabelService, { getUriLabel: uri => uri.path, getSeparator: () => '/' });
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(ILogService, new NullLogService());
	});

	test('making one: named and coloured before its row is drawn, trusted, its record read, its repository opened, and the window taken to it', async () => {
		trust.enabled = true;
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		answer = { branch: 'w3', customization: { name: 'Three' } };

		await instantiationService.createInstance(WorktreeService).createWorktree(main);

		assert.deepStrictEqual(steps, [
			'_git.prepareWorktreeBaseAt /lab inspect',
			'ask',
			'customize /home/me/.facade/worktrees/lab/w3 {"name":"Three"}',
			'_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w3 w3',
			'trust /home/me/.facade/worktrees/lab/w3',
			'listed /home/me/.facade/worktrees/lab/w3',
			'open /lab',
			'show /home/me/.facade/worktrees/lab/w3',
		]);
	});

	test('setup lines run one at a time: each once the shell says that line\'s own command finished', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		answer = { branch: 'w3', customization: {} };
		files.set(`${w3.path}/.facade/worktrees.json`, '{ "setup-worktree": ["npm ci", "npm run build"] }');

		await instantiationService.createInstance(WorktreeService).createWorktree(main);
		const shell = await setupShell.p;
		shell.integrate();
		await shell.whenSent(1);
		shell.finish(undefined);
		await timeout(0);
		const whileTheFirstRuns = sentLines(shell);
		shell.finish(shell.sent[0].id);
		await shell.whenSent(2);
		shell.finish(shell.sent[1].id);
		await timeout(0);

		assert.deepStrictEqual({ whileTheFirstRuns, sent: sentLines(shell) }, {
			whileTheFirstRuns: ['run npm ci'],
			sent: ['run npm ci', 'run npm run build'],
		});
	});

	test('without shell integration to say when a line finished, setup lines are typed one after another', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		answer = { branch: 'w3', customization: {} };
		files.set(`${w3.path}/.facade/worktrees.json`, '{ "setup-worktree": ["npm ci", "npm run build"] }');
		shellIntegrationTimeout = 0;

		await instantiationService.createInstance(WorktreeService).createWorktree(main);
		const shell = await setupShell.p;
		await shell.whenSent(2);

		assert.deepStrictEqual(sentLines(shell), ['type npm ci', 'type npm run build']);
	});

	test('setup is the worktree\'s own .facade/worktrees.json when it has one, before its repository\'s', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		answer = { branch: 'w3', customization: {} };
		files.set(`${main.path}/.facade/worktrees.json`, '{ "setup-worktree": ["the repository\'s"] }');
		files.set(`${w3.path}/.facade/worktrees.json`, '{ "setup-worktree": ["the worktree\'s"] }');
		shellIntegrationTimeout = 0;

		await instantiationService.createInstance(WorktreeService).createWorktree(main);
		const shell = await setupShell.p;
		await shell.whenSent(1);

		assert.deepStrictEqual(sentLines(shell), ['type the worktree\'s']);
	});

	test('setup goes on after New Worktree is done: the repository\'s next New Worktree is not held up by it', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		answer = { branch: 'w3', customization: {} };
		files.set(`${w3.path}/.facade/worktrees.json`, '{ "setup-worktree": ["npm run dev"] }');
		const service = instantiationService.createInstance(WorktreeService);

		const first = service.createWorktree(main);
		const shell = await setupShell.p;
		shell.integrate();
		await shell.whenSent(1);
		steps = [];
		answer = undefined;
		await service.createWorktree(main);
		const second = [...steps];
		shell.finish(shell.sent[0].id);
		await first;
		await timeout(0);

		assert.deepStrictEqual(second, ['_git.prepareWorktreeBaseAt /lab inspect', 'ask']);
	});

	test('trust given in Restricted Mode starts Git, which is waited for before it is asked anything', async () => {
		trust = { enabled: true, trusted: false, granted: true };
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });

		const made = instantiationService.createInstance(WorktreeService).createWorktree(main);
		await timeout(0);
		steps.push('git registers its commands');
		store.add(CommandsRegistry.registerCommand('_git.prepareWorktreeBaseAt', () => { }));
		await made;

		assert.deepStrictEqual(steps, ['ask for trust', 'git registers its commands', '_git.prepareWorktreeBaseAt /lab inspect', 'ask']);
	});

	test('a worktree git made although its post-checkout hook failed is taken to all the same, the failure said', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: 'the hook says no' });
		answer = { branch: 'w3', customization: {} };

		await instantiationService.createInstance(WorktreeService).createWorktree(main);

		assert.deepStrictEqual(steps.filter(step => step.startsWith('warn') || step.startsWith('show')), [
			'warn: The worktree was created, but a Git hook failed: the hook says no',
			'show /home/me/.facade/worktrees/lab/w3',
		]);
	});

	test('a branch checked out in another worktree is said so, with a way to go there', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w2', { kind: 'error', code: 'BranchAlreadyExists', message: 'a branch named \'w2\' already exists' });
		answer = { branch: 'w2', customization: { name: 'Two' } };

		await instantiationService.createInstance(WorktreeService).createWorktree(main);
		await prompted[0].run();

		assert.deepStrictEqual({ steps, choices: prompted.map(choice => choice.label) }, {
			steps: [
				'_git.prepareWorktreeBaseAt /lab inspect',
				'ask',
				'customize /home/me/.facade/worktrees/lab/w2 {"name":"Two"}',
				'_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 w2',
				// Nothing was made at that path: the name given for it is taken back.
				'customize /home/me/.facade/worktrees/lab/w2 {}',
				'prompt: Branch w2 is already checked out in /home/me/.facade/worktrees/lab/w2.',
				'show /home/me/.facade/worktrees/lab/w2',
			],
			choices: ['Go There'],
		});
	});

	test('in Restricted Mode, trust is asked for before git is, and nothing runs without it', async () => {
		trust = { enabled: true, trusted: false, granted: false };

		await instantiationService.createInstance(WorktreeService).createWorktree(main);
		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);

		assert.deepStrictEqual(steps, ['ask for trust', 'ask for trust']);
	});

	test('a failure the git extension gave a code of the product\'s own is said in the product\'s words, and git\'s own in git\'s', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'uninitialized', files: 1, identity: true, enclosing: undefined });
		answers.set('_git.prepareWorktreeBaseAt initialize', { kind: 'error', code: 'InitialBranch', message: 'in the extension\'s words' });
		answer = { branch: 'main', customization: {} };
		await instantiationService.createInstance(WorktreeService).createWorktree(main);

		answers.set('_git.deleteWorktreeAt check', { kind: 'error', code: undefined, message: 'fatal from git' });
		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);

		assert.deepStrictEqual(steps.filter(step => step.startsWith('error: ')), [
			'error: The initial commit goes on "main", so the worktree needs a branch with another name.',
			'error: The worktree could not be checked before deleting it: fatal from git',
		]);
	});

	test('a folder not on disk, one Git will not open, and a Git extension that is not running, are said in the product\'s words', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'error', code: 'InvalidArgument', message: 'Not an absolute path: vscode-vfs://github/lab' });
		await instantiationService.createInstance(WorktreeService).createWorktree(main);
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'error', code: 'NotASafeGitRepository', message: 'detected dubious ownership in repository at \'/lab\'' });
		await instantiationService.createInstance(WorktreeService).createWorktree(main);
		missingCommands.add('_git.deleteWorktreeAt');
		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);

		assert.deepStrictEqual(steps.filter(step => step.startsWith('error: ')), [
			'error: "lab" is not a folder on disk, which is where Git works.',
			`error: Git does not open "lab", which is owned by another user. To trust it, run git config --global --add safe.directory ${main.fsPath}, then try again.`,
			'error: Worktrees are made and deleted with the Git extension, which is not running in this window.',
		]);
	});

	test('deleting one with changes: asked first, then off it, out of folders[], its terminals closed and only then git, with force; its name, colour, place and trust go with it', async () => {
		trust.enabled = true;
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['a.txt'], submodules: false });
		answers.set('_git.deleteWorktreeAt force', { kind: 'removed' });
		savedOrder = [w2, w3];

		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);

		assert.deepStrictEqual({ steps, type: confirmations[0].type, detail: (confirmations[0].detail as IMarkdownString).value.includes('`a.txt`') }, {
			steps: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'confirm',
				'show /lab',
				'remove /home/me/.facade/worktrees/lab/w2',
				'close its terminal',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 force',
				'customize /home/me/.facade/worktrees/lab/w2 {}',
				'order /home/me/.facade/worktrees/lab/w3',
				'untrust /home/me/.facade/worktrees/lab/w2',
			],
			type: 'warning',
			detail: true,
		});
	});

	test('a clean worktree with submodules checked out is warned about them, and deleted with force - git takes it no other way', async () => {
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: true });
		answers.set('_git.deleteWorktreeAt force', { kind: 'removed' });

		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);

		assert.deepStrictEqual({
			type: confirmations[0].type,
			said: (confirmations[0].detail as IMarkdownString).value.includes('submodules will be deleted with it'),
			deleted: steps.filter(step => step.startsWith('_git.deleteWorktreeAt'))
		}, {
			type: 'warning',
			said: true,
			deleted: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 force',
			],
		});
	});

	test('on a remote, a terminal working in the worktree is found by its path there: said to be running, and closed first', async () => {
		const remote = (path: string) => URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+box', path });
		const worktree = remote(w2.path);
		repository = { kind: 'repository', main: remote('/lab'), folder: undefined, branch: 'main', members: [], worktrees: [{ uri: worktree, branch: 'w2', label: 'w2', exists: true, folder: undefined }] };
		terminals = [
			terminal('the remote one', `${w2.path}/src`, { remoteAuthority: 'ssh-remote+box', running: true }),
			terminal('a local one at the same path', `${w2.path}/src`, { running: true })
		];
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });

		await instantiationService.createInstance(WorktreeService).deleteWorktree(worktree);

		assert.deepStrictEqual({
			running: (confirmations[0].detail as IMarkdownString).value.includes('Something is running'),
			closed: steps.filter(step => step.startsWith('close '))
		}, {
			running: true,
			closed: ['close the remote one'],
		});
	});

	test('a terminal of the worktree\'s editor area is said to be running whatever it started in: deleting the worktree stops it too', async () => {
		editorAreaTerminals = [terminal('a server moved into its editor area', '/lab', { running: true })];
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });

		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);

		assert.deepStrictEqual((confirmations[0].detail as IMarkdownString).value.split('\n').filter(line => line.startsWith('Something')), [
			'Something is running in one of its terminals; it will be stopped.',
		]);
	});

	test('a worktree on a detached HEAD is not told it has a branch to keep', async () => {
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		const lastLine = () => (confirmations[confirmations.length - 1].detail as IMarkdownString).value.trim().split('\n').pop();

		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);
		const onBranch = lastLine();
		repository = { ...repository, worktrees: [{ uri: w2, branch: undefined, label: 'a1b2c3d', exists: true, folder: undefined }] };
		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);

		assert.deepStrictEqual({ onBranch, detached: lastLine() }, {
			onBranch: 'The associated branch "w2" will not be deleted.',
			detached: '`/home/me/.facade/worktrees/lab/w2`',
		});
	});
});

suite('Worktrees - the row menu and its keys', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => {
		store.add(registerAction2(NewWorktreeAction));
		store.add(registerAction2(DeleteWorktreeAction));
	});

	/** With worktrees listed: the setting's default, which a test's configuration does not register. */
	function contextKeys(): ContextKeyService {
		return store.add(new ContextKeyService(new TestConfigurationService({ facade: { workspaceBar: { worktrees: true } } })));
	}

	/** What a row of `kind` has on its menu, its groups in the order the menu draws them, with worktrees listed. */
	function menu(kind: 'folder' | 'repository' | 'worktree', expansion: '' | 'expanded' | 'collapsed'): string[] {
		const contextKeyService = contextKeys();
		WorkspaceBarRowKindContext.bindTo(contextKeyService).set(kind);
		WorkspaceBarRowExpansionContext.bindTo(contextKeyService).set(expansion);
		const rank = (group: string | undefined) => group === 'navigation' ? '' : group ?? '';

		return MenuRegistry.getMenuItems(WorkspaceBarContextMenu)
			.filter(isIMenuItem)
			.filter(item => contextKeyService.contextMatchesRules(item.when))
			.sort((a, b) => rank(a.group).localeCompare(rank(b.group)) || (a.order ?? 0) - (b.order ?? 0))
			.map(item => `${item.group} ${item.command.id}`);
	}

	test('each kind of row has the three groups of WT-1.11: what is in it, how it stands in the list, and whether it stays', () => {
		assert.deepStrictEqual({ folder: menu('folder', ''), repository: menu('repository', 'expanded'), worktree: menu('worktree', '') }, {
			folder: [
				'navigation facade.workspaceBar.newWorktree',
				'navigation facade.workspaceBar.revealFolder',
				'2_arrange facade.workspaceBar.customizeFolder',
				'2_arrange facade.workspaceBar.moveFolderUp',
				'2_arrange facade.workspaceBar.moveFolderDown',
				'9_remove facade.workspaceBar.removeFolder',
			],
			repository: [
				'navigation facade.workspaceBar.newWorktree',
				'navigation facade.workspaceBar.collapseFolder',
				'navigation facade.workspaceBar.revealFolder',
				'2_arrange facade.workspaceBar.customizeFolder',
				'2_arrange facade.workspaceBar.moveFolderUp',
				'2_arrange facade.workspaceBar.moveFolderDown',
				'9_remove facade.workspaceBar.removeFolder',
			],
			worktree: [
				'navigation facade.workspaceBar.revealFolder',
				'2_arrange facade.workspaceBar.customizeFolder',
				'2_arrange facade.workspaceBar.moveWorktreeUp',
				'2_arrange facade.workspaceBar.moveWorktreeDown',
				'9_remove facade.workspaceBar.deleteWorktree',
			],
		});
	});

	test('Alt+Up and Alt+Down on a row move it, over the keys every focused list has for them', () => {
		const contextKeyService = contextKeys();
		RawWorkbenchListFocusContextKey.bindTo(contextKeyService).set(true);
		const inBar = WorkspaceBarFocusContext.bindTo(contextKeyService);
		const kind = WorkspaceBarRowKindContext.bindTo(contextKeyService);
		// The command a key runs: the last of those bound to it that apply, as the keybinding resolver has it.
		const pressed = (key: number, row: 'folder' | 'worktree' | undefined) => {
			inBar.set(!!row);
			kind.set(row ?? 'folder');
			const keybinding = decodeKeybinding(key, OS);
			return KeybindingsRegistry.getDefaultKeybindings()
				.filter(item => !!keybinding && !!item.keybinding?.equals(keybinding) && contextKeyService.contextMatchesRules(item.when ?? undefined))
				.pop()?.command;
		};

		assert.deepStrictEqual({
			folder: [pressed(KeyMod.Alt | KeyCode.UpArrow, 'folder'), pressed(KeyMod.Alt | KeyCode.DownArrow, 'folder')],
			worktree: [pressed(KeyMod.Alt | KeyCode.UpArrow, 'worktree'), pressed(KeyMod.Alt | KeyCode.DownArrow, 'worktree')],
			anotherList: [pressed(KeyMod.Alt | KeyCode.UpArrow, undefined), pressed(KeyMod.Alt | KeyCode.DownArrow, undefined)],
		}, {
			folder: ['facade.workspaceBar.moveFolderUp', 'facade.workspaceBar.moveFolderDown'],
			worktree: ['facade.workspaceBar.moveWorktreeUp', 'facade.workspaceBar.moveWorktreeDown'],
			anotherList: ['list.focusAnyUp', 'list.focusAnyDown'],
		});
	});
});
