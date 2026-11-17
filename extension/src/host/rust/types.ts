/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the parts of the Rust engine share: a window on it is an `ide` client of Facade core, and reaches core only through the
// daemon protocol (ARCHITECTURE-1.1).

import type { Disposable, ExecutionPort, RunId } from '../../core/ports';
import type { ErrorData, Operation, Reason, ResizeArgs, Topic, TypeArgs, WindowDescription } from '../../base/coreProtocol';

/** The engine a window runs its agents on, chosen once as it opens or reloads: core, or the extension's own. */
export type Engine = 'rust' | 'old';

/** Core's `facade` program in this extension's package, relative to its folder: none in a package that carries no core. */
export const FACADE_PROGRAM = 'bin/facade';

/** A call core refused: `reason` decides what the person reads, and the message, core's own words, follows it as the detail. */
export class DaemonError extends Error {
	constructor(message: string, readonly reason: Reason, readonly data: ErrorData) {
		super(message);
	}
}

declare const base64Input: unique symbol;
type Base64Input = string & { readonly [base64Input]: true };

/** The terminal's input as UTF-8 bytes in standard base64 with padding, as `agent.type.raw` carries them. */
export function encodeTerminalInput(data: string): Base64Input {
	return Buffer.from(data, 'utf8').toString('base64') as Base64Input;
}

/** Notification arguments at the daemon boundary: a plain input string must be encoded before it can be `raw`. */
export interface TerminalNotificationArgs {
	readonly 'agent.type': Omit<TypeArgs, 'raw'> & { readonly raw?: Base64Input };
	readonly 'agent.resize': ResizeArgs;
}

/** This window's connection to core, kept across core's restarts and handovers to a newer build. */
export interface DaemonLink {
	/** Runs `op`; rejects with a {@link DaemonError}. A call refused as `upgrading` is sent again once the new daemon responds. */
	call<R>(op: Operation, args: object): Promise<R>;
	/** Sends `op` without a response: what the person types, and a terminal's size. Dropped while disconnected. */
	notify<O extends keyof TerminalNotificationArgs>(op: O, args: TerminalNotificationArgs[O]): void;
	/** Follows `topic`: its snapshot, then its changes; a snapshot again after each reconnection, before its changes. */
	watch<S, C>(topic: Topic, args: object, on: { snapshot(snapshot: S): void; change(change: C): void }): Disposable;
	/** Describes the window again (`window.update`); the next `hello` describes it so too. */
	update(window: WindowDescription): Promise<void>;
	/** This window's ID, which stays the same across its reloads. */
	readonly windowId: string;
	dispose(): void;
}

/** The agents' editor terminals on the Rust engine: today's tabs, each drawing its agent's screen from core. */
export interface RustTerminals extends Pick<ExecutionPort, 'openPair' | 'note' | 'removePair' | 'reveal' | 'tabOpen' | 'reopen' | 'rename'
	| 'tabLabel' | 'pinTab' | 'spin' | 'hideTab' | 'openPinned' | 'pinnedOpened' | 'onDidActivate' | 'onDidClosePair' | 'onDidRenameTab'
	| 'onDidPinTab' | 'onDidPlaceTab'> {
	/** The run's terminal shows core's agent `agent` from now on. */
	bind(run: RunId, agent: string): void;
	/** The run's agent ended: its terminal says so in `text`. */
	exited(run: RunId, text: string): void;
	/** The system's reduced-motion preference, as the panel's page says it (LIFECYCLE-2.2). */
	systemMotion(reduced: boolean): void;
}
