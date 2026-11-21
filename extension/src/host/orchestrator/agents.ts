/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { disposeAll } from '../../base/lifecycle';
import type { AgentRef, DaemonOperations, DaemonTopics } from '../../base/coreProtocol';
import type { LocationPort, LogPort, RunChange, RunError, RunFacts, RunId, RustPin } from '../../core/ports';
import { errorOf, unavailable } from '../rust/rpc';
import { agentFacts, agentKey, failedPinFacts, referenceOf, referenceOfPin } from './agentFacts';
import { restoreRustPins } from './pinRestore';
import type { OrchestratorTerminals } from './terminals';
import { DaemonError, type OrchestratorLink } from './types';
import type { RustWorkspace, WorkspacePinFailure } from './workspace';

type AgentInfo = DaemonOperations['agent.inspect']['result']['agent'];
type AgentListEntry = DaemonOperations['agent.list']['result']['agents'][number];
type ResumeCandidate = DaemonOperations['agent.resume_list']['result']['items'][number];
type ResumeTarget = DaemonOperations['agent.resume']['args']['target'];
type StartArgs = DaemonOperations['agent.start']['args'];
type AgentsSnapshot = DaemonTopics['agents']['snapshot'];
type AgentsChange = DaemonTopics['agents']['change'];
type AgentMachineState = AgentsSnapshot['machines'][number];

const INITIAL_TERMINAL_SIZE = { cols: 80, rows: 24 };
declare const FACADE_TEST_MODE: boolean;

function tracePinRestore(phase: string, detail: unknown): void {
	if (typeof FACADE_TEST_MODE !== 'undefined' && FACADE_TEST_MODE && process.env.FACADE_IT_WINDOW_CONTROL) {
		fs.appendFileSync(`${process.env.FACADE_IT_WINDOW_CONTROL}.pin-restore.log`, `${JSON.stringify({ at: Date.now(), phase, detail })}\n`);
	}
}

interface AgentDeps {
	readonly link: OrchestratorLink;
	readonly terminals: OrchestratorTerminals;
	readonly workspace: RustWorkspace;
	readonly locations: Pick<LocationPort, 'snapshot' | 'onDidChange'>;
	readonly onDidChangeMachineNames: vscode.Event<void>;
	readonly machineName: (machineId: string) => string | undefined;
	readonly environment: (folder: string | undefined) => Record<string, string>;
	readonly notifyError: (error: unknown) => void;
	readonly log: LogPort;
}

/** Joins the Orchestrator's records with the workspace's presentation (RULES-6.1). */
export class OrchestratorAgents implements vscode.Disposable {
	private readonly records = new Map<RunId, AgentInfo>();
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
			deps.link.watch('agents', {}, {
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
		const [imported] = await Promise.all([this.loadLocalPins(), this.first.promise]);
		if (this.disposed) { return false; }
		this.pruning = imported;
		this.reconcile();
		return imported;
	}

	private async loadLocalPins(): Promise<boolean> {
		try {
			return await this.deps.workspace.loadLocalPins();
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

	async start(input: StartArgs): Promise<RunId> {
		const args: StartArgs = {
			...input,
			env: input.scope?.kind === 'machine' ? undefined : this.deps.environment(input.folder),
			request_id: `start-${randomBytes(16).toString('hex')}`
		};
		const result = await this.deps.link.call('agent.start', args);
		return this.show(result.agent);
	}

	async goTo(entry: AgentListEntry): Promise<RunId> {
		const record = await this.inspect(entry.reference);
		if (record.process !== 'running') {
			throw new Error(vscode.l10n.t('{0} has ended. Use Resume Agent to continue it.', record.address));
		}
		return this.show(record);
	}

	async resume({ target, machine_id }: ResumeCandidate): Promise<RunId> {
		const folder = target.kind === 'session' ? target.folder : undefined;
		return this.show(await this.resumeOn(machine_id, target, folder));
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
		const { items: [item] } = await this.deps.link.call('agent.stop', { selection: { kind: 'targets', targets: [reference] } });
		if (item?.status === 'failed') { throw errorOf(item.error); }
		if (item?.status !== 'stopped') { throw unavailable('Facade core did not confirm that the agent stopped.'); }
	}

	async remove(run: RunId): Promise<void> {
		const reference = this.cards.get(run)?.orchestrator?.reference;
		if (!reference) { return; }
		await this.deps.link.call('agent.remove', { target: reference });
		this.records.delete(run);
		this.deps.workspace.forget(reference);
		this.closeView(run);
	}

	async rename(run: RunId, name: string): Promise<void> {
		const reference = this.cards.get(run)?.orchestrator?.reference;
		if (!reference) { return; }
		await this.deps.link.call('agent.rename', { target: reference, name });
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

	private async show(record: AgentInfo): Promise<RunId> {
		const run = agentKey(record.reference);
		this.remember(record);
		this.deps.workspace.show(record.reference);
		this.reconcile();
		await this.attach(record);
		return run;
	}

	private async inspect(reference: AgentRef): Promise<AgentInfo> {
		const { agent } = await this.deps.link.call('agent.inspect', { target: reference });
		this.remember(agent);
		return agent;
	}

	private async attach(record: AgentInfo, pinned = false): Promise<void> {
		if (this.disposed) { return; }
		if (record.process !== 'running') {
			throw new Error(vscode.l10n.t('{0} has ended. Use Resume Agent to continue it.', record.address));
		}
		const run = agentKey(record.reference);
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
			terminals.bind(run, { ref: record.reference, address: record.address }, !this.unreachable(record));
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
		tracePinRestore('start', this.pins().map(pin => pin.agent));
		const recovery = this.deps.workspace.restorePinsOnce(() => {
			tracePinRestore('recover', undefined);
			this.recoveringHere = true;
			return this.recoverPins();
		});
		this.pinRecovery = recovery;
		const restored = await recovery.finally(() => {
			this.recoveringHere = false;
			this.pinRecovery = undefined;
		}).catch(error => {
			tracePinRestore('recovery error', messageOf(error));
			throw error;
		});
		if (this.disposed) { return; }
		const pins = this.pins();
		tracePinRestore('shared outcome', { ...restored, pins: pins.map(pin => pin.agent) });
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
				tracePinRestore('record', { agent: pin.agent, process: record?.process, startedAt: record?.started_at });
				if (record?.process === 'running') {
					this.failures.delete(run);
					tracePinRestore('attach', pin.agent);
					await this.attach(record, true);
					tracePinRestore('attached', pin.agent);
				}
			} catch (error) {
				tracePinRestore('error', messageOf(error));
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
					const removal = error instanceof DaemonError && error.reason === 'not_found' && error.data.details?.record_removal;
					if (removal === 'expired' || removal === 'removed') {
						this.records.delete(agentKey(reference));
						return { removal };
					}
					throw error;
				}
			},
			resumeExisting: async agent => {
				try {
					return await this.resumeOn(agent.reference.machine_id, { kind: 'agent', reference: agent.reference }, agent.cwd);
				} catch (error) {
					if (!(error instanceof DaemonError) || error.reason !== 'unavailable') { throw error; }
					// A different workspace can resume this Agent between our lookup and resume.
					const current = await this.inspect(agent.reference).catch(() => undefined);
					if (current?.process === 'running') { return current; }
					throw error;
				}
			},
			resumeSession: pin => {
				if (!pin.conversation.sessionId) {
					throw new Error(vscode.l10n.t('This Pin has no saved session.'));
				}
				return this.resumeOn(pin.machine_id, {
					kind: 'session', machine_id: pin.machine_id, cli: pin.conversation.cli, session: pin.conversation.sessionId, folder: pin.cwd
				}, pin.cwd);
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

	private async resumeOn(machineId: string, target: ResumeTarget, folder?: string): Promise<AgentInfo> {
		const { agent } = await this.deps.link.call('agent.resume', {
			target, size: INITIAL_TERMINAL_SIZE,
			...(machineId === this.deps.link.machineId ? { env: this.deps.environment(folder) } : {})
		});
		return agent;
	}

	private currentPin(pin: RustPin): boolean {
		return this.pins().some(current => current.id === pin.id && current.machine_id === pin.machine_id && current.agent === pin.agent);
	}

	private pinFor(record: AgentInfo, previous?: RustPin): RustPin {
		const { machine_id, agent_id } = record.reference;
		return {
			id: previous?.id ?? `pin-${randomBytes(16).toString('hex')}`,
			machine_id,
			agent: agent_id,
			location: this.cards.get(agentKey(record.reference))?.location ?? previous?.location ?? record.cwd,
			cwd: record.cwd,
			name: record.name,
			conversation: {
				...previous?.conversation,
				environment: `machine:${machine_id}`,
				cli: record.cli,
				...(record.session ? { sessionId: record.session } : {})
			}
		};
	}

	private snapshot(view: AgentsSnapshot): void {
		this.disconnected = false;
		for (const [run, record] of this.records) {
			if (record.reference.machine_id !== this.deps.link.machineId) {
				this.records.set(run, { ...record, unreachable: true });
			}
		}
		const local = this.deps.link.machineId;
		this.replaceRecords(local, view.agents.filter(record => record.reference.machine_id === local));
		for (const record of view.agents) {
			if (record.reference.machine_id !== local) { this.watchRecord(record); }
		}
		for (const machine of view.machines) { this.machineState(machine); }
		this.first.resolve();
		this.reconcile();
	}

	private change(change: AgentsChange): void {
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

	private machineState(machine: AgentMachineState): void {
		if (machine.state === 'synced' && machine.agents) {
			this.replaceRecords(machine.machine_id, machine.agents);
		} else if (machine.state !== 'synced') {
			for (const [run, record] of this.records) {
				if (record.reference.machine_id === machine.machine_id) {
					this.records.set(run, { ...record, unreachable: true });
				}
			}
		}
	}

	private replaceRecords(machineId: string, records: readonly AgentInfo[]): void {
		const present = new Set(records.map(record => agentKey(record.reference)));
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

	private watchRecord(record: AgentInfo): void {
		this.watchReferences.set(agentKey(record.reference), record.reference);
		this.remember(record);
	}

	private remember(record: AgentInfo): void {
		const run = agentKey(record.reference);
		this.absent.delete(run);
		this.records.set(run, record);
	}

	private unreachable(record: AgentInfo): boolean {
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
				tracePinRestore('close view', { run, startedAt, process: record?.process, recordStartedAt: record?.started_at, card: !!card });
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
