/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConnectionGainEvent, ConnectionLostEvent, PersistentConnectionEvent, ReconnectionPermanentFailureEvent } from '../../../../../platform/remote/common/remoteAgentConnection.js';
import { WillSaveStateReason } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { consumeWindowAway, forgetWindowAway, WindowAwayRecord } from '../../browser/facadeWindowAway.js';

suite('Facade window: having been away from its remote', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function remoteWindow(states: Emitter<PersistentConnectionEvent> | undefined): IRemoteAgentService {
		return upcastPartial<IRemoteAgentService>({ getConnection: () => states ? upcastPartial<IRemoteAgentConnection>({ onDidStateChange: states.event }) : null });
	}

	test('set as the connection goes and kept as it comes back, answered once for the extension host that recovers the agents, and let go of by an extension host heard from again, which saw every end itself (REMOTE.md R4)', () => {
		const storage = store.add(new TestStorageService());
		const states = store.add(new Emitter<PersistentConnectionEvent>());
		store.add(new WindowAwayRecord(remoteWindow(states), storage));

		const connected = consumeWindowAway(storage);
		states.fire(new ConnectionLostEvent('token', 0));
		states.fire(new ConnectionGainEvent('token', 0, 1));
		const backAgain = consumeWindowAway(storage);
		const askedTwice = consumeWindowAway(storage);
		states.fire(new ConnectionLostEvent('token', 0));
		states.fire(new ReconnectionPermanentFailureEvent('token', 0, 1, false));
		const givenUp = consumeWindowAway(storage);
		states.fire(new ConnectionLostEvent('token', 0));
		states.fire(new ConnectionGainEvent('token', 0, 1));
		// The extension host that outlived the cut pings: it saw what ended meanwhile
		forgetWindowAway(storage);
		const heardFrom = consumeWindowAway(storage);

		assert.deepStrictEqual({ connected, backAgain, askedTwice, givenUp, heardFrom }, { connected: false, backAgain: true, askedTwice: false, givenUp: true, heardFrom: false });
	});

	test('a window closed or reloaded while connected was not away as it ended, a cut it came back from aside; one that goes while away keeps its record for the next (REMOTE.md R4)', () => {
		const ended = (cut: 'cameBack' | 'stillAway') => {
			const storage = store.add(new TestStorageService());
			const states = store.add(new Emitter<PersistentConnectionEvent>());
			store.add(new WindowAwayRecord(remoteWindow(states), storage));
			states.fire(new ConnectionLostEvent('token', 0));
			if (cut === 'cameBack') {
				states.fire(new ConnectionGainEvent('token', 0, 1));
			}
			// A periodic save says nothing of the window's ending
			storage.testEmitWillSaveState(WillSaveStateReason.NONE);
			storage.testEmitWillSaveState(WillSaveStateReason.SHUTDOWN);
			return consumeWindowAway(storage);
		};

		assert.deepStrictEqual({ cameBack: ended('cameBack'), stillAway: ended('stillAway') }, { cameBack: false, stillAway: true });
	});

	test('a local window has no connection to lose: it is never away', () => {
		const storage = store.add(new TestStorageService());
		store.add(new WindowAwayRecord(remoteWindow(undefined), storage));

		assert.strictEqual(consumeWindowAway(storage), false);
	});

});
