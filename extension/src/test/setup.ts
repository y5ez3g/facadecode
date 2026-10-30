/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Every unit-test process gets its own Facade root, and with it its own Facade directory, so no test can touch a person's real data
// (ARCHITECTURE-5.3).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-test-'));
process.env.FACADE_HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
