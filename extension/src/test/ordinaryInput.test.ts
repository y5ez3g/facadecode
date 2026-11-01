/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { InputEffects, Submission } from '../core/messagePorts';
import type { CapabilityState, RunFacts, RunId } from '../core/ports';
import { PtydLost, PtydNotSent } from '../host/execution/ptydClient';
import { OrdinaryInput } from '../host/input';
import { isOwnDraft, isSameDraft } from '../ptyd/drafts';
import type { InputEffect, InputReading, InputState } from '../ptyd/protocol';

const RUN = 'run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = 'run-cccccccccccccccccccccccccccccccc';
const SUPPORTED: CapabilityState = { state: 'supported', reason: 'claude-frame reads Claude Code\'s input by its layout.' };
const CONFIRMED: InputEffects = { outcome: 'confirmed', text_written: 'full', enter_written: true };
const NOTHING: InputEffects = { outcome: 'none', text_written: 'none', enter_written: false };

/** What a submission did to the input, without whether its draft showed. */
async function effects(submission: Promise<Submission>): Promise<InputEffects> {
	return (await submission).effects;
}

/**
 * A CLI's terminal as a test scripts it: what its input reads, and how that changes as a paste and Enter go in - shown as a draft, or
 * emptied again, from the `after`th read on; never, where undefined.
 */
class FakeTerminal {
	reading: InputState = 'usable';
	/** A draft as the CLI draws it: the text pasted, by default, as `draws` shows it. */
	draft: string | undefined;
	draws: (text: string) => string = text => text;
	/** As a ptyd from before leads: what it is given ahead of the paste, it does not type. */
	dropsLead = false;
	readonly calls: string[] = [];
	showsPasteAfter: number | undefined = 1;
	takesEnterAfter: number | undefined = 1;
	paste: InputEffect | Error = { outcome: 'applied', pasted: true, entered: false };
	enter: InputEffect | Error = { outcome: 'applied', keysSent: 1 };
	/** What a read waits for before it answers, where it should wait. */
	gate: Promise<void> | undefined;
	onPaste: () => void = () => undefined;
	private change: { to: InputState; reads: number } | undefined;

	readonly inspectInput = async (run: RunId, adapter: string): Promise<InputReading | undefined> => {
		this.calls.push(`read ${run === RUN ? '' : `${run} `}by ${adapter}`);
		await this.gate;
		if (this.change && --this.change.reads <= 0) {
			this.reading = this.change.to;
			this.change = undefined;
		}
		return { state: this.reading, evidence: `scripted ${this.reading}`, ...this.reading === 'draft' && this.draft !== undefined ? { draft: this.draft } : {} };
	};

	readonly typeText = async (run: RunId, text: string, enter: boolean, lead?: string): Promise<InputEffect> => {
		this.calls.push(`type ${run === RUN ? '' : `${run} `}${lead !== undefined ? `${JSON.stringify(lead)} then ` : ''}${JSON.stringify(text)}${enter ? ' and Enter' : ''}`);
		if (this.paste instanceof Error) {
			throw this.paste;
		}
		if (this.showsPasteAfter !== undefined && run === RUN) {
			this.change = { to: 'draft', reads: this.showsPasteAfter };
			// What a ptyd from before leads would leave out, where the test says so
			this.draft = `${this.dropsLead ? '' : lead ?? ''}${this.draws(text)}`;
		}
		this.onPaste();
		return this.paste;
	};

	readonly pressKeys = async (_run: RunId, keys: readonly string[]): Promise<InputEffect> => {
		this.calls.push(`keys ${keys.join(' ')}`);
		if (this.enter instanceof Error) {
			throw this.enter;
		}
		if (this.takesEnterAfter !== undefined) {
			this.change = { to: 'usable', reads: this.takesEnterAfter };
		}
		return this.enter;
	};
}

function setUp(facts: Partial<RunFacts> = {}, platform: NodeJS.Platform = 'darwin') {
	const terminal = new FakeTerminal();
	const runs = new Map<RunId, RunFacts>([RUN, OTHER].map((id, i) => [id, {
		id, alias: `#a${i + 2}`, displayName: 'Claude Code', lifecycle: 'running', inputAdapter: 'claude-frame', inputCapability: SUPPORTED, ...facts
	} as RunFacts]));
	const log: string[] = [];
	const waits: number[] = [];
	let now = 0;
	const input = new OrdinaryInput({
		get: run => runs.get(run),
		inspectInput: terminal.inspectInput,
		typeText: terminal.typeText,
		pressKeys: terminal.pressKeys,
		log: text => log.push(text),
		platform,
		monotonic: () => now,
		// Time moves only as the input waits: each wait is its own read apart
		wait: async (ms, signal) => {
			if (signal?.aborted) {
				throw new Error('Cancelled');
			}
			waits.push(ms);
			now += ms;
		}
	});
	return { input, terminal, runs, log, waits, waited: () => waits.reduce((sum, ms) => sum + ms, 0) };
}

suite('Ordinary message input: a whole paste, Enter once it shows, confirmed once the input empties (CLIS-2.1, RULES-1.3, 1.4, 1.10)', () => {

	test('its capability is what the run\'s launch found - supported whenever its CLI has an input reader, whatever the version (D89); the launch\'s own reason otherwise', () => {
		const unreadable: CapabilityState = { state: 'unavailable', reason: 'Facade cannot read the message input of Example CLI, so messages to it fail; direct terminal input still works' };
		assert.deepStrictEqual(setUp().input.capability(RUN), SUPPORTED);
		assert.deepStrictEqual(setUp({ version: '2.1.999' }).input.capability(RUN), SUPPORTED, 'a version never recorded is read by its layout all the same');
		assert.deepStrictEqual(setUp({ inputAdapter: undefined, inputCapability: unreadable }).input.capability(RUN), unreadable);
		assert.strictEqual(setUp({ inputAdapter: undefined }).input.capability(RUN).state, 'unverified', 'supported with no reader to read it is not');
		const unplanned = setUp({ inputAdapter: undefined, inputCapability: undefined }).input.capability(RUN);
		assert.deepStrictEqual([unplanned.state, /not known before its launch is planned/.test(unplanned.reason)], ['unverified', true]);
		assert.strictEqual(setUp().input.capability('run-unknown').state, 'unverified');
	});

	test('inspect reads the input with the run\'s own adapter, logging what a reading that holds delivery back rested on; unsupported input is unknown, never read', async () => {
		const { input, terminal, log } = setUp();
		assert.strictEqual(await input.inspect(RUN), 'usable');
		terminal.reading = 'draft';
		assert.strictEqual(await input.inspect(RUN), 'draft');
		assert.deepStrictEqual(terminal.calls, ['read by claude-frame', 'read by claude-frame']);
		assert.deepStrictEqual(log, ['Message input of #a2: input reads draft by claude-frame: scripted draft']);
		const unverified = setUp({ inputAdapter: undefined, inputCapability: { state: 'unavailable', reason: 'no reader' } });
		assert.strictEqual(await unverified.input.inspect(RUN), 'unknown');
		assert.deepStrictEqual(unverified.terminal.calls, []);
	});

	test('a screen its reader does not recognize - a changed layout - is unknown, and nothing is pasted into it (D89, RULES-1.4)', async () => {
		const { input, terminal } = setUp();
		terminal.reading = 'unknown';
		assert.strictEqual(await input.inspect(RUN), 'unknown');
		assert.deepStrictEqual(await effects(input.submit(RUN, 'Hello')), NOTHING);
		assert.deepStrictEqual(terminal.calls, ['read by claude-frame', 'read by claude-frame']);
	});

	test('a run ptyd does not hold, or a reading that fails, is unknown', async () => {
		const gone = setUp();
		const missing = new OrdinaryInput({ get: () => gone.runs.get(RUN), inspectInput: async () => undefined, typeText: gone.terminal.typeText, pressKeys: gone.terminal.pressKeys });
		assert.strictEqual(await missing.inspect(RUN), 'unknown');
		const failing = new OrdinaryInput({ get: () => gone.runs.get(RUN), inspectInput: async () => { throw new PtydLost('lost'); }, typeText: gone.terminal.typeText, pressKeys: gone.terminal.pressKeys });
		assert.strictEqual(await failing.inspect(RUN), 'unknown');
	});

	test('type_text: its text, then its Enter in a write of its own a moment later - a tenth of a second, more for a long paste, on Windows and for Antigravity\'s lines (MCP-5.2, D113)', async () => {
		const { input, terminal, waits } = setUp();
		assert.deepStrictEqual(await input.typeDirect(RUN, 'yes', true), { outcome: 'applied', pasted: true, entered: true });
		assert.deepStrictEqual(terminal.calls, ['type "yes"', 'type "" and Enter']);
		assert.deepStrictEqual(waits, [100]);
		// Text alone, or Enter alone, is the one write asked for
		terminal.calls.length = 0;
		await input.typeDirect(RUN, 'draft only', false);
		await input.typeDirect(RUN, '', true);
		assert.deepStrictEqual(terminal.calls, ['type "draft only"', 'type "" and Enter']);
		assert.deepStrictEqual(waits, [100]);
		const windows = setUp({}, 'win32');
		await windows.input.typeDirect(RUN, 'x'.repeat(64_000), true);
		assert.deepStrictEqual(windows.waits, [1_100]);
		const agy = setUp({ inputAdapter: 'agy-frame' });
		await agy.input.typeDirect(RUN, 'a\nb\nc', true);
		assert.deepStrictEqual(agy.waits, [100 + 3 * 45]);
	});

	test('type_text: text the run ended before is not followed by Enter; an Enter it ended before, or ptyd never sent, is not claimed (MCP-5.2)', async () => {
		const ended = setUp();
		ended.terminal.paste = { outcome: 'partial', reason: 'ended', pasted: true, entered: false };
		assert.deepStrictEqual(await ended.input.typeDirect(RUN, 'yes', true), { outcome: 'partial', reason: 'ended', pasted: true, entered: false });
		assert.deepStrictEqual(ended.terminal.calls, ['type "yes"']);
		const late = setUp();
		let typed = 0;
		late.terminal.onPaste = () => {
			if (++typed === 2) {
				late.terminal.paste = { outcome: 'not_applied', reason: 'ended', pasted: false, entered: false };
			}
		};
		assert.deepStrictEqual(await late.input.typeDirect(RUN, 'yes', true), { outcome: 'partial', reason: 'ended', pasted: true, entered: false });
		let writes = 0;
		const unsent = new OrdinaryInput({
			get: () => ({ id: RUN, alias: '#a2', displayName: 'Claude Code', lifecycle: 'running', inputAdapter: 'claude-frame', inputCapability: SUPPORTED } as RunFacts),
			inspectInput: async () => undefined,
			typeText: async () => {
				if (++writes === 2) {
					throw new PtydNotSent('not sent');
				}
				return { outcome: 'applied', pasted: true, entered: false };
			},
			pressKeys: async () => ({ outcome: 'applied', keysSent: 1 }),
			wait: async () => undefined
		});
		assert.deepStrictEqual(await unsent.typeDirect(RUN, 'yes', true), { outcome: 'partial', pasted: true, entered: false });
	});

	test('the message goes in as one paste without Enter, Enter once the CLI shows it as a draft, and is confirmed once its input is empty again', async () => {
		const { input, terminal, waits } = setUp();
		const text = '[Facade message #m1 | from @lead #a1 | window Design]\nReview the API.\n[/Facade message #m1]';
		assert.deepStrictEqual(await input.submit(RUN, text), { effects: CONFIRMED, shown: true, draft: text });
		assert.deepStrictEqual(terminal.calls, ['read by claude-frame', `type ${JSON.stringify(text)}`, 'read by claude-frame', 'keys Enter', 'read by claude-frame']);
		assert.deepStrictEqual(waits, []);
	});

	test('it waits for the draft and for the empty input, reading every 100 ms: busy or idle, an emptied input is the CLI\'s acceptance', async () => {
		const { input, terminal, waits } = setUp();
		terminal.showsPasteAfter = 4;
		terminal.takesEnterAfter = 6;
		assert.deepStrictEqual(await effects(input.submit(RUN, 'Hello')), CONFIRMED);
		assert.deepStrictEqual(terminal.calls.filter(call => !call.startsWith('read')), ['type "Hello"', 'keys Enter']);
		assert.deepStrictEqual(waits, [100, 100, 100, 100, 100, 100, 100, 100]);
	});

	test('Enter after which the input stays full is unconfirmed: its effects unknown, the text and Enter written', async () => {
		const { input, terminal, log, waited } = setUp();
		terminal.takesEnterAfter = undefined;
		assert.deepStrictEqual(await input.submit(RUN, 'Hello'), { effects: { outcome: 'unknown', text_written: 'full', enter_written: true }, shown: true, draft: 'Hello' });
		assert.strictEqual(waited(), 3_000);
		assert.deepStrictEqual(log, ['Message input of #a2: its input did not empty within 3 seconds of Enter, so the message\'s submission is not confirmed yet']);
	});

	test('a paste that never shows as a draft gets no Enter: the text was written, what the CLI holds is not known', async () => {
		const { input, terminal, log, waited } = setUp();
		terminal.showsPasteAfter = undefined;
		assert.deepStrictEqual(await input.submit(RUN, 'Hello'), { effects: { outcome: 'unknown', text_written: 'full', enter_written: false }, shown: false });
		assert.ok(!terminal.calls.includes('keys Enter'));
		assert.strictEqual(waited(), 2_000);
		assert.match(log[0], /did not show alone in its input within 2 seconds, so Enter was not pressed/);
	});

	test('an input no longer usable in the submission\'s turn - direct input came after delivery looked - is not pasted into', async () => {
		const { input, terminal } = setUp();
		terminal.reading = 'draft';
		assert.deepStrictEqual(await effects(input.submit(RUN, 'Hello')), NOTHING);
		assert.deepStrictEqual(terminal.calls, ['read by claude-frame']);
		const unverified = setUp({ inputAdapter: undefined, inputCapability: { state: 'unavailable', reason: 'no reader' } });
		assert.deepStrictEqual(await effects(unverified.input.submit(RUN, 'Hello')), NOTHING);
		assert.deepStrictEqual(unverified.terminal.calls, []);
	});

	test('input ptyd was never given went nowhere; an answer lost on the way is not known; an Enter that did not go in leaves the text alone', async () => {
		const notSent = setUp();
		notSent.terminal.paste = new PtydNotSent('not reached');
		assert.deepStrictEqual(await effects(notSent.input.submit(RUN, 'Hello')), NOTHING);
		const lost = setUp();
		lost.terminal.paste = new PtydLost('lost');
		await assert.rejects(lost.input.submit(RUN, 'Hello'), PtydLost);
		const ended = setUp();
		ended.terminal.paste = { outcome: 'not_applied', reason: 'ended', pasted: false, entered: false };
		assert.deepStrictEqual(await effects(ended.input.submit(RUN, 'Hello')), NOTHING);
		const unentered = setUp();
		unentered.terminal.enter = { outcome: 'not_applied', reason: 'ended', keysSent: 0 };
		assert.deepStrictEqual(await effects(unentered.input.submit(RUN, 'Hello')), { outcome: 'partial', text_written: 'full', enter_written: false });
		const enterNotSent = setUp();
		enterNotSent.terminal.enter = new PtydNotSent('not reached');
		assert.deepStrictEqual(await effects(enterNotSent.input.submit(RUN, 'Hello')), { outcome: 'partial', text_written: 'full', enter_written: false });
		const enterLost = setUp();
		enterLost.terminal.enter = new PtydLost('lost');
		assert.deepStrictEqual(await effects(enterLost.input.submit(RUN, 'Hello')), { outcome: 'unknown', text_written: 'full', enter_written: null });
	});

	test('a submission cut off - its deadline passed or its run ended - sends nothing more: no paste before it, no Enter after the paste', async () => {
		const before = setUp();
		const stopped = new AbortController();
		stopped.abort();
		assert.deepStrictEqual(await effects(before.input.submit(RUN, 'Hello', stopped.signal)), NOTHING);
		assert.deepStrictEqual(before.terminal.calls, []);
		const during = setUp();
		const cutoff = new AbortController();
		during.terminal.showsPasteAfter = 5;
		during.terminal.onPaste = () => cutoff.abort();
		assert.deepStrictEqual(await effects(during.input.submit(RUN, 'Hello', cutoff.signal)), { outcome: 'unknown', text_written: 'full', enter_written: false });
		assert.ok(!during.terminal.calls.includes('keys Enter'));
	});

	test('a draft is the message\'s own only where it is its text alone - wrapped and indented as its CLI draws it - or its CLI\'s placeholder for a paste of its size (RULES-1.6, CLIS-2.1)', () => {
		const text = '[Facade message #m1 | from @lead #a1 | window Design]\nReview the API,\tits errors and its docs.\n[/Facade message #m1]';
		// Rows wrapped at the terminal's width and indented under the prompt row; a no-break space after the prompt
		assert.ok(isOwnDraft('[Facade message #m1 | from @lead #a1 | window Design]\n  Review the API,    its errors and its\n  docs.\n[/Facade message #m1]', text, 'claude-frame'));
		assert.ok(isOwnDraft(' [Facade message #m1 | from @lead #a1 | window Design] Review the API, its errors and its docs. [/Facade message #m1]', text, 'pi-frame'));
		// Text a person added, or took away, is not its own
		assert.ok(!isOwnDraft(`${text} and fix it`, text, 'claude-frame'));
		assert.ok(!isOwnDraft(text.slice(0, -10), text, 'claude-frame'));
		const long = Array.from({ length: 33 }, (_, line) => `line ${line + 1} of a long message, 中文 too`).join('\n');
		const chars = [...long].length;
		for (const [adapter, placeholder, own] of [
			// Claude Code counts the lines after the first; Antigravity, Pi and OpenCode every line
			['claude-frame', '[Pasted text #1 +32 lines]', true],
			['agy-frame', '[Pasted text #2 +33 lines]', true],
			['pi-frame', '[paste #1 +33 lines]', true],
			['opencode-frame', '[Pasted ~33 lines]', true],
			// Codex and Muse Code count characters, as code points or UTF-16 units
			['codex-prompt', `[Pasted Content ${chars} chars]`, true],
			['muse-frame', `[Pasted Content ${chars} chars]`, true],
			// The same words, counted another CLI's way, are some other paste
			['claude-frame', '[Pasted text #1 +33 lines]', false],
			['agy-frame', '[Pasted text #1 +32 lines]', false],
			['codex-prompt', `[Pasted Content ${Buffer.byteLength(long)} chars]`, false],
			['codex-prompt', `[Pasted Content ${chars + 1} chars]`, false],
			['pi-frame', '[Pasted ~33 lines]', false],
			// Another paste beside it, or text around it, is not its own
			['claude-frame', '[Pasted text #1 +32 lines] [Pasted text #2 +3 lines]', false],
			['claude-frame', 'fix this [Pasted text #1 +32 lines]', false]
		] as const) {
			assert.strictEqual(isOwnDraft(placeholder, long, adapter), own, `${adapter} ${placeholder}`);
		}
	});

	test('Pi counts a wide paste\'s characters as it draws them - its tabs four spaces - and a draft scrolled in its box is its own by the end in sight, rows out of sight above alone (D118)', () => {
		const wide = `[Facade message #m6 | from @lead #a1 | window Design]\n${'Review the login flow. '.repeat(50)}\n[/Facade message #m6]`;
		const chars = wide.length;
		assert.ok(chars > 1_000);
		for (const [draft, own] of [
			[`[paste #1 ${chars} chars]`, true],
			[`[paste #12 ${chars} chars]`, true],
			[`[paste #1 ${chars + 1} chars]`, false],
			[`[paste #1 +3 lines]`, true],
			[`[paste #1 +4 lines]`, false],
			[`[Pasted Content ${chars} chars]`, false]
		] as const) {
			assert.strictEqual(isOwnDraft(draft, wide, 'pi-frame'), own, draft);
		}
		assert.ok(isOwnDraft(`[paste #1 ${chars + 4} chars]`, wide.replace('Review', '\tReview'), 'pi-frame'), 'a tab is four of its characters');
		const tall = 'one\ntwo\nthree\nfour\n[/Facade message #m5]';
		for (const [draft, hidden, own] of [
			['three\nfour\n[/Facade message #m5]', { above: 2, below: 0 }, true],
			['three\nfour\n[/Facade message #m5]', undefined, false],
			['three\nfour\n[/Facade message #m5]', { above: 2, below: 1 }, false],
			['one\ntwo\nthree', { above: 0, below: 2 }, false],
			['three\nfour\n[/Facade message #m5] and more', { above: 2, below: 0 }, false],
			['', { above: 5, below: 0 }, false]
		] as const) {
			assert.strictEqual(isOwnDraft(draft, tall, 'agy-frame', undefined, hidden), own, `${JSON.stringify(draft)} ${JSON.stringify(hidden)}`);
		}
	});

	test('once its paste showed as a placeholder, only that same placeholder is its own: a person\'s later paste of its size is not (D118)', async () => {
		const long = Array.from({ length: 33 }, (_, line) => `line ${line + 1}`).join('\n');
		assert.ok(isSameDraft('[Pasted text #1 +32 lines]', '[Pasted text #1 +32 lines]', long));
		assert.ok(!isSameDraft('[Pasted text #2 +32 lines]', '[Pasted text #1 +32 lines]', long));
		// Its text in sight whole is its own however it showed before
		assert.ok(isSameDraft('hello', '[Pasted text #1 +0 lines]', 'hello'));
		const { input, terminal } = setUp();
		terminal.reading = 'draft';
		terminal.draft = '[Pasted text #2 +32 lines]';
		assert.strictEqual(await input.inspect(RUN, long, undefined, '[Pasted text #1 +32 lines]'), 'draft');
		assert.strictEqual(await input.inspect(RUN, long, undefined, '[Pasted text #2 +32 lines]'), 'own');
		assert.deepStrictEqual(await input.enter(RUN, long, undefined, undefined, '[Pasted text #1 +32 lines]'), { outcome: 'none', text_written: 'none', enter_written: false });
		assert.ok(!terminal.calls.includes('keys Enter'));
	});

	test('nothing goes in once its stop came while it read: no paste after the read before it, no Enter after the read that showed its draft (RULES-1.5, 1.7, D118)', async () => {
		const settle = () => new Promise(resolve => setImmediate(resolve));
		// Stopped while it read before its paste
		const before = setUp();
		const stop = new AbortController();
		let open!: () => void;
		before.terminal.gate = new Promise<void>(resolve => { open = resolve; });
		const pasting = before.input.submit(RUN, 'Hello', stop.signal);
		await settle();
		stop.abort();
		open();
		assert.deepStrictEqual(await pasting, { effects: { outcome: 'none', text_written: 'none', enter_written: false }, shown: false });
		assert.ok(!before.terminal.calls.some(call => call.startsWith('type')), before.terminal.calls.join(' | '));
		// Stopped while it read its own draft after its paste: the text in, no Enter
		const after = setUp();
		const halt = new AbortController();
		let release!: () => void;
		after.terminal.onPaste = () => {
			after.terminal.gate = new Promise<void>(resolve => { release = resolve; });
		};
		const entering = after.input.submit(RUN, 'Hello', halt.signal);
		for (let tries = 0; !release && tries < 50; tries++) {
			await settle();
		}
		halt.abort();
		release();
		assert.deepStrictEqual(await entering, { effects: { outcome: 'unknown', text_written: 'full', enter_written: false }, shown: false });
		assert.ok(!after.terminal.calls.includes('keys Enter'), after.terminal.calls.join(' | '));
		// Its Enter over its own draft later, stopped while it read: none
		const later = setUp();
		const ended = new AbortController();
		let free!: () => void;
		later.terminal.reading = 'draft';
		later.terminal.draft = 'Hello';
		later.terminal.gate = new Promise<void>(resolve => { free = resolve; });
		const pressing = later.input.enter(RUN, 'Hello', ended.signal);
		await settle();
		ended.abort();
		free();
		assert.deepStrictEqual(await pressing, { outcome: 'none', text_written: 'none', enter_written: false });
		assert.ok(!later.terminal.calls.includes('keys Enter'));
	});

	test('a paste\'s time beyond the usual: twice its size\'s on this platform, and Antigravity\'s lines (D105, D118)', () => {
		assert.strictEqual(setUp().input.pasteTime(RUN, 'x'.repeat(8_000)), 0);
		assert.strictEqual(setUp({}, 'win32').input.pasteTime(RUN, 'x'.repeat(8_000)), 2 * 100);
		assert.strictEqual(setUp({ inputAdapter: 'agy-frame' }).input.pasteTime(RUN, 'a\nb\nc'), 3 * 45);
	});

	test('Codex on Windows reads a paste a key at a time: 3 ms a UTF-16 unit, in a paste\'s time beyond the usual, the wait for its draft and type_text\'s Enter (D105)', async () => {
		// 9,249 UTF-16 units, as in Orca's measurement of 21.1 s: a character outside the BMP is two key events
		const text = `${'x'.repeat(9_247)}😀`;
		const codex = setUp({ inputAdapter: 'codex-prompt' }, 'win32');
		assert.strictEqual(codex.input.pasteTime(RUN, text), 2 * 100 + 3 * 9_249);
		assert.strictEqual(setUp({ inputAdapter: 'codex-prompt' }).input.pasteTime(RUN, text), 0, 'elsewhere Codex takes a bracketed paste whole');
		assert.strictEqual(setUp({}, 'win32').input.pasteTime(RUN, text), 2 * 100, 'Claude Code on Windows takes it at ConPTY\'s rate alone');
		// A draft drawn only after 21 seconds of reading is waited for, and gets its Enter
		codex.terminal.showsPasteAfter = 211;
		assert.deepStrictEqual(await effects(codex.input.submit(RUN, text)), CONFIRMED);
		assert.ok(codex.terminal.calls.includes('keys Enter'));
		const direct = setUp({ inputAdapter: 'codex-prompt' }, 'win32');
		await direct.input.typeDirect(RUN, 'y'.repeat(1_000), true);
		assert.deepStrictEqual(direct.waits, [100 + 3 * 1_000]);
	});

	test('Enter goes only over the message\'s own draft: a CLI\'s placeholder for it, never a draft a person changed (RULES-1.6)', async () => {
		const { input, terminal } = setUp();
		const text = Array.from({ length: 33 }, (_, line) => `line ${line + 1}`).join('\n');
		terminal.draws = () => '[Pasted text #1 +32 lines]';
		assert.deepStrictEqual(await input.submit(RUN, text), { effects: CONFIRMED, shown: true, draft: '[Pasted text #1 +32 lines]' });
		// Someone typed after the paste: no Enter, the text written, its draft not shown as its own
		const changed = setUp();
		changed.terminal.draws = pasted => `${pasted} and more`;
		assert.deepStrictEqual(await changed.input.submit(RUN, 'Hello'), { effects: { outcome: 'unknown', text_written: 'full', enter_written: false }, shown: false });
		assert.ok(!changed.terminal.calls.includes('keys Enter'));
	});

	test('inspect knows the message\'s own draft; enter presses Enter over it alone, read again in its turn, and confirms it once the input empties', async () => {
		const { input, terminal } = setUp();
		terminal.reading = 'draft';
		terminal.draft = 'Hello';
		assert.deepStrictEqual([await input.inspect(RUN, 'Hello'), await input.inspect(RUN, 'Bye'), await input.inspect(RUN)], ['own', 'draft', 'draft']);
		assert.deepStrictEqual(await input.enter(RUN, 'Hello'), CONFIRMED);
		assert.deepStrictEqual(terminal.calls.filter(call => !call.startsWith('read')), ['keys Enter']);
		// Not its own any more: nothing pressed
		const other = setUp();
		other.terminal.reading = 'draft';
		other.terminal.draft = 'Hello there';
		assert.deepStrictEqual(await other.input.enter(RUN, 'Hello'), NOTHING);
		assert.deepStrictEqual(other.terminal.calls, ['read by claude-frame']);
	});

	test('a message\'s lead is typed ahead of its paste only where the CLI takes a paste alone as material - Claude Code - and its draft is its own with that lead, or without it from an older ptyd (D108)', async () => {
		const lead = 'Act on this Facade message: ';
		const text = Array.from({ length: 3 }, (_, line) => `line ${line + 1}`).join('\n');
		const claude = setUp();
		claude.terminal.draws = () => '[Pasted text #1 +2 lines]';
		assert.deepStrictEqual(await effects(claude.input.submit(RUN, text, undefined, lead)), CONFIRMED);
		assert.deepStrictEqual(claude.terminal.calls.filter(call => !call.startsWith('read')), [`type ${JSON.stringify(lead)} then ${JSON.stringify(text)}`, 'keys Enter']);
		const older = setUp();
		older.terminal.dropsLead = true;
		assert.deepStrictEqual(await effects(older.input.submit(RUN, text, undefined, lead)), CONFIRMED);
		// Another CLI takes the paste alone: no lead typed
		const codex = setUp({ inputAdapter: 'codex-prompt' });
		assert.deepStrictEqual(await effects(codex.input.submit(RUN, text, undefined, lead)), CONFIRMED);
		assert.ok(codex.terminal.calls.includes(`type ${JSON.stringify(text)}`), codex.terminal.calls.join(' | '));
		// The lead alone, or other words before the paste, are not its own
		assert.ok(isOwnDraft(`${lead}[Pasted text #1 +2 lines]`, text, 'claude-frame', lead));
		assert.ok(!isOwnDraft('Do something else: [Pasted text #1 +2 lines]', text, 'claude-frame', lead));
		assert.ok(!isOwnDraft(lead, text, 'claude-frame', lead));
	});

	test('Enter waits for the time a paste of its size takes: its bytes at ConPTY\'s 64 a millisecond on Windows, and 45 ms a line more for Antigravity (D105)', async () => {
		const text = `${'x'.repeat(19_999)}\n${'y'.repeat(30)}`;
		// Windows: a paste that never shows is waited for 2 s and the 300 ms its 20 KB take
		const windows = setUp({}, 'win32');
		windows.terminal.showsPasteAfter = undefined;
		await windows.input.submit(RUN, text);
		assert.strictEqual(windows.waited(), 2_300);
		// Antigravity: shown at once, then two lines' 90 ms before Enter
		const agy = setUp({ inputAdapter: 'agy-frame' });
		assert.deepStrictEqual(await effects(agy.input.submit(RUN, text)), CONFIRMED);
		assert.deepStrictEqual(agy.waits, [90]);
		assert.deepStrictEqual(agy.terminal.calls.filter(call => !call.startsWith('read')).map(call => call.slice(0, 7)), ['type "x', 'keys En']);
	});

	test('direct text and keys for the same terminal wait for a submission under way, never landing between its paste and its Enter; another terminal\'s do not wait', async () => {
		const { input, terminal } = setUp();
		let open!: () => void;
		// The reading after the paste is held back: the submission stays between its paste and its Enter
		terminal.onPaste = () => {
			terminal.onPaste = () => undefined;
			terminal.gate = new Promise(resolve => open = resolve);
		};
		const submitted = input.submit(RUN, 'Hello');
		await new Promise(resolve => setImmediate(resolve));
		const direct = input.inTurn(RUN, () => terminal.typeText(RUN, 'typed', false));
		const elsewhere = input.inTurn(OTHER, () => terminal.typeText(OTHER, 'there', false));
		await elsewhere;
		assert.deepStrictEqual(terminal.calls.filter(call => !call.startsWith('read')), ['type "Hello"', `type ${OTHER} "there"`]);
		terminal.gate = undefined;
		open();
		assert.deepStrictEqual(await effects(submitted), CONFIRMED);
		await direct;
		assert.deepStrictEqual(terminal.calls.filter(call => !call.startsWith('read')), ['type "Hello"', `type ${OTHER} "there"`, 'keys Enter', 'type "typed"']);
	});
});

suite('A start\'s typing before the first turn: the CLI\'s tools ready before it takes a task (COLLABORATION-2.2)', () => {
	const WARM_UP = { text: '/mcp', typed: '^> /mcp\\s*$', ready: '✓\\s+facade_facade\\b', opened: '^MCP Servers\\s*$|\\besc Exit\\b', close: 'Escape' };

	/** The input of a run whose screen shows `/mcp` once typed and the tools' panel once entered, unless `shows` says otherwise. */
	function warming(facts: Partial<RunFacts> = {}, shows: { readonly panel: boolean; readonly typedFirst?: string; readonly closedBy?: 'person' } = { panel: true }, starting = 0) {
		const world = setUp(facts);
		let unrecognized = starting;
		const inspectInput = world.terminal.inspectInput;
		let screen = ['>'];
		const typeText = world.terminal.typeText;
		const pressKeys = world.terminal.pressKeys;
		let now = 0;
		const input = new OrdinaryInput({
			get: run => world.runs.get(run),
			inspectInput: async (run, adapter) => unrecognized-- > 0 ? { state: 'unknown', evidence: 'still starting' } : inspectInput(run, adapter),
			typeText: async (run, text, enter) => {
				// The person may have typed first, the paste going on after their text
				screen = [`> ${shows.typedFirst ?? ''}${text}`];
				return typeText(run, text, enter);
			},
			pressKeys: async (run, keys) => {
				if (keys[0] === 'Enter' && screen[0] === '> /mcp') {
					// A panel the person closes at once leaves the input behind
					screen = shows.closedBy === 'person' ? ['>'] : ['MCP Servers', shows.panel ? '>  ✓ facade_facade  Tools: list_agents' : '>  ⋯ facade_facade'];
				} else if (keys[0] === 'Escape') {
					screen = ['>'];
				}
				return pressKeys(run, keys);
			},
			readScreen: async () => ({ lines: screen, text: screen, buffer: 'normal', older: false, trimmed: false, capturedAt: 0, exited: false }),
			log: text => world.log.push(text),
			monotonic: () => now,
			wait: async ms => {
				now += ms;
			}
		});
		return { ...world, input, now: () => now };
	}

	test('once its input first reads empty, ahead of any message: the text, Enter, the close key once its screen shows the tools ready, then the message', async () => {
		// Its CLI still starting: three readings of nothing it recognizes, then its empty input
		const world = warming({}, { panel: true }, 3);
		const warm = world.input.warmUp(RUN, WARM_UP);
		const sent = world.input.submit(RUN, 'hello');
		await warm;
		assert.deepStrictEqual(await effects(sent), CONFIRMED);
		const typed = world.terminal.calls.filter(call => !call.startsWith('read'));
		assert.deepStrictEqual(typed, ['type "/mcp"', 'keys Enter', 'keys Escape', 'type "hello"', 'keys Enter']);
		assert.ok(world.log.some(line => /tools were shown ready, and its input reads empty again/.test(line)), world.log.join('\n'));
	});

	test('given up, typing nothing, where its input first reads a draft - the person typing first - or a question, or the CLI is working', async () => {
		for (const [first, facts] of [['draft', {}], ['interaction', {}], ['usable', { activity: 'working' }]] as const) {
			const world = warming(facts);
			world.terminal.reading = first;
			await world.input.warmUp(RUN, WARM_UP);
			assert.deepStrictEqual(world.terminal.calls.filter(call => !call.startsWith('read')), [], first);
			assert.ok(world.log.some(line => line.includes(`nothing is typed before its first turn: its input first read ${first}`)), world.log.join('\n'));
		}
	});

	test('nothing is submitted with text the person typed meanwhile, and nothing is closed once the person closed the panel', async () => {
		const typedFirst = warming({}, { panel: true, typedFirst: 'fix ' });
		await typedFirst.input.warmUp(RUN, WARM_UP);
		assert.deepStrictEqual(typedFirst.terminal.calls.filter(call => !call.startsWith('read')), ['type "/mcp"'], 'no Enter: the input holds more than its text');
		assert.ok(typedFirst.log.some(line => /did not show alone in its input/.test(line)), typedFirst.log.join('\n'));
		const closed = warming({}, { panel: true, closedBy: 'person' });
		await closed.input.warmUp(RUN, WARM_UP);
		assert.deepStrictEqual(closed.terminal.calls.filter(call => !call.startsWith('read')), ['type "/mcp"', 'keys Enter'], 'no Escape once the panel is gone');
	});

	test('an input that never reads within the wait is given up; a panel that never shows ready is closed after its wait', async () => {
		const silent = warming();
		silent.terminal.reading = 'unknown';
		await silent.input.warmUp(RUN, WARM_UP);
		assert.deepStrictEqual(silent.terminal.calls.filter(call => !call.startsWith('read')), []);
		assert.ok(silent.now() >= 30_000);
		const slow = warming({}, { panel: false });
		await slow.input.warmUp(RUN, WARM_UP);
		assert.deepStrictEqual(slow.terminal.calls.filter(call => !call.startsWith('read')), ['type "/mcp"', 'keys Enter', 'keys Escape']);
		assert.ok(slow.log.some(line => /did not show ready within 10 seconds/.test(line)), slow.log.join('\n'));
	});
});
