/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

function instanceByProcessId(accessor: ServicesAccessor, processId: unknown): ITerminalInstance | undefined {
	if (typeof processId !== 'number') {
		return undefined;
	}
	return accessor.get(ITerminalService).instances.find(instance => instance.processId === processId);
}

/**
 * `_facade.terminal.read(processId, lines)`: the last lines a terminal shows, which the extension API
 * does not tell, trailing blank lines left out.
 */
export function readTerminal(accessor: ServicesAccessor, processId: unknown, lines: unknown): string | undefined {
	const xterm = instanceByProcessId(accessor, processId)?.xterm;
	if (!xterm) {
		return undefined;
	}
	const wanted = typeof lines === 'number' && lines > 0 ? Math.min(2000, Math.floor(lines)) : 50;
	const collected: string[] = [];
	for (const line of xterm.getBufferReverseIterator()) {
		if (!collected.length && !line.trim()) {
			continue;
		}
		collected.push(line.replace(/\s+$/, ''));
		if (collected.length >= wanted) {
			break;
		}
	}
	return collected.reverse().join('\n');
}
