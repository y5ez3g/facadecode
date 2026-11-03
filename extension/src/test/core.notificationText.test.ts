/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { deliveryText, inputEffectText, operationText } from '../core/notificationText';
import type { InputEffects, MessageRecord } from '../core/messagePorts';

const AGENT = { run: 'run-11111111111111111111111111111111', alias: '#a7', name: 'Ada' };

suite('Notifications retain the facts needed to decide what to do (COLLABORATION-2.1)', () => {
	const delivery = (status: MessageRecord['delivery']['status'], effects: InputEffects, more: Partial<MessageRecord['delivery']> = {}) => deliveryText({
		id: 'm-42', alias: '#m42', kind: 'message', from: { run: 'sender' }, to: AGENT, window: 'win-1', environment: 'local',
		at: 0, text: 'Original', length: 8, delivery: { status, effects, attempts: 1, ...more }
	});

	test('the approved success receipt identifies the original message and recipient; read delivery remains distinguishable', () => {
		assert.strictEqual(delivery('success', { outcome: 'confirmed' }), 'Your message #m42 has been passed on to Ada (#a7).');
		assert.match(delivery('success', { outcome: 'confirmed' }, { via: 'read' }), /It was read through read_messages\.$/);
	});

	test('reading a message confirms delivery but does not erase partial or uncertain terminal input', () => {
		for (const outcome of ['partial', 'unknown'] as const) {
			const text = delivery('success', { outcome, text_written: 'partial', enter_written: null }, { via: 'read' });
			assert.ok(text.includes('has been passed on'));
			assert.ok(text.includes('Only part of the message was entered. Whether Enter was pressed is unknown.'));
			assert.ok(text.includes('Check the terminal for leftover input.'));
			assert.ok(!text.includes('sending it again'), 'the recipient already received the complete message');
		}
	});

	test('a read initial message retains terminal effects only for post-start input, not a native prompt argument', () => {
		for (const path of ['native', 'post_start'] as const) {
			const text = operationText({ data: { process_state: 'running', prompt: {
				message_id: 'm-42', path, status: 'success', delivered_via: 'read', effects: { outcome: 'unknown' }
			} } }, AGENT);
			assert.ok(text.includes('has been passed on through read_messages'));
			assert.strictEqual(text.includes('How much text was entered is unknown'), path === 'post_start');
			assert.ok(!text.includes('sending it again'));
		}
	});

	test('a draft blocks input without implying any text was entered', () => {
		const text = delivery('failure', { outcome: 'none' }, { reason: 'input_draft' });
		assert.ok(text.includes('draft in the terminal was left untouched'));
		assert.ok(!text.includes('passed on'));
	});

	test('a lost route explains uncertainty without claiming failed delivery or automatic replay', () => {
		assert.strictEqual(delivery('unknown', { outcome: 'unknown' }, { reason: 'window_unavailable' }), "Could not get a reply from the destination window; cannot confirm whether your message #m42 reached Ada (#a7).");
		assert.strictEqual(delivery('failure', { outcome: 'none' }, { reason: 'window_unavailable' }), "Your message #m42 could not be sent to Ada (#a7). The destination window could not be reached. Nothing was entered.");
		assert.strictEqual(delivery('failure', { outcome: 'none' }, { reason: 'not_found' }), "Your message #m42 could not be sent. Ada (#a7) is no longer available in the destination window.");
		assert.match(delivery('unknown', { outcome: 'partial', text_written: 'partial', enter_written: false }, { reason: 'window_unavailable' }), /Only part of the message was entered/);
	});

	for (const written of ['none', 'partial', 'full', 'unknown'] as const) {
		for (const enter of [true, false, null] as const) {
			test(`${written} text with Enter ${enter}: no uncertain delivery is described as passed on`, () => {
				const text = delivery('unknown', { outcome: 'unknown', text_written: written, enter_written: enter });
				assert.ok(!text.includes('passed on'));
				if (written === 'none' && enter === false) {
					assert.ok(text.includes('Nothing was entered'));
				} else {
					const amount = { none: 'No message text was entered', partial: 'Only part of the message was entered', full: 'The full message was entered', unknown: 'How much text was entered is unknown' };
					assert.ok(text.includes(amount[written]));
					assert.ok(text.includes(enter === null ? 'Whether Enter was pressed is unknown' : enter ? 'Enter was pressed' : 'Enter was not pressed'));
					assert.ok(text.includes('Check the terminal before sending it again'));
				}
			});
		}
	}

	test('startup, connecting tools, pending first message and a created worktree remain separate facts', () => {
		const text = operationText({ data: { process_state: 'running', tools_state: 'connecting', prompt: { message_id: '#m42', status: 'pending', obstacle: 'input_draft' } },
			effects: { outcome: 'confirmed', worktree_created: '/work/app.worktrees/fix' } }, AGENT);
		assert.ok(text.includes('has started'));
		assert.ok(text.includes('tools are still connecting'));
		assert.ok(text.includes('initial message #m42 is still being delivered'));
		assert.ok(text.includes('draft in the terminal; it will be left untouched'));
		assert.ok(text.includes('worktree was created at /work/app.worktrees/fix'));
		assert.ok(!/\bready\b|input_draft|run-/.test(text));
	});

	test('a native prompt supplied at launch is not invented terminal input or confirmed acceptance', () => {
		for (const outcome of ['unknown', 'confirmed']) {
			const text = operationText({ data: { process_state: 'running', prompt: { path: 'native', message_id: '#m42', status: 'failure', effects: { outcome } } } }, AGENT);
			assert.ok(text.includes('was supplied at launch'));
			assert.ok(text.includes(outcome === 'unknown' ? "acceptance could not be confirmed" : "delivery record could not be saved"));
			assert.ok(!text.includes('Enter'));
		}
	});

	test('uncertain post-start input never claims that delivery definitely failed or is safe to repeat', () => {
		const effects = { outcome: 'unknown', text_written: 'full', enter_written: null } as const;
		const text = operationText({ data: { process_state: 'running', prompt: { path: 'post_start', message_id: '#m42', status: 'failure', effects } } }, AGENT);
		assert.ok(text.includes("Delivery of your initial message #m42 could not be confirmed"));
		assert.ok(text.includes(inputEffectText(effects)));
	});

	for (const cleanup of ['terminated', 'already_exited', 'already_ended', 'not_started', 'unconfirmed', 'failed']) {
		test(`stop ${cleanup}: only observed process exit is stated as stopped`, () => {
			const text = operationText({ data: { cleanup } }, AGENT);
			assert.ok(text.includes('Ada (#a7)'));
			if (cleanup === 'terminated') { assert.ok(text.includes('has stopped')); }
			else if (cleanup.startsWith('already_')) { assert.ok(text.includes('had already stopped')); }
			else if (cleanup === 'not_started') { assert.ok(text.includes("before its process started. It will not be started")); }
			else { assert.ok(text.includes('may still be running')); assert.ok(!text.includes('has stopped')); }
		});
	}
});
