/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { suite, test } from 'node:test';
import { encodePng } from '../facade/ico.ts';
import { decodeEntry, isPngEntry, readIcns, writeIcns } from '../facade/icns.ts';
import { BADGE_MIN_FRAME, DARWIN_BADGE_BOX, erasePage, eraseRect, readMark, rebadgeIcns } from '../facade/brandIcons.ts';

const win32 = path.resolve(import.meta.dirname, '../../../resources/win32');
const darwin = path.resolve(import.meta.dirname, '../../../resources/darwin');
const icons = fs.readdirSync(darwin).filter(n => n.endsWith('.icns') && n !== 'code.icns');

suite('Facade icon tooling - the macOS container', () => {

	test('an icns keeps its entries, their order and their types', () => {
		const png = encodePng({ w: 2, h: 2, rgba: Buffer.alloc(16, 0x80) });
		const entries = [
			{ type: 'info', data: Buffer.from('not an image') },
			{ type: 'ic08', data: png }
		];
		const read = readIcns(writeIcns(entries));

		assert.deepStrictEqual(
			read.map(e => [e.type, e.data.length, isPngEntry(e)]),
			[['info', entries[0].data.length, false], ['ic08', png.length, true]]);
	});

	test('a file that is not an icns is refused rather than read as one', () => {
		assert.throws(() => readIcns(Buffer.from('PK\u0003\u0004and then some')), /not an icns/);
	});
});

suite('Facade icon tooling - the badge on the macOS file type icons', () => {

	test('the committed icons are what the generator makes of the application icon', () => {
		const mark = readMark(win32);
		const drifted = icons.filter(name => {
			const committed = fs.readFileSync(path.join(darwin, name));
			return !rebadgeIcns(committed, mark).equals(committed);
		});

		assert.deepStrictEqual(drifted, []);
	});

	test('no upstream badge survives', () => {
		const withBlue: string[] = [];

		for (const name of icons) {
			for (const entry of readIcns(fs.readFileSync(path.join(darwin, name)))) {
				if (!isPngEntry(entry)) {
					continue;
				}
				const img = decodeEntry(entry);
				if (img.w < BADGE_MIN_FRAME) {
					continue;
				}
				const box = eraseRect(img.w, DARWIN_BADGE_BOX);
				let blue = 0;
				for (let y = Math.max(0, box.y); y < Math.min(img.h, box.y + box.h); y++) {
					for (let x = Math.max(0, box.x); x < Math.min(img.w, box.x + box.w); x++) {
						const d = (y * img.w + x) * 4;
						const [r, , b, a] = [img.rgba[d], img.rgba[d + 1], img.rgba[d + 2], img.rgba[d + 3]];
						if (a > 200 && b - r > 50 && b > 100) { blue++; }
					}
				}
				if (blue > 0) { withBlue.push(`${name} ${img.w}px`); }
			}
		}

		assert.deepStrictEqual(withBlue, []);
	});
});

suite('Facade icon tooling - taking a badge off artwork it overhangs', () => {

	/**
	 * A page with a badge in its corner, in miniature - the macOS shape, where the badge hangs off
	 * the page on the right and at the bottom:
	 *
	 *     x  0        8   11 12   16   19
	 *        # # # # # # # # # # # # ,        y 0     `#` opaque page
	 *        # # # # # # # # # # # # ,                `,` the page's shadow, one pixel of it
	 *        # # # # # # # # B B B B B B B B  y 10    `B` the badge
	 *        # # # # # # # # B B B B B B B B  y 13    the page's last row
	 *        , , , , , , , , B B B B B B B B  y 14    the shadow's last row
	 *        . . . . . . . . B B B B B B B B  y 17    nothing behind it at all
	 */
	function artwork(): { w: number; h: number; rgba: Buffer } {
		const w = 20, h = 20;
		const rgba = Buffer.alloc(w * h * 4);
		const set = (x: number, y: number, v: [number, number, number, number]) => {
			const d = (y * w + x) * 4;
			[rgba[d], rgba[d + 1], rgba[d + 2], rgba[d + 3]] = v;
		};
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (x <= 11 && y <= 13) { set(x, y, [255, 255, 255, 255]); }
				else if (x <= 12 && y <= 14) { set(x, y, [0, 0, 0, 60]); }
			}
		}
		for (let y = 10; y <= 17; y++) {
			for (let x = 8; x <= 16; x++) { set(x, y, [0, 120, 200, 255]); }
		}
		return { w, h, rgba };
	}

	test('what the badge covered comes back as page, shadow or nothing, by where it was', () => {
		const img = artwork();
		erasePage(img, { x: 7, y: 9, w: 11, h: 10 });

		const at = (x: number, y: number) => {
			const d = (y * img.w + x) * 4;
			return `${img.rgba[d]},${img.rgba[d + 3]}`;
		};

		assert.deepStrictEqual({
			onThePage: at(10, 12),			// was badge, inside the page
			pastTheRightEdge: at(15, 12),	// was badge, right of the page: nothing there
			belowTheBottom: at(10, 16),		// was badge, under the page: its shadow, then nothing
			theShadowUnderIt: at(10, 14),	// the page's own shadow row
			untouchedPage: at(3, 12),		// well left of the rectangle
			untouchedBadgeRow: at(19, 12)	// well right of it
		}, {
			onThePage: '255,255',
			pastTheRightEdge: '0,0',
			belowTheBottom: '0,0',
			theShadowUnderIt: '0,60',
			untouchedPage: '255,255',
			untouchedBadgeRow: '0,0'
		});
	});
});
