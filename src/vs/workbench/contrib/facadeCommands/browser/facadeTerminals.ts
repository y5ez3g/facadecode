/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/** When the person last typed into each terminal, by instance id. */
const lastInputByInstance = new Map<number, number>();

/**
 * Records when the person last typed into each terminal, for `_facade.terminal.lastInput`: the agents'
 * extension types a message into an agent's terminal only once the person has left it alone for a
 * while (WORKTREE-AGENTS.md, WA-6.4).
 *
 * The person's typing is read from xterm's own `onData`, which fires for keystrokes and pastes only.
 * The instance's `onDidInputData` also fires for text an extension sends, which would make the
 * extension's own typing look like the person's.
 */
export class TerminalInputTracker extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.facadeTerminalInput';

	private readonly listeners = this._register(new DisposableMap<number, DisposableStore>());

	constructor(@ITerminalService terminalService: ITerminalService) {
		super();
		for (const instance of terminalService.instances) {
			this.track(instance);
		}
		this._register(terminalService.onDidCreateInstance(instance => this.track(instance)));
		this._register(terminalService.onDidDisposeInstance(instance => {
			this.listeners.deleteAndDispose(instance.instanceId);
			lastInputByInstance.delete(instance.instanceId);
		}));
	}

	private track(instance: ITerminalInstance): void {
		if (this.listeners.has(instance.instanceId)) {
			return;
		}
		const store = new DisposableStore();
		this.listeners.set(instance.instanceId, store);
		instance.xtermReadyPromise.then(xterm => {
			if (xterm && !store.isDisposed) {
				store.add(xterm.raw.onData(() => lastInputByInstance.set(instance.instanceId, Date.now())));
			}
		});
	}
}

export function instanceByProcessId(accessor: ServicesAccessor, processId: unknown): ITerminalInstance | undefined {
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

/** `_facade.terminal.lastInput(processId)`: when the person last typed there, if they have. */
export function lastTerminalInput(accessor: ServicesAccessor, processId: unknown): number | undefined {
	const instance = instanceByProcessId(accessor, processId);
	return instance ? lastInputByInstance.get(instance.instanceId) : undefined;
}
