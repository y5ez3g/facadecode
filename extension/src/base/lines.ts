/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Newline-delimited JSON as Facade's processes read it: ptyd and its windows, and a run's MCP shim with its CLI and with ptyd. Each
// side reads whole UTF-8 lines within one bound, so that no peer makes it hold an unbounded partial line.

/** The longest line a reader takes: an 8 MiB screen even with JSON's sixfold control-character escaping, plus its envelope. */
export const MAX_JSON_LINE_BYTES = 64 * 1024 * 1024;

export interface LineReaderOptions {
	/** The longest line taken, in UTF-8 bytes without its line break: {@link MAX_JSON_LINE_BYTES} by default. */
	readonly maxBytes?: number;
	/**
	 * What follows a longer line: `stop`, the default, reads nothing more - its caller closes the transport, and neither that line
	 * nor any after it is delivered; `skip` drops that line up to its line break and reads on from the next.
	 */
	readonly oversized?: 'stop' | 'skip';
}

/**
 * Reads complete UTF-8 lines as chunks come and gives each nonblank one to `onLine`, in order. A line of several megabytes arriving
 * in many small pieces is gathered into one growing buffer and decoded once, so that a character split between chunks is read whole.
 * A line longer than its bound is never delivered, even in part: `onOversized` is told instead.
 */
export function lineReader(onLine: (line: string) => void, onOversized: (err: Error) => void, options: LineReaderOptions = {}): (chunk: string | Buffer) => void {
	const maxBytes = options.maxBytes ?? MAX_JSON_LINE_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error('A line limit must be a positive safe integer.');
	}
	let buffer: Buffer | undefined;
	let length = 0;
	let stopped = false;
	let skipping = false;
	return chunk => {
		if (stopped) {
			return;
		}
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		for (let start = 0; start < bytes.length;) {
			const newline = bytes.indexOf(10, start);
			if (skipping) {
				// The rest of a line too long to take, dropped up to its line break
				if (newline < 0) {
					return;
				}
				skipping = false;
				start = newline + 1;
				continue;
			}
			const end = newline < 0 ? bytes.length : newline;
			const next = length + end - start;
			if (next > maxBytes) {
				buffer = undefined;
				length = 0;
				if (options.oversized === 'skip') {
					skipping = true;
				} else {
					stopped = true;
				}
				onOversized(new Error(`A line exceeds ${maxBytes} bytes.`));
				if (stopped) {
					return;
				}
				continue;
			}
			if (next) {
				if (!buffer || next > buffer.length) {
					const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(1024, next, (buffer?.length ?? 0) * 2)));
					buffer?.copy(grown, 0, 0, length);
					buffer = grown;
				}
				bytes.copy(buffer, length, start, end);
				length = next;
			}
			if (newline < 0) {
				return;
			}
			const line = buffer?.toString('utf8', 0, length) ?? '';
			buffer = undefined;
			length = 0;
			if (line.trim()) {
				onLine(line);
			}
			start = newline + 1;
		}
	};
}
