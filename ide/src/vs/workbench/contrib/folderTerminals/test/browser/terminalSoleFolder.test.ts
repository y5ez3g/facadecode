/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { GeneralShellType } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { ITerminalConfigurationService } from '../../../terminal/browser/terminal.js';
import { TerminalConfigurationService } from '../../../terminal/browser/terminalConfigurationService.js';
import { TerminalLabelComputer } from '../../../terminal/browser/terminalInstance.js';
import { setTerminalSoleFolder } from '../../common/terminalSoleFolder.js';

suite('Folder terminals - a folder\'s terminal labelled as alone in it', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const pathOf = (name: string) => isWindows ? `C:\\w\\${name}` : `/w/${name}`;
	const lab = URI.file(pathOf('lab'));
	const notes = URI.file(pathOf('notes'));

	/** The tab's description of a terminal whose shell is in `cwd`, the folder it is alone in `sole`. */
	function description(cwd: string, sole: URI | undefined): string {
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IWorkspaceContextService, new TestContextService(testWorkspace(lab, notes)));
		instantiationService.set(IConfigurationService, new TestConfigurationService({ terminal: { integrated: { tabs: { separator: ' - ', title: '${process}', description: '${cwdFolder}' } } } }));
		instantiationService.set(ITerminalConfigurationService, store.add(instantiationService.createInstance(TerminalConfigurationService)));
		const computer = store.add(instantiationService.createInstance(TerminalLabelComputer));

		const capabilities = store.add(new TerminalCapabilityStore());
		capabilities.add(TerminalCapability.CwdDetection, null!);
		const terminal = {
			shellLaunchConfig: {}, shellType: GeneralShellType.PowerShell, cwd, initialCwd: undefined, processName: 'pwsh', sequence: undefined,
			workspaceFolder: undefined, staticTitle: undefined, capabilities, title: '', description: '', userHome: '/home/user', os: OperatingSystem.Linux
		};
		const hook = setTerminalSoleFolder(candidate => candidate === terminal ? sole : undefined);
		try {
			computer.refreshLabel(terminal);
			return computer.description;
		} finally {
			hook.dispose();
		}
	}

	test('WS-18 a terminal of the folder on screen names no folder while its shell is in that folder, and names the one it went to; the window\'s own names its folder always, as a multi-root workspace does', () => {
		assert.deepStrictEqual({
			inItsFolder: description(pathOf('lab'), lab),
			wentElsewhere: description(pathOf('notes'), lab),
			theWindows: description(pathOf('lab'), undefined)
		}, {
			inItsFolder: '',
			wentElsewhere: 'notes',
			theWindows: 'lab'
		});
	});
});
