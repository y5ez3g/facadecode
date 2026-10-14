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

/**
 * The language of an agent's last screen in the editor: one of its own, whose color decorators are off - the editor
 * would take an agent's number, as `#a27`, for a color and draw a swatch before it.
 */
export const SCREEN_LANGUAGE = 'facade-screen';

/**
 * A screen file of an agent's: `a7.json` for its final screen as the window writes it - `a7.json.tmp` while it does -
 * `a7.txt` for that screen as text, `a7-<time>.txt` for a screen read while it ran.
 */
const SCREEN_FILE = /^a(?<id>\d+)(?:\.json(?:\.tmp)?|(?:-\d+(?:-\d+)?)?\.txt)$/;

/** The folder of a workspace's record `dir` that holds its agents' screens. */
export function screensDir(dir: string): string {
	return path.join(dir, SCREENS_DIR);
}

/** The file the window writes the agent `id`'s final screen to as its terminal ends, in the screens folder `dir`. */
export function finalScreenFile(dir: string, id: number): string {
	return path.join(dir, `a${id}.json`);
}

/**
 * The file an agent's final screen is in as text, in the screens folder `dir`: what an agent reads - one screen line
 * per line, its sections labeled - where the window's own file is one line of JSON.
 */
export function finalScreenTextFile(dir: string, id: number): string {
	return path.join(dir, `a${id}.txt`);
}

/**
 * An agent's final screen, as the window writes it: the screen as its terminal ended and, where a
 * full-screen program left the alternate buffer before, the last frame it drew there; when it was taken,
 * and when its terminal last showed new output. A file the window wrote before it kept those has none of them.
 */
export interface FinalScreen {
	readonly final: {
		readonly buffer: 'normal' | 'alternate';
		readonly lines: readonly string[];
		/** Whether its buffer held lines above those kept: past the 2,000 lines a final screen keeps. */
		readonly older?: boolean;
		/** Whether its terminal had let go of lines above all it held: its scrollback was full. */
		readonly trimmed?: boolean;
	};
	readonly frame?: readonly string[];
	/** When it was taken, in milliseconds since 1970. */
	readonly capturedAt?: number;
	/** When its terminal last showed new output, where that was known. */
	readonly lastOutput?: number;
}

/** A final screen that could not be read: what is wrong with its file. */
export class FinalScreenError extends Error { }

/** The final screen `text` holds, as the window writes it; throws `FinalScreenError` for text that is not one. */
export function parseFinalScreen(text: string): FinalScreen {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new FinalScreenError('the file is not valid JSON');
	}
	const final = isJsonObject(value) ? value.final : undefined;
	if (!isJsonObject(value) || !isJsonObject(final) || (final.buffer !== 'normal' && final.buffer !== 'alternate') || !isStringArray(final.lines) || (value.frame !== undefined && !isStringArray(value.frame))
		|| !isOptional(final.older, 'boolean') || !isOptional(final.trimmed, 'boolean') || !isOptional(value.capturedAt, 'number') || !isOptional(value.lastOutput, 'number')) {
		throw new FinalScreenError('the file does not match Facade\'s saved final-screen format');
	}
	return {
		final: { buffer: final.buffer, lines: final.lines, ...(typeof final.older === 'boolean' ? { older: final.older } : {}), ...(typeof final.trimmed === 'boolean' ? { trimmed: final.trimmed } : {}) },
		...(value.frame !== undefined ? { frame: value.frame } : {}),
		...(typeof value.capturedAt === 'number' ? { capturedAt: value.capturedAt } : {}),
		...(typeof value.lastOutput === 'number' ? { lastOutput: value.lastOutput } : {})
	};
}

/** Whether `value` is left out, or of type `type`. */
function isOptional(value: unknown, type: 'boolean' | 'number'): boolean {
	return value === undefined || typeof value === type;
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

/**
 * Writes the lines of the agent `id`'s final screen as text to its file in the screens folder `dir` (`finalScreenTextFile`),
 * once: a file that is there already - the same screen, written before - is left as it is. Answers with its path.
 */
export function writeFinalScreenText(dir: string, id: number, lines: readonly string[]): string {
	const file = finalScreenTextFile(dir, id);
	try {
		fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', { flag: 'wx', mode: 0o600 });
	} catch (err) {
		if (codeOf(err) !== 'EEXIST') {
			throw err;
		}
	}
	return file;
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
