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
	 * What ptyd is told of the claiming window (RULES-4.1): its address, the same across its reloads and another window's for another
	 * window (ARCHITECTURE-2.2), and whether its extension host runs on the computer it shows on - a local window, as opposed to a
	 * remote one, whose extension host a lost network leaves running. Absent from a window that cannot know its identity.
	 */
	readonly window?: string;
	readonly local?: boolean;
}

export function isOwnerClaim(value: unknown): value is OwnerClaim {
	return isJsonObject(value) && typeof value.owner === 'string' && !!value.owner
		&& typeof value.token === 'string' && !!value.token
		&& Number.isSafeInteger(value.generation) && (value.generation as number) >= 1;
}

/** Executes a synchronous disk mutation only while its activation still owns the shared record. */
export type OwnedWrite = (write: () => void) => void;
