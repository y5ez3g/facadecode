/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { coalesce } from '../../../../../base/common/arrays.js';
import * as sinon from 'sinon';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService, IFileDialogService, IOpenDialogOptions, ISaveDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceBarService } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { ISimpleFileDialog } from '../../browser/simpleFileDialog.js';
import { FileDialogService } from '../../electron-browser/fileDialogService.js';
import { IEditorService } from '../../../editor/common/editorService.js';
import { BrowserWorkbenchEnvironmentService } from '../../../environment/browser/environmentService.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { IActiveFolderService } from '../../../activeFolder/common/activeFolder.js';
import { IHistoryService } from '../../../history/common/history.js';
import { IHostService } from '../../../host/browser/host.js';
import { IPathService } from '../../../path/common/pathService.js';
import { BrowserWorkspaceEditingService } from '../../../workspaces/browser/workspaceEditingService.js';
import { IWorkspaceEditingService } from '../../../workspaces/common/workspaceEditing.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IRemoteAgentService } from '../../../remote/common/remoteAgentService.js';

class TestFileDialogService extends FileDialogService {
	constructor(
		private simple: ISimpleFileDialog,
		@IHostService hostService: IHostService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IHistoryService historyService: IHistoryService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IFileService fileService: IFileService,
		@IOpenerService openerService: IOpenerService,
		@INativeHostService nativeHostService: INativeHostService,
		@IDialogService dialogService: IDialogService,
		@ILanguageService languageService: ILanguageService,
		@IWorkspacesService workspacesService: IWorkspacesService,
		@ILabelService labelService: ILabelService,
		@IPathService pathService: IPathService,
		@ICommandService commandService: ICommandService,
		@IEditorService editorService: IEditorService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@ILogService logService: ILogService,
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IActiveFolderService activeFolderService: IActiveFolderService
	) {
		super(hostService, contextService, historyService, environmentService, instantiationService, configurationService, fileService,
			openerService, nativeHostService, dialogService, languageService, workspacesService, labelService, pathService, commandService, editorService, codeEditorService, logService, remoteAgentService, activeFolderService);
	}

	protected override getSimpleFileDialog() {
		if (this.simple) {
			return this.simple;
		} else {
			return super.getSimpleFileDialog();
		}
	}
}

suite('FileDialogService', function () {

	let instantiationService: TestInstantiationService;
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const testFile: URI = URI.file('/test/file');

	setup(async function () {
		disposables.add(instantiationService = workbenchInstantiationService(undefined, disposables));
		const configurationService = new TestConfigurationService();
		await configurationService.setUserConfiguration('files', { simpleDialog: { enable: true } });
		instantiationService.stub(IConfigurationService, configurationService);

	});

	test('Local - open/save workspaces availableFilesystems', async function () {
		class TestSimpleFileDialog implements ISimpleFileDialog {
			async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
				assert.strictEqual(options.availableFileSystems?.length, 1);
				assert.strictEqual(options.availableFileSystems[0], Schemas.file);
				return [testFile];
			}
			async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
				assert.strictEqual(options.availableFileSystems?.length, 1);
				assert.strictEqual(options.availableFileSystems[0], Schemas.file);
				return testFile;
			}
			dispose(): void { }
		}

		const dialogService = instantiationService.createInstance(TestFileDialogService, new TestSimpleFileDialog());
		instantiationService.set(IFileDialogService, dialogService);
		const workspaceService: IWorkspaceEditingService = disposables.add(instantiationService.createInstance(BrowserWorkspaceEditingService));
		assert.strictEqual((await workspaceService.pickNewWorkspacePath())?.path.startsWith(testFile.path), true);
		assert.strictEqual(await dialogService.pickWorkspaceAndOpen({}), undefined);
	});

	test('Virtual - open/save workspaces availableFilesystems', async function () {
		class TestSimpleFileDialog {
			async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
				assert.strictEqual(options.availableFileSystems?.length, 1);
				assert.strictEqual(options.availableFileSystems[0], Schemas.file);
				return [testFile];
			}
			async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
				assert.strictEqual(options.availableFileSystems?.length, 1);
				assert.strictEqual(options.availableFileSystems[0], Schemas.file);
				return testFile;
			}
			dispose(): void { }
		}

		instantiationService.stub(IPathService, new class {
			defaultUriScheme: string = 'vscode-virtual-test';
			userHome = async () => URI.file('/user/home');
		} as IPathService);
		const dialogService = instantiationService.createInstance(TestFileDialogService, new TestSimpleFileDialog());
		instantiationService.set(IFileDialogService, dialogService);
		const workspaceService: IWorkspaceEditingService = disposables.add(instantiationService.createInstance(BrowserWorkspaceEditingService));
		assert.strictEqual((await workspaceService.pickNewWorkspacePath())?.path.startsWith(testFile.path), true);
		assert.strictEqual(await dialogService.pickWorkspaceAndOpen({}), undefined);
	});

	test('Remote - open/save workspaces availableFilesystems', async function () {
		class TestSimpleFileDialog implements ISimpleFileDialog {
			async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
				assert.strictEqual(options.availableFileSystems?.length, 2);
				assert.strictEqual(options.availableFileSystems[0], Schemas.vscodeRemote);
				assert.strictEqual(options.availableFileSystems[1], Schemas.file);
				return [testFile];
			}
			async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
				assert.strictEqual(options.availableFileSystems?.length, 2);
				assert.strictEqual(options.availableFileSystems[0], Schemas.vscodeRemote);
				assert.strictEqual(options.availableFileSystems[1], Schemas.file);
				return testFile;
			}
			dispose(): void { }
		}

		instantiationService.set(IWorkbenchEnvironmentService, new class extends mock<BrowserWorkbenchEnvironmentService>() {
			override get remoteAuthority() {
				return 'testRemote';
			}
		});
		instantiationService.stub(IPathService, new class {
			defaultUriScheme: string = Schemas.vscodeRemote;
			userHome = async () => URI.file('/user/home');
		} as IPathService);
		const dialogService = instantiationService.createInstance(TestFileDialogService, new TestSimpleFileDialog());
		instantiationService.set(IFileDialogService, dialogService);
		const workspaceService: IWorkspaceEditingService = disposables.add(instantiationService.createInstance(BrowserWorkspaceEditingService));
		assert.strictEqual((await workspaceService.pickNewWorkspacePath())?.path.startsWith(testFile.path), true);
		assert.strictEqual(await dialogService.pickWorkspaceAndOpen({}), undefined);
	});

	test('Remote - filters default files/folders to RA (#195938)', async function () {
		class TestSimpleFileDialog implements ISimpleFileDialog {
			async showOpenDialog(): Promise<URI[] | undefined> {
				return [testFile];
			}
			async showSaveDialog(): Promise<URI | undefined> {
				return testFile;
			}
			dispose(): void { }
		}
		instantiationService.set(IWorkbenchEnvironmentService, new class extends mock<BrowserWorkbenchEnvironmentService>() {
			override get remoteAuthority() {
				return 'testRemote';
			}
		});
		instantiationService.stub(IPathService, new class {
			defaultUriScheme: string = Schemas.vscodeRemote;
			userHome = async () => URI.file('/user/home');
		} as IPathService);


		const dialogService = instantiationService.createInstance(TestFileDialogService, new TestSimpleFileDialog());
		const historyService = instantiationService.get(IHistoryService);
		const getLastActiveFile = sinon.spy(historyService, 'getLastActiveFile');
		// ⚠️ The folder the window is on is asked for under the same filter the last active file is.
		// A remote window must not be handed a local path, so the dialog cannot simply read
		// `activeFolder` - a workspace can hold a local folder and a remote one at once.
		const activeFolderFor = sinon.spy(instantiationService.get(IActiveFolderService), 'activeFolderFor');

		await dialogService.defaultFilePath();
		assert.deepStrictEqual(getLastActiveFile.args, [[Schemas.vscodeRemote, 'testRemote']]);
		assert.deepStrictEqual(activeFolderFor.args, [[Schemas.vscodeRemote, 'testRemote']]);

		await dialogService.defaultFolderPath();
		assert.deepStrictEqual(activeFolderFor.args[1], [Schemas.vscodeRemote, 'testRemote']);
	});

	test(`WS-03 ⭐ a folder picked from the native Open dialog becomes a row, not a window`, async function () {
		// ⚠️ `pickFileFolderAndOpen` used to hand the whole job to the main process, which picks and
		// opens in one call and can only answer with a window. The dialog is asked for a path now, and
		// what to do with it is decided here - so a folder joins this window instead of starting
		// another one. The in-page dialog and this one share that decision.
		const folder = URI.file('/test/folder');
		const shown: URI[] = [];
		const windowed: unknown[] = [];

		const configurationService = new TestConfigurationService();
		await configurationService.setUserConfiguration('files', { simpleDialog: { enable: false } });
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INativeHostService, new class extends mock<INativeHostService>() {
			override async showOpenDialog() { return { canceled: false, filePaths: [folder.fsPath] }; }
			override async getCursorScreenPoint() { return { point: { x: 0, y: 0 }, display: { x: 0, y: 0, width: 0, height: 0 } }; }
		});
		instantiationService.stub(IFileService, new class extends mock<IFileService>() {
			override async stat() { return { isDirectory: true, resource: folder } as never; }
		});
		instantiationService.stub(IHostService, new class extends mock<IHostService>() {
			override async openWindow(...args: unknown[]) { windowed.push(args); }
		});
		instantiationService.stub(IWorkspaceBarService, new class extends mock<IWorkspaceBarService>() {
			override async addAndShow(uris: readonly URI[]) { shown.push(...uris); }
		});

		const dialogService = instantiationService.createInstance(TestFileDialogService, undefined as unknown as ISimpleFileDialog);
		await dialogService.pickFileFolderAndOpen({ forceNewWindow: false });

		assert.deepStrictEqual(shown.map(uri => uri.fsPath), [folder.fsPath]);
		assert.strictEqual(windowed.length, 0);
	});


	test(`⭐ several files picked from the native Open dialog all open`, async function () {
		// ⚠️ The main process opened with `multiSelections`, so this dialog could always take more
		// than one. Asking it for paths instead of telling it to open must not quietly take that away.
		const files = [URI.file('/test/one.ts'), URI.file('/test/two.ts')];
		const opened: URI[] = [];

		const configurationService = new TestConfigurationService();
		await configurationService.setUserConfiguration('files', { simpleDialog: { enable: false } });
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INativeHostService, new class extends mock<INativeHostService>() {
			override async showOpenDialog() { return { canceled: false, filePaths: files.map(file => file.fsPath) }; }
		});
		instantiationService.stub(IFileService, new class extends mock<IFileService>() {
			override async stat(resource: URI) { return { isDirectory: false, resource } as never; }
		});
		instantiationService.stub(IEditorService, new class extends mock<IEditorService>() {
			override openEditors = (async (editors: readonly { resource?: URI }[]) => { opened.push(...coalesce(editors.map(editor => editor.resource))); return []; }) as unknown as IEditorService['openEditors'];
		});

		const dialogService = instantiationService.createInstance(TestFileDialogService, undefined as unknown as ISimpleFileDialog);
		await dialogService.pickFileFolderAndOpen({ forceNewWindow: false });

		assert.deepStrictEqual(opened.map(uri => uri.fsPath), files.map(file => file.fsPath));
	});

	test(`WS-03 ⭐ and several folders all join this window, in one request`, async function () {
		const folders = [URI.file('/test/alpha'), URI.file('/test/beta')];
		const shown: URI[][] = [];

		const configurationService = new TestConfigurationService();
		await configurationService.setUserConfiguration('files', { simpleDialog: { enable: false } });
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INativeHostService, new class extends mock<INativeHostService>() {
			override async showOpenDialog() { return { canceled: false, filePaths: folders.map(folder => folder.fsPath) }; }
		});
		instantiationService.stub(IFileService, new class extends mock<IFileService>() {
			override async stat(resource: URI) { return { isDirectory: true, resource } as never; }
		});
		instantiationService.stub(IWorkspaceBarService, new class extends mock<IWorkspaceBarService>() {
			override async addAndShow(uris: readonly URI[]) { shown.push([...uris]); }
		});

		const dialogService = instantiationService.createInstance(TestFileDialogService, undefined as unknown as ISimpleFileDialog);
		await dialogService.pickFolderAndOpen({ forceNewWindow: false });

		assert.deepStrictEqual(shown.map(batch => batch.map(uri => uri.fsPath)), [folders.map(folder => folder.fsPath)]);
	});

});
