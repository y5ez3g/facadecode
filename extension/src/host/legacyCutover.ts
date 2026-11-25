/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { codeOf, messageOf } from '../base/errors';
import { isSameFolder, realFolderOf, replaceFile } from '../base/files';
import type { AgentRef } from '../base/frameworkProtocol';
import { isJsonObject } from '../base/json';
import { withLongFileLock } from '../base/lock';
import type { OwnerClaim } from '../base/ownership';
import { ptydRecords } from '../base/ptydRegistry';
import { isSameStart, processStartTimeAsync, processStartTimeOfAsync } from '../base/system';
import type { Pin } from '../core/ports';
import { isCurrentOwner, writeAsOwner } from '../record/ownership';
import {
	EARLIER_PROTOCOLS, PTYD_PROTOCOL, PtydClient, ptydListenerLockedAt, ptydSocketPath, releasedPtydSockets, within, type RunInfo,
} from './migration/supervisor';
import {
	isLegacyWorkspaceKey, legacyStateFile, readLegacyPins, type LegacyPinInput, type LegacyPinMigration,
	type LegacyPinOutcome, type LegacyResumeAttempt, type LegacySessionPin, type SharedPinRecovery,
} from './legacyPins';
import { isPin } from './pins';

const PROTOCOLS = [...EARLIER_PROTOCOLS, PTYD_PROTOCOL];
const RELEASED_RUN_ID = /^run-[0-9a-f]{32}$/u;
const TERMINATE_GRACE_MS = 2_000;
const JOURNAL_WAIT_MS = 16_000;

interface Endpoint {
	readonly socket: string;
	readonly protocol: number;
	readonly pid?: number;
	readonly build?: string;
	readonly recordedAt?: number;
}

interface Inventory {
	readonly endpoints: readonly Endpoint[];
	readonly unavailable: readonly string[];
}

interface LegacyRunIdentity {
	readonly environment: string;
	readonly cli: string;
	readonly cwd: string;
	readonly builtIn?: string;
	readonly sessionId?: string;
	readonly pin?: string;
}

export interface LegacyCutoverScope {
	readonly owner: string;
	readonly retired?: OwnerClaim;
}

interface ObservedRun {
	readonly socket: string;
	readonly run: string;
	readonly owner: string;
	readonly pid: number;
	readonly processStartedAt?: number;
	readonly protocol?: number;
	readonly approved: boolean;
	readonly incarnation?: string;
	readonly startedAt?: number;
	readonly identity?: LegacyRunIdentity;
	readonly stop?: 'requested' | 'confirmed';
	readonly nativeStop?: true;
	readonly uncertain?: true;
}

interface CutoverRecord {
	readonly version: 1;
	readonly runs: readonly ObservedRun[];
	readonly snapshots: Readonly<Record<string, readonly Pin[]>>;
	readonly recoveries?: Readonly<Record<string, RecoveryRecord>>;
	readonly unrecognizedPins?: Readonly<Record<string, readonly unknown[]>>;
}

interface RecoveryRecord {
	readonly pending?: true;
	readonly attempt?: LegacyResumeAttempt;
	readonly reference?: AgentRef;
	readonly runs?: readonly string[];
}

export interface CutoverState {
	readonly ready: boolean;
	readonly unavailable: readonly string[];
	readonly unconfirmed: number;
	readonly pendingExits?: readonly string[];
	readonly waitingForOwner: number;
	readonly plan?: CutoverPlan;
}

export interface CutoverPlan {
	readonly runs: readonly ObservedRun[];
	readonly snapshots: Readonly<Record<string, LegacyPinInput>>;
}

interface Listing {
	readonly endpoint: Endpoint;
	readonly client?: PtydClient;
	readonly incarnation?: string;
	readonly publishedIncarnation?: string;
	readonly runs: readonly RunInfo[];
	readonly unavailable?: string;
}

function journal(home: string): string { return path.join(home, 'legacy-cutover.json'); }

class InvalidCutoverRecord extends Error {}
class LegacyPinHeld extends Error {}

function readCutover(home: string): CutoverRecord {
	const file = journal(home);
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		if (codeOf(error) === 'ENOENT') { return { version: 1, runs: [], snapshots: {} }; }
		if (error instanceof SyntaxError) { throw new InvalidCutoverRecord(file, { cause: error }); }
		throw error;
	}
	if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.runs) || !value.runs.every(isObservedRun)
		|| new Set(value.runs.map(runKey)).size !== value.runs.length
		|| value.recoveries !== undefined && (!isJsonObject(value.recoveries) || !Object.values(value.recoveries).every(isRecoveryRecord))
		|| !isJsonObject(value.snapshots) || !Object.entries(value.snapshots).every(([owner, pins]) =>
			isLegacyWorkspaceKey(owner) && Array.isArray(pins) && pins.every(isPin))
		|| value.unrecognizedPins !== undefined && (!isJsonObject(value.unrecognizedPins)
			|| !Object.entries(value.unrecognizedPins).every(([owner, pins]) => isLegacyWorkspaceKey(owner) && Array.isArray(pins)))) {
		throw new InvalidCutoverRecord(`Invalid Facade legacy cutover record: ${file}`);
	}
	return value as unknown as CutoverRecord;
}

function isObservedRun(value: unknown): value is ObservedRun {
	return isJsonObject(value) && typeof value.socket === 'string' && isLegacyWorkspaceKey(value.owner)
		&& typeof value.run === 'string' && value.run.length > 0 && validPid(value.pid)
		&& (value.processStartedAt === undefined || typeof value.processStartedAt === 'number' && Number.isFinite(value.processStartedAt))
		&& (value.protocol === undefined || typeof value.protocol === 'number' && Number.isSafeInteger(value.protocol) && value.protocol > 0)
		&& (value.incarnation === undefined || nonempty(value.incarnation))
		&& (value.startedAt === undefined || typeof value.startedAt === 'number' && Number.isFinite(value.startedAt))
		&& (value.identity === undefined || isLegacyRunIdentity(value.identity))
		&& typeof value.approved === 'boolean' && (value.stop === undefined || value.stop === 'requested' || value.stop === 'confirmed')
		&& (value.nativeStop === undefined || value.nativeStop === true && value.approved && value.stop !== undefined)
		&& (value.uncertain === undefined || value.uncertain === true);
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
	return isJsonObject(value) && (value.pending === undefined || value.pending === true)
		&& (value.reference === undefined || isAgentRef(value.reference))
		&& (value.attempt === undefined || value.pending === true && isJsonObject(value.attempt)
			&& isAgentRef(value.attempt.reference) && typeof value.attempt.startedAt === 'string'
			&& Number.isFinite(Date.parse(value.attempt.startedAt)) && typeof value.attempt.requestedAt === 'number'
			&& Number.isSafeInteger(value.attempt.requestedAt))
		&& (value.runs === undefined || Array.isArray(value.runs) && value.runs.every(nonempty));
}

function isAgentRef(value: unknown): value is AgentRef {
	return isJsonObject(value) && nonempty(value.machine_id) && nonempty(value.agent_id);
}

function nonempty(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function isLegacyRunIdentity(value: unknown): value is LegacyRunIdentity {
	return isJsonObject(value) && nonempty(value.environment) && nonempty(value.cli) && nonempty(value.cwd)
		&& [value.builtIn, value.sessionId, value.pin].every(field => field === undefined || nonempty(field));
}

function validPid(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** An absent PID or a different process using it is positive evidence. */
async function processGone(pid: number, originalStart?: number): Promise<boolean> {
	if (pid <= 0) { return false; }
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (codeOf(error) === 'ESRCH') { return true; }
	}
	if (originalStart === undefined) { return false; }
	const fresh = await processStartTimeAsync(pid, true);
	return fresh !== undefined && !isSameStart(fresh, originalStart);
}

function runKey(run: Pick<ObservedRun, 'socket' | 'owner' | 'run'>): string {
	// Run IDs are unique within the supervisor. Its startedAt moves until a queued run has a process.
	return JSON.stringify([run.socket, run.owner, run.run]);
}

function inventory(home: string, previous: readonly ObservedRun[]): Inventory {
	const directory = ptydRecords(path.join(home, 'ptyd'));
	let files: string[] = [];
	const unavailable: string[] = [];
	try {
		files = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') { unavailable.push(`${directory}: ${messageOf(error)}`); }
	}
	const found = new Map<string, Endpoint>(PROTOCOLS.map(protocol => {
		const socket = ptydSocketPath(home, protocol);
		return [socket, { socket, protocol }] as const;
	}));
	try {
		for (const endpoint of releasedPtydSockets(home)) {
			found.set(endpoint.socket, { ...endpoint, protocol: PTYD_PROTOCOL });
		}
	} catch (error) {
		unavailable.push(messageOf(error));
	}
	for (const name of files) {
		const file = path.join(directory, name);
		try {
			const endpoint = readEndpoint(file);
			if (endpoint.socket !== ptydSocketPath(home, endpoint.protocol, endpoint.build)
				&& endpoint.socket !== ptydSocketPath(home, endpoint.protocol)) {
				throw new Error('The legacy supervisor registry names an endpoint outside this Facade home.');
			}
			found.set(endpoint.socket, endpoint);
		} catch (error) {
			// A supervisor can unpublish while we scan. The remaining failures make saved-session evidence incomplete.
			if (codeOf(error) !== 'ENOENT') { unavailable.push(`${file}: ${messageOf(error)}`); }
		}
	}
	for (const { socket, protocol } of previous) {
		if (found.has(socket)) { continue; }
		const speaks = protocol ?? PTYD_PROTOCOL;
		const build = /extension-ptyd-\d+-([0-9a-f]{10})-[0-9a-f]{12}(?:\.sock)?$/u.exec(socket)?.[1];
		if (build && socket === ptydSocketPath(home, speaks, build)) {
			found.set(socket, { socket, protocol: speaks, build });
		}
	}
	return { endpoints: [...found.values()], unavailable };
}

function readEndpoint(file: string): Endpoint {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) { throw new Error('Legacy supervisor record is not a file.'); }
		const value: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
		if (!isJsonObject(value) || typeof value.protocol !== 'number' || !Number.isSafeInteger(value.protocol) || value.protocol <= 0
			|| typeof value.build !== 'string' || !/^[0-9a-f]{1,64}$/.test(value.build) || !validPid(value.pid) || value.pid === 0
			|| typeof value.socket !== 'string' || !value.socket || !Number.isFinite(stat.mtimeMs)) {
			throw new Error('Invalid legacy supervisor record.');
		}
		return { socket: value.socket, protocol: value.protocol, build: value.build, pid: value.pid, recordedAt: stat.mtimeMs };
	} finally {
		fs.closeSync(fd);
	}
}

/** The legacy supervisor writes its record after it starts listening. */
async function supervisorGone(pid: number, recordedAt: number | undefined): Promise<boolean> {
	if (await processGone(pid)) { return true; }
	if (recordedAt === undefined) { return false; }
	const current = await processStartTimeAsync(pid, true);
	return current !== undefined && current > recordedAt && !isSameStart(current, recordedAt);
}

async function list(client: PtydClient): Promise<readonly RunInfo[]> {
	// The unfiltered protocol method includes runs hidden by Stop while their exit is still uncertain.
	const runs: unknown = await within(client.request('list', {}));
	if (!Array.isArray(runs) || !runs.every(run => isJsonObject(run) && typeof run.run === 'string' && run.run.length > 0
		&& isLegacyWorkspaceKey(run.owner) && validPid(run.pid)
		&& typeof run.claimedElsewhere === 'boolean' && nonempty(run.cwd) && Number.isFinite(run.startedAt)
		&& isJsonObject(run.meta)
		&& (run.uncertain === undefined || run.uncertain === true)
		&& (run.exited === undefined || isJsonObject(run.exited) && typeof run.exited.exitCode === 'number' && Number.isFinite(run.exited.exitCode)))
		|| new Set(runs.map(run => run.run)).size !== runs.length) {
		throw new Error('Legacy ptyd returned an invalid run list.');
	}
	return runs;
}

async function open(endpoint: Endpoint): Promise<Listing> {
	let client: PtydClient | undefined;
	try {
		client = await PtydClient.join(endpoint.socket, endpoint.protocol);
		if (!client) {
			if (endpoint.pid !== undefined && !await supervisorGone(endpoint.pid, endpoint.recordedAt)) {
				throw new Error('The recorded legacy supervisor process is still present.');
			}
			return { endpoint, runs: [] };
		}
		if (!PROTOCOLS.includes(endpoint.protocol) || endpoint.build !== undefined && endpoint.build !== client.build) {
			throw new Error('The legacy supervisor protocol or build could not be verified.');
		}
		const { socket, pid, build, recordedAt } = endpoint;
		const released = build !== undefined && endpoint.protocol === PTYD_PROTOCOL;
		const lockedAt = released && client.pid !== undefined ? await verifiedListenerLock(socket, client.pid).catch(() => undefined) : undefined;
		const listenerIncarnation = lockedAt === undefined ? undefined : JSON.stringify([client.pid, build, lockedAt, 'listener']);
		// The released supervisor creates the lock first. A registry row older than the viable lock names a prior listener.
		const publishedIncarnation = pid !== undefined && pid === client.pid && build && recordedAt !== undefined
			&& (lockedAt === undefined || lockedAt <= recordedAt) ? JSON.stringify([pid, build, recordedAt]) : undefined;
		if ((released || pid !== undefined) && !listenerIncarnation && !publishedIncarnation) {
			throw new Error('The legacy supervisor has no verified listener lock or registry record.');
		}
		return { endpoint, client, incarnation: listenerIncarnation ?? publishedIncarnation, publishedIncarnation, runs: await list(client) };
	} catch (error) {
		client?.dispose();
		return { endpoint, runs: [], unavailable: `${endpoint.socket}: ${messageOf(error)}` };
	}
}

async function verifiedListenerLock(socket: string, pid: number): Promise<number | undefined> {
	const lockedAt = ptydListenerLockedAt(socket, pid);
	if (lockedAt === undefined) { return; }
	const start = await processStartTimeAsync(pid, true);
	return start !== undefined && (start <= lockedAt || isSameStart(start, lockedAt)) ? lockedAt : undefined;
}

function observed({ endpoint, incarnation }: Listing, { run, owner, pid, startedAt, cwd, meta, uncertain }: RunInfo): ObservedRun {
	const { socket, protocol } = endpoint;
	const { environment, cli, builtIn, pin, sessionId } = meta;
	const identity = { environment, cli, cwd: nonempty(meta.cwd) ? meta.cwd : cwd, builtIn, pin, sessionId };
	return { socket, protocol, run, owner, pid, startedAt: pid > 0 ? startedAt : undefined, incarnation, approved: false,
		identity: isLegacyRunIdentity(identity) ? identity : undefined, uncertain: uncertain ? true : undefined };
}

function sameSupervisor(old: ObservedRun, listing: Listing): boolean {
	return old.socket === listing.endpoint.socket && old.protocol === listing.endpoint.protocol
		&& old.incarnation !== undefined && (old.incarnation === listing.incarnation || old.incarnation === listing.publishedIncarnation);
}

function sameRun(old: ObservedRun, listing: Listing, current: RunInfo): boolean {
	return old.socket === listing.endpoint.socket && old.owner === current.owner && old.run === current.run
		&& (old.protocol === undefined || old.protocol === listing.endpoint.protocol)
		&& (old.incarnation === undefined || sameSupervisor(old, listing))
		&& (!old.pid || old.pid === current.pid)
		&& (!old.pid || old.startedAt === undefined || old.startedAt === current.startedAt);
}

async function observedStart(row: RunInfo, previous: ObservedRun | undefined): Promise<number | undefined> {
	if (previous?.processStartedAt !== undefined && (!row.pid || previous.pid === row.pid)) {
		return previous.processStartedAt;
	}
	if (row.pid <= 0 || !Number.isFinite(row.startedAt)) { return undefined; }
	// Compare the OS reading with the supervisor's start stamp before trusting the PID.
	const start = await processStartTimeOfAsync(row.pid, row.startedAt);
	return start !== undefined && isSameStart(start, row.startedAt) ? start : undefined;
}

function save(home: string, previous: CutoverRecord, next: CutoverRecord): void {
	if (JSON.stringify(previous) !== JSON.stringify(next)) {
		replaceFile(journal(home), `${JSON.stringify(next)}\n`);
	}
}

function frozenPins(record: CutoverRecord, owner: string): LegacyPinInput | undefined {
	const pins = record.snapshots[owner];
	return pins === undefined ? undefined : { pins, unrecognized: record.unrecognizedPins?.[owner] ?? [] };
}

function planFor(home: string, record: CutoverRecord, owner: string, runs: readonly ObservedRun[]): CutoverPlan {
	const snapshots = { [owner]: frozenPins(record, owner) ?? readLegacyPins(legacyStateFile(home, owner)) ?? {
		pins: [], unrecognized: [],
	} };
	return { runs, snapshots };
}

export function cutoverPlanIdentity(plan: CutoverPlan): string {
	return JSON.stringify([plan.runs.map(({ socket, owner, run, pid, startedAt, incarnation }) =>
		[socket, owner, run, pid, startedAt, incarnation]), plan.snapshots]);
}

interface Scan {
	readonly listings: readonly Listing[];
	readonly unavailable: readonly string[];
}

async function scan(home: string, before: CutoverRecord): Promise<Scan> {
	const discovered = inventory(home, before.runs.filter(run => run.stop !== 'confirmed'));
	return { listings: await Promise.all(discovered.endpoints.map(endpoint => open(endpoint))), unavailable: discovered.unavailable };
}

function close(scan: Scan): void {
	for (const { client } of scan.listings) { client?.dispose(); }
}

/** Keep old rows and fences even when an endpoint goes away. Only exact evidence advances a row. */
async function reconcile(before: CutoverRecord, scan: Scan, relevant: (row: ObservedRun) => boolean): Promise<CutoverRecord> {
	const runs = new Map(before.runs.map(row => [runKey(row), row]));
	const rows = scan.listings.flatMap(listing => listing.runs.map(row => ({ listing, row, current: observed(listing, row) })));
	const keys = new Set<string>();
	for (const { listing, row, current } of rows) {
		const key = runKey(current);
		const previous = runs.get(key);
		if (!relevant(current) && !(previous && relevant(previous))) { continue; }
		keys.add(key);
		if (previous && (!sameRun(previous, listing, row) || previous.stop === 'confirmed')) { continue; }
		runs.set(key, {
			...previous,
			...current,
			incarnation: previous?.incarnation ?? current.incarnation,
			approved: previous?.approved ?? false,
			identity: current.identity ?? previous?.identity,
			processStartedAt: await observedStart(row, previous),
			stop: row.exited ? 'confirmed' : previous?.stop,
		});
	}
	for (const [key, row] of runs) {
		if (!relevant(row) || keys.has(key) || row.stop === 'confirmed') { continue; }
		// Protocol 17's complete list retains uncertain exits and removes failed queued spawns.
		const queueCleared = row.pid === 0 && !row.uncertain && !row.stop && row.protocol === PTYD_PROTOCOL
			&& scan.listings.some(listing => listing.client && sameSupervisor(row, listing));
		if (queueCleared || await processGone(row.pid, row.processStartedAt)) {
			runs.set(key, { ...row, stop: 'confirmed' });
		}
	}
	return { ...before, runs: [...runs.values()] };
}

function isActiveRun(scan: Scan, run: ObservedRun): boolean {
	return scan.listings.some(listing => listing.runs.some(row => !row.exited && sameRun(run, listing, row)));
}

function consentPlan(home: string, before: CutoverRecord, scan: Scan, owner: string): CutoverPlan | undefined {
	// A still-active older window can start more work after consent. The approved snapshot and run set remain fixed.
	if (frozenPins(before, owner)) { return undefined; }
	const runs = before.runs.filter(run => run.owner === owner && !run.approved && run.stop !== 'confirmed'
		&& isActiveRun(scan, run));
	return runs.length ? planFor(home, before, owner, runs) : undefined;
}

/** Revalidate the identities and immutable Pin input the person was actually shown. */
export async function approveLegacyCutover(home: string, scope: LegacyCutoverScope, offered: CutoverPlan): Promise<boolean> {
	return withLongFileLock(journal(home), async () => {
		const before = readCutover(home);
		const observed = await scan(home, before);
		try {
			const checked = await reconcile(before, observed, row => row.owner === scope.owner);
			const latest = consentPlan(home, checked, observed, scope.owner);
			if (!latest || cutoverPlanIdentity(latest) !== cutoverPlanIdentity(offered)) { return false; }
			const source = latest.snapshots[scope.owner];
			const approved = new Set(latest.runs.map(runKey));
			save(home, before, {
				...checked,
				snapshots: { ...checked.snapshots, [scope.owner]: source.pins },
				unrecognizedPins: { ...checked.unrecognizedPins, [scope.owner]: source.unrecognized },
				runs: checked.runs.map(run => approved.has(runKey(run)) ? { ...run, approved: true } : run),
			});
			return true;
		} finally {
			close(observed);
		}
	}, JOURNAL_WAIT_MS);
}

const READY: CutoverState = { ready: true, unavailable: [], waitingForOwner: 0, unconfirmed: 0 };

function currentRetirement(home: string, scope: LegacyCutoverScope): OwnerClaim | undefined {
	const retired = scope.retired;
	return retired?.owner === scope.owner && retired.local !== false && isCurrentOwner(retired, home) ? retired : undefined;
}

function otherCustody(row: RunInfo): boolean {
	return row.claimedElsewhere || row.meta.environment !== 'local';
}

function stopStatus(record: CutoverRecord, fresh: Scan, scope: LegacyCutoverScope, duplicate: ReadonlySet<string>, home: string): CutoverState {
	const retired = currentRetirement(home, scope);
	const pending = record.runs.filter(run => {
		if (run.owner !== scope.owner || run.stop === 'confirmed') { return false; }
		// Dispatch is durable even when this native window's handoff is no longer available.
		if (run.nativeStop && run.stop === 'requested') { return true; }
		if (!retired || !run.approved || run.stop || !run.incarnation || run.protocol !== PTYD_PROTOCOL
			|| run.identity?.environment !== 'local' || duplicate.has(run.run) || !RELEASED_RUN_ID.test(run.run)) { return false; }
		const listing = fresh.listings.find(each => each.endpoint.socket === run.socket);
		// If another live window holds this owner at the exact listener, leave custody there.
		return !listing?.runs.some(row => row.owner === scope.owner && !row.exited && otherCustody(row));
	});
	if (!pending.length) { return READY; }
	const unavailable = fresh.listings.flatMap(listing => listing.unavailable
		&& pending.some(run => run.socket === listing.endpoint.socket) ? [listing.unavailable] : []);
	const pendingExits = pending.filter(run => !isActiveRun(fresh, run))
		.map(run => `${run.run} (${run.socket}, PID ${run.pid})`);
	return { ready: false, unavailable, unconfirmed: pending.length, pendingExits, waitingForOwner: 0 };
}

/** ARCHITECTURE-1.4. Inventory elsewhere can qualify a Pin, but cannot keep this window out of Framework. */
export async function checkLegacyCutover(home: string, scope?: LegacyCutoverScope): Promise<CutoverState> {
	if (!scope) { return READY; }
	return withLongFileLock(journal(home), async () => {
		const before = readCutover(home);
		const fresh = await scan(home, before);
		try {
			let checked = await reconcile(before, fresh, row => row.owner === scope.owner);
			save(home, before, checked);
			const plan = consentPlan(home, checked, fresh, scope.owner);
			if (plan) { return { ...READY, ready: false, plan }; }

			const seen = new Set<string>();
			const duplicate = new Set<string>();
			for (const listing of fresh.listings) {
				for (const { owner, run } of listing.runs) {
					if (owner !== scope.owner) { continue; }
					if (seen.has(run)) { duplicate.add(run); }
					seen.add(run);
				}
			}
			await Promise.all(fresh.listings.map(listing =>
				stopApproved(home, scope, listing, duplicate, () => checked.runs, (run, stop) => {
					const next = { ...checked, runs: checked.runs.map(each =>
						runKey(each) === runKey(run) ? { ...each, nativeStop: true as const, stop } : each) };
					save(home, checked, next);
					checked = next;
				})));
			return stopStatus(checked, fresh, scope, duplicate, home);
		} finally {
			close(fresh);
		}
	}, JOURNAL_WAIT_MS).catch(error => {
		if (error instanceof InvalidCutoverRecord) { return READY; }
		throw error;
	});
}

async function stopApproved(home: string, scope: LegacyCutoverScope, listing: Listing, duplicate: ReadonlySet<string>,
	progress: () => readonly ObservedRun[], advance: (run: ObservedRun, stop: 'requested' | 'confirmed') => void): Promise<void> {
	const { client, endpoint } = listing;
	const retired = currentRetirement(home, scope);
	if (!client || !retired || endpoint.protocol !== PTYD_PROTOCOL) { return; }
	const retiredOwnerRows = (rows: readonly RunInfo[]) => rows.filter(row => row.owner === scope.owner && !row.exited);
	const targets = (rows: readonly RunInfo[]) => progress().filter(run => run.owner === scope.owner && run.incarnation
		&& run.approved && !run.stop && run.pid > 0 && run.processStartedAt !== undefined
		&& !duplicate.has(run.run) && RELEASED_RUN_ID.test(run.run)
		&& rows.some(row => !row.uncertain && sameRun(run, listing, row)));
	const rows = retiredOwnerRows(listing.runs);
	if (rows.some(otherCustody) || !targets(rows).length) { return; }
	const requests: Promise<void>[] = [];
	let lost = false;
	client.onDidLoseOwner(owner => { if (owner === scope.owner) { lost = true; } });
	try {
		const beforeClaim = retiredOwnerRows(await list(client));
		if (beforeClaim.some(otherCustody) || !targets(beforeClaim).length) { return; }
		// The released host can close every terminal view before recording retirement. Its claim still
		// identifies the local owner, while the supervisor supplies the exact run and process identities.
		let claim: Promise<void> | undefined;
		writeAsOwner(retired, home, () => { claim = client.request('claim', { ...retired, local: true }); });
		if (!claim) { return; }
		await claim;
		const beforeStop = retiredOwnerRows(await list(client));
		if (beforeStop.some(otherCustody)) { return; }
		for (const run of targets(beforeStop)) {
			if (lost || client.isClosed) { break; }
			const sent = writeAsOwner(retired, home, () => {
				advance(run, 'requested');
				const answer = client.request('terminate', { run: run.run, graceMs: TERMINATE_GRACE_MS });
				requests.push(answer.then(result => {
					// A bare already_exited also means an unknown ID. The next inventory or the original PID can prove exit.
					if (result === 'terminated') { advance(run, 'confirmed'); }
				}));
			});
			if (!sent) { break; }
		}
	} catch {
		// An unavailable endpoint or an ownership transfer cannot authorize retrying a dispatched stop.
	} finally {
		await Promise.allSettled(requests);
	}
}

function normalizedFolder(folder: string): string {
	const real = realFolderOf(folder);
	return process.platform === 'linux' ? real : real.toLowerCase();
}

function sameConversation(pin: LegacySessionPin, identity: LegacyRunIdentity): boolean {
	const { sessionId, cli, environment, builtIn } = pin.conversation;
	return !!sessionId && identity.environment === environment && identity.sessionId === sessionId
		&& (identity.cli === cli || (identity.builtIn ?? identity.cli) === (builtIn ?? cli));
}

/** A session holder in any cwd fences this Pin. A sessionless Pin needs its own scope or its exact Pin ID. */
function affectsPin(pin: LegacySessionPin, owner: string, row: ObservedRun): boolean {
	const identity = row.identity;
	if (!identity) { return row.owner === owner || !!pin.conversation.sessionId; }
	return pin.id === identity.pin && identity.environment === pin.conversation.environment
		|| sameConversation(pin, identity)
		|| !pin.conversation.sessionId && row.owner === owner && identity.cli === pin.conversation.cli
			&& identity.environment === pin.conversation.environment && isSameFolder(identity.cwd, pin.cwd);
}

function exactPinRun(pin: LegacySessionPin, row: ObservedRun): boolean {
	const identity = row.identity;
	return !!row.incarnation && !!identity && identity.environment === pin.conversation.environment
		&& identity.cli === pin.conversation.cli && isSameFolder(identity.cwd, pin.cwd)
		&& (identity.builtIn ?? identity.cli) === (pin.conversation.builtIn ?? pin.conversation.cli)
		&& (pin.conversation.sessionId ? sameConversation(pin, identity) : identity.pin === pin.id);
}

function recoveryKey(pin: LegacySessionPin, owner: string, row: ObservedRun | undefined): string {
	const { environment, cli, builtIn, sessionId } = pin.conversation;
	return JSON.stringify(sessionId ? [environment, cli, builtIn ?? cli, normalizedFolder(pin.cwd), sessionId]
		: row ? [row.incarnation, runKey(row)] : [owner, pin.id, environment, cli, builtIn ?? cli, normalizedFolder(pin.cwd)]);
}

function sameReference(expected: AgentRef, actual: AgentRef | undefined): actual is AgentRef {
	return actual !== undefined && expected.agent_id === actual.agent_id && expected.machine_id === actual.machine_id;
}

/** Shared conversion progress remains in the adapter after a workspace consumes its own Pin. */
export function legacyPinMigration(home: string, owner: string): LegacyPinMigration {
	const file = journal(home);
	return {
		snapshot: () => frozenPins(readCutover(home), owner),
		async recover(pin, previousAttempt, perform, reconcileAttempt, reconcilePrevious): Promise<LegacyPinOutcome> {
			const select = (record: CutoverRecord): {
				readonly key: string;
				readonly runs: readonly string[];
				readonly reference?: AgentRef;
				readonly previous?: ReturnType<typeof previousAttempt>;
			} | undefined => {
				const exact = record.runs.filter(row => exactPinRun(pin, row));
				if (!pin.conversation.sessionId && exact.length > 1) { return; }
				const key = recoveryKey(pin, owner, exact[0]);
				const runs = exact.map(run => JSON.stringify([run.incarnation, runKey(run)]));
				return { key, runs, reference: record.recoveries?.[key]?.reference };
			};
			const readHistorical = () => {
				const existing = select(readCutover(home));
				if (!existing || existing.reference) { return existing; }
				const previous = previousAttempt();
				return previous.attempted ? { ...existing, previous } : undefined;
			};
			const observe = async () => withLongFileLock(file, async () => {
				const before = readCutover(home);
				const existing = select(before);
				// The workspace inspects an already confirmed reference before adoption. No legacy effect is needed.
				if (existing?.reference) { return existing; }
				const fresh = await scan(home, before);
				try {
					const relevant = (row: ObservedRun) => affectsPin(pin, owner, row);
					const checked = await reconcile(before, fresh, relevant);
					save(home, before, checked);
					const current = select(checked);
					if (current?.reference) { return current; }
					const live = fresh.listings.some(listing => listing.runs.some(row =>
						!row.exited && relevant(observed(listing, row))));
					const pending = checked.runs.some(row => row.stop !== 'confirmed' && relevant(row));
					if (live || pending || fresh.unavailable.length || fresh.listings.some(row => row.unavailable)) { return; }
					return current;
				} finally {
					close(fresh);
				}
			}, JOURNAL_WAIT_MS);
			const selection = readHistorical() ?? await observe();
			if (!selection) { return { kind: 'deferred' }; }
			if (selection.reference) { return { kind: 'confirmed', reference: selection.reference }; }
			const lockKey = createHash('sha256').update(selection.key).digest('hex');
			return withLongFileLock(path.join(home, 'claims', `legacy-pin-${lockKey}`), async () => {
				const current = readHistorical() ?? await observe();
				if (!current || current.key !== selection.key) { return { kind: 'deferred' }; }
				if (current.reference) { return { kind: 'confirmed', reference: current.reference }; }
				const { key, runs } = current;
				const update = (edit: (before: RecoveryRecord) => RecoveryRecord) => withLongFileLock(file, async () => {
					const record = readCutover(home);
					const existing = record.recoveries?.[key] ?? {};
					const next = edit(existing);
					save(home, record, { ...record, recoveries: { ...record.recoveries, [key]: next } });
					return next;
				}, JOURNAL_WAIT_MS);
				const commit = async (reference: AgentRef): Promise<LegacyPinOutcome> => {
					await update(before => ({ reference, runs: [...new Set([...before.runs ?? [], ...runs])] }));
					return { kind: 'confirmed', reference };
				};
				const known = readCutover(home).recoveries?.[key];
				if (known?.reference) { return { kind: 'confirmed', reference: known.reference }; }
				const previous = current.previous ?? previousAttempt();
				if (previous.attempted && !known?.pending) {
					await update(before => ({ ...before, pending: true }));
				}
				const historical = previous.attempted ? previous.reference : undefined;
				if (historical && reconcilePrevious && (!known?.attempt || sameReference(known.attempt.reference, historical))) {
					const inspected = await reconcilePrevious(historical);
					if (sameReference(historical, inspected)) { return commit(inspected); }
					return { kind: 'deferred' };
				}
				if (known?.pending && known.attempt && reconcileAttempt) {
					const reference = await reconcileAttempt(known.attempt);
					if (sameReference(known.attempt.reference, reference)) { return commit(reference); }
					return { kind: 'deferred' };
				}
				if (known?.pending || previous.attempted) {
					return { kind: 'unconfirmed' };
				}
				const reservation: SharedPinRecovery = {
					async begin(target) {
						const latest = await observe();
						if (latest?.key !== key || latest.reference) { throw new LegacyPinHeld(); }
						await update(() => ({
							pending: true, runs: latest.runs,
							attempt: target && Number.isFinite(Date.parse(target.startedAt))
								? { ...target, requestedAt: Date.now() } : undefined,
						}));
					},
					async refused() { await update(() => ({ runs })); },
				};
				try {
					return await commit(await perform(reservation));
				} catch (error) {
					if (error instanceof LegacyPinHeld) { return { kind: 'deferred' }; }
					throw error;
				}
			}, JOURNAL_WAIT_MS);
		},
	};
}
