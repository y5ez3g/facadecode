/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { daemonSocketPath } from '../host/rust/connection';
import { FACADE_PROGRAM } from '../host/rust/types';

suite('Core connection (ARCHITECTURE-1.4)', () => {
	test('the daemon\'s socket is named from the exact UTF-8 home, and FACADE_PROGRAM is bin/facade.exe on Windows', () => {
		const home = 'D:\\Facade home\\\u4f60\u597d';
		if (process.platform === 'win32') {
			assert.strictEqual(daemonSocketPath(home), '\\\\.\\pipe\\facade-core-daemon-3023af2dc8');
			assert.strictEqual(FACADE_PROGRAM, 'bin/facade.exe');
		} else {
			assert.strictEqual(daemonSocketPath(home), path.join('/tmp', `facade-core-${process.getuid?.() ?? os.userInfo().uid}`, 'daemon-3023af2dc8.sock'));
			assert.strictEqual(FACADE_PROGRAM, 'bin/facade');
		}
	});
});
