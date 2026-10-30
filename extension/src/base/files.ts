/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sleepSync } from './async';
import { codeOf, messageOf } from './errors';
import { isJsonObject, JsonObject } from './json';
import { JsonNode, JsonObjectNode, nodeValue, parseJsonc } from './jsonc';

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
	return normalized(a) === normalized(b);
}

/**
 * `file` as a person reads it, the home folder written `~` - as VS Code says a path, which it does not on Windows: `~/Desktop`.
 */
export function homeRelative(file: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
	if (platform === 'win32' || !home) {
		return file;
	}
	if (isEqualPath(file, home)) {
		return '~';
	}
	// With `/` between its parts, as a path of a system other than Windows is written, whatever system this one is
	return isInsideFolder(file, home) ? `~/${path.relative(path.resolve(home), path.resolve(file)).split(path.sep).join('/')}` : file;
}

/** A display-only path within 40 visible characters; never use this shortened value for file operations (WORKTREES-2.1). */
export function compactPath(file: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
	const display = homeRelative(file, home, platform);
	const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	const graphemes = (text: string) => Array.from(segmenter.segment(text), each => each.segment);
	const length = (text: string) => graphemes(text).length;
	const shorten = (text: string, budget: number): string => {
		const chars = graphemes(text);
		if (chars.length <= budget) {
			return text;
		}
		const left = Math.ceil((budget - 1) / 2);
		const right = Math.floor((budget - 1) / 2);
		return `${chars.slice(0, left).join('')}…${right ? chars.slice(-right).join('') : ''}`;
	};
	if (length(display) <= 40) {
		return display;
	}
	const paths = platform === 'win32' ? path.win32 : path.posix;
	const separator = platform === 'win32' && display.includes('\\') ? '\\' : '/';
	const root = display.startsWith('~/') ? '~/' : paths.parse(display).root;
	const parts = display.slice(root.length).split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
	if (!parts.length) {
		return shorten(display, 40);
	}
	const tail = parts.slice(-2);
	const prefix = `${root}${parts.length > 2 ? `…${separator}` : ''}`;
	const condensed = prefix + tail.join(separator);
	if (length(condensed) <= 40) {
		return condensed;
	}
	// A long UNC root must leave room for the destination; the complete root remains in Copy Path.
	const head = shorten(prefix, 12);
	if (tail.length === 1) {
		return head + shorten(tail[0], 40 - length(head));
	}
	const room = 40 - length(head) - 1;
	const leafBudget = Math.min(length(tail[1]), room - Math.min(length(tail[0]), Math.floor(room / 2)));
	return head + shorten(tail[0], room - leafBudget) + separator + shorten(tail[1], leafBudget);
}

/** Whether `inner` is below the folder `outer`, not `outer` itself: case is ignored on Windows and macOS. */
export function isInsideFolder(inner: string, outer: string): boolean {
	const relative = path.relative(normalized(outer), normalized(inner));
	return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A path as the file system compares it: absolute, and in lower case where case is ignored. */
function normalized(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
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
 * A folder's real path as `canonicalFolder` finds it, for a folder that is not there too: the nearest folder above it that is,
 * resolved, and the rest as written - a worktree deleted, or not made yet, is where its parent's real path puts it.
 */
export function realFolderOf(folder: string): string {
	const absolute = path.resolve(folder);
	let rest = '';
	for (let at = absolute; ; at = path.dirname(at)) {
		try {
			return path.join(fs.realpathSync.native(at), rest);
		} catch {
			if (path.dirname(at) === at) {
				return absolute;
			}
			rest = path.join(path.basename(at), rest);
		}
	}
}

/** What a folder is compared by: its real path, as `realFolderOf` finds it, in lower case where the file system ignores case. */
export function folderKeyOf(folder: string): string {
	return normalized(realFolderOf(folder));
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
		super(`Another process changed '${file}' while Facade was preparing to write it. Facade wrote nothing.`);
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
 * has `newFileMode` - readable by the user only unless given - less what the umask takes away. Nothing is left beside it when replacing fails. With `unchangedSince`, a
 * file another program writes too is replaced only while it is still as it was read - or still not
 * there - and else `FileChangedError` is thrown. Content given as bytes is written as they are: a file put back
 * as it was is put back byte for byte, whatever its encoding (X-62).
 */
export function replaceFile(file: string, content: string | Uint8Array, unchangedSince?: FileStamp | 'missing', newFileMode = 0o600): void {
	let target = file;
	try {
		target = fs.realpathSync.native(file);
	} catch {
		// A new file, or a link to none.
	}
	const folder = path.dirname(target);
	fs.mkdirSync(folder, { recursive: true });
	let mode = newFileMode;
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

/**
 * A JSON file as read: missing, an object - with its text, where each of its parts is in it, its layout and
 * stamp - or anything else, which is left alone, with why, as the person is told it (AGENT-LAUNCHER.md, L11).
 */
export type JsonFile =
	| { readonly kind: 'missing' }
	| { readonly kind: 'object'; readonly value: JsonObject; readonly text: string; readonly tree: JsonObjectNode; readonly layout: JsonLayout; readonly stamp: FileStamp }
	| { readonly kind: 'other'; readonly why: string };

/**
 * Reads a JSON file that should hold an object, such as a settings file - comments and trailing commas
 * allowed, as such files have them (X-48); one written while it is read is read again.
 */
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
			return codeOf(err) === 'ENOENT' ? { kind: 'missing' } : { kind: 'other', why: `could not be read: ${messageOf(err)}` };
		}
		if (before === undefined || !sameStamp(after, before)) {
			if (attempt < CHANGED_ATTEMPTS) {
				continue;
			}
			return { kind: 'other', why: 'kept changing during the read' };
		}
		let tree: JsonNode;
		try {
			tree = parseJsonc(text);
		} catch (err) {
			return { kind: 'other', why: `is not valid JSON: ${messageOf(err)}` };
		}
		const value = nodeValue(tree);
		return tree.kind === 'object' && isJsonObject(value) ? { kind: 'object', value, text, tree, layout: jsonLayoutOf(text), stamp: before } : { kind: 'other', why: `contains ${Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`}; expected a JSON object` };
	}
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
 * makes of it, if anything: a value, laid out as the file was, or the file's text as edited. Should that
 * program write the file meanwhile, it is read again and `update` asked again, so that what the program
 * wrote is kept; a file that goes on changing throws `FileChangedError`. `update` answers what to say, and
 * what to write, if anything.
 */
export function updateJsonFile<T>(file: string, update: (read: JsonFile) => { readonly outcome: T; readonly write?: JsonObject | string }): T {
	for (let attempt = 1; ; attempt++) {
		const read = readJsonFile(file);
		const { outcome, write } = update(read);
		if (write === undefined) {
			return outcome;
		}
		try {
			if (typeof write === 'string') {
				replaceFile(file, write, read.kind === 'object' ? read.stamp : 'missing');
			} else {
				writeJsonFile(file, write, read.kind === 'object' ? read.layout : undefined, read.kind === 'object' ? read.stamp : 'missing');
			}
			return outcome;
		} catch (err) {
			if (!(err instanceof FileChangedError) || attempt >= CHANGED_ATTEMPTS) {
				throw err;
			}
		}
	}
}
