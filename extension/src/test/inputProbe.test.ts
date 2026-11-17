/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { CapabilityState, RunFacts, RunId } from '../core/ports';
import { OrdinaryInput } from '../host/input';
import type { InputEffect, InputLine, InputReading } from '../ptyd/protocol';

const RUN = 'run-dddddddddddddddddddddddddddddddd';
const NEXT = 'run-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SUPPORTED: CapabilityState = { state: 'supported', reason: 'muse-frame reads Muse Code\'s input by its layout.' };
const HINT = 'review my changes';
const DRAFT = 'hello there';
/** Where the input starts on its row, after `❯ `, and the row. */
const START = 2;
const ROW = 10;

/**
 * A CLI's input row as Muse 1.4.20 draws it: what is typed before the cursor in the default color, then in color a draft after the
 * cursor or, with nothing else there, a hint. A row with only colored text after the cursor where the input starts reads unsure, with
 * the person's writes counted, as ptyd reads it; `oldPtyd` reads it as a ptyd from before probes did, plain unknown. Keys go in as the
 * CLI takes them, unless they were pressed `unlessTyped` a count of the person's writes that is no longer theirs.
 */
class ProbedRow {
	hint: string | undefined;
	after = '';
	typed = '';
	person = 0;
	pasted: string | undefined;
	ignoreSpace = false;
	ignoreBackspace = false;
	noLeadingSpace = false;
	/** A suggestion on the row under the input while it starts with a space. */
	suggests = false;
	oldPtyd = false;
	/** What happens after a key the CLI took, such as the person typing. */
	afterKey: (key: string) => void = () => undefined;
	/** Keys pressed, `paste` for a paste, `refused` for a key not sent as the person typed first. */
	readonly pressed: string[] = [];
	readonly submitted: string[] = [];

	readonly inspectInput = async (_run: RunId, _adapter: string): Promise<InputReading | undefined> => {
		if (this.pasted !== undefined) {
			return { state: 'draft', evidence: 'scripted paste', draft: this.pasted };
		}
		const shown = this.noLeadingSpace ? this.typed.trimStart() : this.typed;
		const colored = shown === '' && this.after === '' ? this.hint ?? '' : this.after;
		if (shown === '' && colored === '') {
			return { state: 'usable', evidence: 'scripted empty' };
		}
		const line: InputLine = {
			y: ROW, start: START, rest: this.suggests && this.typed.startsWith(' '), cursor: { x: START + shown.length, y: ROW },
			cells: [...[...shown].map(chars => ({ chars, dim: false, colored: false })), ...[...colored].map(chars => ({ chars, dim: false, colored: true }))]
		};
		if (shown === '') {
			return this.oldPtyd
				? { state: 'unknown', evidence: 'scripted hint or draft' }
				: { state: 'unknown', evidence: 'scripted hint or draft', unsure: true, line, typed: this.person };
		}
		return { state: 'draft', evidence: 'scripted draft', draft: shown + colored, line, ...this.oldPtyd ? {} : { typed: this.person } };
	};

	readonly typeText = async (_run: RunId, text: string): Promise<InputEffect> => {
		this.pressed.push('paste');
		this.pasted = text;
		return { outcome: 'applied', pasted: true, entered: false };
	};

	readonly pressKeys = async (_run: RunId, keys: readonly string[], unlessTyped?: number): Promise<InputEffect> => {
		if (unlessTyped !== undefined && !this.oldPtyd && unlessTyped !== this.person) {
			this.pressed.push('refused');
			return { outcome: 'not_applied', typedFirst: true, keysSent: 0 };
		}
		for (const key of keys) {
			this.pressed.push(key);
			if (key === 'Space' && !this.ignoreSpace) {
				this.typed += ' ';
			} else if (key === 'Backspace' && !this.ignoreBackspace) {
				this.typed = this.typed.slice(0, -1);
			} else if (key === 'Enter' && this.pasted !== undefined) {
				this.submitted.push(this.pasted);
				this.pasted = undefined;
			}
			this.afterKey(key);
		}
		return { outcome: 'applied', keysSent: keys.length };
	};

}

function setUp(row: Partial<ProbedRow> = {}) {
	const terminal = Object.assign(new ProbedRow(), row);
	const runs = new Map<RunId, RunFacts>([RUN, NEXT].map((id, i) => [id, {
		id, alias: `#a${i + 2}`, displayName: 'Muse Code', lifecycle: 'running', inputAdapter: 'muse-frame', inputCapability: SUPPORTED
	} as RunFacts]));
	const log: string[] = [];
	let now = 0;
	const input = new OrdinaryInput({
		get: run => runs.get(run),
		inspectInput: terminal.inspectInput,
		typeText: terminal.typeText,
		pressKeys: terminal.pressKeys,
		log: text => log.push(text),
		platform: 'darwin',
		monotonic: () => now,
		wait: async ms => { now += ms; }
	});
	return { input, terminal, runs, log };
}

suite('A hint or a draft where the input starts is told apart by a space typed and taken back, once a run (CLIS-2.1, RULES-1.4)', () => {

	test('inspect says unsure and presses no key; the submission that follows probes in turn', async () => {
		const { input, terminal } = setUp({ hint: HINT });
		assert.strictEqual(await input.inspect(RUN), 'unsure');
		assert.deepStrictEqual(terminal.pressed, []);
	});

	test('a hint: Space, Backspace, then the paste and its Enter; the run\'s next message presses no Space; a new run probes again', async () => {
		const { input, terminal, log } = setUp({ hint: HINT });
		assert.strictEqual((await input.submit(RUN, 'first')).effects.outcome, 'confirmed');
		assert.deepStrictEqual(terminal.pressed, ['Space', 'Backspace', 'paste', 'Enter']);
		assert.strictEqual((await input.submit(RUN, 'second')).effects.outcome, 'confirmed');
		assert.deepStrictEqual(terminal.pressed.slice(4), ['paste', 'Enter'], 'the run remembers the hint');
		assert.deepStrictEqual(terminal.submitted, ['first', 'second'], 'no space of the probe\'s went in');
		assert.strictEqual((await input.submit(NEXT, 'third')).effects.outcome, 'confirmed');
		assert.deepStrictEqual(terminal.pressed.slice(6), ['Space', 'Backspace', 'paste', 'Enter'], 'another run tries the row again');
		assert.ok(log.some(line => /input probe found a hint/.test(line)), log.join('\n'));
		assert.ok(!log.some(line => line.includes(HINT)), 'the log shows the row\'s shape, never its text');
	});

	test('a draft before the cursor: Space, Backspace, the draft as it was, and the message held as input_draft; its retries press nothing', async () => {
		const { input, terminal } = setUp({ after: DRAFT });
		const held = await input.submit(RUN, 'a message');
		assert.deepStrictEqual([held.held, held.effects.outcome], ['input_draft', 'none']);
		assert.deepStrictEqual(terminal.pressed, ['Space', 'Backspace']);
		assert.strictEqual(terminal.typed + terminal.after, DRAFT, 'the draft as it was');
		assert.strictEqual((await input.submit(RUN, 'a message')).held, 'input_draft');
		assert.deepStrictEqual(terminal.pressed, ['Space', 'Backspace'], 'one probe a row a run');
	});

	test('a space that goes in with a row under it is neither: Backspace, the row as it was, held as input_unknown, no other probe', async () => {
		const { input, terminal } = setUp({ after: DRAFT, suggests: true });
		assert.strictEqual((await input.submit(RUN, 'a message')).held, 'input_unknown');
		assert.deepStrictEqual(terminal.pressed, ['Space', 'Backspace']);
		assert.strictEqual(terminal.typed, '');
		await input.submit(RUN, 'a message');
		assert.deepStrictEqual(terminal.pressed, ['Space', 'Backspace']);
	});

	for (const [label, row] of [['ignores Space', { ignoreSpace: true }], ['draws no space where its input starts', { noLeadingSpace: true }]] as const) {
		test(`a CLI that ${label} gets no Backspace, and no other probe`, async () => {
			const { input, terminal } = setUp({ after: DRAFT, ...row });
			assert.strictEqual((await input.submit(RUN, 'a message')).held, 'input_unknown');
			await input.submit(RUN, 'a message');
			assert.deepStrictEqual(terminal.pressed, ['Space']);
		});
	}

	test('a Backspace that does not put the row back presses nothing more', async () => {
		const { input, terminal } = setUp({ after: DRAFT, ignoreBackspace: true });
		const submitted = await input.submit(RUN, 'a message');
		assert.strictEqual(submitted.effects.outcome, 'none');
		assert.deepStrictEqual(terminal.pressed, ['Space', 'Backspace']);
	});

	test('the person writing after the probe\'s Space, before the CLI draws it, stops the probe: its Backspace is not sent', async () => {
		const { input, terminal, log } = setUp({ after: DRAFT });
		// Their write is on its way: counted, not drawn yet, so the space reads taken
		terminal.afterKey = key => { if (key === 'Space') { terminal.person++; } };
		assert.strictEqual((await input.submit(RUN, 'a message')).effects.outcome, 'none');
		assert.deepStrictEqual(terminal.pressed, ['Space', 'refused']);
		assert.strictEqual(terminal.typed, ' ', 'no Backspace went after their write; the probe\'s space stays (RULES-1.4)');
		assert.ok(log.some(line => /as the person typed first/.test(line)), log.join('\n'));
	});

	test('a ptyd from before probes, whose readings carry no unsure row or count of the person\'s writes, is never probed', async () => {
		const { input, terminal } = setUp({ hint: HINT, oldPtyd: true });
		assert.strictEqual((await input.submit(RUN, 'a message')).effects.outcome, 'none');
		assert.deepStrictEqual(terminal.pressed, []);
	});
});
