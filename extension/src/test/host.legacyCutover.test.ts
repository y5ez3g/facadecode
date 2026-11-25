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
import { approveLegacyCutover, checkLegacyCutover, legacyPinMigration } from '../host/legacyCutover';
import type { LegacySessionPin } from '../host/legacyPins';
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

async function fixture() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cutover-'));
	const registry = path.join(home, 'ptyd', 'sockets');
	const journal = path.join(home, 'legacy-cutover.json');
	const claimFile = path.join(home, 'claims', `${createHash('sha256').update(A).digest('hex')}.json`);
	const socketFile = path.join(home, 'legacy.sock');
	const pid = process.pid;
	const startedAt = await processStartTimeAsync(pid, true) ?? Date.now();
	const build = 'abcd1234';
	fs.chmodSync(home, 0o700);
	fs.mkdirSync(registry, { recursive: true });
	fs.mkdirSync(path.dirname(claimFile));
	fs.writeFileSync(claimFile, JSON.stringify(CLAIM));
	fs.writeFileSync(path.join(registry, 'current.json'), JSON.stringify({ protocol: 17, build, socket: socketFile, pid }));
	const rows = [
		{ owner: A, run: RUN_A, session: 'scope-a', cwd: '/work/a', pin: 'pin-a', attached: false },
		{ owner: B, run: RUN_B, session: 'shared', cwd: '/work/b', pin: 'pin-b', attached: true },
	].map(row => ({ ...row, ended: false }));
	const effects: { method: string; params: unknown; journal: unknown }[] = [];
	const sockets = new Set<net.Socket>();
	let termination: 'terminated' | 'already_exited' = 'terminated';
	let claimAction: (() => void) | undefined;
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
						owner: row.owner, run: row.run, pid, cwd: row.cwd, startedAt,
						claimedElsewhere: row.attached, ...(row.ended ? { exited: { exitCode: 0 } } : {}),
						meta: { environment: 'local', cli: 'codex', builtIn: 'codex', sessionId: row.session, pin: row.pin },
					}));
				} else if (method === 'claim' || method === 'terminate') {
					effects.push({ method, params, journal: JSON.parse(fs.readFileSync(journal, 'utf8')) });
					if (method === 'claim') { claimAction?.(); }
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
		home, journal, claimFile, registry, rows, effects,
		unconfirmedStop: () => { termination = 'already_exited'; },
		onClaim: (action: () => void) => { claimAction = action; },
		savePins(owner: string, pins: unknown[]) {
			const workspace = path.join(home, 'workspaces', owner);
			fs.mkdirSync(workspace, { recursive: true });
			fs.writeFileSync(path.join(workspace, 'workspace-state.json'), JSON.stringify({ 'facade.pins': pins }));
		},
		async dispose() {
			for (const socket of sockets) { socket.destroy(); }
			await new Promise<void>(resolve => server.close(() => resolve()));
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

suite('Scoped legacy cutover', () => {
	test('approves and stops A only and durably writes intent before the request (ARCHITECTURE-1.4)', async function () {
		if (process.platform === 'win32') { this.skip(); }
		const f = await fixture();
		try {
			const saved = pin('pin-a', 'scope-a');
			f.savePins(A, [saved, { opaque: true }]);
			const scope = { owner: A, retired: { claim: CLAIM, runs: [RUN_A] } };
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
				protocol: 16, build: 'aaaa', pid: process.pid, socket: path.join(f.home, 'unavailable.sock'),
			}));
			const scope = { owner: A, retired: { claim: CLAIM, runs: [RUN_A] } };
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
			assert.deepStrictEqual(await legacyPinMigration(f.home, A).recover(pin('pin-a', 'scope-a'), () => false,
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
			assert.deepStrictEqual(await legacyPinMigration(f.home, A).recover(saved, () => false,
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
			const scope = { owner: A, retired: { claim: CLAIM, runs: [RUN_A] } };
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
			assert.deepStrictEqual(await a.recover(pin('pin-a'), () => false,
				async () => assert.fail('an old session was still live')), { kind: 'deferred' });
			assert.deepStrictEqual(await a.recover(pin('unrelated', 'other'), () => false, async () => REFERENCE),
				{ kind: 'confirmed', reference: REFERENCE });
			f.rows[1].ended = true;
			let launches = 0;
			const convert: Parameters<typeof a.recover>[2] = async reservation => {
				await reservation.begin();
				launches++;
				return REFERENCE;
			};
			assert.deepStrictEqual(await Promise.all([
				a.recover(pin('pin-a'), () => false, convert),
				b.recover(pin('pin-b'), () => false, convert),
			]), [{ kind: 'confirmed', reference: REFERENCE }, { kind: 'confirmed', reference: REFERENCE }]);
			assert.strictEqual(launches, 1);
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
			assert.deepStrictEqual(await a.recover(pin('pin-a'), () => false, async reservation => {
				f.rows.push({ ...f.rows[1], run: 'run-cccccccccccccccccccccccccccccccc', ended: false });
				await reservation.begin();
				return assert.fail('a fresh legacy holder allowed resume');
			}), { kind: 'deferred' });
			f.rows[2].ended = true;
			await assert.rejects(a.recover(pin('pin-a'), () => false, async reservation => {
				await reservation.begin();
				throw new Error('lost reply');
			}), /lost reply/);
			assert.deepStrictEqual(await legacyPinMigration(f.home, B).recover(pin('pin-b'), () => false,
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
			const { confirmsLegacyResume } = withModules({ vscode: {} })
				<typeof import('../host/framework/legacyRecovery')>(require.resolve('../host/framework/legacyRecovery'));
			const a = legacyPinMigration(f.home, A);
			const saved = pin('pin-a');
			const before: AgentInfo = {
				type: 'managed', reference: REFERENCE, root: REFERENCE, process: 'ended', started_at: '2026-01-01T00:00:00.000Z',
				created_at: '2026-01-01T00:00:00.000Z', address: 'a7@machine', cli: 'codex', args: [],
				cwd: saved.cwd, session: saved.conversation.sessionId, name: 'Fixture', yolo: false, state: 'ended', tools_state: 'available',
			};
			await assert.rejects(a.recover(saved, () => false, async reservation => {
				await reservation.begin({ reference: REFERENCE, startedAt: before.started_at });
				throw new Error('lost exact resume');
			}), /lost exact resume/);
			const neverReplay = async () => assert.fail('the exact resume replayed');
			assert.deepStrictEqual(await a.recover(saved, () => false, neverReplay, async attempt =>
				confirmsLegacyResume(saved, REFERENCE.machine_id, attempt, before) ? REFERENCE : undefined), { kind: 'deferred' });
			assert.deepStrictEqual(await a.recover(saved, () => false, neverReplay, async attempt => {
				const after = { ...before, started_at: new Date(attempt.requestedAt + 1).toISOString() };
				assert.strictEqual(confirmsLegacyResume(saved, REFERENCE.machine_id, attempt, {
					...after, reference: { ...REFERENCE, agent_id: 'a8' },
				}), false);
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
