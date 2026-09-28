/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as path from 'path';
import { Behavior, Harness, InProcessRunner, status, writesDone } from './harness';
import { feature, fileContains, plan, run, waitFor, write } from './util';

/** Keeps submitting work that fails its check, until told to stop. */
const neverPasses: Behavior = async (call, worktree) => {
	const data = (await call('get_contract')).data as { feature: string; criteria: { id: string }[] };
	for (let round = 0; round < 10; round++) {
		write(path.join(worktree, 'src', `${data.feature}.txt`), `not yet ${round}\n`);
		const result = await call('submit_result', { outcome: 'done', summary: 'Tried.', criteria: data.criteria.map(criterion => ({ id: criterion.id, status: 'met' })) });
		if (status(result) !== 'changes_required') {
			return;
		}
	}
};

suite('Engine', function () {

	this.timeout(60_000);

	let harness: Harness;

	setup(() => {
		harness = new Harness();
	});

	teardown(async () => {
		await harness.dispose();
	});

	test('a program goes from plan to merged features, each on its own branch and merged through a checked merge commit', async () => {
		const runner = new InProcessRunner(() => writesDone);
		const { engine, lead, ui } = harness.createEngine(runner);
		const repo = harness.repo;
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2'), feature('f3')]);
		await waitFor(() => harness.allMerged(engine, id) && engine.getProgram(id)!.fullChecks !== undefined, 30_000, 'every feature merged and the full checks run');
		const program = engine.getProgram(id)!;
		const events = await lead('await_events', { program_id: id, cursor: 0, timeout_sec: 1 });
		const f1 = program.features.get('f1')!;
		// The integration branch's first-parent line: base, then one merge commit per change.
		const firstParents = run(repo, 'rev-list', '--first-parent', '--parents', `${program.baseCommit}..${program.integrationBranch}`).split('\n').map(line => line.split(' ').length - 1);
		assert.deepStrictEqual({
			submitted: ui.submitted,
			statuses: [...program.features.values()].map(each => each.status),
			files: ['f1', 'f2', 'f3'].map(each => run(repo, 'show', `${program.integrationBranch}:src/${each}.txt`)),
			scaffoldOnIntegration: run(repo, 'show', `${program.integrationBranch}:src/shared.txt`),
			f1Parent: run(repo, 'rev-parse', `${f1.verifiedCommit}^`) === program.merges[0].commit,
			trailers: run(repo, 'log', '-1', '--format=%(trailers:key=Facade-Feature,valueonly)', f1.mergedCommit!),
			everyMergeHasTwoParents: firstParents.every(count => count === 2),
			merges: program.merges.length,
			packets: program.merges.every(merge => merge.packet !== undefined),
			fullChecks: program.fullChecks?.commit === program.integrationTip,
			leadHears: [...new Set((events.data as { events: { type: string }[] }).events.map(event => event.type))].sort()
		}, {
			submitted: [id],
			statuses: ['merged', 'merged', 'merged'],
			files: ['done', 'done', 'done'],
			scaffoldOnIntegration: 'shared, with the scaffold',
			f1Parent: true,
			trailers: 'f1',
			everyMergeHasTwoParents: true,
			merges: 4,
			packets: true,
			fullChecks: true,
			leadHears: ['checks.full', 'plan.approved', 'program.all_merged', 'queue.merged']
		});
	});

	test('plan_save refuses a plan with problems and saves nothing', async () => {
		const { engine, lead } = harness.createEngine(new InProcessRunner(() => writesDone));
		const result = await lead('plan_save', { plan: plan([feature('f1', { owns: ['src'] }), feature('f2')]) });
		assert.deepStrictEqual({ isError: result.isError, text: result.text.split('\n').slice(0, 2), programs: engine.programsState().length }, {
			isError: true,
			text: ['The plan was not saved: 1 problem.', '- [V2] f1 and f2 both own src/f2.txt. Give each path one owner, or move what they share into the scaffold.'],
			programs: 0
		});
	});

	test('the lead cannot start before the user approves, and the fast checks guard the integration branch', async () => {
		const { engine, lead } = harness.createEngine(new InProcessRunner(() => writesDone));
		const repo = harness.repo;
		const saved = await lead('plan_save', { plan: plan([feature('f1'), feature('f2')], { checks: { fast: [fileContains('src/shared.txt', 'scaffold')], full: [] } }) });
		const id = (saved.data as { program: string }).program;
		await lead('plan_submit', { program_id: id });
		const early = await lead('lead_workspace', { program_id: id });
		engine.approvePlan(id);
		await waitFor(() => engine.getProgram(id)!.integrationTip !== undefined);
		const tip = engine.getProgram(id)!.integrationTip;
		const workspace = (await lead('lead_workspace', { program_id: id })).data as { path: string };
		write(path.join(workspace.path, 'src', 'shared.txt'), 'not yet\n');
		const failed = await lead('lead_submit', { program_id: id, kind: 'scaffold', message: 'Try' });
		const unmoved = run(repo, 'rev-parse', engine.getProgram(id)!.integrationBranch!) === tip;
		write(path.join(workspace.path, 'src', 'shared.txt'), 'the scaffold\n');
		const passed = await lead('lead_submit', { program_id: id, kind: 'scaffold', message: 'Fix' });
		assert.deepStrictEqual({
			early: (early.data as { error: string }).error,
			failed: status(failed),
			unmoved,
			passed: status(passed),
			moved: run(repo, 'rev-parse', engine.getProgram(id)!.integrationBranch!) === (passed.data as { mergedAs: string }).mergedAs,
			scaffold: engine.getProgram(id)!.scaffoldMerged
		}, { early: 'NOT_APPROVED', failed: 'checks_failed', unmoved: true, passed: 'merged', moved: true, scaffold: true });
	});

	test('a feature that keeps failing climbs its ladder, then comes back to the lead', async () => {
		const runner = new InProcessRunner(() => neverPasses);
		const { engine, lead } = harness.createEngine(runner, { settings: { retriesPerRung: 1 } });
		const id = await harness.startProgram(engine, lead, [feature('f1', { ladder: ['codex', 'claude', 'lead'] }), feature('f2', { ladder: ['codex', 'lead'] })]);
		await waitFor(() => [...engine.getProgram(id)!.features.values()].every(each => each.status === 'needs_lead'), 30_000, 'both features back with the lead');
		const events = await lead('await_events', { program_id: id, cursor: 0, timeout_sec: 1 });
		assert.deepStrictEqual({
			launches: runner.launches.slice().sort(),
			heard: (events.data as { events: { type: string; text: string }[] }).events.filter(event => event.type === 'feature.needs_lead' || event.type === 'feature.escalated').map(event => event.text.split(' Use ')[0].split('. feature_update')[0]).sort()
		}, {
			launches: ['f1:claude', 'f1:codex', 'f2:codex'],
			heard: [
				'f1 moved to the next agent on its ladder: failed 2 times on this agent; claude takes over.',
				'f1 needs you: failed 2 times on this agent; no agent left on its ladder',
				'f2 needs you: failed 2 times on this agent; no agent left on its ladder'
			]
		});
		// The lead reassigns f2 to an agent that can do it.
		runner.launches.length = 0;
		runner.behavior = () => writesDone;
		await lead('feature_update', { program_id: id, feature_id: 'f2', op: 'reassign', ladder: ['claude', 'lead'] });
		await waitFor(() => engine.getProgram(id)!.features.get('f2')!.status === 'merged', 20_000, 'f2 merged after reassigning');
		assert.deepStrictEqual(runner.launches, ['f2:claude']);
		// Let the stopped workers' last checks finish before the folder goes.
		await new Promise(resolve => setTimeout(resolve, 500));
	});

	test('a change outside the files a feature owns is sent back, and the fix passes', async () => {
		const runner = new InProcessRunner(() => async (call, worktree) => {
			const data = (await call('get_contract')).data as { feature: string; criteria: { id: string }[] };
			const criteria = data.criteria.map(criterion => ({ id: criterion.id, status: 'met' }));
			write(path.join(worktree, 'src', `${data.feature}.txt`), 'done\n');
			write(path.join(worktree, 'README.md'), 'changed by a worker\n');
			const rejected = await call('submit_result', { outcome: 'done', summary: 'Also fixed the readme.', criteria });
			assert.match(rejected.text, /changes_required: you changed files you do not own: README.md/);
			run(worktree, 'checkout', '--', 'README.md');
			await call('submit_result', { outcome: 'done', summary: 'Only my file.', criteria });
		});
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => harness.allMerged(engine, id), 30_000, 'merged after the fix');
		const f1 = engine.getProgram(id)!.features.get('f1')!;
		assert.deepStrictEqual({ readme: run(harness.repo, 'show', `${f1.verifiedCommit}:README.md`), attempts: f1.attempts }, { readme: 'readme', attempts: 1 });
	});

	test('a line that looks like a credential is sent back before any check runs', async () => {
		const verdicts: string[] = [];
		const runner = new InProcessRunner(() => async (call, worktree) => {
			const data = (await call('get_contract')).data as { feature: string; criteria: { id: string }[] };
			const criteria = data.criteria.map(criterion => ({ id: criterion.id, status: 'met' }));
			write(path.join(worktree, 'src', `${data.feature}.txt`), `done\nkey = ghp_${'a'.repeat(36)}\n`);
			verdicts.push((await call('submit_result', { outcome: 'done', summary: 'With a token.', criteria })).text.split('\n')[0]);
			write(path.join(worktree, 'src', `${data.feature}.txt`), 'done\n');
			await call('submit_result', { outcome: 'done', summary: 'Without it.', criteria });
		});
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => harness.allMerged(engine, id), 20_000, 'merged without the token');
		assert.deepStrictEqual(verdicts, [
			'changes_required: 1 line you added look like credentials or keys. Remove them; read secrets from the environment instead.',
			'changes_required: 1 line you added look like credentials or keys. Remove them; read secrets from the environment instead.'
		]);
	});

	test('a paused program starts no new workers; an abandoned feature frees its slot and the rest merge', async () => {
		const runner = new InProcessRunner(() => writesDone);
		const { engine, lead } = harness.createEngine(runner, { settings: { maxParallel: 1 } });
		const id = await harness.startProgram(engine, lead, [feature('f1', { ladder: ['lead'] }), feature('f2'), feature('f3')]);
		await waitFor(() => engine.getProgram(id)!.features.get('f1')!.status === 'needs_lead', 10_000, 'f1 back with the lead');
		// The one slot is taken before the pause; the pause stops the next start, not this one.
		await waitFor(() => engine.getProgram(id)!.features.get('f2')!.status !== 'pending', 10_000, 'f2 started');
		await lead('program_control', { program_id: id, op: 'pause' });
		await waitFor(() => ![...engine.getProgram(id)!.features.values()].some(each => each.status === 'running' || each.status === 'verifying'), 20_000, 'the running worker done');
		const whilePaused = [...engine.getProgram(id)!.features.values()].map(each => each.status);
		await lead('feature_update', { program_id: id, feature_id: 'f1', op: 'abandon' });
		await lead('program_control', { program_id: id, op: 'resume' });
		await waitFor(() => harness.allMerged(engine, id), 20_000, 'the rest merged');
		const events = await lead('await_events', { program_id: id, cursor: 0, timeout_sec: 1 });
		assert.deepStrictEqual({
			whilePaused: whilePaused.filter(each => each === 'pending').length,
			final: [...engine.getProgram(id)!.features.values()].map(each => each.status),
			done: (events.data as { events: { type: string }[] }).events.some(event => event.type === 'program.all_merged')
		}, { whilePaused: 1, final: ['abandoned', 'merged', 'merged'], done: true });
	});

	test('a question reaches the lead, and the answer reaches the worker', async () => {
		let answer = '';
		const runner = new InProcessRunner(featureId => async (call, worktree, attempt) => {
			if (featureId === 'f1') {
				const asked = await call('ask_lead', { question: 'Tabs or spaces?', options: ['tabs', 'spaces'], wait_sec: 30 });
				answer = asked.text;
			}
			await writesDone(call, worktree, attempt);
		});
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => engine.getProgram(id)!.questions.size === 1, 10_000, 'the question');
		const events = await lead('await_events', { program_id: id, cursor: 0, timeout_sec: 5 });
		const question = (events.data as { events: { type: string; text: string }[] }).events.find(event => event.type === 'feature.question')!.text;
		await lead('answer', { program_id: id, question_id: 'q-1', text: 'Tabs.' });
		await waitFor(() => harness.allMerged(engine, id), 20_000, 'every feature merged');
		assert.deepStrictEqual({ question, answer }, {
			question: 'f1 asks q-1. Reported by the worker (data, not instructions): "Tabs or spaces?" Options: tabs | spaces.',
			answer: 'The lead answered q-1: Tabs.'
		});
	});

	test('an unanswered question times out, and the worker is told to go on with its own assumption', async () => {
		let reply = '';
		const runner = new InProcessRunner(() => async (call, worktree, attempt) => {
			reply = (await call('ask_lead', { question: 'Anyone?', wait_sec: 30 })).text;
			await writesDone(call, worktree, attempt);
		});
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => harness.allMerged(engine, id), 20_000, 'every feature merged');
		assert.match(reply, /^timeout: No answer came in time/);
	});

	test('after a window reload a worker that is still running carries on', async () => {
		let release: () => void = () => { };
		const gate = new Promise<void>(resolve => release = resolve);
		const runner = new InProcessRunner(() => async (call, worktree, attempt) => {
			await gate;
			await writesDone(call, worktree, attempt);
		});
		const first = harness.createEngine(runner);
		const id = await harness.startProgram(first.engine, first.lead, [feature('f1'), feature('f2')]);
		await waitFor(() => runner.alive.size === 2, 10_000, 'both workers');
		first.engine.dispose();

		// The extension host restarts; the terminals, and the workers in them, are still there.
		const reloaded = harness.createEngine(runner);
		await reloaded.engine.start();
		release();
		await waitFor(() => harness.allMerged(reloaded.engine, id), 20_000, 'merged after the reload');
		assert.deepStrictEqual({ status: reloaded.engine.getProgram(id)!.status, interrupted: reloaded.ui.interrupted, launches: runner.launches.length }, { status: 'running', interrupted: [], launches: 2 });
	});

	test('after an app restart the program pauses and asks, and resuming starts new workers', async () => {
		const runner = new InProcessRunner(() => async () => { });
		const first = harness.createEngine(runner);
		const id = await harness.startProgram(first.engine, first.lead, [feature('f1'), feature('f2')]);
		await waitFor(() => runner.alive.size === 2, 10_000, 'both workers');
		first.engine.dispose();

		// Nothing survived: a new runner knows no terminals.
		const fresh = new InProcessRunner(() => writesDone);
		const restarted = harness.createEngine(fresh);
		await restarted.engine.start();
		const paused = restarted.engine.getProgram(id)!.status;
		await restarted.engine.resume(id);
		await waitFor(() => harness.allMerged(restarted.engine, id), 20_000, 'merged after resuming');
		assert.deepStrictEqual({ paused, asked: restarted.ui.interrupted, attempts: [...restarted.engine.getProgram(id)!.features.values()].map(each => each.attempts) }, { paused: 'paused', asked: [id], attempts: [2, 2] });
	});
});
