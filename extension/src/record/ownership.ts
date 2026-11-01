/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import { withFileLock } from '../base/lock';
import type { OwnerClaim } from '../base/ownership';

function claimFile(owner: string, home: string): string {
	return path.join(home, 'claims', `${crypto.createHash('sha256').update(owner).digest('hex')}.json`);
}

/** Orders activations at their start, never at reconnection: an older remote host cannot take its successor's runs back. */
export function nextOwnerClaim(owner: string, home: string): OwnerClaim {
	const file = claimFile(owner, home);
	return withFileLock(file, () => {
		let generation = 0;
		try {
			const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OwnerClaim>;
			if (!Number.isSafeInteger(previous.generation) || previous.generation! < 1) {
				throw new Error('Invalid workspace ownership generation.');
			}
			generation = previous.generation!;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw err;
			}
		}
		const claim = { owner, generation: generation + 1, token: crypto.randomBytes(16).toString('hex') };
		replaceFile(file, `${JSON.stringify(claim)}\n`);
		return claim;
	}, { keepLive: true });
}

/** Synchronous disk writers also stop when a successor activation has been allocated, before its socket connects. */
export function isCurrentOwner(claim: OwnerClaim, home: string): boolean {
	try {
		return holds(claim, home);
	} catch {
		return false;
	}
}

/** Whether `claim` is the one its owner's record names now: throws where that record cannot be read, never taking that for another. */
function holds(claim: OwnerClaim, home: string): boolean {
	let text: string;
	try {
		text = fs.readFileSync(claimFile(claim.owner, home), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw err;
	}
	const current = JSON.parse(text) as Partial<OwnerClaim>;
	return current.generation === claim.generation && current.token === claim.token;
}

/**
 * The ownership check and final file replacement share the same lock as successor-generation allocation. Answers whether it wrote:
 * false where a successor activation owns the record now. Throws where the record cannot be read: a write is never skipped silently
 * for a failure that is not another owner's claim.
 */
export function writeAsOwner(claim: OwnerClaim, home: string, write: () => void): boolean {
	return withFileLock(claimFile(claim.owner, home), () => {
		if (!holds(claim, home)) {
			return false;
		}
		write();
		return true;
	}, { keepLive: true });
}
