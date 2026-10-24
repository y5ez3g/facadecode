/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { facadeRemoteStartLabel } from '../../browser/facadeRemoteStartLabels.js';

suite('Facade remote menu: the entries of its own remote extensions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the SSH and WSL extensions\' entries are the window\'s own strings, which its language packs translate; any other extension\'s are the product\'s (REMOTE.md R5; LOCALIZATION.md LC3)', () => {
		assert.deepStrictEqual({
			ssh: facadeRemoteStartLabel('jeanp413.open-remote-ssh'),
			wsl: facadeRemoteStartLabel('Jeanp413.Open-Remote-WSL'),
			other: facadeRemoteStartLabel('ms-vscode-remote.remote-containers'),
		}, { ssh: 'Connect to Host...', wsl: 'Connect to WSL', other: undefined });
	});

});
