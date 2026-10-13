/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { FACADE_CONFIGURATION_DEFAULTS } from '../../common/facadeDefaults.js';

suite('Facade defaults', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('what this fork moved, and that the registry is holding it', () => {
		// Read back out of the registry rather than off the constant: importing the module is what
		// registers these, so a registration that silently did not land reads as an absent key here.
		// The settings themselves are declared in upstream's files and are not imported - a unit
		// test that pulled the workbench in to read one default would be measuring the import.
		const overrides = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides();

		assert.deepStrictEqual(
			Object.fromEntries(Object.keys(FACADE_CONFIGURATION_DEFAULTS).map(key => [key, overrides.get(key)?.value])),
			{
				// Upstream says `visibleInWorkspace`. Closed, because this window already spends a
				// column on the left and the editor should not open as the middle of three.
				'workbench.secondarySideBar.defaultVisibility': 'hidden',
				// WS-49: upstream says `never`. Closing with an agent at work asks first
				'terminal.integrated.confirmOnExit': 'hasChildProcesses',
				// WS-14: upstream says `prompt`. A clone joins this window without a question, as Open Folder does
				'git.openAfterClone': 'always'
			});
	});

	test('WS-14 a repository just cloned is opened in this window, nothing asked: `git.openAfterClone` is `always`', () => {
		const overrides = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationDefaultsOverrides();

		assert.strictEqual(overrides.get('git.openAfterClone')?.value, 'always');
	});
});
