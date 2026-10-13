/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import assert from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { Schemas } from '../../../../../base/common/network.js';
import { posix } from '../../../../../base/common/path.js';
import { OS } from '../../../../../base/common/platform.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
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
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { ICommandDetectionCapability, ITerminalCapabilityStore, ITerminalCommand } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalBackend, TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';
import { IProcessDetails } from '../../../../../platform/terminal/common/terminalProcess.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService, IWorkspaceTrustRequestService, IWorkspaceTrustUriInfo } from '../../../../../platform/workspace/common/workspaceTrust.js';
// For the keys every focused list has, which the bar's own have to win over.
import '../../../../browser/actions/listCommands.js';
import { WorkspaceBarContextMenu, WorkspaceBarFocusContext, WorkspaceBarRowExpansionContext, WorkspaceBarRowKindContext } from '../../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { INewWorktreeAnswer, IWorkspaceBarDialogService } from '../../../../browser/parts/workspacebar/workspaceBarCustomize.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IEditorIdentifier } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { BackgroundFolderChangesService, IBackgroundFolderChangesService } from '../../../../services/backgroundFolderChanges/common/backgroundFolderChanges.js';
import { IFilesConfigurationService } from '../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IFacadeRunsService } from '../../../facadeCommands/browser/facadeRuns.js';
import { facadeRunProperties, IFacadeRun } from '../../../facadeCommands/common/facadeRun.js';
import { IFolderTerminalsService } from '../../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../../terminal/browser/terminal.js';
import type { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';
import { DeleteWorktreeAction, freeWorktreeName, freeWorktreeUri, IRemoveWorktreeOptions, NewWorktreeAction, readSetupCommands, worktreeFolderName, WorktreeService } from '../../browser/worktrees.js';

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
	/** The SHA-256 of `{}`, in hex. */
	const SHA256_OF_EMPTY_OBJECT = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

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
	/** Symbolic links to folders, by their paths: a path through one has the folder's as its real path. */
	let links: Map<string, string>;
	/** How long a new terminal's shell integration is waited for (`terminal.integrated.shellIntegration.timeout`). */
	let shellIntegrationTimeout: number;
	/** The terminal setup runs in, once there is one. */
	let setupShell: DeferredPromise<ISetupTerminal>;
	let terminals: ITerminalInstance[];
	/** What the pty host runs for every window: other windows' terminals among them. */
	let ptyProcesses: IProcessDetails[];
	/** The terminals of the worktree's editor area, whatever they started in (`IFolderTerminalsService`). */
	let editorAreaTerminals: ITerminalInstance[];
	/** Whether trust is on, the workspace trusted, trust given when asked, and the repository trusted where that differs. */
	let trust: { enabled: boolean; trusted: boolean; granted: boolean; repositoryTrusted?: boolean };
	/** Where each progress was shown. */
	let progressShown: ProgressLocation[];
	/** The files open with unsaved changes, editors and notebooks alike. */
	let unsaved: IWorkingCopy[];
	/** The window's working copies of files with nothing unsaved. */
	let open: IWorkingCopy[];
	/** Fired as a working copy comes: a file opened. */
	let registered: Emitter<IWorkingCopy>;
	/** Called with each command the service runs, as it runs it. */
	let whenCommand: ((command: string) => void) | undefined;
	/** The files open in editors, saved or not. */
	let opened: URI[];
	/** The window's folders, `folders[]`. */
	let workspaceFolders: URI[];
	/** The folders on disk the service asks about: the repository's own. */
	let onDisk: Set<string>;
	/** The folder the window was on before the active one, `IActiveFolderService.previousFolder`. */
	let previousFolder: URI | undefined;
	/** What the runs service was told of terminals the person's deletion closes, and why. */
	let closing: string[];
	let backgroundFolderChanges: BackgroundFolderChangesService;
	let instantiationService: TestInstantiationService;
	/** xterm, which a setup terminal's screen is. */
	let TerminalCtor: typeof RawXtermTerminal;

	suiteSetup(async () => {
		TerminalCtor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
	});

	/** A terminal working in `cwd`; `options.closing` is what its process does as its terminal is closed. */
	function terminal(name: string, cwd: string, options?: { readonly remoteAuthority?: string; readonly running?: boolean; readonly run?: IFacadeRun; readonly exitCode?: number; readonly closing?: () => void }): ITerminalInstance {
		let closed = false;
		return upcastPartial<ITerminalInstance>({
			title: name,
			cwd,
			initialCwd: cwd,
			remoteAuthority: options?.remoteAuthority,
			hasChildProcesses: !!options?.running,
			reconnectionProperties: options?.run && facadeRunProperties(options.run),
			exitCode: options?.exitCode,
			get isDisposed() { return closed; },
			dispose: () => {
				closed = true;
				steps.push(`close ${name}`);
				options?.closing?.();
			}
		});
	}

	/** A file of a worktree open with unsaved changes. */
	function unsavedFile(path: string): IWorkingCopy {
		const resource = URI.file(path);
		opened.push(resource);
		return upcastPartial<IWorkingCopy>({
			resource,
			revert: async () => {
				steps.push(`revert ${path}`);
				unsaved = unsaved.filter(each => each.resource.path !== path);
			}
		});
	}

	/** The terminal setup runs in, and the shell in it, which does what the test says when it says so. */
	interface ISetupTerminal {
		readonly instance: ITerminalInstance;
		/** Every line sent to it, with the id it was run with; none for a line typed ahead. */
		readonly sent: { readonly line: string; readonly id: string | undefined }[];
		/** What runs in it writing `output` to its screen, 30 columns wide. */
		print(output: string): Promise<void>;
		/** Shell integration lighting up, a moment after the shell starts. */
		integrate(): void;
		/** The shell saying a command finished: the one run with `id`, or with none, one of somebody else's - with its exit code and output. */
		finish(id: string | undefined, exitCode?: number, output?: string): void;
		/** The shell ending in the middle of a line - its `exit 7` - with that code, the line having written `output`. */
		exit(exitCode: number, output?: string): void;
		/** Whether its terminal was closed. */
		readonly closed: () => boolean;
		/** Resolves once `count` lines have been sent. */
		whenSent(count: number): Promise<void>;
	}

	function setupTerminal(): ISetupTerminal {
		const added = store.add(new Emitter<ICommandDetectionCapability>());
		const finished = store.add(new Emitter<ITerminalCommand>());
		const disposed = store.add(new Emitter<ITerminalInstance>());
		const exited = store.add(new Emitter<number | undefined>());
		const onDidSend = store.add(new Emitter<void>());
		let executing: ITerminalCommand | undefined;
		const detection = upcastPartial<ICommandDetectionCapability>({ onCommandFinished: finished.event, get executingCommandObject() { return executing; } });
		let integrated = false;
		let closed = false;
		const sent: { line: string; id: string | undefined }[] = [];
		const send = (line: string, id: string | undefined) => {
			sent.push({ line, id });
			onDidSend.fire();
		};
		const raw = store.add(new TerminalCtor({ cols: 30, rows: 5, allowProposedApi: true }));

		const instance = upcastPartial<ITerminalInstance>({
			get isDisposed() { return closed; },
			xterm: upcastPartial<XtermTerminal>({ raw }),
			hasRemoteAuthority: false,
			onDisposed: disposed.event,
			onExit: exited.event,
			capabilities: upcastPartial<ITerminalCapabilityStore>({
				get: (() => integrated ? detection : undefined) as ITerminalCapabilityStore['get'],
				onDidAddCommandDetectionCapability: added.event
			}),
			runCommand: async (line, _execute, id) => send(line, id),
			sendText: async line => send(line, undefined),
			dispose: () => {
				closed = true;
				disposed.fire(instance);
			}
		});
		return {
			instance,
			sent,
			closed: () => closed,
			print: output => new Promise(resolve => raw.write(output, resolve)),
			integrate: () => {
				integrated = true;
				added.fire(detection);
			},
			finish: (id, exitCode = 0, output) => finished.fire(upcastPartial<ITerminalCommand>({ id, exitCode, getOutput: () => output })),
			exit: (exitCode, output) => {
				executing = upcastPartial<ITerminalCommand>({ getOutput: () => output });
				exited.fire(exitCode);
			},
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

	/** Resolves once the service took a step that starts with `prefix`. */
	async function stepTaken(prefix: string): Promise<void> {
		for (let turn = 0; turn < 1000 && !steps.some(step => step.startsWith(prefix)); turn++) {
			await timeout(0);
		}
	}

	/** The git extension's commands registered, as once it has started: a worktree made or deleted for an agent waits for them. */
	function gitIsRunning(): void {
		store.add(CommandsRegistry.registerCommand('_git.prepareWorktreeBaseAt', () => { }));
		store.add(CommandsRegistry.registerCommand('_git.deleteWorktreeAt', () => { }));
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
		links = new Map();
		shellIntegrationTimeout = 60000;
		setupShell = new DeferredPromise<ISetupTerminal>();
		terminals = [terminal('its terminal', '/home/me/.facade/worktrees/lab/w2/src'), terminal('another', '/lab')];
		editorAreaTerminals = [];
		trust = { enabled: false, trusted: true, granted: false };
		progressShown = [];
		unsaved = [];
		open = [];
		whenCommand = undefined;
		opened = [];
		workspaceFolders = [];
		onDisk = new Set(['/lab']);
		previousFolder = undefined;
		closing = [];
		repository = { kind: 'repository', main, folder: undefined, branch: 'main', members: [], worktrees: [{ uri: w2, branch: 'w2', label: 'w2', exists: true, folder: undefined }] };

		const restored = store.add(new Emitter<void>());
		registered = store.add(new Emitter<IWorkingCopy>());
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
			add: async uris => { steps.push(`add ${uris.map(uri => uri.path).join(', ')}${uris.some(uri => backgroundFolderChanges.isChanging(uri)) ? ', in the background' : ''}`); },
			setExpanded: uri => { steps.push(`open ${uri.path}`); },
			whenListed: async uri => { steps.push(`listed ${uri.path}`); },
			hideWorktree: uri => {
				steps.push(`hide ${uri.path}`);
				return toDisposable(() => steps.push(`unhide ${uri.path}`));
			}
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
		instantiationService.stub(IActiveFolderService, {
			activeFolder: upcastPartial<IWorkspaceFolder>({ uri: w2 }),
			get previousFolder() { return previousFolder && upcastPartial<IWorkspaceFolder>({ uri: previousFolder }); },
			setActiveFolder: async folder => { steps.push(`back to ${(URI.isUri(folder) ? folder : folder.uri).path}`); }
		});
		instantiationService.stub(ICommandService, {
			executeCommand: async <T>(id: string, ...args: unknown[]) => {
				steps.push(describeCommand(id, args));
				whenCommand?.(describeCommand(id, args));
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
		instantiationService.stub(IFolderTerminalsService, {
			terminalsOf: () => editorAreaTerminals,
			openFor: async folder => {
				steps.push(`hold setup under ${folder.path}`);
				const shell = setupTerminal();
				setupShell.complete(shell);
				return shell.instance;
			}
		});
		ptyProcesses = [];
		// As the pty host answers: the orphans alone, unless every one is asked for
		instantiationService.stub(ITerminalInstanceService, { getBackend: async () => upcastPartial<ITerminalBackend>({ listProcesses: async options => options?.attached ? ptyProcesses : ptyProcesses.filter(each => each.isOrphan) }) });
		instantiationService.stub(ITerminalService, {
			get instances() { return terminals; },
			createTerminal: async () => {
				const shell = setupTerminal();
				setupShell.complete(shell);
				return shell.instance;
			},
			setActiveInstance: () => { },
			revealTerminal: async () => { steps.push('reveal setup'); }
		});
		instantiationService.stub(IProgressService, {
			withProgress: async (options, task) => {
				progressShown.push(options.location as ProgressLocation);
				return task({ report: () => { } });
			}
		});
		instantiationService.stub(IFileService, {
			hasCapability: () => true,
			resolve: (() => Promise.reject(new Error('not there'))) as IFileService['resolve'],
			exists: async (uri: URI) => onDisk.has(uri.path),
			realpath: async (uri: URI) => {
				const link = [...links.keys()].find(each => uri.path.startsWith(`${each}/`));
				return link === undefined ? uri : URI.file(`${links.get(link)}${uri.path.slice(link.length)}`);
			},
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
			getUriTrustInfo: async uri => upcastPartial<IWorkspaceTrustUriInfo>({ uri, trusted: trust.repositoryTrusted ?? trust.trusted }),
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
		instantiationService.stub(IWorkingCopyService, {
			get dirtyWorkingCopies() { return unsaved; },
			get workingCopies() { return [...open, ...unsaved]; },
			onDidRegister: registered.event
		});
		instantiationService.stub(IFilesConfigurationService, {
			isReadonly: () => false,
			updateReadonly: (async (resources: URI | URI[], readonly: unknown) => {
				steps.push(`${readonly === 'reset' ? 'writable' : 'read-only'} ${[resources].flat().map(uri => uri.path).join(', ')}`);
			}) as IFilesConfigurationService['updateReadonly']
		});
		instantiationService.stub(IEditorService, {
			getEditors: () => opened.map(resource => upcastPartial<IEditorIdentifier>({ editor: upcastPartial<EditorInput>({ resource }), groupId: 1 })),
			closeEditors: (async (editors: readonly IEditorIdentifier[]) => {
				steps.push(`close editors ${editors.map(({ editor }) => editor.resource?.path).join(', ')}`);
			}) as IEditorService['closeEditors']
		});
		instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => upcastPartial<IWorkspace>({ folders: workspaceFolders.map(uri => upcastPartial<IWorkspaceFolder>({ uri })) }) });
		instantiationService.stub(IFacadeRunsService, { closingBecause: (instance, reason) => { closing.push(`${instance.title} ${reason}`); } });
		backgroundFolderChanges = instantiationService.createInstance(BackgroundFolderChangesService);
		instantiationService.stub(IBackgroundFolderChangesService, backgroundFolderChanges);
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

	test('made without asking, for an agent: no dialog, from the commit it is given, its row there, and the window left where it is - its repository row not opened, which the person may have collapsed (XS-06)', async () => {
		gitIsRunning();
		trust.enabled = true;
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		const commit = 'a'.repeat(40);

		const made = await instantiationService.createInstance(WorktreeService).makeWorktree(main, ' w3 ', { startPoint: commit });

		assert.deepStrictEqual({ made: made.worktree.path, steps }, {
			made: '/home/me/.facade/worktrees/lab/w3',
			steps: [
				'_git.prepareWorktreeBaseAt /lab inspect',
				'customize /home/me/.facade/worktrees/lab/w3 {}',
				`_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w3 w3 ${commit}`,
				'trust /home/me/.facade/worktrees/lab/w3',
				'listed /home/me/.facade/worktrees/lab/w3',
			],
		});
	});

	test('made without asking, it is answered once its setup has started, in a terminal held under its row and not shown; how the setup came out is asked for apart - the first line that failed, its exit code and output, once the last has finished (WT-5.11)', async () => {
		gitIsRunning();
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		files.set(`${w3.path}/.facade/worktrees.json`, '{ "setup-worktree": ["npm ci", "npm run build"] }');
		const service = instantiationService.createInstance(WorktreeService);

		const making = service.makeWorktree(main, 'w3');
		const shell = await setupShell.p;
		const made = await making;
		let outcome: unknown = 'not yet';
		const asking = service.setupOutcome(made.worktree).then(result => outcome = result);
		shell.integrate();
		await shell.whenSent(1);
		shell.finish(shell.sent[0].id, 3, 'npm ERR! missing script');
		await shell.whenSent(2);
		await timeout(0);
		const beforeTheLastFinished = outcome;
		shell.finish(shell.sent[1].id, 0);
		await asking;

		assert.deepStrictEqual({ made: made.worktree.path, beforeTheLastFinished, outcome, sent: sentLines(shell), terminal: steps.filter(step => step.includes('setup')) }, {
			made: '/home/me/.facade/worktrees/lab/w3',
			beforeTheLastFinished: 'not yet',
			outcome: { kind: 'failed', line: 'npm ci', exitCode: 3, output: 'npm ERR! missing script' },
			sent: ['run npm ci', 'run npm run build'],
			terminal: ['hold setup under /home/me/.facade/worktrees/lab/w3'],
		});
	});

	test('a setup line that ends its shell - its `exit 7` - ends with it: the setup failed on it, with the shell\'s code and the line\'s output; one that exits 0 before the last line failed too, the lines after it not run (AS-33)', async () => {
		gitIsRunning();
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		answers.set('_git.createWorktreeAt w4', { kind: 'created', copyFailures: [], hookFailure: undefined });
		const service = instantiationService.createInstance(WorktreeService);
		const outcomeOfSetup = async (branch: string, lines: string[], exitCode: number, output: string) => {
			setupShell = new DeferredPromise<ISetupTerminal>();
			files.set(`/home/me/.facade/worktrees/lab/${branch}/.facade/worktrees.json`, JSON.stringify({ 'setup-worktree': lines }));
			const made = await service.makeWorktree(main, branch);
			const shell = await setupShell.p;
			const asking = service.setupOutcome(made.worktree);
			shell.integrate();
			await shell.whenSent(1);
			shell.exit(exitCode, output);
			return { outcome: await asking, sent: sentLines(shell) };
		};

		assert.deepStrictEqual({
			seven: await outcomeOfSetup('w3', ['echo set up; exit 7', 'npm ci'], 7, 'set up'),
			zero: await outcomeOfSetup('w4', ['exit 0', 'npm ci'], 0, '')
		}, {
			seven: { outcome: { kind: 'failed', line: 'echo set up; exit 7', exitCode: 7, output: 'set up\nThe shell ended with this line: the lines after it did not run.' }, sent: ['run echo set up; exit 7'] },
			zero: { outcome: { kind: 'failed', line: 'exit 0', exitCode: 0, output: 'The shell ended with this line: the lines after it did not run.' }, sent: ['run exit 0'] }
		});
	});

	test('made without asking, its setup can be looked at as it runs, for the caller waiting on it: the line running, where shell integration says when each finishes, and the last 20 lines of its terminal as plain text - one the terminal wraps read whole, a blank one kept, the empty rows below dropped; nothing where the window knows no setup of it (O3, O4; OR-03)', async () => {
		gitIsRunning();
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		answers.set('_git.createWorktreeAt w4', { kind: 'created', copyFailures: [], hookFailure: undefined });
		files.set(`${w3.path}/.facade/worktrees.json`, '{ "setup-worktree": ["npm ci", "npm run build"] }');
		const service = instantiationService.createInstance(WorktreeService);

		const made = await service.makeWorktree(main, 'w3');
		const shell = await setupShell.p;
		const opened = service.setupState(made.worktree);
		shell.integrate();
		await shell.whenSent(1);
		// More lines than are read, a blank one, one wider than the terminal, and the prompt's empty rows below
		await shell.print([...[...Array(22).keys()].map(count => `added ${count} packages`), '', 'npm warn deprecated left-pad@1.3.0', '', ''].join('\r\n'));
		const running = service.setupState(made.worktree);
		const outcome = service.setupOutcome(made.worktree);
		shell.finish(shell.sent[0].id, 0);
		await shell.whenSent(2);
		const between = service.setupState(made.worktree)?.running;
		shell.finish(shell.sent[1].id, 0);
		await outcome;
		// A worktree with nothing to set up
		const none = await service.makeWorktree(main, 'w4');

		assert.deepStrictEqual({ opened, running, between, outcomeTaken: service.setupState(made.worktree), none: service.setupState(none.worktree), unknown: service.setupState(URI.file('/elsewhere')) }, {
			opened: { lines: [] },
			running: { running: 'npm ci', lines: [...[...Array(18).keys()].map(count => `added ${count + 4} packages`), '', 'npm warn deprecated left-pad@1.3.0'] },
			between: 'npm run build',
			outcomeTaken: undefined,
			none: undefined,
			unknown: undefined
		});
	});

	test('an agent\'s worktree: setup that went well is said so; without shell integration, its lines sent and their completion unknown; one stopped - its start cancelled - closes its terminal; what could not be copied and a failed hook are answered, not shown to the person, and no notification says it is being made', async () => {
		gitIsRunning();
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: ['x.secret'], hookFailure: 'the hook says no' });
		files.set(`${w3.path}/.facade/worktrees.json`, '{ "setup-worktree": ["npm ci"] }');
		const service = instantiationService.createInstance(WorktreeService);

		const made = await service.makeWorktree(main, 'w3');
		const shell = await setupShell.p;
		shell.integrate();
		await shell.whenSent(1);
		shell.finish(shell.sent[0].id, 0);
		const succeeded = await service.setupOutcome(made.worktree);

		shellIntegrationTimeout = 0;
		setupShell = new DeferredPromise();
		const typed = await service.makeWorktree(main, 'w3');
		const typedShell = await setupShell.p;
		await typedShell.whenSent(1);
		const submitted = await service.setupOutcome(typed.worktree);

		setupShell = new DeferredPromise();
		shellIntegrationTimeout = 60_000;
		const cancelled = await service.makeWorktree(main, 'w3');
		const cancelledShell = await setupShell.p;
		service.stopSetup(cancelled.worktree);
		const stopped = await service.setupOutcome(cancelled.worktree);

		assert.deepStrictEqual({ copyFailures: made.copyFailures, hookFailure: made.hookFailure, succeeded, submitted, stopped, closed: cancelledShell.closed(), warned: steps.filter(step => step.startsWith('warn')), progress: progressShown }, {
			copyFailures: ['x.secret'],
			hookFailure: 'the hook says no',
			succeeded: { kind: 'succeeded' },
			submitted: { kind: 'submitted' },
			stopped: { kind: 'stopped' },
			closed: true,
			warned: [],
			progress: [],
		});
	});

	test('made without asking, what would have been asked is refused instead: no branch, a name that is no folder, trust, no repository or no commit yet, a branch or a folder that is there', async () => {
		gitIsRunning();
		const service = instantiationService.createInstance(WorktreeService);
		const attempt = (branch: string) => service.makeWorktree(main, branch).then(() => 'made', (err: Error) => err.message);
		const noBranch = await attempt('  ');
		const notAFolder = await attempt('con');
		trust.enabled = true;
		trust.trusted = false;
		const restricted = await attempt('w3');
		trust.trusted = true;
		trust.repositoryTrusted = false;
		const untrusted = await attempt('w3');
		trust.repositoryTrusted = true;
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'uninitialized', files: 2, identity: true, enclosing: undefined });
		const notARepository = await attempt('w3');
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'unborn', files: 2, identity: true });
		const unborn = await attempt('w3');
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w2', { kind: 'error', code: 'BranchAlreadyExists', message: 'fatal: a branch named w2 already exists' });
		const branchTaken = await attempt('w2');
		answers.set('_git.createWorktreeAt w5', { kind: 'error', code: 'WorktreeAlreadyExists', message: 'fatal: already exists' });
		const folderTaken = await attempt('w5');

		assert.deepStrictEqual({ noBranch, notAFolder, restricted, untrusted, notARepository, unborn, branchTaken, folderTaken, asked: steps.filter(step => step === 'ask' || step === 'ask for trust' || step.startsWith('prompt')) }, {
			noBranch: 'A worktree needs the name of its branch.',
			notAFolder: '"con" cannot be the name of a folder on Windows.',
			restricted: 'The workspace is in Restricted Mode, where Git does not run. Trust the workspace first.',
			untrusted: '/lab is not trusted, and a worktree of it would be. Trust /lab first.',
			notARepository: '"lab" is not a Git repository. Make it one first.',
			unborn: '"lab" has no commit for a worktree to branch off from. Make its first commit first.',
			branchTaken: 'A branch named w2 already exists. Choose another name.',
			folderTaken: 'Something is already at /home/me/.facade/worktrees/lab/w5.',
			asked: [],
		});
	});

	test('a worktree Git could not check out, whose branch it had made and could not take back, says so by name - made for an agent or by New Worktree: the branch is there, its name taken (O4; OR-07)', async () => {
		gitIsRunning();
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'error', code: undefined, message: 'could not write index: No space left on device', branchKept: 'w3' });
		answer = { branch: 'w3', customization: {} };
		const service = instantiationService.createInstance(WorktreeService);

		const forAnAgent = await service.makeWorktree(main, 'w3').then(() => 'made', (err: Error) => err.message);
		await service.createWorktree(main);

		assert.deepStrictEqual({ forAnAgent, forThePerson: steps.filter(step => step.startsWith('error: ')) }, {
			forAnAgent: 'The worktree could not be made: could not write index: No space left on device. Git had made its branch w3 already, which is kept: delete it, or choose another name.',
			forThePerson: ['error: The worktree could not be made: could not write index: No space left on device. Git had made its branch w3 already, which is kept: delete it, or choose another name.'],
		});
	});

	test('made without asking while Git is still starting, it waits for Git, as New Worktree does once trust is given; Git that does not start is said not to run', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		const service = instantiationService.createInstance(WorktreeService);

		const starting = service.makeWorktree(main, 'w3');
		await timeout(10);
		steps.push('git registers its commands');
		const registered = CommandsRegistry.registerCommand('_git.prepareWorktreeBaseAt', () => { });
		const made = await starting;
		registered.dispose();
		const whileStarting = steps.splice(0, 2);
		missingCommands.add('_git.prepareWorktreeBaseAt');
		const notRunning = await service.makeWorktree(main, 'w4').then(() => 'made', (err: Error) => err.message);

		assert.deepStrictEqual({ made: made.worktree.path, whileStarting, notRunning }, {
			made: '/home/me/.facade/worktrees/lab/w3',
			whileStarting: ['git registers its commands', '_git.prepareWorktreeBaseAt /lab inspect'],
			notRunning: 'Worktrees are made and deleted with the Git extension, which is not running in this window.',
		});
	}));

	test('made without asking, two at once in one repository: the second waits for the first, and neither is refused', async () => {
		gitIsRunning();
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		const makingW3 = new DeferredPromise<unknown>();
		answers.set('_git.createWorktreeAt w3', makingW3.p);
		answers.set('_git.createWorktreeAt w4', { kind: 'created', copyFailures: [], hookFailure: undefined });
		const service = instantiationService.createInstance(WorktreeService);
		const made = () => steps.filter(step => step.startsWith('_git.createWorktreeAt'));

		const first = service.makeWorktree(main, 'w3');
		const second = service.makeWorktree(main, 'w4').then(made => made.worktree.path, (err: Error) => err.message);
		await stepTaken('_git.createWorktreeAt');
		await timeout(0);
		const whileW3IsMade = made();
		makingW3.complete({ kind: 'created', copyFailures: [], hookFailure: undefined });

		assert.deepStrictEqual({ first: (await first).worktree.path, second: await second, whileW3IsMade, made: made() }, {
			first: '/home/me/.facade/worktrees/lab/w3',
			second: '/home/me/.facade/worktrees/lab/w4',
			whileW3IsMade: ['_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w3 w3'],
			made: [
				'_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w3 w3',
				'_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w4 w4',
			],
		});
	});

	test('New Worktree while a worktree is made for an agent in its repository goes once that one is made, rather than doing nothing', async () => {
		gitIsRunning();
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		const makingW3 = new DeferredPromise<unknown>();
		answers.set('_git.createWorktreeAt w3', makingW3.p);
		answers.set('_git.createWorktreeAt w4', { kind: 'created', copyFailures: [], hookFailure: undefined });
		answer = { branch: 'w4', customization: {} };
		const service = instantiationService.createInstance(WorktreeService);

		const agents = service.makeWorktree(main, 'w3');
		await stepTaken('_git.createWorktreeAt');
		const persons = service.createWorktree(main);
		await timeout(0);
		const askedWhileW3IsMade = steps.includes('ask');
		makingW3.complete({ kind: 'created', copyFailures: [], hookFailure: undefined });
		await agents;
		await persons;

		assert.deepStrictEqual({ askedWhileW3IsMade, asked: steps.filter(step => step === 'ask').length, made: steps.filter(step => step.startsWith('_git.createWorktreeAt')) }, {
			askedWhileW3IsMade: false,
			asked: 1,
			made: [
				'_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w3 w3',
				'_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w4 w4',
			],
		});
	});

	test('a second New Worktree while the person\'s first is going does nothing, as a second click on a row that is being worked on', async () => {
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		const makingW3 = new DeferredPromise<unknown>();
		answers.set('_git.createWorktreeAt w3', makingW3.p);
		answer = { branch: 'w3', customization: {} };
		const service = instantiationService.createInstance(WorktreeService);

		const first = service.createWorktree(main);
		await stepTaken('_git.createWorktreeAt');
		await service.createWorktree(main);
		makingW3.complete({ kind: 'created', copyFailures: [], hookFailure: undefined });
		await first;

		assert.deepStrictEqual({ asked: steps.filter(step => step === 'ask').length, made: steps.filter(step => step.startsWith('_git.createWorktreeAt')).length }, { asked: 1, made: 1 });
	});

	test('the person\'s New Worktree holds its repository\'s queue only while Git makes the worktree: an agent\'s asked for while its dialog is open is made at once, and the person\'s, created meanwhile, waits its turn; a second New Worktree while the dialog is open does nothing (O4; OR-06)', async () => {
		gitIsRunning();
		answers.set('_git.prepareWorktreeBaseAt inspect', { kind: 'ready' });
		const makingW4 = new DeferredPromise<unknown>();
		answers.set('_git.createWorktreeAt w4', makingW4.p);
		answers.set('_git.createWorktreeAt w3', { kind: 'created', copyFailures: [], hookFailure: undefined });
		// The person takes their time choosing a name
		const named = new DeferredPromise<INewWorktreeAnswer | undefined>();
		instantiationService.stub(IWorkspaceBarDialogService, {
			showNewWorktreeDialog: async () => {
				steps.push('ask');
				return named.p;
			}
		});
		const service = instantiationService.createInstance(WorktreeService);
		const made = () => steps.filter(step => step === 'ask' || step.startsWith('_git.createWorktreeAt'));

		const persons = service.createWorktree(main);
		await stepTaken('ask');
		await service.createWorktree(main);
		const agents = service.makeWorktree(main, 'w4');
		await stepTaken('_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w4');
		const whileTheDialogIsOpen = made();
		named.complete({ branch: 'w3', customization: {} });
		// The person's w3 is not made while w4 is: a few turns for the service to go on, there being no step to wait for
		for (let turn = 0; turn < 10; turn++) {
			await timeout(0);
		}
		const whileW4IsMade = made();
		makingW4.complete({ kind: 'created', copyFailures: [], hookFailure: undefined });
		await agents;
		await persons;

		assert.deepStrictEqual({ whileTheDialogIsOpen, whileW4IsMade, made: made() }, {
			whileTheDialogIsOpen: ['ask', '_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w4 w4'],
			whileW4IsMade: ['ask', '_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w4 w4'],
			made: ['ask', '_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w4 w4', '_git.createWorktreeAt /lab /home/me/.facade/worktrees/lab/w3 w3'],
		});
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

	test('deleting one with changes: asked first, then off it and its row gone, out of folders[], its terminals closed and only then git, with force; its name, colour, place and trust go with it', async () => {
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
				'hide /home/me/.facade/worktrees/lab/w2',
				'_facade.agents.worktreeDeleting /home/me/.facade/worktrees/lab/w2',
				'remove /home/me/.facade/worktrees/lab/w2',
				'close its terminal',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 force',
				'unhide /home/me/.facade/worktrees/lab/w2',
				'_facade.agents.worktreeDeleted /home/me/.facade/worktrees/lab/w2',
				'customize /home/me/.facade/worktrees/lab/w2 {}',
				'order /home/me/.facade/worktrees/lab/w3',
				'untrust /home/me/.facade/worktrees/lab/w2',
			],
			type: 'warning',
			detail: true,
		});
	});

	test('deleted without asking, for an agent: nothing asked, then off it and its row gone, out of folders[], its terminals closed and only then git, with force for the changes it was told to discard; its name, colour, place and trust go with it; its progress in the status bar', async () => {
		gitIsRunning();
		trust.enabled = true;
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['a.txt'], submodules: false });
		answers.set('_git.deleteWorktreeAt force', { kind: 'removed' });
		savedOrder = [w2, w3];

		await instantiationService.createInstance(WorktreeService).removeWorktree(w2, { discardChanges: true });

		assert.deepStrictEqual({ steps, progressShown }, {
			steps: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'show /lab',
				'hide /home/me/.facade/worktrees/lab/w2',
				'remove /home/me/.facade/worktrees/lab/w2',
				'close its terminal',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 force',
				'unhide /home/me/.facade/worktrees/lab/w2',
				'_facade.agents.worktreeDeleted /home/me/.facade/worktrees/lab/w2',
				'customize /home/me/.facade/worktrees/lab/w2 {}',
				'order /home/me/.facade/worktrees/lab/w3',
				'untrust /home/me/.facade/worktrees/lab/w2',
			],
			progressShown: [ProgressLocation.Window],
		});
	});

	test('the window on the worktree an agent deletes goes to its repository\'s folder; with that folder gone, back to the folder the person was on before; with none, to its neighbour as it leaves folders[] (O5; OR-27)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		const deleteIt = async () => {
			steps = [];
			await instantiationService.createInstance(WorktreeService).removeWorktree(w2);
			// The first two after its looks
			return steps.filter(step => !step.startsWith('_git')).slice(0, 2);
		};

		const owned = await deleteIt();
		previousFolder = URI.file('/other');
		const ownerToo = await deleteIt();
		onDisk.delete('/lab');
		const ownerGone = await deleteIt();
		previousFolder = undefined;
		const both = await deleteIt();

		assert.deepStrictEqual({ owned, ownerToo, ownerGone, both }, {
			owned: ['show /lab', 'hide /home/me/.facade/worktrees/lab/w2'],
			ownerToo: ['show /lab', 'hide /home/me/.facade/worktrees/lab/w2'],
			ownerGone: ['back to /other', 'hide /home/me/.facade/worktrees/lab/w2'],
			both: ['hide /home/me/.facade/worktrees/lab/w2', 'remove /home/me/.facade/worktrees/lab/w2']
		});
	});

	test('deleted without asking, changes git would lose that it was not told to discard refuse it, listed, with nothing done - all but the caller\'s own files, which go with it by force', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json', 'build/out.js'], submodules: false });
		answers.set('_git.deleteWorktreeAt force', { kind: 'removed' });
		const service = instantiationService.createInstance(WorktreeService);
		files.set('/home/me/.facade/worktrees/lab/w2/.mcp.json', '{}');
		const ownFiles = [{ path: '.mcp.json', sha256: SHA256_OF_EMPTY_OBJECT }];
		const refused = await service.removeWorktree(w2, { ownFiles }).then(() => 'deleted', (err: Error) => err.message);
		const stepsWhenRefused = [...steps];
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json'], submodules: false });
		await service.removeWorktree(w2, { ownFiles });

		assert.deepStrictEqual({ refused, stepsWhenRefused, deletedBy: steps.filter(step => step.startsWith('_git.deleteWorktreeAt') && !step.endsWith('check')) }, {
			refused: '/home/me/.facade/worktrees/lab/w2 has changes that deleting it would lose: build/out.js. Nothing was deleted.',
			stepsWhenRefused: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check'],
			deletedBy: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 force']
		});
	});

	test('deleted without asking, a file the caller put there is its own only as it wrote it: changed since, by its hash, it is the person\'s work, and refuses it (X-73)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json'], submodules: false });
		files.set('/home/me/.facade/worktrees/lab/w2/.mcp.json', '{"mcpServers":{"docs":{}}}');

		const refused = await instantiationService.createInstance(WorktreeService).removeWorktree(w2, { ownFiles: [{ path: '.mcp.json', sha256: SHA256_OF_EMPTY_OBJECT }] }).then(() => 'deleted', (err: Error) => err.message);

		assert.deepStrictEqual({ refused, steps }, {
			refused: '/home/me/.facade/worktrees/lab/w2 has changes that deleting it would lose: .mcp.json. Nothing was deleted.',
			steps: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check']
		});
	});

	test('deleted without asking, unsaved editors of its files and its submodules refuse it, named, with nothing done; told to discard, the editors are closed without saving before anything could ask to save them, and it goes by force (X-14, X-73)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt force', { kind: 'removed' });
		unsaved = [unsavedFile('/home/me/.facade/worktrees/lab/w2/src/a.ts'), unsavedFile('/elsewhere/b.ts')];
		const service = instantiationService.createInstance(WorktreeService);
		const attempt = (options: IRemoveWorktreeOptions) => service.removeWorktree(w2, options).then(() => 'deleted', (err: Error) => err.message);
		const editors = await attempt({});
		unsaved = unsaved.slice(1);
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: true });
		const submodules = await attempt({});
		const refusedSteps = [...steps];
		steps = [];
		opened = [];
		unsaved = [unsavedFile('/home/me/.facade/worktrees/lab/w2/src/a.ts')];
		const discarded = await attempt({ discardChanges: true });

		assert.deepStrictEqual({ editors, submodules, refusedSteps, discarded, steps }, {
			editors: '/home/me/.facade/worktrees/lab/w2 has changes that deleting it would lose: src/a.ts (unsaved). Nothing was deleted.',
			submodules: '/home/me/.facade/worktrees/lab/w2 has submodules, which would go with it with any of their commits not pushed. Nothing was deleted.',
			refusedSteps: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check', '_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check'],
			discarded: 'deleted',
			steps: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'revert /home/me/.facade/worktrees/lab/w2/src/a.ts',
				'close editors /home/me/.facade/worktrees/lab/w2/src/a.ts',
				'show /lab',
				'hide /home/me/.facade/worktrees/lab/w2',
				'remove /home/me/.facade/worktrees/lab/w2',
				'close its terminal',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 force',
				'unhide /home/me/.facade/worktrees/lab/w2',
				'_facade.agents.worktreeDeleted /home/me/.facade/worktrees/lab/w2',
				'customize /home/me/.facade/worktrees/lab/w2 {}',
			]
		});
	});

	test('an unsaved editor of a file of the worktree opened through a link to it is the worktree\'s by its real path: it refuses a deletion, named, and told to discard, it is closed without saving (X-71; SP-25)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		// Nothing but the unsaved editor, discarded: git's own remove, no force
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		links.set('/tmp/link', '/home/me/.facade/worktrees/lab/w2');
		unsaved = [unsavedFile('/tmp/link/README.md')];
		const service = instantiationService.createInstance(WorktreeService);
		const refused = await service.removeWorktree(w2, {}).then(() => 'deleted', (err: Error) => err.message);
		// The same editor, unsaved again
		steps = [];
		opened = [];
		unsaved = [unsavedFile('/tmp/link/README.md')];
		await service.removeWorktree(w2, { discardChanges: true });

		assert.deepStrictEqual({ refused, discarded: steps.filter(step => step.startsWith('revert') || step.startsWith('close editors')) }, {
			refused: '/home/me/.facade/worktrees/lab/w2 has changes that deleting it would lose: README.md (unsaved). Nothing was deleted.',
			discarded: ['revert /tmp/link/README.md', 'close editors /tmp/link/README.md']
		});
	});

	test('deleted without asking, it can be looked at first - for an agent\'s deletion, before any agent is stopped - which names what deleting it would lose as its refusal names it, the caller\'s own files as it wrote them going with it, and does nothing else: nothing stopped, closed, moved or removed (O5 step 2; OR-04)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json', 'build/out.js'], submodules: true });
		files.set('/home/me/.facade/worktrees/lab/w2/.mcp.json', '{}');
		const ownFiles = [{ path: '.mcp.json', sha256: SHA256_OF_EMPTY_OBJECT }];
		// The person is on the worktree, an image of it unsaved in its editor and a dev server running in it
		workspaceFolders = [main, w2];
		unsaved = [unsavedFile('/home/me/.facade/worktrees/lab/w2/logo.png')];
		terminals = [terminal('npm run dev', '/home/me/.facade/worktrees/lab/w2', { running: true })];
		const service = instantiationService.createInstance(WorktreeService);
		const loss = await service.removalLoss(w2, { ownFiles });
		const lookSteps = steps.splice(0);
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json'], submodules: false });
		unsaved = [];
		const nothing = await service.removalLoss(w2, { ownFiles });
		const mainCheckout = await service.removalLoss(main).then(() => 'looked', (err: Error) => err.message);

		assert.deepStrictEqual({ loss, lookSteps, nothing, mainCheckout }, {
			loss: ['build/out.js', 'logo.png (unsaved)', 'its submodules (with any of their commits not pushed)'],
			lookSteps: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check'],
			nothing: [],
			mainCheckout: '/lab is its repository\'s main checkout, which is never deleted.'
		});
	});

	test('deleted without asking, it is looked at once more before anything is moved, closed or removed: a file come meanwhile, an unsaved edit, or the person\'s edit to a file the caller put there, keep it - nothing lost, nothing asked, and nothing done (X-73; XS-07)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json'], submodules: false });
		answers.set('_git.deleteWorktreeAt force', { kind: 'removed' });
		files.set('/home/me/.facade/worktrees/lab/w2/.mcp.json', '{}');
		workspaceFolders = [main, w2];
		// Between the first look and the last, the person types into an editor of it and edits Facade's own file, and a file comes
		let looks = 0;
		whenCommand = command => {
			if (command.endsWith(' check') && ++looks === 2) {
				unsaved = [unsavedFile('/home/me/.facade/worktrees/lab/w2/src/a.ts')];
				files.set('/home/me/.facade/worktrees/lab/w2/.mcp.json', '{"mcpServers":{"docs":{}}}');
				answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json', 'late.txt'], submodules: false });
			}
		};

		const refused = await instantiationService.createInstance(WorktreeService).removeWorktree(w2, { ownFiles: [{ path: '.mcp.json', sha256: SHA256_OF_EMPTY_OBJECT }] }).then(() => 'deleted', (err: Error) => err.message);

		assert.deepStrictEqual({ refused, steps }, {
			refused: '/home/me/.facade/worktrees/lab/w2 was not deleted: changes came into it as it was being deleted, which deleting it would lose: .mcp.json, late.txt, src/a.ts (unsaved).',
			steps: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
			]
		});
	});

	test('deleted without asking, a deletion refused at its last look, or for an agent the call did not stop, leaves the person\'s window as it was: still on the worktree, its folder, row, terminals and editors untouched - it is decided before anything is moved, closed or removed (XS-07)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		// The person is on the worktree, with an editor of it open and a dev server running in it
		workspaceFolders = [main, w2];
		open = [upcastPartial<IWorkingCopy>({ resource: URI.file('/home/me/.facade/worktrees/lab/w2/src/a.ts') })];
		terminals = [terminal('npm run dev', '/home/me/.facade/worktrees/lab/w2', { running: true })];
		const service = instantiationService.createInstance(WorktreeService);
		const attempt = () => service.removeWorktree(w2, { runs: [] }).then(() => 'deleted', (err: Error) => err.message);
		// A file comes as it is looked at the last time
		let looks = 0;
		whenCommand = command => {
			if (command.endsWith(' check') && ++looks === 2) {
				answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['late.txt'], submodules: false });
			}
		};
		const lastLook = await attempt();
		const lastLookSteps = steps.splice(0);
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		whenCommand = undefined;
		terminals = [...terminals, terminal('@x #a3', '/home/me/.facade/worktrees/lab/w2/src', { run: { workspace: 'record', id: 3 } })];
		const agentInside = await attempt();

		assert.deepStrictEqual({ lastLook, lastLookSteps, agentInside, agentInsideSteps: steps }, {
			lastLook: '/home/me/.facade/worktrees/lab/w2 was not deleted: changes came into it as it was being deleted, which deleting it would lose: late.txt.',
			lastLookSteps: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'read-only /home/me/.facade/worktrees/lab/w2/src/a.ts',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'writable /home/me/.facade/worktrees/lab/w2/src/a.ts',
			],
			agentInside: '/home/me/.facade/worktrees/lab/w2 was not deleted: an agent the call did not stop is working inside it, in @x #a3. Stop it first.',
			agentInsideSteps: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check'],
		});
	});

	test('deleted without asking, its files open in the window are read-only from the last look to git\'s end - one opened meanwhile too - and then as they were: nothing typed into one after the look goes unseen (N-41)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		const file = (path: string) => upcastPartial<IWorkingCopy>({ resource: URI.file(path) });
		open = [file('/home/me/.facade/worktrees/lab/w2/src/a.ts'), file('/lab/elsewhere.ts')];
		// The person opens another of its files as git deletes it
		whenCommand = command => {
			if (command.endsWith(' remove')) {
				registered.fire(file('/home/me/.facade/worktrees/lab/w2/b.ts'));
			}
		};

		await instantiationService.createInstance(WorktreeService).removeWorktree(w2, {});

		assert.deepStrictEqual(steps, [
			'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
			'read-only /home/me/.facade/worktrees/lab/w2/src/a.ts',
			'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
			'show /lab',
			'hide /home/me/.facade/worktrees/lab/w2',
			'remove /home/me/.facade/worktrees/lab/w2',
			'close its terminal',
			'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 remove',
			'read-only /home/me/.facade/worktrees/lab/w2/b.ts',
			'writable /home/me/.facade/worktrees/lab/w2/src/a.ts, /home/me/.facade/worktrees/lab/w2/b.ts',
			'unhide /home/me/.facade/worktrees/lab/w2',
			'_facade.agents.worktreeDeleted /home/me/.facade/worktrees/lab/w2',
			'customize /home/me/.facade/worktrees/lab/w2 {}'
		]);
	});

	test('deleted without asking, it closes the terminals of the agents the caller stopped, and the person\'s; another agent still working inside it - wherever it was started - refuses it, named, with no terminal closed (X-74)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		const stopped = { workspace: 'record', id: 2 };
		terminals = [
			terminal('@b1 #a2', '/home/me/.facade/worktrees/lab/w2', { run: stopped }),
			terminal('@x #a3', '/home/me/.facade/worktrees/lab/w2/src', { run: { workspace: 'record', id: 3 } }),
			terminal('@old #a1', '/home/me/.facade/worktrees/lab/w2', { run: { workspace: 'record', id: 1 }, exitCode: 0 }),
			terminal('zsh', '/home/me/.facade/worktrees/lab/w2'),
		];
		const service = instantiationService.createInstance(WorktreeService);
		const refused = await service.removeWorktree(w2, { runs: [stopped] }).then(() => 'deleted', (err: Error) => err.message);
		const refusedSteps = steps.filter(step => step.startsWith('close') || step.startsWith('_git'));
		steps = [];
		const deleted = await service.removeWorktree(w2, { runs: [stopped, { workspace: 'record', id: 3 }] }).then(() => 'deleted', (err: Error) => err.message);

		assert.deepStrictEqual({ refused, refusedSteps, deleted, closed: steps.filter(step => step.startsWith('close')) }, {
			refused: '/home/me/.facade/worktrees/lab/w2 was not deleted: an agent the call did not stop is working inside it, in @x #a3. Stop it first.',
			refusedSteps: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check'],
			deleted: 'deleted',
			closed: ['close @b1 #a2', 'close @x #a3', 'close @old #a1', 'close zsh']
		});
	});

	test('deleted without asking while the bar lists no worktrees, and so knows no repository: by the main checkout the caller read from git; without it, it is no worktree the workspace knows, and the main checkout itself is never deleted (X-41)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		instantiationService.stub(IWorkspaceBarService, 'repositoryFor', () => undefined);
		const service = instantiationService.createInstance(WorktreeService);
		const attempt = (target: URI, options: IRemoveWorktreeOptions) => service.removeWorktree(target, options).then(() => 'deleted', (err: Error) => err.message);

		assert.deepStrictEqual({
			unknown: await attempt(w2, {}),
			mainCheckout: await attempt(main, { main }),
			deleted: await attempt(w2, { main }),
			git: steps.filter(step => step.startsWith('_git')),
		}, {
			unknown: '/home/me/.facade/worktrees/lab/w2 is not a worktree the workspace knows.',
			mainCheckout: '/lab is its repository\'s main checkout, which is never deleted.',
			deleted: 'deleted',
			git: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check', '_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check', '_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 remove'],
		});
	});

	test('deleted without asking, it is refused with why: a main checkout, which is never deleted, a folder that is no worktree, and Restricted Mode; one git will not delete comes back to its row, said in the product\'s words and nowhere else', async () => {
		gitIsRunning();
		const service = instantiationService.createInstance(WorktreeService);
		const attempt = (target: URI) => service.removeWorktree(target).then(() => 'deleted', (err: Error) => err.message);
		const mainCheckout = await attempt(main);
		const notAWorktree = await attempt(URI.file('/notes'));
		trust.enabled = true;
		trust.trusted = false;
		const restricted = await attempt(w2);
		trust.trusted = true;
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'error', code: undefined, message: 'fatal: the directory is busy' });
		const busy = await attempt(w2);

		assert.deepStrictEqual({ mainCheckout, notAWorktree, restricted, busy, steps }, {
			mainCheckout: '/lab is its repository\'s main checkout, which is never deleted.',
			notAWorktree: '/notes is not a worktree the workspace knows.',
			restricted: 'The workspace is in Restricted Mode, where Git does not run. Trust the workspace first.',
			busy: 'The worktree could not be deleted: fatal: the directory is busy',
			steps: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'show /lab',
				'hide /home/me/.facade/worktrees/lab/w2',
				'remove /home/me/.facade/worktrees/lab/w2',
				'close its terminal',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 remove',
				'unhide /home/me/.facade/worktrees/lab/w2',
			],
		});
	});

	test('deleted without asking, one Git does not delete after the cleanup is put back as far as it can be - in the workspace, in the background, and the window on it, as they were - and the answer names what cannot be: the terminals closed for it, whose processes ended; one Git let go of part way, no worktree any more, stays out (O5; OR-11)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'error', code: undefined, message: 'cannot remove a locked working tree' });
		const stopped = { workspace: 'record', id: 3 };
		// The person is on the worktree, a dev server running in it; the agent the caller stopped there has ended
		workspaceFolders = [main, w2];
		onDisk.add(w2.path);
		const deleteIt = async () => {
			terminals = [terminal('npm run dev', w2.path, { running: true }), terminal('@x #a3', `${w2.path}/src`, { run: stopped, exitCode: 0 })];
			const why = await instantiationService.createInstance(WorktreeService).removeWorktree(w2, { runs: [stopped] }).then(() => 'deleted', (err: Error) => err.message);
			return { why, steps: steps.splice(0).filter(step => !step.startsWith('_git')) };
		};
		const refused = await deleteIt();
		answers.set('_git.deleteWorktreeAt remove', { kind: 'error', code: undefined, message: 'Permission denied', partial: true });
		const partly = await deleteIt();

		const cleanup = ['show /lab', 'hide /home/me/.facade/worktrees/lab/w2', 'remove /home/me/.facade/worktrees/lab/w2', 'close npm run dev', 'close @x #a3', 'unhide /home/me/.facade/worktrees/lab/w2'];
		assert.deepStrictEqual({ refused, partly }, {
			refused: {
				why: 'The worktree could not be deleted: cannot remove a locked working tree\nThe terminals working in it were closed for the deletion, which ended what ran in them: npm run dev.',
				steps: [...cleanup, 'add /home/me/.facade/worktrees/lab/w2, in the background', 'back to /home/me/.facade/worktrees/lab/w2'],
			},
			partly: {
				why: 'The worktree could not be deleted: Permission denied\nThe terminals working in it were closed for the deletion, which ended what ran in them: npm run dev.',
				steps: cleanup,
			}
		});
	});

	test('deleted without asking, it is looked at once more once the terminals working in it have closed, right before Git deletes it: a file one of them wrote as it stopped refuses it then - not lost to the force its first look called for - and it is put back as far as it can be (XS-07)', async () => {
		gitIsRunning();
		// Only what the caller put there, as it wrote it: that goes by force
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json'], submodules: false });
		answers.set('_git.deleteWorktreeAt force', { kind: 'removed' });
		files.set('/home/me/.facade/worktrees/lab/w2/.mcp.json', '{}');
		workspaceFolders = [main, w2];
		onDisk.add(w2.path);
		// The dev server writes its log as it is stopped
		terminals = [terminal('npm run dev', w2.path, { running: true, closing: () => answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: ['.mcp.json', 'dev.log'], submodules: false }) })];

		const refused = await instantiationService.createInstance(WorktreeService).removeWorktree(w2, { ownFiles: [{ path: '.mcp.json', sha256: SHA256_OF_EMPTY_OBJECT }] }).then(() => 'deleted', (err: Error) => err.message);

		assert.deepStrictEqual({ refused, steps }, {
			refused: '/home/me/.facade/worktrees/lab/w2 was not deleted: changes came into it as it was being deleted, which deleting it would lose: dev.log.\nThe terminals working in it were closed for the deletion, which ended what ran in them: npm run dev.',
			steps: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'show /lab',
				'hide /home/me/.facade/worktrees/lab/w2',
				'remove /home/me/.facade/worktrees/lab/w2',
				'close npm run dev',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'unhide /home/me/.facade/worktrees/lab/w2',
				'add /home/me/.facade/worktrees/lab/w2, in the background',
				'back to /home/me/.facade/worktrees/lab/w2',
			]
		});
	});

	test('a locked worktree, which Git does not delete, is refused at its first look - by the person\'s Delete Worktree or a caller\'s, or as a caller looks before stopping anything - before anything is asked, closed or moved: why it is locked said, and how to unlock it (OR-11)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'error', code: 'WorktreeLocked', message: 'on an external disk' });
		const service = instantiationService.createInstance(WorktreeService);
		const byACaller = await service.removeWorktree(w2, {}).then(() => 'deleted', (err: Error) => err.message);
		const looked = await service.removalLoss(w2).then(() => 'looked', (err: Error) => err.message);
		answers.set('_git.deleteWorktreeAt check', { kind: 'error', code: 'WorktreeLocked', message: '' });
		await service.deleteWorktree(w2);

		const unlock = `git worktree unlock "${w2.fsPath}"`;
		assert.deepStrictEqual({ byACaller, looked, steps }, {
			byACaller: `"w2" is locked: on an external disk. Git does not delete a locked worktree: unlock it with ${unlock}, then try again.`,
			looked: `"w2" is locked: on an external disk. Git does not delete a locked worktree: unlock it with ${unlock}, then try again.`,
			steps: [
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check',
				`error: "w2" is locked. Git does not delete a locked worktree: unlock it with ${unlock}, then try again.`,
			]
		});
	});

	test('the person\'s Delete Worktree says why the agents\' terminals in it close - its worktree was deleted - before anything closes; a caller\'s deletion, which stopped its agents first, does not (N-04)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		terminals = [terminal('@clamp #a2', '/home/me/.facade/worktrees/lab/w2', { run: { workspace: 'record', id: 2 } })];
		const service = instantiationService.createInstance(WorktreeService);
		await service.deleteWorktree(w2);
		const byThePerson = [...closing];
		closing = [];
		terminals = [terminal('@clamp #a2', '/home/me/.facade/worktrees/lab/w2', { run: { workspace: 'record', id: 2 }, exitCode: 0 })];
		await service.removeWorktree(w2, { runs: [{ workspace: 'record', id: 2 }] });

		assert.deepStrictEqual({ byThePerson, byACaller: closing }, { byThePerson: ['@clamp #a2 worktreeDeleted'], byACaller: [] });
	});

	test('deleted without asking, for an agent, its folder leaves the workspace as background work - no extension host restarts for it, the window\'s first folder or not - and leaves it so only while it does; the person\'s Delete Worktree is their own act (AGENT-LAUNCHER.md, L1; VC-01)', async () => {
		gitIsRunning();
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		const removals: string[] = [];
		instantiationService.stub(IWorkspaceBarService, 'remove', async (uris: readonly URI[]) => {
			removals.push(`${uris.map(uri => uri.path).join(', ')}${uris.some(uri => backgroundFolderChanges.isChanging(uri)) ? ', in the background' : ''}`);
		});
		const service = instantiationService.createInstance(WorktreeService);
		await service.removeWorktree(w2);
		const afterwards = backgroundFolderChanges.isChanging(w2);
		await service.deleteWorktree(w2);

		assert.deepStrictEqual({ removals, afterwards }, {
			removals: ['/home/me/.facade/worktrees/lab/w2, in the background', '/home/me/.facade/worktrees/lab/w2'],
			afterwards: false
		});
	});

	test('a delete git refuses brings the row back and says why, the agents\' record is told it is over, and the worktree keeps its name, colour and trust (OR-10)', async () => {
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'error', code: undefined, message: 'fatal: the directory is busy' });

		await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);

		assert.deepStrictEqual(steps.slice(steps.indexOf('confirm') + 1), [
			'show /lab',
			'hide /home/me/.facade/worktrees/lab/w2',
			'_facade.agents.worktreeDeleting /home/me/.facade/worktrees/lab/w2',
			'remove /home/me/.facade/worktrees/lab/w2',
			'close its terminal',
			'_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 remove',
			'unhide /home/me/.facade/worktrees/lab/w2',
			'_facade.agents.worktreeDeleteFailed /home/me/.facade/worktrees/lab/w2',
			'error: The worktree could not be deleted: fatal: the directory is busy',
		]);
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

	test('an agent\'s terminal in the worktree is said to be running while its CLI runs, children or not - one still connecting has none; one that ended is not (WT-8.1; N-35)', async () => {
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		const said = async (agent: ITerminalInstance) => {
			terminals = [agent];
			confirmations.length = 0;
			await instantiationService.createInstance(WorktreeService).deleteWorktree(w2);
			return (confirmations[0].detail as IMarkdownString).value.includes('Something is running');
		};

		assert.deepStrictEqual({
			connecting: await said(terminal('@late #a2', `${w2.path}`, { run: { workspace: 'record', id: 2 } })),
			ended: await said(terminal('@done #a3', `${w2.path}`, { run: { workspace: 'record', id: 3 }, exitCode: 0 })),
			shell: await said(terminal('zsh', `${w2.path}`))
		}, { connecting: true, ended: false, shell: false });
	});

	test('a worktree in which another window\'s agent works is not deleted - by the person or by a caller - before anything is closed: refused naming it (SP-18; N-37)', async () => {
		answers.set('_git.deleteWorktreeAt check', { kind: 'checked', files: [], submodules: false });
		answers.set('_git.deleteWorktreeAt remove', { kind: 'removed' });
		gitIsRunning();
		// Attached to its own window, as a running agent is: no orphan
		ptyProcesses = [upcastPartial<IProcessDetails>({ title: '@sp18o #a208', pid: 4242, cwd: `${w2.path}/src`, workspaceId: 'another window', isOrphan: false, reconnectionProperties: facadeRunProperties({ workspace: 'other', id: 208 }) })];
		terminals = [terminal('zsh', w2.path)];
		const service = instantiationService.createInstance(WorktreeService);
		const byCaller = await service.removeWorktree(w2, { runs: [] }).then(() => 'deleted', (err: Error) => err.message);
		const callerSteps = steps.splice(0);
		await service.deleteWorktree(w2);

		assert.deepStrictEqual({ byCaller, callerSteps, personSteps: steps }, {
			byCaller: '/home/me/.facade/worktrees/lab/w2 was not deleted: an agent of another window is working inside it, @sp18o #a208. Stop it in that window first.',
			callerSteps: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check'],
			personSteps: ['_git.deleteWorktreeAt /lab /home/me/.facade/worktrees/lab/w2 check', 'confirm', 'error: /home/me/.facade/worktrees/lab/w2 was not deleted: an agent of another window is working inside it, @sp18o #a208. Stop it in that window first.']
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
