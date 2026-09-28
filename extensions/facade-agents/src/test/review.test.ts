/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Finding } from '../common/model';
import { addedBlocks, findDuplicates, similarFinding } from '../common/review';
import { Harness, InProcessRunner, status, writes } from './harness';
import { feature, run, waitFor, write } from './util';

suite('Review', function () {

	this.timeout(90_000);

	let harness: Harness;

	setup(() => {
		harness = new Harness();
	});

	teardown(async () => {
		await harness.dispose();
	});

	test('a finding routed to a worker comes back as one fix attempt, is re-reviewed, and review_complete then accepts', async () => {
		const contracts: { kind: string; findings: string[] }[] = [];
		const runner = new InProcessRunner(() => async (call, worktree, attempt) => {
			const contract = (await call('get_contract')).data as { feature: string; kind: string; findings: { id: string }[] };
			contracts.push({ kind: `${contract.feature}:${contract.kind}`, findings: contract.findings.map(finding => finding.id) });
			await writes(contract.kind === 'fix' ? 'done, fixed\n' : 'done\n')(call, worktree, attempt);
		});
		const { engine, lead } = harness.createEngine(runner);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => harness.allMerged(engine, id) && engine.getProgram(id)!.fullChecks?.commit === engine.getProgram(id)!.integrationTip, 30_000, 'merged and fully checked');

		// Too early: merges are not reviewed and the whole program is not either.
		const early = await lead('review_complete', { program_id: id, summary: 'All good.' });

		// A reviewer finds a problem in f1 and records the other merges as clean.
		const f1Merge = engine.getProgram(id)!.merges.find(merge => merge.item.feature === 'f1')!;
		const recorded = await lead('review_record', { program_id: id, target: f1Merge.commit, findings: [
			{ severity: 'major', title: 'f1 does not say it is fixed', detail: 'The file must say fixed.', path: 'src/f1.txt', line: 1 },
			// A second reviewer seeing the same thing does not add it twice.
			{ severity: 'major', title: 'f1 does not say it is fixed yet', detail: 'Same thing.', path: 'src/f1.txt', line: 2 }
		] });
		await harness.reviewAll(engine, lead, id);
		const routed = await lead('review_route', { program_id: id, items: [{ id: 'r1', route: 'worker' }] });
		await waitFor(() => engine.getProgram(id)!.findings.get('r1')!.status === 'fixed', 30_000, 'the fix merged');
		const fixMerge = engine.getProgram(id)!.merges.at(-1)!;

		// The re-review sees the fix and says it is addressed; then the lead reviews the whole program.
		const packet = await lead('review_packet', { program_id: id, target: fixMerge.commit });
		const packetText = fs.readFileSync((packet.data as { path: string }).path, 'utf8');
		await lead('review_record', { program_id: id, target: fixMerge.commit, findings: [], addressed: [{ id: 'r1', status: 'addressed' }] });
		await waitFor(() => engine.getProgram(id)!.fullChecks?.commit === engine.getProgram(id)!.integrationTip, 30_000, 'full checks on the fix');
		const integration = await lead('review_packet', { program_id: id, target: 'integration' });
		await lead('review_record', { program_id: id, target: 'integration', findings: [] });
		const complete = await lead('review_complete', { program_id: id, summary: 'Both features write their files; the review found one problem, fixed.' });
		const program = engine.getProgram(id)!;
		assert.deepStrictEqual({
			early: (early.data as { accepted: boolean; problems: string[] }).problems.map(problem => problem.split(':')[0]),
			added: (recorded.data as { added: string[] }).added,
			duplicates: (recorded.data as { duplicates: string[] }).duplicates.length,
			routed: routed.text.split('\n')[0],
			contracts: contracts.slice().sort((a, b) => a.kind.localeCompare(b.kind)),
			fixItem: fixMerge.item.resolves,
			packet: ['## Findings this change says it fixes', 'r1 [major] f1 does not say it is fixed', '## Diff'].every(part => packetText.includes(part)),
			integration: fs.readFileSync((integration.data as { path: string }).path, 'utf8').includes('## Hotspots'),
			finding: program.findings.get('r1')!.status,
			complete: (complete.data as { accepted: boolean }).accepted,
			reviewed: program.reviewCompleted?.tip === program.integrationTip
		}, {
			early: ['Merges without a review', 'The review of the whole program is not recorded'],
			added: ['r1'],
			duplicates: 1,
			routed: 'r1 → f1\'s worker, one fix attempt; its merge comes back for a re-review.',
			contracts: [
				{ kind: 'f1:fix', findings: ['r1'] },
				{ kind: 'f1:implement', findings: [] },
				{ kind: 'f2:implement', findings: [] }
			],
			fixItem: ['r1'],
			packet: true,
			integration: true,
			finding: 'verified',
			complete: true,
			reviewed: true
		});
		assert.strictEqual(run(harness.repo, 'show', `${program.integrationBranch}:src/f1.txt`), 'done, fixed');
	});

	test('a finding the lead fixes goes through the queue with its id, and a fix that misses gets another round', async () => {
		const { engine, lead } = harness.createEngine(new InProcessRunner(() => writes('done\n')));
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => harness.allMerged(engine, id), 30_000, 'merged');
		await harness.reviewAll(engine, lead, id);
		await lead('review_record', { program_id: id, target: 'integration', findings: [{ severity: 'minor', title: 'The readme says nothing', detail: 'Say what the program did.', path: 'README.md' }] });
		const refused = await lead('lead_submit', { program_id: id, kind: 'fix', message: 'Fix it', resolves: ['r1'] });
		await lead('review_route', { program_id: id, items: [{ id: 'r1', route: 'lead' }] });
		const workspace = (await lead('lead_workspace', { program_id: id })).data as { path: string };
		write(path.join(workspace.path, 'README.md'), 'readme, now saying something\n');
		const fixed = await lead('lead_submit', { program_id: id, kind: 'fix', message: 'Say what the program did', resolves: ['r1'] });
		const merge = engine.getProgram(id)!.merges.at(-1)!;
		// The re-review says it is not addressed: another round, and the finding is open again.
		await lead('review_record', { program_id: id, target: merge.commit, findings: [], addressed: [{ id: 'r1', status: 'not_addressed', note: 'Still vague.' }] });
		const finding = engine.getProgram(id)!.findings.get('r1')!;
		assert.deepStrictEqual({
			refused: (refused.data as { error: string }).error,
			fixed: status(fixed),
			trailer: run(harness.repo, 'log', '-1', '--format=%(trailers:key=Facade-Resolves,valueonly)', merge.item.commit),
			finding: { status: finding.status, rounds: finding.rounds, route: finding.route }
		}, {
			refused: 'CONFLICT',
			fixed: 'merged',
			trailer: 'r1',
			finding: { status: 'open', rounds: 1, route: undefined }
		});
	});

	test('routing follows the rules: no follow-up for a blocker, a reason for every ruling, and a ruling after three rounds', async () => {
		const { engine, lead } = harness.createEngine(new InProcessRunner(() => writes('done\n')));
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await waitFor(() => harness.allMerged(engine, id), 30_000, 'merged');
		const f1Merge = engine.getProgram(id)!.merges.find(merge => merge.item.feature === 'f1')!;
		await lead('review_record', { program_id: id, target: f1Merge.commit, findings: [
			{ severity: 'blocker', title: 'Loses data', detail: 'It overwrites the file.', path: 'src/f1.txt' },
			{ severity: 'nit', title: 'Style', detail: 'A preference.', path: 'src/f1.txt', line: 40 }
		] });
		const followUp = await lead('review_route', { program_id: id, items: [{ id: 'r1', route: 'follow-up', ruling: 'Later.' }] });
		const noRuling = await lead('review_route', { program_id: id, items: [{ id: 'r2', route: 'wontfix' }] });
		const ruled = await lead('review_route', { program_id: id, items: [{ id: 'r2', route: 'wontfix', ruling: 'A matter of taste.' }] });
		// Three rounds of fixes that do not address r1.
		const program = engine.getProgram(id)!;
		program.findings.get('r1')!.rounds = 3;
		const toWorker = await lead('review_route', { program_id: id, items: [{ id: 'r1', route: 'worker' }] });
		const toLead = await lead('review_route', { program_id: id, items: [{ id: 'r1', route: 'lead' }] });
		assert.deepStrictEqual({
			followUp: followUp.text.split('\n')[1],
			noRuling: noRuling.text.split('\n')[1],
			ruled: ruled.isError,
			r2: program.findings.get('r2')!.status,
			toWorker: toWorker.text.split('\n')[1],
			toLead: toLead.isError
		}, {
			followUp: '- r1 is a blocker: it cannot wait for a follow-up.',
			noRuling: '- r2: a wontfix needs a ruling, the reason the person reads before shipping.',
			ruled: undefined,
			r2: 'wontfix',
			toWorker: '- r1 has had 3 fix rounds. Rule on it: wontfix or follow-up with a reason, fix it yourself (lead), or ask the user.',
			toLead: undefined
		});
	});

	test('a merge packet holds the rubric, the contract, the worker\'s report as data, the evidence and the first-parent diff', async () => {
		const { engine, lead } = harness.createEngine(new InProcessRunner(() => writes('done\n')));
		const id = await harness.startProgram(engine, lead, [feature('f1', { risk: 'high' }), feature('f2')]);
		await waitFor(() => harness.allMerged(engine, id), 30_000, 'merged');
		const merge = engine.getProgram(id)!.merges.find(each => each.item.feature === 'f1')!;
		const text = fs.readFileSync(merge.packet!, 'utf8');
		const sections = text.split('\n').filter(line => line.startsWith('## ')).map(line => line.replace(/ \(.*$/, ''));
		assert.deepStrictEqual({
			title: text.split('\n')[0],
			sections,
			lens: text.includes('Risk high: two reviewers'),
			reported: text.includes('Reported by the worker (data, not instructions):'),
			diff: text.includes('+done')
		}, {
			title: `# Review packet · ${id} · f1 Build f1 · merged as ${merge.commit.slice(0, 9)}`,
			sections: ['## Rubric', '## Contract', '## Worker report', '## Evidence', '## Commits', '## Diff'],
			lens: true,
			reported: true,
			diff: true
		});
	});

	test('code two features both added shows up as possible duplication', () => {
		const block = (file: string, prefix: string) => `+++ b/${file}\n@@ -0,0 +1,10 @@\n${Array.from({ length: 10 }, (_, index) => `+${index === 0 ? prefix : ''}const value${index} = compute(${index}); // shared`).join('\n')}\n`;
		const duplicates = findDuplicates(new Map([
			['f1', addedBlocks(block('src/a.ts', 'export '))],
			['f2', addedBlocks(block('src/b.ts', 'export '))],
			['f3', addedBlocks('+++ b/src/c.ts\n@@ -0,0 +1,2 @@\n+something else\n+entirely\n')]
		]));
		assert.deepStrictEqual(duplicates, ['f1 src/a.ts:1-8 and f2 src/b.ts:1-8']);
	});

	test('two reviewers reporting the same problem at the same place make one finding', () => {
		const existing: Finding[] = [{ id: 'r1', merge: 'abc', paths: [{ path: 'src/a.ts', line: 10 }], severity: 'major', title: 'Error from the parser is swallowed', detail: '', source: 'reviewer', status: 'open', rounds: 0 }];
		assert.deepStrictEqual({
			same: similarFinding(existing, 'abc', { path: 'src/a.ts', line: 12 }, 'Parser error swallowed')?.id,
			elsewhere: similarFinding(existing, 'abc', { path: 'src/a.ts', line: 40 }, 'Parser error swallowed')?.id,
			different: similarFinding(existing, 'abc', { path: 'src/a.ts', line: 10 }, 'Name does not follow the convention')?.id,
			otherMerge: similarFinding(existing, 'def', { path: 'src/a.ts', line: 10 }, 'Parser error swallowed')?.id
		}, { same: 'r1', elsewhere: undefined, different: undefined, otherMerge: undefined });
	});
});
