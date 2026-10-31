/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ATTENTION_MS, attentionText, AttentionNotices } from '../core/attention';
import type { Disposable, Event, RunChange, RunFacts, RunId } from '../core/ports';

class Emitter<T> {
	private readonly listeners = new Set<(value: T) => void>();
	readonly event: Event<T> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) } as Disposable;
	};
	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}
}

const LEAD = 'run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD = 'run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWN = 'run-cccccccccccccccccccccccccccccccc';

/** A window's runs as a test changes them, its timers run by hand, and the notices the creators are given. */
function setUp() {
	const runs = new Map<RunId, RunFacts>();
	const add = (facts: Partial<RunFacts> & { readonly id: RunId }) => runs.set(facts.id, { lifecycle: 'running', ...facts } as RunFacts);
	add({ id: LEAD, alias: '#a1', name: 'Lead', origin: 'human' });
	add({ id: CHILD, alias: '#a2', name: 'Echo', origin: 'agent', creator: LEAD });
	add({ id: OWN, alias: '#a3', name: 'Mine', origin: 'human' });
	const changes = new Emitter<RunChange>();
	const timers: { readonly ms: number; readonly fn: () => void; stopped: boolean }[] = [];
	const told: { readonly to: RunId; readonly agent?: RunId; readonly text: string }[] = [];
	const logged: string[] = [];
	const failing: { error?: Error } = {};
	const notices = new AttentionNotices({
		agents: { get: run => runs.get(run), onDidChange: changes.event },
		messages: {
			report: request => {
				if (failing.error) {
					throw failing.error;
				}
				told.push(request);
				return {} as never;
			}
		},
		log: text => logged.push(text),
		after: (ms, fn) => {
			const timer = { ms, fn, stopped: false };
			timers.push(timer);
			return { dispose: () => { timer.stopped = true; } };
		}
	});
	/** Sets what `run`'s CLI reports it waits on, as its report arrives. */
	const waits = (run: RunId, blocker: RunFacts['blocker']) => {
		runs.set(run, { ...runs.get(run)!, blocker });
		changes.fire({ run, kind: 'reported' });
	};
	/** Runs the timers that are due and not stopped. */
	const elapse = () => timers.filter(timer => !timer.stopped).forEach(timer => (timer.stopped = true, timer.fn()));
	return { runs, notices, waits, elapse, timers, told, changes, logged, failing };
}

suite('Attention: a started agent waiting on its CLI\'s question is reported to its creator (RULES-1.8, D103)', () => {

	test('after twenty seconds of a permission question, its creator is told once; again only once it stopped waiting and waits again', () => {
		const { waits, elapse, timers, told } = setUp();
		waits(CHILD, { kind: 'permission', text: 'Allow Bash(rm -rf build)?' });
		assert.deepStrictEqual(timers.map(timer => timer.ms), [ATTENTION_MS]);
		elapse();
		assert.deepStrictEqual(told.map(each => [each.to, each.agent]), [[LEAD, CHILD]]);
		assert.match(told[0].text, /^@Echo #a2, which you started, is waiting for permission in its terminal \("Allow Bash\(rm -rf build\)\?"\)\. Permission is the person's to give/);
		// Still waiting, its report again: nothing more
		waits(CHILD, { kind: 'permission', text: 'Allow Bash(rm -rf build)?' });
		elapse();
		assert.strictEqual(told.length, 1);
		// It goes on, then waits again: a new count, and a new notice
		waits(CHILD, undefined);
		waits(CHILD, { kind: 'permission' });
		elapse();
		assert.strictEqual(told.length, 2);
	});

	test('a notice that cannot be recorded is logged, never thrown from its timer (D112)', () => {
		const { waits, elapse, told, logged, failing } = setUp();
		failing.error = new Error('the disk is full');
		waits(CHILD, { kind: 'question' });
		assert.doesNotThrow(elapse);
		assert.strictEqual(told.length, 0);
		assert.ok(logged.some(line => line === 'Could not tell #a1 that #a2 waits: the disk is full'), logged.join('\n'));
	});

	test('a question answered within the twenty seconds tells nobody; one that turns into another kind starts its count again', () => {
		const { waits, elapse, told, timers } = setUp();
		waits(CHILD, { kind: 'question' });
		waits(CHILD, undefined);
		elapse();
		assert.strictEqual(told.length, 0);
		waits(CHILD, { kind: 'question' });
		waits(CHILD, { kind: 'auth' });
		assert.deepStrictEqual(timers.map(timer => timer.stopped), [true, true, false]);
		elapse();
		assert.deepStrictEqual(told.map(each => /waiting for a sign-in/.test(each.text)), [true]);
	});

	test('an agent the person started, or whose creator ended or is not of this window, tells nobody', () => {
		const { runs, waits, elapse, told, changes } = setUp();
		waits(OWN, { kind: 'permission' });
		elapse();
		runs.set(LEAD, { ...runs.get(LEAD)!, lifecycle: 'ended' });
		waits(CHILD, { kind: 'question' });
		elapse();
		runs.set(CHILD, { ...runs.get(CHILD)!, creator: 'run-dddddddddddddddddddddddddddddddd', blocker: undefined });
		changes.fire({ run: CHILD, kind: 'reported' });
		waits(CHILD, { kind: 'question' });
		elapse();
		assert.strictEqual(told.length, 0);
	});

	test('a run that ended, or a window that went, stops its count', () => {
		const { runs, waits, elapse, told, notices, changes } = setUp();
		waits(CHILD, { kind: 'permission' });
		runs.set(CHILD, { ...runs.get(CHILD)!, lifecycle: 'ended' });
		changes.fire({ run: CHILD, kind: 'lifecycle' });
		elapse();
		runs.set(CHILD, { ...runs.get(CHILD)!, lifecycle: 'running' });
		waits(CHILD, { kind: 'permission' });
		notices.dispose();
		elapse();
		assert.strictEqual(told.length, 0);
	});

	test('a blocker is reported without directing the creator to contact the person or answer the prompt', () => {
		const run = { name: 'Echo', alias: '#a2' };
		assert.match(attentionText(run, { kind: 'permission' }), /Permission is the person's to give/);
		assert.match(attentionText(run, { kind: 'question', text: 'Which branch?' }), /waiting for an answer in its terminal \("Which branch\?"\)/);
		assert.match(attentionText(run, { kind: 'auth' }), /Only the person can sign in/);
		for (const kind of ['permission', 'question', 'auth'] as const) {
			const text = attentionText(run, { kind });
			assert.doesNotMatch(text, /send_message|#human|tell them|tell the person|press_keys|type_text/);
			assert.match(text, /does not request human contact or authorize answering the prompt; follow the person's task instructions/);
		}
	});
});
