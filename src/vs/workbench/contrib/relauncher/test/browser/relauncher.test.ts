/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { SyncStatus, IUserDataSyncService, IUserDataSyncEnablementService } from '../../../../../platform/userDataSync/common/userDataSync.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { BackgroundFolderChangesService } from '../../../../services/backgroundFolderChanges/common/backgroundFolderChanges.js';
import { IUserDataSyncWorkbenchService } from '../../../../services/userDataSync/common/userDataSync.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { SettingsChangeRelauncher, WorkspaceChangeExtHostRelauncher } from '../../browser/relauncher.contribution.js';

suite('SettingsChangeRelauncher', () => {

	const disposables = new DisposableStore();

	let restartCount: number;
	let confirmResult: boolean;
	let confirmCount: number;

	function createRelauncher(initialConfiguration: Record<string, unknown>): TestConfigurationService {
		// `update()` reads `config.window.titleBarStyle` unconditionally on native, so
		// the `window` object must always be present on the configuration root.
		initialConfiguration.window ??= {};
		const configurationService = new TestConfigurationService(initialConfiguration);

		const hostService = { hasFocus: true, restart: async () => { restartCount++; } } as Partial<IHostService> as IHostService;
		const dialogService = { confirm: async () => { confirmCount++; return { confirmed: confirmResult }; } } as Partial<IDialogService> as IDialogService;
		const userDataSyncService = { status: SyncStatus.Idle } as Partial<IUserDataSyncService> as IUserDataSyncService;
		const userDataSyncEnablementService = { isEnabled: () => true } as Partial<IUserDataSyncEnablementService> as IUserDataSyncEnablementService;
		const userDataSyncWorkbenchService = { onDidTurnOnSync: Event.None } as Partial<IUserDataSyncWorkbenchService> as IUserDataSyncWorkbenchService;
		const productService = { nameLong: 'Test Product' } as Partial<IProductService> as IProductService;

		disposables.add(new SettingsChangeRelauncher(hostService, configurationService, userDataSyncService, userDataSyncEnablementService, userDataSyncWorkbenchService, productService, dialogService));

		return configurationService;
	}

	function fireChange(configurationService: TestConfigurationService, key: string, source = ConfigurationTarget.USER): void {
		configurationService.onDidChangeConfigurationEmitter.fire({
			source,
			affectedKeys: new Set([key]),
			change: { keys: [key], overrides: [] },
			affectsConfiguration: (configuration: string) => configuration === key,
		});
	}

	async function changeSetting<T extends Record<string, unknown>>(key: string, createConfiguration: () => T, applyChange: (configuration: T) => void, source = ConfigurationTarget.USER): Promise<void> {
		const configuration = createConfiguration();
		const configurationService = createRelauncher(configuration);

		applyChange(configuration);
		fireChange(configurationService, key, source);
		await Promise.resolve();
	}

	setup(() => {
		restartCount = 0;
		confirmCount = 0;
		confirmResult = false;
	});

	teardown(() => {
		disposables.clear();
	});

	test('prompts to restart when chat.agentHost.claudeAgent.enabled changes', async () => {
		confirmResult = true;
		await changeSetting(
			'chat.agentHost.claudeAgent.enabled',
			() => ({ chat: { agentHost: { claudeAgent: { enabled: true } } } }),
			c => c.chat.agentHost.claudeAgent.enabled = false);

		assert.strictEqual(confirmCount, 1, 'should prompt to restart');
		assert.strictEqual(restartCount, 1, 'should restart when confirmed');
	});

	test('does not prompt to restart when chat.agentHost.codexAgent.enabled changes', async () => {
		confirmResult = true;
		await changeSetting(
			'chat.agentHost.codexAgent.enabled',
			() => ({ chat: { agentHost: { codexAgent: { enabled: true } } } }),
			c => c.chat.agentHost.codexAgent.enabled = false);

		assert.strictEqual(confirmCount, 0, 'should not prompt to restart');
		assert.strictEqual(restartCount, 0, 'should not restart');
	});

	test('does not prompt to restart when chat.agentHost.byokModels.enabled changes', async () => {
		confirmResult = true;
		await changeSetting(
			'chat.agentHost.byokModels.enabled',
			() => ({ chat: { agentHost: { byokModels: { enabled: true } } } }),
			c => c.chat.agentHost.byokModels.enabled = false);

		assert.strictEqual(confirmCount, 0, 'should not prompt to restart');
		assert.strictEqual(restartCount, 0, 'should not restart');
	});

	test('prompts to restart when chat.editor.codex.preferAgentHost changes', async () => {
		confirmResult = true;
		await changeSetting(
			'chat.editor.codex.preferAgentHost',
			() => ({ chat: { editor: { codex: { preferAgentHost: true } } } }),
			c => c.chat.editor.codex.preferAgentHost = false);

		assert.strictEqual(confirmCount, 1, 'should prompt to restart');
		assert.strictEqual(restartCount, 1, 'should restart when confirmed');
	});

	test('does not restart when the confirmation is declined', async () => {
		confirmResult = false;
		await changeSetting(
			'chat.agentHost.claudeAgent.enabled',
			() => ({ chat: { agentHost: { claudeAgent: { enabled: true } } } }),
			c => c.chat.agentHost.claudeAgent.enabled = false);

		assert.strictEqual(confirmCount, 1, 'should prompt to restart');
		assert.strictEqual(restartCount, 0, 'should not restart when declined');
	});

	test('does not prompt when only the default value changes', async () => {
		confirmResult = true;
		await changeSetting(
			'chat.agentHost.claudeAgent.enabled',
			() => ({ chat: { agentHost: { claudeAgent: { enabled: true } } } }),
			c => c.chat.agentHost.claudeAgent.enabled = false,
			ConfigurationTarget.DEFAULT);

		assert.strictEqual(confirmCount, 0, 'should not prompt for default changes');
		assert.strictEqual(restartCount, 0);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});

suite('WorkspaceChangeExtHostRelauncher', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * The relauncher in a workspace of the folders `a` and `b`; `folders` moves its folders, as removing one does,
	 * `backgroundFolderChanges` runs changes as an agent's work in the background, and `restarts` is what it did to
	 * the extension hosts.
	 */
	async function workspaceRelauncher() {
		const restarts: string[] = [];
		let folders = [URI.file('/w/a'), URI.file('/w/b')];
		const changed = disposables.add(new Emitter<IWorkspaceFoldersChangeEvent>());
		const workspace = () => upcastPartial<IWorkspace>({ folders: folders.map(uri => upcastPartial<IWorkspaceFolder>({ uri })) });
		const contextService = upcastPartial<IWorkspaceContextService>({
			getCompleteWorkspace: async () => workspace(),
			getWorkspace: workspace,
			getWorkbenchState: () => WorkbenchState.WORKSPACE,
			onDidChangeWorkbenchState: Event.None,
			onDidChangeWorkspaceFolders: changed.event
		});
		const extensionService = upcastPartial<IExtensionService>({
			stopExtensionHosts: async () => {
				restarts.push('stop');
				return true;
			},
			startExtensionHosts: async () => { restarts.push('start'); }
		});
		const hostService = upcastPartial<IHostService>({ reload: async () => { restarts.push('reload'); } });
		const environmentService = upcastPartial<IWorkbenchEnvironmentService>({ extensionTestsLocationURI: undefined, isSessionsWindow: false, remoteAuthority: undefined });
		const backgroundFolderChanges = new BackgroundFolderChangesService(upcastPartial<IUriIdentityService>({ extUri }));
		disposables.add(new WorkspaceChangeExtHostRelauncher(contextService, extensionService, hostService, environmentService, backgroundFolderChanges));
		await timeout(0);

		return {
			restarts,
			backgroundFolderChanges,
			/** The workspace's folders are `next` now, as a removal leaves them; settled once any restart it brings is done. */
			async folders(next: URI[]): Promise<void> {
				folders = next;
				changed.fire({ added: [], removed: [], changed: [] });
				await timeout(50);
			}
		};
	}

	test('restarts the extension hosts when the workspace\'s first folder changes - for the deprecated `workspace.rootPath` - and not when another does', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const relauncher = await workspaceRelauncher();
		await relauncher.folders([URI.file('/w/a')]);
		const anotherRemoved = [...relauncher.restarts];
		await relauncher.folders([URI.file('/w/c')]);

		assert.deepStrictEqual({ anotherRemoved, firstRemoved: relauncher.restarts }, { anotherRemoved: [], firstRemoved: ['stop', 'start'] });
	}));

	test('Facade Code: restarts none for a first folder taken out or put back for an agent\'s work in the background - its worktree deleted by `stop_agent`, and put back where git did not delete it - and does for the person\'s change of the first folder, made while another folder changes in the background (AGENT-LAUNCHER.md, L1; VC-01)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const relauncher = await workspaceRelauncher();
		const a = URI.file('/w/a');
		await relauncher.backgroundFolderChanges.run([a], () => relauncher.folders([URI.file('/w/b')]));
		await relauncher.backgroundFolderChanges.run([a], () => relauncher.folders([a, URI.file('/w/b')]));
		const inTheBackground = [...relauncher.restarts];
		await relauncher.backgroundFolderChanges.run([URI.file('/w/c')], () => relauncher.folders([URI.file('/w/b')]));

		assert.deepStrictEqual({ inTheBackground, byThePerson: relauncher.restarts }, { inTheBackground: [], byThePerson: ['stop', 'start'] });
	}));
});
