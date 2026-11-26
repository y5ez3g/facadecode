/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
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
