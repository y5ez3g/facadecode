/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILifecycleService, ShutdownReason } from '../../../services/lifecycle/common/lifecycle.js';

/** How long the agents' extension may take, as the window closes, to end its runs and leave its notices. */
const WINDOW_CLOSING_TIMEOUT_MS = 10_000;

/**
 * Tells the agents' extension why the window shuts down - closing, quitting, replacing its workspace or reloading - once
 * no question can cancel it any more, and waits for it before the extension host stops, which waits for every other
 * joiner (AGENT-LAUNCHER.md, L6): a close ends the window's runs and leaves their notices for the other workspaces; a
 * reload ends nothing.
 */
export class FacadeWindowClosing extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.facadeWindowClosing';

	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this._register(lifecycleService.onWillShutdown(event => {
			if (!CommandsRegistry.getCommand('_facade.agents.windowClosing')) {
				return;
			}
			const reason = event.reason === ShutdownReason.CLOSE ? 'close' : event.reason === ShutdownReason.QUIT ? 'quit' : event.reason === ShutdownReason.LOAD ? 'load' : 'reload';
			event.join((async () => {
				try {
					await raceTimeout(this.commandService.executeCommand('_facade.agents.windowClosing', { reason }), WINDOW_CLOSING_TIMEOUT_MS);
				} catch (error) {
					this.logService.trace(`[facadeWindowClosing] Could not tell the agents why the window shuts down: ${toErrorMessage(error)}`);
				}
			})(), {
				id: 'join.facadeWindowClosing',
				label: localize('facadeWindowClosing', "Ending this window's agents")
			});
		}));
	}
}
