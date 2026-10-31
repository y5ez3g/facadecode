/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { monotonic } from '../base/clock';
import { messageOf } from '../base/errors';
import type { InputEffects, InputPort } from '../core/messagePorts';
import type { CapabilityState, RunFacts, RunId } from '../core/ports';
import { PtydNotSent } from './execution/ptydClient';
import type { InputEffect, InputReading, InputState } from '../ptyd/protocol';

/** How often the input is read again while a submission waits for it to change. */
const POLL_MS = 100;
/** How long a pasted message has to show in the input as a draft; Enter is not pressed for one that does not. */
const DRAFT_MS = 2_000;
/** How long the input has to empty after Enter for the CLI to have taken the message (RULES-1.3). */
const TAKEN_MS = 3_000;

const NOTHING: InputEffects = { outcome: 'none', text_written: 'none', enter_written: false };
const CONFIRMED: InputEffects = { outcome: 'confirmed', text_written: 'full', enter_written: true };
/** The whole text shown as a draft, and no Enter after it. */
const TEXT_ONLY: InputEffects = { outcome: 'partial', text_written: 'full', enter_written: false };

/** What ordinary message input needs of the window: the run's facts, ptyd's reading of its input and its serialized terminal input. */
export interface OrdinaryInputDeps {
	readonly get: (run: RunId) => RunFacts | undefined;
	/** The run's input as the input adapter `adapter` reads it from ptyd's screen of it; undefined where ptyd holds no such run. */
	readonly inspectInput: (run: RunId, adapter: string) => Promise<InputReading | undefined>;
	/** Pastes text, then Enter where asked, in turn with the run's other automated input in ptyd (RULES-1.10). */
	readonly typeText: (run: RunId, text: string, enter: boolean) => Promise<InputEffect>;
	readonly pressKeys: (run: RunId, keys: readonly string[]) => Promise<InputEffect>;
	/** A line for Show Agents Log: what a reading rested on, never the text on the screen or of a message (ARCHITECTURE-3.3). */
	readonly log?: (text: string) => void;
	/** The clock a submission's waits are held on: this process's monotonic one. */
	readonly monotonic?: () => number;
	/** Waits `ms`, rejecting as soon as `signal` aborts. */
	readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Ordinary message input (CLIS-2.1, RULES-1.3, 1.4): only a run whose launch found an input adapter verified for its CLI's version is
 * typed a message into. Its input is read from the screen - usable and empty, a draft, a native question, or unknown - and a message
 * goes in as one whole paste, Enter pressed once the CLI shows it as a draft, and is confirmed once the input empties again. A paste
 * that never shows gets no Enter; an Enter after which the input stays full is reported unconfirmed. A submission and the window's
 * direct text and keys for the same run go one after another, so no other automated input comes between its paste and its Enter.
 */
export class OrdinaryInput implements InputPort {

	/** Each run's submissions and direct input from this window, one after another (RULES-1.10). */
	private readonly turns = new Map<RunId, Promise<void>>();
	private readonly mono: () => number;
	private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(private readonly deps: OrdinaryInputDeps) {
		this.mono = deps.monotonic ?? monotonic;
		this.wait = deps.wait ?? timeout;
	}

	capability(run: RunId): CapabilityState {
		const facts = this.deps.get(run);
		const capability = facts?.inputCapability;
		if (capability?.state === 'supported' && typeof facts?.inputAdapter === 'string') {
			return { state: 'supported', reason: capability.reason };
		}
		if ((capability?.state === 'unverified' || capability?.state === 'unavailable') && typeof capability.reason === 'string') {
			return { state: capability.state, reason: capability.reason };
		}
		return { state: 'unverified', reason: `How the message input of ${facts?.displayName ?? 'this agent'} is read is not known before its launch is planned, so Facade does not type messages into its terminal.` };
	}

	async inspect(run: RunId): Promise<InputState> {
		const adapter = this.adapterOf(run);
		if (adapter === undefined) {
			return 'unknown';
		}
		const reading = await this.read(run, adapter);
		if (reading.state !== 'usable') {
			this.log(run, `input reads ${reading.state} by ${adapter}: ${reading.evidence}`);
		}
		return reading.state;
	}

	submit(run: RunId, text: string, signal?: AbortSignal): Promise<InputEffects> {
		return this.inTurn(run, () => this.submitNow(run, text, signal));
	}

	/**
	 * Runs `input` once this window's earlier submissions and direct input for `run` are done (RULES-1.10): the window's type_text and
	 * press_keys go through it, so that they never land between a message's paste and its Enter.
	 */
	inTurn<T>(run: RunId, input: () => Promise<T>): Promise<T> {
		const before = this.turns.get(run) ?? Promise.resolve();
		const turn = before.then(input);
		const after = turn.then(() => undefined, () => undefined);
		this.turns.set(run, after);
		void after.then(() => {
			if (this.turns.get(run) === after) {
				this.turns.delete(run);
			}
		});
		return turn;
	}

	/** One submission, in its turn: nothing once `signal` aborts before Enter - the stage's deadline passed or its run ended. */
	private async submitNow(run: RunId, text: string, signal: AbortSignal | undefined): Promise<InputEffects> {
		const adapter = this.adapterOf(run);
		// Read again in this turn: direct input that came after the delivery looked is never pasted over (RULES-1.4)
		if (adapter === undefined || signal?.aborted || (await this.read(run, adapter)).state !== 'usable') {
			return NOTHING;
		}
		let pasted: InputEffect;
		try {
			pasted = await this.deps.typeText(run, text, false);
		} catch (err) {
			if (err instanceof PtydNotSent) {
				return NOTHING;
			}
			throw err;
		}
		if (pasted.outcome !== 'applied') {
			return pasted.outcome === 'partial' ? { outcome: 'partial', text_written: 'partial', enter_written: false } : NOTHING;
		}
		// The whole text is in the terminal: Enter goes only after it, once the CLI shows it in its input
		if (!await this.until(run, adapter, 'draft', DRAFT_MS, signal)) {
			this.log(run, `the pasted message did not show in its input within ${DRAFT_MS / 1000} seconds, so Enter was not pressed`);
			return { outcome: 'unknown', text_written: 'full', enter_written: false };
		}
		let entered: InputEffect;
		try {
			entered = await this.deps.pressKeys(run, ['Enter']);
		} catch (err) {
			return err instanceof PtydNotSent ? TEXT_ONLY : { outcome: 'unknown', text_written: 'full', enter_written: null };
		}
		if (entered.outcome !== 'applied') {
			return TEXT_ONLY;
		}
		// Taken once its input is empty again: busy or idle, the CLI has the message (RULES-1.3)
		if (await this.until(run, adapter, 'usable', TAKEN_MS, signal)) {
			return CONFIRMED;
		}
		this.log(run, `its input did not empty within ${TAKEN_MS / 1000} seconds of Enter, so the message's submission is not confirmed`);
		return { outcome: 'unknown', text_written: 'full', enter_written: true };
	}

	/** Whether `run`'s input reads `state` within `ms`, read every {@link POLL_MS}; false once `signal` aborts. */
	private async until(run: RunId, adapter: string, state: InputState, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
		const end = this.mono() + ms;
		for (; ;) {
			if ((await this.read(run, adapter)).state === state) {
				return true;
			}
			const left = end - this.mono();
			if (left <= 0 || signal?.aborted) {
				return false;
			}
			try {
				await this.wait(Math.min(POLL_MS, left), signal);
			} catch {
				return false;
			}
		}
	}

	/** The input adapter of a run whose message input is supported; none for any other. */
	private adapterOf(run: RunId): string | undefined {
		return this.capability(run).state === 'supported' ? this.deps.get(run)?.inputAdapter : undefined;
	}

	private async read(run: RunId, adapter: string): Promise<InputReading> {
		try {
			return await this.deps.inspectInput(run, adapter) ?? { state: 'unknown', evidence: 'its agent runtime holds no such run' };
		} catch (err) {
			return { state: 'unknown', evidence: `its input could not be read: ${messageOf(err)}` };
		}
	}

	private log(run: RunId, text: string): void {
		this.deps.log?.(`Message input of ${this.deps.get(run)?.alias ?? run}: ${text}`);
	}
}
