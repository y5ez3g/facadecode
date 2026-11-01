/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { monotonic } from '../base/clock';
import { messageOf } from '../base/errors';
import { displayLine } from '../base/text';
import { invalid } from './errors';
import { REQUEST_MS } from './requests';
import type { HumanContactPort, InboxPage, InboxQuery, InputEffects, InputPort, MessageRecord, Messages, SendRequest, SendResult } from './messagePorts';
import type { Agents, CapabilityState, Clock, Disposable, LogPort, RunChange, RunFacts, RunId } from './ports';

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
/** Each delivery stage - the message, then any Facade result - tries every three seconds for fifteen (RULES-1.5). */
export const STAGE_MS = 15_000;
export const SLOT_MS = 3_000;
/** How long from its start a stage waits for an input that another draft or a native question holds (RULES-1.5, D106). */
export const HOLD_MS = 10 * 60_000;
/**
 * Facade results this close together came together - those of sends that ended with their recipient - and go in one paste, the
 * later ones keeping their whole stage (D115).
 */
const TOGETHER_MS = 50;

/**
 * Facade results on their way to one run's terminal (RULES-1.7, D115): those that come while none of them is typed yet go in one
 * paste, a single turn of its model; once typing begins, its text is fixed, and the next result starts another.
 */
interface ResultBatch {
	readonly records: string[];
	readonly texts: Map<string, string>;
	/** The paste's text, fixed as its typing begins. */
	typed?: string;
}

/** How a stage ended. */
interface Outcome {
	readonly status: 'success' | 'failure';
	readonly reason?: string;
	readonly effects: InputEffects;
	readonly attempts: number;
	/** How a successful stage delivered it: into the terminal, or handed back by the recipient's read_messages (COLLABORATION-3.1). */
	readonly via?: 'terminal' | 'read';
}

/** What one attempt found or did: the input written to, in the way, waited on for the message's own text to show, or no more to try. */
type Attempt =
	| { readonly kind: 'submitted'; readonly effects: InputEffects }
	| { readonly kind: 'blocked'; readonly obstacle: string }
	| { readonly kind: 'waiting' }
	| { readonly kind: 'ended' }
	| { readonly kind: 'expired' }
	/** Its launch planned meanwhile, its CLI has no input reader: a permanent obstacle (RULES-1.4, 1.5). */
	| { readonly kind: 'unsupported' };

/** A delivery stage under way to one run: what it found so far, and how it is stopped. */
interface Stage {
	readonly target: RunId;
	/** The record it delivers. */
	readonly message: string;
	readonly stop: AbortController;
	/** When it started, on this process's monotonic clock: its slots and its ten minutes count from then (RULES-1.5). */
	readonly start: number;
	/**
	 * Its deadline on this process's monotonic clock: fifteen seconds from its start and the time a paste of its text takes beyond the
	 * usual (D105, D118), moved on to ten minutes from its start while the input is held (RULES-1.5, D106).
	 */
	deadline: number;
	/** The time a paste of its text takes beyond the usual, which every deadline of it gives (D118). */
	extra: number;
	/** Its outcome where something other than an attempt settled it: the recipient's read_messages delivered the record meanwhile. */
	settled?: Outcome;
	/** Read delivery resolves the send immediately, independently of finishing an already pasted owned draft. */
	readonly read: Promise<Outcome>;
	readonly resolveRead: (outcome: Outcome) => void;
	attempts: number;
	obstacle?: string;
	/** The most telling input effects of its attempts so far (RULES-1.6): never forgotten by a later attempt that wrote nothing. */
	effects: InputEffects;
	/** Whether an attempt is pasting now: cut off by the deadline or a close, what it wrote is not known. */
	submitting: boolean;
	/** Whether its text went into the input whole: from then on it is never typed again (RULES-1.6, D104). */
	written: boolean;
	/** The draft the input showed its text as, its own and alone: a later Enter needs the same, its paste's number too (D118). */
	seen?: string;
	/** Whether an Enter of this stage went in after its text. */
	entered: boolean;
	/** Whether an attempt confirmed its submission: it is ending, and its text is its CLI's (RULES-1.3). */
	confirmed?: true;
	/** Epoch ms its deadline moved on to, while another draft or a native question held the input (RULES-1.5, D106). */
	heldUntil?: number;
	/** The Facade results it types in one paste, where it delivers results; `message` is the first of them (D115). */
	readonly batch?: ResultBatch;
}

const NO_EFFECTS: InputEffects = { outcome: 'none', text_written: 'none', enter_written: false };
/** A delivery not yet tried: nothing written so far (MCP-4.1's accepted effects). */
const PENDING: MessageRecord['delivery'] = { status: 'pending', effects: { outcome: 'pending', text_written: 'none', enter_written: false }, attempts: 0 };
const UNKNOWN_EFFECTS: InputEffects = { outcome: 'unknown', text_written: 'unknown', enter_written: null };
/** A paste whose answer was lost: what went in is not known, but its Enter, a write of its own after it, never went (D118). */
const PASTE_UNKNOWN: InputEffects = { outcome: 'unknown', text_written: 'unknown', enter_written: false };
/** A submission whose input emptied after its Enter, at that attempt or a later one (RULES-1.3). */
const CONFIRMED: InputEffects = { outcome: 'confirmed', text_written: 'full', enter_written: true };

/** The obstacle an input that is not usable is, as a delivery reports it. */
const OBSTACLES: { readonly [state: string]: string | undefined } = { draft: 'input_draft', interaction: 'input_interaction', unknown: 'input_unknown' };
/** What holds an input for a person or its CLI, and is waited for (RULES-1.5, D106): unlike an input that cannot be read. */
const HELD: ReadonlySet<string> = new Set(['input_draft', 'input_interaction']);

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
 * person in this window by notification, or a run's CLI as one paste and Enter, never over a draft or into a menu, trying every
 * three seconds for fifteen, and up to ten minutes while another draft or a native question holds the input. Its text is typed at
 * most once. The first response comes within two seconds; an accepted send's outcome goes back to its sender as a Facade result
 * with its own budget, and ends quietly where it cannot. Attempts for one terminal never run side by side.
 */
export class MessageService implements Messages, Disposable {
	private readonly listeners = new Set<(record: MessageRecord) => void>();
	private readonly subscriptions: Disposable[] = [];
	/** Records whose delivery is under way here: the current version of each, ahead of what was read from the store. */
	private readonly live = new Map<string, MessageRecord>();
	private readonly stages = new Set<Stage>();
	/** Each terminal's attempts, one after another (RULES-1.10). */
	private readonly lanes = new Map<RunId, Promise<void>>();
	/** The deadlines of deliveries an earlier opening began that this one cannot go on with (RULES-1.9). */
	private readonly timers = new Set<AbortController>();
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

	/**
	 * Stops this window's deliveries without recording an outcome: a reload is not closure, and its next opening goes on with them
	 * within their deadlines, or settles them (RULES-1.9).
	 */
	dispose(): void {
		this.disposed = true;
		for (const stage of this.stages) {
			stage.stop.abort();
		}
		for (const timer of this.timers) {
			timer.abort();
		}
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.listeners.clear();
	}

	async send(request: SendRequest): Promise<SendResult> {
		// Check and create synchronously in the execution owner, before the first await. Routed retries can have a fresh proposed
		// message ID after a lost reply, but the original request still names the original message (MCP-1.1).
		const earlier = request.requestId !== undefined ? this.findRequest(request.from, request.requestId) : undefined;
		if (earlier) {
			return { record: earlier, status: earlier.delivery.status === 'pending' ? 'accepted' : earlier.delivery.status,
				...earlier.delivery.reason ? { reason: earlier.delivery.reason } : {} };
		}
		// Queueing and forwarding before Facade had it spent the same budgets, and so does making its record (RULES-1.2, 1.5)
		const elapsed = Number.isFinite(request.elapsedMs) ? Math.max(0, request.elapsedMs) : 0;
		const start = this.mono() - elapsed;
		const deadline = this.deps.clock.now() - elapsed + STAGE_MS;
		const record = this.create({
			kind: 'message',
			from: request.sender?.party ?? this.party(request.from),
			to: request.to === '@human' ? { run: '@human' } : this.party(request.to),
			text: request.text,
			...(request.replyTo !== undefined ? { replyTo: request.replyTo } : {}),
			...(request.sender ? { fromWindow: request.sender.window } : {}),
			...(request.sender?.label !== undefined ? { label: request.sender.label } : {}),
			...(request.requestId !== undefined ? { requestId: request.requestId } : {})
		}, PENDING, true, request.id);
		if (request.to === '@human') {
			return this.contact(record);
		}
		const target = this.deps.agents.get(request.to);
		if (!target || target.lifecycle === 'ended') {
			return this.failed(record, 'ended', NO_EFFECTS);
		}
		const capability = this.deps.input.capability(request.to);
		if (!readable(target, capability)) {
			// A permanent obstacle: nothing is typed and no slot is waited out (MCP-1.2, RULES-1.5)
			this.deps.log.event(`Message ${record.alias} to ${target.alias} not delivered: its ordinary input is ${capability.state} (${capability.reason})`);
			return this.failed(record, 'unsupported', NO_EFFECTS);
		}
		const text = formatMessage(record, request.sender?.label ?? this.deps.window.label);
		// A long paste gets the time it takes, beyond the usual, at every deadline of its stage (D105, D118)
		const extra = this.deps.input.pasteTime?.(request.to, text) ?? 0;
		const pending = this.update(record.id, { delivery: { ...record.delivery, deadline: deadline + extra, start: deadline - STAGE_MS } });
		const stage = this.newStage(request.to, pending.id, start, extra);
		const delivered = Promise.race([this.stage(stage, text, MESSAGE_LEAD), stage.read]);
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

	findRequest(from: RunId, requestId: string): MessageRecord | undefined {
		const cutoff = this.deps.clock.now() - REQUEST_MS;
		return this.involving().find(record => record.kind === 'message' && record.from.run === from && record.requestId === requestId && record.at > cutoff);
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
			const stage = [...this.stages].find(each => each.batch ? each.batch.records.includes(record.id) : each.message === record.id);
			// An input call still under way may already have written text or Enter. A successful read does not prove no input effects.
			const effects = stage?.submitting ? { ...UNKNOWN_EFFECTS, ...stage.written ? { text_written: stage.effects.text_written } : {} } : record.delivery.effects;
			if (stage?.batch && stage.batch.records.length > 1) {
				// One of the results going in one paste: delivered by the read, and left out of it where its typing has not begun (D115)
				stage.batch.records.splice(stage.batch.records.indexOf(record.id), 1);
				if (stage.batch.typed === undefined) {
					stage.batch.texts.delete(record.id);
				}
				this.live.delete(record.id);
				this.save({ ...record, delivery: { ...record.delivery, status: 'success', effects, via: 'read', deliveredAt: at } });
				this.deps.log.event(`Facade result ${record.alias} delivered to ${record.to.alias ?? record.to.run} by its read_messages`);
				continue;
			}
			if (stage) {
				// The record is delivered now. Only a paste already issued may finish its own draft; no fresh paste follows the read.
				stage.settled = { status: 'success', effects, attempts: stage.attempts, via: 'read' };
				this.save({ ...record, delivery: { ...record.delivery, status: 'success', effects, via: 'read', deliveredAt: at } });
				this.deps.log.event(`${record.kind === 'result' ? 'Facade result' : 'Message'} ${record.alias} delivered to ${record.to.alias ?? record.to.run} by its read_messages`);
				stage.resolveRead(stage.settled);
				if (!stage.submitting && !stage.written) {
					stage.stop.abort();
				}
				continue;
			}
			// Failed already, or left pending by a window that went: delivered now, and nobody is told again (RULES-1.7)
			this.live.delete(record.id);
			this.save({ ...record, delivery: { ...record.delivery, status: 'success', via: 'read', deliveredAt: at } });
			this.deps.log.event(`${record.kind === 'result' ? 'Facade result' : 'Message'} ${record.alias} delivered to ${record.to.alias ?? record.to.run} by its read_messages`);
		}
	}

	history(): readonly MessageRecord[] {
		const now = this.deps.clock.now();
		// A copy whose outcome its window never sent back, past its deadline: shown unconfirmed, as it is not known here (COLLABORATION-3.2)
		return this.involving().map(record => record.delivery.status !== 'pending' || this.live.has(record.id) || record.delivery.deadline === undefined || record.delivery.deadline > now ? record
			: { ...record, delivery: { ...record.delivery, status: 'failure', reason: 'submission_unconfirmed', effects: { ...record.delivery.effects, outcome: 'unknown' } } });
	}

	/** The records involving this window's runs or workspace, with the copies of what its agents sent to other windows, as kept. */
	private involving(): readonly MessageRecord[] {
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
		if (!facts || !capability || !readable(facts, capability)) {
			return this.finish(record.id, { status: 'failure', reason: capability ? 'unsupported' : 'ended', effects: NO_EFFECTS, attempts: 0 }) ?? record;
		}
		const start = this.mono();
		// A result's own budget is never cut short: it joins only results with a whole stage's time still before them, or that came
		// together with it, and never a paste a read has delivered already, which ends at its next slot (RULES-1.5, D115, D118)
		const open = [...this.stages].find(each => each.target === run && each.batch !== undefined && each.batch.typed === undefined && !each.stop.signal.aborted
			&& !each.settled && each.deadline - start >= STAGE_MS + each.extra - TOGETHER_MS);
		if (open?.batch) {
			// Typed with the results already waiting for this terminal, one turn of its model for them all, by their deadline (D115)
			open.batch.records.push(record.id);
			open.batch.texts.set(record.id, text);
			const extra = this.deps.input.pasteTime?.(run, open.batch.records.map(id => open.batch!.texts.get(id)!).join('\n\n')) ?? 0;
			// Its whole stage, for one that came a moment after the others; the paste's added time for all of them
			const deadline = Math.max(open.deadline + Math.max(0, extra - open.extra), start + STAGE_MS + extra);
			if (deadline > open.deadline) {
				open.deadline = deadline;
				open.extra = Math.max(open.extra, extra);
				open.heldUntil = this.deps.clock.now() + open.deadline - start;
				for (const id of open.batch.records) {
					this.progress(id, open);
				}
			}
			return this.update(record.id, { delivery: { ...record.delivery, deadline: this.deps.clock.now() + (open.deadline - start) } });
		}
		const extra = this.deps.input.pasteTime?.(run, text) ?? 0;
		const now = this.deps.clock.now();
		const pending = this.update(record.id, { delivery: { ...record.delivery, deadline: now + STAGE_MS + extra, start: now } });
		return this.deliverResults(pending, text, this.newStage(run, record.id, start, extra, { records: [record.id], texts: new Map([[record.id, text]]) }));
	}

	/** Runs the stage of a paste of Facade results, `record` the first, and records its outcome for each (RULES-1.7, D115). */
	private deliverResults(record: MessageRecord, text: string, stage: Stage): MessageRecord {
		const batch = stage.batch!;
		const typed = () => batch.typed ??= batch.records.map(id => batch.texts.get(id)!).join('\n\n');
		void Promise.race([this.stage(stage, batch.typed !== undefined ? text : typed), stage.read]).then(outcome => {
			for (const id of batch.records) {
				this.finish(id, outcome);
			}
		});
		return record;
	}

	private newStage(target: RunId, message: string, start: number, extra: number, batch?: ResultBatch): Stage {
		let resolveRead!: (outcome: Outcome) => void;
		const read = new Promise<Outcome>(resolve => { resolveRead = resolve; });
		const stage: Stage = {
			target, message, stop: new AbortController(), start, read, resolveRead, deadline: start + STAGE_MS + extra, extra, attempts: 0, effects: NO_EFFECTS, submitting: false, written: false, entered: false,
			...batch ? { batch } : {}
		};
		this.stages.add(stage);
		return stage;
	}

	/**
	 * One delivery stage (RULES-1.4-1.6): an attempt at its start and every three seconds on, each looking at the input first and
	 * pasting the whole text with Enter only into a usable composer - once: a later attempt presses Enter only over the message's own
	 * draft. A confirmed submission ends it; a draft, a menu or unknown input spends the slot, and while another draft or a native
	 * question holds the input its deadline moves on, to ten minutes from its start; an ended run ends it at once. A slot that went by
	 * during an attempt is not made up for. At the deadline, input not yet started is dropped and what went in is reported.
	 */
	private async stage(stage: Stage, text: string | (() => string), lead?: string): Promise<Outcome> {
		const { start } = stage;
		try {
			for (let slot = 0; ;) {
				const due = start + slot * SLOT_MS - this.mono();
				if (due > 0) {
					await this.wait(due, stage.stop.signal);
				}
				if (stage.stop.signal.aborted || stage.settled && !stage.written) {
					return this.ended(stage);
				}
				if (this.mono() >= stage.deadline) {
					break;
				}
				// Input not yet gone in when the deadline passes or the run ends is not sent (RULES-1.5)
				const cutoff = new AbortController();
				const attempt = await this.within(this.lane(stage.target, () => this.attempt(stage, text, lead, cutoff.signal)), () => stage.deadline - this.mono(), stage.stop.signal);
				if (attempt === 'deadline') {
					cutoff.abort();
					if (stage.submitting) {
						// Cut off while it pasted: what went in is not known, and nothing is typed again
						stage.attempts++;
						stage.effects = UNKNOWN_EFFECTS;
						stage.written = true;
					}
					if (stage.stop.signal.aborted) {
						return this.ended(stage);
					}
					break;
				}
				if (attempt.kind === 'ended') {
					return this.ended(stage);
				}
				if (attempt.kind === 'unsupported') {
					return stage.settled ?? { status: 'failure', reason: 'unsupported', effects: stage.effects, attempts: stage.attempts };
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
					stage.written ||= attempt.effects.text_written !== 'none';
					stage.entered ||= attempt.effects.enter_written !== false;
					stage.obstacle = undefined;
				} else if (attempt.kind === 'blocked') {
					stage.obstacle = attempt.obstacle;
					if (HELD.has(attempt.obstacle) && stage.deadline < start + HOLD_MS + stage.extra) {
						// Another draft or the CLI's own question: waited for, up to ten minutes from the start (RULES-1.5, D106)
						stage.deadline = start + HOLD_MS + stage.extra;
						stage.heldUntil = this.deps.clock.now() + (stage.deadline - this.mono());
					}
				}
				for (const id of stage.batch?.records ?? [stage.message]) {
					this.progress(id, stage);
				}
				slot = Math.max(slot + 1, Math.ceil((this.mono() - start) / SLOT_MS));
			}
			// The slots are spent: the outcome is the deadline's, as the accepted response said, unless the run ends first
			const left = stage.deadline - this.mono();
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

	/**
	 * One attempt, in its terminal's turn: nothing once the run ended or the deadline passed while it waited (RULES-1.5, 1.10). Its
	 * text, once written whole, is never typed again (RULES-1.6, D104): the message's own draft gets Enter, an input that empties after
	 * an Enter of the stage confirms it, and anything else is waited on.
	 */
	private async attempt(stage: Stage, typed: string | (() => string), lead: string | undefined, cutoff: AbortSignal): Promise<Attempt> {
		// A batch's text is fixed once its typing begins, and is the same at every attempt after (D115)
		const text = () => typeof typed === 'string' ? typed : typed();
		if (!this.usable(stage)) {
			return { kind: 'ended' };
		}
		if (stage.settled && !stage.written) {
			return { kind: 'ended' };
		}
		if (this.mono() >= stage.deadline) {
			return { kind: 'expired' };
		}
		if (this.deps.input.capability(stage.target).state === 'unavailable') {
			return { kind: 'unsupported' };
		}
		let input: Awaited<ReturnType<InputPort['inspect']>>;
		try {
			input = await this.deps.input.inspect(stage.target, stage.written ? text() : undefined, lead, stage.seen);
		} catch (err) {
			this.deps.log.event(`Could not read ${stage.target}'s input: ${messageOf(err)}`);
			input = 'unknown';
		}
		if (stage.written) {
			if (input === 'usable' && stage.entered) {
				// Empty after an Enter of this stage: its CLI took the message later than that attempt saw (RULES-1.3)
				stage.confirmed = true;
				return { kind: 'submitted', effects: CONFIRMED };
			}
			if (input !== 'own') {
				// Its own text gone without its Enter, or someone's text added to it: neither is typed over, nor typed again; another draft
				// or a native question is waited for as before its text went in (RULES-1.4, 1.5) - but for a part of its text, which no wait
				// makes its own
				return input === 'usable' || stage.effects.text_written === 'partial' ? { kind: 'waiting' } : { kind: 'blocked', obstacle: OBSTACLES[input] ?? 'input_unknown' };
			}
		} else if (input !== 'usable') {
			return { kind: 'blocked', obstacle: OBSTACLES[input] ?? 'input_unknown' };
		} else if ([...this.stages].some(other => other !== stage && other.target === stage.target && (other.written || other.submitting) && !other.confirmed && !other.stop.signal.aborted)) {
			// Another delivery's text may be in the input still, drawn late: nothing is pasted with it (RULES-1.10, D118)
			return { kind: 'blocked', obstacle: 'input_draft' };
		}
		if (!this.usable(stage)) {
			return { kind: 'ended' };
		}
		if (this.mono() >= stage.deadline) {
			return { kind: 'expired' };
		}
		if (input !== 'own' && !this.pasting(stage)) {
			// Not kept as maybe in its input, it is not pasted: an opening after a reload could not know not to paste it again (RULES-1.6)
			return { kind: 'blocked', obstacle: 'input_unknown' };
		}
		stage.submitting = true;
		try {
			if (input === 'own') {
				const effects = await this.deps.input.enter(stage.target, text(), cutoff, lead, stage.seen);
				if (effects.outcome === 'confirmed') {
					stage.confirmed = true;
				}
				return { kind: 'submitted', effects };
			}
			const submission = await this.deps.input.submit(stage.target, text(), cutoff, lead, () => !stage.settled);
			// Its text in the input from here on, before another delivery to this terminal looks (RULES-1.10)
			stage.written ||= submission.effects.text_written !== 'none';
			if (submission.effects.outcome === 'confirmed') {
				stage.confirmed = true;
			}
			if (submission.draft !== undefined) {
				stage.seen = submission.draft;
			}
			if (!stage.written && stage.batch) {
				// Nothing typed: the results go on gathering, and one read meanwhile is left out (D115)
				stage.batch.typed = undefined;
			}
			return { kind: 'submitted', effects: submission.effects };
		} catch (err) {
			this.deps.log.event(`Input to ${stage.target} did not answer what went in: ${messageOf(err)}`);
			if (input === 'own') {
				return { kind: 'submitted', effects: UNKNOWN_EFFECTS };
			}
			stage.written = true;
			return { kind: 'submitted', effects: PASTE_UNKNOWN };
		} finally {
			stage.submitting = false;
		}
	}

	private usable(stage: Stage): boolean {
		const facts = this.deps.agents.get(stage.target);
		return !stage.stop.signal.aborted && !!facts && facts.lifecycle !== 'ended';
	}

	/**
	 * Keeps, before its paste is issued, that the stage's text may be in its recipient's input from now on, so that no later opening of
	 * this window pastes it again (RULES-1.6, 1.9); false where that cannot be kept.
	 */
	private pasting(stage: Stage): boolean {
		for (const id of stage.batch?.records ?? [stage.message]) {
			const current = this.live.get(id);
			if (!current || current.delivery.pasted) {
				continue;
			}
			const marked: MessageRecord = { ...current, delivery: { ...current.delivery, pasted: true } };
			try {
				this.deps.store.put(marked);
			} catch (err) {
				this.deps.log.event(`Could not keep that ${current.alias} may be in ${stage.target}'s input, so it is not pasted: ${messageOf(err)}`);
				return false;
			}
			this.live.set(id, marked);
		}
		return true;
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
	private async within<T>(promise: Promise<T>, ms: number | (() => number), signal?: AbortSignal): Promise<T | 'deadline'> {
		const done = new AbortController();
		const stop = () => done.abort();
		signal?.addEventListener('abort', stop, { once: true });
		if (signal?.aborted) {
			done.abort();
		}
		const expires = async (): Promise<'deadline'> => {
			try {
				for (;;) {
					const left = typeof ms === 'number' ? ms : ms();
					if (left <= 0 || done.signal.aborted) {
						return 'deadline';
					}
					await this.wait(left, done.signal);
					if (typeof ms === 'number') {
						return 'deadline';
					}
				}
			} catch {
				return 'deadline';
			}
		};
		try {
			return await Promise.race([promise, expires()]);
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
	private create(fields: Pick<MessageRecord, 'kind' | 'from' | 'to' | 'text' | 'replyTo' | 'about' | 'callId' | 'agent' | 'fromWindow' | 'requestId' | 'label'>, delivery: MessageRecord['delivery'], required = true, id?: string): MessageRecord {
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
			// A retry with the same request ID finds it, in this window or the sender's (MCP-1.1, D110)
			...(fields.requestId !== undefined ? { requestId: fields.requestId } : {}),
			...(fields.label !== undefined ? { label: fields.label } : {}),
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
			// A deadline moved on while the input was held is the one the record states (RULES-1.5, D106)
			const deadline = stage.heldUntil ?? current.delivery.deadline;
			// What a later opening goes on from: the stage's start, whether its text may be in the input, as what, and its Enter (RULES-1.9)
			const { pasted: _pasted, seen: _seen, entered: _entered, ...delivery } = current.delivery;
			this.save({
				...current,
				delivery: {
					...delivery, attempts: stage.attempts, effects: written, ...deadline !== undefined ? { deadline } : {}, start: delivery.start ?? this.deps.clock.now() - (this.mono() - stage.start),
					...stage.written || stage.submitting ? { pasted: true } : {}, ...stage.seen !== undefined ? { seen: stage.seen } : {}, ...stage.entered ? { entered: true } : {}
				}
			});
		}
	}

	/** Records the stage's outcome; answers the final record, or none where this window's service went meanwhile. */
	private finish(id: string, outcome: Outcome): MessageRecord | undefined {
		const current = this.live.get(id);
		if (!current || this.disposed) {
			return undefined;
		}
		// A read's delivery time and status are authoritative even if its already-issued terminal input finishes later.
		if (current.delivery.status === 'success' && current.delivery.via === 'read') {
			this.live.delete(id);
			return current;
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
	 * - its window reloaded or closed meanwhile - ended with its deadline: this window's own is settled as such and its sender told
	 * (RULES-1.7, 1.9); another window's reads so here, that window settling it.
	 */
	private records(): readonly MessageRecord[] {
		const now = this.deps.clock.now();
		return this.deps.store.list().map(stored => {
			const record = this.live.get(stored.id) ?? stored;
			if (record.delivery.status !== 'pending' || this.live.has(record.id) || record.delivery.deadline === undefined || record.delivery.deadline > now) {
				return record;
			}
			return record.workspace === this.deps.workspace ? this.abandon(record, 'timeout') : settledAt(record, 'timeout');
		});
	}

	/**
	 * After a reload (RULES-1.9): this window's deliveries still pending go on with what is left of their own budget, never a fresh one,
	 * and a text that may be in its input already is never pasted again, only its own draft given Enter (RULES-1.6). One past its deadline,
	 * or whose agent is gone, ends now, its sender told; one kept by an earlier version, which cannot tell what went in, ends at its
	 * deadline, typing nothing.
	 */
	resume(): void {
		const now = this.deps.clock.now();
		for (const record of this.deps.store.list()) {
			const { deadline, start } = record.delivery;
			if (record.delivery.status !== 'pending' || this.live.has(record.id) || record.workspace !== this.deps.workspace || record.to.run === '@human' || deadline === undefined) {
				continue;
			}
			const facts = this.deps.agents.get(record.to.run);
			if (!facts || facts.lifecycle === 'ended') {
				this.abandon(record, 'ended');
			} else if (deadline <= now) {
				this.abandon(record, 'timeout');
			} else if (start === undefined) {
				this.expireAt(record);
			} else {
				this.goOn(record, facts.id, now);
			}
		}
	}

	/** A delivery this window's earlier opening began, under way again within its own deadline (RULES-1.9). */
	private goOn(record: MessageRecord, run: RunId, now: number): void {
		const { delivery } = record;
		const text = record.kind === 'result' ? formatResult(record) : formatMessage(record, record.label ?? this.deps.window.label);
		const extra = this.deps.input.pasteTime?.(run, text) ?? 0;
		const stage = this.newStage(run, record.id, this.mono() - (now - delivery.start!), extra, record.kind === 'result' ? { records: [record.id], texts: new Map([[record.id, text]]) } : undefined);
		stage.deadline = this.mono() + (delivery.deadline! - now);
		stage.attempts = delivery.attempts;
		if (delivery.pasted) {
			// What went in is not known here: never pasted again, its own draft alone given Enter (RULES-1.6, D104, D118)
			stage.written = true;
			stage.effects = uncertain(delivery);
			stage.entered = delivery.entered === true;
			if (delivery.seen !== undefined) {
				stage.seen = delivery.seen;
			}
			if (stage.batch) {
				stage.batch.typed = text;
			}
		}
		this.live.set(record.id, record);
		this.deps.log.event(`${record.kind === 'result' ? 'Facade result' : 'Message'} ${record.alias} to ${record.to.alias ?? record.to.run} goes on after a reload until ${new Date(delivery.deadline!).toISOString()}`);
		if (stage.batch) {
			this.deliverResults(record, text, stage);
			return;
		}
		void Promise.race([this.stage(stage, text, MESSAGE_LEAD), stage.read]).then(outcome => {
			const final = this.finish(record.id, outcome);
			if (final && !this.disposed) {
				this.reportOutcome(final, undefined);
			}
		});
	}

	/** Ends at its deadline a pending record this window cannot go on with, as `records` settles it then (RULES-1.9). */
	private expireAt(record: MessageRecord): void {
		const stop = new AbortController();
		this.timers.add(stop);
		void this.wait(Math.max(0, record.delivery.deadline! - this.deps.clock.now()), stop.signal)
			.then(() => this.records(), () => undefined)
			.finally(() => this.timers.delete(stop));
	}

	/** A pending record nothing delivers any more, ended - as `reason` says - with what may have gone in, and its sender told (RULES-1.7). */
	private abandon(record: MessageRecord, reason: string): MessageRecord {
		const final = this.save(settledAt(record, reason));
		if (record.kind === 'message' && !this.disposed) {
			this.reportOutcome(final, undefined);
		}
		return final;
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

	/** Tells each listener - Message History - of `record`; one that fails stops no delivery, nor any listener after it. */
	private emit(record: MessageRecord): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(record);
			} catch (err) {
				this.deps.log.event(`Could not show message ${record.alias} where it is listed: ${messageOf(err)}`);
			}
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

/**
 * What is typed before a message's paste where its recipient's CLI takes a paste alone as material rather than a request: words of
 * the person's own that ask it to act on the message (COLLABORATION-2.1, D108). A Facade result asks for nothing, and has none.
 */
export const MESSAGE_LEAD = 'Act on this Facade message: ';

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
	// An input box Facade did not recognize names the CLI and version it found, for whoever looks into it (CLIS-2.1, D89)
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

/**
 * Why a stage that ran out of time failed: what went in, if anything did - part of its text, or its text without a confirmed
 * submission, its Enter not written or not taken - else what stood in the way (MCP-1.2).
 */
function finalReason(stage: Stage): string {
	if (stage.effects.text_written === 'partial') {
		return 'partial_input';
	}
	if (stage.effects.outcome === 'partial' || stage.effects.outcome === 'unknown') {
		return 'submission_unconfirmed';
	}
	return stage.obstacle ?? 'timeout';
}

/**
 * What a delivery nothing goes on with may have put in its input: not known where its text may be there - kept so before its paste
 * was issued, or recorded since; by an earlier version, after any attempt - and nothing otherwise (MCP-1.2, RULES-1.6).
 */
function uncertain(delivery: MessageRecord['delivery']): InputEffects {
	const text = delivery.effects.text_written;
	const maybe = delivery.pasted || (text !== undefined && text !== 'none') || (delivery.start === undefined && delivery.attempts > 0);
	if (!maybe) {
		return NO_EFFECTS;
	}
	return { outcome: 'unknown', text_written: text !== undefined && text !== 'none' ? text : 'unknown', enter_written: delivery.effects.enter_written === true || delivery.entered ? true : null };
}

/** A pending record ended by `reason` with what may have gone in, its delivery as it stood otherwise (RULES-1.9). */
function settledAt(record: MessageRecord, reason: string): MessageRecord {
	const { delivery } = record;
	return { ...record, delivery: { status: 'failure', reason, effects: uncertain(delivery), ...delivery.deadline !== undefined ? { deadline: delivery.deadline } : {}, attempts: delivery.attempts } };
}

/**
 * Whether a run's ordinary input can be tried: a supported reader, or one not known yet because the run's launch is not planned - an
 * unknown input, waited for within the stage, as a CLI without a reader is not (RULES-1.4, MCP-1.2).
 */
function readable(run: Pick<RunFacts, 'lifecycle'>, capability: CapabilityState): boolean {
	return capability.state === 'supported' || (run.lifecycle === 'starting' && capability.state === 'unverified');
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
