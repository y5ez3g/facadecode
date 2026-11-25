/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { AgentInfo } from '../base/frameworkProtocol';
import { processStartTimeAsync } from '../base/system';
import type { FrameworkPin } from '../core/ports';
import { approveLegacyCutover, checkLegacyCutover, legacyPinMigration } from '../host/legacyCutover';
import type { LegacySessionPin } from '../host/legacyPins';
import { PTYD_PROTOCOL, ptydSocketPath } from '../host/migration/supervisor';
import { beginWindowTerminals, retireWindowTerminals } from '../record/windowTerminals';
import { TestEmitter, withModules } from './withModules';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const RUN_A = 'run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_B = 'run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REFERENCE = { machine_id: 'machine', agent_id: 'a7' };
const CLAIM = { owner: A, generation: 1, token: 'retired' };

function pin(id: string, sessionId = 'shared'): LegacySessionPin {
	return { id, cwd: '/work/a', location: '/work/a', name: 'Fixture', conversation: { cli: 'codex', environment: 'local', sessionId } };
}

async function fixture(published = true) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cutover-'));
	const registry = path.join(home, 'ptyd', 'sockets');
	const journal = path.join(home, 'legacy-cutover.json');
	const claimFile = path.join(home, 'claims', `${createHash('sha256').update(A).digest('hex')}.json`);
	const pid = process.pid;
	const startedAt = await processStartTimeAsync(pid, true) ?? Date.now();
	const build = 'abcd123456';
	const socketFile = ptydSocketPath(home, PTYD_PROTOCOL, build);
	const registryFile = path.join(registry, 'current.json');
	const lockFile = process.platform === 'win32' ? path.join(os.tmpdir(), `${path.win32.basename(socketFile)}.lock`) : `${socketFile}.lock`;
	fs.chmodSync(home, 0o700);
	fs.mkdirSync(path.dirname(claimFile));
	fs.writeFileSync(claimFile, JSON.stringify(CLAIM));
	if (process.platform !== 'win32') { fs.mkdirSync(path.dirname(socketFile), { recursive: true, mode: 0o700 }); }
	if (published) {
		fs.mkdirSync(registry, { recursive: true });
		fs.writeFileSync(registryFile, JSON.stringify({ protocol: PTYD_PROTOCOL, build, socket: socketFile, pid }));
	} else {
		fs.writeFileSync(lockFile, String(pid), { flag: 'wx', mode: 0o600 });
	}
	const rows = [
		{ owner: A, run: RUN_A, session: 'scope-a', cwd: '/work/a', pin: 'pin-a', attached: false },
		{ owner: B, run: RUN_B, session: 'shared', cwd: '/work/b', pin: 'pin-b', attached: true },
	].map(row => ({ ...row, pid, uncertain: false, ended: false }));
	const effects: { method: string; params: unknown; journal: unknown }[] = [];
	const sockets = new Set<net.Socket>();
	let termination: 'terminated' | 'already_exited' = 'terminated';
	let claimAction: (() => void) | undefined;
	let refuseClaim = false;
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.setEncoding('utf8');
		let pending = '';
		socket.on('data', (data: string) => {
			const lines = (pending + data).split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				const { id, method, params } = JSON.parse(line);
				let result: unknown;
				if (method === 'hello') {
					result = { protocol: 17, pid, build };
				} else if (method === 'list') {
					result = rows.map(row => ({
						owner: row.owner, run: row.run, pid: row.pid, cwd: row.cwd, startedAt,
						claimedElsewhere: row.attached, ...(row.ended ? { exited: { exitCode: 0 } } : {}),
						...(row.uncertain ? { uncertain: true } : {}),
						meta: { environment: 'local', cli: 'codex', builtIn: 'codex', sessionId: row.session, pin: row.pin },
					}));
				} else if (method === 'claim' || method === 'terminate') {
					effects.push({ method, params, journal: JSON.parse(fs.readFileSync(journal, 'utf8')) });
					if (method === 'claim') {
						claimAction?.();
						if (refuseClaim) { socket.write(JSON.stringify({ id, error: 'Interrupted before dispatch' }) + '\n'); continue; }
					}
					if (method === 'terminate') {
						const run = rows.find(row => row.run === params.run);
						if (run && termination === 'terminated') { run.ended = true; }
						result = termination;
					}
				} else {
					assert.fail(`Unexpected legacy request ${method}`);
				}
				socket.write(JSON.stringify({ id, result }) + '\n');
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketFile, resolve); });
	return {
		home, journal, claimFile, registry, registryFile, lockFile, rows, effects,
		unconfirmedStop: () => { termination = 'already_exited'; },
		onClaim: (action: () => void) => { claimAction = action; },
		refuseClaim: (refuse: boolean) => { refuseClaim = refuse; },
		savePins(owner: string, pins: unknown[]) {
			const workspace = path.join(home, 'workspaces', owner);
			fs.mkdirSync(workspace, { recursive: true });
			fs.writeFileSync(path.join(workspace, 'workspace-state.json'), JSON.stringify({ 'facade.pins': pins }));
		},
		async dispose() {
			for (const socket of sockets) { socket.destroy(); }
			await new Promise<void>(resolve => server.close(() => resolve()));
			fs.rmSync(lockFile, { force: true });
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

suite('Scoped legacy cutover', () => {
	test('a previously confirmed shared Pin retries exact inspection after a disconnect (RULES-6.4)', async () => {
		const wanted = pin('second-workspace-pin');
		const agent: AgentInfo = {
			reference: REFERENCE, address: 'a7@this-machine', type: 'managed', name: 'Fixture',
			cli: 'codex', args: [], cwd: wanted.cwd, process: 'ended', state: 'ended',
			created_at: new Date(0).toISOString(), started_at: new Date(0).toISOString(),
			root: REFERENCE, yolo: true, tools_state: 'available', session: wanted.conversation.sessionId,
		};
		let retry: (() => void) | undefined;
		const timer = { unref: () => undefined };
		const { OrchestratorAgents } = withModules({
			vscode: { env: {}, workspace: {}, EventEmitter: TestEmitter, l10n: { t: (text: string) => text } },
		}, {
			setTimeout: (callback: () => void) => { retry = callback; return timer; },
			clearTimeout: () => undefined,
		})<typeof import('../host/framework/agents')>(require.resolve('../host/framework/agents'));
		const disposal = () => ({ dispose: () => undefined });
		const saved: FrameworkPin[] = [];
		const inspected: unknown[] = [];
		const agents = new OrchestratorAgents({
			link: {
				machineId: REFERENCE.machine_id, onDidConnect: disposal, watch: disposal,
				call: async (operation: string, { target }: { readonly target: unknown }) => {
					assert.strictEqual(operation, 'agent.inspect', 'only a read is made for the confirmed record');
					inspected.push(target);
					if (inspected.length === 1) { throw new Error('Lost connection'); }
					return { agent };
				},
			},
			workspace: {
				onDidChange: disposal, snapshot: () => ({ members: [], pins: [...saved] }),
				pendingLegacyPins: () => saved.length ? [] : [wanted],
				legacyPinMigration: () => ({
					recover: async () => ({ kind: 'confirmed', reference: REFERENCE }),
				}),
				restorePinsOnce: async (restore: () => Promise<unknown>) => ({ performed: true, failures: await restore() }),
				importLegacyPin: (previous: LegacySessionPin, confirmed: FrameworkPin) => {
					assert.strictEqual(previous.id, wanted.id);
					saved.push(confirmed);
					return true;
				},
				reportLegacyPinFailure: () => false,
			},
			locations: { onDidChange: disposal, snapshot: () => ({ locations: [] }) },
			onDidChangeMachineNames: disposal, machineName: () => undefined,
			notifyError: assert.fail, log: { event: assert.fail },
		} as never);
		try {
			await agents.restorePins();
			assert.deepStrictEqual(inspected, [REFERENCE]);
			assert.strictEqual(saved.length, 0);
			agents.recheckLegacyPins();
			assert.ok(retry, 'a failed read keeps this Pin queued for another inspection');
			retry();
			await agents.pendingPinRecovery();
			assert.deepStrictEqual(inspected, [REFERENCE, REFERENCE]);
			assert.deepStrictEqual(saved.map(pinned => [pinned.id, pinned.machine_id, pinned.agent]),
				[[wanted.id, REFERENCE.machine_id, REFERENCE.agent_id]]);
		} finally {
			agents.dispose();
		}
	});

	test('discovers the released home-suffixed supervisor without any registry (ARCHITECTURE-1.4)', async () => {
		const f = await fixture(false);
		const other = await fixture(false);
		try {
			const scope = { owner: A, retired: CLAIM };
			const saved = pin('pin-a', 'scope-a');
			assert.ok(!fs.existsSync(f.registry));
			assert.deepStrictEqual(await legacyPinMigration(f.home, A).recover(saved, () => ({ attempted: false }),
				async () => assert.fail('the unpublished supervisor still holds this session')), { kind: 'deferred' });
			const offered = (await checkLegacyCutover(f.home, scope)).plan;
			assert.ok(offered);
			assert.deepStrictEqual(offered.runs.map(run => run.run), [RUN_A]);
			assert.ok(await approveLegacyCutover(f.home, scope, offered));
			assert.strictEqual((await checkLegacyCutover(f.home, scope)).ready, true);
			assert.deepStrictEqual(f.effects.map(effect => effect.method), ['claim', 'terminate']);
			assert.strictEqual(other.rows[0].ended, false, 'identical run IDs on a different resolved home are outside the scope');
			assert.deepStrictEqual(other.effects, []);
		} finally {
			await f.dispose();
			await other.dispose();
		}
	});

	test('defers a new Pin recovery when released supervisor enumeration fails (ARCHITECTURE-1.4)', async () => {
		const f = await fixture();
		try {
			f.rows.forEach(row => { row.ended = true; });
			const namespace = process.platform === 'win32' ? '\\\\.\\pipe\\' : path.dirname(ptydSocketPath(f.home, PTYD_PROTOCOL));
			let unreadable = true;
			let attempts = 0;
			const readdirSync = (directory: string) => {
				if (directory === namespace) {
					attempts++;
					const code = process.platform === 'win32' ? 'ENOENT' : 'EACCES';
					if (unreadable) { throw Object.assign(new Error('Cannot enumerate legacy supervisors'), { code }); }
				}
				return fs.readdirSync(directory);
			};
			const hostFs = new Proxy(fs, { get: (target, key) => key === 'readdirSync' ? readdirSync : Reflect.get(target, key) });
			const load = withModules({ fs: hostFs });
			const { legacyPinMigration: migrate } = load<typeof import('../host/legacyCutover')>(require.resolve('../host/legacyCutover'));
			const migration = migrate(f.home, A);
			const saved = pin('pin-a', 'scope-a');
			assert.deepStrictEqual(await migration.recover(saved, () => ({ attempted: false }),
				async () => assert.fail('endpoint enumeration failure allowed a new start')), { kind: 'deferred' });
			assert.strictEqual(attempts, 1);
			unreadable = false;
			assert.deepStrictEqual(await migration.recover(saved, () => ({ attempted: false }), async reservation => {
				await reservation.begin();
				return REFERENCE;
			}), { kind: 'confirmed', reference: REFERENCE });
		} finally {
			await f.dispose();
		}
	});

	test('reloads before consent and before dispatch with the same retired claim and approved scope (ARCHITECTURE-1.4)', async () => {
		const f = await fixture();
		try {
			const directory = path.join(f.home, 'native-window');
			const predecessor = beginWindowTerminals(directory);
			retireWindowTerminals(directory, predecessor.epoch, [{ claim: CLAIM, runs: [] }]);
			let current = beginWindowTerminals(directory);
			const scope = () => ({ owner: A, retired: current.retired.find(entry => entry.claim.owner === A)?.claim });
			const reload = () => {
				retireWindowTerminals(directory, current.epoch, []);
				current = beginWindowTerminals(directory);
				assert.deepStrictEqual(scope().retired, CLAIM);
			};
			const offered = (await checkLegacyCutover(f.home, scope())).plan;
			assert.ok(offered);
			reload();
			assert.deepStrictEqual((await checkLegacyCutover(f.home, scope())).plan, offered);
			assert.ok(await approveLegacyCutover(f.home, scope(), offered));
			assert.strictEqual(f.effects.length, 0);
			reload();
			f.refuseClaim(true);
			const pending = await checkLegacyCutover(f.home, scope());
			assert.strictEqual(pending.ready, false);
			assert.strictEqual(pending.plan, undefined);
			assert.strictEqual(pending.unconfirmed, 1);
			assert.deepStrictEqual(f.effects.map(effect => effect.method), ['claim']);
			assert.strictEqual(JSON.parse(fs.readFileSync(f.journal, 'utf8')).runs[0].stop, undefined);
			assert.strictEqual((await checkLegacyCutover(f.home, { owner: B })).plan?.runs[0].owner, B);
			f.refuseClaim(false);
			assert.strictEqual((await checkLegacyCutover(f.home, scope())).ready, true);
			assert.deepStrictEqual(f.effects.filter(effect => effect.method === 'terminate').map(effect => effect.params),
				[{ run: RUN_A, graceMs: 2_000 }]);
			assert.strictEqual(f.rows[1].ended, false);
		} finally {
			await f.dispose();
		}
	});

	test('settles a missing queued run only on its exact supervisor’s verified list (ARCHITECTURE-1.4)', async () => {
		const f = await fixture();
		try {
			const scope = { owner: A, retired: CLAIM };
			const a = legacyPinMigration(f.home, A);
			const saved = pin('pin-a', 'scope-a');
			const neverStart = async () => assert.fail('a legacy holder was not cleared');
			const priorPublication = new Date(Date.now() - 10_000);
			fs.utimesSync(f.registryFile, priorPublication, priorPublication);
			f.rows[0].pid = 0;
			const offered = (await checkLegacyCutover(f.home, scope)).plan;
			assert.ok(offered);
			assert.ok(await approveLegacyCutover(f.home, scope, offered));
			assert.strictEqual((await checkLegacyCutover(f.home, scope)).ready, false);
			assert.deepStrictEqual(await a.recover(saved, () => ({ attempted: false }), neverStart), { kind: 'deferred' });
			f.rows.splice(0, 1);
			fs.renameSync(f.registryFile, `${f.registryFile}.hidden`);
			assert.strictEqual((await checkLegacyCutover(f.home, scope)).ready, false);
			assert.deepStrictEqual(await a.recover(saved, () => ({ attempted: false }), neverStart), { kind: 'deferred' });
			fs.renameSync(`${f.registryFile}.hidden`, f.registryFile);
			fs.writeFileSync(f.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
			assert.strictEqual((await checkLegacyCutover(f.home, scope)).ready, false, 'a newer listener cannot settle the old queue');
			assert.deepStrictEqual(await a.recover(saved, () => ({ attempted: false }), neverStart), { kind: 'deferred' });
			fs.unlinkSync(f.lockFile);
			assert.strictEqual((await checkLegacyCutover(f.home, scope)).ready, true);
			assert.deepStrictEqual(await a.recover(saved, () => ({ attempted: false }), async () => REFERENCE), { kind: 'confirmed', reference: REFERENCE });
			assert.deepStrictEqual(f.effects, []);
		} finally {
			await f.dispose();
		}
	});

	test('keeps an exact uncertain local exit pending without sending a second stop (ARCHITECTURE-1.4)', async () => {
		const f = await fixture();
		try {
			const scope = { owner: A, retired: CLAIM };
			f.rows[0].uncertain = true;
			const offered = (await checkLegacyCutover(f.home, scope)).plan;
			assert.ok(offered);
			assert.ok(await approveLegacyCutover(f.home, scope, offered));
			const state = await checkLegacyCutover(f.home, scope);
			assert.strictEqual(state.ready, false);
			assert.strictEqual(state.unconfirmed, 1);
			assert.strictEqual(f.effects.length, 0);
			f.rows[0].ended = true;
			assert.strictEqual((await checkLegacyCutover(f.home, scope)).ready, true);
		} finally {
			await f.dispose();
		}
	});

	test('approves and stops A only and durably writes intent before the request (ARCHITECTURE-1.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			const saved = pin('pin-a', 'scope-a');
			f.savePins(A, [saved, { opaque: true }]);
			const scope = { owner: A, retired: CLAIM };
			f.rows[0].attached = true;
			const offered = (await checkLegacyCutover(f.home, scope)).plan;
			assert.ok(offered);
			assert.deepStrictEqual(offered.runs.map(run => run.run), [RUN_A]);
			assert.deepStrictEqual(offered.snapshots[A], { pins: [saved], unrecognized: [{ opaque: true }] });
			assert.ok(await approveLegacyCutover(f.home, scope, offered));
			assert.ok((await checkLegacyCutover(f.home, scope)).ready);
			assert.strictEqual(f.effects.length, 0);
			f.rows[0].attached = false;
			assert.ok((await checkLegacyCutover(f.home, scope)).ready);
			assert.deepStrictEqual(f.effects.map(effect => effect.method), ['claim', 'terminate']);
			assert.deepStrictEqual(f.effects[0].params, { ...CLAIM, local: true });
			assert.deepStrictEqual(f.effects[1].params, { run: RUN_A, graceMs: 2_000 });
			assert.deepStrictEqual((f.effects[1].journal as { runs: { stop?: string }[] }).runs.map(run => run.stop), ['requested']);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.claimFile, 'utf8')), CLAIM);
			assert.strictEqual(f.rows[1].ended, false);
			assert.deepStrictEqual(legacyPinMigration(f.home, A).snapshot(), offered.snapshots[A]);
		} finally {
			await f.dispose();
		}
	});

	test('keeps a dispatched stop pending across reload and leaves independent workspaces ready (ARCHITECTURE-1.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			f.unconfirmedStop();
			fs.writeFileSync(path.join(f.registry, 'unavailable.json'), JSON.stringify({
				protocol: 16, build: 'abcd123456', pid: process.pid, socket: ptydSocketPath(f.home, 16, 'abcd123456'),
			}));
			const scope = { owner: A, retired: CLAIM };
			const offered = (await checkLegacyCutover(f.home, scope)).plan;
			assert.ok(offered);
			assert.ok(await approveLegacyCutover(f.home, scope, offered));
			const waiting = await checkLegacyCutover(f.home, scope);
			assert.strictEqual(waiting.ready, false);
			assert.strictEqual(waiting.unconfirmed, 1);
			assert.deepStrictEqual(waiting.unavailable, [], 'an unrelated endpoint does not change the pending status');
			assert.strictEqual((await checkLegacyCutover(f.home, { owner: A })).ready, false, 'reload without native proof stays pending');
			assert.strictEqual((await checkLegacyCutover(f.home, { owner: 'cccccccccccccccc' })).ready, true);
			assert.deepStrictEqual(f.effects.map(effect => effect.method), ['claim', 'terminate']);
			const progress = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
			assert.deepStrictEqual([progress.runs[0].stop, progress.runs[0].nativeStop], ['requested', true]);
			assert.deepStrictEqual(await legacyPinMigration(f.home, A).recover(pin('pin-a', 'scope-a'), () => ({ attempted: false }),
				async () => assert.fail('unconfirmed stop released recovery')), { kind: 'deferred' });
			f.rows[0].ended = true;
			assert.strictEqual((await checkLegacyCutover(f.home, { owner: A })).ready, true);
			assert.deepStrictEqual(f.effects.map(effect => effect.method), ['claim', 'terminate']);
		} finally {
			await f.dispose();
		}
	});

	test('preserves an older v1 request fence and defers its Pin when custody was unproven (ARCHITECTURE-1.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			const saved = pin('pin-a', 'scope-a');
			const offered = (await checkLegacyCutover(f.home, { owner: A })).plan;
			assert.ok(offered);
			const [run] = offered.runs;
			fs.writeFileSync(f.journal, JSON.stringify({
				version: 1, snapshots: { [A]: [saved] },
				runs: [{ socket: run.socket, owner: A, run: RUN_A, pid: run.pid, approved: true, stop: 'requested' }],
			}));
			assert.strictEqual((await checkLegacyCutover(f.home, { owner: A })).ready, true);
			assert.deepStrictEqual(await legacyPinMigration(f.home, A).recover(saved, () => ({ attempted: false }),
				async () => assert.fail('the historic request fence was lost')), { kind: 'deferred' });
			assert.strictEqual(JSON.parse(fs.readFileSync(f.journal, 'utf8')).runs[0].stop, 'requested');
			assert.strictEqual(f.effects.length, 0);
		} finally {
			await f.dispose();
		}
	});

	test('keeps consent fixed and drops stop authority when the disk generation changes (ARCHITECTURE-1.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			const scope = { owner: A, retired: CLAIM };
			const offered = (await checkLegacyCutover(f.home, scope)).plan;
			assert.ok(offered);
			assert.ok(await approveLegacyCutover(f.home, scope, offered));
			f.onClaim(() => fs.writeFileSync(f.claimFile, JSON.stringify({ ...CLAIM, generation: 2, token: 'new-owner' })));
			assert.ok((await checkLegacyCutover(f.home, scope)).ready);
			assert.deepStrictEqual(f.effects.map(effect => effect.method), ['claim']);
			f.rows.push({ ...f.rows[0], run: 'run-cccccccccccccccccccccccccccccccc', pin: 'late' });
			assert.ok((await checkLegacyCutover(f.home, scope)).ready);
			assert.deepStrictEqual(f.effects.map(effect => effect.method), ['claim']);
			assert.ok(f.rows.every(row => !row.ended));
		} finally {
			await f.dispose();
		}
	});

	test('holds only the matching session across directories and shares one result across Pin IDs (ARCHITECTURE-1.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			f.rows[0].ended = true;
			const a = legacyPinMigration(f.home, A);
			const b = legacyPinMigration(f.home, B);
			assert.ok((await checkLegacyCutover(f.home, { owner: A })).ready);
			assert.deepStrictEqual(await a.recover(pin('pin-a'), () => ({ attempted: false }),
				async () => assert.fail('an old session was still live')), { kind: 'deferred' });
			assert.deepStrictEqual(await a.recover(pin('unrelated', 'other'), () => ({ attempted: false }), async () => REFERENCE),
				{ kind: 'confirmed', reference: REFERENCE });
			f.rows[1].ended = true;
			let launches = 0;
			const convert: Parameters<typeof a.recover>[2] = async reservation => {
				await reservation.begin();
				launches++;
				return REFERENCE;
			};
			assert.deepStrictEqual(await Promise.all([
				a.recover(pin('pin-a'), () => ({ attempted: false }), convert),
				b.recover(pin('pin-b'), () => ({ attempted: false }), convert),
			]), [{ kind: 'confirmed', reference: REFERENCE }, { kind: 'confirmed', reference: REFERENCE }]);
			assert.strictEqual(launches, 1);
		} finally {
			await f.dispose();
		}
	});

	test('two workspace Pins for an exact legacy run share one stop and a durable recovery (ARCHITECTURE-1.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			const pinA = pin('pin-a', 'scope-a');
			const pinB = pin('pin-shared-b', 'scope-a');
			f.savePins(A, [pinA]);
			f.savePins(B, [pinB]);
			const a = legacyPinMigration(f.home, A);
			const b = legacyPinMigration(f.home, B);
			const scope = { owner: A, retired: CLAIM };
			const offered = (await checkLegacyCutover(f.home, scope)).plan;
			assert.ok(offered);
			let started = 0;
			const convert: Parameters<typeof a.recover>[2] = async reservation => {
				await reservation.begin();
				started++;
				return REFERENCE;
			};
			assert.deepStrictEqual(await b.recover(pinB, () => ({ attempted: false }), convert), { kind: 'deferred' });
			assert.strictEqual(started, 0);
			assert.ok(await approveLegacyCutover(f.home, scope, offered));
			assert.strictEqual((await checkLegacyCutover(f.home, scope)).ready, true);
			assert.strictEqual((await checkLegacyCutover(f.home, scope)).ready, true);
			assert.deepStrictEqual(f.effects.filter(effect => effect.method === 'terminate').map(effect => effect.params),
				[{ run: RUN_A, graceMs: 2_000 }]);
			assert.strictEqual(f.rows[1].ended, false, 'the second workspace’s unrelated agent is still live');
			const confirmed = { kind: 'confirmed', reference: REFERENCE };
			assert.deepStrictEqual(await Promise.all([
				a.recover(pinA, () => ({ attempted: false }), convert),
				b.recover(pinB, () => ({ attempted: false }), convert),
			]), [confirmed, confirmed]);
			assert.strictEqual(started, 1);
			const journal = JSON.parse(fs.readFileSync(f.journal, 'utf8')) as {
				recoveries: Record<string, { reference: typeof REFERENCE; runs: string[] }>;
			};
			const recoveries = Object.values(journal.recoveries);
			assert.deepStrictEqual(recoveries.map(item => item.reference), [REFERENCE]);
			assert.strictEqual(recoveries[0].runs.length, 1);
			assert.ok(recoveries[0].runs[0].includes(RUN_A), 'the recovery is tied to the exact stopped run');
			fs.writeFileSync(path.join(f.registry, 'unreadable.json'), '{');
			assert.deepStrictEqual(await legacyPinMigration(f.home, B).recover(pinB, () => ({ attempted: false }),
				async () => assert.fail('the saved recovery was launched again')), confirmed);
			assert.deepStrictEqual(await b.recover(pin('different', 'different-session'), () => ({ attempted: false }),
				async () => assert.fail('incomplete inventory authorized a new start')), { kind: 'deferred' });
		} finally {
			await f.dispose();
		}
	});

	test('confirms an exact historical reference once despite unreadable legacy inventory (ARCHITECTURE-1.4)', async () => {
		const f = await fixture();
		try {
			f.rows[0].ended = true;
			fs.writeFileSync(path.join(f.registry, 'unreadable.json'), '{');
			const pinA = pin('pin-a', 'scope-a');
			const pinB = pin('pin-shared-b', 'scope-a');
			const a = legacyPinMigration(f.home, A);
			const b = legacyPinMigration(f.home, B);
			const history = () => ({ attempted: true, reference: REFERENCE });
			const noStart = async () => assert.fail('historical intent allowed a new start');
			const stored = () => Object.values(JSON.parse(fs.readFileSync(f.journal, 'utf8')).recoveries);
			assert.deepStrictEqual(await a.recover(pinA, history, noStart, undefined, async () => {
				assert.deepStrictEqual(stored(), [{ pending: true }]);
				return { ...REFERENCE, machine_id: 'unrelated-machine' };
			}), { kind: 'deferred' });
			assert.deepStrictEqual(stored(), [{ pending: true }]);
			assert.deepStrictEqual(await b.recover(pinB, () => ({ attempted: true }), noStart), { kind: 'unconfirmed' });

			let inspections = 0;
			const inspect = async (reference: typeof REFERENCE) => {
				assert.deepStrictEqual(reference, REFERENCE);
				inspections++;
				return REFERENCE;
			};
			const confirmed = { kind: 'confirmed', reference: REFERENCE };
			assert.deepStrictEqual(await Promise.all([
				a.recover(pinA, history, noStart, undefined, inspect),
				b.recover(pinB, history, noStart, undefined, inspect),
			]), [confirmed, confirmed]);
			assert.strictEqual(inspections, 1);
			assert.deepStrictEqual(stored(), [{ reference: REFERENCE, runs: [] }]);
			assert.deepStrictEqual(await b.recover(pinB, () => assert.fail('the known result lost priority'), noStart, undefined, noStart), confirmed);
		} finally {
			await f.dispose();
		}
	});

	test('persists an ambiguous resume and refuses a late-discovered session holder (RULES-6.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			f.rows.forEach(row => { row.ended = true; });
			const a = legacyPinMigration(f.home, A);
			assert.deepStrictEqual(await a.recover(pin('pin-a'), () => ({ attempted: false }), async reservation => {
				f.rows.push({ ...f.rows[1], run: 'run-cccccccccccccccccccccccccccccccc', ended: false });
				await reservation.begin();
				return assert.fail('a fresh legacy holder allowed resume');
			}), { kind: 'deferred' });
			f.rows[2].ended = true;
			await assert.rejects(a.recover(pin('pin-a'), () => ({ attempted: false }), async reservation => {
				await reservation.begin();
				throw new Error('lost reply');
			}), /lost reply/);
			assert.deepStrictEqual(await legacyPinMigration(f.home, B).recover(pin('pin-b'), () => ({ attempted: false }),
				async () => assert.fail('ambiguous attempt replayed')), { kind: 'unconfirmed' });
		} finally {
			await f.dispose();
		}
	});

	test('reconciles a lost exact Framework resume only after that reference starts a newer run (RULES-6.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			f.rows.forEach(row => { row.ended = true; });
			const { confirmsLegacyResume } = withModules({ vscode: { env: {}, workspace: {} } })
				<typeof import('../host/framework/legacyRecovery')>(require.resolve('../host/framework/legacyRecovery'));
			const a = legacyPinMigration(f.home, A);
			const saved = pin('pin-a');
			const before: AgentInfo = {
				type: 'managed', reference: REFERENCE, root: REFERENCE, process: 'ended', started_at: '2026-01-01T00:00:00.000Z',
				created_at: '2026-01-01T00:00:00.000Z', address: 'a7@machine', cli: 'codex', args: [],
				cwd: saved.cwd, session: saved.conversation.sessionId, name: 'Fixture', yolo: false, state: 'ended', tools_state: 'available',
			};
			await assert.rejects(a.recover(saved, () => ({ attempted: false }), async reservation => {
				await reservation.begin({ reference: REFERENCE, startedAt: before.started_at });
				throw new Error('lost exact resume');
			}), /lost exact resume/);
			const neverReplay = async () => assert.fail('the exact resume replayed');
			assert.deepStrictEqual(await a.recover(saved, () => ({ attempted: false }), neverReplay, async attempt =>
				confirmsLegacyResume(saved, REFERENCE.machine_id, attempt, before) ? REFERENCE : undefined), { kind: 'deferred' });
			assert.deepStrictEqual(await a.recover(saved, () => ({ attempted: false }), neverReplay, async attempt => {
				const after = { ...before, started_at: new Date(attempt.requestedAt + 1).toISOString() };
				assert.strictEqual(confirmsLegacyResume(saved, REFERENCE.machine_id, attempt, {
					...after, reference: { ...REFERENCE, agent_id: 'a8' },
				}), false);
				const anotherEnvironment = { ...saved, conversation: { ...saved.conversation, environment: 'ssh-remote' } };
				assert.strictEqual(confirmsLegacyResume(anotherEnvironment, REFERENCE.machine_id, attempt, after), false);
				return confirmsLegacyResume(saved, REFERENCE.machine_id, attempt, after) ? REFERENCE : undefined;
			}), { kind: 'confirmed', reference: REFERENCE });
		} finally {
			await f.dispose();
		}
	});

	test('preserves a pending Pin through a reference conflict and never imports it again after Unpin (RULES-6.4)', async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-legacy-pin-'));
		const file = path.join(home, 'workspace-state.json');
		const previous = pin('pin-old');
		const recovered = { ...previous, machine_id: REFERENCE.machine_id, agent: REFERENCE.agent_id };
		fs.writeFileSync(file, JSON.stringify({ 'facade.pins': [previous] }));
		const { FrameworkWorkspace } = withModules({ vscode: { EventEmitter: TestEmitter } })
			<typeof import('../host/framework/workspace')>(require.resolve('../host/framework/workspace'));
		const workspace = new FrameworkWorkspace(home, { file }, { event: assert.fail });
		try {
			await workspace.loadLocalPins();
			workspace.savePin({ ...recovered, id: 'pin-conflicting' });
			assert.strictEqual(workspace.importLegacyPin(previous, recovered), false);
			assert.deepStrictEqual(workspace.pendingLegacyPins(), [previous]);
			workspace.removePin('pin-conflicting');
			workspace.savePin({ ...recovered, agent: 'other' });
			workspace.removePin(recovered.id, false);
			assert.deepStrictEqual(workspace.pendingLegacyPins(), [previous]);
			assert.strictEqual(workspace.importLegacyPin(previous, recovered), true);
			assert.deepStrictEqual(workspace.snapshot().pins, [recovered]);
			assert.deepStrictEqual(workspace.pendingLegacyPins(), []);
			workspace.removePin(recovered.id);
			await workspace.loadLocalPins();
			assert.deepStrictEqual(workspace.snapshot().pins, []);
			assert.deepStrictEqual(workspace.pendingLegacyPins(), []);
		} finally {
			workspace.dispose();
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

});
