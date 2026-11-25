/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { codeOf, messageOf } from '../../base/errors';
import { isSameFolder, replaceFile } from '../../base/files';
import { isJsonObject } from '../../base/json';
import { withFileLock, withLongFileLock } from '../../base/lock';
import { isProcessRunning, isSameStart, processStartedAt, processStartTime, processStartTimeOf } from '../../base/system';
import type { AgentRef, DaemonTopics } from '../../base/frameworkProtocol';
import type { Disposable, Event, LogPort, FrameworkPin } from '../../core/ports';
import { keepWorkspaceUri, mayReadPreLedgerWorkspace, workspaceRecord } from '../../record/workspace';
import {
	isFrameworkPin, isLegacySessionPin, isLegacyWorkspaceKey as isWorkspaceKey, LEGACY_STATE_FILE as OLD_STATE,
	legacyStateFile, readLegacyPins, type LegacyMigrationSource, type LegacyPinMigration, type LegacySessionPin,
} from '../legacyPins';
import { legacyWindowInstance } from '../windowComponent';

export interface WorkspaceRoster {
	readonly members: readonly AgentRef[];
	readonly pins: readonly FrameworkPin[];
}

export interface WorkspacePinFailure {
	readonly id: string;
	readonly reference: AgentRef;
	readonly reason: string;
}

interface PinRestoreResult {
	readonly performed: boolean;
	readonly failures: readonly WorkspacePinFailure[];
}

interface SavedRoster extends WorkspaceRoster {
	readonly version: 1;
	readonly hidden: readonly AgentRef[];
	readonly imported: boolean;
	readonly importedPins: boolean;
	readonly legacyWorkspaceKey?: string;
}

interface LegacyPinRecovery {
	readonly version: 1;
	readonly pending: readonly LegacySessionPin[];
	readonly attempts: readonly string[];
	readonly unrecognized: readonly unknown[];
	readonly reports?: readonly LegacyPinReport[];
	readonly commits?: readonly { readonly id: string; readonly reference: AgentRef }[];
	readonly removed?: readonly string[];
}

interface LegacyPinReport {
	readonly id: string;
	readonly reason: string;
}

interface LegacySource {
	readonly migration?: LegacyMigrationSource['pins'];
	readonly home?: string;
	readonly key?: string;
	readonly file?: string;
	readonly folderless?: { readonly home: string; readonly uri: string; readonly kept?: string };
	readonly keepNativeKey?: () => Thenable<void>;
}

type AgentInfo = DaemonTopics['agents']['snapshot']['agents'][number];

const WORKSPACE_KEY = 'facade.workspaceKey';
const EMPTY_WORKSPACE_KEY = 'facade.orchestratorEmptyWorkspaceKey';
const ROSTER = 'orchestrator-workspace.json';
const ROSTER_POLL_MS = 1_000;
const LEGACY_PIN_RECOVERY = 'orchestrator-legacy-pins.json';
const WINDOW_FILE_FORMAT = /^[0-9a-f]{16}\.json$/;
const EMPTY: SavedRoster = { version: 1, members: [], pins: [], hidden: [], imported: false, importedPins: false };

/** Open the shared roster using the URI's canonical key (ARCHITECTURE-6.2). */
export function openFrameworkWorkspace(context: vscode.ExtensionContext, options: {
	readonly home: string;
	readonly log: LogPort;
	readonly legacy?: LegacyMigrationSource;
}): FrameworkWorkspace {
	const { home, log } = options;
	const folders = vscode.workspace.workspaceFolders;
	const workspace = vscode.workspace.workspaceFile ?? folders?.[0]?.uri;
	const uri = workspace?.toString() ?? `untitled:${vscode.env.sessionId}`;
	const kept = context.workspaceState.get<unknown>(WORKSPACE_KEY);
	const nativeKey = workspace ? undefined : context.workspaceState.get<unknown>(EMPTY_WORKSPACE_KEY);
	// A kept editor key identifies old Pins only when it matches the URI ledger's binding.
	// The ledger itself also finds the old state for a window with a fresh editor profile.
	const predecessor = options.legacy?.predecessor;
	const handover = predecessor?.window && folders?.length
		? { token: predecessor.window.token, folders: folders.map(folder => folder.uri.toString()) } : undefined;
	const record = workspaceRecord(uri, home, nativeKey, handover);
	const prior = record.handedOver ?? record.binding.key ?? (!folders?.length ? predecessor?.owner : undefined);
	const folderless = !folders?.length ? { home, uri, kept: isWorkspaceKey(kept) ? kept : undefined } : undefined;
	const savedEmpty = folderless && workspace && !uri.startsWith('untitled:');
	const priorFile = prior && legacyStateFile(home, prior);
	const emptyPinFile = savedEmpty && (!priorFile || !fs.existsSync(priorFile))
		? folderlessPinsForUri(home, uri, kept) ?? folderlessPinsForUri(home, uri, record.key)
		: undefined;
	const verified = emptyPinFile ? path.basename(path.dirname(emptyPinFile)) : prior;
	const rosterFile = path.join(record.dir, ROSTER);
	// Save the migration source before registering this URI so another window sees the same binding.
	const key = withFileLock(rosterFile, () => {
		const saved = readRoster(rosterFile);
		if (saved) {
			if (saved.legacyWorkspaceKey || !verified || saved.importedPins) { return saved.legacyWorkspaceKey; }
			// An earlier Framework opening may have registered this saved empty URI before it imported Pins.
			if (savedEmpty && !folderlessPinsForUri(home, uri, verified)) { return undefined; }
			replaceFile(rosterFile, `${JSON.stringify({ ...saved, legacyWorkspaceKey: verified })}\n`);
			return verified;
		}
		const initial: SavedRoster = { ...EMPTY, legacyWorkspaceKey: verified };
		replaceFile(rosterFile, `${JSON.stringify(initial)}\n`);
		return verified;
	}, { keepLive: true });
	const oldStateFile = isWorkspaceKey(key) ? legacyStateFile(home, key) : undefined;
	keepWorkspaceUri(uri, workspace ? record : { ...record, folderless: true }, home);
	return new FrameworkWorkspace(record.dir, {
		migration: options.legacy?.pins,
		home,
		key: isWorkspaceKey(key) ? key : undefined,
		file: oldStateFile && fs.existsSync(oldStateFile) ? oldStateFile : undefined,
		folderless,
		keepNativeKey: !workspace && nativeKey !== record.key
			? () => context.workspaceState.update(EMPTY_WORKSPACE_KEY, record.key)
			: undefined,
	}, log);
}

function normalizedWorkspaceUri(uri: string): string {
	const normalized = uri.replace(/\/+$/, '');
	return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}

/** An empty saved workspace can retain its Memento even though v2 skipped its URI ledger entry. */
function folderlessPinsForUri(home: string, uri: string, key: unknown): string | undefined {
	if (!isWorkspaceKey(key) || !mayReadPreLedgerWorkspace(key, uri, home)) { return undefined; }
	const dir = path.join(home, 'workspaces', key);
	const file = path.join(dir, OLD_STATE);
	if (!fs.existsSync(file)) { return undefined; }
	let identity: unknown;
	try { identity = readJson(path.join(dir, 'identity.json')); }
	catch { return undefined; }
	if (isJsonObject(identity) && typeof identity.workspace === 'string'
		&& normalizedWorkspaceUri(identity.workspace) === normalizedWorkspaceUri(uri)) {
		return file;
	}
	return undefined;
}

/** Read the native-window record from v2's keepWindowKey, including a folderless record with no sidecar. */
function folderlessWindowKey(file: string, uri: string): string | undefined {
	let record: unknown;
	try {
		record = readJson(file);
	} catch {
		return undefined;
	}
	if (!isJsonObject(record) || !isWorkspaceKey(record.key) || !Array.isArray(record.folders) ||
		record.folders.length !== 0 || typeof record.uri !== 'string') {
		return undefined;
	}
	const sameUri = record.uri === normalizedWorkspaceUri(uri);
	// The editor's session changes on reload. A later exact token check identifies this same native empty window.
	return sameUri || (record.uri.startsWith('untitled:') && uri.startsWith('untitled:')) ? record.key : undefined;
}

function folderlessWindows(home: string, uri: string, kept: string | undefined): { readonly any: boolean; readonly kept?: string } {
	const directory = path.join(home, 'windows');
	try {
		let any = false;
		for (const name of fs.readdirSync(directory)) {
			if (!WINDOW_FILE_FORMAT.test(name)) { continue; }
			const key = folderlessWindowKey(path.join(directory, name), uri);
			if (key === undefined) { continue; }
			any = true;
			if (key === kept) { return { any, kept }; }
		}
		return { any };
	} catch (error) {
		if (codeOf(error) === 'ENOENT') { return { any: false }; }
		throw error;
	}
}

function isIdentity(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function isRef(value: unknown): value is AgentRef {
	return isJsonObject(value) && isIdentity(value.machine_id) && isIdentity(value.agent_id);
}

function refOf(pin: FrameworkPin): AgentRef {
	return { machine_id: pin.machine_id, agent_id: pin.agent };
}

function identityOf(ref: AgentRef): AgentRef {
	return { machine_id: ref.machine_id, agent_id: ref.agent_id };
}

function refKey(ref: AgentRef): string {
	return `${ref.machine_id}\0${ref.agent_id}`;
}

function sameRef(a: AgentRef, b: AgentRef): boolean {
	return a.machine_id === b.machine_id && a.agent_id === b.agent_id;
}

function addRef(refs: readonly AgentRef[], ref: AgentRef): readonly AgentRef[] {
	return refs.some(each => sameRef(each, ref)) ? refs : [...refs, identityOf(ref)];
}

function sameLegacyIntent(a: LegacySessionPin, b: LegacySessionPin): boolean {
	const { environment, cli, builtIn, sessionId } = a.conversation;
	const other = b.conversation;
	return environment === other.environment && cli === other.cli && (builtIn ?? cli) === (other.builtIn ?? cli)
		&& sessionId === other.sessionId && (sessionId !== undefined || a.id === b.id) && isSameFolder(a.cwd, b.cwd);
}

function isConvertedLegacyPin(previous: LegacySessionPin, saved: FrameworkPin): boolean {
	const { cli, builtIn, sessionId } = previous.conversation;
	return saved.id === previous.id && sessionId !== undefined && saved.conversation.sessionId === sessionId
		&& saved.conversation.environment === `machine:${saved.machine_id}` && saved.conversation.cli === cli
		&& (saved.conversation.builtIn ?? cli) === (builtIn ?? cli) && isSameFolder(saved.cwd, previous.cwd);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
	} catch (error) {
		if (codeOf(error) === 'ENOENT') { return undefined; }
		throw error;
	}
}

function readRoster(file: string): SavedRoster | undefined {
	const value = readJson(file);
	if (value === undefined) { return undefined; }
	if (!isJsonObject(value) || value.version !== 1 || typeof value.imported !== 'boolean' || typeof value.importedPins !== 'boolean'
		|| !Array.isArray(value.members) || !value.members.every(isRef)
		|| !Array.isArray(value.hidden) || !value.hidden.every(isRef)
		|| !Array.isArray(value.pins) || !value.pins.every(isFrameworkPin)
		|| (value.legacyWorkspaceKey !== undefined && typeof value.legacyWorkspaceKey !== 'string')) {
		throw new Error(vscode.l10n.t('Invalid Facade workspace roster: {0}', file));
	}
	return {
		version: 1, members: value.members, pins: value.pins, hidden: value.hidden, imported: value.imported, importedPins: value.importedPins,
		legacyWorkspaceKey: value.legacyWorkspaceKey,
	};
}

function readLegacyPinRecovery(file: string): LegacyPinRecovery | undefined {
	const invalid = (cause?: unknown) => new Error(vscode.l10n.t('Invalid Facade legacy Pin recovery record: {0}', file), { cause });
	let value: unknown;
	try {
		value = readJson(file);
	} catch (error) {
		throw invalid(error);
	}
	if (value === undefined) { return undefined; }
	if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.pending) || !value.pending.every(isLegacySessionPin)
		|| !Array.isArray(value.attempts) || !value.attempts.every(isIdentity) || !Array.isArray(value.unrecognized)
		|| value.reports !== undefined && (!Array.isArray(value.reports) || !value.reports.every(report =>
			isJsonObject(report) && isIdentity(report.id) && typeof report.reason === 'string'))
		|| value.commits !== undefined && (!Array.isArray(value.commits) || !value.commits.every(commit =>
			isJsonObject(commit) && isIdentity(commit.id) && isRef(commit.reference)))
		|| value.removed !== undefined && (!Array.isArray(value.removed) || !value.removed.every(isIdentity))) {
		throw invalid();
	}
	return value as unknown as LegacyPinRecovery;
}

interface Activation {
	readonly id: string;
	readonly pid: number;
	readonly start: number;
}

interface RestoreRound {
	readonly generation: string;
	readonly activations: readonly Activation[];
	readonly failures?: readonly WorkspacePinFailure[];
}

function readRound(file: string): RestoreRound | undefined {
	const value = readJson(file);
	if (value === undefined) { return undefined; }
	if (!isJsonObject(value) || !isIdentity(value.generation) || !Array.isArray(value.activations)
		|| !value.activations.every(activation => isJsonObject(activation) && isIdentity(activation.id)
			&& Number.isSafeInteger(activation.pid) && Number.isFinite(activation.start))
		|| (value.failures !== undefined && (!Array.isArray(value.failures) || !value.failures.every(failure =>
			isJsonObject(failure) && isIdentity(failure.id) && isRef(failure.reference) && typeof failure.reason === 'string')))) {
		throw new Error(vscode.l10n.t('Invalid Facade Pin recovery record: {0}', file));
	}
	return value as unknown as RestoreRound;
}

function activationIsLive(activation: Activation, selfStart: number): boolean {
	if (!isProcessRunning(activation.pid)) { return false; }
	const start = activation.pid === process.pid ? selfStart : processStartTimeOf(activation.pid, activation.start);
	return start === undefined || isSameStart(start, activation.start);
}

// Each workspace in this process must record the same start even if the native lookup is intermittent.
let ownActivationStart: number | undefined;

/** A group of simultaneously open workspace hosts shares one restore result (RULES-6.4). */
class PinRestoreRound implements Disposable {
	private readonly file: string;
	private readonly restoreLock: string;
	private readonly activation: Activation = {
		id: randomUUID(), pid: process.pid,
		// Use the same OS clock as peers because Node can initialize after the host PID starts.
		start: ownActivationStart ??= processStartedAt(process.pid) ?? processStartTime(process.pid)!,
	};
	private readonly generation: string;
	private disposed = false;

	constructor(directory: string, private readonly log: LogPort) {
		this.file = path.join(directory, 'orchestrator-pin-restore.json');
		this.restoreLock = path.join(directory, 'orchestrator-pin-restore');
		this.generation = withFileLock(this.file, () => {
			const previous = readRound(this.file);
			const activations = previous?.activations.filter(activation => activationIsLive(activation, this.activation.start)) ?? [];
			const round = activations.length && previous ? previous : { generation: randomUUID(), activations: [] };
			replaceFile(this.file, `${JSON.stringify({ ...round, activations: [...activations, this.activation] })}\n`);
			return round.generation;
		}, { keepLive: true });
	}

	async restore(perform: () => Promise<readonly WorkspacePinFailure[]>): Promise<PinRestoreResult> {
		if (this.disposed) { return { performed: false, failures: [] }; }
		// The restore lock covers the calls. Roster edits and registration use their own short locks.
		return withLongFileLock(this.restoreLock, async () => {
			const round = readRound(this.file);
			if (this.disposed || round?.generation !== this.generation) { return { performed: false, failures: [] }; }
			if (round.failures !== undefined) { return { performed: false, failures: round.failures }; }
			const failures = await perform();
			// A concurrently opening window can hold this lock while checking process identities.
			await withLongFileLock(this.file, async () => {
				const latest = readRound(this.file);
				if (latest?.generation === this.generation) {
					replaceFile(this.file, `${JSON.stringify({ ...latest, failures })}\n`);
				}
			}, Infinity);
			return { performed: true, failures };
		}, Infinity);
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		try {
			withFileLock(this.file, () => {
				const round = readRound(this.file);
				if (round?.generation === this.generation) {
					const activations = round.activations.filter(each => each.id !== this.activation.id);
					replaceFile(this.file, `${JSON.stringify({ ...round, activations })}\n`);
				}
			}, { keepLive: true });
		} catch (error) {
			this.log.event(`Could not close this Facade workspace's Pin recovery round: ${messageOf(error)}`);
		}
	}
}

/** Shared card visibility, Pins and import progress, updated together from the latest durable state. */
export class FrameworkWorkspace implements Disposable {
	private readonly file: string;
	private readonly legacyRecoveryFile: string;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange: Event<void> = this.changed.event;
	private readonly watcher: Disposable;
	private readonly restoration: PinRestoreRound;
	private current: SavedRoster;
	private disposed = false;
	private reportedLegacyReadError = false;
	private legacyOwner?: string;

	constructor(directory: string, private readonly legacy: LegacySource, private readonly log: LogPort) {
		this.legacyOwner = legacy.key;
		this.file = path.join(directory, ROSTER);
		this.legacyRecoveryFile = path.join(directory, LEGACY_PIN_RECOVERY);
		this.current = readRoster(this.file) ?? EMPTY;
		this.watcher = this.watchRoster(directory);
		try {
			this.current = readRoster(this.file) ?? EMPTY;
			this.restoration = new PinRestoreRound(directory, log);
		} catch (error) {
			this.watcher.dispose();
			this.changed.dispose();
			throw error;
		}
	}

	snapshot(): WorkspaceRoster {
		return { members: this.current.members, pins: this.current.pins };
	}

	pendingLegacyPins(): readonly LegacySessionPin[] {
		const recovery = this.readLegacyRecovery();
		return recovery?.pending.filter(pin => !recovery.removed?.includes(pin.id)) ?? [];
	}

	legacyPinMigration(): LegacyPinMigration | undefined {
		return isWorkspaceKey(this.legacyOwner) ? this.legacy.migration?.(this.legacyOwner) : undefined;
	}

	/** A v1 attempt may be left beside a completed conversion. Only an exact durable Pin can corroborate it. */
	legacyPinProgress(pin: LegacySessionPin): { readonly attempted: boolean; readonly reference?: AgentRef } {
		const committed = new Map<string, AgentRef>();
		let attempted = false;
		const collect = (rosterFile: string, recovery: LegacyPinRecovery | undefined | null) => {
			const pending = recovery?.pending.filter(each => recovery.attempts.includes(each.id)
				&& !recovery.removed?.includes(each.id) && sameLegacyIntent(each, pin));
			if (!pending?.length) { return; }
			attempted = true;
			const roster = readRoster(rosterFile);
			for (const saved of roster?.pins ?? []) {
				if (pending.some(previous => isConvertedLegacyPin(previous, saved))) {
					const reference = refOf(saved);
					committed.set(refKey(reference), reference);
				}
			}
		};
		try { collect(this.file, this.readLegacyRecovery()); }
		catch { /* The current attempt still fences recovery if its roster cannot substantiate a result. */ }
		if (this.legacy.home) {
			const directory = path.join(this.legacy.home, 'workspaces');
			for (const owner of fs.readdirSync(directory).filter(isWorkspaceKey)) {
				const file = path.join(directory, owner, LEGACY_PIN_RECOVERY);
				if (file === this.legacyRecoveryFile) { continue; }
				try { collect(path.join(directory, owner, ROSTER), readLegacyPinRecovery(file)); }
				catch { /* A damaged store cannot supply a confirmed reference. */ }
			}
		}
		return committed.size === 1 ? { attempted, reference: committed.values().next().value } : { attempted };
	}

	/** A lost reply can have started a process. Save the v1 attempt marker before calling Framework. */
	beginLegacyPinResume(pin: LegacySessionPin): boolean {
		return withFileLock(this.file, () => {
			const roster = readRoster(this.file) ?? EMPTY;
			const recovery = this.readLegacyRecovery();
			if (!recovery?.pending.some(each => each.id === pin.id && sameLegacyIntent(each, pin))
				|| recovery.removed?.includes(pin.id) || roster.pins.some(each => each.id === pin.id)
				|| recovery.attempts.includes(pin.id)) {
				return false;
			}
			this.writeLegacyRecovery({ ...recovery, attempts: [...recovery.attempts, pin.id] });
			return true;
		}, { keepLive: true });
	}

	clearLegacyPinAttempt(pin: LegacySessionPin): void {
		withFileLock(this.file, () => {
			const recovery = this.readLegacyRecovery();
			if (recovery?.attempts.includes(pin.id)) {
				this.writeLegacyRecovery({ ...recovery, attempts: recovery.attempts.filter(id => id !== pin.id) });
			}
		}, { keepLive: true });
	}

	/** All windows share the same failure report. A later opening can still retry the saved Pin. */
	reportLegacyPinFailure(pin: LegacySessionPin, reason: string): boolean {
		return withFileLock(this.file, () => {
			const recovery = this.readLegacyRecovery();
			if (!recovery?.pending.some(each => each.id === pin.id) || recovery.reports?.some(report => report.id === pin.id)) {
				return false;
			}
			this.writeLegacyRecovery({ ...recovery, reports: [...recovery.reports ?? [], { id: pin.id, reason }] });
			return true;
		}, { keepLive: true });
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.watcher.dispose();
		this.changed.dispose();
		this.restoration.dispose();
	}

	/** Execute or join this workspace's one restore attempt for the current opening. */
	async restorePinsOnce(restore: () => Promise<readonly WorkspacePinFailure[]>): Promise<PinRestoreResult> {
		const result = await this.restoration.restore(() => {
			this.refresh();
			return restore();
		});
		this.refresh();
		return result;
	}

	/** Loads verified local Pins and reports whether the stored members can be reconciled. */
	async loadLocalPins(): Promise<boolean> {
		if (this.disposed) { return false; }
		await this.legacy.keepNativeKey?.();
		if (this.disposed) { return false; }
		const before = readRoster(this.file) ?? EMPTY;
		const recovery = this.readLegacyRecovery();
		if (recovery === null) {
			this.publish(before);
			return before.imported;
		}
		if ((before.imported || before.importedPins) && recovery) {
			// A host can stop between committing an exact Pin and consuming migration progress.
			// On reload, finish consumption from the current durable roster before considering a resume.
			return this.edit(latest => {
				const saved = this.readLegacyRecovery();
				const committed = saved?.commits?.filter(commit => latest.pins.some(pin =>
					pin.id === commit.id && sameRef(refOf(pin), commit.reference))).map(commit => commit.id) ?? [];
				this.consumeLegacyPins(new Set([...committed, ...saved?.removed ?? []]));
				return latest;
			}).imported;
		}
		let pinFile = this.legacy.file;
		let pending = !!(this.legacy.key || pinFile);
		const folderless = this.legacy.folderless;
		if (folderless) {
			const windows = folderlessWindows(folderless.home, folderless.uri, folderless.kept);
			if (!this.legacy.migration && windows.kept !== undefined) {
				pending = true;
				pinFile = path.join(folderless.home, 'workspaces', windows.kept, OLD_STATE);
			}
			const previous = pinFile || windows.any ? await legacyWindowInstance() : undefined;
			if (previous) {
				// The extension host holds keepWindowKey's files, while only the UI component has the native token.
				const windowFile = `${createHash('sha256').update(previous.token).digest('hex').slice(0, 16)}.json`;
				const key = folderlessWindowKey(path.join(folderless.home, 'windows', windowFile), folderless.uri);
				if (key) {
					pending = true;
					pinFile = path.join(folderless.home, 'workspaces', key, OLD_STATE);
				}
			}
		}
		if (this.disposed) { return false; }
		const previousKey = pinFile ? path.basename(path.dirname(pinFile)) : this.legacy.key;
		if (isWorkspaceKey(previousKey)) { this.legacyOwner = previousKey; }
		const pinnedBeforeStop = this.legacyPinMigration()?.snapshot();
		const source = pinnedBeforeStop ?? readLegacyPins(pinFile);
		let unrecognized = 0;
		const final = this.edit(latest => {
			const recovery = this.readLegacyRecovery();
			if (recovery === null) { return latest; }
			if (!source && (pending || latest.imported || latest.importedPins)) { return latest; }
			const pins = source?.pins ?? [];
			const importReferences = !latest.imported && !latest.importedPins;
			const hidden = new Set(latest.hidden.map(refKey));
			const visiblePins = new Map(latest.pins.map(pin => [refKey(refOf(pin)), pin]));
			const ids = new Set(latest.pins.map(pin => pin.id));
			for (const pin of importReferences ? pins.filter(isFrameworkPin) : []) {
				const ref = refKey(refOf(pin));
				if (!hidden.has(ref) && !visiblePins.has(ref) && !ids.has(pin.id)) {
					visiblePins.set(ref, pin);
					ids.add(pin.id);
				}
			}
			const members = new Map(latest.members.map(ref => [refKey(ref), ref]));
			for (const pin of visiblePins.values()) {
				const ref = refOf(pin);
				const key = refKey(ref);
				if (!hidden.has(key)) { members.set(key, ref); }
			}
			if (source && !recovery) {
				this.writeLegacyRecovery({
					version: 1, pending: pins.filter(isLegacySessionPin),
					attempts: [], unrecognized: source.unrecognized,
				});
				unrecognized = source.unrecognized.length;
			}
			return {
				...latest, members: [...members.values()], pins: [...visiblePins.values()],
				legacyWorkspaceKey: latest.legacyWorkspaceKey ?? (isWorkspaceKey(previousKey) ? previousKey : undefined),
				imported: latest.imported || !pending, importedPins: true,
			};
		});
		if (unrecognized) {
			const notice = vscode.l10n.t('Could not recognize {0} saved legacy Pin entries. Their original data is in {1}.',
				unrecognized, this.legacyRecoveryFile);
			this.log.event(notice);
			void vscode.window.showWarningMessage(notice);
		}
		return final.imported;
	}

	/** Consume only after the same Pin ID and converted Framework identity are durable. */
	importLegacyPin(previous: LegacySessionPin, pin: FrameworkPin): boolean {
		let committed = false;
		this.edit(latest => {
			const recovery = this.readLegacyRecovery();
			if (!recovery?.pending.some(each => each.id === previous.id && sameLegacyIntent(each, previous))
				|| recovery.removed?.includes(previous.id) || previous.id !== pin.id) { return latest; }
			const reference = refOf(pin);
			const existing = latest.pins.find(each => each.id === pin.id || sameRef(refOf(each), reference));
			if (latest.hidden.some(ref => sameRef(ref, reference)) || existing &&
				(existing.id !== pin.id || !sameRef(refOf(existing), reference)
					|| existing.conversation.cli !== pin.conversation.cli || !isSameFolder(existing.cwd, pin.cwd)
					|| existing.conversation.sessionId !== pin.conversation.sessionId)) { return latest; }
			const commits = [...recovery.commits?.filter(commit => commit.id !== pin.id) ?? [], { id: pin.id, reference }];
			this.writeLegacyRecovery({ ...recovery, commits });
			committed = true;
			return existing ? latest : { ...latest, pins: [...latest.pins, pin], members: addRef(latest.members, reference) };
		}, () => {
			if (committed) { this.consumeLegacyPins(new Set([previous.id])); }
		});
		return committed;
	}

	show(ref: AgentRef): void {
		this.edit(latest => ({
			...latest, members: addRef(latest.members, ref), hidden: latest.hidden.filter(each => !sameRef(each, ref)),
		}));
	}

	forget(ref: AgentRef, explicitlyRemoved = false): void {
		this.edit(latest => {
			this.discardLegacyPins(latest.pins.filter(pin => sameRef(refOf(pin), ref)), explicitlyRemoved);
			return {
				...latest,
				members: latest.members.filter(each => !sameRef(each, ref)),
				pins: latest.pins.filter(pin => !sameRef(refOf(pin), ref)),
				hidden: latest.hidden.filter(each => !sameRef(each, ref)),
			};
		});
	}

	reconcile(records: readonly AgentInfo[], absent: readonly AgentRef[]): void {
		const missing = new Set(absent.map(refKey));
		const children = new Map<string, AgentRef[]>();
		const observed = new Map<string, AgentInfo>();
		for (const record of records) {
			if (record.type === 'managed' && !record.unreachable) {
				observed.set(refKey(record.reference), record);
			}
			if (!record.creator) { continue; }
			const parent = refKey(record.creator);
			const siblings = children.get(parent) ?? [];
			siblings.push(identityOf(record.reference));
			children.set(parent, siblings);
		}
		this.edit(latest => {
			const seen = new Set([...latest.members, ...latest.hidden].map(refKey));
			const members = [...latest.members];
			const ancestry = [...members, ...latest.hidden];
			for (const parent of ancestry) {
				for (const child of children.get(refKey(parent)) ?? []) {
					const key = refKey(child);
					if (seen.has(key)) { continue; }
					seen.add(key);
					members.push(child);
					ancestry.push(child);
				}
			}
			const pinned = new Set(latest.pins.map(pin => refKey(refOf(pin))));
			const exists = (ref: AgentRef) => !latest.imported || !missing.has(refKey(ref));
			const pins = latest.pins.map(pin => {
				const record = observed.get(refKey(refOf(pin)));
				if (!record) { return pin; }
				const sessionId = record.session ?? pin.conversation.sessionId;
				if (record.name === pin.name && sessionId === pin.conversation.sessionId) { return pin; }
				return { ...pin, name: record.name, conversation: { ...pin.conversation, sessionId } };
			});
			return { ...latest, pins, members: members.filter(ref => pinned.has(refKey(ref)) || exists(ref)), hidden: latest.hidden.filter(exists) };
		});
	}

	savePin(pin: FrameworkPin): FrameworkPin {
		const ref = refOf(pin);
		const saved = this.edit(latest => {
			const existing = latest.pins.find(each => sameRef(refOf(each), ref));
			const next = existing ? {
				...existing, ...pin, id: existing.id,
				conversation: { ...existing.conversation, ...pin.conversation },
			} : pin;
			return {
				...latest,
				pins: existing ? latest.pins.map(each => each === existing ? next : each) : [...latest.pins, next],
				members: addRef(latest.members, ref),
				hidden: latest.hidden.filter(each => !sameRef(each, ref)),
			};
		});
		return saved.pins.find(each => sameRef(refOf(each), ref))!;
	}

	removePin(id: string, explicitlyRemoved = true): void {
		this.edit(latest => {
			this.discardLegacyPins(latest.pins.filter(pin => pin.id === id), explicitlyRemoved);
			return { ...latest, pins: latest.pins.filter(pin => pin.id !== id) };
		});
	}

	/** Reserve one sessionless start before sending it, even across a reload or another window. */
	beginPinRestart(expected: FrameworkPin, requestId: string): boolean {
		const saved = this.edit(latest => ({
			...latest,
			pins: latest.pins.map(pin => pin.id === expected.id && sameRef(refOf(pin), refOf(expected))
				&& !pin.conversation.sessionId && !pin.restartAttempt ? { ...pin, restartAttempt: requestId } : pin)
		}));
		return saved.pins.some(pin => pin.id === expected.id && sameRef(refOf(pin), refOf(expected))
			&& pin.restartAttempt === requestId);
	}

	clearPinRestart(expected: FrameworkPin, requestId: string): void {
		this.edit(latest => ({
			...latest,
			pins: latest.pins.map(pin => {
				if (pin.id !== expected.id || !sameRef(refOf(pin), refOf(expected)) || pin.restartAttempt !== requestId) { return pin; }
				const { restartAttempt: _attempt, ...kept } = pin;
				return kept;
			})
		}));
	}

	/** Reorder current Pins while keeping the slots of Pins absent from the panel's order (PANEL-4.2). */
	reorderPins(ids: readonly string[]): void {
		const requested = new Set(ids);
		const before = this.current.pins.filter(pin => requested.has(pin.id)).map(pin => pin.id);
		const present = new Set(before);
		// Apply only changed slots so a move in one window preserves edits to other Pins in another.
		const moved = [...requested].filter(id => present.has(id)).filter((id, index) => id !== before[index]);
		if (moved.length < 2) { return; }
		this.edit(latest => {
			const byId = new Map(latest.pins.map(pin => [pin.id, pin]));
			const ordered = moved.flatMap(id => {
				const pin = byId.get(id);
				return pin ? [pin] : [];
			});
			const reordered = new Set(moved);
			let next = 0;
			return { ...latest, pins: latest.pins.map(pin => reordered.has(pin.id) ? ordered[next++] : pin) };
		});
	}

	replacePin(previous: FrameworkPin, replacement: FrameworkPin): void {
		const before = refOf(previous);
		const after = refOf(replacement);
		this.edit(latest => {
			const existing = latest.pins.find(pin => pin.id === previous.id && sameRef(refOf(pin), before));
			if (!existing) { return latest; }
			const next = { ...existing, machine_id: after.machine_id, agent: after.agent_id, conversation: { ...existing.conversation } };
			for (const key of ['name', 'location', 'cwd'] as const) {
				if (previous[key] !== replacement[key]) { next[key] = replacement[key]; }
			}
			for (const key of ['environment', 'cli', 'sessionId', 'builtIn'] as const) {
				if (previous.conversation[key] !== replacement.conversation[key]) {
					Object.assign(next.conversation, { [key]: replacement.conversation[key] });
				}
			}
			if (replacement.launch && replacement.launch !== previous.launch) { next.launch = replacement.launch; }
			if (!sameRef(before, after)) { delete next.restartAttempt; }
			const duplicate = !sameRef(before, after) && latest.pins.some(pin => sameRef(refOf(pin), after));
			const pins = duplicate ? latest.pins.filter(pin => pin !== existing)
				: latest.pins.map(pin => pin === existing ? next : pin);
			const members = sameRef(before, after) ? latest.members : latest.members.some(ref => sameRef(ref, after))
				? latest.members.filter(ref => !sameRef(ref, before))
				: latest.members.map(ref => sameRef(ref, before) ? after : ref);
			return { ...latest, pins, members, hidden: latest.hidden.filter(ref => !sameRef(ref, after)) };
		});
	}

	private writeLegacyRecovery(recovery: LegacyPinRecovery): void {
		replaceFile(this.legacyRecoveryFile, `${JSON.stringify(recovery)}\n`);
	}

	private readLegacyRecovery(): LegacyPinRecovery | undefined | null {
		try {
			return readLegacyPinRecovery(this.legacyRecoveryFile);
		} catch (error) {
			if (!this.reportedLegacyReadError) {
				this.reportedLegacyReadError = true;
				const reason = messageOf(error);
				this.log.event(reason);
				void vscode.window.showWarningMessage(reason);
			}
			return null;
		}
	}

	private discardLegacyPins(pins: readonly FrameworkPin[], explicitlyRemoved: boolean): void {
		if (!pins.length) { return; }
		const recovery = this.readLegacyRecovery();
		if (!recovery) { return; }
		const removed = recovery.pending.filter(previous => pins.some(pin => pin.id === previous.id
			&& (explicitlyRemoved || recovery.commits?.some(commit => commit.id === pin.id
				&& sameRef(commit.reference, refOf(pin)))))).map(pin => pin.id);
		if (removed.length) { this.writeLegacyRecovery({ ...recovery, removed: [...new Set([...recovery.removed ?? [], ...removed])] }); }
	}

	private consumeLegacyPins(ids: ReadonlySet<string>): void {
		if (!ids.size) { return; }
		const recovery = this.readLegacyRecovery();
		if (recovery?.pending.some(pin => ids.has(pin.id))) {
			this.writeLegacyRecovery({
				...recovery, pending: recovery.pending.filter(pin => !ids.has(pin.id)),
				attempts: recovery.attempts.filter(id => !ids.has(id)),
				reports: recovery.reports?.filter(report => !ids.has(report.id)),
				commits: recovery.commits?.filter(commit => !ids.has(commit.id)),
				removed: recovery.removed?.filter(id => !ids.has(id)),
			});
		}
	}

	private edit(change: (latest: SavedRoster) => SavedRoster, afterSave?: () => void): SavedRoster {
		const next = withFileLock(this.file, () => {
			const latest = readRoster(this.file) ?? EMPTY;
			const edited = change(latest);
			const json = JSON.stringify(edited);
			if (json !== JSON.stringify(latest)) {
				replaceFile(this.file, `${json}\n`);
			}
			afterSave?.();
			return edited;
		}, { keepLive: true });
		this.publish(next);
		return next;
	}

	private publish(next: SavedRoster): void {
		if (this.disposed || JSON.stringify(this.current) === JSON.stringify(next)) { return; }
		this.current = next;
		this.changed.fire();
	}

	private watchRoster(directory: string): Disposable {
		let failedRead = false;
		const refresh = () => {
			try {
				this.refresh();
				failedRead = false;
			} catch (error) {
				if (!failedRead) { this.log.event(`Could not read the Facade workspace: ${messageOf(error)}`); }
				failedRead = true;
			}
		};
		let close = () => {};
		const poll = (error: unknown) => {
			close();
			if (this.disposed) { return; }
			this.log.event(`Could not watch the Facade workspace: ${messageOf(error)}`);
			const timer = setInterval(refresh, ROSTER_POLL_MS);
			timer.unref();
			close = () => clearInterval(timer);
			refresh();
		};
		try {
			const watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
				if (name === null || name === ROSTER) { refresh(); }
			});
			close = () => watcher.close();
			watcher.once('error', poll);
		} catch (error) {
			poll(error);
		}
		return { dispose: () => close() };
	}

	private refresh(): void {
		if (!this.disposed) {
			this.publish(readRoster(this.file) ?? EMPTY);
		}
	}
}
