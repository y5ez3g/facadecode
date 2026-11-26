/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { withFileLock } from '../base/lock';
import { isOwnerClaim, type OwnerClaim } from '../base/ownership';
import { isWindowToken } from '../base/windowIdentity';

export interface RetiredTerminals {
	readonly claim: OwnerClaim;
	readonly runs: readonly { readonly run: string; readonly title: string }[];
}

function terminalRecord(file: string): { readonly epoch: string; readonly retired: readonly RetiredTerminals[] } | undefined {
	let value: unknown;
	try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
	if (!isJsonObject(value) || value.version !== 1 || !isWindowToken(value.epoch) || !Array.isArray(value.retired)
		|| value.retired.some(owner => !isJsonObject(owner) || !isOwnerClaim(owner.claim) || !Array.isArray(owner.runs)
			|| owner.runs.some(run => !isJsonObject(run) || typeof run.run !== 'string' || !run.run || typeof run.title !== 'string')
			|| new Set(owner.runs.map(run => run.run)).size !== owner.runs.length)
		|| new Set(value.retired.map(owner => owner.claim.owner)).size !== value.retired.length) {
		throw new Error('Invalid retired window terminal record.');
	}
	return value as unknown as { readonly epoch: string; readonly retired: readonly RetiredTerminals[] };
}

/** Consume old tab names once, while carrying the predecessor claim until that owner registers a successor. */
export function beginWindowTerminals(directory: string): { readonly epoch: string; readonly retired: readonly RetiredTerminals[] } {
	const file = path.join(directory, 'terminals.json');
	return withFileLock(file, () => {
		const retired = terminalRecord(file)?.retired ?? [];
		const epoch = crypto.randomUUID();
		const handoffs = retired.map(({ claim }) => ({ claim, runs: [] }));
		replaceFile(file, `${JSON.stringify({ version: 1, epoch, retired: handoffs })}\n`);
		return { epoch, retired };
	}, { keepLive: true });
}

export function claimRetiredTerminals(directory: string, epoch: string, owner: string): boolean {
	const file = path.join(directory, 'terminals.json');
	return withFileLock(file, () => {
		const record = terminalRecord(file);
		if (record?.epoch !== epoch) { return false; }
		const retired = record.retired.filter(each => each.claim.owner !== owner);
		if (retired.length !== record.retired.length) {
			replaceFile(file, `${JSON.stringify({ version: 1, epoch, retired })}\n`);
		}
		return true;
	}, { keepLive: true });
}

/** Only graceful shutdown writes names, once; output and title changes cause no disk traffic. */
export function retireWindowTerminals(directory: string, epoch: string, retired: readonly RetiredTerminals[]): void {
	const file = path.join(directory, 'terminals.json');
	withFileLock(file, () => {
		const record = terminalRecord(file);
		if (record?.epoch === epoch) {
			const registered = new Set(retired.map(owner => owner.claim.owner));
			const handoffs = [...record.retired.filter(owner => !registered.has(owner.claim.owner)), ...retired];
			replaceFile(file, `${JSON.stringify({ version: 1, epoch, retired: handoffs })}\n`);
		}
	}, { keepLive: true });
}
