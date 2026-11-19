/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { disposeAll } from '../../base/lifecycle';
import type {
	AgentListEntry, AgentRef, LegacyWorkspaceArgs, LegacyWorkspaceResult, ResumeResult, ResumeTarget,
	V3AgentInfo, V3AgentMachineState, V3AgentsChange, V3AgentsSnapshot, V3InspectResult, V3ResumeArgs, V3StartArgs, V3StartResult
} from '../../base/coreProtocol';
import type { LocationPort, LogPort, RunChange, RunError, RunFacts, RunId, RustPin } from '../../core/ports';
import { agentFacts, agentKey, failedPinFacts, referenceOf, referenceOfPin } from './agentFacts';
import { restoreRustPins } from './pinRestore';
import type { OrchestratorTerminals } from './terminals';
import { DaemonError, type OrchestratorLink } from './types';
import type { RustWorkspace, WorkspacePinFailure } from './workspace';

const INITIAL_TERMINAL_SIZE = { cols: 80, rows: 24 };

interface AgentDeps {
	readonly link: OrchestratorLink;
	readonly terminals: OrchestratorTerminals;
	readonly workspace: RustWorkspace;
	readonly locations: Pick<LocationPort, 'snapshot' | 'onDidChange'>;
	readonly onDidChangeMachineNames: vscode.Event<void>;
	readonly machineName: (machineId: string) => string | undefined;
	readonly environment: (folder: string | undefined) => Record<string, string>;
	readonly isHost: (machine: string | undefined) => boolean;
	readonly notifyError: (error: unknown) => void;
	readonly log: LogPort;
}

/** Joins the Orchestrator's records with the workspace's presentation (RULES-6.1). */
export class OrchestratorAgents implements vscode.Disposable {
	private readonly records = new Map<RunId, V3AgentInfo>();
	private readonly watchReferences = new Map<RunId, AgentRef>();
	private readonly absent = new Map<RunId, AgentRef>();
	private readonly changed = new vscode.EventEmitter<RunChange>();
	private readonly first = Promise.withResolvers<void>();
	private readonly subscriptions: vscode.Disposable[];
	private readonly attached = new Map<RunId, string>();
	private readonly failures = new Map<RunId, RunError>();
	private cards = new Map<RunId, RunFacts>();
	private pinRecovery?: Promise<unknown>;
	private recoveringHere = false;
	private pruning = false;
	private disconnected = false;
	private disposed = false;

	readonly onDidChange = this.changed.event;

	constructor(private readonly deps: AgentDeps) {
		this.captureWorkspaceMembers();
		this.subscriptions = [
			this.changed,
			deps.workspace.onDidChange(() => this.render()),
			deps.locations.onDidChange(() => this.render()),
			deps.onDidChangeMachineNames(() => this.render()),
			deps.link.onDidConnect(() => this.captureWorkspaceMembers()),
			deps.link.watch<V3AgentsSnapshot, V3AgentsChange>('agents', {}, {
				snapshot: view => this.snapshot(view),
				change: change => this.change(change),
				disconnected: () => {
					this.disconnected = true;
					this.render();
				},
				ended: error => {
					this.first.reject(error);
					deps.notifyError(error);
				}
			})
		];
	}

	async loadWorkspace(): Promise<boolean> {
		const [imported] = await Promise.all([this.importLegacy(), this.first.promise]);
		if (this.disposed) { return false; }
		this.pruning = imported;
		this.reconcile();
		return imported;
	}

	private async importLegacy(): Promise<boolean> {
		try {
			await this.deps.workspace.importLegacy({
				machineId: this.deps.link.machineId,
				load: (args: LegacyWorkspaceArgs) => this.deps.link.call<LegacyWorkspaceResult>('workspace.import_legacy', args)
			});
			return true;
		} catch (error) {
			if (!this.disposed) { this.deps.notifyError(error); }
			return false;
		}
	}

	list(): readonly RunFacts[] {
		return [...this.cards.values()];
	}

	get(run: RunId): RunFacts | undefined {
		return this.cards.get(run);
	}

	pins(): readonly RustPin[] {
		return this.deps.workspace.snapshot().pins;
	}

	async start(input: V3StartArgs): Promise<RunId> {
		const args: V3StartArgs = {
			...input,
			env: this.deps.isHost(input.machine) ? this.deps.environment(input.folder) : {},
			request_id: `start-${randomBytes(16).toString('hex')}`
		};
		await this.deps.link.call('agent.start_preflight', args);
		const result = await this.deps.link.call<V3StartResult>('agent.start', args);
		return this.show(result.agent);
	}

	async goTo(entry: AgentListEntry): Promise<RunId> {
		const record = await this.inspect(entry.reference);
		if (record.process !== 'running') {
			throw new Error(vscode.l10n.t('{0} has ended. Use Resume Agent to continue it.', record.address));
		}
		return this.show(record);
	}

	async resume(target: ResumeTarget): Promise<RunId> {
		const args: V3ResumeArgs = {
			...target,
			...INITIAL_TERMINAL_SIZE,
			...(this.deps.isHost(target.machine) ? { env: this.deps.environment(target.folder) } : {})
		};
		const { agent } = await this.deps.link.call<ResumeResult>('agent.resume', args);
		return this.show(agent);
	}

	async open(run: RunId): Promise<boolean> {
		const card = this.cards.get(run);
		if (!card?.orchestrator || card.lifecycle === 'ended') { return false; }
		const record = await this.inspect(card.orchestrator.reference);
		this.render();
		await this.attach(record);
		return true;
	}

	async hide(run: RunId): Promise<void> {
		const card = this.cards.get(run);
		if (!card?.orchestrator) { return; }
		this.deps.workspace.hide(card.orchestrator.reference);
		this.closeView(run);
	}

	async stop(run: RunId): Promise<void> {
		const reference = this.cards.get(run)?.orchestrator?.reference;
		if (!reference) { return; }
		await this.deps.link.call('agent.stop', { reference });
	}

	async remove(run: RunId): Promise<void> {
		const reference = this.cards.get(run)?.orchestrator?.reference;
		if (!reference) { return; }
		await this.deps.link.call('agent.remove', { reference });
		this.records.delete(run);
		this.deps.workspace.forget(reference);
		this.closeView(run);
	}

	async rename(run: RunId, name: string): Promise<void> {
		const reference = this.cards.get(run)?.orchestrator?.reference;
		if (!reference) { return; }
		await this.deps.link.call('agent.rename', { reference, name });
	}

	async setPinned(run: RunId, pinned: boolean): Promise<void> {
		const card = this.cards.get(run);
		if (!card) { return; }
		if (!pinned) {
			if (card.pin) { this.deps.workspace.removePin(card.pin); }
			return;
		}
		const record = this.records.get(run);
		if (!record?.session) {
			throw new Error(vscode.l10n.t('A Pin needs a saved session.'));
		}
		this.deps.workspace.savePin(this.pinFor(record));
	}

	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		this.first.resolve();
		disposeAll(this.subscriptions, error => this.deps.log.event(messageOf(error)));
	}

	/** The host keeps its connection while this window commits the shared outcome it started. */
	pendingPinRecovery(): Promise<unknown> | undefined {
		return this.recoveringHere ? this.pinRecovery : undefined;
	}

	private async show(record: V3AgentInfo): Promise<RunId> {
		const run = agentKey(record);
		this.remember(record);
		this.deps.workspace.show(referenceOf(record));
		this.reconcile();
		await this.attach(record);
		return run;
	}

	private async inspect(reference: AgentRef): Promise<V3AgentInfo> {
		const { agent } = await this.deps.link.call<V3InspectResult>('agent.inspect', { reference });
		this.remember(agent);
		return agent;
	}

	private async attach(record: V3AgentInfo, pinned = false): Promise<void> {
		if (this.disposed) { return; }
		if (record.process !== 'running') {
			throw new Error(vscode.l10n.t('{0} has ended. Use Resume Agent to continue it.', record.address));
		}
		const run = agentKey(record);
		const terminals = this.deps.terminals;
		if (this.attached.get(run) !== record.started_at) { this.closeView(run); }
		if (!this.attached.has(run)) {
			this.attached.set(run, record.started_at);
			terminals.openPair({
				run, name: record.name, cli: record.cli,
				displayName: record.cli,
				command: record.cli, cwd: record.cwd,
				...(pinned || this.cards.get(run)?.pin ? { pinned: true as const } : {})
			}, { reveal: false, hidden: true });
			terminals.bind(run, { ref: referenceOf(record), address: record.address }, !this.unreachable(record));
		}
		if (pinned) {
			await terminals.openPinned(run);
			terminals.pinnedOpened();
		} else if (!await terminals.reveal(run, { preserveFocus: false })) {
			throw new Error(vscode.l10n.t('Could not open the terminal for {0}.', record.address));
		}
		await terminals.attached(run);
	}

	private closeView(run: RunId): void {
		if (this.attached.delete(run)) { this.deps.terminals.removePair(run); }
	}

	async restorePins(): Promise<void> {
		if (this.disposed) { return; }
		const recovery = this.deps.workspace.restorePinsOnce(() => {
			this.recoveringHere = true;
			return this.recoverPins();
		});
		this.pinRecovery = recovery;
		const restored = await recovery.finally(() => {
			this.recoveringHere = false;
			this.pinRecovery = undefined;
		});
		if (this.disposed) { return; }
		const pins = this.pins();
		for (const failed of restored.failures) {
			const run = agentKey(failed.reference);
			if (pins.some(pin => pin.id === failed.id && agentKey(referenceOfPin(pin)) === run)) {
				this.failures.set(run, { reason: failed.reason, source: 'restore', at: Date.now() });
			}
		}
		this.render();
		for (const pin of pins) {
			if (this.disposed) { return; }
			const reference = referenceOfPin(pin);
			const run = agentKey(reference);
			const known = this.records.get(run);
			if (this.failures.has(run) && known?.process !== 'running') { continue; }
			try {
				const record = restored.performed ? known : await this.inspect(reference);
				if (record?.process === 'running') {
					this.failures.delete(run);
					await this.attach(record, true);
				}
			} catch (error) {
				this.deps.notifyError(error);
			}
		}
		this.render();
	}

	private async recoverPins(): Promise<readonly WorkspacePinFailure[]> {
		const failed: WorkspacePinFailure[] = [];
		await restoreRustPins(this.pins(), {
			lookup: async pin => {
				const reference = referenceOfPin(pin);
				try { return { agent: await this.inspect(reference) }; }
				catch (error) {
					if (error instanceof DaemonError && error.reason === 'not_found' && error.data.record_removal !== undefined) {
						this.records.delete(agentKey(reference));
						return { removal: error.data.record_removal };
					}
					throw error;
				}
			},
			resumeExisting: agent => this.restoreOn(agent.machine_id, { reference: agent.agent_id }, agent.cwd),
			resumeSession: pin => {
				if (!pin.conversation.sessionId) {
					throw new Error(vscode.l10n.t('This Pin has no saved session.'));
				}
				return this.restoreOn(pin.machine_id, { reference: `${pin.conversation.cli}:${pin.conversation.sessionId}`, folder: pin.cwd }, pin.cwd);
			},
			opened: async (pin, agent) => {
				if (!this.currentPin(pin)) { return; }
				this.remember(agent);
				this.deps.workspace.replacePin(pin, this.pinFor(agent, pin));
			},
			removed: pin => {
				if (this.currentPin(pin)) { this.deps.workspace.forget(referenceOfPin(pin)); }
			},
			expired: pin => {
				if (!this.currentPin(pin)) { return; }
				const reference = referenceOfPin(pin);
				if (this.records.has(agentKey(reference))) {
					this.deps.workspace.removePin(pin.id);
				} else {
					this.deps.workspace.forget(reference);
				}
				if (!this.disposed) {
					void vscode.window.showInformationMessage(vscode.l10n.t('Removed the Pin for {0} because its saved session is gone.', pin.name));
				}
			},
			failed: (pin, error) => {
				if (!this.currentPin(pin)) { return; }
				failed.push({ id: pin.id, reference: referenceOfPin(pin), reason: messageOf(error) });
			},
			isMissingSession: error => error instanceof DaemonError && error.reason === 'session_not_found'
		});
		return failed;
	}

	private async restoreOn(machineId: string, target: Pick<ResumeTarget, 'reference' | 'folder'>, folder: string): Promise<V3AgentInfo> {
		const args: V3ResumeArgs = {
			...target, machine_id: machineId, ...INITIAL_TERMINAL_SIZE,
			...(machineId === this.deps.link.machineId ? { env: this.deps.environment(folder) } : {})
		};
		return (await this.deps.link.call<ResumeResult>('agent.resume', args)).agent;
	}

	private currentPin(pin: RustPin): boolean {
		return this.pins().some(current => current.id === pin.id && current.machine_id === pin.machine_id && current.agent === pin.agent);
	}

	private pinFor(record: V3AgentInfo, previous?: RustPin): RustPin {
		return {
			id: previous?.id ?? `pin-${randomBytes(16).toString('hex')}`,
			machine_id: record.machine_id,
			agent: record.agent_id,
			location: this.cards.get(agentKey(record))?.location ?? previous?.location ?? record.cwd,
			cwd: record.cwd,
			name: record.name,
			conversation: {
				...previous?.conversation,
				environment: `machine:${record.machine_id}`,
				cli: record.cli,
				...(record.session ? { sessionId: record.session } : {})
			}
		};
	}

	private snapshot(view: V3AgentsSnapshot): void {
		this.disconnected = false;
		for (const [run, record] of this.records) {
			if (record.machine_id !== this.deps.link.machineId) {
				this.records.set(run, { ...record, unreachable: true });
			}
		}
		const local = this.deps.link.machineId;
		this.replaceRecords(local, view.agents.filter(record => record.machine_id === local));
		for (const record of view.agents) {
			if (record.machine_id !== local) { this.watchRecord(record); }
		}
		for (const machine of view.machines) { this.machineState(machine); }
		this.first.resolve();
		this.reconcile();
	}

	private change(change: V3AgentsChange): void {
		switch (change.kind) {
			case 'updated':
				this.watchRecord(change.agent);
				break;
			case 'removed': {
				const reference = referenceOf(change);
				const run = agentKey(reference);
				this.records.delete(run);
				this.watchReferences.delete(run);
				if (change.cause === 'removed') {
					this.absent.delete(run);
					this.deps.workspace.forget(reference);
				} else if (change.cause === 'expired') {
					this.absent.set(run, reference);
				}
				break;
			}
			case 'machine_state':
				this.machineState(change.machine);
				break;
		}
		this.reconcile();
	}

	private machineState(machine: V3AgentMachineState): void {
		if (machine.state === 'synced' && machine.agents) {
			this.replaceRecords(machine.machine_id, machine.agents);
		} else if (machine.state !== 'synced') {
			for (const [run, record] of this.records) {
				if (record.machine_id === machine.machine_id) {
					this.records.set(run, { ...record, unreachable: true });
				}
			}
		}
	}

	private replaceRecords(machineId: string, records: readonly V3AgentInfo[]): void {
		const present = new Set(records.map(agentKey));
		for (const [run, reference] of this.watchReferences) {
			if (reference.machine_id === machineId && !present.has(run)) {
				this.watchReferences.delete(run);
				this.absent.set(run, reference);
				this.records.delete(run);
			}
		}
		for (const record of records) { this.watchRecord(record); }
	}

	private captureWorkspaceMembers(): void {
		// The host's snapshot can confirm missing members that predate this watch. The daemon's
		// remote cache can lag a Start from another window, so only use remote records we observed.
		const local = this.deps.link.machineId;
		for (const reference of this.deps.workspace.snapshot().members) {
			if (reference.machine_id === local) {
				this.watchReferences.set(agentKey(reference), reference);
			}
		}
	}

	private watchRecord(record: V3AgentInfo): void {
		this.watchReferences.set(agentKey(record), referenceOf(record));
		this.remember(record);
	}

	private remember(record: V3AgentInfo): void {
		const run = agentKey(record);
		this.absent.delete(run);
		this.records.set(run, record);
	}

	private unreachable(record: V3AgentInfo): boolean {
		return this.disconnected || record.unreachable === true;
	}

	private reconcile(): void {
		const absent = this.pruning ? [...this.absent.values()] : [];
		this.deps.workspace.reconcile([...this.records.values()], absent);
		if (absent.length) { this.absent.clear(); }
		this.render();
	}

	private render(): void {
		const { members, pins } = this.deps.workspace.snapshot();
		const byRef = new Map(pins.map(pin => [agentKey(referenceOfPin(pin)), pin]));
		const locations = this.deps.locations.snapshot().locations;
		const next = new Map<RunId, RunFacts>();
		for (const reference of members) {
			const run = agentKey(reference);
			const record = this.records.get(run);
			const pin = byRef.get(run);
			const failure = pin && (!record || record.process === 'ended' || this.unreachable(record)) ? this.failures.get(run) : undefined;
			const machine = this.deps.machineName(reference.machine_id);
			if (record?.type === 'managed') {
				next.set(run, agentFacts(record, {
					locations, local: reference.machine_id === this.deps.link.machineId,
					disconnected: this.unreachable(record),
					...(machine !== undefined ? { machine } : {}),
					...(pin !== undefined ? { pin } : {}),
					...(failure !== undefined ? { failure } : {})
				}));
			} else if (pin && failure) {
				next.set(run, failedPinFacts(pin, failure, machine));
			}
		}
		const previous = this.cards;
		this.cards = next;
		for (const [run, startedAt] of this.attached) {
			const card = next.get(run);
			const record = this.records.get(run);
			if (!record || record.process === 'ended' || record.started_at !== startedAt || !card) {
				this.closeView(run);
			} else {
				this.deps.terminals.setReachable(run, !this.unreachable(record));
				if (previous.get(run)?.name !== record.name) { this.deps.terminals.rename(run, record.name); }
			}
		}
		for (const run of previous.keys()) {
			if (!next.has(run)) { this.changed.fire({ run, kind: 'removed', cause: 'close' }); }
		}
		for (const [run, card] of next) {
			const before = previous.get(run);
			if (!before) { this.changed.fire({ run, kind: 'added' }); }
			else if (before.lifecycle !== card.lifecycle || before.pin !== card.pin) { this.changed.fire({ run, kind: 'lifecycle' }); }
			else if (before.name !== card.name) { this.changed.fire({ run, kind: 'renamed' }); }
			else if (JSON.stringify(before) !== JSON.stringify(card)) { this.changed.fire({ run, kind: 'reported' }); }
		}
	}
}
