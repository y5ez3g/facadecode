/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentRef, DaemonOperations, DaemonTopics } from '../../base/frameworkProtocol';
import type { Disposable, Event } from '../../core/ports';
import type { encodeTerminalInput, WatchListener } from './daemonTypes';

export { DaemonError, encodeTerminalInput, type WatchListener } from './daemonTypes';

export type EditorCalls = Pick<DaemonOperations,
	'agent.list' | 'agent.inspect' | 'agent.start' | 'agent.resume_list' | 'agent.resume' | 'agent.stop'
	| 'agent.remove' | 'agent.rename' | 'location.list' | 'cli.list' | 'daemon.status' | 'daemon.log'>;
export type EditorTopic = 'agents' | 'machines';
export type AttachWatchArgs = Omit<DaemonTopics['attach']['args'], 'target'> & { readonly target: AgentRef };
export type RawInputArgs = DaemonOperations['agent.type']['args'] & {
	readonly target: AgentRef;
	readonly input: { readonly kind: 'raw'; readonly raw: ReturnType<typeof encodeTerminalInput> };
};

export type ResizeAttach = (args: Omit<DaemonOperations['attach.resize']['args'], 'watch'>) => void;

export interface AttachListener extends Omit<WatchListener<DaemonTopics['attach']['snapshot'], DaemonTopics['attach']['change']>, 'snapshot'> {
	/** The resize function belongs to this snapshot's live watch. */
	snapshot(screen: DaemonTopics['attach']['snapshot'], resize: ResizeAttach): void;
}

export interface FrameworkLink extends Disposable {
	/** The last verified Facade Code Framework's full machine ID. */
	readonly machineId: string;
	readonly connected: boolean;
	/** Fires after installing a connection and before asking for watch snapshots. */
	readonly onDidConnect: Event<string>;
	call<Op extends keyof EditorCalls>(op: Op, args: EditorCalls[Op]['args']): Promise<EditorCalls[Op]['result']>;
	/** True once handed to the current usable connection. */
	notify(op: 'agent.type', args: RawInputArgs): boolean;
	watch<Topic extends EditorTopic>(topic: Topic, args: DaemonTopics[Topic]['args'],
		on: WatchListener<DaemonTopics[Topic]['snapshot'], DaemonTopics[Topic]['change']>): Disposable;
	/** Rechecks support and reads the current pane capacity each time the view is installed. */
	watchAttach(args: () => AttachWatchArgs, on: AttachListener): Disposable;
}
