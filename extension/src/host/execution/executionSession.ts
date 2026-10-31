/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { messageOf } from '../../base/errors';
import type { OwnerClaim } from '../../base/ownership';
import { nextOwnerClaim } from '../../record/ownership';
import { earlierRuns, PtydClient, PtydNotSent, ptydSocketPath } from './ptydClient';

/** Cadence for checking live processes and retrying recovery (UX-5.2). */
export const RECONCILE_MS = 2_000;

interface SessionOptions {
	readonly owner: string;
	readonly claim?: OwnerClaim;
	readonly home: string;
	readonly ptydScript: string;
	readonly log: (line: string) => void;
	readonly connectionLost: () => void;
	readonly transferred: () => void;
	readonly reconnect: () => Promise<void>;
	readonly reconcile: () => Promise<void>;
}

/** Owns one activation's claim, connection and recovery schedule; it never owns terminal or per-run state. */
export class ExecutionSession {
	private connection: Promise<PtydClient> | undefined;
	private lost = false;
	private reclaiming: Promise<void> | undefined;
	private disposed = false;
	private transferredAway = false;
	private readonly claim: OwnerClaim;
	private readonly reconcileTimer: ReturnType<typeof setInterval>;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: SessionOptions) {
		this.claim = options.claim ?? nextOwnerClaim(options.owner, options.home);
		this.reconcileTimer = setInterval(() => void options.reconcile(), RECONCILE_MS);
		this.reconcileTimer.unref?.();
	}

	get closed(): boolean { return this.disposed || this.transferredAway; }
	get ownershipLost(): boolean { return this.transferredAway; }
	get current(): Promise<PtydClient> | undefined { return this.connection; }
	get needsRecovery(): boolean { return this.lost; }

	/** The connection to ptyd, made where there is none: a lost one is replaced and this window's runs claimed again. */
	client(): Promise<PtydClient> {
		if (this.closed) {
			return Promise.reject(new PtydNotSent('The window is closing.'));
		}
		if (!this.connection) {
			const socket = ptydSocketPath(this.options.home);
			const connection = this.connection = PtydClient.connect(socket, this.options.ptydScript, path.join(this.options.home, 'ptyd', 'ptyd.log')).then(async client => {
				client.onDidLoseOwner(owner => { if (owner === this.options.owner) { this.transfer(); } });
				try {
					await client.request('claim', this.claim);
					if (this.closed) {
						throw new Error('This workspace activation no longer owns its agents.');
					}
					return client;
				} catch (err) {
					client.dispose();
					if (/ownership was transferred or expired/.test(messageOf(err))) {
						this.transfer();
					}
					throw err;
				}
			});
			connection.then(client => {
				client.onDidClose(() => {
					if (this.connection === connection) {
						this.connection = undefined;
						this.options.log('The connection to ptyd closed: agents keep running, and this window claims them again.');
						if (!this.closed) {
							this.lost = true;
							this.options.connectionLost();
							clearTimeout(this.reconnectTimer);
							this.reconnectTimer = setTimeout(() => void this.options.reconnect(), 1_000);
							this.reconnectTimer.unref?.();
						}
					}
				});
				void earlierRuns(this.options.home, this.options.owner).then(found => {
					for (const { protocol, runs } of found) {
						this.options.log(`${runs} agent processes started by an earlier Facade Code still run in a ptyd of protocol ${protocol}; this window cannot show them, and they were not ended.`);
					}
				}, () => undefined);
			}, err => {
				if (this.connection === connection) {
					this.connection = undefined;
				}
				this.options.log(`Could not reach ptyd: ${messageOf(err)}`);
			});
		}
		return this.connection;
	}

	private transfer(): void {
		if (this.transferredAway) {
			return;
		}
		this.transferredAway = true;
		this.lost = false;
		clearInterval(this.reconcileTimer);
		clearTimeout(this.reconnectTimer);
		this.options.transferred();
	}

	/** One recovery batch at a time. A newer disconnect keeps its lost flag even when an older batch succeeds. */
	recover(hasRuns: boolean, restore: (client: PtydClient) => Promise<boolean>): Promise<void> {
		this.reclaiming ??= this.restore(hasRuns, restore).finally(() => this.reclaiming = undefined);
		return this.reclaiming;
	}

	/**
	 * Connects and claims again, whether or not runs are shown: ptyd ends an absent owner's runs, and its claim, five minutes after
	 * the window went (D75), and this window is still here. A failed connection keeps the loss, tried again by the next check.
	 */
	private async restore(hasRuns: boolean, restore: (client: PtydClient) => Promise<boolean>): Promise<void> {
		if (this.closed) {
			this.lost = false;
			return;
		}
		let client: PtydClient;
		try {
			client = await this.client();
		} catch {
			return;
		}
		if (this.closed) {
			return;
		}
		this.lost = false;
		if (hasRuns && !await restore(client) && !this.closed) {
			this.lost = true;
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		clearInterval(this.reconcileTimer);
		clearTimeout(this.reconnectTimer);
		void this.connection?.then(client => client.dispose(), () => undefined);
	}
}
