/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parseStatus, ProgramStatus } from '../ptyd/status';
import { RunStatus } from '../ptyd/protocol';
import { sleep, useFakeClock } from './clock';

/** `text` as a report carries it: base64 of its UTF-8. */
function b64(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64');
}

suite('ptyd: what a program reports of itself (OSC 7501, CLIS-2.3)', () => {

	useFakeClock();

	test('a program\'s question whether its terminal takes reports, and its reports: its state, what it waits for where it is blocked, its words decoded, its id, its progress where it works or waits; what is no report is none', () => {
		assert.deepStrictEqual([
			'?',
			' ? ',
			'state=idle:app=claude-code',
			`state=working:msg=${b64('Showing current date and time')}`,
			`state=blocked:kind=permission:msg=${b64('Trust this folder?')}:progress=40`,
			'state=blocked:kind=nonsense',
			'state=done:kind=auth:progress=50',
			'state=clear',
			'state=error:app=x y',
			'id=build/test:state=working',
			// No state, or one it does not know: nothing, as an older terminal takes a newer state
			'app=claude-code',
			'state=sleeping',
			''
		].map(parseStatus), [
			'query',
			'query',
			{ state: 'idle', app: 'claude-code' },
			{ state: 'working', msg: 'Showing current date and time' },
			{ state: 'blocked', kind: 'permission', msg: 'Trust this folder?', progress: 40 },
			{ state: 'blocked' },
			{ state: 'done' },
			{ state: 'clear' },
			{ state: 'error' },
			{ id: 'build/test', state: 'working' },
			undefined,
			undefined,
			undefined
		]);
	});

	test('a report that passes a limit is no report - a key, an app or a message too long, an id that is none, words that do not decode or hold a control character - while a pair that is no pair is passed over, the rest applying, and of two the last counts', () => {
		assert.deepStrictEqual([
			`state=idle:${'k'.repeat(17)}=1`,
			`state=idle:app=${'a'.repeat(33)}`,
			`state=working:msg=${'A'.repeat(2733)}`,
			`state=working:msg=${b64('x'.repeat(2049))}`,
			'id=a//b:state=done',
			`id=${'a/'.repeat(8)}a:state=done`,
			'state=working:msg=A',
			`state=working:msg=${b64('one\ntwo')}`,
			`state=working:msg=${b64('ok')}:msg=${b64('a\u0007b')}`,
			'x'.repeat(4097),
			// Passed over: no `=`, a key that is no key, a value with a byte none may have - words among them
			'state=idle:junk:KEY=1:app=a b:msg=!!!!',
			'state=idle:state=working',
			`state=working:msg=${b64('first')}:msg=${b64('second')}`
		].map(parseStatus), [
			undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
			{ state: 'idle' },
			{ state: 'working' },
			{ state: 'working', msg: 'second' }
		]);
	});

	test('a program\'s status: none while it takes no part; pending once it asks, until its first report; each report of its own record taking the place of the last - one of another record, or the same again, changing nothing; clear, or a full reset, pending again; a new prompt ends working and blocked, not done', async () => {
		const status = new ProgramStatus();
		const seen: (RunStatus | undefined)[] = [];
		status.onDidChange(each => seen.push(each));
		const before = status.status;
		status.asked();
		const asked = status.status?.state;
		status.report({ state: 'idle', app: 'codex' });
		status.report({ state: 'idle', app: 'codex' });
		status.report({ id: 'worker', state: 'blocked' });
		await sleep(10);
		status.report({ state: 'working', msg: `${'Long words '.repeat(40)}\u202e` });
		status.promptStarted();
		status.report({ state: 'done' });
		status.promptStarted();
		status.clear();

		assert.deepStrictEqual({ before, asked, seen: seen.map(each => each && [each.state, each.msg && [...each.msg].length]), at: seen.map(each => each?.at) }, {
			before: undefined,
			asked: 'pending',
			// The program's words as they are shown: invisible formatting out, one line, and cut at 300 code points
			seen: [['pending', undefined], ['idle', undefined], ['working', 300], ['pending', undefined], ['done', undefined], ['pending', undefined]],
			at: [0, 0, 10, 10, 10, 10].map(ms => ms + seen[0]!.at)
		});
	});

	test('a clear, or a full reset, after a probe and no report since takes nothing away: the program\'s first report is still waited for (CLIS-2.3, D81)', () => {
		const status = new ProgramStatus();
		const seen: (RunStatus | undefined)[] = [];
		status.onDidChange(each => seen.push(each));
		status.asked();
		status.clear();
		status.report({ state: 'clear' });
		assert.deepStrictEqual(seen.map(each => each && [each.state, each.negotiating]), [['pending', true]]);
		assert.deepStrictEqual([status.status?.state, status.status?.negotiating], ['pending', true]);
	});

	test('the title a report gives is kept until another report gives another or the record is cleared; a title change alone keeps the episode\'s time', async () => {
		const status = new ProgramStatus();
		status.report({ state: 'working', title: 'Fixing tests' });
		const began = status.status!.at;
		await sleep(1_000);
		status.report({ state: 'working' });
		const kept = [status.status!.title, status.status!.at - began];
		status.report({ state: 'working', title: 'Fixing   more\ntests' });
		const changed = [status.status!.title, status.status!.at - began];
		status.report({ state: 'idle' });
		const idle = status.status!.title;
		status.clear();
		assert.deepStrictEqual({ kept, changed, idle, cleared: status.status!.title }, { kept: ['Fixing tests', 0], changed: ['Fixing more tests', 0], idle: 'Fixing more tests', cleared: undefined });
	});

	test('a report that moves only its progress on keeps the time its state began: a program held up on the same prompt is held up since it first said so; new words, or a new state, begin anew', async () => {
		const status = new ProgramStatus();
		status.report({ state: 'blocked', kind: 'permission', msg: 'Run npm install?', progress: 10 });
		const began = status.status!.at;
		await sleep(1_000);
		status.report({ state: 'blocked', kind: 'permission', msg: 'Run npm install?', progress: 20 });
		const progressed = status.status!.at - began;
		await sleep(1_000);
		status.report({ state: 'blocked', kind: 'permission', msg: 'Run the tests?', progress: 20 });
		const asked = status.status!.at - began;
		await sleep(1_000);
		status.report({ state: 'working', msg: 'Run the tests?', progress: 20 });

		assert.deepStrictEqual({ progressed, asked, working: status.status!.at - began }, { progressed: 0, asked: 2_000, working: 3_000 });
	});
});
