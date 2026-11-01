/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What vendor history discovery shares (LIFECYCLE-3.2, CLIS-2.4): the scope - the window's directories and everything below them -
// and reading only the head of a conversation file, never the whole of a long one.

import * as fs from 'fs';
import { isEqualPath, isInsideFolder } from '../../base/files';
import { isJsonObject } from '../../base/json';
import { displayLine } from '../../base/text';

/** The most of a conversation file read for its list metadata. */
export const HEAD_BYTES = 64 * 1024;
/**
 * How far a conversation's file is read where its head gives no title, or no whole line: a CLI can write a long preamble first - its
 * own instructions, skills and environment - and a first prompt can be a long paste (LIFECYCLE-3.2). Still list metadata, never the log.
 */
export const PROMPT_BYTES = 1024 * 1024;

/** The longest title a picker entry shows, in code points. */
const MOST_TITLE = 120;

/** `folder` as given and as it really is: a CLI may record either - macOS's /tmp is /private/tmp. */
export function formsOf(folder: string): string[] {
	let real = folder;
	try {
		real = fs.realpathSync.native(folder);
	} catch {
		// Gone: as given
	}
	return [...new Set([folder, real])];
}

/** Whether `cwd` is one of `directories` or inside one, compared as given and as they really are. */
export function inScope(cwd: string, directories: readonly string[]): boolean {
	const forms = formsOf(cwd);
	return directories.some(dir => formsOf(dir).some(scope => forms.some(each => isEqualPath(each, scope) || isInsideFolder(each, scope))));
}

/** Bounded list metadata at both ends, using one handle; small files are read only once. */
export async function edgeLines(file: string): Promise<{ head: { readonly [key: string]: unknown }[]; tail: { readonly [key: string]: unknown }[]; size: number }> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(file, 'r');
		const { size } = await handle.stat();
		const buffer = Buffer.alloc(Math.min(HEAD_BYTES, size));
		const first = await handle.read(buffer, 0, buffer.length, 0);
		const beginning = buffer.subarray(0, first.bytesRead).toString('utf8').split('\n');
		if (size <= first.bytesRead) {
			const head = objectsOf(beginning);
			return { head, tail: head, size };
		}
		beginning.pop();
		const last = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
		const ending = buffer.subarray(0, last.bytesRead).toString('utf8').split('\n');
		ending.shift();
		return { head: objectsOf(beginning), tail: objectsOf(ending), size };
	} catch {
		return { head: [], tail: [], size: 0 };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** The whole JSON-object lines among the last `bytes` of `file`: where a CLI appends what renames a conversation. */
export async function tailLines(file: string, bytes = HEAD_BYTES): Promise<{ readonly [key: string]: unknown }[]> {
	let handle: fs.promises.FileHandle | undefined;
	let text = '';
	let cut = false;
	try {
		handle = await fs.promises.open(file, 'r');
		const { size } = await handle.stat();
		const buffer = Buffer.alloc(Math.min(bytes, size));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
		text = buffer.subarray(0, bytesRead).toString('utf8');
		cut = size > bytesRead;
	} catch {
		return [];
	} finally {
		await handle?.close().catch(() => undefined);
	}
	const lines = text.split('\n');
	if (cut) {
		lines.shift();
	}
	return objectsOf(lines);
}

/** The whole JSON-object lines among the first `bytes` of `file`, no more than `most`; a line cut short is not read. */
export async function headLines(file: string, bytes = HEAD_BYTES, most = Infinity): Promise<{ readonly [key: string]: unknown }[]> {
	let handle: fs.promises.FileHandle | undefined;
	let text = '';
	let cut = false;
	try {
		handle = await fs.promises.open(file, 'r');
		const { size } = await handle.stat();
		const buffer = Buffer.alloc(Math.min(bytes, size));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		text = buffer.subarray(0, bytesRead).toString('utf8');
		cut = size > bytesRead;
	} catch {
		return [];
	} finally {
		await handle?.close().catch(() => undefined);
	}
	const lines = text.split('\n');
	if (cut) {
		lines.pop();
	}
	return objectsOf(lines, most);
}

/** The JSON objects among `lines`, no more than `most`. */
function objectsOf(lines: readonly string[], most = Infinity): { readonly [key: string]: unknown }[] {
	const objects: { readonly [key: string]: unknown }[] = [];
	for (const line of lines) {
		if (objects.length >= most) {
			break;
		}
		try {
			const value: unknown = JSON.parse(line);
			if (isJsonObject(value)) {
				objects.push(value);
			}
		} catch {
			// Not a record: the next line may be
		}
	}
	return objects;
}

/** `text` as a picker's title: its first line, one line of display text, capped. */
export function titleOf(text: string): string | undefined {
	return displayLine(text.trim().split(/\r?\n/)[0] ?? '', MOST_TITLE) || undefined;
}

/** The names in `dir` that `pattern` takes, sorted; none where it cannot be read. */
export function namesIn(dir: string, pattern?: RegExp): string[] {
	try {
		return fs.readdirSync(dir).filter(name => !pattern || pattern.test(name)).sort();
	} catch {
		return [];
	}
}

/** When `file` last changed; undefined where it cannot be read. */
export function mtimeOf(file: string): number | undefined {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}
