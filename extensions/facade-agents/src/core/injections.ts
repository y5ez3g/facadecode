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

/** What removing a folder fails with on Windows while a process has it as its current folder. */
const IN_USE_CODES = new Set(['EBUSY', 'EPERM']);

/** An agent that uses what Facade put into a folder: by its workspace's record and its number, with its process once it has one. */
export interface InjectionUser {
	readonly workspace: string;
	readonly id: number;
	readonly processId?: number;
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

/**
 * What a put is writing into a folder, recorded before it writes anything and dropped once it is done:
 * each file with what it held before - in base64; none where there was none - and Facade's record of it
 * before, where it had one; the folders it makes, and the exclude lines it adds. What a window comes upon
 * here was cut short, and is taken back.
 */
interface Writing {
	files: { [file: string]: { before?: string; record?: WrittenFile } };
	made: string[];
	lines: string[];
}

/** What Facade put into one folder, and the agents that use it. */
interface FolderRecord {
	users: InjectionUser[];
	/** Each file Facade wrote, by its path relative to the folder. */
	files: { [file: string]: WrittenFile };
	/** The folders Facade made, relative to the folder, outermost first. */
	made: string[];
	/** The repository's `info/exclude`, and the lines the files need in it. */
	exclude?: string;
	lines: string[];
	writing?: Writing;
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
	const { users, files, made, exclude, lines, writing } = value;
	if (!Array.isArray(users) || !isJsonObject(files) || !isStringArray(made) || !isStringArray(lines) || (exclude !== undefined && typeof exclude !== 'string')) {
		return undefined;
	}
	const checkedUsers = users.map(userOf);
	const written: FolderRecord['files'] = {};
	for (const [file, entry] of Object.entries(files)) {
		const checked = writtenFileOf(entry);
		if (!checked) {
			return undefined;
		}
		written[file] = checked;
	}
	const checkedWriting = writing === undefined ? undefined : writingOf(writing);
	if (checkedUsers.some(user => !user) || (writing !== undefined && !checkedWriting)) {
		return undefined;
	}
	return {
		users: checkedUsers.filter((user): user is InjectionUser => !!user),
		files: written,
		made: [...made],
		...(exclude !== undefined ? { exclude } : {}),
		lines: [...lines],
		...(checkedWriting ? { writing: checkedWriting } : {})
	};
}

function userOf(value: unknown): InjectionUser | undefined {
	if (!isJsonObject(value) || typeof value.workspace !== 'string' || !isNumberFrom1(value.id) || (value.processId !== undefined && !isNumberFrom1(value.processId))) {
		return undefined;
	}
	return { workspace: value.workspace, id: value.id, ...(value.processId !== undefined ? { processId: value.processId } : {}) };
}

function writtenFileOf(value: unknown): WrittenFile | undefined {
	if (!isJsonObject(value) || typeof value.hash !== 'string' || (value.theirs !== undefined && typeof value.theirs !== 'string') || (value.ours !== undefined && typeof value.ours !== 'string')) {
		return undefined;
	}
	return { hash: value.hash, ...(typeof value.theirs === 'string' ? { theirs: value.theirs } : {}), ...(typeof value.ours === 'string' ? { ours: value.ours } : {}) };
}

function writingOf(value: unknown): Writing | undefined {
	if (!isJsonObject(value) || !isJsonObject(value.files) || !isStringArray(value.made) || !isStringArray(value.lines)) {
		return undefined;
	}
	const files: Writing['files'] = {};
	for (const [file, entry] of Object.entries(value.files)) {
		if (!isJsonObject(entry) || (entry.before !== undefined && typeof entry.before !== 'string')) {
			return undefined;
		}
		const record = entry.record === undefined ? undefined : writtenFileOf(entry.record);
		if (entry.record !== undefined && !record) {
			return undefined;
		}
		files[file] = { ...(typeof entry.before === 'string' ? { before: entry.before } : {}), ...(record ? { record } : {}) };
	}
	return { files, made: [...value.made], lines: [...value.lines] };
}

function isNumberFrom1(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
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

/** A file a put writes: where, what, and the person's file it takes the place of, in base64. */
interface FileWrite {
	readonly file: string;
	readonly target: string;
	readonly content: string;
	readonly theirs?: string;
	/** Whether it holds that already, as Facade wrote it for other agents. */
	readonly there?: boolean;
}

/**
 * The files Facade puts into folders for its agents, recorded in one file every window shares,
 * `~/.facade/injected.json`, with the agents that use them, by workspace and number.
 *
 * - The person's own file stays theirs. An agent is not started over it unless its launch can add
 *   Facade's part to it beside theirs - a file git tracks too, whose change shows in `git diff` while
 *   agents use it, never hidden with index flags (AGENT-ORCHESTRATION.md, O10); it then holds that part
 *   while agents use it, and is theirs again, byte for byte, afterwards.
 * - Agents that need the same files share them; a file in use with other content refuses the launch.
 * - Copies first: what a put is about to write, and the person's files as they were, are recorded
 *   before anything is written, and the folder's entry marked done once it is. A put that fails part way
 *   takes back what it wrote; one a window comes upon not done - cut short as its window went - is taken
 *   back the same way.
 * - Each file gets a line in the repository's `info/exclude`, so that no agent commits it, unless some
 *   worktree of the repository has a file of the person's at that place that git neither tracks nor
 *   ignores: git would then feel free to write over theirs.
 * - The files are taken back once no agent that uses them may still run - each has ended, or its
 *   process is gone - and only while they hold what Facade wrote. The person's file that they changed
 *   meanwhile keeps their change and loses Facade's part, where both are JSON; one that holds nothing of
 *   Facade's any more is left alone, and what it held before is kept beside the record, which the person
 *   is told of. A reload, Facade being off, or time passing takes nothing back.
 * - What cannot be taken back yet - a file the disk refuses, a folder a process has in use - is tried again.
 */
export class Injections {

	constructor(
		/** The record every window shares. */
		private readonly file: string,
		private readonly log: (message: string) => void,
		/** Tells the person something they need to act on. */
		private readonly tell: (text: string) => void,
		/** Whether an agent that uses what Facade put into a folder may still run: it has not ended, and its process is not gone. */
		private readonly mayRun: (user: InjectionUser) => boolean
	) { }

	/** Refuses, with why, `files` that {@link put} would not put into `folder` for an agent of `cli` now; writes nothing. */
	check(folder: string, files: readonly Injected[], cli: string): void {
		withFileLock(this.file, () => {
			const record = this.read();
			const key = keyFor(record.folders, folder);
			const entry = key === undefined ? undefined : record.folders[key];
			// A put cut short is taken back first: what it wrote is no one's.
			const settled = entry && { ...entry, files: Object.fromEntries(Object.entries(entry.files).filter(([file]) => !entry.writing?.files[file])) };
			this.decide(settled, folder, files, cli);
		});
	}

	/**
	 * Puts `files` into `folder` for `user`, an agent of `cli`: all of them, or none, with an error that
	 * says why.
	 */
	put(folder: string, files: readonly Injected[], git: InjectionGit, cli: string, user: InjectionUser): void {
		withFileLock(this.file, () => {
			const record = this.read();
			// What no agent may still use goes first, and what a window left half written.
			if (this.settle(record)) {
				this.write(record);
			}
			const key = keyFor(record.folders, folder) ?? folder;
			const entry = record.folders[key] ?? { users: [], files: {}, made: [], lines: [] };
			const writes = this.decide(record.folders[key], folder, files, cli).filter(write => !write.there);
			const made = foldersToMake(folder, writes.map(write => path.dirname(write.target)));
			// A folder Facade makes keeps what Facade writes in it out of git by itself, in this worktree only - and
			// nothing else: what an agent adds there is work of its own, which a deletion counts (O10).
			const ignores = made.filter(each => !made.some(other => other !== each && isInside(each, other))).map(each => ({ file: `${each.split(path.sep).join('/')}/.gitignore`, target: path.join(folder, each, '.gitignore'), content: ignoreFileOf(path.join(folder, each), writes) }));
			const all: FileWrite[] = [...writes, ...ignores];
			const lines = git.exclude ? this.linesFor(folder, files, git, git.exclude).filter(line => !entry.lines.includes(line)) : [];
			const exclude = git.exclude?.file;
			const missing = exclude ? linesMissing(exclude, lines) : [];

			// Copies first: what is about to be written, and what each file held, before anything is.
			entry.writing = {
				files: Object.fromEntries(all.map(write => {
					const before = readBytes(write.target);
					const previous = entry.files[write.file];
					return [write.file, { ...(before !== undefined ? { before: before.toString('base64') } : {}), ...(previous ? { record: previous } : {}) }];
				})),
				made,
				lines
			};
			for (const write of all) {
				const hash = hashOf(Buffer.from(write.content));
				entry.files[write.file] = write.theirs === undefined ? { hash } : { hash, theirs: write.theirs, ours: Buffer.from(write.content).toString('base64') };
			}
			entry.made.push(...made);
			entry.lines.push(...lines);
			if (exclude) {
				entry.exclude = exclude;
				const addedKey = keyFor(record.added, exclude) ?? exclude;
				record.added[addedKey] = [...new Set([...record.added[addedKey] ?? [], ...missing])];
			}
			record.folders[key] = entry;
			this.write(record);

			try {
				for (const dir of made) {
					fs.mkdirSync(path.join(folder, dir));
				}
				for (const write of all) {
					replaceFile(write.target, write.content);
					if (write.theirs !== undefined) {
						this.log(`${write.target} is the person's: Facade's part is added to it while agents use it.`);
					}
				}
				if (exclude && missing.length) {
					appendLines(exclude, missing);
				}
			} catch (err) {
				this.rollBack(record, key);
				this.write(record);
				throw new Error(`${cli} is not started: what Facade puts into ${folder} could not be written, and what was is taken back: ${messageOf(err)}`);
			}
			delete entry.writing;
			entry.users.push(user);
			this.write(record);
		});
	}

	/**
	 * The files of `folder` that Facade wrote there and nobody changed since, relative to it with forward
	 * slashes: not the person's work, for a worktree's deletion to count (AGENT-ORCHESTRATION.md, O5). A file
	 * of the person's that holds Facade's part counts as what it held before: whether that was a change of
	 * theirs, git says once Facade's part is out of it, before the worktree is deleted.
	 */
	ownedUnchanged(folder: string): string[] {
		return withFileLock(this.file, () => {
			const record = this.read();
			const key = keyFor(record.folders, folder);
			const entry = key === undefined ? undefined : record.folders[key];
			if (!entry) {
				return [];
			}
			return Object.entries(entry.files).filter(([file, written]) => {
				try {
					const current = readBytes(path.join(folder, file));
					return current !== undefined && hashOf(current) === written.hash;
				} catch {
					return false;
				}
			}).map(([file]) => file.split(path.sep).join('/'));
		});
	}

	/** Records the process of an agent that uses what Facade put into folders, by which it is known to run. */
	launched(user: InjectionUser, processId: number): void {
		withFileLock(this.file, () => {
			const record = this.read();
			let changed = false;
			for (const entry of Object.values(record.folders)) {
				entry.users = entry.users.map(each => {
					if (isEqualPath(each.workspace, user.workspace) && each.id === user.id) {
						changed = true;
						return { ...each, processId };
					}
					return each;
				});
			}
			if (changed) {
				this.write(record);
			}
		});
	}

	/**
	 * Lets go of what `user`, an agent that ended, used: what no agent may still use is taken back, in
	 * its folder and any other. Answers whether something is left to take back later, for {@link sweep}.
	 */
	release(user: InjectionUser): boolean {
		return withFileLock(this.file, () => {
			const record = this.read();
			for (const entry of Object.values(record.folders)) {
				entry.users = entry.users.filter(each => !isEqualPath(each.workspace, user.workspace) || each.id !== user.id);
			}
			this.settle(record);
			this.write(record);
			return hasLeftovers(record);
		});
	}

	/**
	 * Takes back what no agent may still use, whatever its workspace, what a window left half written, and
	 * what could not be taken back before. Answers whether something is left to take back later.
	 */
	sweep(): boolean {
		return withFileLock(this.file, () => {
			const record = this.read();
			if (this.settle(record)) {
				this.write(record);
			}
			return hasLeftovers(record);
		});
	}

	/**
	 * What `files` would be written into `folder`, whose record is `entry`: refused, with why, where git
	 * tracks one, one is the person's that cannot take Facade's part, one leads out of the folder, or one
	 * in use holds other content.
	 */
	private decide(entry: FolderRecord | undefined, folder: string, files: readonly Injected[], cli: string): FileWrite[] {
		const used = !!entry?.users.some(user => this.mayRun(user));
		return files.map(file => {
			const target = path.join(folder, file.path);
			if (!isInside(target, folder)) {
				throw new Error(`${cli} is not started: ${file.path} leads out of ${folder}, where Facade puts nothing.`);
			}
			const refused = new Error(`${cli} is not started: ${target} is there already, and Facade does not write over it.`);
			let current: Buffer | undefined;
			try {
				current = readBytes(target);
			} catch {
				throw refused;
			}
			const written = entry?.files[file.path];
			const isOurs = current !== undefined && written !== undefined && hashOf(current) === written.hash;
			let theirs: string | undefined;
			if (isOurs) {
				theirs = written.theirs;
			} else if (current !== undefined) {
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
			const same = isOurs && hashOf(Buffer.from(content)) === written.hash;
			if (isOurs && used && !same) {
				throw new Error(`${cli} is not started: ${target} holds what Facade put there for other agents, which use it, and this one needs other content in it.`);
			}
			return { file: file.path, target, content, ...(theirs !== undefined ? { theirs } : {}), ...(same ? { there: true } : {}) };
		});
	}

	/** The `info/exclude` lines `files` need in `folder`: none for one a file of the person's in some worktree is at. */
	private linesFor(folder: string, files: readonly Injected[], git: InjectionGit, exclude: { readonly file: string; readonly root: string }): string[] {
		const lines: string[] = [];
		for (const file of files) {
			const relative = path.relative(exclude.root, path.join(folder, file.path));
			const line = excludeLine(relative);
			// A file git tracks takes no line: an exclude does nothing to it, and its change shows as it is.
			if (line === undefined || git.tracked.has(file.path)) {
				continue;
			}
			if (git.untracked.has(file.path)) {
				this.log(`${path.join(folder, file.path)}: a worktree of this repository has a file of the person's at ${relative.split(path.sep).join('/')} that git neither tracks nor ignores, so Facade adds no line for it to info/exclude, which would let git write over theirs.`);
				continue;
			}
			lines.push(line);
		}
		return [...new Set(lines)];
	}

	/**
	 * Takes back what a window left half written, drops the agents that cannot run any more, and takes
	 * back what no agent uses; answers whether the record changed.
	 */
	private settle(record: InjectedRecord): boolean {
		let changed = false;
		for (const [key, entry] of Object.entries(record.folders)) {
			if (entry.writing) {
				this.log(`What Facade was putting into ${key} as its window went is taken back.`);
				this.rollBack(record, key);
				changed = true;
			}
			const current = record.folders[key];
			if (!current) {
				continue;
			}
			const users = current.users.filter(user => this.mayRun(user));
			if (users.length !== current.users.length) {
				current.users = users;
				changed = true;
			}
			if (!users.length) {
				changed = true;
				this.takeBack(record, key);
			}
		}
		return changed;
	}

	/** Takes back what the put into the folder `key` that is not done wrote: each file as it was before, and its record. */
	private rollBack(record: InjectedRecord, key: string): void {
		const entry = record.folders[key];
		const writing = entry.writing;
		if (!writing) {
			return;
		}
		for (const [file, { before, record: previous }] of Object.entries(writing.files)) {
			const target = path.join(key, file);
			try {
				const now = readBytes(target);
				const wrote = entry.files[file];
				if (now !== undefined && wrote !== undefined && hashOf(now) === wrote.hash) {
					if (before === undefined) {
						fs.rmSync(target, { force: true });
					} else {
						replaceFile(target, Buffer.from(before, 'base64').toString('utf8'));
					}
				}
			} catch (err) {
				this.log(`${target} could not be put back as it was: ${messageOf(err)}`);
			}
			if (previous) {
				entry.files[file] = previous;
			} else {
				delete entry.files[file];
			}
		}
		for (const made of [...writing.made].reverse()) {
			try {
				fs.rmdirSync(path.join(key, made));
			} catch {
				// Something else is in it, or it was never made.
			}
		}
		entry.made = entry.made.filter(made => !writing.made.includes(made));
		entry.lines = entry.lines.filter(line => !writing.lines.includes(line));
		delete entry.writing;
		if (!Object.keys(entry.files).length && !entry.made.length && !entry.users.length) {
			delete record.folders[key];
		}
		if (entry.exclude !== undefined) {
			this.removeExcludeLines(record, entry.exclude, writing.lines);
		}
	}

	/**
	 * Takes back what Facade put into the folder `key`, which no agent uses any more. What cannot be taken
	 * back yet - a file the disk refuses, a folder a process has in use - stays in the record for later.
	 */
	private takeBack(record: InjectedRecord, key: string): void {
		const entry = record.folders[key];
		const left: FolderRecord['files'] = {};
		for (const [file, written] of Object.entries(entry.files)) {
			const target = path.join(key, file);
			try {
				this.takeBackFile(target, written);
			} catch (err) {
				left[file] = written;
				this.log(`${target} could not be taken back yet, and is tried again later: ${messageOf(err)}`);
			}
		}
		// Innermost first. One with a file of Facade's left in it, or one a process has in use, is tried
		// again later, with the folders around it; one with something of the person's in it stays.
		const leftMade: string[] = [];
		for (const made of [...entry.made].reverse()) {
			const dir = path.join(key, made);
			if ([...leftMade, ...Object.keys(left)].some(inner => isInside(path.join(key, inner), dir))) {
				leftMade.unshift(made);
				continue;
			}
			try {
				fs.rmdirSync(dir);
			} catch (err) {
				if (IN_USE_CODES.has(codeOf(err) ?? '')) {
					leftMade.unshift(made);
				}
				// Otherwise something of the person's is in it, or it went with its worktree.
			}
		}
		delete record.folders[key];
		if (Object.keys(left).length || leftMade.length) {
			if (leftMade.length && !Object.keys(left).length) {
				this.log(`${path.join(key, leftMade[0])} is still in use by a process of an agent that ended: Facade removes it once it is not.`);
			}
			record.folders[key] = { users: [], files: left, made: leftMade, ...(entry.exclude !== undefined ? { exclude: entry.exclude } : {}), lines: Object.keys(left).length ? entry.lines : [] };
		}
		if (entry.exclude !== undefined && !Object.keys(left).length) {
			this.removeExcludeLines(record, entry.exclude, entry.lines);
		}
	}

	private takeBackFile(target: string, written: WrittenFile): void {
		const current = readBytes(target);
		if (current === undefined) {
			if (written.theirs !== undefined) {
				const kept = this.keep(target, written.theirs);
				this.log(`${target} was gone when its agents ended: what it held before Facade's part went in is kept at ${kept}.`);
				this.tell(l10n.t("{0} was gone when its agents ended: what it held before Facade's part went in is kept at {1}.", target, kept));
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
			this.log(`${target} changed while agents used it and holds nothing of Facade's: it is left as it is, and what it held before is kept at ${kept}.`);
			this.tell(l10n.t("{0} changed while agents used it and holds nothing of Facade's: it is left as it is, and what it held before is kept at {1}.", target, kept));
		} else {
			this.log(`${target} changed since Facade put it there: it is left as it is.`);
		}
	}

	/** Takes `lines` out of `exclude` where Facade added them and no folder's files need them any more. */
	private removeExcludeLines(record: InjectedRecord, exclude: string, lines: readonly string[]): void {
		const needed = new Set(Object.values(record.folders).filter(each => each.exclude !== undefined && isEqualPath(each.exclude, exclude)).flatMap(each => each.lines));
		const key = keyFor(record.added, exclude);
		if (key === undefined) {
			return;
		}
		const gone = record.added[key].filter(line => lines.includes(line) && !needed.has(line));
		try {
			removeLines(exclude, gone);
		} catch (err) {
			this.log(`${exclude} could not be changed: Facade's lines ${gone.join(', ')} stay in it. ${messageOf(err)}`);
		}
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

/** Whether something is left to take back later: a folder no agent uses that still holds what Facade put there. */
function hasLeftovers(record: InjectedRecord): boolean {
	return Object.values(record.folders).some(entry => !entry.users.length);
}

/** Whether `inner` is inside the folder `outer`. */
function isInside(inner: string, outer: string): boolean {
	const relative = path.relative(outer, inner);
	return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The folders in `folder` that `dirs` need and that are not there yet, relative to `folder`, outermost first. */
function foldersToMake(folder: string, dirs: readonly string[]): string[] {
	const missing: string[] = [];
	for (const dir of dirs) {
		for (let each = dir; !isEqualPath(each, folder) && path.dirname(each) !== each && !fs.existsSync(each); each = path.dirname(each)) {
			const relative = path.relative(folder, each);
			if (!missing.includes(relative)) {
				missing.push(relative);
			}
		}
	}
	return missing.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
}

/** The `info/exclude` line for one file, by its path relative to its worktree's root; undefined for one outside it. */
function excludeLine(relative: string): string | undefined {
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return undefined;
	}
	// The file alone, from the root, with any pattern characters escaped.
	return `/${relative.split(path.sep).join('/').replace(/[*?[\\]/g, '\\$&')}`;
}

/** The `.gitignore` of `dir`, a folder Facade makes: itself, and the files of `writes` in it, each alone. */
function ignoreFileOf(dir: string, writes: readonly FileWrite[]): string {
	const lines = ['/.gitignore', ...writes.filter(write => isInside(write.target, dir)).map(write => excludeLine(path.relative(dir, write.target))).filter((line): line is string => line !== undefined)];
	return `${[...new Set(lines)].join('\n')}\n`;
}

/** Which of `lines` an `info/exclude` does not have yet. */
function linesMissing(file: string, lines: readonly string[]): string[] {
	let listed = '';
	try {
		listed = fs.readFileSync(file, 'utf8');
	} catch {
		// Made as the lines are added.
	}
	const present = new Set(listed.split(/\r?\n/));
	return [...new Set(lines)].filter(line => !present.has(line));
}

/** Adds `lines` to an `info/exclude`, after what it has. */
function appendLines(file: string, lines: readonly string[]): void {
	let listed = '';
	try {
		listed = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (codeOf(err) !== 'ENOENT') {
			throw err;
		}
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${listed && !listed.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
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
