/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { isIMenuItem, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IFormatterChangeEvent, ILabelService } from '../../../../../platform/label/common/label.js';
import { Schemas } from '../../../../../base/common/network.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { AGENT_MENU } from '../../browser/terminalLauncherActions.js';
import { DETECT_CLIS_COMMAND } from '../../browser/terminalLauncherDetection.js';
import { TerminalLauncherMenu } from '../../browser/terminalLauncherMenu.js';
import { ITerminalLauncherService } from '../../browser/terminalLauncherService.js';

suite('Agent menu: a remote with no agent CLI', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the line in its place names the remote as the remote indicator does, and follows the name once the SSH extension says it, after the menu was made (REMOTE.md R3)', () => {
		const formatters = store.add(new Emitter<IFormatterChangeEvent>());
		let hostLabel = '';
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(IActionViewItemService, { register: () => Disposable.None });
		// Never ready: the editor groups play no part here
		instantiationService.stub(IEditorGroupsService, { whenReady: new Promise<void>(() => { }) });
		instantiationService.stub(ITerminalLauncherService, { onDidChangeAvailable: Event.None, refreshAvailable: async () => { }, available: new Set<string>(), availableKnown: false });
		instantiationService.stub(IContextKeyService, new MockContextKeyService());
		instantiationService.stub(IHostService, { onDidChangeFocus: Event.None });
		instantiationService.stub(IWorkbenchEnvironmentService, upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority: 'ssh-remote+box' }));
		instantiationService.stub(ILabelService, upcastPartial<ILabelService>({ getHostLabel: () => hostLabel, onDidChangeFormatters: formatters.event }));
		const line = () => MenuRegistry.getMenuItems(AGENT_MENU).filter(isIMenuItem).filter(item => item.command.id === 'facade.agent.remoteNoneFound').map(item => typeof item.command.title === 'string' ? item.command.title : item.command.title.value);

		const menu = instantiationService.createInstance(TerminalLauncherMenu);
		const asMade = line();
		hostLabel = 'SSH: box';
		formatters.fire({ scheme: Schemas.vscodeRemote });
		const named = line();
		menu.dispose();

		assert.deepStrictEqual({ asMade, named, gone: line() }, {
			asMade: ['No agent CLI found on ssh-remote+box. Install and sign in to one there.'],
			named: ['No agent CLI found on SSH: box. Install and sign in to one there.'],
			gone: []
		});
	});

	test('a remote\'s agents are looked for again the moment its agents\' extension host can be asked - its command comes with the extension\'s activation, once the window has started, after the first look found none there to ask - not first as the menu opens: that opening would show none of them while it asks, more than half a second over a slow link (REMOTE.md R3; RM-16). A local window looks for them itself, and is not asked again', () => {
		/** How many times a window looks for its agents: as the menu is made, as some other command comes, and as the agents' extension host's comes. */
		const looks = (remoteAuthority: string | undefined) => {
			let looked = 0;
			const instantiationService = store.add(new TestInstantiationService());
			instantiationService.stub(IConfigurationService, new TestConfigurationService());
			instantiationService.stub(IActionViewItemService, { register: () => Disposable.None });
			instantiationService.stub(IEditorGroupsService, { whenReady: new Promise<void>(() => { }) });
			instantiationService.stub(ITerminalLauncherService, { onDidChangeAvailable: Event.None, refreshAvailable: async () => { looked++; }, available: new Set<string>(), availableKnown: false });
			instantiationService.stub(IContextKeyService, new MockContextKeyService());
			instantiationService.stub(IHostService, { onDidChangeFocus: Event.None });
			instantiationService.stub(IWorkbenchEnvironmentService, upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority }));
			instantiationService.stub(ILabelService, upcastPartial<ILabelService>({ getHostLabel: () => 'SSH: box', onDidChangeFormatters: Event.None }));
			const commands = new DisposableStore();

			const menu = instantiationService.createInstance(TerminalLauncherMenu);
			const asMade = looked;
			commands.add(CommandsRegistry.registerCommand('_facade.agents.claimTicket', () => ({ granted: false })));
			const another = looked;
			commands.add(CommandsRegistry.registerCommand(DETECT_CLIS_COMMAND, () => []));
			const itsCommand = looked;
			menu.dispose();
			commands.dispose();
			return { asMade, another, itsCommand };
		};

		assert.deepStrictEqual({ remote: looks('ssh-remote+box'), local: looks(undefined) }, {
			remote: { asMade: 1, another: 1, itsCommand: 2 },
			local: { asMade: 1, another: 1, itsCommand: 1 },
		});
	});

});
