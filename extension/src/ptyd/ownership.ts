/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OwnerClaim } from './protocol';

/**
 * The grace period a remote window's runs have, from when its current extension host disconnects from ptyd: long enough for a
 * reconnect after a lost network, which a reopened window of the workspace may take too (RULES-4.1).
 */
export const OWNER_GRACE_MS = 5 * 60_000;

/**
 * A local window's: a reload or an extension host restart claims its runs again well within it; a closed window's runs end after
 * it, unless a window opening the workspace within it takes them over, as a reload does - no claim ends another window's runs
 * (RULES-4.1).
 */
export const LOCAL_OWNER_GRACE_MS = 90_000;

export interface OwnerClock {
	after(ms: number, run: () => void): { dispose(): void };
}

interface Owner<C> {
	readonly claim: OwnerClaim;
	connection?: C;
	timer?: { dispose(): void };
	expired?: boolean;
}

/**
 * One activation acquires ownership once, before connecting. Reconnect uses the same generation; it never acquires a newer
 * one. The exact current connection fences every effect. A transferred connection's later disconnect cannot expire its successor.
 */
export class OwnerClaims<C> {
	private readonly owners = new Map<string, Owner<C>>();

	constructor(
		private readonly transferred: (owner: string, previous: C) => void,
		private readonly expired: (owner: string) => void,
		private readonly clock: OwnerClock = {
			after: (ms, run) => {
				const timer = setTimeout(run, ms);
				timer.unref?.();
				return { dispose: () => clearTimeout(timer) };
			}
		}
	) { }

	claim(claim: OwnerClaim, connection: C): void {
		if (typeof claim.owner !== 'string' || !claim.owner || !Number.isSafeInteger(claim.generation) || claim.generation < 1 || typeof claim.token !== 'string' || !claim.token
			|| (claim.local !== undefined && typeof claim.local !== 'boolean')) {
			throw new Error('Invalid workspace ownership claim.');
		}
		const previous = this.owners.get(claim.owner);
		if (previous && (claim.generation < previous.claim.generation ||
			(claim.generation === previous.claim.generation && (claim.token !== previous.claim.token || previous.expired)))) {
			throw new Error('Workspace ownership was transferred or expired.');
		}
		// Within its grace any window of the workspace takes its runs over, a reloaded one or another: no claim ends them (RULES-4.1)
		previous?.timer?.dispose();
		this.owners.set(claim.owner, { claim, connection });
		if (previous?.connection !== undefined && previous.connection !== connection) {
			this.transferred(claim.owner, previous.connection);
		}
	}

	assert(owner: string, connection: C): void {
		if (this.owners.get(owner)?.connection !== connection) {
			throw new Error('Workspace ownership was transferred or expired.');
		}
	}

	disconnect(connection: C): void {
		for (const [key, owner] of this.owners) {
			if (owner.connection !== connection) {
				continue;
			}
			owner.connection = undefined;
			owner.timer = this.clock.after(owner.claim.local === true ? LOCAL_OWNER_GRACE_MS : OWNER_GRACE_MS, () => {
				if (this.owners.get(key) !== owner || owner.connection !== undefined) {
					return;
				}
				owner.expired = true;
				owner.timer = undefined;
				this.expired(key);
			});
		}
	}

	dispose(): void {
		for (const owner of this.owners.values()) {
			owner.timer?.dispose();
		}
		this.owners.clear();
	}
}
