/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { codexAdapter } from '../clis/codex';
import { activityOf } from '../clis/activity';
import { ProgramStatus } from '../ptyd/status';
import { sleep, useFakeClock } from './clock';

// Codex 0.166.0's and 0.167.0's own titles and reports, as scripts/probe-codex-status.cjs recorded them alike: a turn that leaves
// a command running, then a follow-up that streams its answer. Its report stays `working` from the first turn on.
const RECORDED = [
	{ label: 'initial', title: 'work', report: 'idle', activity: 'not_working' },
	{ label: 'working', title: '⠹ work', report: 'working', activity: 'working' },
	{ label: 'background-completed', title: 'work', report: 'working', activity: 'not_working' },
	{ label: 'follow-up-working', title: '⠧ work', report: 'working', activity: 'working' },
	{ label: 'follow-up-streaming', title: '⠏ work', report: 'working', activity: 'working' },
	{ label: 'follow-up-completed', title: 'work', report: 'working', activity: 'not_working' }
] as const;

/** A run whose title has shown its spinner and whose report says working, its turn still going on. */
function spun(): ProgramStatus {
	const status = new ProgramStatus(true);
	status.titled('⠋ work');
	status.report({ state: 'working' });
	return status;
}

suite('Codex turns read from its title spinner while a command its turn started runs on (CLIS-2.3)', () => {
	useFakeClock();

	test('its adapter names the spinner from 0.166.0 on, an unknown version none', () => {
		assert.deepStrictEqual(['0.165.0', '0.166.0', '0.166.1', '0.167.0', '0.166.0-dev', '1.0.0', undefined].map(version => codexAdapter.titleSpinner?.(version)),
			[false, true, true, true, false, true, false]);
	});

	test('the recorded turns: working while its spinner shows, idle once its turn is over and the command runs on, in either order', () => {
		for (const titleFirst of [true, false]) {
			const status = new ProgramStatus(true);
			for (const step of RECORDED) {
				if (titleFirst) { status.titled(step.title); }
				status.report({ state: step.report });
				if (!titleFirst) { status.titled(step.title); }
				assert.strictEqual(activityOf(status.status).activity, step.activity, `${step.label}, title ${titleFirst ? 'first' : 'last'}`);
			}
		}
	});

	test('a title that never shows a spinner - its animations off or its items without one - leaves its report as it is', () => {
		for (const title of ['work', 'codex | work', '[ ! ] Action Required | work', '']) {
			const status = new ProgramStatus(true);
			status.titled(title);
			status.report({ state: 'working' });
			status.titled(title === 'work' ? 'codex | work' : 'work');
			assert.strictEqual(status.status!.state, 'working', JSON.stringify(title));
		}
	});

	test('the spinner is read wherever its title items put it, as a word of its own', () => {
		for (const [title, turn] of [['⠋ work', true], ['work ⠙', true], ['Fix the bug ⠹ work', true], ['● ⠸ work', true],
			['work', false], ['⠋work', false], ['w⠋ork', false], ['⠿ work', false], ['', false], ['[ ! ] Action Required | work', false]] as const) {
			const status = spun();
			status.titled(title);
			assert.strictEqual(status.status!.state, turn ? 'working' : 'idle', JSON.stringify(title));
		}
	});

	test('the idle a turn ends in keeps its time through its record\'s changes; a new turn is a new working episode', async () => {
		const status = new ProgramStatus(true);
		status.titled('⠋ work');
		status.report({ state: 'working', title: 'Native title' });
		const began = status.status!.at;
		await sleep(20);
		status.titled('work');
		assert.strictEqual(activityOf(status.status).activity, 'not_working');
		const finished = status.status!.at;
		assert.ok(finished > began);
		await sleep(20);
		status.report({ state: 'working', title: 'New title' });
		assert.deepStrictEqual(status.status, { state: 'idle', title: 'New title', at: finished });
		status.report({ id: 'worker', state: 'working' });
		assert.strictEqual(status.status!.at, finished);
		status.titled('⠙ work');
		assert.strictEqual(activityOf(status.status).activity, 'working');
		assert.ok(status.status!.at > finished);
	});

	test('a new turn reported before its spinner shows stays in the idle before it until the spinner shows', async () => {
		const status = spun();
		status.titled('work');
		status.report({ state: 'idle' });
		const idle = status.status!.at;
		await sleep(20);
		status.report({ state: 'working' });
		assert.deepStrictEqual(status.status, { state: 'idle', at: idle });
		status.titled('⠙ work');
		assert.strictEqual(status.status!.state, 'working');
	});

	test('its own idle, done, blocker, error, clear and negotiation always win; another CLI keeps its report', () => {
		for (const report of [{ state: 'idle' }, { state: 'done' }, { state: 'blocked' }, { state: 'blocked', kind: 'permission' }, { state: 'error' }, { state: 'clear' }] as const) {
			const status = spun();
			status.titled('work');
			status.report(report);
			assert.strictEqual(status.status!.state, report.state === 'clear' ? 'pending' : report.state);
			assert.strictEqual(status.status!.kind, 'kind' in report ? report.kind : undefined);
		}
		const status = new ProgramStatus(true);
		status.titled('⠋ work');
		status.titled('work');
		assert.strictEqual(status.status, undefined, 'no report to read');
		status.asked();
		assert.strictEqual(status.status!.state, 'pending');
		status.report({ state: 'working' });
		status.clear();
		assert.strictEqual(status.status!.state, 'pending');
		const other = new ProgramStatus();
		other.titled('⠋ work');
		other.report({ state: 'working' });
		other.titled('work');
		assert.strictEqual(other.status!.state, 'working');
	});
});
