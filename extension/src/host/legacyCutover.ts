/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { codeOf, messageOf } from '../base/errors';
import { replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';
import { withLongFileLock } from '../base/lock';
import type { OwnerClaim } from '../base/ownership';
import { ptydRecords } from '../base/ptydRegistry';
import { isSameStart, processStartTimeAsync, processStartTimeOfAsync } from '../base/system';
import type { Pin } from '../core/ports';
import { EARLIER_PROTOCOLS, PTYD_PROTOCOL, type RunInfo } from '../ptyd/protocol';
import { isCurrentOwner, nextOwnerClaim } from '../record/ownership';
import { PtydClient, ptydSocketPath, within } from './execution/ptydClient';
import { isLegacyWorkspaceKey, legacyStateFile, readLegacyPins, type LegacyPinInput } from './legacyPins';
import { isPin } from './pins';

const PROTOCOLS = [...EARLIER_PROTOCOLS, PTYD_PROTOCOL];
const TERMINATE_GRACE_MS = 2_000;
/** Allow ptyd's hangup and kill confirmation phases to both finish. */
const STOP_WAIT_MS = 8_000;

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

interface ObservedRun {
	readonly socket: string;
	readonly run: string;
	readonly owner: string;
	readonly pid: number;
	readonly processStartedAt?: number;
	readonly protocol?: number;
	readonly approved: boolean;
	readonly stop?: 'requested' | 'confirmed';
}

interface CutoverRecord {
	readonly version: 1;
	readonly runs: readonly ObservedRun[];
	readonly snapshots: Readonly<Record<string, readonly Pin[]>>;
	readonly unrecognizedPins?: Readonly<Record<string, readonly unknown[]>>;
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
	readonly runs: readonly RunInfo[];
	readonly unavailable?: string;
}

/** Carries passive custody across a pending editor activation so the prior reload grace does not end its agents. */
export class LegacyCustody {
	private readonly held = new Map<string, PtydClient>();
	private generation: OwnerClaim | undefined;
	private disposed = false;

	constructor(private readonly home: string, readonly owner: string, private readonly local: boolean) {}

	client(socket: string): PtydClient | undefined { return this.held.get(socket); }

	async keep(socket: string, client: PtydClient): Promise<OwnerClaim | undefined> {
		if (this.disposed) { return undefined; }
		const held = this.client(socket) === client;
		if (held && this.generation && isCurrentOwner(this.generation, this.home)) { return this.generation; }
		if (held) {
			this.held.delete(socket);
			client.dispose();
			return undefined;
		}
		if (!this.generation || !isCurrentOwner(this.generation, this.home)) {
			this.generation = { ...nextOwnerClaim(this.owner, this.home), local: this.local };
		}
		const claim = this.generation;
		await within(client.request('claim', claim), STOP_WAIT_MS);
		if (this.disposed || client.isClosed || !isCurrentOwner(claim, this.home)) { return undefined; }
		this.held.set(socket, client);
		const release = () => {
			if (this.held.get(socket) === client) { this.held.delete(socket); }
		};
		client.onDidClose(release);
		client.onDidLoseOwner(owner => {
			if (owner === this.owner) {
				release();
				client.dispose();
			}
		});
		return claim;
	}

	dispose(): void {
		this.disposed = true;
		for (const client of this.held.values()) { client.dispose(); }
		this.held.clear();
	}
}

function journal(home: string): string { return path.join(home, 'legacy-cutover.json'); }

function readCutover(home: string): CutoverRecord {
	const file = journal(home);
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		if (codeOf(error) === 'ENOENT') { return { version: 1, runs: [], snapshots: {} }; }
		throw error;
	}
	if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.runs) || !value.runs.every(isObservedRun)
		|| !isJsonObject(value.snapshots) || !Object.entries(value.snapshots).every(([owner, pins]) =>
			isLegacyWorkspaceKey(owner) && Array.isArray(pins) && pins.every(isPin))
		|| value.unrecognizedPins !== undefined && (!isJsonObject(value.unrecognizedPins)
			|| !Object.entries(value.unrecognizedPins).every(([owner, pins]) => isLegacyWorkspaceKey(owner) && Array.isArray(pins)))) {
		throw new Error(`Invalid Facade legacy cutover record: ${file}`);
	}
	return value as unknown as CutoverRecord;
}

function isObservedRun(value: unknown): value is ObservedRun {
	return isJsonObject(value) && typeof value.socket === 'string' && isLegacyWorkspaceKey(value.owner)
		&& typeof value.run === 'string' && value.run.length > 0 && validPid(value.pid)
		&& (value.processStartedAt === undefined || typeof value.processStartedAt === 'number' && Number.isFinite(value.processStartedAt))
		&& (value.protocol === undefined || typeof value.protocol === 'number' && Number.isSafeInteger(value.protocol) && value.protocol > 0)
		&& typeof value.approved === 'boolean' && (value.stop === undefined || value.stop === 'requested' || value.stop === 'confirmed');
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
	const current = await processStartTimeOfAsync(pid, originalStart);
	if (current !== undefined && !isSameStart(current, originalStart)) { return true; }
	// The cache can still hold a matching start even when a new process has reused the PID.
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
	for (const name of files) {
		const file = path.join(directory, name);
		try {
			const endpoint = readEndpoint(file);
			found.set(endpoint.socket, endpoint);
		} catch (error) {
			// A supervisor can unpublish while we scan. Other unreadable records keep the gate closed.
			if (codeOf(error) !== 'ENOENT') { unavailable.push(`${file}: ${messageOf(error)}`); }
		}
	}
	for (const { socket, protocol } of previous) {
		if (!found.has(socket)) { found.set(socket, { socket, protocol: protocol ?? PTYD_PROTOCOL }); }
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
		&& typeof run.claimedElsewhere === 'boolean'
		&& (run.exited === undefined || isJsonObject(run.exited) && typeof run.exited.exitCode === 'number' && Number.isFinite(run.exited.exitCode)))) {
		throw new Error('Legacy ptyd returned an invalid run list.');
	}
	return runs;
}

async function open(endpoint: Endpoint, held?: PtydClient): Promise<Listing> {
	let client = held;
	try {
		client ??= await PtydClient.join(endpoint.socket, endpoint.protocol);
		if (!client) {
			if (endpoint.pid !== undefined && !await supervisorGone(endpoint.pid, endpoint.recordedAt)) {
				throw new Error('The recorded legacy supervisor process is still present.');
			}
			return { endpoint, runs: [] };
		}
		if (!PROTOCOLS.includes(endpoint.protocol) || endpoint.build !== undefined && endpoint.build !== client.build) {
			throw new Error('The legacy supervisor protocol or build could not be verified.');
		}
		return { endpoint, client, runs: await list(client) };
	} catch (error) {
		if (!held) { client?.dispose(); }
		return { endpoint, runs: [], unavailable: `${endpoint.socket}: ${messageOf(error)}` };
	}
}

function observed({ endpoint: { socket, protocol } }: Listing, { run, owner, pid }: RunInfo): ObservedRun {
	return { socket, protocol, run, owner, pid, approved: false };
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

/** The successful exit gate precedes all readers of these immutable copies. */
export function cutoverPins(home: string, owner: string): LegacyPinInput | undefined {
	return frozenPins(readCutover(home), owner);
}

function frozenPins(record: CutoverRecord, owner: string): LegacyPinInput | undefined {
	const pins = record.snapshots[owner];
	return pins === undefined ? undefined : { pins, unrecognized: record.unrecognizedPins?.[owner] ?? [] };
}

/** Recheck before accepting: this consent only covers the run identities and Pin state actually offered. */
export async function approveLegacyCutover(home: string, offered: CutoverPlan): Promise<boolean> {
	return withLongFileLock(journal(home), async () => {
		const before = readCutover(home);
		const offeredIds = new Set(offered.runs.map(runKey));
		const runs = before.runs.filter(run => offeredIds.has(runKey(run)) && !run.approved);
		if (!runs.length) { return false; }
		const sources = Object.entries(snapshotPins(home, before, runs));
		if (sources.some(([owner, input]) => JSON.stringify(input) !== JSON.stringify(offered.snapshots[owner]))) {
			return false;
		}
		save(home, before, {
			...before,
			snapshots: { ...before.snapshots, ...Object.fromEntries(sources.map(([owner, input]) => [owner, input.pins])) },
			unrecognizedPins: {
				...before.unrecognizedPins,
				...Object.fromEntries(sources.filter(([, input]) => input.unrecognized.length).map(([owner, input]) => [owner, input.unrecognized])),
			},
			runs: before.runs.map(run => offeredIds.has(runKey(run)) ? { ...run, approved: true } : run),
		});
		return true;
	}, STOP_WAIT_MS * 2);
}

function snapshotPins(home: string, record: CutoverRecord, runs: readonly ObservedRun[]): Record<string, LegacyPinInput> {
	const snapshots: Record<string, LegacyPinInput> = {};
	for (const owner of new Set(runs.map(run => run.owner))) {
		snapshots[owner] = frozenPins(record, owner) ?? readLegacyPins(legacyStateFile(home, owner)) ?? { pins: [], unrecognized: [] };
	}
	return snapshots;
}

/** Observes all legacy ptyds. The only mutating capability is a new fenced claim for this verified workspace. */
export async function checkLegacyCutover(home: string, custody?: LegacyCustody): Promise<CutoverState> {
	return withLongFileLock(journal(home), async () => {
		const before = readCutover(home);
		const owner = custody?.owner;
		const discovered = inventory(home, before.runs);
		const listings = await Promise.all(discovered.endpoints.map(endpoint => open(endpoint, custody?.client(endpoint.socket))));
		try {
			const unavailable = [...discovered.unavailable, ...listings.flatMap(entry => entry.unavailable ? [entry.unavailable] : [])];
			const live = new Map<string, ObservedRun>();
			const seen = new Set<string>();
			const previous = new Map(before.runs.map(run => [runKey(run), run]));
			const observedRuns = await Promise.all(listings.flatMap(listing => listing.runs.map(async row => {
				const run = observed(listing, row);
				const key = runKey(run);
				const old = previous.get(key);
				const active = row.exited ? undefined : {
					...run, pid: run.pid || old?.pid || 0, processStartedAt: await observedStart(row, old),
					approved: old?.approved ?? false, stop: old?.stop,
				};
				return { key, active };
			})));
			for (const { key, active } of observedRuns) {
				seen.add(key);
				if (active) { live.set(key, active); }
			}
			const verified = new Set(listings.filter(entry => !entry.unavailable).map(entry => entry.endpoint.socket));
			const disappeared = before.runs.filter(run => !seen.has(runKey(run)) && run.stop !== 'confirmed');
			const missing = (await Promise.all(disappeared.map(async run => {
				// With no CLI PID, only a fresh answer or proven supervisor absence resolves a missing row.
				const gone = run.pid === 0 ? verified.has(run.socket) : await processGone(run.pid, run.processStartedAt);
				return gone ? undefined : run;
			}))).filter((run): run is ObservedRun => run !== undefined);
			const pendingExits = missing.map(run => `${run.run} (${run.socket}, PID ${run.pid})`);
			let checked = { ...before, runs: [...live.values(), ...missing] };
			save(home, before, checked);

			const needsConsent = [...live.values()].filter(run => !run.approved);
			const plan = unavailable.length === 0 && needsConsent.length > 0
				? { runs: needsConsent, snapshots: snapshotPins(home, checked, needsConsent) } : undefined;
			const remaining = listings.flatMap(entry => entry.runs.filter(row => !row.exited));
			// The workspace generation fences disk writes across all ptyds. An active prior owner
			// keeps it even if another supervisor lists disconnected runs for the same workspace.
			const ownerStillConnected = remaining.some(row => row.owner === owner && row.claimedElsewhere);
			const waitingForOwner = remaining.filter(row => row.owner !== owner || ownerStillConnected).length;
			if (custody && !ownerStillConnected && !unavailable.length) {
				const scope = listings.flatMap(listing => {
					const runs = listing.runs.filter(row => !row.exited && row.owner === owner);
					return listing.client && runs.length ? [{ listing, client: listing.client, runs }] : [];
				});
				const confirmed = new Set<string>();
				const stopped = await Promise.all(scope.map(async ({ listing, client, runs }) => {
					const { socket } = listing.endpoint;
					if (!custody.client(socket)) {
						// Refresh custody close to taking the claim. Prior protocols have no conditional claim operation.
						const rows = await list(client).catch(() => undefined);
						if (!rows || rows.some(row => !row.exited && row.owner === owner && row.claimedElsewhere)) { return []; }
					}
					const claim = await custody.keep(socket, client).catch(() => undefined);
					if (!claim) { return []; }
					const unsent = runs.flatMap(row => {
						const run = live.get(runKey(observed(listing, row)));
						return run?.approved && !run.stop ? [run] : [];
					});
					return stopLegacyRuns(home, claim, listing, client, unsent, key => {
						const requested = { ...checked, runs: checked.runs.map(run =>
							runKey(run) === key ? { ...run, stop: 'requested' as const } : run) };
						save(home, checked, requested);
						checked = requested;
					});
				}));
				for (const key of stopped.flat()) { confirmed.add(key); }
				const next = { ...checked, runs: checked.runs.map(run =>
					confirmed.has(runKey(run)) ? { ...run, stop: 'confirmed' as const } : run) };
				save(home, checked, next);
				// Require a subsequent fresh inventory after a stop before allowing Framework activation.
				if (confirmed.size > 0) { return { ready: false, unavailable, waitingForOwner, pendingExits, unconfirmed: next.runs.length }; }
			}
			return {
				ready: !unavailable.length && checked.runs.length === 0,
				unavailable, waitingForOwner, pendingExits, unconfirmed: missing.length + [...live.values()].filter(run => run.approved).length,
				plan,
			};
		} finally {
			for (const entry of listings) {
				if (entry.client !== custody?.client(entry.endpoint.socket)) { entry.client?.dispose(); }
			}
		}
	}, STOP_WAIT_MS * 2);
}

async function stopLegacyRuns(home: string, claim: OwnerClaim, listing: Listing, client: PtydClient,
	runs: readonly ObservedRun[], requested: (key: string) => void): Promise<readonly string[]> {
	if (!runs.length) { return []; }
	const targets = new Map(runs.map(run => [runKey(run), run]));
	try {
		const current = await list(client);
		return (await Promise.all(current.filter(row => targets.has(runKey(observed(listing, row)))).map(async row => {
			const key = runKey(observed(listing, row));
			if (row.exited) { return key; }
			const prior = targets.get(key)!;
			if (row.claimedElsewhere || !isCurrentOwner(claim, home) || (prior.pid && prior.pid !== row.pid)) { return undefined; }
			// A lost reply leaves this exact run pending. Poll for exit without sending repeated signals.
			requested(key);
			const result = await within(client.request('terminate', { run: row.run, graceMs: TERMINATE_GRACE_MS }), STOP_WAIT_MS)
				.catch(() => undefined);
			// The older server also answers already_exited for an unknown ID. Accept it only with separate exit evidence.
			return result === 'terminated' || result === 'already_exited' && await processGone(row.pid, prior.processStartedAt) ? key : undefined;
		}))).filter((key): key is string => key !== undefined);
	} catch {
		// Ownership transfer, transport failure and timeouts all leave the run pending.
		return [];
	}
}
