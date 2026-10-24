/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IReconnectionProperties } from '../../../../../platform/terminal/common/terminal.js';
import { agentRecordForAttach, agentRestoreDeferred, facadeRunProperties, setAgentRecordForAttach } from '../../common/facadeRun.js';

suite('Facade runs: what layout restore brings back on a remote', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an agent\'s terminal is left out for the take-back while the window\'s record is none told yet, or another\'s; its own comes back, an ordinary terminal comes back, and a local window brings every agent\'s back as ever (REMOTE.md R7; RM-20)', () => {
		const run = (workspace: string) => ({ reconnectionProperties: facadeRunProperties({ workspace, id: 1 }) });
		const shell: { readonly reconnectionProperties?: IReconnectionProperties } = { reconnectionProperties: { ownerId: 'Task', data: {} } };
		const remote = 'ssh-remote+host';
		const decided = (terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined, record: string | undefined, authority: string | undefined) => agentRestoreDeferred(terminal, record, authority);

		assert.deepStrictEqual({
			remoteOwnRecord: decided(run('w'), 'w', remote),
			remoteRecordUnknown: decided(run('w'), undefined, remote),
			remoteOtherRecord: decided(run('w'), 'other', remote),
			remoteShellUnknown: decided(shell, undefined, remote),
			remoteUnmarkedUnknown: decided(undefined, undefined, remote),
			localUnknown: decided(run('w'), undefined, undefined),
			localOtherRecord: decided(run('w'), 'other', undefined)
		}, {
			remoteOwnRecord: false,
			remoteRecordUnknown: true,
			remoteOtherRecord: true,
			remoteShellUnknown: false,
			remoteUnmarkedUnknown: false,
			localUnknown: false,
			localOtherRecord: false
		});
	});

	test('the record attaching terminals are decided with stays as it is said again - the extension says it on every change, through a slot that disposes the one before - and goes only with the last (REMOTE.md R7)', () => {
		const slot = new MutableDisposable();
		slot.value = setAgentRecordForAttach('w');
		const first = agentRecordForAttach();
		slot.value = setAgentRecordForAttach('w');
		const sameAgain = agentRecordForAttach();
		slot.value = setAgentRecordForAttach('v');
		const another = agentRecordForAttach();
		slot.dispose();

		assert.deepStrictEqual({ first, sameAgain, another, gone: agentRecordForAttach() }, { first: 'w', sameAgain: 'w', another: 'v', gone: undefined });
	});

});
