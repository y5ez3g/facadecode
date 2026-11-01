/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Facade puts into project folders and run folders for the tools (CLIS-2.2). A project write happens only where a CLI requires
// one, under one lock across the runs and windows of the execution environment: the exact original bytes are kept, only Facade's own
// content is merged in, and each run that uses it holds a reference in the record. A different `facade` server or skill already there
// is a conflict, and malformed or unknown content is never overwritten. After the last run lets go, content Facade wrote that nobody
// changed goes - the original put back byte for byte - and a file changed since stays, with a diagnostic. A record that cannot be
// read is never replaced. No global Git ignore is touched, and no folder is removed that Facade did not make or that holds
// anything. A run counts as alive from its plan, before its process exists, so a window that opens meanwhile leaves its files.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { codeOf, messageOf } from '../base/errors';
import { readJsonFile, replaceFile } from '../base/files';
import { canonicalJson, isJsonObject } from '../base/json';
import { addMembers, applyJsonEdits, JsonEdit, JsonMember, JsonObjectNode, jsonStyleOf, memberOf, nodeValue, replaceValue } from '../base/jsonc';
import { withFileLock } from '../base/lock';
import { isSessionFileName } from './identity';
import { Injection, ProjectWrite, runDirOf } from './tools';

/** The record's file in the Facade directory `home`: what Facade put into project folders and the runs that use it. */
export function injectedRecordOf(home: string): string {
	return path.join(home, 'injected.json');
}

/** Content Facade owns in one project file, and the runs that hold it. */
interface Held {
	readonly kind: 'file' | 'entry';
	/** The member Facade owns, for an entry: `mcpServers`, `facade`. */
	readonly keys?: readonly string[];
	/** The file's exact bytes before Facade wrote it, in base64; null where there was no file. */
	readonly original: string | null;
	/** The SHA-256 of the whole file as Facade last left it. */
	readonly written: string;
	/** The SHA-256 of Facade's own content: the file's bytes, or the entry's canonical JSON. */
	readonly owned: string;
	/** For an entry: whether Facade added its parent object too, as it does to a file without one. */
	readonly parent?: boolean;
	/** The folders Facade made for the file. */
	readonly created: readonly string[];
	/** The runs that use it: its reference count. */
	readonly runs: readonly string[];
}

type Record = { [file: string]: Held };

/** A project write checked against the file as it is: what writing it does, or why it cannot be written. */
interface Step {
	readonly file: string;
	/** Writes it, if anything is to be written, and returns the file's record with `run`; none where the content is not Facade's. */
	apply(run: string): Held | undefined;
}

function sha256(data: Buffer | string): string {
	return crypto.createHash('sha256').update(data).digest('hex');
}

/** What `file` holds now, as bytes; undefined where there is no file. */
function bytesOf(file: string): Buffer | undefined {
	try {
		return fs.readFileSync(file);
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return undefined;
		}
		throw err;
	}
}

function isHeld(value: unknown): value is Held {
	return isJsonObject(value) && (value.kind === 'file' || value.kind === 'entry') && (value.original === null || typeof value.original === 'string')
		&& typeof value.written === 'string' && typeof value.owned === 'string' && Array.isArray(value.created) && Array.isArray(value.runs);
}

/**
 * The record as `file` has it; empty where there is none. One that cannot be read - unreadable, no JSON, or not a record - throws:
 * it is never replaced, as what it names would then be forgotten (CLIS-2.2).
 */
function readRecord(file: string): Record {
	const unreadable = (why: string) => new Error(`${file}, Facade's record of the project files it wrote, cannot be read: ${why}`);
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (codeOf(err) === 'ENOENT') {
			return {};
		}
		throw unreadable(messageOf(err));
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		throw unreadable(`it is not valid JSON (${messageOf(err)})`);
	}
	if (!isJsonObject(value) || !isJsonObject(value.files)) {
		throw unreadable('it has no files object');
	}
	const files = value.files;
	const odd = Object.keys(files).find(key => !isHeld(files[key]));
	if (odd !== undefined) {
		throw unreadable(`its entry for ${odd} is not one Facade writes`);
	}
	return { ...files } as Record;
}

function writeRecord(file: string, record: Record): void {
	if (Object.keys(record).length) {
		replaceFile(file, `${JSON.stringify({ files: record }, undefined, '\t')}\n`);
	} else {
		fs.rmSync(file, { force: true });
	}
}

/** `runs` with `run`, once. */
function withRun(runs: readonly string[], run: string): string[] {
	return runs.includes(run) ? [...runs] : [...runs, run];
}

/** The folders above `file` that are not there yet, deepest first. */
function missingFolders(file: string): string[] {
	const missing: string[] = [];
	for (let folder = path.dirname(file); !fs.existsSync(folder); folder = path.dirname(folder)) {
		missing.push(folder);
		if (path.dirname(folder) === folder) {
			break;
		}
	}
	return missing;
}

/** Makes the folders `file` needs; returns those it made, deepest first. */
function makeFolders(file: string): string[] {
	const missing = missingFolders(file);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	return missing;
}

/** Removes each of `folders` that is empty now, deepest first; one that holds anything stays. */
function removeEmptyFolders(folders: readonly string[]): void {
	for (const folder of [...new Set(folders)].sort((a, b) => b.length - a.length)) {
		try {
			fs.rmdirSync(folder);
		} catch {
			// Not empty, or gone already
		}
	}
}

/** A file Facade owns whole, such as a skill's SKILL.md, checked against what is there. */
function fileStep(file: string, content: string, held: Held | undefined): Step | string {
	const wanted = Buffer.from(content, 'utf8');
	const current = bytesOf(file);
	if (current?.equals(wanted)) {
		// Already what Facade writes: Facade's where the record says so, else the person's, which stays as it is
		return { file, apply: run => held ? { ...held, runs: withRun(held.runs, run) } : undefined };
	}
	if (current && held && sha256(current) === held.written) {
		// As Facade left it, from an earlier version of its content: brought up to date
		return {
			file,
			apply: run => {
				replaceFile(file, wanted, undefined, 0o666);
				return { ...held, written: sha256(wanted), owned: sha256(wanted), runs: withRun(held.runs, run) };
			}
		};
	}
	if (current) {
		return held
			? `${file} was changed after Facade wrote it; Facade leaves it as it is`
			: `${file} already exists with other content, such as another ${path.basename(path.dirname(file))} skill or plugin; Facade leaves it as it is`;
	}
	return {
		file,
		apply: run => {
			const created = makeFolders(file);
			replaceFile(file, wanted, 'missing', 0o666);
			return { kind: 'file', original: null, written: sha256(wanted), owned: sha256(wanted), created, runs: withRun(held?.runs ?? [], run) };
		}
	};
}

/** A member Facade owns in a project's JSON file, such as `mcpServers.facade` of `.mcp.json`, checked against what is there. */
function entryStep(file: string, write: Extract<ProjectWrite, { kind: 'entry' }>, held: Held | undefined): Step | string {
	const [parentKey, key] = write.keys;
	const owned = sha256(canonicalJson(write.value));
	const read = readJsonFile(file);
	if (read.kind === 'missing') {
		const text = `${JSON.stringify({ [parentKey]: { [key]: write.value } }, undefined, 2)}\n`;
		return {
			file,
			apply: run => {
				const created = makeFolders(file);
				replaceFile(file, text, 'missing', 0o666);
				return { kind: 'entry', keys: write.keys, original: null, written: sha256(text), owned, parent: true, created, runs: withRun(held?.runs ?? [], run) };
			}
		};
	}
	if (read.kind === 'other') {
		return `${file} ${read.why}; Facade leaves it as it is`;
	}
	const parent = memberOf(read.tree, parentKey);
	if (parent && parent.value.kind !== 'object') {
		return `${file} has a ${parentKey} that is not a JSON object; Facade leaves it as it is`;
	}
	const servers = parent?.value.kind === 'object' ? parent.value : undefined;
	const member = servers && memberOf(servers, key);
	const bytes = fs.readFileSync(file);
	const style = jsonStyleOf(read.text, read.tree, read.layout.lineEnding, read.layout.indent);
	// An edit of the person's text, written only while the file is still as it was read
	const edited = (edits: readonly JsonEdit[], record: (text: string, run: string) => Held): Step => ({
		file,
		apply: run => {
			const text = applyJsonEdits(read.text, edits);
			replaceFile(file, text, read.stamp, 0o666);
			return record(text, run);
		}
	});
	if (member) {
		const existing = sha256(canonicalJson(nodeValue(member.value)));
		if (existing === owned) {
			return { file, apply: run => held ? { ...held, runs: withRun(held.runs, run) } : undefined };
		}
		if (held && existing === held.owned) {
			// Facade's own entry from an earlier version of its content, unchanged since: brought up to date. The original goes back
			// later only where nothing else of the file was changed either
			const untouched = sha256(bytes) === held.written;
			return edited([replaceValue(read.text, member.value, write.value, style)], (text, run) => ({ ...held, written: untouched ? sha256(text) : held.written, owned, runs: withRun(held.runs, run) }));
		}
		return `${file} already names another ${key} server in ${parentKey}; Facade leaves it as it is`;
	}
	const original = bytes.toString('base64');
	const edits = servers ? addMembers(read.text, servers, [[key, write.value]], style) : addMembers(read.text, read.tree, [[parentKey, { [key]: write.value }]], style);
	return edited(edits, (text, run) => ({ kind: 'entry', keys: write.keys, original, written: sha256(text), owned, parent: !servers, created: [], runs: withRun(held?.runs ?? [], run) }));
}

/** The edit that takes `member` out of the object `node` of `text`, with the comma that separates it. */
function withoutMember(node: JsonObjectNode, member: JsonMember): JsonEdit {
	const at = node.members.indexOf(member);
	const next = node.members[at + 1];
	const previous = node.members[at - 1];
	if (next) {
		return { offset: member.keyStart, length: next.keyStart - member.keyStart, text: '' };
	}
	if (previous) {
		return { offset: previous.value.end, length: member.value.end - previous.value.end, text: '' };
	}
	return { offset: node.start, length: node.end - node.start, text: '{}' };
}

/**
 * Takes Facade's content out of `file` once no run holds it: the original put back where the file is as Facade left it, else an
 * entry Facade owns taken out where it is unchanged. Anything else changed stays; the diagnostic says so.
 */
function restore(file: string, held: Held): string | undefined {
	const current = bytesOf(file);
	if (!current) {
		return undefined;
	}
	if (sha256(current) === held.written) {
		if (held.original === null) {
			fs.rmSync(file, { force: true });
		} else {
			replaceFile(file, Buffer.from(held.original, 'base64'), undefined, 0o666);
		}
		return undefined;
	}
	if (held.kind === 'file') {
		return `${file} was changed after Facade wrote it, so it stays`;
	}
	const [parentKey, key] = held.keys ?? [];
	const read = readJsonFile(file);
	if (read.kind !== 'object') {
		return `${file} ${read.kind === 'other' ? read.why : 'is gone'}; Facade's ${parentKey}.${key} entry stays as it is`;
	}
	const parent = memberOf(read.tree, parentKey);
	const member = parent?.value.kind === 'object' ? memberOf(parent.value, key) : undefined;
	if (!parent || !member || parent.value.kind !== 'object') {
		return undefined;
	}
	if (sha256(canonicalJson(nodeValue(member.value))) !== held.owned) {
		return `${file}: ${parentKey}.${key} was changed after Facade wrote it, so it stays`;
	}
	const edit = held.parent && parent.value.members.every(each => each.key === key) ? withoutMember(read.tree, parent) : withoutMember(parent.value, member);
	replaceFile(file, applyJsonEdits(read.text, [edit]), read.stamp, 0o666);
	return undefined;
}

/**
 * Takes the runs `goes` picks off the records of `files` in `record`; content no run holds any more is taken out of its file. Returns
 * the diagnostics of what stays.
 */
function dropRuns(record: Record, files: readonly string[], goes: (run: string) => boolean): string[] {
	const diagnostics: string[] = [];
	const folders: string[] = [];
	for (const file of files) {
		const held = record[file];
		if (!held?.runs.some(goes)) {
			continue;
		}
		const runs = held.runs.filter(run => !goes(run));
		if (runs.length) {
			record[file] = { ...held, runs };
			continue;
		}
		delete record[file];
		try {
			const diagnostic = restore(file, held);
			if (diagnostic) {
				diagnostics.push(diagnostic);
			} else {
				folders.push(...held.created);
			}
		} catch (err) {
			diagnostics.push(`Could not take Facade's content out of ${file}: ${messageOf(err)}`);
		}
	}
	removeEmptyFolders(folders);
	return diagnostics;
}

/**
 * Lets go of the references of the runs `goes` picks, the record's lock held; returns the diagnostics of what stays. A record that
 * cannot be read is left as it is, and so is the content it names: that is the diagnostic.
 */
function letGoHeld(recordFile: string, goes: (run: string) => boolean): string[] {
	let record: Record;
	try {
		record = readRecord(recordFile);
	} catch (err) {
		return [`${messageOf(err)}; it is left as it is, and so is the project content it names`];
	}
	const diagnostics = dropRuns(record, Object.keys(record), goes);
	writeRecord(recordFile, record);
	return diagnostics;
}

/** Lets go of the references of the runs `goes` picks, under the record's lock; returns the diagnostics of what stays. */
function letGo(recordFile: string, goes: (run: string) => boolean): string[] {
	return fs.existsSync(recordFile) ? withFileLock(recordFile, () => letGoHeld(recordFile, goes)) : [];
}

/**
 * Writes the project content of `writes` in `cwd` for `run`, all or none (CLIS-2.2); returns why it cannot be written - a file that
 * holds other content or cannot be read, or a record that cannot be read - and then nothing of it stays written.
 */
export function acquireProject(recordFile: string, run: string, cwd: string, writes: readonly ProjectWrite[]): string | undefined {
	if (!writes.length) {
		return undefined;
	}
	return withFileLock(recordFile, () => {
		let record: Record;
		try {
			record = readRecord(recordFile);
		} catch (err) {
			return `${messageOf(err)}; Facade leaves it as it is and writes no project file until it can be read`;
		}
		const steps: Step[] = [];
		for (const write of writes) {
			const file = path.join(cwd, write.path);
			let step: Step | string;
			try {
				step = write.kind === 'file' ? fileStep(file, write.content, record[file]) : entryStep(file, write, record[file]);
			} catch (err) {
				step = `${file} could not be read: ${messageOf(err)}`;
			}
			if (typeof step === 'string') {
				return step;
			}
			steps.push(step);
		}
		const done: string[] = [];
		let failure: string | undefined;
		try {
			for (const step of steps) {
				const held = step.apply(run);
				if (held) {
					record[step.file] = held;
					done.push(step.file);
				}
			}
		} catch (err) {
			// What this launch wrote goes again, as after its release
			failure = [messageOf(err), ...dropRuns(record, done, each => each === run)].join('; ');
		}
		writeRecord(recordFile, record);
		return failure;
	});
}

/** Lets go of `run`'s project references; returns the diagnostics of content that stays as it was changed. */
export function releaseProject(recordFile: string, run: string): string[] {
	return letGo(recordFile, each => each === run);
}

/**
 * How long a run counts as alive once planned, before its process is listed: a plan's files are written moments before its spawn,
 * so a marker older than this is of a window that ended between the two (CLIS-2.2).
 */
export const PLANNED_ALIVE_MS = 10 * 60_000;

/** The folder of run `run`'s own files in the Facade directory `home`: its launch files and its planned marker. */
function runFolderOf(home: string, run: string): string {
	return path.dirname(runDirOf(home, run));
}

/** The marker of a run planned and not yet known to have ended. */
function plannedMarkerOf(home: string, run: string): string {
	return path.join(runFolderOf(home, run), 'planned');
}

/**
 * Marks `run` as planned, under the record's lock, before any file of its launch is written: until its process is listed - or
 * {@link PLANNED_ALIVE_MS} passes - another window's reconcile counts it as alive and leaves its files (CLIS-2.2). Its release
 * removes the marker.
 */
export function markPlanned(home: string, run: string): void {
	withFileLock(injectedRecordOf(home), () => {
		const marker = plannedMarkerOf(home, run);
		fs.mkdirSync(path.dirname(marker), { recursive: true });
		fs.writeFileSync(marker, '');
	});
}

/**
 * The runs of the Facade directory `home` with a folder of their own files, by run ID. A run's session folder beside them is no
 * run's: it holds the hook a live run's CLI still calls, and goes with that run's process (CLIS-2.4).
 */
function runFoldersIn(home: string): string[] {
	const runs = path.dirname(runFolderOf(home, 'run'));
	try {
		return fs.readdirSync(runs, { withFileTypes: true }).filter(entry => entry.isDirectory() && !isSessionFileName(entry.name)).map(entry => entry.name);
	} catch {
		return [];
	}
}

/** Whether `run` was planned less than {@link PLANNED_ALIVE_MS} before `now`. */
function plannedRecently(home: string, run: string, now: number): boolean {
	try {
		return now - fs.statSync(plannedMarkerOf(home, run)).mtimeMs < PLANNED_ALIVE_MS;
	} catch {
		return false;
	}
}

/** Removes run `run`'s own files: its folder of launch files and planned marker (RULES-5.3). */
export function removeRunFiles(home: string, run: string): void {
	fs.rmSync(runFolderOf(home, run), { recursive: true, force: true });
}

/**
 * Lets go of everything `run` held (CLIS-2.2, RULES-5.3): its project references - content no run holds any more taken out - its
 * launch files and its planned marker. Returns the diagnostics of what stays.
 */
export function releaseRun(home: string, run: string): string[] {
	const diagnostics = releaseProject(injectedRecordOf(home), run);
	removeRunFiles(home, run);
	return diagnostics;
}

/**
 * Lets go of what runs that are neither in `alive` nor planned recently still hold, as after windows that ended without letting go:
 * under the record's lock, so that a run another window plans now is either seen planned or holds nothing yet. Returns the
 * diagnostics of what stays.
 */
export function reconcileRuns(home: string, alive: readonly string[], now: number = Date.now()): string[] {
	const recordFile = injectedRecordOf(home);
	return withFileLock(recordFile, () => {
		const known = new Set([...alive, ...runFoldersIn(home)]);
		const living = new Set([...alive, ...[...known].filter(run => plannedRecently(home, run, now))]);
		const goes = (run: string) => !living.has(run);
		const diagnostics = fs.existsSync(recordFile) ? letGoHeld(recordFile, goes) : [];
		for (const run of [...known].filter(goes)) {
			try {
				removeRunFiles(home, run);
			} catch (err) {
				diagnostics.push(`Could not remove the files of the ended run ${run}: ${messageOf(err)}`);
			}
		}
		return diagnostics;
	});
}

/** Writes the run's own launch files of `injection`. */
export function writeRunFiles(injection: Injection): void {
	for (const each of injection.runFiles) {
		fs.mkdirSync(path.dirname(each.path), { recursive: true });
		replaceFile(each.path, each.content);
	}
}
