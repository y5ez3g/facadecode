/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The macOS icon container, to the depth this fork needs it.
 *
 * An `.icns` is a four-character magic, a length, and then a run of entries that are each a
 * four-character type, a length that counts its own header, and the data. Nothing is compressed at
 * the container level and nothing is indexed, so an entry can be swapped for another of a different
 * size as long as the lengths are written back.
 *
 * ⚠️ The entry data is left alone unless it is a PNG. The file type icons this fork ships carry
 * `ic07`, `ic08` and `ic09` as PNG, and `ic04`, `ic05` as the old packed-ARGB formats - which are
 * the 16 and 32 pixel sizes, the ones upstream draws no badge on anyway. So the formats that would
 * need a decoder written for them are exactly the ones there is no reason to open.
 */

import { decodePng, encodePng, type IRaster } from './ico.ts';

/** One image in an `.icns`, still encoded. */
export interface IIcnsEntry {
	readonly type: string;
	readonly data: Buffer;
}

const MAGIC = 'icns';

/**
 * The optional index some writers put first, listing every other entry's type and length.
 *
 * ⚠️ Dropped rather than carried or rebuilt. Swapping an image changes its length, so an index
 * copied across is an index that lies - and nothing here needs one: it exists to let a reader skip
 * to an entry without walking the file, and a file this size is walked in microseconds. The icons
 * this fork ships have none, but an `.icns` written by the Mac tooling does, so this is the
 * difference between reading one of those safely and writing it back broken.
 */
const TABLE_OF_CONTENTS = 'TOC ';

export function readIcns(buf: Buffer): IIcnsEntry[] {
	if (buf.toString('ascii', 0, 4) !== MAGIC) {
		throw new Error('not an icns file');
	}
	const total = Math.min(buf.readUInt32BE(4), buf.length);
	const entries: IIcnsEntry[] = [];
	let off = 8;
	while (off + 8 <= total) {
		const type = buf.toString('ascii', off, off + 4);
		const length = buf.readUInt32BE(off + 4);
		if (length < 8 || off + length > total) {
			throw new Error(`icns entry '${type}' has a length of ${length} at offset ${off}`);
		}
		entries.push({ type, data: buf.subarray(off + 8, off + length) });
		off += length;
	}
	return entries;
}

export function writeIcns(entries: readonly IIcnsEntry[]): Buffer {
	const body = entries.filter(e => e.type !== TABLE_OF_CONTENTS).map(e => {
		const head = Buffer.alloc(8);
		head.write(e.type, 0, 'ascii');
		head.writeUInt32BE(8 + e.data.length, 4);
		return Buffer.concat([head, e.data]);
	});
	const head = Buffer.alloc(8);
	head.write(MAGIC, 0, 'ascii');
	head.writeUInt32BE(8 + body.reduce((n, b) => n + b.length, 0), 4);
	return Buffer.concat([head, ...body]);
}

export function isPngEntry(entry: IIcnsEntry): boolean {
	return entry.data[0] === 0x89 && entry.data.toString('ascii', 1, 4) === 'PNG';
}

export function decodeEntry(entry: IIcnsEntry): IRaster {
	if (!isPngEntry(entry)) {
		throw new Error(`icns entry '${entry.type}' is not a PNG`);
	}
	return decodePng(entry.data);
}

export function encodeEntry(entry: IIcnsEntry, img: IRaster): IIcnsEntry {
	return { type: entry.type, data: encodePng(img) };
}
