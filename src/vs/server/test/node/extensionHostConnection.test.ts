/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { resolve } from '../../../base/common/path.js';
import { upcastPartial } from '../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { buildUserEnvironment } from '../../node/extensionHostConnection.js';
import { IServerEnvironmentService } from '../../node/serverEnvironmentService.js';

suite('Remote extension host environment', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const environmentService = upcastPartial<IServerEnvironmentService>({
		appRoot: '/server',
		userDataPath: '/server/data',
		isBuilt: true,
		args: upcastPartial<IServerEnvironmentService['args']>({ 'without-browser-env-var': true }),
		reconnectionGraceTime: 1000
	});
	const configurationService = upcastPartial<IConfigurationService>({});

	test('Facade home follows the server, not a resolver override, including absence and Windows key casing (O8)', async () => {
		const previous = process.env.FACADE_HOME;
		const serverHome = resolve('server-facade-home');
		try {
			process.env.FACADE_HOME = serverHome;
			const set = await buildUserEnvironment({ FACADE_HOME: '/resolver/facade', facade_home: '/resolver/mixed-case' }, false, 'en', environmentService, new NullLogService(), configurationService);
			delete process.env.FACADE_HOME;
			const absent = await buildUserEnvironment({ FACADE_HOME: '/resolver/facade', facade_home: '/resolver/mixed-case' }, false, 'en', environmentService, new NullLogService(), configurationService);

			assert.deepStrictEqual({
				set: set.FACADE_HOME,
				absent: absent.FACADE_HOME,
				keysWhenSet: Object.keys(set).filter(key => key.toUpperCase() === 'FACADE_HOME').length,
				keysWhenAbsent: Object.keys(absent).filter(key => key.toUpperCase() === 'FACADE_HOME').length
			}, {
				set: serverHome, absent: undefined,
				keysWhenSet: process.platform === 'win32' ? 1 : 2,
				keysWhenAbsent: process.platform === 'win32' ? 0 : 1
			});
		} finally {
			if (previous === undefined) {
				delete process.env.FACADE_HOME;
			} else {
				process.env.FACADE_HOME = previous;
			}
		}
	});
});
