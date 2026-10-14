/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../../../base/common/actions.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { assertType, isString, isStringArray, isUndefinedOrNull } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INotificationHandle, INotificationService, NotificationPriority, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { isFacadeRun } from '../common/facadeRun.js';
import { IFacadeRunsService } from './facadeRuns.js';

/**
 * Shows Facade's notifications for `_facade.notification.show`, one per key: the next with a key takes the
 * place of the one up, as a new one, so that it is shown as the first was; `_facade.notification.close` closes it.
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

		// `(key, message, buttons?, quietFor?, severity?)`: answers with the button pressed; undefined once it closed, or
		// another took its place. `quietFor` is the run of the agent it is from (`IFacadeRun`); `severity` - 'information',
		// 'warning' or 'error' - how it is shown, as news by default: the ends of the person's agents a failure as one
		this._register(CommandsRegistry.registerCommand('_facade.notification.show', (accessor, key: unknown, message: unknown, buttons: unknown, quietFor: unknown, severity: unknown): Promise<string | undefined> => {
			assertType(isString(key), 'string');
			assertType(isString(message), 'string');
			assertType(isUndefinedOrNull(buttons) || isStringArray(buttons), 'string[]');
			assertType(isUndefinedOrNull(quietFor) || isFacadeRun(quietFor), 'IFacadeRun');
			assertType(isUndefinedOrNull(severity) || severity === 'information' || severity === 'warning' || severity === 'error', `'information' | 'warning' | 'error'`);
			// Quiet, into the notification center alone, while the person is at the terminal of the agent it is from
			const quiet = isFacadeRun(quietFor) && accessor.get(IHostService).hasFocus && !!accessor.get(IFacadeRunsService).terminalOf(quietFor)?.hasFocus;
			return this._show(accessor.get(INotificationService), key, message, buttons ?? [], quiet, severity === 'error' ? Severity.Error : severity === 'warning' ? Severity.Warning : Severity.Info);
		}));

		// `(key)`: closes the notification shown with that key, if one is - from the notification center too, as the
		// condition it told of is over (AGENT-LAUNCHER.md, L5); its call answers with nothing pressed
		this._register(CommandsRegistry.registerCommand('_facade.notification.close', (_accessor, key: unknown): void => {
			assertType(isString(key), 'string');
			this._shown.get(key)?.close();
		}));
	}

	private _show(notificationService: INotificationService, key: string, message: string, buttons: readonly string[], quiet: boolean, severity: Severity): Promise<string | undefined> {
		this._shown.get(key)?.close();
		return new Promise(resolve => {
			const handle = notificationService.notify({
				severity,
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
