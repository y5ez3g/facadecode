/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FACADE_RUN_OWNER, IShellLaunchConfig, processExitCode } from '../../common/terminal.js';

suite('Terminal: the code a process ended with', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an agent\'s CLI ended by a signal ends with 128 and the signal\'s number, as a shell says it, not with the 0 node-pty says beside the signal; its own code otherwise; any other terminal keeps the code node-pty says (N-58)', () => {
		const agent: IShellLaunchConfig = { reconnectionProperties: { ownerId: FACADE_RUN_OWNER, data: { workspace: 'w', id: 1 } } };
		const task: IShellLaunchConfig = { reconnectionProperties: { ownerId: 'Task', data: {} } };

		deepStrictEqual({
			agent: [processExitCode({ exitCode: 0, signal: 9 }, agent), processExitCode({ exitCode: 0, signal: 1 }, agent), processExitCode({ exitCode: 3 }, agent), processExitCode({ exitCode: 0 }, agent)],
			others: [processExitCode({ exitCode: 0, signal: 9 }, task), processExitCode({ exitCode: 0, signal: 9 }, {}), processExitCode({ exitCode: 2 }, {})]
		}, {
			agent: [137, 129, 3, 0],
			others: [0, 0, 2]
		});
	});
});
