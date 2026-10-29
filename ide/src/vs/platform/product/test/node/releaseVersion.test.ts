/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildVersionMessage } from '../../../environment/node/argv.js';
import { releaseVersionLabel } from '../../common/releaseVersion.js';

suite('Product - which Facade Code this is', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ID-09 the release version, with the VS Code it is built on beside it; upstream\'s alone without one', () => {
		assert.deepStrictEqual({
			facade: releaseVersionLabel({ facadeVersion: '0.1.0', version: '1.138.0' }),
			upstream: releaseVersionLabel({ version: '1.138.0' }),
			// `facade --version`: the first line says both, the commit and the architecture stay on theirs
			cli: buildVersionMessage(releaseVersionLabel({ facadeVersion: '0.1.0', version: '1.138.0' }), 'abc123').split('\n').slice(0, 2),
		}, {
			facade: '0.1.0 (based on VS Code 1.138.0)',
			upstream: '1.138.0',
			cli: ['0.1.0 (based on VS Code 1.138.0)', 'abc123'],
		});
	});
});
