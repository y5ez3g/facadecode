/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as l10n from '@vscode/l10n';
import { codeOf, messageOf } from '../base/errors';
import { formatJson, isEqualPath, isInsideFolder, jsonLayoutOf, parseJson, replaceFile } from '../base/files';
import { isJsonObject, isStringArray } from '../base/json';
import { withFileLock } from '../base/lock';
import { Injected } from '../clis/cli';
import { OwnedFile } from './ports';

/** What removing a folder fails with on Windows while a process has it as its current folder. */
const IN_USE_CODES = new Set(['EBUSY', 'EPERM']);

/**
 * An agent that uses what Facade put into a folder: by its workspace's record and its number, with its process
 * once it has one - or, number 0, an earlier build's window, known by its record alone (X-11).
 */
export interface InjectionUser {
	readonly workspace: string;
	readonly id: number;
	readonly processId?: number;
}

/**
 * A file Facade wrote: the hash of what it wrote, and what it wrote, in base64 - for its part to be taken out
 * of the file as someone changed it (X-28); and where it took the place of the person's own file, theirs, in
 * base64. A record of an earlier build has what it wrote only for a file of the person's.
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

/**
 * A file Facade wrote into a folder that nobody changed since: where, its hash, and - one it merged its part
 * into - what the person's held before, in base64.
 */
export interface UnchangedFile extends OwnedFile {
	readonly theirs?: string;
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
	/**
	 * What else Facade did to an `info/exclude` as it added its first lines, undone once its last ones go:
	 * made it, where there was none; or ended the person's last line, `endedLine`, which had no line break (X-65).
	 */
	edited?: { [exclude: string]: ExcludeEdit };
}

/** What Facade did to an `info/exclude` besides its lines. */
interface ExcludeEdit {
	readonly made?: boolean;
	readonly endedLine?: string;
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
	// None in an earlier build's record: nothing to undo then
	if (isJsonObject(value.edited)) {
		for (const [exclude, edit] of Object.entries(value.edited)) {
			if (!isJsonObject(edit) || (edit.made !== undefined && edit.made !== true) || (edit.endedLine !== undefined && typeof edit.endedLine !== 'string')) {
				return undefined;
			}
			record.edited = { ...record.edited, [exclude]: { ...(edit.made ? { made: true } : {}), ...(typeof edit.endedLine === 'string' ? { endedLine: edit.endedLine } : {}) } };
		}
	}
	return record;
}

function folderRecordOf(value: unknown): FolderRecord | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}
	const { files, made, exclude, lines, writing } = value;
	// An earlier build's record names the records of the windows whose agents use the files, its holders: each
	// a user known by its record alone, which may run while that record's ledger is held (X-11)
	const users = value.users ?? (isStringArray(value.holders) ? value.holders.map(workspace => ({ workspace, id: 0 })) : undefined);
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
	if (!isJsonObject(value) || typeof value.workspace !== 'string' || (value.id !== 0 && !isNumberFrom1(value.id)) || (value.processId !== undefined && !isNumberFrom1(value.processId))) {
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
			const ignores = made.filter(each => !made.some(other => other !== each && isInsideFolder(each, other))).map(each => ({ file: `${each.split(path.sep).join('/')}/.gitignore`, target: path.join(folder, each, '.gitignore'), content: ignoreFileOf(path.join(folder, each), writes) }));
			const all: FileWrite[] = [...writes, ...ignores];
			const lines = git.exclude ? this.linesFor(folder, files, git, git.exclude).filter(line => !entry.lines.includes(line)) : [];
			const exclude = git.exclude?.file;
			const missing = exclude ? linesMissing(exclude, lines) : [];

			// A file of the person's that Facade's part went into, and that they deleted since: a later start writes it
			// anew, Facade's alone - what it held before is kept, and said, as at the end of its agents (C-INJ-09; X-64)
			const deleted = all.filter(write => entry.files[write.file]?.theirs !== undefined && readBytes(write.target) === undefined).map(write => ({ target: write.target, theirs: entry.files[write.file].theirs as string }));

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
				entry.files[write.file] = { hash, ...(write.theirs !== undefined ? { theirs: write.theirs } : {}), ours: Buffer.from(write.content).toString('base64') };
			}
			entry.made.push(...made);
			entry.lines.push(...lines);
			if (exclude) {
				entry.exclude = exclude;
				const addedKey = keyFor(record.added, exclude) ?? exclude;
				// Its first lines there: what else adding them does, recorded first, to be undone with the last
				if (missing.length && !record.added[addedKey]?.length && keyFor(record.edited ?? {}, exclude) === undefined) {
					const before = readText(exclude);
					const lastLine = before?.split('\n').at(-1);
					const edit: ExcludeEdit = before === undefined ? { made: true } : lastLine ? { endedLine: lastLine } : {};
					if (edit.made || edit.endedLine !== undefined) {
						record.edited = { ...record.edited, [exclude]: edit };
					}
				}
				record.added[addedKey] = [...new Set([...record.added[addedKey] ?? [], ...missing])];
			}
			record.folders[key] = entry;
			this.write(record);

			try {
				for (const dir of made) {
					fs.mkdirSync(path.join(folder, dir));
				}
				for (const write of all) {
					// A file of the project's, as any program there makes one - not Facade's own, kept to the user (X-65)
					replaceFile(write.target, write.content, undefined, 0o666);
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
			for (const { target, theirs } of deleted) {
				const kept = this.keep(target, theirs);
				this.log(`${target} was gone when Facade's part went into it again: what it held before Facade's part first went in is kept at ${kept}.`);
				this.tell(l10n.t("{0} was gone when another agent started there: what it held before Facade's part went in is kept at {1}.", target, kept));
			}
		});
	}

	/**
	 * The files of `folder` that Facade wrote there and nobody changed since, relative to it with forward
	 * slashes, with the hash of what they hold - and, for one of the person's that Facade merged its part into,
	 * what it held before: whether that is their work is the caller's to say (AGENT-ORCHESTRATION.md, O5).
	 */
	ownedUnchanged(folder: string): UnchangedFile[] {
		return this.writtenIn(folder).filter(each => each.unchanged).map(({ file, written }) => ({ path: file, sha256: written.hash, ...(written.theirs !== undefined ? { theirs: written.theirs } : {}) }));
	}

	/**
	 * The files Facade wrote into `folder` that someone changed since, relative to it with forward slashes:
	 * work, which git may not show - a file of Facade's own is kept out of it by `info/exclude` (X-73).
	 */
	editedSince(folder: string): string[] {
		return this.writtenIn(folder).filter(each => each.unchanged === false).map(each => each.file);
	}

	/** Each file Facade wrote into `folder`, and whether it holds what Facade wrote: undefined where it is gone or cannot be read. */
	private writtenIn(folder: string): { readonly file: string; readonly written: WrittenFile; readonly unchanged?: boolean }[] {
		return withFileLock(this.file, () => {
			const record = this.read();
			const key = keyFor(record.folders, folder);
			const entry = key === undefined ? undefined : record.folders[key];
			return Object.entries(entry?.files ?? {}).map(([file, written]) => {
				let current: Buffer | undefined;
				try {
					current = readBytes(path.join(folder, file));
				} catch {
					current = undefined;
				}
				return { file: file.split(path.sep).join('/'), written, ...(current !== undefined ? { unchanged: hashOf(current) === written.hash } : {}) };
			});
		});
	}

	/**
	 * The agents of other workspaces than `workspace` - another window's - that use what Facade put into
	 * `folder` and may still run: working there, beyond this window's sight.
	 */
	othersUsing(folder: string, workspace: string): InjectionUser[] {
		return withFileLock(this.file, () => {
			const record = this.read();
			const key = keyFor(record.folders, folder);
			const users = key === undefined ? [] : record.folders[key].users;
			return users.filter(user => !isEqualPath(user.workspace, workspace) && this.mayRun(user));
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
			if (!isInsideFolder(target, folder)) {
				throw new Error(`${cli} is not started: ${file.path} leads out of ${folder}, where Facade puts nothing.`);
			}
			// Written through, a link would take Facade's files where it points - out of the folder, maybe - and
			// replaced, it would be lost: one on the way is refused, named, and left as it is (X-63)
			const link = linkOnTheWay(folder, target);
			if (link !== undefined) {
				throw new Error(`${cli} is not started: ${link} is a symbolic link, and Facade writes nothing through one, nor over it.`);
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
				// Changed while Facade's part was in it - the person's file, or one Facade made: theirs is it without
				// that part; nothing, where that is nothing (X-28). One whose Facade entry they changed is theirs whole.
				const changed = written?.ours !== undefined
					? withoutOurs(current.toString('utf8'), written.theirs !== undefined ? Buffer.from(written.theirs, 'base64').toString('utf8') : undefined, Buffer.from(written.ours, 'base64').toString('utf8'))
					: undefined;
				theirs = changed === undefined || changed === 'changed'
					? current.toString('base64')
					: written?.theirs === undefined && changed.empty ? undefined : Buffer.from(changed.text).toString('base64');
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
			// info/exclude is every worktree's of the repository: a line for a name of the person's - `.mcp.json` -
			// would hide theirs in each, for git to clean or check out over. Only a path in a folder of Facade's own
			// name is narrow enough; any other shows in git status, its entry saying whose it is (O10; X-12).
			if (!file.path.split('/').includes('facade')) {
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
				const wrote = entry.files[file];
				// As a take-back does it, what it held before standing for the person's: unchanged, put back; gone,
				// what it held before kept and said. Changed since - by the person, after the window went - what it
				// held before is kept and said first, whatever comes of Facade's part (C-INJ-03; X-64)
				if (wrote !== undefined) {
					const now = readBytes(target);
					let kept = false;
					if (now !== undefined && before !== undefined && hashOf(now) !== wrote.hash && !now.equals(Buffer.from(before, 'base64'))) {
						const at = this.keep(target, before);
						this.log(`${target} changed after Facade's part went in, as its window went: what it held before is kept at ${at}.`);
						this.tell(l10n.t("{0} changed after Facade's part went in, as its window went: what it held before is kept at {1}.", target, at));
						kept = true;
					}
					this.takeBackFile(target, { hash: wrote.hash, ...(wrote.ours !== undefined ? { ours: wrote.ours } : {}), ...(before !== undefined ? { theirs: before } : {}) }, kept);
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
			if ([...leftMade, ...Object.keys(left)].some(inner => isInsideFolder(path.join(key, inner), dir))) {
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

	/** `kept`: what the file held before is kept already, and said - not again. */
	private takeBackFile(target: string, written: WrittenFile, kept = false): void {
		const current = readBytes(target);
		// Put back already - by a take-back the window's going cut short before its record was written: nobody
		// changed it (C-INJ-04; X-64)
		if (current !== undefined && written.theirs !== undefined && current.equals(Buffer.from(written.theirs, 'base64'))) {
			return;
		}
		if (current === undefined) {
			if (written.theirs !== undefined) {
				const at = this.keep(target, written.theirs);
				this.log(`${target} was gone when its agents ended: what it held before Facade's part went in is kept at ${at}.`);
				this.tell(l10n.t("{0} was gone when its agents ended: what it held before Facade's part went in is kept at {1}.", target, at));
			}
			return;
		}
		if (hashOf(current) === written.hash) {
			if (written.theirs !== undefined) {
				replaceFile(target, Buffer.from(written.theirs, 'base64'));
			} else {
				fs.rmSync(target, { force: true });
			}
			return;
		}
		// Changed while Facade's part was in it - the person's file, or one Facade made: the change is theirs.
		const before = written.theirs !== undefined ? Buffer.from(written.theirs, 'base64').toString('utf8') : undefined;
		const ours = written.ours !== undefined ? Buffer.from(written.ours, 'base64').toString('utf8') : undefined;
		const withoutFacade = ours !== undefined ? withoutOurs(current.toString('utf8'), before, ours) : undefined;
		if (withoutFacade === 'changed') {
			// Facade's own entry changed: left as it is, a copy kept, said once (AGENT-ORCHESTRATION.md, O10; X-29)
			if (kept) {
				this.log(`${target}: Facade's own entry in it was changed, so it is left as it is.`);
			} else {
				const at = this.keep(target, written.theirs ?? written.ours!);
				this.log(`${target}: Facade's own entry in it was changed while agents used it, so it is left as it is; ${before !== undefined ? 'what it held before Facade\'s part went in' : 'what Facade wrote'} is kept at ${at}.`);
			}
		} else if (withoutFacade !== undefined) {
			// Facade's part out, the change kept; a file Facade made that holds nothing else goes (X-28)
			if (before === undefined && withoutFacade.empty) {
				fs.rmSync(target, { force: true });
			} else {
				replaceFile(target, withoutFacade.text);
			}
			this.log(`${target} changed while Facade's part was in it: the change is kept, and Facade's part taken out.`);
		} else if (written.theirs !== undefined && !kept) {
			const at = this.keep(target, written.theirs);
			this.log(`${target} changed while agents used it and holds nothing of Facade's: it is left as it is, and what it held before is kept at ${at}.`);
			this.tell(l10n.t("{0} changed while agents used it and holds nothing of Facade's: it is left as it is, and what it held before is kept at {1}.", target, at));
		} else {
			this.log(`${target} changed since Facade put it there: it is left as it is.`);
		}
	}

	/**
	 * Undoes what Facade did to `exclude` besides its lines, its last lines gone: one it made goes, where nothing
	 * else is in it; the line break it ended the person's last line with goes, where that line is still the last.
	 */
	private undoExcludeEdit(record: InjectedRecord, exclude: string): void {
		const key = keyFor(record.edited ?? {}, exclude);
		if (key === undefined || !record.edited) {
			return;
		}
		const edit = record.edited[key];
		delete record.edited[key];
		if (!Object.keys(record.edited).length) {
			delete record.edited;
		}
		const now = readText(exclude);
		try {
			if (edit.made && now === '') {
				fs.rmSync(exclude, { force: true });
			} else if (edit.endedLine !== undefined && now !== undefined && now.endsWith(`${edit.endedLine}\n`) && (now.length === edit.endedLine.length + 1 || now.at(-edit.endedLine.length - 2) === '\n')) {
				replaceFile(exclude, now.slice(0, -1));
			}
		} catch (err) {
			this.log(`${exclude} could not be put back as it was before Facade's lines: ${messageOf(err)}`);
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
			this.undoExcludeEdit(record, exclude);
		}
	}

	/** Keeps what the person's file held, in base64, in `kept/` beside the record, under the time and the file's name; answers where. */
	private keep(target: string, theirs: string): string {
		const dir = path.join(path.dirname(this.file), 'kept');
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
		for (let n = 1; ; n++) {
			const kept = path.join(dir, `${stamp}${n > 1 ? `-${n}` : ''}-${path.basename(target)}`);
			try {
				// The person's own, which may hold their secrets: readable by them alone (X-65)
				fs.writeFileSync(kept, Buffer.from(theirs, 'base64'), { flag: 'wx', mode: 0o600 });
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
				this.setAside(`could not be read (${messageOf(err)})`, true);
			}
			return { folders: {}, added: {} };
		}
		const record = injectedRecordOf(value);
		if (!record) {
			this.setAside('holds no record Facade can read', true);
		} else if (isJsonObject(value) && isJsonObject(value.folders) && Object.values(value.folders).some(entry => isJsonObject(entry) && entry.users === undefined)) {
			// Kept as it was, then written as this build's, once
			this.setAside('is an earlier build\'s record, read as this one\'s', false);
			this.write(record);
		}
		return record ?? { folders: {}, added: {} };
	}

	/**
	 * Keeps the record as it is beside it - moved, where Facade starts its record anew, or copied, where it reads
	 * it - before Facade writes over it: what an earlier build or a damaged file held is never lost (X-11).
	 */
	private setAside(why: string, anew: boolean): void {
		const aside = `${this.file}.${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')}.${anew ? 'unread' : 'earlier'}`;
		try {
			if (anew) {
				fs.renameSync(this.file, aside);
			} else {
				fs.copyFileSync(this.file, aside, fs.constants.COPYFILE_EXCL);
			}
			this.log(`${this.file} ${why}: it is kept at ${aside}${anew ? ', and Facade starts its record anew' : ''}.`);
		} catch (err) {
			this.log(`${this.file} ${why}, and could not be kept aside (${messageOf(err)})${anew ? ': Facade starts its record anew' : ''}.`);
		}
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
function withoutOurs(current: string, theirs: string | undefined, ours: string): { readonly text: string; readonly empty: boolean } | 'changed' | undefined {
	try {
		const now = parseJson(current);
		let changed = false;
		const kept = stripped(now, theirs === undefined ? undefined : parseJson(theirs), parseJson(ours), () => changed = true);
		if (changed) {
			return 'changed';
		}
		return isSameJson(kept, now) ? undefined : { text: formatJson(kept, jsonLayoutOf(current)), empty: isSameJson(kept, {}) || isSameJson(kept, []) };
	} catch {
		return undefined;
	}
}

/**
 * `now` without what `ours` added over `before` - none for a file Facade made. An entry of Facade's that
 * someone changed is not taken out: `changed` hears of it, and the file is the person's to keep as it is.
 */
function stripped(now: unknown, before: unknown, ours: unknown, changed: () => void): unknown {
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
			// A key Facade added goes as it wrote it; one that holds entries keeps those the person added since;
			// one of Facade's own the person changed stays, and says so.
			if (isSameJson(value, ours[key])) {
				continue;
			}
			if (holdsEntries(ours[key])) {
				const left = stripped(value, Array.isArray(value) ? [] : {}, ours[key], changed);
				if (!isSameJson(left, []) && !isSameJson(left, {})) {
					kept[key] = left;
				}
			} else {
				changed();
				kept[key] = value;
			}
		} else {
			kept[key] = Object.hasOwn(ours, key) ? stripped(value, theirs[key], ours[key], changed) : value;
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

/** The first symbolic link from `folder` down to `target` - `target` itself included - where one is there. */
function linkOnTheWay(folder: string, target: string): string | undefined {
	let at = folder;
	for (const part of path.relative(folder, target).split(path.sep)) {
		at = path.join(at, part);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(at);
		} catch {
			return undefined;
		}
		if (stat.isSymbolicLink()) {
			return at;
		}
	}
	return undefined;
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
	const lines = ['/.gitignore', ...writes.filter(write => isInsideFolder(write.target, dir)).map(write => excludeLine(path.relative(dir, write.target))).filter((line): line is string => line !== undefined)];
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

/** What `file` holds as text; undefined where it is not there, or cannot be read. */
function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
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
