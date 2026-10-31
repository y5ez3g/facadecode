/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { monotonic } from '../base/clock';
import { messageOf } from '../base/errors';
import { displayLine } from '../base/text';
import { invalid } from './errors';
import type { HumanContactPort, InboxPage, InboxQuery, InputEffects, InputPort, MessageRecord, Messages, SendRequest, SendResult } from './messagePorts';
import type { Agents, Clock, Disposable, LogPort, RunChange, RunId } from './ports';

/** The message records, kept in the execution environment's Facade directory for thirty days (RULES-5.3, ARCHITECTURE-3.1). */
export interface MessageStore {
	/** Every record kept, oldest first. */
	list(): readonly MessageRecord[];
	/** Writes a new record; throws where one of its ID is kept already, which is never written over (RULES-1.1). */
	create(record: MessageRecord): void;
	/** Writes `record` whole, in place of the one with its ID. */
	put(record: MessageRecord): void;
}

/** Message numbers: `m-N`, shown `#mN`, unique and never reused (RULES-1.1). */
export interface MessageIdPort {
	next(): number;
}

/** Where a Facade result goes when the message's sender is in another window of this computer (RULES-1.7, COLLABORATION-1.1). */
export interface ResultRoute {
	/** True once that window took it; false where it could not be reached, and the result then ends quietly. */
	report(window: string, result: { readonly to: RunId; readonly about: MessageRecord; readonly text: string; readonly callId?: string }): Promise<boolean>;
}

export interface MessageServiceDeps {
	readonly agents: Pick<Agents, 'get' | 'onDidChange'>;
	readonly input: InputPort;
	readonly human: HumanContactPort;
	readonly store: MessageStore;
	/** Copies of messages this window's agents sent to other windows' agents, for Message History (COLLABORATION-3.2). */
	readonly sent?: MessageStore;
	/** Carries results to senders in other windows; none, and such a result ends quietly. */
	readonly results?: ResultRoute;
	readonly ids: MessageIdPort;
	/** Epoch milliseconds, for the times records keep. */
	readonly clock: Clock;
	/** This window: its ID, which records keep, and its label, which the message header shows (COLLABORATION-2.1). */
	readonly window: { readonly id: string; readonly label: string };
	readonly environment: string;
	/** The workspace whose Message History shows this window's records, across reloads and later openings (COLLABORATION-3.2). */
	readonly workspace: string;
	readonly log: LogPort;
	/** The clock attempt slots and deadlines are held on: this process's monotonic one (ARCHITECTURE-2.3). */
	readonly monotonic?: () => number;
	/** Waits `ms`, rejecting as soon as `signal` aborts. */
	readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The first response comes within this long of the request reaching Facade (RULES-1.2). */
export const RESPONSE_BUDGET_MS = 2_000;
/** Each delivery stage - the message, then any Facade result - has five attempts, three seconds apart, within fifteen (RULES-1.5). */
export const STAGE_MS = 15_000;
export const SLOT_MS = 3_000;
export const ATTEMPTS = 5;

/** How a stage ended. */
interface Outcome {
	readonly status: 'success' | 'failure';
	readonly reason?: string;
	readonly effects: InputEffects;
	readonly attempts: number;
	/** How a successful stage delivered it: into the terminal, or handed back by the recipient's read_messages (COLLABORATION-3.1). */
	readonly via?: 'terminal' | 'read';
}

/** What one attempt found or did. */
type Attempt =
	| { readonly kind: 'submitted'; readonly effects: InputEffects }
	| { readonly kind: 'blocked'; readonly obstacle: string }
	| { readonly kind: 'ended' }
	| { readonly kind: 'expired' };

/** A delivery stage under way to one run: what it found so far, and how it is stopped. */
interface Stage {
	readonly target: RunId;
	/** The record it delivers. */
	readonly message: string;
	readonly stop: AbortController;
	/** Its outcome where something other than an attempt settled it: the recipient's read_messages delivered the record meanwhile. */
	settled?: Outcome;
	attempts: number;
	obstacle?: string;
	/** The most telling input effects of its attempts so far (RULES-1.6): never forgotten by a later attempt that wrote nothing. */
	effects: InputEffects;
	/** Whether an attempt is pasting now: cut off by the deadline or a close, what it wrote is not known. */
	submitting: boolean;
}

const NO_EFFECTS: InputEffects = { outcome: 'none', text_written: 'none', enter_written: false };
/** A delivery not yet tried: nothing written so far (MCP-4.1's accepted effects). */
const PENDING: MessageRecord['delivery'] = { status: 'pending', effects: { outcome: 'pending', text_written: 'none', enter_written: false }, attempts: 0 };
const UNKNOWN_EFFECTS: InputEffects = { outcome: 'unknown', text_written: 'unknown', enter_written: null };

const OBSTACLES = { draft: 'input_draft', interaction: 'input_interaction', unknown: 'input_unknown' } as const;

/** Why delivery did not succeed, as a Facade result says it. */
const REASONS: { readonly [reason: string]: string } = {
	input_draft: 'a draft stayed in its input until the deadline',
	input_interaction: 'its CLI showed a menu, sign-in or permission question until the deadline',
	input_unknown: 'its input could not be read until the deadline',
	partial_input: 'only part of the message went into its input',
	submission_unconfirmed: 'its CLI did not confirm the submission',
	timeout: 'the delivery deadline passed',
	ended: 'the agent ended or was closed',
	unsupported: 'Facade cannot read the message input of its CLI'
};

/**
 * Agent messages (RULES-1, COLLABORATION-2-4): every send is recorded at once with its own ID, then given to its one recipient - the
 * person in this window by notification, or a run's CLI as one paste and Enter, never over a draft or into a menu, in at most five
 * attempts within fifteen seconds. The first response comes within two seconds; an accepted send's outcome goes back to its sender as
 * a Facade result with its own budget, and ends quietly where it cannot. Attempts for one terminal never run side by side.
 */
export class MessageService implements Messages, Disposable {
	private readonly listeners = new Set<(record: MessageRecord) => void>();
	private readonly subscriptions: Disposable[] = [];
	/** Records whose delivery is under way here: the current version of each, ahead of what was read from the store. */
	private readonly live = new Map<string, MessageRecord>();
	private readonly stages = new Set<Stage>();
	/** Each terminal's attempts, one after another (RULES-1.10). */
	private readonly lanes = new Map<RunId, Promise<void>>();
	private readonly mono: () => number;
	private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
	private disposed = false;

	readonly onDidRecord = (listener: (record: MessageRecord) => void): Disposable => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	constructor(private readonly deps: MessageServiceDeps) {
		this.mono = deps.monotonic ?? monotonic;
		this.wait = deps.wait ?? timeout;
		this.subscriptions.push(deps.agents.onDidChange(change => this.changed(change)));
	}

	/** Stops this window's deliveries without recording an outcome: a reload is not closure, and expired ones are settled on reading. */
	dispose(): void {
		this.disposed = true;
		for (const stage of this.stages) {
			stage.stop.abort();
		}
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.listeners.clear();
	}

	async send(request: SendRequest): Promise<SendResult> {
		// Queueing and forwarding before Facade had it spent the same budgets, and so does making its record (RULES-1.2, 1.5)
		const elapsed = Math.max(0, request.elapsedMs);
		const start = this.mono() - elapsed;
		const deadline = this.deps.clock.now() - elapsed + STAGE_MS;
		const record = this.create({
			kind: 'message',
			from: request.sender?.party ?? this.party(request.from),
			to: request.to === '@human' ? { run: '@human' } : this.party(request.to),
			text: request.text,
			...(request.replyTo !== undefined ? { replyTo: request.replyTo } : {}),
			...(request.sender ? { fromWindow: request.sender.window } : {})
		}, PENDING, true, request.id);
		if (request.to === '@human') {
			return this.contact(record);
		}
		const target = this.deps.agents.get(request.to);
		if (!target || target.lifecycle === 'ended') {
			return this.failed(record, 'ended', NO_EFFECTS);
		}
		const capability = this.deps.input.capability(request.to);
		if (capability.state !== 'supported') {
			// A permanent obstacle: nothing is typed and no slot is waited out (MCP-1.2, RULES-1.5)
			this.deps.log.event(`Message ${record.alias} to ${target.alias} not delivered: its ordinary input is ${capability.state} (${capability.reason})`);
			return this.failed(record, 'unsupported', NO_EFFECTS);
		}
		const pending = this.update(record.id, { delivery: { ...record.delivery, deadline } });
		const stage = this.newStage(request.to, pending.id);
		const delivered = this.stage(stage, pending, formatMessage(pending, request.sender?.label ?? this.deps.window.label), start);
		const first = await this.within(delivered, RESPONSE_BUDGET_MS - (this.mono() - start));
		if (first !== 'deadline') {
			return { record: this.finish(pending.id, first) ?? pending, status: first.status, ...(first.reason ? { reason: first.reason } : {}) };
		}
		const accepted = this.live.get(pending.id) ?? pending;
		this.deps.log.event(`Message ${accepted.alias} to ${target.alias} accepted${stage.obstacle ? ` (${stage.obstacle})` : ''}; delivery goes on until ${new Date(accepted.delivery.deadline!).toISOString()}`);
		void delivered.then(outcome => {
			const final = this.finish(pending.id, outcome);
			if (final && !this.disposed) {
				this.reportOutcome(final, request.callId);
			}
		});
		return {
			record: accepted,
			status: 'accepted',
			...(stage.obstacle ? { obstacle: stage.obstacle } : {})
		};
	}

	allocate(request: { readonly from: RunId; readonly text: string; readonly party?: MessageRecord['from']; readonly label?: string }): { readonly id: string; readonly text: string } {
		const n = this.deps.ids.next();
		// The header names the sender's window: another window's, for a sender whose call was routed here (COLLABORATION-2.1)
		return { id: `m-${n}`, text: formatMessage({ alias: `#m${n}`, from: request.party ?? this.party(request.from), text: request.text }, request.label ?? this.deps.window.label) };
	}

	recordPrompt(request: Omit<SendRequest, 'elapsedMs'>, delivery: MessageRecord['delivery']): MessageRecord {
		return this.create({
			kind: 'message',
			from: request.sender?.party ?? this.party(request.from),
			...(request.sender ? { fromWindow: request.sender.window } : {}),
			to: request.to === '@human' ? { run: '@human' } : this.party(request.to),
			text: request.text,
			...(request.replyTo !== undefined ? { replyTo: request.replyTo } : {})
		}, delivery, true, request.id);
	}

	report(request: { readonly to: RunId; readonly callId?: string; readonly agent?: RunId; readonly agentParty?: MessageRecord['agent']; readonly about?: string; readonly text: string }): MessageRecord {
		const record = this.create({
			kind: 'result',
			from: { run: 'facade' },
			to: this.party(request.to),
			text: request.text,
			...(request.about !== undefined ? { about: request.about } : {}),
			...(request.callId !== undefined ? { callId: request.callId } : {}),
			...(request.agentParty !== undefined ? { agent: request.agentParty } : request.agent !== undefined ? { agent: this.party(request.agent) } : {})
		}, PENDING);
		return this.handOver(record, formatResult(record));
	}

	keepSent(record: MessageRecord): void {
		if (!this.deps.sent) {
			return;
		}
		try {
			this.deps.sent.put(record);
		} catch (err) {
			this.deps.log.event(`Could not keep a copy of message ${record.alias}: ${messageOf(err)}`);
		}
		this.emit(record);
	}

	inbox(run: RunId, query: InboxQuery): InboxPage {
		const mine = this.records().filter(record => record.to.run === run);
		if (query.ids) {
			const found = new Map<string, MessageRecord>();
			const missing: string[] = [];
			for (const asked of query.ids) {
				const id = messageIdOf(asked);
				const record = id ? mine.find(each => each.id === id) : undefined;
				if (record) {
					found.set(record.id, record);
				} else {
					missing.push(asked);
				}
			}
			return { records: [...found.values()].sort(byAge), missing };
		}
		const after = query.cursor === undefined ? 0 : cursorNumber(query.cursor);
		// Without IDs or `all`, what has not reached the run yet: pending, failed or not confirmed (COLLABORATION-3.1)
		const rest = mine.filter(record => (query.all || record.delivery.status !== 'success') && numberOf(record.id) > after);
		const page = rest.slice(0, Math.max(1, query.limit));
		return {
			records: page,
			...(rest.length > page.length ? { nextCursor: `after-${page[page.length - 1].id}` } : {}),
			missing: []
		};
	}

	markDelivered(run: RunId, ids: readonly string[]): void {
		const wanted = new Set(ids.map(messageIdOf).filter((id): id is string => !!id));
		if (!wanted.size) {
			return;
		}
		const at = this.deps.clock.now();
		for (const record of this.records()) {
			if (record.to.run !== run || !wanted.has(record.id) || record.delivery.status === 'success') {
				continue;
			}
			const stage = [...this.stages].find(each => each.message === record.id);
			if (stage) {
				// Still being delivered: its stage ends now as delivered, and whoever waits for it reports that (RULES-1.7)
				stage.settled = { status: 'success', effects: stage.effects, attempts: stage.attempts, via: 'read' };
				stage.stop.abort();
				continue;
			}
			// Failed already, or left pending by a window that went: delivered now, and nobody is told again (RULES-1.7)
			this.live.delete(record.id);
			this.save({ ...record, delivery: { ...record.delivery, status: 'success', via: 'read', deliveredAt: at } });
			this.deps.log.event(`${record.kind === 'result' ? 'Facade result' : 'Message'} ${record.alias} delivered to ${record.to.alias ?? record.to.run} by its read_messages`);
		}
	}

	history(): readonly MessageRecord[] {
		const here = (party: MessageRecord['from'] | MessageRecord['to']) => party.run !== 'facade' && party.run !== '@human' && !!this.deps.agents.get(party.run);
		const records = this.records();
		const kept = new Set(records.map(record => record.id));
		// A copy of a message sent to another window, where this environment does not keep the message itself (COLLABORATION-3.2)
		const copies = (this.deps.sent?.list() ?? []).filter(copy => !kept.has(copy.id));
		return [...records, ...copies].sort(byAge).filter(record => record.workspace === this.deps.workspace || here(record.from) || here(record.to));
	}

	// -----------------------------------------------------------------------------------------------------------------------
	// Delivery

	/** `@human`: a notification in this window; success is its handoff to the editor (COLLABORATION-2.3). */
	private contact(record: MessageRecord): SendResult {
		let handed = false;
		try {
			handed = this.deps.human.contact(record, id => this.records().find(each => each.id === id));
		} catch (err) {
			this.deps.log.event(`Message ${record.alias} to @human: the notification could not be shown: ${messageOf(err)}`);
		}
		if (!handed) {
			return this.failed(record, 'window_unavailable', NO_EFFECTS);
		}
		const final = this.update(record.id, { delivery: { status: 'success', effects: { outcome: 'confirmed' }, attempts: 1, via: 'notification', deliveredAt: this.deps.clock.now() } });
		this.live.delete(record.id);
		this.deps.log.event(`Message ${record.alias} from ${record.from.alias ?? record.from.run} shown to the person`);
		return { record: final, status: 'success' };
	}

	private failed(record: MessageRecord, reason: string, effects: InputEffects): SendResult {
		const final = this.update(record.id, { delivery: { ...record.delivery, status: 'failure', reason, effects } });
		this.live.delete(record.id);
		if (reason !== 'unsupported') {
			this.deps.log.event(`Message ${record.alias} to ${record.to.alias ?? record.to.run} not delivered: ${reason}`);
		}
		return { record: final, status: 'failure', reason };
	}

	/**
	 * The Facade result of an accepted send, once its outcome is known (RULES-1.7): a record in the sender's inbox, about the original,
	 * given to the sender's terminal with a budget of its own. It is never the original again, and nobody hears of it going astray.
	 */
	private reportOutcome(original: MessageRecord, callId: string | undefined): void {
		if (original.from.run === 'facade') {
			return;
		}
		if (original.fromWindow !== undefined) {
			// Its sender is in another window: the result is that window's to give, and goes nowhere else if it cannot (RULES-1.7)
			const results = this.deps.results;
			void (results ? results.report(original.fromWindow, { to: original.from.run as RunId, about: original, text: resultText(original, this.cliOf(original.to.run)), ...(callId !== undefined ? { callId } : {}) }) : Promise.resolve(false))
				.then(taken => {
					if (!taken) {
						this.deps.log.event(`The Facade result about ${original.alias} could not reach its sender's window, and ends there`);
					}
				}, err => this.deps.log.event(`The Facade result about ${original.alias} could not reach its sender's window: ${messageOf(err)}`));
			return;
		}
		const record = this.create({
			kind: 'result',
			from: { run: 'facade' },
			to: original.from,
			about: original.id,
			text: resultText(original, this.cliOf(original.to.run)),
			...(callId !== undefined ? { callId } : {})
		}, PENDING, false);
		this.handOver(record, formatResult(record));
	}

	/**
	 * Gives a Facade result to its run's terminal, or ends it quietly: no person and no other agent is told (RULES-1.7, 1.8). Answers
	 * the record as it is now.
	 */
	private handOver(record: MessageRecord, text: string): MessageRecord {
		const run = record.to.run as RunId;
		const facts = this.deps.agents.get(run);
		const capability = facts && facts.lifecycle !== 'ended' ? this.deps.input.capability(run) : undefined;
		if (!capability || capability.state !== 'supported') {
			return this.finish(record.id, { status: 'failure', reason: capability ? 'unsupported' : 'ended', effects: NO_EFFECTS, attempts: 0 }) ?? record;
		}
		const deadline = this.deps.clock.now() + STAGE_MS;
		const pending = this.update(record.id, { delivery: { ...record.delivery, deadline } });
		void this.stage(this.newStage(run, record.id), pending, text, this.mono()).then(outcome => this.finish(record.id, outcome));
		return pending;
	}

	private newStage(target: RunId, message: string): Stage {
		const stage: Stage = { target, message, stop: new AbortController(), attempts: 0, effects: NO_EFFECTS, submitting: false };
		this.stages.add(stage);
		return stage;
	}

	/**
	 * One delivery stage (RULES-1.4-1.6): an attempt at its start and 3, 6, 9 and 12 seconds on, each looking at the input first and
	 * pasting the whole text with Enter only into a usable composer. A confirmed submission ends it; a draft, a menu or unknown input
	 * spends the slot; an ended run ends it at once. A slot that went by during an attempt is not made up for. At the deadline, input
	 * not yet started is dropped and what went in is reported.
	 */
	private async stage(stage: Stage, record: MessageRecord, text: string, start: number): Promise<Outcome> {
		const deadline = start + STAGE_MS;
		try {
			for (let slot = 0; slot < ATTEMPTS;) {
				const due = start + slot * SLOT_MS - this.mono();
				if (due > 0) {
					await this.wait(due, stage.stop.signal);
				}
				if (stage.stop.signal.aborted) {
					return this.ended(stage);
				}
				if (this.mono() >= deadline) {
					break;
				}
				// Input not yet gone in when the deadline passes or the run ends is not sent (RULES-1.5)
				const cutoff = new AbortController();
				const attempt = await this.within(this.lane(stage.target, () => this.attempt(stage, text, deadline, cutoff.signal)), deadline - this.mono(), stage.stop.signal);
				if (attempt === 'deadline') {
					cutoff.abort();
					if (stage.submitting) {
						// Cut off while it pasted: what went in is not known
						stage.attempts++;
						stage.effects = UNKNOWN_EFFECTS;
					}
					if (stage.stop.signal.aborted) {
						return this.ended(stage);
					}
					break;
				}
				if (attempt.kind === 'ended') {
					return this.ended(stage);
				}
				if (attempt.kind === 'expired') {
					break;
				}
				stage.attempts++;
				if (attempt.kind === 'submitted') {
					if (attempt.effects.outcome === 'confirmed') {
						return { status: 'success', effects: attempt.effects, attempts: stage.attempts, via: 'terminal' };
					}
					stage.effects = telling(stage.effects, attempt.effects);
					stage.obstacle = undefined;
				} else {
					stage.obstacle = attempt.obstacle;
				}
				this.progress(record.id, stage);
				slot = Math.max(slot + 1, Math.ceil((this.mono() - start) / SLOT_MS));
			}
			// The slots are spent: the outcome is the deadline's, as the accepted response said, unless the run ends first
			const left = deadline - this.mono();
			if (left > 0) {
				await this.wait(left, stage.stop.signal);
			}
			return { status: 'failure', reason: finalReason(stage), effects: stage.effects, attempts: stage.attempts };
		} catch {
			// Its wait was stopped: the run ended or was closed, or this window's service went
			return this.ended(stage);
		} finally {
			this.stages.delete(stage);
		}
	}

	/** A stage stopped before its deadline: delivered meanwhile by the recipient's read, or its run ended or was closed. */
	private ended(stage: Stage): Outcome {
		return stage.settled ?? { status: 'failure', reason: 'ended', effects: stage.effects, attempts: stage.attempts };
	}

	/** One attempt, in its terminal's turn: nothing once the run ended or the deadline passed while it waited (RULES-1.5, 1.10). */
	private async attempt(stage: Stage, text: string, deadline: number, cutoff: AbortSignal): Promise<Attempt> {
		if (!this.usable(stage)) {
			return { kind: 'ended' };
		}
		if (this.mono() >= deadline) {
			return { kind: 'expired' };
		}
		let input: Awaited<ReturnType<InputPort['inspect']>>;
		try {
			input = await this.deps.input.inspect(stage.target);
		} catch (err) {
			this.deps.log.event(`Could not read ${stage.target}'s input: ${messageOf(err)}`);
			input = 'unknown';
		}
		if (input !== 'usable') {
			return { kind: 'blocked', obstacle: OBSTACLES[input] ?? 'input_unknown' };
		}
		if (!this.usable(stage)) {
			return { kind: 'ended' };
		}
		if (this.mono() >= deadline) {
			return { kind: 'expired' };
		}
		stage.submitting = true;
		try {
			return { kind: 'submitted', effects: await this.deps.input.submit(stage.target, text, cutoff) };
		} catch (err) {
			this.deps.log.event(`Input to ${stage.target} did not answer what went in: ${messageOf(err)}`);
			return { kind: 'submitted', effects: UNKNOWN_EFFECTS };
		} finally {
			stage.submitting = false;
		}
	}

	private usable(stage: Stage): boolean {
		const facts = this.deps.agents.get(stage.target);
		return !stage.stop.signal.aborted && !!facts && facts.lifecycle !== 'ended';
	}

	/** Runs `attempt` once the terminal's earlier attempts are done; waiting renews no deadline (RULES-1.10). */
	private lane<T>(target: RunId, attempt: () => Promise<T>): Promise<T> {
		const before = this.lanes.get(target) ?? Promise.resolve();
		const turn = before.then(attempt);
		const after = turn.then(() => undefined, () => undefined);
		this.lanes.set(target, after);
		void after.then(() => {
			if (this.lanes.get(target) === after) {
				this.lanes.delete(target);
			}
		});
		return turn;
	}

	/** `promise`, or `deadline` once `ms` passed first; a stop ends the wait as the deadline would. */
	private async within<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | 'deadline'> {
		const done = new AbortController();
		const stop = () => done.abort();
		signal?.addEventListener('abort', stop, { once: true });
		try {
			return await Promise.race([promise, this.wait(Math.max(0, ms), done.signal).then(() => 'deadline' as const, () => 'deadline' as const)]);
		} finally {
			signal?.removeEventListener('abort', stop);
			done.abort();
		}
	}

	private changed(change: RunChange): void {
		if (change.kind !== 'removed' && change.kind !== 'lifecycle') {
			return;
		}
		const facts = this.deps.agents.get(change.run);
		if (change.kind === 'removed' || !facts || facts.lifecycle === 'ended') {
			// Closing a run stops what was on its way to it (RULES-1.4, 1.9)
			for (const stage of this.stages) {
				if (stage.target === change.run) {
					stage.stop.abort();
				}
			}
		}
	}

	// -----------------------------------------------------------------------------------------------------------------------
	// Records

	/**
	 * A new record with its own ID (RULES-1.1) - the one `allocate` took for it, where given - written before any input and never over
	 * another; throws where it cannot be written, unless `required` is false.
	 */
	private create(fields: Pick<MessageRecord, 'kind' | 'from' | 'to' | 'text' | 'replyTo' | 'about' | 'callId' | 'agent' | 'fromWindow'>, delivery: MessageRecord['delivery'], required = true, id?: string): MessageRecord {
		const given = id !== undefined ? messageIdOf(id) : undefined;
		if (id !== undefined && (given === undefined || given !== id)) {
			throw new Error(`${JSON.stringify(id)} is not a message ID.`);
		}
		const n = given !== undefined ? numberOf(given) : this.deps.ids.next();
		const record: MessageRecord = {
			id: `m-${n}`,
			alias: `#m${n}`,
			kind: fields.kind,
			from: fields.from,
			to: fields.to,
			window: this.deps.window.id,
			environment: this.deps.environment,
			...(fields.fromWindow !== undefined ? { fromWindow: fields.fromWindow } : {}),
			workspace: this.deps.workspace,
			at: this.deps.clock.now(),
			...(fields.replyTo !== undefined ? { replyTo: fields.replyTo } : {}),
			...(fields.about !== undefined ? { about: fields.about } : {}),
			...(fields.callId !== undefined ? { callId: fields.callId } : {}),
			...(fields.agent !== undefined ? { agent: fields.agent } : {}),
			text: fields.text,
			length: [...fields.text].length,
			delivery
		};
		try {
			this.deps.store.create(record);
		} catch (err) {
			this.deps.log.event(`Could not record message ${record.alias}: ${messageOf(err)}`);
			if (required) {
				throw err;
			}
		}
		if (delivery.status === 'pending') {
			this.live.set(record.id, record);
		}
		this.emit(record);
		return record;
	}

	/** The record's current version with `changes`, written and told. */
	private update(id: string, changes: Partial<MessageRecord>): MessageRecord {
		const current = this.live.get(id) ?? this.deps.store.list().find(record => record.id === id);
		if (!current) {
			throw new Error(`No message ${id}.`);
		}
		return this.save({ ...current, ...changes });
	}

	private save(record: MessageRecord): MessageRecord {
		if (this.live.has(record.id)) {
			this.live.set(record.id, record);
		}
		if (!this.disposed) {
			try {
				this.deps.store.put(record);
			} catch (err) {
				this.deps.log.event(`Could not record message ${record.alias}: ${messageOf(err)}`);
			}
			this.emit(record);
		}
		return record;
	}

	private progress(id: string, stage: Stage): void {
		const current = this.live.get(id);
		if (current && !this.disposed) {
			const written = stage.effects.outcome === 'none' ? current.delivery.effects : { ...stage.effects, outcome: 'pending' as const };
			this.save({ ...current, delivery: { ...current.delivery, attempts: stage.attempts, effects: written } });
		}
	}

	/** Records the stage's outcome; answers the final record, or none where this window's service went meanwhile. */
	private finish(id: string, outcome: Outcome): MessageRecord | undefined {
		const current = this.live.get(id);
		if (!current || this.disposed) {
			return undefined;
		}
		const final = this.save({
			...current,
			delivery: {
				status: outcome.status,
				...(outcome.reason ? { reason: outcome.reason } : {}),
				effects: outcome.effects,
				...(current.delivery.deadline !== undefined ? { deadline: current.delivery.deadline } : {}),
				attempts: outcome.attempts,
				...(outcome.status === 'success' ? { via: outcome.via ?? 'terminal', deliveredAt: this.deps.clock.now() } : {})
			}
		});
		this.live.delete(id);
		const what = current.kind === 'result' ? 'Facade result' : 'Message';
		const how = outcome.via === 'read' ? 'delivered by its read_messages' : 'submitted';
		this.deps.log.event(`${what} ${current.alias} to ${current.to.alias ?? current.to.run}: ${outcome.status === 'success' ? how : `not delivered (${outcome.reason})`} after ${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'}`);
		return final;
	}

	/**
	 * Every record kept, oldest first, those under way here as they are now. A pending one past its deadline that nothing here delivers
	 * - its window reloaded or closed meanwhile - ended with its deadline, and is settled as such (RULES-1.9).
	 */
	private records(): readonly MessageRecord[] {
		const now = this.deps.clock.now();
		return this.deps.store.list().map(stored => {
			const record = this.live.get(stored.id) ?? stored;
			if (record.delivery.status !== 'pending' || this.live.has(record.id) || record.delivery.deadline === undefined || record.delivery.deadline > now) {
				return record;
			}
			const effects: InputEffects = record.delivery.attempts ? { ...record.delivery.effects, outcome: 'unknown' } : NO_EFFECTS;
			return this.save({ ...record, delivery: { ...record.delivery, status: 'failure', reason: 'timeout', effects } });
		});
	}

	/** The recipient's CLI and the version its installation says, as a failed read of its input names them. */
	private cliOf(run: RunId | '@human'): string | undefined {
		const facts = run === '@human' ? undefined : this.deps.agents.get(run);
		return facts ? `${facts.displayName}${facts.version ? ` ${facts.version}` : ''}` : undefined;
	}

	private party(run: RunId): { readonly run: RunId; readonly alias?: string; readonly name?: string } {
		const facts = this.deps.agents.get(run);
		return facts ? { run, alias: facts.alias, name: facts.name } : { run };
	}

	private emit(record: MessageRecord): void {
		for (const listener of [...this.listeners]) {
			listener(record);
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------------------
// What a recipient's CLI is given (COLLABORATION-2.1, 2.2)

/** Metadata as display text that cannot end a header or forge a field of it: one line, its delimiters escaped (COLLABORATION-2.1). */
export function headerText(text: string): string {
	return displayLine(text, 120).replace(/[\\|[\]#]/g, '\\$&');
}

/** `@Ada #a7`: an agent as a header names it, its name escaped and its Facade alias after it. */
export function partyText(party: MessageRecord['from'] | MessageRecord['to']): string {
	if (party.run === '@human') {
		return '#human';
	}
	if (party.run === 'facade') {
		return 'Facade';
	}
	const alias = party.alias && /^#a\d+$/.test(party.alias) ? party.alias : headerText(party.run);
	return party.name ? `@${headerText(party.name)} ${alias}` : alias;
}

/** A message as its recipient's CLI is given it: the whole text between a header and a footer naming its ID. */
export function formatMessage(record: Pick<MessageRecord, 'alias' | 'from' | 'replyTo' | 'text'>, windowLabel: string): string {
	const fields = [
		`Facade message ${record.alias}`,
		`from ${partyText(record.from)}`,
		`window ${headerText(windowLabel)}`,
		...(record.replyTo !== undefined ? [`reply to ${aliasText(record.replyTo)}`] : [])
	];
	return `[${fields.join(' | ')}]\n${record.text}\n[/Facade message ${record.alias}]`;
}

/** A Facade result as its run's CLI is given it: labeled as Facade's, about the message or agent it reports on, and its call. */
export function formatResult(record: MessageRecord): string {
	const fields = [
		`Facade result ${record.alias}`,
		...(record.about !== undefined ? [`about ${aliasText(record.about)}`] : []),
		...(record.agent !== undefined ? [`agent ${partyText(record.agent)}`] : []),
		...(record.callId !== undefined ? [`call ${headerText(record.callId)}`] : [])
	];
	return `[${fields.join(' | ')}]\n${record.text}\n[/Facade result ${record.alias}]`;
}

/** What an accepted send came to, as its Facade result says it: the original, its target, outcome and input effects (COLLABORATION-2.2). */
function resultText(original: MessageRecord, cli?: string): string {
	const target = `${partyText(original.to)} (${original.to.run})`;
	const delivery = original.delivery;
	// An input box Facade did not recognize names the CLI and version it found, for whoever looks into it (CLIS-2.1, D78)
	const unrecognized = delivery.reason === 'input_unknown' && cli ? `; Facade did not recognize the input box of ${cli}` : '';
	const outcome = delivery.status === 'success'
		? delivery.via === 'read'
			? `Your message ${original.alias} to ${target} was delivered: the recipient read it with read_messages.`
			: `Your message ${original.alias} to ${target} was submitted to its CLI.`
		: `Your message ${original.alias} to ${target} was not delivered: ${REASONS[delivery.reason ?? ''] ?? delivery.reason ?? 'unknown reason'}${unrecognized} (${delivery.reason ?? 'unknown'}). Input effects: ${effectsText(delivery.effects)}.`;
	return `${outcome} This is a Facade result, not a reply from the recipient.`;
}

function effectsText(effects: InputEffects): string {
	if (effects.outcome === 'none') {
		return 'none';
	}
	const enter = effects.enter_written === true ? 'Enter written' : effects.enter_written === false ? 'no Enter' : 'Enter unknown';
	return `${effects.outcome} (text ${effects.text_written ?? 'unknown'}, ${enter})`;
}

/** Why a stage that ran out of time failed: what went in, if anything did, else what stood in the way (MCP-1.2). */
function finalReason(stage: Stage): string {
	if (stage.effects.outcome === 'partial') {
		return 'partial_input';
	}
	if (stage.effects.outcome === 'unknown') {
		return 'submission_unconfirmed';
	}
	return stage.obstacle ?? 'timeout';
}

/** The more telling of two attempts' effects: uncertain over partial over nothing, and the later of two alike. */
function telling(before: InputEffects, now: InputEffects): InputEffects {
	const rank = (effects: InputEffects) => effects.outcome === 'unknown' ? 2 : effects.outcome === 'partial' ? 1 : 0;
	return rank(now) >= rank(before) && rank(now) > 0 ? now : before;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Message IDs (RULES-1.1, MCP-4.2)

/** `m-42` for `m-42` or its alias `#m42`; undefined for anything else, such as an agent reference. */
export function messageIdOf(text: string): string | undefined {
	const match = /^(?:m-|#m)([1-9]\d*)$/.exec(text.trim());
	return match ? `m-${match[1]}` : undefined;
}

/** `#m42` for a message ID or alias; other text escaped as header text. */
function aliasText(text: string): string {
	const id = messageIdOf(text);
	return id ? `#m${id.slice(2)}` : headerText(text);
}

function numberOf(id: string): number {
	return Number(id.slice(2));
}

function byAge(a: MessageRecord, b: MessageRecord): number {
	return numberOf(a.id) - numberOf(b.id);
}

function cursorNumber(cursor: string): number {
	const match = /^after-m-(\d+)$/.exec(cursor);
	if (!match) {
		throw invalid('invalid_argument', `${JSON.stringify(cursor)} is not a cursor read_messages returned.`);
	}
	return Number(match[1]);
}
