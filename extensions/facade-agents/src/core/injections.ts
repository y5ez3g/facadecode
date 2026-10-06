/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { codeOf, messageOf } from '../base/errors';
import { formatJson, isEqualPath, jsonLayoutOf, parseJson, replaceFile } from '../base/files';
import { isJsonObject, isStringArray } from '../base/json';
import { withFileLock } from '../base/lock';
import { Injected } from '../clis/cli';
import { isLedgerHeld } from '../record/ledger';

/** The `.gitignore` of a folder Facade made, which keeps all of it out of git. */
const IGNORE_ALL = '*\n';
/** What removing a folder fails with on Windows while a process has it as its current folder. */
const IN_USE_CODES = new Set(['EBUSY', 'EPERM']);

/** What Facade put into one folder, and the windows whose agents need it there. */
interface FolderRecord {
	/** The windows whose agents run there, by their workspace records' folders. */
	holders: string[];
	/** Each file Facade wrote, by its path relative to the folder. */
	files: { [file: string]: WrittenFile };
	/** The folders Facade made, relative to the folder, outermost first. */
	made: string[];
	/** The repository's `info/exclude`, and the lines the files need in it. */
	exclude?: string;
	lines: string[];
}

/**
 * A file Facade wrote: the hash of what it wrote; and where it took the place of the person's own file,
 * theirs and what Facade wrote, both in base64.
 */
interface WrittenFile {
	hash: string;
	theirs?: string;
	ours?: string;
}

interface InjectedRecord {
	folders: { [folder: string]: FolderRecord };
	/** The lines Facade added to each `info/exclude`, which go once no folder needs them. */
	added: { [exclude: string]: string[] };
}

function injectedRecordOf(value: unknown): InjectedRecord | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}
	const { folders = {}, added = {} } = value;
	if (!isJsonObject(folders) || !isJsonObject(added)) {
		return undefined;
	}
	const record: InjectedRecord = { folders: {}, added: {} };
	for (const [folder, entry] of Object.entries(folders)) {
		const checked = folderRecordOf(entry);
		if (!checked) {
			return undefined;
		}
		record.folders[folder] = checked;
	}
	for (const [exclude, lines] of Object.entries(added)) {
		if (!isStringArray(lines)) {
			return undefined;
		}
		record.added[exclude] = [...lines];
	}
	return record;
}

function folderRecordOf(value: unknown): FolderRecord | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}
	const { holders, files, made, exclude, lines } = value;
	if (!isStringArray(holders) || !isJsonObject(files) || !isStringArray(made) || !isStringArray(lines) || (exclude !== undefined && typeof exclude !== 'string')) {
		return undefined;
	}
	const written: FolderRecord['files'] = {};
	for (const [file, entry] of Object.entries(files)) {
		if (!isJsonObject(entry) || typeof entry.hash !== 'string' || (entry.theirs !== undefined && typeof entry.theirs !== 'string') || (entry.ours !== undefined && typeof entry.ours !== 'string')) {
			return undefined;
		}
		written[file] = { hash: entry.hash, ...(typeof entry.theirs === 'string' ? { theirs: entry.theirs } : {}), ...(typeof entry.ours === 'string' ? { ours: entry.ours } : {}) };
	}
	return { holders: [...holders], files: written, made: [...made], ...(exclude !== undefined ? { exclude } : {}), lines: [...lines] };
}

/** What git says of the folder files go into. */
export interface InjectionGit {
	/** Its repository's `info/exclude`, and the root of its worktree, which the exclude lines start from. */
	readonly exclude?: { readonly file: string; readonly root: string };
	/** Which of the files git tracks there. */
	readonly tracked: ReadonlySet<string>;
	/** Which of the files some worktree of the repository has at that place as a file git neither tracks nor ignores. */
	readonly untracked: ReadonlySet<string>;
}

/**
 * The files Facade puts into folders for its agents, recorded in one file every window shares, so that
 * what one window's agents need stays while another window's exit.
 *
 * - The person's own file stays theirs. An agent is not started over it unless git does not track it
 *   and its launch can add Facade's part to it; it then holds that part while agents run there, and is
 *   theirs again, byte for byte, afterwards.
 * - Each file gets a line in the repository's `info/exclude`, so that no agent commits it, unless some
 *   worktree of the repository has a file of the person's at that place that git neither tracks nor
 *   ignores: git would then feel free to write over theirs.
 * - The files are taken back once no agent of any window runs there, and only while they hold what
 *   Facade wrote. The person's file that they changed meanwhile keeps their change and loses Facade's
 *   part, where both are JSON; one that holds nothing of Facade's any more is left alone, and what it
 *   held before is kept beside the record, which the person is told of.
 * - A window holds a folder while it is open, and for a minute after it closed, which covers a reload.
 * - A folder Facade made that a process still has in use is removed later.
 */
export class Injections {

	constructor(
		/** The record every window shares. */
		private readonly file: string,
		/** This window, by its workspace record's folder. */
		private readonly holder: string,
		private readonly log: (message: string) => void,
		/** Tells the person something they need to act on. */
		private readonly tell: (text: string) => void,
		/** Whether the window of a workspace record is open, or closed a moment ago as it reloads. */
		private readonly isHeld: (holder: string) => boolean = isLedgerHeld
	) { }

	/** Puts `files` into `folder` for an agent of `cli`: all of them, or none, with an error that says why. */
	put(folder: string, files: readonly Injected[], git: InjectionGit, cli: string): void {
		withFileLock(this.file, () => {
			const record = this.read();
			const key = keyFor(record.folders, folder) ?? folder;
			const entry = record.folders[key] ?? { holders: [], files: {}, made: [], lines: [] };
			// Everything is decided before anything is written, so that a refusal leaves the folder as it was.
			const writes = files.map(file => {
				const target = path.join(folder, file.path);
				const refused = new Error(`${cli} is not started: ${target} is there already, and Facade does not write over it.`);
				let current: Buffer | undefined;
				try {
					current = readBytes(target);
				} catch {
					throw refused;
				}
				const written = entry.files[file.path];
				const isOurs = current !== undefined && written !== undefined && hashOf(current) === written.hash;
				let theirs: string | undefined;
				if (isOurs) {
					theirs = written.theirs;
				} else if (current !== undefined) {
					if (git.tracked.has(file.path)) {
						throw new Error(`${cli} is not started: ${target} is in the repository, and Facade would have to change it, so that a commit could take Facade's settings with it.`);
					}
					// The person's file, which they changed while Facade's part was in it: theirs is it without that part.
					const changed = written?.theirs !== undefined && written.ours !== undefined
						? withoutOurs(current.toString('utf8'), Buffer.from(written.theirs, 'base64').toString('utf8'), Buffer.from(written.ours, 'base64').toString('utf8'))
						: undefined;
					theirs = changed !== undefined ? Buffer.from(changed).toString('base64') : current.toString('base64');
				}
				const content = theirs === undefined ? file.content : file.merge?.(Buffer.from(theirs, 'base64').toString('utf8'));
				if (content === undefined) {
					throw refused;
				}
				if (isOurs && hashOf(Buffer.from(content)) !== written.hash && entry.holders.some(holder => !isEqualPath(holder, this.holder) && this.isHeld(holder))) {
					throw new Error(`${cli} is not started: ${target} holds what another Facade window wrote there for its agents, which would change under them.`);
				}
				return { file: file.path, target, content, theirs };
			});
			for (const write of writes) {
				entry.made.push(...makeFolders(folder, path.dirname(write.target)));
				replaceFile(write.target, write.content);
				const hash = hashOf(Buffer.from(write.content));
				entry.files[write.file] = write.theirs === undefined ? { hash } : { hash, theirs: write.theirs, ours: Buffer.from(write.content).toString('base64') };
				if (write.theirs !== undefined) {
					this.log(`${write.target} is the person's: Facade's part is added to it while agents run there.`);
				}
			}
			// A folder Facade made keeps everything in it out of git by itself, in this worktree only.
			for (const made of entry.made.filter(each => !entry.made.some(other => other !== each && isInside(each, other)))) {
				const ignore = `${made.split(path.sep).join('/')}/.gitignore`;
				if (entry.files[ignore] === undefined && !fs.existsSync(path.join(folder, ignore))) {
					fs.writeFileSync(path.join(folder, ignore), IGNORE_ALL);
					entry.files[ignore] = { hash: hashOf(Buffer.from(IGNORE_ALL)) };
				}
			}
			if (!entry.holders.some(holder => isEqualPath(holder, this.holder))) {
				entry.holders.push(this.holder);
			}
			if (git.exclude) {
				this.excludeFromGit(record, entry, folder, files, git, git.exclude);
			}
			record.folders[key] = entry;
			this.write(record);
		});
	}

	private excludeFromGit(record: InjectedRecord, entry: FolderRecord, folder: string, files: readonly Injected[], git: InjectionGit, exclude: { readonly file: string; readonly root: string }): void {
		const lines: string[] = [];
		for (const file of files) {
			const relative = path.relative(exclude.root, path.join(folder, file.path));
			const line = excludeLine(relative);
			if (line === undefined) {
				continue;
			}
			if (git.untracked.has(file.path)) {
				this.log(`${path.join(folder, file.path)}: a worktree of this repository has a file of the person's at ${relative.split(path.sep).join('/')} that git neither tracks nor ignores, so Facade adds no line for it to info/exclude, which would let git write over theirs.`);
				continue;
			}
			lines.push(line);
		}
		entry.exclude = exclude.file;
		entry.lines = [...new Set([...entry.lines, ...lines])];
		const appended = appendLines(exclude.file, lines);
		if (appended.length) {
			const key = keyFor(record.added, exclude.file) ?? exclude.file;
			record.added[key] = [...(record.added[key] ?? []), ...appended];
		}
	}

	/**
	 * Lets go of `folder` for this window, whose agents there have all exited: what Facade put there is
	 * taken back once no window holds it. Answers whether a folder is left in use, for {@link sweep}.
	 */
	release(folder: string): boolean {
		return withFileLock(this.file, () => {
			const record = this.read();
			const key = keyFor(record.folders, folder);
			if (key === undefined) {
				return false;
			}
			const entry = record.folders[key];
			entry.holders = entry.holders.filter(holder => !isEqualPath(holder, this.holder) && this.isHeld(holder));
			if (!entry.holders.length) {
				this.takeBack(record, key);
			}
			this.write(record);
			return hasFoldersInUse(record);
		});
	}

	/**
	 * Takes back what Facade put where only windows that are gone held it, whatever their workspace, and
	 * removes the folders a process still had in use when they were taken back. Answers whether a folder
	 * is left in use.
	 */
	sweep(): boolean {
		return withFileLock(this.file, () => {
			const record = this.read();
			let changed = false;
			for (const [key, entry] of Object.entries(record.folders)) {
				const holders = entry.holders.filter(holder => this.isHeld(holder));
				if (holders.length && holders.length === entry.holders.length) {
					continue;
				}
				changed = true;
				entry.holders = holders;
				if (!holders.length) {
					if (Object.keys(entry.files).length) {
						this.log(`No open window holds ${key}: what Facade put there for its agents is taken back.`);
					}
					this.takeBack(record, key);
				}
			}
			if (changed) {
				this.write(record);
			}
			return hasFoldersInUse(record);
		});
	}

	/** The folders this window holds. */
	held(): string[] {
		return Object.entries(this.read().folders).filter(([, entry]) => entry.holders.some(holder => isEqualPath(holder, this.holder))).map(([folder]) => folder);
	}

	/** Takes back what Facade put into the folder `key`, which no window holds any more. */
	private takeBack(record: InjectedRecord, key: string): void {
		const entry = record.folders[key];
		for (const [file, written] of Object.entries(entry.files)) {
			const target = path.join(key, file);
			try {
				this.takeBackFile(target, written);
			} catch (err) {
				this.log(`${target} could not be taken back: ${messageOf(err)}`);
			}
		}
		// Innermost first; one that a process has in use stays for later, with the folders around it.
		const inUse: string[] = [];
		for (const made of [...entry.made].reverse()) {
			if (inUse.some(inner => isInside(inner, made))) {
				inUse.push(made);
				continue;
			}
			try {
				fs.rmdirSync(path.join(key, made));
			} catch (err) {
				if (IN_USE_CODES.has(codeOf(err) ?? '')) {
					inUse.push(made);
				}
				// Otherwise something else is in it, or it went with its worktree.
			}
		}
		delete record.folders[key];
		if (inUse.length) {
			if (Object.keys(entry.files).length) {
				this.log(`${path.join(key, inUse[0])} is still in use by a process of an agent that exited: Facade removes it once it is not.`);
			}
			record.folders[key] = { holders: [], files: {}, made: inUse.reverse(), lines: [] };
		}
		if (entry.exclude !== undefined) {
			this.removeExcludeLines(record, entry, entry.exclude);
		}
	}

	private takeBackFile(target: string, written: WrittenFile): void {
		const current = readBytes(target);
		if (current === undefined) {
			if (written.theirs !== undefined) {
				const kept = this.keep(target, written.theirs);
				this.log(`${target} was gone when its agents exited: what it held before Facade's part went in is kept at ${kept}.`);
				this.tell(l10n.t("{0} was gone when its agents exited: what it held before Facade's part went in is kept at {1}.", target, kept));
			}
			return;
		}
		if (hashOf(current) === written.hash) {
			if (written.theirs !== undefined) {
				replaceFile(target, Buffer.from(written.theirs, 'base64').toString('utf8'));
			} else {
				fs.rmSync(target, { force: true });
			}
			return;
		}
		// The person's file, which they changed while Facade's part was in it.
		const withoutFacade = written.theirs !== undefined && written.ours !== undefined
			? withoutOurs(current.toString('utf8'), Buffer.from(written.theirs, 'base64').toString('utf8'), Buffer.from(written.ours, 'base64').toString('utf8'))
			: undefined;
		if (withoutFacade !== undefined) {
			replaceFile(target, withoutFacade);
			this.log(`${target} changed while Facade's part was in it: the change is kept, and Facade's part taken out.`);
		} else if (written.theirs !== undefined) {
			const kept = this.keep(target, written.theirs);
			this.log(`${target} changed while agents ran there and holds nothing of Facade's: it is left as it is, and what it held before is kept at ${kept}.`);
			this.tell(l10n.t("{0} changed while agents ran there and holds nothing of Facade's: it is left as it is, and what it held before is kept at {1}.", target, kept));
		} else {
			this.log(`${target} changed since Facade put it there: it is left as it is.`);
		}
	}

	private removeExcludeLines(record: InjectedRecord, entry: FolderRecord, exclude: string): void {
		const needed = new Set(Object.values(record.folders).filter(each => each.exclude !== undefined && isEqualPath(each.exclude, exclude)).flatMap(each => each.lines));
		const key = keyFor(record.added, exclude);
		if (key === undefined) {
			return;
		}
		const gone = record.added[key].filter(line => entry.lines.includes(line) && !needed.has(line));
		removeLines(exclude, gone);
		const kept = record.added[key].filter(line => !gone.includes(line));
		if (kept.length) {
			record.added[key] = kept;
		} else {
			delete record.added[key];
		}
	}

	/** Keeps what the person's file held, in base64, in `kept/` beside the record, under the time and the file's name; answers where. */
	private keep(target: string, theirs: string): string {
		const dir = path.join(path.dirname(this.file), 'kept');
		fs.mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
		for (let n = 1; ; n++) {
			const kept = path.join(dir, `${stamp}${n > 1 ? `-${n}` : ''}-${path.basename(target)}`);
			try {
				fs.writeFileSync(kept, Buffer.from(theirs, 'base64'), { flag: 'wx' });
				return kept;
			} catch (err) {
				if (codeOf(err) !== 'EEXIST') {
					throw err;
				}
			}
		}
	}

	/** The record as the windows left it; one that cannot be read counts as empty, which the log says. */
	private read(): InjectedRecord {
		let value: unknown;
		try {
			value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		} catch (err) {
			if (codeOf(err) !== 'ENOENT') {
				this.log(`${this.file} could not be read (${messageOf(err)}): Facade starts its record anew.`);
			}
			return { folders: {}, added: {} };
		}
		const record = injectedRecordOf(value);
		if (!record) {
			this.log(`${this.file} holds no record Facade can read: Facade starts its record anew.`);
		}
		return record ?? { folders: {}, added: {} };
	}

	private write(record: InjectedRecord): void {
		if (!Object.keys(record.folders).length && !Object.keys(record.added).length) {
			fs.rmSync(this.file, { force: true });
			return;
		}
		replaceFile(this.file, JSON.stringify(record, undefined, '\t'));
	}
}

/**
 * `current`, the person's JSON file that Facade added `ours` to over `theirs`, as they left it but
 * without Facade's part, laid out as it is; undefined where one of them is not JSON or nothing of
 * Facade's is left in it.
 */
function withoutOurs(current: string, theirs: string, ours: string): string | undefined {
	try {
		const now = parseJson(current);
		const kept = stripped(now, parseJson(theirs), parseJson(ours));
		return isSameJson(kept, now) ? undefined : formatJson(kept, jsonLayoutOf(current));
	} catch {
		return undefined;
	}
}

/** `now` without what `ours` added over `before`. */
function stripped(now: unknown, before: unknown, ours: unknown): unknown {
	if (Array.isArray(now) && Array.isArray(ours)) {
		const left = [...now];
		for (const item of ours.slice(Array.isArray(before) ? before.length : 0)) {
			const index = left.findIndex(each => isSameJson(each, item));
			if (index >= 0) {
				left.splice(index, 1);
			}
		}
		return left;
	}
	if (!isJsonObject(now) || !isJsonObject(ours)) {
		return now;
	}
	const theirs = isJsonObject(before) ? before : {};
	const kept: { [key: string]: unknown } = {};
	for (const [key, value] of Object.entries(now)) {
		if (Object.hasOwn(ours, key) && !Object.hasOwn(theirs, key)) {
			// A key Facade added goes, unless the person added their own entries to it since: those stay.
			if (!isSameJson(value, ours[key]) && holdsEntries(ours[key])) {
				const left = stripped(value, Array.isArray(value) ? [] : {}, ours[key]);
				if (!isSameJson(left, []) && !isSameJson(left, {})) {
					kept[key] = left;
				}
			}
		} else {
			kept[key] = Object.hasOwn(ours, key) ? stripped(value, theirs[key], ours[key]) : value;
		}
	}
	return kept;
}

/** Whether a value Facade wrote holds entries others may add to: an array, or an object of entries such as the servers of an `.mcp.json`. */
function holdsEntries(value: unknown): boolean {
	return Array.isArray(value) || (isJsonObject(value) && Object.values(value).every(each => Array.isArray(each) || isJsonObject(each)));
}

function isSameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function readBytes(file: string): Buffer | undefined {
	try {
		return fs.readFileSync(file);
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return undefined;
		}
		throw err;
	}
}

function hashOf(bytes: Buffer): string {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Whether a folder was left in use when it was taken back. */
function hasFoldersInUse(record: InjectedRecord): boolean {
	return Object.values(record.folders).some(entry => !entry.holders.length);
}

/** Whether the folder `inner` is inside `outer`. */
function isInside(inner: string, outer: string): boolean {
	const relative = path.relative(outer, inner);
	return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Makes `dir` in `folder`, and answers with the folders it made, relative to `folder`, outermost first. */
function makeFolders(folder: string, dir: string): string[] {
	const missing: string[] = [];
	for (let each = dir; !isEqualPath(each, folder) && path.dirname(each) !== each && !fs.existsSync(each); each = path.dirname(each)) {
		missing.unshift(each);
	}
	fs.mkdirSync(dir, { recursive: true });
	return missing.map(each => path.relative(folder, each));
}

/** The `info/exclude` line for one file, by its path relative to its worktree's root; undefined for one outside it. */
function excludeLine(relative: string): string | undefined {
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return undefined;
	}
	// The file alone, from the root, with any pattern characters escaped.
	return `/${relative.split(path.sep).join('/').replace(/[*?[\\]/g, '\\$&')}`;
}

/** Adds the lines an `info/exclude` does not have yet; answers with those it added. */
function appendLines(file: string, lines: readonly string[]): string[] {
	let listed = '';
	try {
		listed = fs.readFileSync(file, 'utf8');
	} catch {
		// Created below.
	}
	const present = new Set(listed.split(/\r?\n/));
	const missing = [...new Set(lines)].filter(line => !present.has(line));
	if (missing.length) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${listed && !listed.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
	}
	return missing;
}

/** Removes `lines` from an `info/exclude`, leaving the rest as it is. */
function removeLines(file: string, lines: readonly string[]): void {
	if (!lines.length) {
		return;
	}
	let listed: string;
	try {
		listed = fs.readFileSync(file, 'utf8');
	} catch {
		return;
	}
	replaceFile(file, listed.split(/(?<=\n)/).filter(line => !lines.includes(line.replace(/\r?\n$/, ''))).join(''));
}

/** The key of `record` that names the same file as `file`, however its case is written. */
function keyFor(record: { readonly [file: string]: unknown }, file: string): string | undefined {
	return Object.keys(record).find(key => isEqualPath(key, file));
}
