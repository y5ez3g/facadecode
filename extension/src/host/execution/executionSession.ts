/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { messageOf } from '../../base/errors';
import type { OwnerClaim } from '../../base/ownership';
import { PTYD_PROTOCOL } from '../../ptyd/protocol';
import { nextOwnerClaim } from '../../record/ownership';
import { EarlierPtyds, PtydClient, PtydNotSent, ptydSocketPath } from './ptydClient';

/** Cadence for checking live processes and retrying recovery (UX-5.2). */
export const RECONCILE_MS = 2_000;

interface SessionOptions {
	readonly owner: string;
	readonly claim?: OwnerClaim;
	readonly home: string;
	readonly ptydScript: string;
	readonly log: (line: string) => void;
	/** The connection to the ptyd of `protocol` - this window's own, or an earlier one's - was lost. */
	readonly connectionLost: (protocol: number) => void;
	/** Whether requests through the ptyd of the earlier protocol `protocol` are under way, for which it is not let go. */
	readonly busy?: (protocol: number) => boolean;
	readonly transferred: () => void;
	readonly reconnect: () => Promise<void>;
	readonly reconcile: () => Promise<void>;
	/** Each connection once it holds this activation's claim: the window hears its runs' tool calls on it (MCP-6.1). */
	readonly connected?: (client: PtydClient) => void;
}

/** Owns one activation's claim, connection and recovery schedule; it never owns terminal or per-run state. */
export class ExecutionSession {
	private connection: Promise<PtydClient> | undefined;
	private lost = false;
	private reclaiming: Promise<void> | undefined;
	private disposed = false;
	private transferredAway = false;
	private readonly claim: OwnerClaim;
	/** This window's connections to the ptyds of earlier protocols that hold its agents: shown as its own, never ended by an update. */
	private readonly earlier: EarlierPtyds;
	private readonly reconcileTimer: ReturnType<typeof setInterval>;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: SessionOptions) {
		this.claim = options.claim ?? nextOwnerClaim(options.owner, options.home);
		this.earlier = new EarlierPtyds(options.home, this.claim, {
			log: options.log, lost: protocol => this.lose(protocol), ownerLost: () => this.transfer(), ...options.busy ? { busy: options.busy } : {}
		});
		this.reconcileTimer = setInterval(() => void options.reconcile(), RECONCILE_MS);
		this.reconcileTimer.unref?.();
	}

	get closed(): boolean { return this.disposed || this.transferredAway; }
	get ownershipLost(): boolean { return this.transferredAway; }
	get current(): Promise<PtydClient> | undefined { return this.connection; }
	get needsRecovery(): boolean { return this.lost; }

	/** The ptyds of earlier protocols this window holds now, each with its protocol. */
	get earlierHeld(): readonly (readonly [number, PtydClient])[] {
		return this.closed ? [] : this.earlier.clients;
	}

	/** The ptyds of earlier protocols that hold this window's runs, each with its protocol: looked for first (ARCHITECTURE-2.4). */
	async earlierClients(): Promise<readonly (readonly [number, PtydClient])[]> {
		if (this.closed) {
			return [];
		}
		await this.earlier.find();
		return this.earlier.clients;
	}

	/**
	 * The connection to the ptyd of `protocol`, made where there is none: this window's own, a lost one replaced and this window's
	 * runs claimed again; or that of an earlier protocol, joined again where it was lost (ARCHITECTURE-2.4).
	 */
	client(protocol = PTYD_PROTOCOL): Promise<PtydClient> {
		if (this.closed) {
			return Promise.reject(new PtydNotSent('The window is closing.'));
		}
		if (protocol !== PTYD_PROTOCOL) {
			return this.earlier.client(protocol);
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
					this.options.connected?.(client);
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
						this.lose(PTYD_PROTOCOL);
					}
				});
				void this.earlier.find();
			}, err => {
				if (this.connection === connection) {
					this.connection = undefined;
				}
				this.options.log(`Could not reach ptyd: ${messageOf(err)}`);
			});
		}
		return this.connection;
	}

	/** The connection to the ptyd of `protocol` is lost: its runs are told so, and claimed again soon (RULES-3.1, 4.1). */
	private lose(protocol: number): void {
		if (this.closed) {
			return;
		}
		this.lost = true;
		this.options.connectionLost(protocol);
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => void this.options.reconnect(), 1_000);
		this.reconnectTimer.unref?.();
	}

	private transfer(): void {
		if (this.transferredAway) {
			return;
		}
		this.transferredAway = true;
		this.lost = false;
		this.earlier.dispose();
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
		this.earlier.dispose();
		clearInterval(this.reconcileTimer);
		clearTimeout(this.reconnectTimer);
		void this.connection?.then(client => client.dispose(), () => undefined);
	}
}
