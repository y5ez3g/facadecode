/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A CLI's SQLite index read for list metadata (LIFECYCLE-3.2): with the runtime's own SQLite, read only, leaving no file beside it.

import * as fs from 'fs';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';

/** Node's SQLite, where the runtime has it: a runtime without it reads no SQLite store. */
function sqlite(): typeof import('node:sqlite') | undefined {
	try {
		return require('node:sqlite') as typeof import('node:sqlite');
	} catch {
		return undefined;
	}
}

/**
 * `file`'s database, read only; none where it is not there, cannot be opened or the runtime has no SQLite. Opened as it is when its
 * CLI has written no journal still to merge - so that no shared-memory or journal file of SQLite's is left beside it - and as a
 * database being written otherwise, the journal then read too.
 */
export function openReadOnly(file: string): DatabaseSync | undefined {
	const module = fs.existsSync(file) ? sqlite() : undefined;
	if (!module) {
		return undefined;
	}
	let journal = 0;
	try {
		journal = fs.statSync(`${file}-wal`).size;
	} catch {
		// No journal: the database is all there is
	}
	const url = pathToFileURL(file);
	url.searchParams.set('immutable', '1');
	try {
		return new module.DatabaseSync(journal ? file : url, { readOnly: true });
	} catch {
		return undefined;
	}
}
