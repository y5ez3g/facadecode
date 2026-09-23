/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Puts this fork's mark where upstream's is, in the artwork that carries one.
 *
 * Three surfaces, all drawn from `resources/win32/code.ico` - the application icon, and the one
 * place the mark is authored:
 *
 *   the Windows installer     `inno-big-*.bmp` and `inno-small-*.bmp`, seven DPI steps each
 *   the Windows file icons    the badge in the corner of `c.ico`, `json.ico` and the rest
 *   the macOS file icons      the same badge in `c.icns`, `json.icns` and the rest
 *
 * ⚠️ Run it after the application icon changes: `node build/lib/facade/brandIcons.ts`. Nothing runs
 * it during a build. The output is committed, the way the artwork it replaces was, so no build
 * depends on this file being right - and `facadeIco.test.ts` fails if what is committed is not what
 * this produces.
 *
 * Every number below was measured off upstream's own artwork rather than chosen. The measurements
 * are in the comments beside them, and the tests hold the ones that can be checked.
 */

import fs from 'fs';
import path from 'path';
import { type IIcoFrame, type IRaster, composite, crop, decodeFrame, encodeBmp, encodeFrame, inkBounds, readIco, resample, writeIco } from './ico.ts';
import { type IIcnsEntry, decodeEntry, encodeEntry, isPngEntry, readIcns, writeIcns } from './icns.ts';

const ROOT = path.dirname(path.dirname(path.dirname(import.meta.dirname)));
const WIN32 = path.join(ROOT, 'resources', 'win32');
const DARWIN = path.join(ROOT, 'resources', 'darwin');

/** The application icon, which is where the mark is authored. */
export const SOURCE_ICON = 'code.ico';

/** White, which is what upstream's wizard images are on - sampled at all four corners. */
export const WIZARD_BACKGROUND: readonly [number, number, number] = [255, 255, 255];

/**
 * The wizard images, at the sizes Inno Setup asks for.
 *
 * ⚠️ `mark` is the share of the canvas width upstream's mark takes: measured 120 of 164 on the big
 * image and 42 of 55 on the small one, both centred on both axes to within half a pixel.
 */
export const WIZARD_IMAGES: readonly { readonly name: string; readonly w: number; readonly h: number; readonly mark: number }[] = [
	{ name: 'inno-big-100', w: 164, h: 314, mark: 0.73 },
	{ name: 'inno-big-125', w: 192, h: 386, mark: 0.73 },
	{ name: 'inno-big-150', w: 246, h: 459, mark: 0.73 },
	{ name: 'inno-big-175', w: 273, h: 556, mark: 0.73 },
	{ name: 'inno-big-200', w: 328, h: 604, mark: 0.73 },
	{ name: 'inno-big-225', w: 355, h: 700, mark: 0.73 },
	{ name: 'inno-big-250', w: 410, h: 797, mark: 0.73 },
	{ name: 'inno-small-100', w: 55, h: 55, mark: 0.76 },
	{ name: 'inno-small-125', w: 64, h: 68, mark: 0.76 },
	{ name: 'inno-small-150', w: 83, h: 80, mark: 0.76 },
	{ name: 'inno-small-175', w: 92, h: 97, mark: 0.76 },
	{ name: 'inno-small-200', w: 110, h: 106, mark: 0.76 },
	{ name: 'inno-small-225', w: 119, h: 123, mark: 0.76 },
	{ name: 'inno-small-250', w: 138, h: 140, mark: 0.76 }
];

/** No image's mark may take more of the canvas height than this, or the tall ones read as a banner. */
const WIZARD_MAX_HEIGHT = 0.86;

/**
 * Where the badge sits on a file type icon, as a share of the frame.
 *
 * ⚠️ One set of numbers per platform, because the two sets of artwork do not agree. Both were read
 * off `default`, the template with no language mark on it, and each was the same to four decimal
 * places on every frame of it that carries a badge:
 *
 *     windows   x 0.6250  y 0.7656  w 0.1797  h 0.1563     measured on 64, 96, 128, 256
 *     macOS     x 0.6563  y 0.7422  w 0.2617  h 0.2227     measured on 128, 256, 512
 *
 * The macOS badge is half as wide again as its Windows counterpart, in proportion. Assuming one
 * from the other would have put the mark a good margin off centre.
 */
export const BADGE_BOX = { x: 0.6250, y: 0.7656, w: 0.1797, h: 0.1563 };
export const DARWIN_BADGE_BOX = { x: 0.6563, y: 0.7422, w: 0.2617, h: 0.2227 };

/**
 * How far past the badge the erase has to reach.
 *
 * ⚠️ The badge is not printed straight onto the page: there is a white keyline round it, with a
 * half-lit pixel outside that. Measured along the badge's middle row at 256 - page 245, then 247,
 * then two pixels of 255, then the badge - it ends three pixels out from the box; at 128 and 96 two,
 * at 64 one. Three parts in 256 covers all four, and the spare pixel at the small sizes lands on
 * page, which is what it is being painted with.
 *
 * ⚠️ A fixed margin rather than walking outwards looking for it. The first pixel outside the box is
 * the badge's own antialiased edge, which is darker than the page, so a walk stops there and never
 * reaches the keyline beyond it.
 *
 * ⚠️ The macOS artwork has no keyline - its page is white up to the badge - but it needs the margin
 * for the same antialiased edge. What differs there is where the rectangle lands: the macOS badge
 * overhangs the page on two sides, so most of this rectangle is not over page at all. `erasePage`
 * is what knows the difference.
 */
export const BADGE_ERASE_MARGIN = 3 / 256;

/**
 * The smallest frame that carries a badge at all.
 *
 * ⚠️ Upstream draws none below this - measured, not one pixel of badge colour on the 16, 20, 24, 32
 * or 48 frames of `default.ico` - because a badge that small is a smudge. Followed rather than
 * improved on: those frames come back byte for byte identical, which `brandIcons.test.ts` checks.
 */
export const BADGE_MIN_FRAME = 64;

type Box = { x: number; y: number; w: number; h: number };
type BadgeShare = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

function badgeBox(size: number, share: BadgeShare): Box {
	return {
		x: Math.round(share.x * size),
		y: Math.round(share.y * size),
		w: Math.round(share.w * size),
		h: Math.round(share.h * size)
	};
}

export function eraseRect(size: number, share: BadgeShare = BADGE_BOX): Box {
	const box = badgeBox(size, share);
	const pad = Math.max(2, Math.round(size * BADGE_ERASE_MARGIN));
	return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}

/** Takes the badge off one frame and puts the mark in its place. */
function swapBadge(img: IRaster, mark: IRaster, share: BadgeShare): void {
	erasePage(img, eraseRect(img.w, share));

	const box = badgeBox(img.w, share);
	const scale = Math.min(box.w / mark.w, box.h / mark.h);
	const w = Math.max(1, Math.round(mark.w * scale));
	const h = Math.max(1, Math.round(mark.h * scale));
	composite(img, resample(mark, w, h), box.x + Math.round((box.w - w) / 2), box.y + Math.round((box.h - h) / 2));
}

/** The mark on its own, with the application icon's padding trimmed off it. */
export function readMark(dir: string = WIN32): IRaster {
	const frames = readIco(fs.readFileSync(path.join(dir, SOURCE_ICON)));
	const largest = frames.reduce((a, b) => (b.w > a.w ? b : a));
	const img = decodeFrame(largest);
	return crop(img, inkBounds(img));
}

/** How far outside the rectangle the artwork is read from. Far enough to clear the badge's own edge. */
const SAMPLE_OFFSET = 3;

/**
 * Takes the badge off by carrying the artwork around it across the space it occupied.
 *
 * Two profiles, because the badge does not sit in one kind of place:
 *
 *   on the page       the pixel to the left of the rectangle, on the same row - so the page's own
 *                     tone, per row rather than one flat fill, since the Windows page carries a
 *                     slight vertical gradient down the badge's height
 *
 *   past its edge     the pixel at the same column on a row just above the rectangle - so the
 *                     page's right-hand shadow, at the strength that column already had it
 *
 * ⚠️ The second profile exists because the macOS badge overhangs the page on two sides. Measured on
 * the 256 frame of `default.icns`: the page's right edge is at x=217 on every row above the badge
 * and its bottom edge at y=239, while the badge runs to x=237 and y=251. Carrying the row's page
 * tone all the way across left an opaque white block hanging off the page's right side, which is
 * invisible against anything white and a bright slab against anything else.
 *
 * ⚠️ Alpha is copied with the colour, and that is what makes the bottom overhang right: under the
 * page's last row there is no page, and the pixel beside it holds the shadow fading into nothing.
 *
 * ⚠️ `above` is a sixteenth of the frame clear of the rectangle, for room this artwork does not
 * need. Measured at 256, the badge's white backing starts at y=187 and the rectangle's own top edge
 * is 187, so two rows up already reads the page - `pageRight` comes out 217 either way, and the
 * icons are byte for byte the same with it at two rows or at sixteen. The distance is here because
 * two rows is the whole of the rectangle's top margin, and a badge drawn a little taller would put
 * its own edge under the reference row without anything saying so.
 *
 * ⚠️ On the Windows artwork the badge is well inside the page, `pageRight` comes out past the
 * rectangle, and the second profile is never used.
 */
export function erasePage(img: IRaster, rect: { x: number; y: number; w: number; h: number }): void {
	const above = Math.max(0, rect.y - Math.round(img.h / 16));
	const opaque = (x: number, y: number) => img.rgba[(y * img.w + x) * 4 + 3] >= 250;

	let pageRight = img.w - 1;
	while (pageRight > 0 && !opaque(pageRight, above)) {
		pageRight--;
	}

	const copy = (to: number, from: number) => {
		img.rgba[to] = img.rgba[from];
		img.rgba[to + 1] = img.rgba[from + 1];
		img.rgba[to + 2] = img.rgba[from + 2];
		img.rgba[to + 3] = img.rgba[from + 3];
	};

	for (let y = rect.y; y < rect.y + rect.h; y++) {
		if (y < 0 || y >= img.h) {
			continue;
		}
		const beside = (Math.max(0, rect.x - SAMPLE_OFFSET) + y * img.w) * 4;
		for (let x = Math.max(0, rect.x); x < Math.min(img.w, rect.x + rect.w); x++) {
			copy((y * img.w + x) * 4, x <= pageRight ? beside : (above * img.w + x) * 4);
		}
	}
}

/** Swaps the badge on one Windows file type icon, leaving every frame below {@link BADGE_MIN_FRAME} alone. */
export function rebadge(ico: Buffer, mark: IRaster): Buffer {
	const out: IIcoFrame[] = readIco(ico).map(frame => {
		if (frame.w < BADGE_MIN_FRAME) {
			return frame;
		}
		const img = decodeFrame(frame);
		swapBadge(img, mark, BADGE_BOX);
		return { ...frame, data: encodeFrame(frame, img) };
	});
	return writeIco(out);
}

/**
 * The same for a macOS file type icon.
 *
 * ⚠️ PNG entries only. The small sizes are stored as packed ARGB, and they are also the sizes with
 * no badge on them - see {@link BADGE_MIN_FRAME} - so the entries that would need another decoder
 * written are the entries there is nothing to do to. They are copied through untouched.
 */
export function rebadgeIcns(icns: Buffer, mark: IRaster): Buffer {
	const out: IIcnsEntry[] = readIcns(icns).map(entry => {
		if (!isPngEntry(entry)) {
			return entry;
		}
		const img = decodeEntry(entry);
		if (img.w < BADGE_MIN_FRAME) {
			return entry;
		}
		swapBadge(img, mark, DARWIN_BADGE_BOX);
		return encodeEntry(entry, img);
	});
	return writeIcns(out);
}

/**
 * Where the mark goes on a wizard canvas: fitted by width, centred on both axes.
 *
 * ⚠️ The height clamp does not fire for the mark this fork ships - it is wider than it is tall, so
 * width is always the tighter of the two. It is here for the one that is not, because a tall mark
 * fitted by width alone runs off a 164x314 canvas. Separated from the drawing so that the branch
 * can be reached from a test without an image to look at.
 */
export function fitMark(spec: { w: number; h: number; mark: number }, mark: { w: number; h: number }): { w: number; h: number; x: number; y: number } {
	let w = Math.round(spec.w * spec.mark);
	let h = Math.round(w * mark.h / mark.w);
	if (h > spec.h * WIZARD_MAX_HEIGHT) {
		h = Math.round(spec.h * WIZARD_MAX_HEIGHT);
		w = Math.round(h * mark.w / mark.h);
	}
	return { w, h, x: Math.round((spec.w - w) / 2), y: Math.round((spec.h - h) / 2) };
}

/** One wizard image: the mark centred on white. */
export function wizardImage(spec: typeof WIZARD_IMAGES[number], mark: IRaster): Buffer {
	const canvas: IRaster = { w: spec.w, h: spec.h, rgba: Buffer.alloc(spec.w * spec.h * 4) };
	const at = fitMark(spec, mark);
	composite(canvas, resample(mark, at.w, at.h), at.x, at.y);
	return encodeBmp(canvas, WIZARD_BACKGROUND);
}

export function main(dir: string = WIN32, darwinDir: string = DARWIN): void {
	const mark = readMark(dir);
	console.log(`mark ${mark.w}x${mark.h} from ${SOURCE_ICON}`);

	for (const spec of WIZARD_IMAGES) {
		fs.writeFileSync(path.join(dir, `${spec.name}.bmp`), wizardImage(spec, mark));
	}
	console.log(`  ${WIZARD_IMAGES.length} wizard images`);

	const icons = fs.readdirSync(dir).filter(n => n.endsWith('.ico') && n !== SOURCE_ICON);
	for (const icon of icons) {
		fs.writeFileSync(path.join(dir, icon), rebadge(fs.readFileSync(path.join(dir, icon)), mark));
	}
	console.log(`  ${icons.length} Windows file type icons`);

	// ⚠️ From `code.ico`, not from `resources/darwin/code.icns` beside these. The macOS application
	// icon is the same mark, but printed on a filled white tile - measured, its 1024 frame is opaque
	// to all four corners - because that is the shape a macOS application icon is. A badge wants the
	// mark and not the tile, and the Windows icon is where the mark is kept on its own.
	const darwinIcons = fs.readdirSync(darwinDir).filter(n => n.endsWith('.icns') && n !== 'code.icns');
	for (const icon of darwinIcons) {
		fs.writeFileSync(path.join(darwinDir, icon), rebadgeIcns(fs.readFileSync(path.join(darwinDir, icon)), mark));
	}
	console.log(`  ${darwinIcons.length} macOS file type icons`);
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
	main();
}
