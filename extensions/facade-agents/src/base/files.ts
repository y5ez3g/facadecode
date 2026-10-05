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

/**
 * Replaces the content of `file` in one step: the content is written whole and flushed to a sibling
 * file, which is then renamed over it, so a reader sees either the old content or the new one. A link is
 * followed - what it points to is replaced, and it stays a link. The file keeps its permissions; a new one
 * is readable by the user only. Nothing is left beside it when replacing fails.
 */
export function replaceFile(file: string, content: string): void {
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
			fs.renameSync(next, target);
			return;
		} catch (err) {
			if (retry >= RENAME_RETRY_DELAYS_MS.length || !HELD_OPEN_CODES.has(codeOf(err) ?? '')) {
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

/** A JSON file as read: missing, an object with its layout, or anything else, which is left alone. */
export type JsonFile =
	| { readonly kind: 'missing' }
	| { readonly kind: 'object'; readonly value: JsonObject; readonly layout: JsonLayout }
	| { readonly kind: 'other' };

/** Reads a JSON file that should hold an object, such as a settings file. */
export function readJsonFile(file: string): JsonFile {
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		return codeOf(err) === 'ENOENT' ? { kind: 'missing' } : { kind: 'other' };
	}
	let value: unknown;
	try {
		value = parseJson(text);
	} catch {
		return { kind: 'other' };
	}
	return isJsonObject(value) ? { kind: 'object', value, layout: jsonLayoutOf(text) } : { kind: 'other' };
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
export function writeJsonFile(file: string, value: JsonObject, layout: JsonLayout = NEW_FILE_LAYOUT): void {
	replaceFile(file, formatJson(value, layout));
}
