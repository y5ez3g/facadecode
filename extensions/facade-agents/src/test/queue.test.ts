/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Cmd, FeatureState, ProgramState } from '../common/model';
import { conflictResolver, outsideOwnership } from '../common/queue';
import { createState } from '../common/state';
import { Harness, InProcessRunner, status, writes, writesDone } from './harness';
import { alwaysPasses, feature, plan, run, waitFor, write } from './util';

/** A fast check that fails when two or more feature files say "clash": two changes that each pass alone. */
const noClash: Cmd = { argv: [process.execPath, '-e', 'const fs=require("fs");const n=fs.existsSync("src")?fs.readdirSync("src").filter(f=>/^f\\d+\\.txt$/.test(f)&&fs.readFileSync("src/"+f,"utf8").includes("clash")).length:0;process.exit(n>1?1:0)'] };

/** A small seeded random number generator, so a failing interleaving can be run again. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

/** The commits a ref pointed at, oldest first, from its reflog. */
function reflog(repo: string, ref: string): string[] {
	return run(repo, 'log', '-g', '--format=%H', ref).split('\n').filter(Boolean).reverse();
}

suite('Merge queue', function () {

	this.timeout(90_000);

	let harness: Harness;

	setup(() => {
		harness = new Harness();
		run(harness.repo, 'config', 'core.logAllRefUpdates', 'always');
	});

	teardown(async () => {
		await harness.dispose();
	});

	for (const seed of [7, 42]) {
		test(`under a random interleaving the integration branch only moves forward, to checked merge commits (I1, I2, I4), seed ${seed}`, async () => {
			const next = random(seed);
			const ids = ['f1', 'f2', 'f3', 'f4', 'f5'];
			// Decided up front, per feature: fail its own check first, clash with other features, pause.
			const plans = new Map(ids.map(id => [id, { failFirst: next() < 0.4, clash: next() < 0.5, delay: Math.floor(next() * 200) }]));
			const runner = new InProcessRunner(featureId => async (call, worktree, attempt) => {
				const choice = plans.get(featureId)!;
				await new Promise(resolve => setTimeout(resolve, choice.delay));
				const contract = (await call('get_contract')).data as { kind: string; criteria: { id: string }[] };
				const criteria = contract.criteria.map(criterion => ({ id: criterion.id, status: 'met' }));
				const file = path.join(worktree, 'src', `${featureId}.txt`);
				if (choice.failFirst && attempt === 1) {
					write(file, 'not yet\n');
					if (status(await call('submit_result', { outcome: 'done', summary: 'Too early.', criteria })) !== 'changes_required') {
						return;
					}
				}
				// A regression attempt gives up the clash.
				write(file, choice.clash && contract.kind !== 'regression' ? 'done clash\n' : 'done\n');
				await call('submit_result', { outcome: 'done', summary: 'Done.', criteria });
			});
			const { engine, lead } = harness.createEngine(runner, { settings: { retriesPerRung: 2, maxParallel: 3 } });
			const id = await harness.startProgram(engine, lead, ids.map(each => feature(each)), { checks: { fast: [noClash], full: [alwaysPasses] } });
			await waitFor(() => harness.allMerged(engine, id) || [...engine.getProgram(id)!.features.values()].some(each => each.status === 'needs_lead'), 60_000, 'every feature merged');
			const program = engine.getProgram(id)!;
			const repo = harness.repo;
			const branch = `refs/heads/${program.integrationBranch}`;

			// I1: every move of the branch went from the tip before it to a descendant.
			const moves = reflog(repo, branch);
			const forward = moves.slice(1).every((commit, index) => run(repo, 'merge-base', '--is-ancestor', moves[index], commit) === '');
			// I2: the first-parent line from the base is the queue's merge commits, and each tree passes the fast check.
			const line = run(repo, 'rev-list', '--first-parent', '--reverse', `${program.baseCommit}..${branch}`).split('\n');
			const clashes = (commit: string) => {
				const present = run(repo, 'ls-tree', '--name-only', `${commit}:src`).split('\n');
				return ids.filter(each => present.includes(`${each}.txt`) && run(repo, 'show', `${commit}:src/${each}.txt`).includes('clash')).length;
			};
			// I4: no branch Facade made ever moved to a commit that did not descend from where it was.
			const facadeRefs = run(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/facade').split('\n').filter(Boolean);
			const rewritten = facadeRefs.filter(ref => {
				const history = reflog(repo, ref);
				return !history.slice(1).every((commit, index) => run(repo, 'merge-base', '--is-ancestor', history[index], commit) === '');
			});
			const clashing = ids.filter(each => plans.get(each)!.clash);
			assert.deepStrictEqual({
				statuses: [...program.features.values()].map(each => each.status),
				forward,
				line: line.join(',') === program.merges.map(merge => merge.commit).join(','),
				mergeParents: program.merges.every((merge, index) => run(repo, 'rev-parse', `${merge.commit}^1`) === (index === 0 ? program.baseCommit : program.merges[index - 1].commit) && run(repo, 'rev-parse', `${merge.commit}^2`) === merge.item.commit),
				greenLine: line.every(commit => clashes(commit) <= 1),
				rewritten,
				regressions: clashing.length > 1 ? clashing.slice(1).every(each => program.features.get(each)!.regressions >= 1) || clashing.some(each => program.features.get(each)!.regressions >= 1) : true
			}, {
				statuses: ids.map(() => 'merged'),
				forward: true,
				line: true,
				mergeParents: true,
				greenLine: true,
				rewritten: [],
				regressions: true
			}, JSON.stringify([...plans]));
		});
	}

	test('a feature whose merge breaks the fast checks goes back to its worker with the integration branch merged in; a second time goes to the lead', async () => {
		// Fails, until the marker exists, when f2 says v1 next to f1, or when f2 sits next to f3. So
		// f2's first merge breaks the check, and so does its second, because f3 landed after f2's
		// regression attempt had merged the integration branch in.
		const marker = path.join(harness.temp.dir, 'fixed');
		const script = `const fs=require("fs");const has=f=>fs.existsSync(f);const text=f=>has(f)?fs.readFileSync(f,"utf8"):"";process.exit(!has(${JSON.stringify(marker)})&&((text("src/f2.txt").includes("v1")&&has("src/f1.txt"))||(has("src/f2.txt")&&has("src/f3.txt")))?1:0)`;
		const breaksOnMerge: Cmd = { argv: [process.execPath, '-e', script] };
		const f2Kinds: string[] = [];
		let id = '';
		const f2Running = (attempt: number) => engine.getProgram(id)!.features.get('f2')!.attempts === attempt;
		const runner = new InProcessRunner(featureId => async (call, worktree, attempt) => {
			const contract = (await call('get_contract')).data as { kind: string; commands: unknown[] };
			if (featureId === 'f2') {
				f2Kinds.push(`${contract.kind}:${contract.commands.length}`);
				if (attempt === 2) {
					// Hand in only after f3 landed.
					await waitFor(() => engine.getProgram(id)!.features.get('f3')!.status === 'merged', 20_000, 'f3 merged');
				}
			}
			if (featureId === 'f3') {
				// Land only once f2's regression attempt has merged the integration branch in.
				await waitFor(() => f2Running(2), 20_000, 'f2 on its regression attempt');
			}
			await writes(`done v${attempt}\n`)(call, worktree, attempt);
		});
		// The workers above read the engine once they run, after it exists.
		const { engine, lead } = harness.createEngine(runner, { settings: { maxParallel: 2 } });
		id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2', { dependsOn: ['f1'] }), feature('f3', { dependsOn: ['f1'] })], { checks: { fast: [breaksOnMerge], full: [] } });
		await waitFor(() => engine.getProgram(id)!.features.get('f2')!.status === 'needs_lead', 40_000, 'f2 back with the lead');
		const program = engine.getProgram(id)!;
		const reason = program.features.get('f2')!.needsLeadReason;
		const tipHeld = program.integrationTip === program.merges.find(merge => merge.item.feature === 'f3')!.commit;
		// The lead retries it once the cause is fixed.
		fs.writeFileSync(marker, 'fixed');
		await lead('feature_update', { program_id: id, feature_id: 'f2', op: 'retry' });
		await waitFor(() => harness.allMerged(engine, id), 30_000, 'f2 merged after the retry');
		const f2 = engine.getProgram(id)!.features.get('f2')!;
		assert.deepStrictEqual({
			// A regression attempt must pass the acceptance command and the fast checks.
			f2Kinds,
			reason,
			tipHeld,
			// The last attempt started from the integration branch: f1's and f3's changes are in f2's branch.
			synced: ['f1', 'f3'].map(each => run(harness.repo, 'show', `${f2.verifiedCommit}:src/${each}.txt`)),
			f2: run(harness.repo, 'show', `${engine.getProgram(id)!.integrationBranch}:src/f2.txt`)
		}, {
			f2Kinds: ['implement:1', 'regression:2', 'regression:2'],
			reason: 'its merge broke the fast checks twice',
			tipHeld: true,
			synced: ['done v1', 'done v1'],
			f2: 'done v3'
		});
	});

	test('a fast check that fails once and passes when run again is flaky, not a regression', async () => {
		const marker = path.join(harness.temp.dir, 'flaked');
		const flaky: Cmd = { argv: [process.execPath, '-e', `const fs=require("fs");if(fs.existsSync("src/f1.txt")&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},"1");process.exit(1)}`] };
		const { engine, lead } = harness.createEngine(new InProcessRunner(() => writesDone));
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')], { checks: { fast: [flaky], full: [] } });
		await waitFor(() => harness.allMerged(engine, id), 30_000, 'both merged');
		const program = engine.getProgram(id)!;
		const f1 = program.merges.find(merge => merge.item.feature === 'f1')!;
		assert.deepStrictEqual({ flaky: f1.flaky?.length, regressions: program.features.get('f1')!.regressions }, { flaky: 1, regressions: 0 });
	});

	test('when the lead changed a feature\'s file meanwhile, the merge conflicts and the feature\'s worker resolves it', async () => {
		let release: () => void = () => { };
		const gate = new Promise<void>(resolve => release = resolve);
		const seen: string[] = [];
		const runner = new InProcessRunner(featureId => async (call, worktree, attempt) => {
			const contract = (await call('get_contract')).data as { kind: string; conflicts: string[]; criteria: { id: string }[] };
			const criteria = contract.criteria.map(criterion => ({ id: criterion.id, status: 'met' }));
			const file = path.join(worktree, 'src', `${featureId}.txt`);
			if (featureId === 'f1' && attempt === 1) {
				await gate;
			}
			if (contract.kind === 'resolve') {
				seen.push(`${contract.conflicts.join(',')} ${fs.readFileSync(file, 'utf8').includes('<<<<<<<') ? 'with markers' : 'clean'}`);
				// Resolving keeps both sides.
				write(file, 'done\nthe lead\'s line\n');
			} else {
				write(file, 'done\n');
			}
			await call('submit_result', { outcome: 'done', summary: 'Done.', criteria });
		});
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => runner.alive.size === 2, 10_000, 'both workers');
		// While f1's worker works, the lead writes f1's file too.
		const workspace = (await lead('lead_workspace', { program_id: id })).data as { path: string };
		write(path.join(workspace.path, 'src', 'f1.txt'), 'the lead\'s line\n');
		const submitted = await lead('lead_submit', { program_id: id, kind: 'resolve', message: 'Seed f1 with the lead\'s line' });
		release();
		await waitFor(() => harness.allMerged(engine, id), 30_000, 'both merged');
		const program = engine.getProgram(id)!;
		assert.deepStrictEqual({
			lead: status(submitted),
			note: /f1 is being worked on and your change touches its files/.test(submitted.text),
			seen,
			f1: run(harness.repo, 'show', `${program.integrationBranch}:src/f1.txt`),
			attempts: program.features.get('f1')!.attempts
		}, {
			lead: 'merged',
			note: true,
			seen: ['src/f1.txt with markers'],
			f1: 'done\nthe lead\'s line',
			attempts: 2
		});
	});

	test('a conflict in files the feature does not own goes to the lead', () => {
		const program: ProgramState = createState('p-1', { type: 'program.created', plan: plan([feature('f1'), feature('f2', { owns: ['src/f2.txt', 'src/shared/**'] })]), repoRoot: '/r', repoName: 'r', createdBy: 'lead', seq: 1, ts: 0 });
		const f1: FeatureState = program.features.get('f1')!;
		assert.deepStrictEqual({
			own: conflictResolver(program, f1, ['src/f1.txt']),
			scaffold: conflictResolver(program, f1, ['src/f1.txt', 'src/shared.txt']),
			other: outsideOwnership(program, f1, ['src/shared/x.ts', 'src/f1.txt'])
		}, { own: 'worker', scaffold: 'lead', other: ['src/shared/x.ts'] });
	});

	test('a dependent feature starts only once the feature it depends on is merged', async () => {
		const order: string[] = [];
		const runner = new InProcessRunner(featureId => async (call, worktree, attempt) => {
			order.push(`start ${featureId}`);
			await writesDone(call, worktree, attempt);
		});
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2', { dependsOn: ['f1'] })]);
		await waitFor(() => harness.allMerged(engine, id), 30_000, 'both merged');
		const program = engine.getProgram(id)!;
		assert.deepStrictEqual({
			order,
			f2From: run(harness.repo, 'merge-base', '--is-ancestor', program.features.get('f1')!.mergedCommit!, program.features.get('f2')!.verifiedCommit!)
		}, { order: ['start f1', 'start f2'], f2From: '' });
	});

	test('a branch moved outside Facade halts the queue and pauses the program until the person resumes it', async () => {
		let release: () => void = () => { };
		const gate = new Promise<void>(resolve => release = resolve);
		const runner = new InProcessRunner(() => async (call, worktree, attempt) => {
			await gate;
			await writesDone(call, worktree, attempt);
		});
		const { engine, lead, ui } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		const program = engine.getProgram(id)!;
		const tip = program.integrationTip!;
		// Someone moves the integration branch back to where it started.
		run(harness.repo, 'update-ref', `refs/heads/${program.integrationBranch}`, program.baseCommit!);
		release();
		await waitFor(() => program.queueHalted !== undefined, 20_000, 'the queue halted');
		const halted = { status: program.status, merges: program.merges.length, told: ui.halted.length };
		// The person puts it back and resumes.
		run(harness.repo, 'update-ref', `refs/heads/${program.integrationBranch}`, tip);
		await engine.resume(id);
		await waitFor(() => harness.allMerged(engine, id), 20_000, 'merged after resuming');
		assert.deepStrictEqual({ halted, after: engine.getProgram(id)!.merges.length, queueHalted: engine.getProgram(id)!.queueHalted }, { halted: { status: 'paused', merges: 1, told: 1 }, after: 3, queueHalted: undefined });
	});

	test('a merge the log did not record before a crash is found and recorded on the next start', async () => {
		const runner = new InProcessRunner(() => writesDone);
		const first = harness.createEngine(runner);
		const id = await harness.startProgram(first.engine, first.lead, [feature('f1', { ladder: ['codex'] }), feature('f2', { ladder: ['lead'] })]);
		await waitFor(() => first.engine.getProgram(id)!.features.get('f1')!.status === 'merged', 20_000, 'f1 merged');
		const merged = first.engine.getProgram(id)!.integrationTip;
		first.engine.dispose();
		// Cut the log just before f1's queue.merged, as a crash between the ref update and the append would.
		const file = path.join(harness.temp.dir, 'storage', id, 'events.jsonl');
		const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
		const cut = lines.findIndex(line => line.includes('"queue.merged"') && line.includes('"f1@1"'));
		fs.writeFileSync(file, `${lines.slice(0, cut).join('\n')}\n`);

		const second = harness.createEngine(runner);
		await second.engine.start();
		const program = second.engine.getProgram(id)!;
		assert.deepStrictEqual({ tip: program.integrationTip, f1: program.features.get('f1')!.status, halted: program.queueHalted }, { tip: merged, f1: 'merged', halted: undefined });
	});

	test('a lead submission that conflicts returns the conflict, and lead_workspace merges the branch in to resolve it', async () => {
		const runner = new InProcessRunner(() => writes('done\n'));
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2', { ladder: ['lead'] })]);
		// The lead's worktree falls behind: f1 lands, and the lead writes f1's file without it.
		await waitFor(() => engine.getProgram(id)!.features.get('f1')!.status === 'merged', 20_000, 'f1 merged');
		const workspace = (engine.getProgram(id)!.lead!).path;
		write(path.join(workspace, 'src', 'f1.txt'), 'the lead\'s version\n');
		const conflict = await lead('lead_submit', { program_id: id, kind: 'resolve', message: 'Rewrite f1' });
		const refreshed = await lead('lead_workspace', { program_id: id });
		const markers = fs.readFileSync(path.join(workspace, 'src', 'f1.txt'), 'utf8').includes('<<<<<<<');
		write(path.join(workspace, 'src', 'f1.txt'), 'done\nthe lead\'s version\n');
		const resolved = await lead('lead_submit', { program_id: id, kind: 'resolve', message: 'Keep both' });
		assert.deepStrictEqual({
			conflict: status(conflict),
			conflicts: (refreshed.data as { conflicts: string[] }).conflicts,
			markers,
			resolved: status(resolved),
			f1: run(harness.repo, 'show', `${engine.getProgram(id)!.integrationBranch}:src/f1.txt`)
		}, { conflict: 'conflict', conflicts: ['src/f1.txt'], markers: true, resolved: 'merged', f1: 'done\nthe lead\'s version' });
	});
});
