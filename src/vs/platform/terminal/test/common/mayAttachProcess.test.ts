/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FACADE_RUN_OWNER, IShellLaunchConfig, mayAttachProcess } from '../../common/terminal.js';

suite('Terminal: which window attaches a process', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an agent\'s process is attached by a window only while no other has it - an orphan; any other process as upstream, whoever has it (N-68)', async () => {
		const agent: IShellLaunchConfig = { reconnectionProperties: { ownerId: FACADE_RUN_OWNER, data: { workspace: 'w', id: 1 } } };
		const process = (shellLaunchConfig: IShellLaunchConfig, orphan: boolean) => ({ shellLaunchConfig, isOrphaned: async () => orphan });

		deepStrictEqual({
			agentAnotherWindowHas: await mayAttachProcess(process(agent, false)),
			agentOrphan: await mayAttachProcess(process(agent, true)),
			shellAnotherWindowHas: await mayAttachProcess(process({}, false)),
			taskAnotherWindowHas: await mayAttachProcess(process({ reconnectionProperties: { ownerId: 'Task', data: {} } }, false))
		}, {
			agentAnotherWindowHas: false,
			agentOrphan: true,
			shellAnotherWindowHas: true,
			taskAnotherWindowHas: true
		});
	});

	test('an agent\'s process is attached only by a window of its own record, told or not; with the record not said yet, as before (REMOTE.md R7)', async () => {
		const agent: IShellLaunchConfig = { reconnectionProperties: { ownerId: FACADE_RUN_OWNER, data: { workspace: 'w', id: 1 } } };
		const process = (shellLaunchConfig: IShellLaunchConfig, orphan: boolean) => ({ shellLaunchConfig, isOrphaned: async () => orphan });

		deepStrictEqual({
			ownRecordOrphan: await mayAttachProcess(process(agent, true), 'w'),
			ownRecordHeld: await mayAttachProcess(process(agent, false), 'w'),
			otherRecordOrphan: await mayAttachProcess(process(agent, true), 'other'),
			otherRecordHeld: await mayAttachProcess(process(agent, false), 'other'),
			recordUnknownOrphan: await mayAttachProcess(process(agent, true)),
			recordUnknownHeld: await mayAttachProcess(process(agent, false)),
			shellOtherRecord: await mayAttachProcess(process({}, true), 'other')
		}, {
			ownRecordOrphan: true,
			ownRecordHeld: false,
			otherRecordOrphan: false,
			otherRecordHeld: false,
			recordUnknownOrphan: true,
			recordUnknownHeld: false,
			shellOtherRecord: true
		});
	});
});
