/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPtyHostController, ISerializedTerminalState, ITerminalLogService } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { facadeRunProperties } from '../../../facadeCommands/common/facadeRun.js';
import { BaseTerminalBackend } from '../../browser/baseTerminalBackend.js';

/** A backend as far as reading the processes kept to be revived goes. */
class TestBackend extends BaseTerminalBackend {

	constructor() {
		super(
			new class extends mock<IPtyHostController>() {
				override readonly onPtyHostExit = Event.None;
				override readonly onPtyHostStart = Event.None;
				override readonly onPtyHostUnresponsive = Event.None;
				override readonly onPtyHostResponsive = Event.None;
				override readonly onPtyHostRequestResolveVariables = Event.None;
			},
			upcastPartial<ITerminalLogService>(new NullLogService()),
			new class extends mock<IActiveFolderService>() { },
			new class extends mock<IConfigurationResolverService>() { },
			new class extends mock<IStatusbarService>() { },
			new class extends mock<IWorkspaceContextService>() { }
		);
	}

	/** The ids of the processes the app's last quit kept, to be revived. */
	revived(state: readonly Partial<ISerializedTerminalState>[]): number[] | undefined {
		return this._deserializeTerminalState(JSON.stringify({ version: 1, state }))?.map(each => each.id);
	}
}

suite('Terminal backend - the processes revived after the app restarts', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('an agent\'s run is never revived: its CLI would run again once a window took its terminal back (Facade Code, N-30); a shell is, as upstream', () => {
		const backend = store.add(new TestBackend());

		assert.deepStrictEqual(backend.revived([
			{ id: 1, shellLaunchConfig: { executable: '/bin/zsh' } },
			{ id: 2, shellLaunchConfig: { executable: 'claude', reconnectionProperties: facadeRunProperties({ workspace: 'w', id: 3 }) } }
		]), [1]);
	});
});
