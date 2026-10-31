/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agents an earlier Facade Code started that its own ptyd still holds after an update (ARCHITECTURE-2.4, VERIFICATION E05). An update
// raises ptyd's protocol, and a new ptyd cannot take an earlier one's processes; so this window claims them in that ptyd, as their
// workspace's newest activation, and shows each in a terminal of its own - its screen, typing and size, and ending it when its
// terminal is closed - until it ends. They keep working as they did, without the features of the newer version.

import * as path from 'path';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import type { OwnerClaim, RunEvent, RunInfo } from '../../ptyd/protocol';
import { earlierRuns, PtydClient, ptydSocketPath } from './ptydClient';

/** The protocol of the ptyd Facade Code 0.0.1 shipped: the earliest whose runs a newer window can claim. */
const EARLIEST_CLAIMABLE = 8;

/** How long a closed terminal's agent has to end on the hang-up before ptyd kills it (LIFECYCLE-4.2). */
const GRACE_MS = 3_000;

export interface EarlierAgentsOptions {
	readonly home: string;
	readonly owner: string;
	readonly claim: OwnerClaim;
	readonly ptydScript: string;
	readonly log: (line: string) => void;
	/** Whether the person confirms ending a live agent whose terminal they closed (LIFECYCLE-3.1). */
	readonly confirmClose: (agent: { readonly run: string; readonly label: string }) => Promise<boolean>;
}

/** The agents earlier versions' ptyds hold for this workspace, each in a terminal of its own. */
export class EarlierAgents implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly clients: PtydClient[] = [];
	private disposed = false;

	private constructor(private readonly options: EarlierAgentsOptions) { }

	/** Finds them and shows them; says once, in plain words, that they are there. None found, nothing is shown or said. */
	static async open(options: EarlierAgentsOptions): Promise<EarlierAgents> {
		const agents = new EarlierAgents(options);
		let shown = 0;
		for (const { protocol } of await earlierRuns(options.home, options.owner)) {
			if (protocol < EARLIEST_CLAIMABLE) {
				options.log(`Agents of a development build of ptyd protocol ${protocol} still run; this version cannot show them, and they were not ended.`);
				continue;
			}
			try {
				shown += await agents.claim(protocol);
			} catch (err) {
				options.log(`Could not show the agents a Facade Code of ptyd protocol ${protocol} still runs: ${messageOf(err)}`);
			}
		}
		if (shown) {
			void vscode.window.showInformationMessage(shown === 1
				? vscode.l10n.t("An agent started before Facade Code was updated is still running. It opens in its own terminal and works as before, without this version's new features.")
				: vscode.l10n.t("{0} agents started before Facade Code was updated are still running. They open in their own terminals and work as before, without this version's new features.", shown));
		}
		return agents;
	}

	dispose(): void {
		this.disposed = true;
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
		for (const client of this.clients.splice(0)) {
			client.dispose();
		}
	}

	/** Claims this workspace in the ptyd of `protocol` and shows its live agents; answers how many. */
	private async claim(protocol: number): Promise<number> {
		const { home } = this.options;
		const client = await PtydClient.connect(ptydSocketPath(home, protocol), this.options.ptydScript, path.join(home, 'ptyd', 'ptyd.log'), { protocol, start: false });
		this.clients.push(client);
		await client.request('claim', this.options.claim);
		const live = (await client.request('list', { owner: this.options.owner })).filter(run => !run.exited);
		let shown = 0;
		for (const run of live) {
			try {
				await this.show(client, run);
				shown++;
			} catch (err) {
				this.options.log(`Could not show the earlier agent ${run.run}: ${messageOf(err)}`);
			}
		}
		this.options.log(`Showing ${shown} agent${shown === 1 ? '' : 's'} that a Facade Code of ptyd protocol ${protocol} still runs.`);
		return shown;
	}

	/** One earlier agent in a terminal of its own: its screen as it stands, then what it writes, until it ends. */
	private async show(client: PtydClient, run: RunInfo): Promise<void> {
		const attached = await client.request('attach', { run: run.run });
		const meta = run.meta as { readonly name?: unknown; readonly alias?: unknown; readonly displayName?: unknown };
		const label = typeof meta.name === 'string' && meta.name ? meta.name : typeof meta.alias === 'string' ? meta.alias : run.run;
		const cli = typeof meta.displayName === 'string' ? meta.displayName : '';
		const writes = new vscode.EventEmitter<string>();
		const closes = new vscode.EventEmitter<number | void>();
		let seq = attached.seq;
		let ended = false;
		let closing = false;
		const events = client.onRunEvent(run.run, (event: RunEvent) => {
			if (event.event === 'output' && event.seq > seq) {
				seq = event.seq;
				writes.fire(event.data);
			} else if (event.event === 'exit') {
				ended = true;
				writes.fire(`\r\n${typeof event.signal === 'number'
					? vscode.l10n.t("[Agent process terminated by signal {0}]", String(event.signal))
					: vscode.l10n.t("[Agent process exited with code {0}]", String(event.exitCode))}\r\n`);
			}
		});
		const pty: vscode.Pseudoterminal = {
			onDidWrite: writes.event,
			onDidClose: closes.event,
			open: () => writes.fire(attached.screen),
			handleInput: data => {
				if (!ended) {
					void client.request('input', { run: run.run, data }).catch(err => this.options.log(`Could not type into the earlier agent ${run.run}: ${messageOf(err)}`));
				}
			},
			setDimensions: size => {
				if (!ended) {
					void client.request('resize', { run: run.run, cols: size.columns, rows: size.rows }).catch(() => undefined);
				}
			},
			close: () => {
				if (closing || this.disposed) {
					return;
				}
				closing = true;
				events.dispose();
				void (async () => {
					// Closing its terminal ends a live agent once the person confirms; kept, it opens again (LIFECYCLE-3.1)
					if (!ended && !await this.options.confirmClose({ run: run.run, label })) {
						await this.show(client, run).catch(err => this.options.log(`Could not show the earlier agent ${run.run} again: ${messageOf(err)}`));
						return;
					}
					try {
						if (!ended) {
							await client.request('terminate', { run: run.run, graceMs: GRACE_MS });
						}
						await client.request('forget', { run: run.run });
					} catch (err) {
						this.options.log(`Could not end the earlier agent ${run.run}: ${messageOf(err)}`);
					}
				})();
			}
		};
		const terminal = vscode.window.createTerminal({ name: cli ? `${label} · ${cli}` : label, pty, location: vscode.TerminalLocation.Editor });
		this.disposables.push(events, writes, closes, { dispose: () => { closing = true; terminal.dispose(); } });
	}
}
