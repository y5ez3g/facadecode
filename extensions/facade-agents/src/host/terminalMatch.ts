/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which of the window's terminals is an agent's, by index; -1 for none. The one running the process its
 * launch recorded, where that is known; else the one of its name - unless that one is known to run another
 * process, or the recorded process has ended: VS Code starts a new shell, under the old title, in a tab whose
 * process it could not reconnect to after a reload, as one whose agent ended meanwhile, and tells that shell's
 * process id only once it runs.
 *
 * @param named The index of the terminal of the agent's name, -1 for none.
 * @param processIds Each terminal's process id, where the window has told it.
 * @param processId The process the agent's launch recorded, where it is known.
 * @param running Whether that process still runs.
 */
export function agentTerminalIndex(named: number, processIds: readonly (number | undefined)[], processId: number | undefined, running: boolean): number {
	if (processId !== undefined) {
		const index = processIds.indexOf(processId);
		if (index >= 0) {
			return index;
		}
		if (!running) {
			return -1;
		}
	}
	return named >= 0 && (processId === undefined || processIds[named] === undefined) ? named : -1;
}
