/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf, messageOf } from '../base/errors';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { withFileLock } from '../base/lock';

/**
 * Takes `count` numbers from the counter in `file`, under its lock, and answers the first: never a number given before (RULES-1.1,
 * 2.2). The counter moves past `floor`, read under the lock too - numbers an earlier counter gave, or records still kept. A missing
 * counter counts from its floor; one that cannot be read or holds no number is an error, never a count from nothing, and is left as
 * it was. `name` says what it counts, in its errors.
 */
export function takeNumbers(file: string, count: number, name: string, floor: () => number = () => 0): number {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	return withFileLock(file, () => {
		const first = Math.max(lastOf(file, name), Math.max(0, Math.floor(floor()))) + 1;
		replaceFile(file, `${JSON.stringify({ last: first + count - 1 })}\n`);
		return first;
	});
}

/** The number the counter in `file` gave last: none before the first. */
function lastOf(file: string, name: string): number {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return 0;
		}
		throw new Error(`The ${name} counter ${file} cannot be read: ${messageOf(err)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const last = isJsonObject(parsed) ? parsed.last : undefined;
	if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0) {
		throw new Error(`The ${name} counter ${file} does not hold a number; Facade gives no ${name} it may have given before.`);
	}
	return last;
}
