/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Engine } from '../common/engine';
import { Call, Harness, HarnessOptions, InProcessRunner, status, writesDone } from './harness';
import { fakeAdapter, feature, run, waitFor, write } from './util';

suite('Ship', function () {

	this.timeout(90_000);

	let harness: Harness;

	setup(() => {
		harness = new Harness();
	});

	teardown(async () => {
		await harness.dispose();
	});

	/** A program with two merged, reviewed and fully checked features. */
	async function reviewed(options: HarnessOptions = {}): Promise<{ engine: Engine; lead: Call; id: string; ui: { shipRequests: string[] } }> {
		const { engine, lead, ui } = harness.createEngine(new InProcessRunner(() => writesDone), options);
		const id = await harness.startProgram(engine, lead, [feature('f1'), feature('f2')]);
		await complete(engine, lead, id);
		return { engine, lead, id, ui };
	}

	async function complete(engine: Engine, lead: Call, id: string): Promise<void> {
		await waitFor(() => harness.allMerged(engine, id) && engine.getProgram(id)!.fullChecks?.commit === engine.getProgram(id)!.integrationTip, 30_000, 'merged and fully checked');
		await harness.reviewAll(engine, lead, id);
		if (!engine.getProgram(id)!.integrationReviewed) {
			await lead('review_record', { program_id: id, target: 'integration', findings: [] });
		}
		const done = await lead('review_complete', { program_id: id, summary: 'Two features, each writing its file.' });
		assert.strictEqual((done.data as { accepted: boolean }).accepted, true, done.text);
	}

	async function approve(engine: Engine, id: string): Promise<void> {
		engine.approveShip(id);
		await waitFor(() => engine.getProgram(id)!.ship?.status === 'done' || engine.getProgram(id)!.ship?.status === 'failed', 30_000, 'shipping to end');
	}

	test('merge where the base branch is checked out nowhere: a merge commit with the reviewed tree, then cleanup', async () => {
		run(harness.repo, 'switch', '--quiet', '--create', 'elsewhere');
		const { engine, lead, id, ui } = await reviewed();
		const oldMain = run(harness.repo, 'rev-parse', 'main');
		const program = engine.getProgram(id)!;
		const tip = program.integrationTip!;
		const asked = await lead('ship', { program_id: id, mode: 'merge' });
		const message = engine.shipMessage(id);
		await approve(engine, id);
		const main = run(harness.repo, 'rev-parse', 'main');
		assert.deepStrictEqual({
			asked: status(asked),
			told: ui.shipRequests,
			ship: program.ship?.status,
			status: program.status,
			// I3: the base branch has exactly the reviewed tree.
			tree: run(harness.repo, 'rev-parse', 'main^{tree}') === run(harness.repo, 'rev-parse', `${tip}^{tree}`),
			parents: [run(harness.repo, 'rev-parse', 'main^1') === oldMain, run(harness.repo, 'rev-parse', 'main^2') === tip],
			message: run(harness.repo, 'log', '-1', '--format=%B', main).trim() === message.trim(),
			features: message.includes('Features\n  f1 Build f1'),
			facadeBranches: run(harness.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/facade'),
			worktrees: run(harness.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length,
			kept: program.ship?.kept
		}, {
			asked: 'awaiting_approval',
			told: [id],
			ship: 'done',
			status: 'shipped',
			tree: true,
			parents: [true, true],
			message: true,
			features: true,
			facadeBranches: '',
			worktrees: 1,
			kept: []
		});
	});

	test('cleanup takes the files Facade wrote for agents out of the worktrees, so they can go', async () => {
		// The repository has its own copy of one of them, which comes back as it was.
		write(path.join(harness.repo, '.fake', 'config.json'), '{"keep":true}\n');
		run(harness.repo, 'add', '.');
		run(harness.repo, 'commit', '-q', '-m', 'config');
		run(harness.repo, 'switch', '--quiet', '--create', 'elsewhere');
		const adapter = fakeAdapter('codex', 'unused', { injected: [{ path: '.fake/config.json', content: '{"facade":1}' }, { path: '.agents/hooks.json', content: '{}' }] });
		const { engine, lead, id } = await reviewed({ adapters: [adapter] });
		await lead('ship', { program_id: id, mode: 'merge' });
		await approve(engine, id);
		const program = engine.getProgram(id)!;
		assert.deepStrictEqual({
			ship: program.ship?.status,
			kept: program.ship?.kept,
			worktrees: run(harness.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length,
			config: run(harness.repo, 'show', 'main:.fake/config.json')
		}, { ship: 'done', kept: [], worktrees: 1, config: '{"keep":true}' });
	});

	test('merge where the base branch is checked out and clean: git merges it there', async () => {
		const { engine, lead, id } = await reviewed();
		const tip = engine.getProgram(id)!.integrationTip!;
		await lead('ship', { program_id: id, mode: 'merge' });
		await approve(engine, id);
		assert.deepStrictEqual({
			ship: engine.getProgram(id)!.ship?.status,
			tree: run(harness.repo, 'rev-parse', 'HEAD^{tree}') === run(harness.repo, 'rev-parse', `${tip}^{tree}`),
			secondParent: run(harness.repo, 'rev-parse', 'HEAD^2') === tip,
			files: fs.readFileSync(path.join(harness.repo, 'src', 'f2.txt'), 'utf8'),
			clean: run(harness.repo, 'status', '--porcelain', '--untracked-files=no')
		}, { ship: 'done', tree: true, secondParent: true, files: 'done\n', clean: '' });
	});

	test('merge where the base branch is checked out with changes: refused before anything moves', async () => {
		const { engine, lead, id } = await reviewed();
		write(path.join(harness.repo, 'README.md'), 'edited by the person\n');
		const main = run(harness.repo, 'rev-parse', 'main');
		const refused = await lead('ship', { program_id: id, mode: 'merge' });
		assert.deepStrictEqual({
			error: (refused.data as { error: string }).error,
			mentions: refused.text.includes('README.md'),
			main: run(harness.repo, 'rev-parse', 'main') === main,
			ship: engine.getProgram(id)!.ship
		}, { error: 'DIRTY', mentions: true, main: true, ship: undefined });
	});

	test('when the base branch moved, it is merged in through the queue and reviewed before shipping', async () => {
		const { engine, lead, id } = await reviewed();
		// Someone lands a change on main meanwhile.
		write(path.join(harness.repo, 'CHANGELOG.md'), 'news\n');
		run(harness.repo, 'add', 'CHANGELOG.md');
		run(harness.repo, 'commit', '-q', '-m', 'News on main');
		const syncing = await lead('ship', { program_id: id, mode: 'merge' });
		await waitFor(() => engine.getProgram(id)!.merges.some(merge => merge.item.kind === 'sync'), 30_000, 'the sync merged');
		const notYet = await lead('ship', { program_id: id, mode: 'merge' });
		await complete(engine, lead, id);
		await lead('ship', { program_id: id, mode: 'merge' });
		await approve(engine, id);
		assert.deepStrictEqual({
			syncing: status(syncing),
			notYet: (notYet.data as { error: string }).error,
			ship: engine.getProgram(id)!.ship?.status,
			changelog: fs.readFileSync(path.join(harness.repo, 'CHANGELOG.md'), 'utf8'),
			f1: fs.readFileSync(path.join(harness.repo, 'src', 'f1.txt'), 'utf8'),
			tree: run(harness.repo, 'rev-parse', 'HEAD^{tree}') === run(harness.repo, 'rev-parse', `${engine.getProgram(id)!.integrationTip}^{tree}`)
		}, { syncing: 'syncing', notYet: 'NOT_READY', ship: 'done', changelog: 'news\n', f1: 'done\n', tree: true });
	});

	test('when the base branch moved and conflicts, the lead merges it in its worktree, and the resolution goes through the queue and review', async () => {
		const { engine, lead, id } = await reviewed();
		// main changes the file the scaffold changed.
		write(path.join(harness.repo, 'src', 'shared.txt'), 'shared, changed on main\n');
		run(harness.repo, 'commit', '-q', '-am', 'Change shared on main');
		const refused = await lead('ship', { program_id: id, mode: 'merge' });
		const workspace = await lead('lead_workspace', { program_id: id, sync: true });
		const leadPath = (workspace.data as { path: string }).path;
		write(path.join(leadPath, 'src', 'shared.txt'), 'shared, with the scaffold, changed on main\n');
		const resolved = await lead('lead_submit', { program_id: id, kind: 'resolve', message: 'Merge main and keep both changes to shared' });
		await complete(engine, lead, id);
		await lead('ship', { program_id: id, mode: 'merge' });
		await approve(engine, id);
		assert.deepStrictEqual({
			refused: (refused.data as { error: string }).error,
			conflicts: (workspace.data as { conflicts: string[] }).conflicts,
			resolved: status(resolved),
			ship: engine.getProgram(id)!.ship?.status,
			shared: fs.readFileSync(path.join(harness.repo, 'src', 'shared.txt'), 'utf8')
		}, {
			refused: 'BASE_CONFLICTS',
			conflicts: ['src/shared.txt'],
			resolved: 'merged',
			ship: 'done',
			shared: 'shared, with the scaffold, changed on main\n'
		});
	});

	test('squash puts one commit with the reviewed tree on the base branch', async () => {
		run(harness.repo, 'switch', '--quiet', '--create', 'elsewhere');
		const { engine, lead, id } = await reviewed();
		const oldMain = run(harness.repo, 'rev-parse', 'main');
		const tip = engine.getProgram(id)!.integrationTip!;
		await lead('ship', { program_id: id, mode: 'squash' });
		await approve(engine, id);
		assert.deepStrictEqual({
			ship: engine.getProgram(id)!.ship?.status,
			parents: run(harness.repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1),
			tree: run(harness.repo, 'rev-parse', 'main^{tree}') === run(harness.repo, 'rev-parse', `${tip}^{tree}`),
			// The integration branch is not in main's history, so it stays.
			integrationKept: run(harness.repo, 'rev-parse', engine.getProgram(id)!.integrationBranch!) === tip
		}, { ship: 'done', parents: [oldMain], tree: true, integrationKept: true });
	});

	test('pr pushes the integration branch and opens a pull request with gh', async () => {
		const remote = path.join(harness.temp.dir, 'remote.git');
		run(harness.temp.dir, 'init', '-q', '--bare', remote);
		run(harness.repo, 'remote', 'add', 'origin', remote);
		const bin = path.join(harness.temp.dir, 'bin');
		fs.mkdirSync(bin);
		const calls = path.join(harness.temp.dir, 'gh-calls.txt');
		if (process.platform === 'win32') {
			fs.writeFileSync(path.join(bin, 'gh.cmd'), `@echo %* >> "${calls}"\r\n@echo https://example.test/pull/7\r\n`);
		} else {
			fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${calls}'\necho https://example.test/pull/7\n`, { mode: 0o755 });
		}
		const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`, Path: undefined };
		const { engine, lead, id } = await reviewed({ env });
		const main = run(harness.repo, 'rev-parse', 'main');
		const branch = engine.getProgram(id)!.integrationBranch!;
		await lead('ship', { program_id: id, mode: 'pr' });
		await approve(engine, id);
		assert.deepStrictEqual({
			ship: engine.getProgram(id)!.ship?.status,
			url: engine.getProgram(id)!.ship?.url,
			pushed: run(remote, 'rev-parse', `refs/heads/${branch}`) === engine.getProgram(id)!.integrationTip,
			gh: fs.readFileSync(calls, 'utf8').replace(/"/g, '').includes(`pr create --base main --head ${branch}`),
			main: run(harness.repo, 'rev-parse', 'main') === main
		}, { ship: 'done', url: 'https://example.test/pull/7', pushed: true, gh: true, main: true });
	});
});
