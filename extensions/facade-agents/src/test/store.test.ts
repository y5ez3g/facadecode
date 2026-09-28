/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ProgramEventBody, ProgramState } from '../common/model';
import { ProgramLog } from '../common/store';
import { feature, plan, tempDir } from './util';

function summary(state: ProgramState): object {
	return {
		seq: state.seq,
		status: state.status,
		features: Object.fromEntries([...state.features].map(([id, each]) => [id, `${each.status}/rung ${each.rung}/failures ${each.failuresOnRung}/attempts ${each.attempts}`])),
		questions: [...state.questions.values()].map(question => `${question.id}:${question.answer ?? '-'}`)
	};
}

/** A plausible stretch of a program's life. */
const history: ProgramEventBody[] = [
	{ type: 'plan.submitted', baseCommit: 'a'.repeat(40), integrationBranch: 'facade/p-test', newCommands: [] },
	{ type: 'plan.approved', approvedCommands: [] },
	{ type: 'integration.created', branch: 'facade/p-test', commit: 'a'.repeat(40) },
	{ type: 'program.started' },
	{ type: 'feature.started', feature: 'f1', attempt: 1, rung: 0, agent: { id: 'codex' }, worktree: '/w/f1', branch: 'b1', base: 'a'.repeat(40), tokenHash: 'h1', terminal: 't1' },
	{ type: 'feature.started', feature: 'f2', attempt: 1, rung: 0, agent: { id: 'codex' }, worktree: '/w/f2', branch: 'b2', base: 'a'.repeat(40), tokenHash: 'h2', terminal: 't2' },
	{ type: 'feature.question', feature: 'f1', attempt: 1, questionId: 'q-1', question: 'Which?' },
	{ type: 'feature.answered', questionId: 'q-1', answer: 'That one', by: 'lead' },
	{ type: 'feature.submitted', feature: 'f1', attempt: 1, result: { outcome: 'done', summary: 's', criteria: [{ id: 'c1', status: 'met' }] } },
	{ type: 'feature.checked', feature: 'f1', attempt: 1, commit: 'c'.repeat(40), checks: { passed: false, tree: 't'.repeat(40), runs: [{ argv: ['x'], cwd: '.', status: 'fail', ms: 1, tail: '' }] } },
	{ type: 'feature.escalated', feature: 'f1', fromRung: 0, toRung: 1, reason: 'failed' },
	{ type: 'feature.ended', feature: 'f1', attempt: 1, reason: 'stopped' },
	{ type: 'feature.ended', feature: 'f2', attempt: 1, reason: 'exited' }
];

suite('ProgramLog', () => {

	let temp: ReturnType<typeof tempDir>;
	setup(() => temp = tempDir('facade-store-'));
	teardown(() => temp.remove());

	function create(): ProgramLog {
		let clock = 1000;
		return ProgramLog.create(temp.dir, 'p-test', { type: 'program.created', plan: plan([feature('f1'), feature('f2')]), repoRoot: '/repo', repoName: 'repo', createdBy: 'lead' }, () => clock++);
	}

	test('loading replays the log into the same state the appends built', () => {
		const log = create();
		for (const event of history) {
			log.append(event);
		}
		log.close();
		const loaded = ProgramLog.load(path.join(temp.dir, 'p-test'), () => 0)!;
		assert.deepStrictEqual(summary(loaded.state), summary(log.state));
		assert.deepStrictEqual(summary(loaded.state), {
			seq: 14,
			status: 'running',
			features: { f1: 'pending/rung 1/failures 0/attempts 1', f2: 'pending/rung 0/failures 1/attempts 1' },
			questions: ['q-1:That one']
		});
	});

	test('property: a crash at any byte leaves the events written whole before it, and the log appendable', () => {
		const log = create();
		for (const event of history) {
			log.append(event);
		}
		log.close();
		const file = path.join(temp.dir, 'p-test', 'events.jsonl');
		const full = fs.readFileSync(file);
		const ends: number[] = [];
		for (let index = 0; index < full.length; index++) {
			if (full[index] === 0x0a) {
				ends.push(index + 1);
			}
		}
		for (let cut = 1; cut < full.length; cut += 7) {
			fs.writeFileSync(file, full.subarray(0, cut));
			const whole = ends.filter(end => end <= cut).length;
			const loaded = ProgramLog.load(path.join(temp.dir, 'p-test'), () => 0);
			if (whole === 0) {
				assert.strictEqual(loaded, undefined, `cut ${cut}`);
				continue;
			}
			assert.strictEqual(loaded!.state.seq, whole, `cut ${cut}`);
			assert.strictEqual(fs.statSync(file).size, ends[whole - 1], `cut ${cut}: truncated to the last whole event`);
			loaded!.append({ type: 'program.paused', reason: 'after a crash' });
			loaded!.close();
			assert.strictEqual(ProgramLog.load(path.join(temp.dir, 'p-test'), () => 0)!.state.seq, whole + 1, `cut ${cut}: appendable`);
		}
	});

	test('eventsAfter returns what came after a cursor, in order', () => {
		const log = create();
		for (const event of history.slice(0, 4)) {
			log.append(event);
		}
		assert.deepStrictEqual(log.eventsAfter(3).map(event => `${event.seq} ${event.type}`), ['4 integration.created', '5 program.started']);
		log.close();
	});
});
