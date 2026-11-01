/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ptyd's log: a dated line for each run started and ended, each owner gone and each exception, in a file of bounded size, its
// oldest lines let go of first (ARCHITECTURE-3.3). The log is a help, never a reason for ptyd to stop.

import * as fs from 'fs';

/** The most the log holds; past it, its newest {@link KEPT_LOG_BYTES} are kept, from the first whole line in them. */
export const MOST_LOG_BYTES = 2 * 1024 * 1024;
export const KEPT_LOG_BYTES = 512 * 1024;

/** Appends each message to `file` as a line dated by `now`, keeping the file within {@link MOST_LOG_BYTES}; none where no file is named. */
export function logTo(file: string | undefined, now: () => Date = () => new Date()): (message: string) => void {
	if (!file) {
		return () => undefined;
	}
	let size = sizeOf(file);
	if (size > MOST_LOG_BYTES) {
		size = trim(file);
	}
	return message => {
		try {
			const line = `${now().toISOString()} ${message}\n`;
			fs.appendFileSync(file, line);
			size += Buffer.byteLength(line);
			if (size > MOST_LOG_BYTES) {
				size = trim(file);
			}
		} catch {
			// The log is a help, never a reason to stop
		}
	};
}

function sizeOf(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

/** Keeps the newest whole lines of `file` within {@link KEPT_LOG_BYTES}; answers its size then. */
function trim(file: string): number {
	try {
		const size = fs.statSync(file).size;
		const kept = Buffer.alloc(Math.min(size, KEPT_LOG_BYTES));
		const fd = fs.openSync(file, 'r');
		try {
			fs.readSync(fd, kept, 0, kept.length, size - kept.length);
		} finally {
			fs.closeSync(fd);
		}
		// From the first whole line: a line cut at its start is no line
		const start = kept.length < size ? kept.indexOf(10) + 1 : 0;
		const tail = kept.subarray(start);
		fs.writeFileSync(file, tail);
		return tail.length;
	} catch {
		return sizeOf(file);
	}
}
