/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Just enough of PNG, BMP and ICO to re-badge the icons this fork ships.
 *
 * ⚠️ Written rather than taken from a package. The job is to open the icons already in
 * `resources/win32`, change one corner of them and write them back in the format they arrived in -
 * 32bpp DIB frames up to 128 and a PNG frame at 256 - and every encoder that does that arrives with
 * a native build step. This is a few hundred lines with no dependencies, it runs in the same
 * `node --test` the rest of `build/lib` runs in, and what it does not handle it refuses loudly.
 */

import zlib from 'zlib';

/** An 8-bit RGBA raster. */
export interface IRaster {
	readonly w: number;
	readonly h: number;
	readonly rgba: Buffer;
}

/** One image inside an `.ico`, still encoded. */
export interface IIcoFrame {
	readonly w: number;
	readonly h: number;
	readonly isPng: boolean;
	readonly data: Buffer;
}

//#region PNG

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let c = -1;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ -1) >>> 0;
}

/** Greyscale, truecolour, greyscale+alpha and truecolour+alpha. Palettes are not handled. */
const CHANNELS_PER_COLOUR_TYPE = new Map<number, number>([[0, 1], [2, 3], [4, 2], [6, 4]]);

function unfilter(raw: Buffer, w: number, h: number, channels: number): Buffer {
	const stride = w * channels;
	const px = Buffer.alloc(h * stride);
	let p = 0;
	for (let y = 0; y < h; y++) {
		const filter = raw[p++];
		const line = raw.subarray(p, p + stride);
		p += stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? px[y * stride + x - channels] : 0;
			const b = y > 0 ? px[(y - 1) * stride + x] : 0;
			const c = (x >= channels && y > 0) ? px[(y - 1) * stride + x - channels] : 0;
			let v = line[x];
			switch (filter) {
				case 1: v += a; break;
				case 2: v += b; break;
				case 3: v += (a + b) >> 1; break;
				case 4: {
					const p0 = a + b - c;
					const pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c);
					v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
					break;
				}
			}
			px[y * stride + x] = v & 0xff;
		}
	}
	return px;
}

export function decodePng(buf: Buffer): IRaster {
	let off = 8, w = 0, h = 0, colourType = 0, bitDepth = 8;
	let compression = 0, filterMethod = 0, interlace = 0;
	const idat: Buffer[] = [];
	while (off < buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString('ascii', off + 4, off + 8);
		const data = buf.subarray(off + 8, off + 8 + len);
		if (type === 'IHDR') {
			w = data.readUInt32BE(0);
			h = data.readUInt32BE(4);
			bitDepth = data[8];
			colourType = data[9];
			compression = data[10];
			filterMethod = data[11];
			interlace = data[12];
		} else if (type === 'IDAT') {
			idat.push(data);
		} else if (type === 'IEND') {
			break;
		}
		off += 12 + len;
	}
	if (bitDepth !== 8) {
		throw new Error(`PNG bit depth ${bitDepth} is not handled`);
	}
	const channels = CHANNELS_PER_COLOUR_TYPE.get(colourType);
	if (!channels) {
		throw new Error(`PNG colour type ${colourType} is not handled`);
	}
	// ⚠️ Refused rather than mis-read. An interlaced PNG holds seven reduced images where this
	// expects one, so `unfilter` would walk it as scanlines and hand back a picture nobody wrote -
	// no error, just an icon that is wrong. Every PNG in this repository is non-interlaced, and the
	// point of the check is the one that arrives later from some other exporter. The compression and
	// filter methods have one defined value each for the same reason.
	if (interlace !== 0) {
		throw new Error('interlaced PNG is not handled');
	}
	if (compression !== 0 || filterMethod !== 0) {
		throw new Error(`PNG compression method ${compression} with filter method ${filterMethod} is not handled`);
	}

	const px = unfilter(zlib.inflateSync(Buffer.concat(idat)), w, h, channels);
	const rgba = Buffer.alloc(w * h * 4);
	for (let i = 0, n = w * h; i < n; i++) {
		const s = i * channels, d = i * 4;
		switch (channels) {
			case 4: rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3]; break;
			case 3: rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255; break;
			case 2: rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + 1]; break;
			default: rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255; break;
		}
	}
	return { w, h, rgba };
}

function pngChunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

export function encodePng(img: IRaster): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(img.w, 0);
	ihdr.writeUInt32BE(img.h, 4);
	ihdr[8] = 8;		// bit depth
	ihdr[9] = 6;		// RGBA
	const stride = img.w * 4;
	const raw = Buffer.alloc(img.h * (stride + 1));
	for (let y = 0; y < img.h; y++) {
		raw[y * (stride + 1)] = 0;		// filter: none
		img.rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

//#endregion

//#region DIB - the frame format inside an .ico below 256px

/**
 * ⚠️ 32bpp only, and it says so rather than guessing. Every frame this fork has to open is 32bpp -
 * checked across all 28 icons - and a palette decoder written for frames that do not exist is a
 * decoder nobody can tell is wrong.
 */
export function decodeDib(buf: Buffer): IRaster {
	const headerSize = buf.readUInt32LE(0);
	const w = buf.readInt32LE(4);
	const h = buf.readInt32LE(8) / 2;		// the stored height counts the XOR and AND halves
	const bits = buf.readUInt16LE(14);
	if (bits !== 32) {
		throw new Error(`only 32bpp DIB frames are handled, got ${bits}`);
	}
	const rgba = Buffer.alloc(w * h * 4);
	let p = headerSize;
	for (let y = h - 1; y >= 0; y--) {		// rows run bottom-up
		for (let x = 0; x < w; x++) {
			const d = (y * w + x) * 4;
			rgba[d] = buf[p + 2];
			rgba[d + 1] = buf[p + 1];
			rgba[d + 2] = buf[p];
			rgba[d + 3] = buf[p + 3];
			p += 4;
		}
	}
	return { w, h, rgba };
}

export function encodeDib(img: IRaster): Buffer {
	const maskStride = ((img.w + 31) >> 5) << 2;		// 1bpp rows padded to 4 bytes
	const out = Buffer.alloc(40 + img.w * img.h * 4 + maskStride * img.h);
	out.writeUInt32LE(40, 0);
	out.writeInt32LE(img.w, 4);
	out.writeInt32LE(img.h * 2, 8);
	out.writeUInt16LE(1, 12);
	out.writeUInt16LE(32, 14);
	out.writeUInt32LE(0, 16);							// BI_RGB
	out.writeUInt32LE(img.w * img.h * 4, 20);
	let p = 40;
	for (let y = img.h - 1; y >= 0; y--) {
		for (let x = 0; x < img.w; x++) {
			const s = (y * img.w + x) * 4;
			out[p] = img.rgba[s + 2];
			out[p + 1] = img.rgba[s + 1];
			out[p + 2] = img.rgba[s];
			out[p + 3] = img.rgba[s + 3];
			p += 4;
		}
	}
	// ⚠️ The AND mask is written even though 32bpp frames are composited from the alpha channel.
	// It is part of the frame's size and shells older than the alpha path still read it.
	for (let y = img.h - 1; y >= 0; y--) {
		const row = p;
		p += maskStride;
		for (let x = 0; x < img.w; x++) {
			if (img.rgba[(y * img.w + x) * 4 + 3] === 0) {
				out[row + (x >> 3)] |= 0x80 >> (x & 7);
			}
		}
	}
	return out;
}

//#endregion

//#region BMP - the standalone files Inno Setup wants for its wizard

/** A 24bpp bottom-up BMP, which is the only shape Inno Setup's wizard images are read in. */
export function encodeBmp(img: IRaster, background: readonly [number, number, number]): Buffer {
	const rowStride = (img.w * 3 + 3) & ~3;
	const pixels = rowStride * img.h;
	const out = Buffer.alloc(14 + 40 + pixels);
	out.write('BM', 0, 'ascii');
	out.writeUInt32LE(out.length, 2);
	out.writeUInt32LE(54, 10);
	out.writeUInt32LE(40, 14);
	out.writeInt32LE(img.w, 18);
	out.writeInt32LE(img.h, 22);
	out.writeUInt16LE(1, 26);
	out.writeUInt16LE(24, 28);
	out.writeUInt32LE(0, 30);
	out.writeUInt32LE(pixels, 34);
	for (let y = 0; y < img.h; y++) {
		let p = 54 + (img.h - 1 - y) * rowStride;
		for (let x = 0; x < img.w; x++) {
			const s = (y * img.w + x) * 4;
			const a = img.rgba[s + 3] / 255;
			// flattened onto the background, because a BMP has nowhere to keep the alpha
			out[p] = Math.round(img.rgba[s + 2] * a + background[2] * (1 - a));
			out[p + 1] = Math.round(img.rgba[s + 1] * a + background[1] * (1 - a));
			out[p + 2] = Math.round(img.rgba[s] * a + background[0] * (1 - a));
			p += 3;
		}
	}
	return out;
}

//#endregion

//#region ICO

export function readIco(buf: Buffer): IIcoFrame[] {
	const count = buf.readUInt16LE(4);
	const frames: IIcoFrame[] = [];
	for (let i = 0; i < count; i++) {
		const o = 6 + i * 16;
		const size = buf.readUInt32LE(o + 8);
		const offset = buf.readUInt32LE(o + 12);
		const data = buf.subarray(offset, offset + size);
		frames.push({
			w: buf[o] || 256,			// 0 means 256 in an icon directory
			h: buf[o + 1] || 256,
			isPng: data[0] === 0x89 && data[1] === 0x50,
			data
		});
	}
	return frames;
}

export function writeIco(frames: readonly IIcoFrame[]): Buffer {
	const head = Buffer.alloc(6 + frames.length * 16);
	head.writeUInt16LE(1, 2);		// type: icon
	head.writeUInt16LE(frames.length, 4);
	let offset = head.length;
	frames.forEach((f, i) => {
		const o = 6 + i * 16;
		head[o] = f.w >= 256 ? 0 : f.w;
		head[o + 1] = f.h >= 256 ? 0 : f.h;
		head.writeUInt16LE(1, o + 4);
		head.writeUInt16LE(32, o + 6);
		head.writeUInt32LE(f.data.length, o + 8);
		head.writeUInt32LE(offset, o + 12);
		offset += f.data.length;
	});
	return Buffer.concat([head, ...frames.map(f => f.data)]);
}

export function decodeFrame(frame: IIcoFrame): IRaster {
	return frame.isPng ? decodePng(frame.data) : decodeDib(frame.data);
}

export function encodeFrame(frame: IIcoFrame, img: IRaster): Buffer {
	return frame.isPng ? encodePng(img) : encodeDib(img);
}

//#endregion

//#region raster helpers

/**
 * Area-average resample.
 *
 * ⚠️ Colour is weighted by alpha. Averaging the colour of a transparent pixel in with its
 * neighbours' pulls whatever was left in the transparent pixels - white, usually - into the edge of
 * the mark, and the mark comes back with a pale halo at the small sizes where it shows most.
 */
export function resample(src: IRaster, dw: number, dh: number): IRaster {
	const out = Buffer.alloc(dw * dh * 4);
	for (let y = 0; y < dh; y++) {
		const sy0 = y * src.h / dh, sy1 = (y + 1) * src.h / dh;
		for (let x = 0; x < dw; x++) {
			const sx0 = x * src.w / dw, sx1 = (x + 1) * src.w / dw;
			let r = 0, g = 0, b = 0, alphaWeight = 0, weight = 0;
			for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
				const fy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
				if (fy <= 0) {
					continue;
				}
				for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
					const fx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
					if (fx <= 0) {
						continue;
					}
					const w = fx * fy, s = (sy * src.w + sx) * 4, a = src.rgba[s + 3] / 255;
					r += src.rgba[s] * a * w;
					g += src.rgba[s + 1] * a * w;
					b += src.rgba[s + 2] * a * w;
					alphaWeight += a * w;
					weight += w;
				}
			}
			const d = (y * dw + x) * 4;
			if (alphaWeight > 0) {
				out[d] = Math.round(Math.min(255, r / alphaWeight));
				out[d + 1] = Math.round(Math.min(255, g / alphaWeight));
				out[d + 2] = Math.round(Math.min(255, b / alphaWeight));
			}
			out[d + 3] = Math.round(Math.min(255, (alphaWeight / weight) * 255));
		}
	}
	return { w: dw, h: dh, rgba: out };
}

/** Source-over composite of `top` onto `dst` at (dx, dy). */
export function composite(dst: IRaster, top: IRaster, dx: number, dy: number): void {
	for (let y = 0; y < top.h; y++) {
		const ty = dy + y;
		if (ty < 0 || ty >= dst.h) {
			continue;
		}
		for (let x = 0; x < top.w; x++) {
			const tx = dx + x;
			if (tx < 0 || tx >= dst.w) {
				continue;
			}
			const s = (y * top.w + x) * 4, d = (ty * dst.w + tx) * 4;
			const sa = top.rgba[s + 3] / 255;
			if (sa === 0) {
				continue;
			}
			const da = dst.rgba[d + 3] / 255;
			const oa = sa + da * (1 - sa);
			for (let k = 0; k < 3; k++) {
				dst.rgba[d + k] = Math.round((top.rgba[s + k] * sa + dst.rgba[d + k] * da * (1 - sa)) / (oa || 1));
			}
			dst.rgba[d + 3] = Math.round(oa * 255);
		}
	}
}

/** The bounds of everything that is not fully transparent. */
export function inkBounds(img: IRaster): { x: number; y: number; w: number; h: number } {
	let minX = img.w, maxX = -1, minY = img.h, maxY = -1;
	for (let y = 0; y < img.h; y++) {
		for (let x = 0; x < img.w; x++) {
			if (img.rgba[(y * img.w + x) * 4 + 3] > 8) {
				if (x < minX) { minX = x; }
				if (x > maxX) { maxX = x; }
				if (y < minY) { minY = y; }
				if (y > maxY) { maxY = y; }
			}
		}
	}
	if (maxX < 0) {
		throw new Error('image has no ink');
	}
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** A copy of `rect` out of `img`. */
export function crop(img: IRaster, rect: { x: number; y: number; w: number; h: number }): IRaster {
	const rgba = Buffer.alloc(rect.w * rect.h * 4);
	for (let y = 0; y < rect.h; y++) {
		const from = ((rect.y + y) * img.w + rect.x) * 4;
		img.rgba.copy(rgba, y * rect.w * 4, from, from + rect.w * 4);
	}
	return { w: rect.w, h: rect.h, rgba };
}

//#endregion
