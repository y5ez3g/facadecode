/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { monotonic } from '../base/clock';
import { messageOf } from '../base/errors';
import { FacadeError } from '../core/errors';
import type { InputEffects, InputPort, Submission } from '../core/messagePorts';
import type { CapabilityState, LaunchPlan, RunFacts, RunId } from '../core/ports';
import { PtydNotSent } from './execution/ptydClient';
import { isOwnDraft, isSameDraft } from '../ptyd/drafts';
import type { InputEffect, InputReading, InputState, ScreenRead } from '../ptyd/protocol';

/** How often the input is read again while a submission waits for it to change. */
const POLL_MS = 100;
/**
 * How long a pasted message has to show in the input as its own draft, beyond the time a paste of its size takes; Enter is not
 * pressed for one that does not.
 */
const DRAFT_MS = 2_000;
/** How long the input has to empty after Enter for the CLI to have taken the message (RULES-1.3), beyond that time too. */
const TAKEN_MS = 3_000;
/** How many bytes of a paste a terminal takes in a millisecond, as Orca measured: Windows' ConPTY 64, elsewhere 4 KB (D105). */
const PASTE_BYTES_PER_MS: { readonly win32: number; readonly other: number } = { win32: 64, other: 4096 };
/** How long more a CLI's input needs for each line of a paste before Enter: Antigravity expands a long paste over seconds (D105). */
const LINE_SETTLE_MS: { readonly [adapter: string]: number } = { 'agy-frame': 45 };
/**
 * How long more a CLI needs for each character of a paste where it reads its input one key at a time: Codex on Windows reads console
 * input records, not a bracketed paste, which Orca measured at 21.1 s for 9,249 characters and gives 3 ms each. A character is a
 * UTF-16 code unit there, one key event each (D105).
 */
const CHAR_SETTLE_MS: { readonly [adapter: string]: { readonly [platform: string]: number } } = { 'codex-prompt': { win32: 3 } };
/** How long type_text's Enter waits after its text at least, so that its CLI reads them apart (MCP-5.2, D113). */
const DIRECT_ENTER_MS = 100;

/** The input readers of CLIs whose model takes a paste alone as material, not a request: a message's lead is typed before it (D108). */
const TAKES_LEAD: ReadonlySet<string> = new Set(['claude-frame']);

/** How long a start waits for its CLI's input to read empty before it gives up what it types before the first turn. */
const WARM_INPUT_MS = 30_000;
/** How long that typing waits for the CLI's screen to show the tools are there before it closes what it opened. */
const WARM_READY_MS = 10_000;

const NOTHING: InputEffects = { outcome: 'none', text_written: 'none', enter_written: false };
const CONFIRMED: InputEffects = { outcome: 'confirmed', text_written: 'full', enter_written: true };
/** The whole text shown as a draft, and no Enter after it. */
const TEXT_ONLY: InputEffects = { outcome: 'partial', text_written: 'full', enter_written: false };

/**
 * Whether `reading`, by the reader `adapter`, is `text` alone as its input's draft, after `lead` where that was typed - and, where it
 * showed before as the placeholder `seen`, that same placeholder, its paste's number too: a person's later paste of its size is not.
 */
function holds(reading: InputReading, text: string, adapter: string, lead?: string, seen?: string): boolean {
	return reading.state === 'draft' && reading.draft !== undefined && isOwnDraft(reading.draft, text, adapter, lead, reading.hidden)
		&& (seen === undefined || isSameDraft(reading.draft, seen, text, lead, reading.hidden));
}

/** What ordinary message input needs of the window: the run's facts, ptyd's reading of its input and its serialized terminal input. */
export interface OrdinaryInputDeps {
	readonly get: (run: RunId) => RunFacts | undefined;
	/** The run's input as the input adapter `adapter` reads it from ptyd's screen of it; undefined where ptyd holds no such run. */
	readonly inspectInput: (run: RunId, adapter: string) => Promise<InputReading | undefined>;
	/** Pastes text, `lead` typed before it where given, then Enter where asked, in turn with the run's other automated input in ptyd (RULES-1.10). */
	readonly typeText: (run: RunId, text: string, enter: boolean, lead?: string) => Promise<InputEffect>;
	readonly pressKeys: (run: RunId, keys: readonly string[]) => Promise<InputEffect>;
	/** The bottom `lines` lines of the run's screen, where its start waits on what its CLI shows (COLLABORATION-2.2). */
	readonly readScreen?: (run: RunId, lines: number) => Promise<ScreenRead>;
	/** A line for Show Agents Log: what a reading rested on, never the text on the screen or of a message (ARCHITECTURE-3.3). */
	readonly log?: (text: string) => void;
	/** The clock a submission's waits are held on: this process's monotonic one. */
	readonly monotonic?: () => number;
	/** Waits `ms`, rejecting as soon as `signal` aborts. */
	readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** The platform the run's terminal is on: how fast it takes a paste (D105). */
	readonly platform?: NodeJS.Platform;
}

/**
 * Ordinary message input (CLIS-2.1, RULES-1.3, 1.4, 1.6): only a run whose launch found an input adapter verified for its CLI's
 * version is typed a message into. Its input is read from the screen - usable and empty, a draft, a native question, or unknown -
 * and a message goes in as one whole paste, Enter pressed once the CLI shows it as the input's own draft and has had the time a paste
 * of its size takes, and is confirmed once the input empties again. A paste that never shows gets no Enter; an Enter after which the
 * input stays full is reported unconfirmed, and a later Enter goes only over that same draft. A submission and the window's direct
 * text and keys for the same run go one after another, so no other automated input comes between its paste and its Enter.
 */
export class OrdinaryInput implements InputPort {

	/** Each run's submissions and direct input from this window, one after another (RULES-1.10). */
	private readonly turns = new Map<RunId, Promise<void>>();
	private readonly mono: () => number;
	private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly platform: NodeJS.Platform;

	constructor(private readonly deps: OrdinaryInputDeps) {
		this.mono = deps.monotonic ?? monotonic;
		this.wait = deps.wait ?? timeout;
		this.platform = deps.platform ?? process.platform;
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

	async inspect(run: RunId, own?: string, lead?: string, seen?: string): Promise<InputState | 'own'> {
		const adapter = this.adapterOf(run);
		if (adapter === undefined) {
			return 'unknown';
		}
		const reading = await this.read(run, adapter);
		if (own !== undefined && holds(reading, own, adapter, lead, seen)) {
			return 'own';
		}
		if (reading.state !== 'usable') {
			this.log(run, `input reads ${reading.state} by ${adapter}: ${reading.evidence}`);
		}
		return reading.state;
	}

	submit(run: RunId, text: string, signal?: AbortSignal, lead?: string, canPaste?: () => boolean): Promise<Submission> {
		return this.inTurn(run, () => this.submitNow(run, text, signal, lead, canPaste));
	}

	enter(run: RunId, text: string, signal?: AbortSignal, lead?: string, seen?: string): Promise<InputEffects> {
		return this.inTurn(run, async () => {
			const adapter = this.adapterOf(run);
			if (adapter === undefined || signal?.aborted) {
				return NOTHING;
			}
			// Read again in this turn: only the message's own draft, alone, gets Enter (RULES-1.6), and none once stopped meanwhile
			const reading = await this.read(run, adapter);
			if (signal?.aborted || !holds(reading, text, adapter, lead, seen)) {
				return NOTHING;
			}
			return this.enterNow(run, adapter, text, signal);
		});
	}

	/**
	 * How much longer than usual a paste of `text` takes to show and be taken in `run`'s CLI: twice its size's time, Antigravity's lines
	 * and the characters of a CLI that reads them one at a time (D105, D118).
	 */
	pasteTime(run: RunId, text: string): number {
		const adapter = this.adapterOf(run);
		return 2 * this.pasteMs(text) + this.linesMs(adapter, text) + this.charactersMs(adapter, text);
	}

	/**
	 * What a run's start types before its CLI's first turn (COLLABORATION-2.2), in the run's turn ahead of any message: once its input
	 * first reads empty, `text` and Enter; once its screen shows `ready`, `close`; then its input is waited on to read empty again. It
	 * is given up, typing nothing, where the input first reads anything else - the person typing, or a question of the CLI's - or the
	 * CLI is working: the person's own first turn then starts the tools for the turns after it.
	 */
	warmUp(run: RunId, warmUp: NonNullable<LaunchPlan['warmUp']>): Promise<void> {
		return this.inTurn(run, () => this.warmUpNow(run, warmUp));
	}

	private async warmUpNow(run: RunId, warmUp: NonNullable<LaunchPlan['warmUp']>): Promise<void> {
		const adapter = this.adapterOf(run);
		if (adapter === undefined) {
			this.log(run, 'nothing is typed before its first turn: its input cannot be read');
			return;
		}
		const first = await this.firstReading(run, adapter, WARM_INPUT_MS);
		if (first !== 'usable' || this.deps.get(run)?.activity === 'working') {
			this.log(run, `nothing is typed before its first turn: its input first read ${first}${first === 'usable' ? ' while it was working' : ''}`);
			return;
		}
		let typed: InputEffect;
		try {
			typed = await this.deps.typeText(run, warmUp.text, false);
		} catch (err) {
			this.log(run, `what goes before its first turn could not be typed: ${messageOf(err)}`);
			return;
		}
		if (typed.outcome !== 'applied') {
			this.log(run, `what goes before its first turn was not typed whole: ${typed.outcome}`);
			return;
		}
		const shows = (source: string) => {
			const pattern = new RegExp(source, 'u');
			return (screen: ScreenRead) => screen.text.some(line => pattern.test(line.trimEnd()));
		};
		// Enter only once the input holds that text alone: text the person typed meanwhile is never submitted with it
		if (!await this.screenUntil(run, shows(warmUp.typed), DRAFT_MS)) {
			this.log(run, `what goes before its first turn did not show alone in its input within ${DRAFT_MS / 1000} seconds, so Enter was not pressed`);
			return;
		}
		await this.deps.pressKeys(run, ['Enter']);
		const shown = await this.screenUntil(run, shows(warmUp.ready), WARM_READY_MS);
		// Closed only while what it opened shows: once someone else closed it, the key could stop a turn of theirs
		const opened = shows(warmUp.opened);
		if (shown || await this.screenUntil(run, opened, 0)) {
			await this.deps.pressKeys(run, [warmUp.close]);
		}
		const usable = await this.until(run, adapter, reading => reading.state === 'usable', TAKEN_MS, undefined);
		this.log(run, `before its first turn its tools ${shown ? 'were shown ready' : `did not show ready within ${WARM_READY_MS / 1000} seconds`}, and its input ${usable ? 'reads empty again' : 'did not read empty again'}`);
	}

	/** The first reading of `run`'s input other than unknown within `ms`: unknown where none comes. */
	private async firstReading(run: RunId, adapter: string, ms: number): Promise<InputState> {
		const end = this.mono() + ms;
		for (; ;) {
			const { state } = await this.read(run, adapter);
			if (state !== 'unknown' || this.deps.get(run)?.lifecycle === 'ended') {
				return state;
			}
			const left = end - this.mono();
			if (left <= 0) {
				return 'unknown';
			}
			await this.wait(Math.min(POLL_MS, left));
		}
	}

	/** Whether `run`'s screen satisfies `test` within `ms`, read every {@link POLL_MS}. */
	private async screenUntil(run: RunId, test: (screen: ScreenRead) => boolean, ms: number): Promise<boolean> {
		const read = this.deps.readScreen;
		if (!read) {
			return false;
		}
		const end = this.mono() + ms;
		for (; ;) {
			try {
				if (test(await read(run, 40))) {
					return true;
				}
			} catch {
				// Not readable now: tried again
			}
			const left = end - this.mono();
			if (left <= 0) {
				return false;
			}
			await this.wait(Math.min(POLL_MS, left));
		}
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
	private async submitNow(run: RunId, text: string, signal: AbortSignal | undefined, lead: string | undefined, canPaste?: () => boolean): Promise<Submission> {
		const adapter = this.adapterOf(run);
		if (adapter === undefined || signal?.aborted) {
			return { effects: NOTHING, shown: false };
		}
		// Read again in this turn: direct input that came after the delivery looked is never pasted over (RULES-1.4), and nothing goes
		// in once stopped meanwhile
		if ((await this.read(run, adapter)).state !== 'usable' || signal?.aborted || canPaste?.() === false) {
			return { effects: NOTHING, shown: false };
		}
		// Typed ahead of the paste only where its CLI takes a paste alone as material (D108)
		const typed = lead !== undefined && TAKES_LEAD.has(adapter) ? lead : undefined;
		let pasted: InputEffect;
		try {
			pasted = await this.deps.typeText(run, text, false, typed);
		} catch (err) {
			if (err instanceof PtydNotSent) {
				return { effects: NOTHING, shown: false };
			}
			throw err;
		}
		if (pasted.outcome !== 'applied') {
			return { effects: pasted.outcome === 'partial' ? { outcome: 'partial', text_written: 'partial', enter_written: false } : NOTHING, shown: false };
		}
		// The whole text is in the terminal: Enter goes only once the CLI shows it as the input's own draft, alone (RULES-1.6) - one that
		// reads it a key at a time drawing it as it reads (D105)
		const showMs = DRAFT_MS + this.pasteMs(text) + this.charactersMs(adapter, text);
		let seen: string | undefined;
		const shows = (reading: InputReading) => {
			if (!holds(reading, text, adapter, typed)) {
				return false;
			}
			seen = reading.draft;
			return true;
		};
		if (!await this.until(run, adapter, shows, showMs, signal)) {
			this.log(run, `the pasted message did not show alone in its input within ${showMs / 1000} seconds, so Enter was not pressed`);
			return { effects: { outcome: 'unknown', text_written: 'full', enter_written: false }, shown: false };
		}
		return { effects: await this.enterNow(run, adapter, text, signal), shown: true, ...seen !== undefined ? { draft: seen } : {} };
	}

	/**
	 * Enter over the message's own draft, once its CLI has had what more it needs for a paste of its size (D105), then the input waited
	 * on to empty: a confirmed submission, else what went in.
	 */
	private async enterNow(run: RunId, adapter: string, text: string, signal: AbortSignal | undefined): Promise<InputEffects> {
		const settle = this.linesMs(adapter, text);
		if (settle > 0) {
			try {
				await this.wait(settle, signal);
			} catch {
				return TEXT_ONLY;
			}
		}
		if (signal?.aborted) {
			// Stopped while it looked: the read that showed its draft delivered it, or the deadline passed (RULES-1.5, 1.7)
			return TEXT_ONLY;
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
		const takenMs = TAKEN_MS + this.pasteMs(text);
		if (await this.until(run, adapter, reading => reading.state === 'usable', takenMs, signal)) {
			return CONFIRMED;
		}
		this.log(run, `its input did not empty within ${takenMs / 1000} seconds of Enter, so the message's submission is not confirmed yet`);
		return { outcome: 'unknown', text_written: 'full', enter_written: true };
	}

	/**
	 * type_text's text, then its Enter where asked (MCP-5.2): no draft protection, but its Enter in a write of its own once its CLI can
	 * have read the text - a tenth of a second at least, and the time a paste of its size takes (D105, D113) - as a CLI that reads a
	 * paste's end and an Enter together may drop the Enter, as Claude Code does.
	 */
	async typeDirect(run: RunId, text: string, enter: boolean): Promise<InputEffect> {
		if (!enter || !text) {
			return this.deps.typeText(run, text, enter).catch(refusedUnsent);
		}
		const typed = await this.deps.typeText(run, text, false).catch(refusedUnsent);
		if (typed.outcome !== 'applied') {
			return typed;
		}
		const adapter = this.adapterOf(run);
		await this.wait(DIRECT_ENTER_MS + this.pasteMs(text) + this.linesMs(adapter, text) + this.charactersMs(adapter, text), undefined);
		let entered: InputEffect;
		try {
			entered = await this.deps.typeText(run, '', true);
		} catch (err) {
			if (err instanceof PtydNotSent) {
				return { outcome: 'partial', pasted: true, entered: false };
			}
			throw err;
		}
		return entered.outcome === 'applied' ? { outcome: 'applied', pasted: true, entered: true } : { outcome: 'partial', ...entered.reason ? { reason: entered.reason } : {}, pasted: true, entered: false };
	}

	/** press_keys' keys (MCP-5.2): refused with no effect where ptyd was never given them. */
	pressDirect(run: RunId, keys: readonly string[]): Promise<InputEffect> {
		return this.deps.pressKeys(run, keys).catch(refusedUnsent);
	}

	/** The time this platform's terminal takes to take in a paste of `text`, in whole tenths of a second (D105). */
	private pasteMs(text: string): number {
		const rate = this.platform === 'win32' ? PASTE_BYTES_PER_MS.win32 : PASTE_BYTES_PER_MS.other;
		return Math.floor(Buffer.byteLength(text, 'utf8') / rate / 100) * 100;
	}

	/** The time the CLI of the reader `adapter` needs for the lines of a paste of `text` before its Enter: Antigravity's (D105). */
	private linesMs(adapter: string | undefined, text: string): number {
		return adapter ? (LINE_SETTLE_MS[adapter] ?? 0) * text.split(/\r\n|\r|\n/u).length : 0;
	}

	/** The time the CLI of the reader `adapter` needs on this platform to read a paste of `text` a key at a time: Codex on Windows (D105). */
	private charactersMs(adapter: string | undefined, text: string): number {
		return adapter ? (CHAR_SETTLE_MS[adapter]?.[this.platform] ?? 0) * text.length : 0;
	}

	/** Whether `run`'s input reads as `test` wants within `ms`, read every {@link POLL_MS}; false once `signal` aborts. */
	private async until(run: RunId, adapter: string, test: (reading: InputReading) => boolean, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
		const end = this.mono() + ms;
		for (; ;) {
			const reading = await this.read(run, adapter);
			// A reading that came after a stop is not acted on
			if (signal?.aborted) {
				return false;
			}
			if (test(reading)) {
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

/**
 * Direct input that ptyd was never given - it cannot be reached, or the run's runtime takes no MCP input (D120) - went nowhere: a
 * refusal with no effect, never input of unknown effect (MCP-1.2).
 */
function refusedUnsent(err: unknown): never {
	throw err instanceof PtydNotSent ? new FacadeError('UNAVAILABLE', 'unavailable', messageOf(err)) : err;
}
