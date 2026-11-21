/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	AgentRef, AttachResizeArgs, ScreenChange, V3Operation, V3ResizeArgs, V3ScreenSnapshot, V3ScreenWatchArgs, V3Topic, V3TypeArgs
} from '../../base/coreProtocol';
import type { Disposable, Event } from '../../core/ports';
import type { encodeTerminalInput, WatchListener } from '../rust/types';

export { DaemonError, encodeTerminalInput, type WatchListener } from '../rust/types';

export interface TerminalNotificationArgs {
	readonly 'agent.type': Omit<V3TypeArgs, 'agent' | 'reference' | 'raw'> & {
		readonly reference: AgentRef;
		readonly raw?: ReturnType<typeof encodeTerminalInput>;
	};
	readonly 'agent.resize': Omit<V3ResizeArgs, 'agent' | 'reference'> & { readonly reference: AgentRef };
}

export type ResizeAttach = (args: Omit<AttachResizeArgs, 'watch'>) => void;

export interface AttachListener extends Omit<WatchListener<V3ScreenSnapshot, ScreenChange>, 'snapshot'> {
	/** The resize function belongs to this snapshot's live watch. A legacy screen watch supplies none. */
	snapshot(screen: V3ScreenSnapshot, resize?: ResizeAttach): void;
}

export interface OrchestratorLink extends Disposable {
	/** The last verified Orchestrator's full machine ID. */
	readonly machineId: string;
	readonly connected: boolean;
	/** Fires after installing a connection and before asking for watch snapshots. */
	readonly onDidConnect: Event<string>;
	call<R>(op: V3Operation, args: object): Promise<R>;
	/** True once handed to the current usable connection. */
	notify<O extends keyof TerminalNotificationArgs>(op: O, args: TerminalNotificationArgs[O]): boolean;
	watch<S, C>(topic: V3Topic, args: object, on: WatchListener<S, C>): Disposable;
	/** Rechecks support and reads the current pane capacity each time the view is installed. */
	watchAttach(args: () => V3ScreenWatchArgs, on: AttachListener): Disposable;
}
