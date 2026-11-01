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

/** A window's handover record that is there but holds no identity: no reload reads another (ARCHITECTURE-2.2). */
export class DamagedWindowRecord extends Error { }

/**
 * One local window's handover record in the directory the editor supplies. Its native-window lifetime is verified in the
 * integration matrix (ARCHITECTURE-2.2), not derived by parsing the directory or matching workspace folders. Throws
 * DamagedWindowRecord for a record that holds no identity, and what failed for one that could not be read or written.
 */
export function windowToken(directory: string): string {
	const file = path.join(directory, 'handover.json');
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
		const token = crypto.randomUUID();
		fs.mkdirSync(directory, { recursive: true });
		replaceFile(file, `${JSON.stringify({ version: 1, token })}\n`);
		return token;
	}
	let stored: unknown;
	try {
		stored = JSON.parse(text) as unknown;
	} catch (error) {
		throw new DamagedWindowRecord(`Invalid local window handover record: ${(error as Error).message}`);
	}
	if (!isJsonObject(stored) || stored.version !== 1 || !isWindowToken(stored.token)) {
		throw new DamagedWindowRecord('Invalid local window handover record.');
	}
	return stored.token;
}

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

/** Consume a graceful predecessor's record once, and fence all later writes by that older incarnation. */
export function beginWindowTerminals(directory: string): { readonly epoch: string; readonly retired: readonly RetiredTerminals[] } {
	const file = path.join(directory, 'terminals.json');
	return withFileLock(file, () => {
		const previous = terminalRecord(file);
		const epoch = crypto.randomUUID();
		replaceFile(file, `${JSON.stringify({ version: 1, epoch, retired: [] })}\n`);
		return { epoch, retired: previous?.retired ?? [] };
	}, { keepLive: true });
}

/** Only graceful shutdown writes names, once; output and title changes cause no disk traffic. */
export function retireWindowTerminals(directory: string, epoch: string, retired: readonly RetiredTerminals[]): void {
	const file = path.join(directory, 'terminals.json');
	withFileLock(file, () => {
		if (terminalRecord(file)?.epoch === epoch) {
			replaceFile(file, `${JSON.stringify({ version: 1, epoch, retired })}\n`);
		}
	}, { keepLive: true });
}
