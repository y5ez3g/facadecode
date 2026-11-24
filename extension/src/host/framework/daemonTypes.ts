/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ErrorData } from '../../base/frameworkProtocol';

/** Framework's `facade` program in this extension's package, relative to its folder (ARCHITECTURE-1.4). */
export const FACADE_PROGRAM = process.platform === 'win32' ? 'bin/facade.exe' : 'bin/facade';

/** A call framework refused: `reason` decides what the person reads, and the message, framework's own words, follows it as the detail. */
export class DaemonError extends Error {
	constructor(message: string, readonly reason: string, readonly data: ErrorData, readonly code?: number, options?: ErrorOptions) {
		super(message, options);
	}
}

declare const base64Input: unique symbol;
type Base64Input = string & { readonly [base64Input]: true };

/** The terminal's input as UTF-8 bytes in standard base64 with padding, as `agent.type` carries raw input. */
export function encodeTerminalInput(data: string): Base64Input {
	return Buffer.from(data, 'utf8').toString('base64') as Base64Input;
}

export interface WatchListener<S, C> {
	snapshot(snapshot: S): void;
	change(change: C): void;
	/** This watch is installed again on the next local connection. */
	disconnected?(): void;
	/** Framework refused or ended the watch. Its next snapshot needs a new watch. */
	ended?(error: DaemonError): void;
}
