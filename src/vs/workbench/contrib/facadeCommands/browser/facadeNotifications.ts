/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../../../base/common/actions.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { assertType, isNumber, isString, isStringArray, isUndefinedOrNull } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INotificationHandle, INotificationService, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { runningTerminalOf } from './facadePersonInput.js';

/**
 * Shows Facade's notifications for `_facade.notification.show`, one per key: the next with a key takes the
 * place of the one up, as a new one, so that it is shown as the first was.
 */
export class FacadeNotifications extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.facadeNotifications';

	private readonly _shown = new Map<string, INotificationHandle>();

	constructor() {
		super();
		this._register(toDisposable(() => {
			for (const handle of [...this._shown.values()]) {
				handle.close();
			}
		}));

		// `(key, message, buttons?, quietFor?)`: answers with the button pressed; undefined once it closed, or another took its place
		this._register(CommandsRegistry.registerCommand('_facade.notification.show', (accessor, key: unknown, message: unknown, buttons: unknown, quietFor: unknown): Promise<string | undefined> => {
			assertType(isString(key), 'string');
			assertType(isString(message), 'string');
			assertType(isUndefinedOrNull(buttons) || isStringArray(buttons), 'string[]');
			assertType(isUndefinedOrNull(quietFor) || isNumber(quietFor), 'number');
			// Quiet, into the notification center alone, while the person is at the terminal of `quietFor`
			const quiet = isNumber(quietFor) && accessor.get(IHostService).hasFocus && !!runningTerminalOf(accessor.get(ITerminalService), quietFor)?.hasFocus;
			return this._show(accessor.get(INotificationService), key, message, buttons ?? [], quiet);
		}));
	}

	private _show(notificationService: INotificationService, key: string, message: string, buttons: readonly string[], quiet: boolean): Promise<string | undefined> {
		this._shown.get(key)?.close();
		return new Promise(resolve => {
			const handle = notificationService.notify({
				severity: Severity.Info,
				message,
				source: localize('facadeNotificationSource', "Facade Agents"),
				actions: { primary: buttons.map((label, index) => toAction({ id: `_facade.notification.button${index}`, label, run: () => resolve(label) })) },
				priority: quiet ? NotificationPriority.SILENT : NotificationPriority.DEFAULT
			});
			this._shown.set(key, handle);
			Event.once(handle.onDidClose)(() => {
				if (this._shown.get(key) === handle) {
					this._shown.delete(key);
				}
				resolve(undefined);
			});
		});
	}
}
