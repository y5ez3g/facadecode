/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { isJsonObject, isStringArray } from '../base/json';

/** Where a workspace's record keeps its agents' screens. */
const SCREENS_DIR = 'screens';

/** A screen file of an agent's: `a7.json` for its final screen, `a7-<time>.txt` for a screen read while it ran. */
const SCREEN_FILE = /^a(?<id>\d+)(?:\.json|-\d+(?:-\d+)?\.txt)$/;

/** The folder of a workspace's record `dir` that holds its agents' screens. */
export function screensDir(dir: string): string {
	return path.join(dir, SCREENS_DIR);
}

/** The file the window writes the agent `id`'s final screen to as its terminal ends, in the screens folder `dir`. */
export function finalScreenFile(dir: string, id: number): string {
	return path.join(dir, `a${id}.json`);
}

/**
 * An agent's final screen, as the window writes it: the screen as its terminal ended and, where a
 * full-screen program left the alternate buffer before, the last frame it drew there.
 */
export interface FinalScreen {
	readonly final: { readonly buffer: 'normal' | 'alternate'; readonly lines: readonly string[] };
	readonly frame?: readonly string[];
}

/** A final screen that could not be read: what is wrong with its file. */
export class FinalScreenError extends Error { }

/** The final screen `text` holds, as the window writes it; throws `FinalScreenError` for text that is not one. */
export function parseFinalScreen(text: string): FinalScreen {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new FinalScreenError('it is not JSON');
	}
	const final = isJsonObject(value) ? value.final : undefined;
	if (!isJsonObject(value) || !isJsonObject(final) || (final.buffer !== 'normal' && final.buffer !== 'alternate') || !isStringArray(final.lines) || (value.frame !== undefined && !isStringArray(value.frame))) {
		throw new FinalScreenError('it is not a final screen as the window writes one');
	}
	return { final: { buffer: final.buffer, lines: final.lines }, ...(value.frame !== undefined ? { frame: value.frame } : {}) };
}

/**
 * The final screen in `file`; undefined where there is no such file. Throws where it cannot be read, or
 * holds no final screen: a `FinalScreenError` for that.
 */
export function readFinalScreen(file: string): FinalScreen | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return undefined;
		}
		throw err;
	}
	return parseFinalScreen(text);
}

/**
 * Writes the lines of a screen read from the agent `id` at `time` to a file of their own in the screens
 * folder `dir`, which nothing writes to again: answers with its path.
 */
export function writeScreenSnapshot(dir: string, id: number, time: number, lines: readonly string[]): string {
	fs.mkdirSync(dir, { recursive: true });
	for (let attempt = 0; ; attempt++) {
		const file = path.join(dir, `a${id}-${time}${attempt ? `-${attempt}` : ''}.txt`);
		try {
			fs.writeFileSync(file, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
			return file;
		} catch (err) {
			if (codeOf(err) !== 'EEXIST') {
				throw err;
			}
		}
	}
}

/** Deletes the screen files - final screens and screens read - of the agents `ids` in the screens folder `dir`: answers how many. */
export function discardScreens(dir: string, ids: ReadonlySet<number>): number {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return 0;
		}
		throw err;
	}
	let discarded = 0;
	for (const name of names) {
		const id = SCREEN_FILE.exec(name)?.groups?.id;
		if (id !== undefined && ids.has(Number(id))) {
			fs.rmSync(path.join(dir, name), { force: true });
			discarded++;
		}
	}
	return discarded;
}
