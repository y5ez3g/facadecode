/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { PersistentConnectionEventType } from '../../../../platform/remote/common/remoteAgentConnection.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';

/** The window's workspace storage key for having been away from its remote: set as the connection goes, kept across loads. */
const AWAY_STORAGE_KEY = 'facade.window.away';

/**
 * Keeps the window's own record of having been away from its remote (REMOTE.md R4): set as soon as
 * the connection is lost - and written out at once, so a window that is killed while away keeps it -
 * and kept, the connection's coming back aside, until it has been answered for: by the agents'
 * extension host that recovers the window's agents, which asks once (`consumeWindowAway`), or by an
 * extension host that outlived the cut and is heard from again (`forgetWindowAway`), which saw every
 * agent's end in its terminal. Only a remote window has a connection to lose.
 */
export class WindowAwayRecord extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.facadeWindowAway';

	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IStorageService storageService: IStorageService
	) {
		super();

		const connection = remoteAgentService.getConnection();
		if (connection) {
			let connected = true;
			this._register(connection.onDidStateChange(e => {
				connected = e.type === PersistentConnectionEventType.ConnectionGain;
				if (!connected && !storageService.getBoolean(AWAY_STORAGE_KEY, StorageScope.WORKSPACE, false)) {
					storageService.store(AWAY_STORAGE_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
					storageService.flush().then(undefined, onUnexpectedError);
				}
			}));
			// Closed or reloaded while connected, the window's agents went with it as a local window's do: it was not
			// away as it ended, whatever its record still said of a cut it came back from. Said as the storage saves on
			// shutdown, as it is about to close: a write after that is dropped
			this._register(storageService.onWillSaveState(e => {
				if (e.reason === WillSaveStateReason.SHUTDOWN && connected) {
					forgetWindowAway(storageService);
				}
			}));
		}
	}
}

/**
 * Whether the window was away from its remote since an extension host last answered for it - for the
 * one that recovers its agents, which asks once: answered true once, then false, until it is away again.
 */
export function consumeWindowAway(storageService: IStorageService): boolean {
	const away = storageService.getBoolean(AWAY_STORAGE_KEY, StorageScope.WORKSPACE, false);
	if (away) {
		forget(storageService);
	}
	return away;
}

/** An extension host was heard from with the window connected: whatever happened while it was away, it saw. */
export function forgetWindowAway(storageService: IStorageService): void {
	if (storageService.getBoolean(AWAY_STORAGE_KEY, StorageScope.WORKSPACE, false)) {
		forget(storageService);
	}
}

function forget(storageService: IStorageService): void {
	storageService.remove(AWAY_STORAGE_KEY, StorageScope.WORKSPACE);
	storageService.flush().then(undefined, onUnexpectedError);
}
