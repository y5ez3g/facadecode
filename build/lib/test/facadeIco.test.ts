/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { suite, test } from 'node:test';
import { type IRaster, decodeFrame, decodePng, encodeBmp, encodeDib, encodePng, readIco, writeIco } from '../facade/ico.ts';
import { BADGE_MIN_FRAME, eraseRect, fitMark, readMark, rebadge, SOURCE_ICON } from '../facade/brandIcons.ts';

const win32 = path.resolve(import.meta.dirname, '../../../resources/win32');

/** A small raster with an alpha ramp, so a round trip has something to lose. */
function sample(w = 7, h = 5): IRaster {
	const rgba = Buffer.alloc(w * h * 4);
	for (let i = 0, n = w * h; i < n; i++) {
		rgba[i * 4] = (i * 37) & 0xff;
		rgba[i * 4 + 1] = (i * 11) & 0xff;
		rgba[i * 4 + 2] = (i * 97) & 0xff;
		rgba[i * 4 + 3] = i % 5 === 0 ? 0 : 255 - (i % 4);
	}
	return { w, h, rgba };
}

suite('Facade icon tooling - what goes in comes back', () => {

	test('PNG and DIB both round trip every channel', () => {
		const src = sample();
		const png = decodePng(encodePng(src));
		const dib = decodeFrame({ w: src.w, h: src.h, isPng: false, data: encodeDib(src) });

		assert.deepStrictEqual(
			[png.w, png.h, png.rgba.equals(src.rgba), dib.w, dib.h, dib.rgba.equals(src.rgba)],
			[src.w, src.h, true, src.w, src.h, true]);
	});

	test('a PNG this cannot read is refused, not read wrong', () => {
		// The kinds that would otherwise come back as a picture nobody wrote: an interlaced file
		// walked as though it were scanlines, and a bit depth or colour type read at the wrong
		// stride. Each is the header of a real PNG with one byte of IHDR changed.
		const png = encodePng(sample(4, 4));
		const withIhdrByte = (offset: number, value: number) => {
			const copy = Buffer.from(png);
			copy[8 + 8 + offset] = value;		// signature, then the IHDR length and type
			return copy;
		};

		assert.deepStrictEqual([
			(() => { try { decodePng(withIhdrByte(12, 1)); return 'read'; } catch (e) { return (e as Error).message; } })(),
			(() => { try { decodePng(withIhdrByte(8, 4)); return 'read'; } catch (e) { return (e as Error).message; } })(),
			(() => { try { decodePng(withIhdrByte(9, 3)); return 'read'; } catch (e) { return (e as Error).message; } })(),
			(() => { try { decodePng(withIhdrByte(10, 1)); return 'read'; } catch (e) { return (e as Error).message; } })()
		], [
			'interlaced PNG is not handled',
			'PNG bit depth 4 is not handled',
			'PNG colour type 3 is not handled',
			'PNG compression method 1 with filter method 0 is not handled'
		]);
	});

	test('an icon directory keeps its frames, their order and their sizes', () => {
		const src = sample(4, 4);
		const frames = [
			{ w: 4, h: 4, isPng: false, data: encodeDib(src) },
			{ w: 256, h: 256, isPng: true, data: encodePng(src) }
		];
		const read = readIco(writeIco(frames));

		assert.deepStrictEqual(
			read.map(f => [f.w, f.h, f.isPng, f.data.length]),
			frames.map(f => [f.w, f.h, f.isPng, f.data.length]));
	});

	test('the wizard mark is fitted by width, and by height when that would overflow', () => {
		const canvas = { w: 164, h: 314, mark: 0.73 };

		assert.deepStrictEqual([
			// the mark this fork ships: 256 x 240, so width is the tighter fit and the clamp sleeps
			fitMark(canvas, { w: 256, h: 240 }),
			// a square one, still inside 86% of 314
			fitMark(canvas, { w: 100, h: 100 }),
			// a tall one: 120 wide would be 480 high, which is taller than the canvas
			fitMark(canvas, { w: 100, h: 400 })
		], [
			{ w: 120, h: 113, x: 22, y: 101 },
			{ w: 120, h: 120, x: 22, y: 97 },
			{ w: 68, h: 270, x: 48, y: 22 }
		]);
	});

	test('a BMP is 24bpp, bottom-up, and flattened onto the background it was given', () => {
		// one opaque red pixel and one fully transparent, on white
		const src: IRaster = { w: 2, h: 1, rgba: Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]) };
		const bmp = encodeBmp(src, [255, 255, 255]);

		assert.deepStrictEqual([
			bmp.toString('ascii', 0, 2),
			bmp.readUInt16LE(28),			// bit count
			bmp.readInt32LE(22),			// positive height means bottom-up
			[...bmp.subarray(54, 60)]		// BGR, BGR
		], ['BM', 24, 1, [0, 0, 255, 255, 255, 255]]);
	});
});

suite('Facade icon tooling - the badge on the file type icons', () => {

	const icons = fs.readdirSync(win32).filter(n => n.endsWith('.ico') && n !== SOURCE_ICON);

	test('the erase reaches past the keyline at every size upstream draws one', () => {
		// Measured on `default.ico`, the badge and the keyline drawn round it, by frame:
		//
		//     64    badge 40..51    keyline 39, 52
		//     96    badge 60..76    keyline 59, 78
		//    128    badge 80..102   keyline 78, 104
		//    256    badge 160..205  keyline 157..158, 207..208
		//
		// The erase has to cover the second column. It may reach past it - what is beyond is page,
		// and page is what those pixels are being painted with.
		assert.deepStrictEqual([64, 96, 128, 256].map(size => {
			const r = eraseRect(size);
			return [size, r.x, r.x + r.w - 1];
		}), [
			[64, 38, 53],
			[96, 58, 78],
			[128, 78, 104],
			[256, 157, 208]
		]);
	});

	test('the committed icons are what the generator makes of the application icon', () => {
		// Idempotent by construction: the erase reads the page beside the badge, which the badge
		// never covered. So re-running it over a committed icon has to hand back the same bytes, and
		// when it does not, the artwork and `code.ico` have come apart.
		const mark = readMark(win32);
		const drifted = icons.filter(name => {
			const committed = fs.readFileSync(path.join(win32, name));
			return !rebadge(committed, mark).equals(committed);
		});

		assert.deepStrictEqual(drifted, []);
	});

	test('every badged frame carries our mark and none of upstream\'s blue', () => {
		// ⚠️ Only the frames that have a badge at all. Below `BADGE_MIN_FRAME` the box is a large
		// share of a tiny canvas and covers the page's own rules and language mark, so counting ink
		// or colour inside it there measures the artwork, not the badge. That those frames were not
		// touched is what the idempotency test above establishes - `rebadge` hands them back whole.
		const withBlue: string[] = [];
		const withoutMark: string[] = [];

		for (const name of icons) {
			for (const frame of readIco(fs.readFileSync(path.join(win32, name)))) {
				if (frame.w < BADGE_MIN_FRAME) {
					continue;
				}
				const img = decodeFrame(frame);
				const box = eraseRect(img.w);
				let blue = 0, ink = 0;
				for (let y = Math.max(0, box.y); y < Math.min(img.h, box.y + box.h); y++) {
					for (let x = Math.max(0, box.x); x < Math.min(img.w, box.x + box.w); x++) {
						const d = (y * img.w + x) * 4;
						const [r, g, b, a] = [img.rgba[d], img.rgba[d + 1], img.rgba[d + 2], img.rgba[d + 3]];
						if (a > 200 && b - r > 50 && b > 100) { blue++; }
						if (a > 200 && (r * 0.299 + g * 0.587 + b * 0.114) < 128) { ink++; }
					}
				}
				if (blue > 0) { withBlue.push(`${name} ${img.w}px`); }
				if (ink === 0) { withoutMark.push(`${name} ${img.w}px`); }
			}
		}

		assert.deepStrictEqual({ withBlue, withoutMark }, { withBlue: [], withoutMark: [] });
	});
});
