/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { CliInfo, CliListResult, LocationListResult, MachineInfo, MachinesChange } from '../../base/coreProtocol';
import { RouteExpired, withinRoute } from '../../base/routeBudget';
import type { MachineLaunch } from '../../ui/pickers/machineLaunch';
import { cliChoicesOf } from './ports';
import { machineSelector } from './references';
import { DaemonError, type DaemonLink } from './types';

const QUERY_MS = 3_000;

/** The editor reads the local core's machine table and asks the selected machine for its launch catalog (LIFECYCLE-1.1). */
export class RustMachines implements vscode.Disposable {
	private readonly rows = new Map<string, MachineInfo>();
	private readonly names = new Map<string, string>();
	private readonly remoteClis = new Map<string, readonly CliInfo[]>();
	private readonly changed = new vscode.EventEmitter<void>();
	private readonly subscriptions: vscode.Disposable;
	readonly onDidChange = this.changed.event;

	constructor(private readonly link: DaemonLink, private readonly icons: () => (cli: string) => string) {
		let bound = link.window;
		this.subscriptions = vscode.Disposable.from(this.changed, link.onDidBind(window => {
			if (window === bound) { return; }
			bound = window;
			this.rows.clear();
			this.names.clear();
			this.remoteClis.clear();
			// Let this binding's other listeners discard their previous window first.
			queueMicrotask(() => this.changed.fire());
		}), link.watch<readonly MachineInfo[], MachinesChange>('machines', {}, {
			snapshot: rows => {
				this.rows.clear();
			for (const row of rows) { this.keep(row); }
				this.changed.fire();
			},
			change: change => {
				if (change.kind === 'updated') {
				this.keep(change.machine);
				} else if (change.kind === 'removed') {
					this.rows.delete(change.machine_id);
					this.remoteClis.delete(change.machine_id);
				} else { return; }
				this.changed.fire();
			}
		}));
	}

	private keep(row: MachineInfo): void {
		this.rows.set(row.machine_id, row);
		this.names.set(row.machine_id, row.name);
	}

	name(machine: string): string {
		const id = machine.replace(/-/g, '').slice(0, 8);
		const name = this.names.get(machine);
		if (!name) { return id; }
		const duplicate = [...this.rows.values()].some(each => each.machine_id !== machine && each.name === name);
		return duplicate ? `${name} (${id})` : name;
	}

	choices(): ReturnType<MachineLaunch['machines']> {
		const id = this.link.machineId;
		return {
			local: { id, name: this.name(id) },
			others: [...this.rows.values()].filter(row => row.machine_id !== id).map(row => ({
				id: row.machine_id,
				name: this.name(row.machine_id),
				...row.route === undefined || !this.link.connected ? { unavailable: this.rows.get(id)?.connections.some(connection =>
					connection.machine_id === row.machine_id && connection.state === 'ssh_interaction_required')
					? 'ssh_interaction_required' as const : 'unavailable' as const } : {}
			}))
		};
	}

	clis(machine: string): readonly CliInfo[] {
		return this.remoteClis.get(machine) ?? [];
	}

	async catalog(machine: string): ReturnType<MachineLaunch['catalog']> {
		if (!this.link.connected) { throw new Error(vscode.l10n.t('Facade cannot do this right now')); }
		const window = this.link.window;
		const args = { machine: machineSelector(machine) };
		const locations = withinRoute(this.link.call<LocationListResult>('location.list', args), QUERY_MS).catch(() => undefined);
		const clis = await withinRoute(this.link.call<CliListResult>('cli.list', args), QUERY_MS).catch((error: unknown) => {
			if (error instanceof RouteExpired) { throw new Error(vscode.l10n.t('Facade cannot do this right now')); }
			throw error;
		});
		if (clis.settings_problem) { throw new DaemonError(clis.settings_problem, 'configuration_invalid', { reason: 'configuration_invalid' }); }
		const found = await locations;
		if (this.link.window !== window) { throw new Error(vscode.l10n.t('Facade cannot do this right now')); }
		this.remoteClis.set(machine, clis.clis);
		this.changed.fire();
		return {
			clis: cliChoicesOf(clis.clis, this.icons()),
			locations: (found?.locations ?? []).map(({ window: source, location }) => ({ source, cwd: location.path, label: location.label }))
		};
	}

	dispose(): void { this.subscriptions.dispose(); }
}
