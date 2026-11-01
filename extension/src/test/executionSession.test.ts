/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { OwnerClaim } from '../base/ownership';
import type { ExecutionSession } from '../host/execution/executionSession';
import { PtydNotSent } from '../host/execution/ptydClient';
import { FakeClock } from './clock';
import { withModules } from './withModules';

function gate() {
	let open!: () => void;
	const wait = new Promise<void>(resolve => open = resolve);
	return { wait, open };
}

/** The transport's externally observable callbacks; no daemon, native terminal or real process is needed here. */
class Peer {
	readonly claims: OwnerClaim[] = [];
	private close: () => void = () => undefined;
	private transfer: (owner: string) => void = () => undefined;
	disposals = 0;
	claimWait?: Promise<void>;
	async request(method: string, claim: OwnerClaim): Promise<void> {
		assert.strictEqual(method, 'claim', 'the session itself never sends a run effect');
		this.claims.push(claim);
		await this.claimWait;
	}
	onDidClose(listener: () => void): void { this.close = listener; }
	onDidLoseOwner(listener: (owner: string) => void): void { this.transfer = listener; }
	disconnect(): void { this.close(); }
	transferred(owner: string): void { this.transfer(owner); }
	dispose(): void { this.disposals++; this.close(); }
}

suite('Execution session: ownership and recovery across asynchronous boundaries', () => {
	let clock: FakeClock;
	let session: ExecutionSession;
	let peers: Peer[];
	let nextClaim: Promise<void> | undefined;
	let reconnects: number;
	let reconciles: number;
	let transfers: number;
	const claim: OwnerClaim = { owner: 'workspace', generation: 7, token: 'activation' };

	setup(() => {
		clock = FakeClock.install();
		peers = [];
		nextClaim = undefined;
		reconnects = reconciles = transfers = 0;
		const { ExecutionSession: Session } = withModules({ './ptydClient': {
			PtydNotSent, ptydSocketPath: () => '/test/socket',
			EarlierPtyds: class { readonly clients = []; find() { return Promise.resolve(); } client() { return Promise.reject(new PtydNotSent('none')); } dispose() { return undefined; } },
			PtydClient: { connect: async () => {
				const peer = new Peer();
				peer.claimWait = nextClaim;
				peers.push(peer);
				return peer;
			} }
		} })<typeof import('../host/execution/executionSession')>(require.resolve('../host/execution/executionSession'));
		session = new Session({ owner: claim.owner, claim, home: '/test', ptydScript: '/test/ptyd.js', log: () => undefined,
			connectionLost: () => undefined, transferred: () => { transfers++; },
			reconnect: async () => { reconnects++; }, reconcile: async () => { reconciles++; } });
	});

	teardown(async () => {
		session.dispose();
		await clock.tick(0);
		clock.uninstall();
	});

	test('concurrent callers share a claim; reconnect retains its identity and ignores a late close from the old transport', async () => {
		const first = session.client();
		assert.strictEqual(session.client(), first);
		await first;
		peers[0].disconnect();
		const second = session.client();
		await second;
		peers[0].disconnect();
		assert.strictEqual(session.current, second);
		assert.deepStrictEqual(peers.map(peer => peer.claims), [[claim], [claim]]);
	});

	test('disposal during claim closes the late transport, starts no restoration and leaves no scheduled work', async () => {
		const claimed = gate();
		nextClaim = claimed.wait;
		let restored = 0;
		const recovering = session.recover(true, async () => { restored++; return true; });
		await clock.tick(0);
		assert.strictEqual(peers[0].claims.length, 1);
		session.dispose();
		claimed.open();
		await recovering;
		await clock.tick(3_000);
		await assert.rejects(session.client(), PtydNotSent);
		assert.deepStrictEqual([restored, peers[0].disposals, reconnects, reconciles], [0, 1, 0, 0]);
	});

	test('overlapping recovery shares one batch, and its completion cannot clear a newer disconnect', async () => {
		await session.client();
		peers[0].disconnect();
		const restored = gate();
		let batches = 0;
		const first = session.recover(true, async () => { batches++; await restored.wait; return true; });
		const second = session.recover(true, async () => { batches++; return true; });
		assert.strictEqual(second, first);
		await clock.tick(0);
		peers[1].disconnect();
		restored.open();
		await first;
		assert.deepStrictEqual([batches, session.needsRecovery, peers.length], [1, true, 2]);
		session.dispose();
		await clock.tick(3_000);
		assert.deepStrictEqual([reconnects, reconciles], [0, 0]);
	});

	test('an incomplete recovery retries on the claimed transport; ownership transfer fences all later work', async () => {
		let batches = 0;
		await session.recover(true, async () => { batches++; return false; });
		assert.strictEqual(session.needsRecovery, true);
		await session.recover(true, async () => { batches++; return true; });
		assert.deepStrictEqual([session.needsRecovery, peers.length, peers[0].claims], [false, 1, [claim]]);
		peers[0].transferred('unrelated');
		assert.strictEqual(session.closed, false);
		peers[0].transferred(claim.owner);
		peers[0].transferred(claim.owner);
		await session.recover(true, async () => { batches++; return true; });
		await assert.rejects(session.client(), PtydNotSent);
		assert.deepStrictEqual([session.ownershipLost, transfers, batches], [true, 1, 2]);
		assert.strictEqual(peers[0].disposals, 1, 'a transferred activation lets go of its connection, which claims nothing any more');
		await clock.tick(3_000);
		assert.deepStrictEqual([reconnects, reconciles, peers.length], [0, 0, 1], 'a transferred activation owns no more scheduled work, and connects no more');
	});
});
