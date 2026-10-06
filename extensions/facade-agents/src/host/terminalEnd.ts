/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TerminalEnd } from '../core/ports';

/** Why VS Code says a terminal ended, as far as Facade tells the reasons apart. */
export type ExitReason = 'shutdown' | 'user' | 'other';

/**
 * What the end of an agent's terminal is to Facade, from VS Code's exit status: nothing as the window
 * shuts down, which leaves the agents to the next window to find, running or gone. The person closed
 * one that ended for the user with no exit code: VS Code closes a terminal in the editor area whose
 * process exited as if the user had, its process's code kept.
 */
export function endOf(reason: ExitReason, code: number | undefined): TerminalEnd | undefined {
	if (reason === 'shutdown') {
		return undefined;
	}
	return { ...(code !== undefined ? { exitCode: code } : {}), byThePerson: reason === 'user' && code === undefined };
}
