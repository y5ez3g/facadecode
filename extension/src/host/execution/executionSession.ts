/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { messageOf } from '../../base/errors';
import type { OwnerClaim } from '../../base/ownership';
import { ptydBuild } from '../../base/ptydRegistry';
import { COLOURS_PROTOCOL, PTYD_PROTOCOL, type TerminalColours } from '../../ptyd/protocol';
import { nextOwnerClaim } from '../../record/ownership';
import { EarlierPtyds, OtherPtyd, otherPtyds, ownPtydSocket, PtydClient, PtydNotSent } from './ptydClient';

/** Cadence for checking live processes and retrying recovery (UX-5.2). */
export const RECONCILE_MS = 2_000;

interface SessionOptions {
	readonly owner: string;
	readonly claim?: OwnerClaim;
	readonly home: string;
	readonly ptydScript: string;
	/** The installation's version, which with its ptyd script names the build its own ptyd runs (ARCHITECTURE-2.4). */
	readonly version?: string;
	readonly log: (line: string) => void;
	/** The connection to the ptyd at `socket` - this window's own, or another's - was lost. */
	readonly connectionLost: (socket: string) => void;
	/** Whether requests through the other ptyd at `socket` are under way, for which it is not let go. */
	readonly busy?: (socket: string) => boolean;
	readonly transferred: () => void;
	readonly reconnect: () => Promise<void>;
	readonly reconcile: () => Promise<void>;
	/** Each connection once it holds this activation's claim: the window hears its runs' tool calls on it (MCP-6.1). */
	readonly connected?: (client: PtydClient) => void;
	/** The colours this window's terminals draw with, told its own ptyd as it connects and when they change (ARCHITECTURE-2.3). */
	readonly colours?: () => TerminalColours;
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
	/** This window's own ptyd, by its build: the only one it starts runs in (ARCHITECTURE-2.4). */
	readonly own: string;
	private readonly build: string;

	constructor(private readonly options: SessionOptions) {
		this.claim = options.claim ?? nextOwnerClaim(options.owner, options.home);
		this.build = ptydBuild(options.ptydScript, options.version ?? '');
		this.own = ownPtydSocket(options.home, options.ptydScript, options.version);
		this.earlier = new EarlierPtyds(options.home, this.own, this.claim, {
			log: options.log, lost: socket => this.lose(socket), ownerLost: () => this.transfer(), ...options.busy ? { busy: options.busy } : {},
			...options.connected ? { connected: options.connected } : {},
			// Its runs' programs ask it their terminal's colours as they ask this window's own: it is told them too (ARCHITECTURE-2.3)
			joined: (client, protocol) => {
				if (protocol >= COLOURS_PROTOCOL) {
					this.tellColours(client);
				}
			}
		});
		this.reconcileTimer = setInterval(() => void options.reconcile(), RECONCILE_MS);
		this.reconcileTimer.unref?.();
	}

	get closed(): boolean { return this.disposed || this.transferredAway; }
	/** This activation's claim, which fences what it writes beside its runs. */
	get ownerClaim(): OwnerClaim { return this.claim; }
	get ownershipLost(): boolean { return this.transferredAway; }
	get current(): Promise<PtydClient> | undefined { return this.connection; }
	/** The protocol the ptyd at `socket` speaks: this window's own's, or what another answered when it was found; 0 where unknown. */
	protocolOf(socket: string): number { return socket === this.own ? PTYD_PROTOCOL : this.earlier.protocolOf(socket) ?? 0; }
	/** The other ptyds that may hold this window's runs, each with its protocol (ARCHITECTURE-2.4). */
	others(): readonly OtherPtyd[] { return otherPtyds(this.options.home, this.own); }
	get needsRecovery(): boolean { return this.lost; }

	/** The other ptyds this window holds now, each by its socket. */
	get earlierHeld(): readonly (readonly [string, PtydClient])[] {
		return this.closed ? [] : this.earlier.clients;
	}

	/** The other ptyds that hold this window's runs, each by its socket: looked for first (ARCHITECTURE-2.4). */
	async earlierClients(): Promise<readonly (readonly [string, PtydClient])[]> {
		if (this.closed) {
			return [];
		}
		await this.earlier.find();
		return this.earlier.clients;
	}

	/**
	 * The connection to the ptyd at `socket`, made where there is none: this window's own, a lost one replaced and this window's
	 * runs claimed again; or another one, joined again where it was lost (ARCHITECTURE-2.4).
	 */
	client(socket: string = this.own): Promise<PtydClient> {
		if (this.closed) {
			return Promise.reject(new PtydNotSent('The window is closing.'));
		}
		if (socket !== this.own) {
			return this.earlier.client(socket);
		}
		if (!this.connection) {
			const connection = this.connection = PtydClient.connect(this.own, this.options.ptydScript, path.join(this.options.home, 'ptyd', 'ptyd.log'), { build: this.build }).then(async client => {
				client.onDidLoseOwner(owner => { if (owner === this.options.owner) { this.transfer(); } });
				try {
					await client.request('claim', this.claim);
					if (this.closed) {
						throw new Error('This workspace activation no longer owns its agents.');
					}
					this.options.connected?.(client);
					this.tellColours(client);
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
						if (!this.closed) {
							this.options.log('The connection to ptyd closed: agents keep running, and this window claims them again.');
							this.lose(this.own);
						}
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

	/** The connection to the ptyd at `socket` is lost: its runs are told so, and claimed again soon (RULES-3.1, 4.1). */
	private lose(socket: string): void {
		if (this.closed) {
			return;
		}
		this.lost = true;
		this.options.connectionLost(socket);
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
		// Its connection claims nothing any more: let go of, so that the ptyd holds no socket for a window that shows no run of it
		void this.connection?.then(client => client.dispose(), () => undefined);
		this.options.transferred();
	}

	/** One recovery batch at a time. A newer disconnect keeps its lost flag even when an older batch succeeds. */
	recover(hasRuns: boolean, restore: (client: PtydClient) => Promise<boolean>): Promise<void> {
		this.reclaiming ??= this.restore(hasRuns, restore).finally(() => this.reclaiming = undefined);
		return this.reclaiming;
	}

	/**
	 * Connects and claims again, whether or not runs are shown: ptyd ends an absent owner's runs, and its claim, five minutes after
	 * the window went (RULES-4.1), and this window is still here. A failed connection keeps the loss, tried again by the next check.
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

	/**
	 * Tells each ptyd that holds this window's runs the colours its terminals draw with now: its own, where it is connected, and those
	 * of earlier builds it holds - a reload into an update leaves its agents there, and a theme changed after must reach their
	 * programs too (ARCHITECTURE-2.3).
	 */
	coloursChanged(): void {
		void this.connection?.then(client => this.tellColours(client), () => undefined);
		for (const [socket, client] of this.earlierHeld) {
			if ((this.earlier.protocolOf(socket) ?? 0) >= COLOURS_PROTOCOL) {
				this.tellColours(client);
			}
		}
	}

	private tellColours(client: PtydClient): void {
		const colours = this.options.colours?.();
		if (colours) {
			void client.request('colours', colours).catch(err => this.options.log(`Could not tell ptyd the terminal colours: ${messageOf(err)}`));
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
