/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { sleepSync } from './async';
import { codeOf } from './errors';
import { isJsonObject, JsonObject } from './json';

/** The byte order mark a text file may start with. */
const BYTE_ORDER_MARK = 0xfeff;
/** How long each retry of a rename waits while another program holds the target open on Windows. */
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 320];
/** The codes Windows fails a call on a file with while another program holds it open, or is deleting it. */
export const HELD_OPEN_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** How many times a file another program writes too is read, or written, again when it changed meanwhile. */
const CHANGED_ATTEMPTS = 3;

/** Whether the file system names one file or folder by both paths: case is ignored on Windows and macOS. */
export function isEqualPath(a: string, b: string): boolean {
	const normalize = (value: string) => {
		const resolved = path.resolve(value);
		return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
	};
	return normalize(a) === normalize(b);
}

/** A folder's real path, links resolved and in its real case; the absolute path given when the folder does not exist. */
export function canonicalFolder(folder: string): string {
	const absolute = path.resolve(folder);
	try {
		return fs.realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

/** What a file was as it was read: its size, when it was last written, and which file it is. */
export interface FileStamp {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ino: number;
}

/** A file another program wrote between its read and the write that was to replace it: nothing was written. */
export class FileChangedError extends Error {
	constructor(file: string) {
		super(`${file} was written by another program while Facade wrote it, so Facade wrote nothing.`);
		this.name = 'FileChangedError';
	}
}

/** The stamp of `file`, or undefined when there is none. */
function stampOf(file: string): FileStamp | undefined {
	try {
		const { size, mtimeMs, ino } = fs.statSync(file);
		return { size, mtimeMs, ino };
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return undefined;
		}
		throw err;
	}
}

function sameStamp(a: FileStamp | undefined, b: FileStamp): boolean {
	return a !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** Whether `file` is still as `stamp` says it was read, or, for `missing`, still not there. */
function isUnchanged(file: string, stamp: FileStamp | 'missing'): boolean {
	const now = stampOf(file);
	return stamp === 'missing' ? now === undefined : sameStamp(now, stamp);
}

/**
 * Replaces the content of `file` in one step: the content is written whole and flushed to a sibling
 * file, which is then renamed over it, so a reader sees either the old content or the new one. A link is
 * followed - what it points to is replaced, and it stays a link. The file keeps its permissions; a new one
 * is readable by the user only. Nothing is left beside it when replacing fails. With `unchangedSince`, a
 * file another program writes too is replaced only while it is still as it was read - or still not
 * there - and else `FileChangedError` is thrown.
 */
export function replaceFile(file: string, content: string, unchangedSince?: FileStamp | 'missing'): void {
	let target = file;
	try {
		target = fs.realpathSync.native(file);
	} catch {
		// A new file, or a link to none.
	}
	const folder = path.dirname(target);
	fs.mkdirSync(folder, { recursive: true });
	let mode = 0o600;
	try {
		mode = fs.statSync(target).mode & 0o777;
	} catch {
		// A new file.
	}
	const next = path.join(folder, `.${path.basename(target)}.${process.pid}-${Date.now().toString(36)}.next`);
	const fd = fs.openSync(next, 'wx', mode);
	try {
		try {
			fs.writeFileSync(fd, content);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		fs.rmSync(next, { force: true });
		throw err;
	}
	for (let retry = 0; ; retry++) {
		try {
			// Looked at again before each try: a wait for another program to let go is a moment it may write
			if (unchangedSince !== undefined && !isUnchanged(target, unchangedSince)) {
				throw new FileChangedError(file);
			}
			fs.renameSync(next, target);
			return;
		} catch (err) {
			if (err instanceof FileChangedError || retry >= RENAME_RETRY_DELAYS_MS.length || !HELD_OPEN_CODES.has(codeOf(err) ?? '')) {
				fs.rmSync(next, { force: true });
				throw err;
			}
			sleepSync(RENAME_RETRY_DELAYS_MS[retry]);
		}
	}
}

/** How a JSON file is laid out, so that it can be written back the way it was. */
export interface JsonLayout {
	readonly byteOrderMark: boolean;
	readonly lineEnding: '\n' | '\r\n';
	/** A tab, or a number of spaces. */
	readonly indent: '\t' | number;
	readonly finalNewline: boolean;
}

/** The layout of a JSON file Facade creates. */
const NEW_FILE_LAYOUT: JsonLayout = { byteOrderMark: false, lineEnding: '\n', indent: 2, finalNewline: true };

/** The layout of a JSON text: its byte order mark, line endings, indentation and final newline. */
export function jsonLayoutOf(text: string): JsonLayout {
	let indent: '\t' | number = 2;
	for (const line of text.split('\n')) {
		const leading = /^(?<leading>[ \t]+)\S/.exec(line)?.groups?.leading;
		if (leading) {
			indent = leading.startsWith('\t') ? '\t' : leading.length;
			break;
		}
	}
	return {
		byteOrderMark: text.charCodeAt(0) === BYTE_ORDER_MARK,
		lineEnding: text.includes('\r\n') ? '\r\n' : '\n',
		indent,
		finalNewline: text.endsWith('\n')
	};
}

/** A JSON file as read: missing, an object with its layout and stamp, or anything else, which is left alone. */
export type JsonFile =
	| { readonly kind: 'missing' }
	| { readonly kind: 'object'; readonly value: JsonObject; readonly layout: JsonLayout; readonly stamp: FileStamp }
	| { readonly kind: 'other' };

/** Reads a JSON file that should hold an object, such as a settings file; one written while it is read is read again. */
export function readJsonFile(file: string): JsonFile {
	for (let attempt = 1; ; attempt++) {
		let text: string;
		let before: FileStamp | undefined;
		let after: FileStamp | undefined;
		try {
			before = stampOf(file);
			text = fs.readFileSync(file, 'utf8');
			after = stampOf(file);
		} catch (err) {
			return codeOf(err) === 'ENOENT' ? { kind: 'missing' } : { kind: 'other' };
		}
		if (before === undefined || !sameStamp(after, before)) {
			if (attempt < CHANGED_ATTEMPTS) {
				continue;
			}
			return { kind: 'other' };
		}
		let value: unknown;
		try {
			value = parseJson(text);
		} catch {
			return { kind: 'other' };
		}
		return isJsonObject(value) ? { kind: 'object', value, layout: jsonLayoutOf(text), stamp: before } : { kind: 'other' };
	}
}

/** Parses a JSON text that may start with a byte order mark. */
export function parseJson(text: string): unknown {
	return JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
}

/** `value` as JSON text laid out as `layout` says. */
export function formatJson(value: unknown, layout: JsonLayout = NEW_FILE_LAYOUT): string {
	const body = JSON.stringify(value, undefined, layout.indent).split('\n').join(layout.lineEnding);
	return `${layout.byteOrderMark ? String.fromCharCode(BYTE_ORDER_MARK) : ''}${body}${layout.finalNewline ? layout.lineEnding : ''}`;
}

/** Writes `value` to a JSON file in one step, laid out as `layout` says: a file that was read keeps its layout. */
export function writeJsonFile(file: string, value: JsonObject, layout: JsonLayout = NEW_FILE_LAYOUT, unchangedSince?: FileStamp | 'missing'): void {
	replaceFile(file, formatJson(value, layout), unchangedSince);
}

/**
 * Reads a JSON file another program writes too - a CLI's own settings - and writes back what `update`
 * makes of it, if anything, laid out as it was. Should that program write the file meanwhile, it is read
 * again and `update` asked again, so that what the program wrote is kept; a file that goes on changing
 * throws `FileChangedError`. `update` answers what to say, and the value to write, if any.
 */
export function updateJsonFile<T>(file: string, update: (read: JsonFile) => { readonly outcome: T; readonly write?: JsonObject }): T {
	for (let attempt = 1; ; attempt++) {
		const read = readJsonFile(file);
		const { outcome, write } = update(read);
		if (write === undefined) {
			return outcome;
		}
		try {
			writeJsonFile(file, write, read.kind === 'object' ? read.layout : undefined, read.kind === 'object' ? read.stamp : 'missing');
			return outcome;
		} catch (err) {
			if (!(err instanceof FileChangedError) || attempt >= CHANGED_ATTEMPTS) {
				throw err;
			}
		}
	}
}
