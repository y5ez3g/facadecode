/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject } from './json';

/** Allocated once at activation and reused unchanged on reconnect. It identifies an owner, not an expiring lease. */
export interface OwnerClaim {
	readonly owner: string;
	readonly generation: number;
	readonly token: string;
	/**
	 * Whether the claiming window's extension host runs on the computer it shows on - a local window, whose runs end 90 seconds after
	 * it goes, as opposed to a remote one, whose extension host a lost network leaves running and whose runs have five minutes (RULES-4.1).
	 */
	readonly local?: boolean;
}

export function isOwnerClaim(value: unknown): value is OwnerClaim {
	return isJsonObject(value) && typeof value.owner === 'string' && !!value.owner
		&& typeof value.token === 'string' && !!value.token
		&& Number.isSafeInteger(value.generation) && (value.generation as number) >= 1;
}

/** Executes a synchronous disk mutation only while its activation still owns the shared record. */
export type OwnedWrite = (write: () => void) => void;
