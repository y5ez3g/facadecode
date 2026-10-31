/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { branchFolderOf, plannedDestination, whyNotFolderName } from '../core/locations/destination';
import { worktreeProblemOf } from '../core/locations/problems';
import { LocationRemoval, WorktreeError, WorktreePlan } from '../core/ports';
import { checkoutOf, hasChanges, removeWorktree, worktreesOf } from '../host/locations/gitRead';
import { LocationService } from '../host/locations/service';
import { NativeCreator, NativeGit, WorktreeGit, WorktreeService } from '../host/locations/worktrees';
import { tempDir } from './util';

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

suite('Worktrees: where a new one goes (WORKTREES-2.2)', () => {

	test('the folder is the branch without git.branchPrefix, separators and characters no OS allows made "-"; a name no folder can have is refused', () => {
		assert.deepStrictEqual([branchFolderOf('me/feat/x', 'me/'), branchFolderOf('feat/a:b*c', ''), branchFolderOf('other/x', 'me/')], ['feat-x', 'feat-a-b-c', 'other-x']);
		// Said as data, which the host words in English and the pickers in the person's language (UX-2.4)
		assert.deepStrictEqual([whyNotFolderName('ok', ''), whyNotFolderName('me/', 'me/'), whyNotFolderName('x.', ''), whyNotFolderName('nul', '')], [
			undefined, { kind: 'folder_name', name: '', why: 'unusable' }, { kind: 'folder_name', name: 'x.', why: 'trailing' }, { kind: 'folder_name', name: 'nul', why: 'device' }
		]);
	});

	test('it goes in <main-folder>.worktrees beside the main checkout, with the next free numeric suffix: never over anything there', () => {
		// An absolute folder as this system names it: on Windows with the current drive
		const w = path.resolve('/w');
		const taken = new Set([path.join(w, 'repo.worktrees', 'feat'), path.join(w, 'repo.worktrees', 'feat-1')]);

		assert.strictEqual(plannedDestination('/w/repo', 'feat', '', candidate => taken.has(candidate)), path.join(w, 'repo.worktrees', 'feat-2'));
		assert.strictEqual(plannedDestination('/w/repo/', 'me/new', 'me/', () => false), path.join(w, 'repo.worktrees', 'new'));
	});
});

suite('Worktrees: native creation from a selected checkout (WORKTREES-2, 4.1-4.3; VERIFICATION W01-W03)', () => {

	let temp: { dir: string; remove(): void };
	let repo: string;
	let services: { dispose(): void }[];
	const settings = { prefix: '', pattern: '' };

	setup(() => {
		temp = tempDir('fd-worktrees-');
		repo = path.join(temp.dir, 'repo');
		git(temp.dir, 'init', '-q', '-b', 'main', repo);
		git(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
		services = [];
		settings.prefix = '';
		settings.pattern = '';
	});

	teardown(() => {
		services.forEach(each => each.dispose());
		temp.remove();
	});

	/** What the editor's `Repository.createWorktree` does with an explicit path: `git worktree add -b`, answering the path. */
	function nativeAdd(options: { path: string; branch: string; commitish: string }): Promise<string> {
		git(repo, 'worktree', 'add', '-q', '-b', options.branch, options.path, options.commitish);
		return Promise.resolve(options.path);
	}

	/** A window with `folders` open, its locations read from this disk with this Git, and `native` as its editor's Git API. */
	async function windowWith(folders: readonly string[], native: Partial<NativeGit> & { creator?: NativeCreator['createWorktree'] } = {}, gitCalls: Partial<WorktreeGit> = {}) {
		const locations = new LocationService({
			environment: 'local',
			folders: { folders: () => folders.map((each, index) => ({ index, name: path.basename(each), uri: `file://${each}`, path: each })), onDidChange: () => ({ dispose: () => undefined }) },
			git: { executable: async () => 'git', checkoutOf, worktreesOf },
			watch: () => ({ dispose: () => undefined }),
			uriOf: (_folder, location) => `file://${location}`,
			known: { get: () => undefined, set: () => undefined },
			log: { event: () => undefined }
		});
		services.push(locations);
		await locations.refresh().catch(() => undefined);
		const nativeCalls: string[][] = [];
		const removals: LocationRemoval[] = [];
		locations.onDidRemove(removal => removals.push(removal));
		const worktrees = new WorktreeService({
			locations,
			git: { executable: async () => 'git', checkoutOf, worktreesOf, hasChanges, removeWorktree, ...gitCalls },
			native: {
				unsupported: native.unsupported ?? (async () => undefined),
				repository: native.repository ?? (async uris => {
					nativeCalls.push([...uris]);
					return { createWorktree: native.creator ?? nativeAdd };
				})
			},
			settings: { branchPrefix: () => settings.prefix, branchValidationRegex: () => settings.pattern },
			locks: path.join(temp.dir, 'locks'),
			log: { event: () => undefined }
		});
		const idOf = (location: string) => {
			const found = locations.locationAt(location);
			assert.ok(found, `no location at ${location}`);
			return found.id;
		};
		return { locations, worktrees, idOf, nativeCalls, removals };
	}

	async function reasonOf(promise: Promise<unknown>): Promise<string> {
		try {
			await promise;
			return 'fulfilled';
		} catch (err) {
			return err instanceof WorktreeError ? err.reason : `not a WorktreeError: ${err}`;
		}
	}

	test('availability says the actual prerequisite: a repository, a commit, Git, an editor with native creation; never an offer to set one up (WORKTREES-2.3; W02)', async () => {
		const plain = path.join(temp.dir, 'plain');
		const empty = path.join(temp.dir, 'empty');
		fs.mkdirSync(plain);
		git(temp.dir, 'init', '-q', '-b', 'main', empty);
		const { worktrees, idOf } = await windowWith([repo, plain, empty]);
		const without = await windowWith([repo], { unsupported: async () => ({ kind: 'no_native_creation' }) });

		// In English for agents and the log, and as its problem for the person's own words (UX-2.4)
		assert.deepStrictEqual(await worktrees.availability(idOf(repo)), { available: true });
		assert.deepStrictEqual(await worktrees.availability(idOf(plain)), { available: false, reason: `${plain} is not in a Git repository.`, problem: { kind: 'not_repository', path: plain } });
		assert.deepStrictEqual(await worktrees.availability(idOf(empty)), { available: false, reason: `${empty} has no commits yet.`, problem: { kind: 'no_commit', path: empty } });
		assert.deepStrictEqual(await without.worktrees.availability(without.idOf(repo)), { available: false, reason: 'This editor\'s Git extension cannot create worktrees: its API has no worktree creation.', problem: { kind: 'no_native_creation' } });
		assert.deepStrictEqual([await reasonOf(worktrees.plan(idOf(plain), 'x')), await reasonOf(worktrees.plan(idOf(empty), 'x')), await reasonOf(without.worktrees.plan(without.idOf(repo), 'x'))],
			['repository_required', 'commit_required', 'unavailable']);
		assert.deepStrictEqual(fs.readdirSync(path.join(empty, '.git', 'refs', 'heads')), []);
	});

	test('a plan proposes branch, base and destination without any effect: git.branchPrefix off the folder name, the source checkout\'s HEAD as base (WORKTREES-2.1, 2.2)', async () => {
		settings.prefix = 'me/';
		const head = git(repo, 'rev-parse', 'HEAD');
		const { worktrees, idOf } = await windowWith([repo]);
		const plan = await worktrees.plan(idOf(repo), 'me/feat/one');

		assert.deepStrictEqual(plan, { source: idOf(repo), branch: 'me/feat/one', baseRef: 'HEAD', baseCommit: head, destination: path.join(temp.dir, 'repo.worktrees', 'feat-one') });
		assert.ok(!fs.existsSync(path.join(temp.dir, 'repo.worktrees')));
		assert.strictEqual(git(repo, 'branch', '--list', 'me/feat/one'), '');
	});

	test('the default base is the selected source checkout\'s HEAD - a worktree\'s own, not the main checkout\'s - and a named base resolves there', async () => {
		const other = path.join(temp.dir, 'other');
		git(repo, 'worktree', 'add', '-q', '-b', 'other', other);
		git(other, 'commit', '-q', '--allow-empty', '-m', 'ahead');
		const { worktrees, idOf } = await windowWith([other]);

		assert.strictEqual((await worktrees.plan(idOf(other), 'from-other')).baseCommit, git(other, 'rev-parse', 'HEAD'));
		assert.strictEqual((await worktrees.plan(idOf(other), 'from-main', 'main')).baseCommit, git(repo, 'rev-parse', 'HEAD'));
		assert.notStrictEqual(git(other, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'HEAD'));
		// The new worktree still goes beside the main checkout
		assert.strictEqual((await worktrees.plan(idOf(other), 'from-other')).destination, path.join(temp.dir, 'repo.worktrees', 'from-other'));
	});

	test('a branch is Git\'s to judge, with git.branchValidationRegex; an existing branch, a base that names nothing and an unknown location are refused (W01)', async () => {
		git(repo, 'branch', 'taken');
		const { worktrees, idOf } = await windowWith([repo]);
		const refused = async (branch: string, base?: string) => {
			try {
				await worktrees.plan(idOf(repo), branch, base);
				return 'fulfilled';
			} catch (err) {
				return `${(err as WorktreeError).reason}: ${(err as Error).message} ${JSON.stringify(worktreeProblemOf(err))}`;
			}
		};

		assert.match(await refused('a..b'), /^invalid_argument: Git rejects "a\.\.b" as a branch name \{"kind":"branch_rejected","branch":"a\.\.b"\}$/);
		assert.match(await refused('-x'), /^invalid_argument: Git rejects "-x"/);
		assert.match(await refused('taken'), /^invalid_argument: A branch named taken already exists\. \{"kind":"branch_exists","branch":"taken"\}$/);
		assert.match(await refused('fine', 'no-such-ref'), /^invalid_argument: no-such-ref is not a commit in the repository .*"kind":"base_unknown","ref":"no-such-ref"/);
		assert.match(await refused('x.'), /^invalid_argument: "x\." ends in a dot or a space, which Windows does not allow at the end of a folder's name \{"kind":"folder_name","name":"x\.","why":"trailing"\}$/);
		settings.pattern = '^team/';
		assert.match(await refused('fine'), /^invalid_argument: fine does not match git\.branchValidationRegex \(\^team\/\)\. \{"kind":"pattern_mismatch","branch":"fine","pattern":"\^team\/"\}$/);
		assert.strictEqual(await refused('team/fine'), 'fulfilled');
		assert.strictEqual(await reasonOf(worktrees.plan('loc-0000000000000000', 'x')), 'invalid_argument');
	});

	test('an occupied destination - a directory, a dangling link, a registered worktree whose folder is gone - takes the next free suffix; nothing there is touched', async () => {
		const parent = path.join(temp.dir, 'repo.worktrees');
		fs.mkdirSync(path.join(parent, 'feat'), { recursive: true });
		fs.writeFileSync(path.join(parent, 'feat', 'mine.txt'), 'keep');
		// A junction on Windows, which needs no administrator; a link elsewhere
		fs.symlinkSync(path.join(temp.dir, 'nowhere'), path.join(parent, 'feat-1'), 'junction');
		git(repo, 'worktree', 'add', '-q', '-b', 'gone', path.join(parent, 'feat-2'));
		fs.rmSync(path.join(parent, 'feat-2'), { recursive: true, force: true });
		const { worktrees, idOf } = await windowWith([repo]);

		assert.strictEqual((await worktrees.plan(idOf(repo), 'feat')).destination, path.join(parent, 'feat-3'));
		assert.strictEqual(fs.readFileSync(path.join(parent, 'feat', 'mine.txt'), 'utf8'), 'keep');
	});

	test('create makes it through the editor\'s API at the planned path from the planned commit, Git confirms it, and it becomes a location - no window, no workspace folder (W01, W03)', async () => {
		const { locations, worktrees, idOf, nativeCalls } = await windowWith([repo]);
		const plan = await worktrees.plan(idOf(repo), 'feat');
		const made = await worktrees.create(plan, () => true);

		assert.deepStrictEqual([made.path, made.branch, made.kind, made.opened], [plan.destination, 'feat', 'checkout', false]);
		assert.deepStrictEqual(locations.snapshot().folders.map(each => each.path), [repo]);
		assert.ok(locations.snapshot().locations.some(each => each.id === made.id));
		assert.strictEqual(git(plan.destination, 'rev-parse', 'HEAD'), plan.baseCommit);
		assert.deepStrictEqual(nativeCalls, [[`file://${repo}`]]);
	});

	test('a failed native creation keeps and reports what it left - the branch stays, nothing is rolled back - with Git\'s own words (WORKTREES-2.2, 4.2; W01)', async () => {
		const { worktrees, idOf } = await windowWith([repo], {
			creator: async options => {
				git(repo, 'branch', options.branch, options.commitish);
				throw Object.assign(new Error('Failed to execute git'), { stderr: 'fatal: could not create work tree dir: Permission denied\n' });
			}
		});
		const plan = await worktrees.plan(idOf(repo), 'feat');
		const failure = await worktrees.create(plan, () => true).then(() => undefined, err => err as WorktreeError);

		assert.ok(failure instanceof WorktreeError);
		assert.deepStrictEqual([failure.reason, failure.effects, worktreeProblemOf(failure)], ['creation_failed', { branchCreated: true }, { kind: 'creation_failed', detail: 'fatal: could not create work tree dir: Permission denied' }]);
		assert.strictEqual(failure.message, 'Git could not create the worktree: fatal: could not create work tree dir: Permission denied.');
		assert.strictEqual(git(repo, 'branch', '--list', 'feat'), 'feat');
	});

	test('a launch closed while its creation waits creates nothing; one closed after the creation keeps its worktree (WORKTREES-2.5; W03)', async () => {
		const { worktrees, idOf } = await windowWith([repo]);
		const closed = await worktrees.plan(idOf(repo), 'closed');

		assert.strictEqual(await reasonOf(worktrees.create(closed, () => false)), 'cancelled');
		assert.ok(!fs.existsSync(closed.destination));
		let wanted = true;
		const later = await worktrees.plan(idOf(repo), 'later');
		const made = await worktrees.create(later, () => {
			const answer = wanted;
			wanted = false;
			return answer;
		});
		assert.ok(fs.existsSync(made.path));
	});

	test('creations in one destination folder run one at a time, a later one taking the next free folder (WORKTREES-4.2)', async () => {
		let running = 0;
		let overlapped = false;
		const { worktrees, idOf } = await windowWith([repo], {
			creator: async options => {
				running++;
				overlapped ||= running > 1;
				await new Promise(resolve => setTimeout(resolve, 50));
				running--;
				return nativeAdd(options);
			}
		});
		// Two branches with one folder name, planned before either exists: both propose the same destination
		const plans: WorktreePlan[] = [await worktrees.plan(idOf(repo), 'team/x'), await worktrees.plan(idOf(repo), 'team-x')];
		assert.strictEqual(plans[0].destination, plans[1].destination);
		const made = await Promise.all(plans.map(plan => worktrees.create(plan, () => true)));

		assert.strictEqual(overlapped, false);
		assert.deepStrictEqual(made.map(each => path.basename(each.path)), ['team-x', 'team-x-1']);
	});

	suite('deleting a linked worktree (WORKTREES-3.2, D73)', () => {

		/** What `remove` came to - `fulfilled`, or its reason and problem - and whether it asked to close the agents first. */
		async function removed(worktrees: WorktreeService, id: string, closing?: () => void): Promise<{ outcome: string; closed: number }> {
			let closed = 0;
			try {
				await worktrees.remove(id, async () => { closed++; closing?.(); });
				return { outcome: 'fulfilled', closed };
			} catch (err) {
				return { outcome: `${(err as WorktreeError).reason} ${JSON.stringify(worktreeProblemOf(err))}`, closed };
			}
		}

		test('a clean one: its agents are closed first, then Git removes it without --force; its branch stays, and the catalog confirms the deletion', async () => {
			const feat = path.join(temp.dir, 'repo.worktrees', 'feat');
			fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
			git(repo, 'add', '.gitignore');
			git(repo, 'commit', '-q', '-m', 'ignore');
			git(repo, 'worktree', 'add', '-q', '-b', 'feat', feat);
			// What Git ignores is no change: it goes with the folder, as `git worktree remove` has it
			fs.mkdirSync(path.join(feat, 'node_modules'));
			fs.writeFileSync(path.join(feat, 'node_modules', 'dep.js'), '');
			const { worktrees, idOf, locations, removals } = await windowWith([repo]);
			const id = idOf(feat);
			let presentWhileClosing = false;

			const result = await removed(worktrees, id, () => { presentWhileClosing = fs.existsSync(feat); });

			assert.deepStrictEqual(result, { outcome: 'fulfilled', closed: 1 });
			assert.ok(presentWhileClosing, 'the agents close before Git removes the worktree');
			assert.ok(!fs.existsSync(feat));
			assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes(feat));
			assert.strictEqual(git(repo, 'branch', '--list', 'feat'), 'feat');
			assert.ok(!locations.snapshot().locations.some(each => each.id === id));
			assert.deepStrictEqual(removals, [{ ids: [id], cause: 'deleted' }]);
		});

		test('one with a change not committed or an untracked file is refused before anything is touched: no agent closed, every file kept', async () => {
			const edited = path.join(temp.dir, 'edited');
			const untracked = path.join(temp.dir, 'untracked');
			fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
			git(repo, 'add', 'a.txt');
			git(repo, 'commit', '-q', '-m', 'a');
			git(repo, 'worktree', 'add', '-q', '-b', 'edited', edited);
			git(repo, 'worktree', 'add', '-q', '-b', 'untracked', untracked);
			fs.writeFileSync(path.join(edited, 'a.txt'), 'two');
			fs.writeFileSync(path.join(untracked, 'new.txt'), 'mine');
			// Untracked files count even where Git is set not to show them
			git(repo, 'config', 'status.showUntrackedFiles', 'no');
			const { worktrees, idOf } = await windowWith([repo]);

			assert.deepStrictEqual([await removed(worktrees, idOf(edited)), await removed(worktrees, idOf(untracked))], [
				{ outcome: 'worktree_changed {"kind":"worktree_changed","name":"edited"}', closed: 0 },
				{ outcome: 'worktree_changed {"kind":"worktree_changed","name":"untracked"}', closed: 0 }
			]);
			assert.deepStrictEqual([fs.readFileSync(path.join(edited, 'a.txt'), 'utf8'), fs.readFileSync(path.join(untracked, 'new.txt'), 'utf8')], ['two', 'mine']);
		});

		test('Git preserves missed changes, and a known lock refuses deletion before closing any agent', async () => {
			const missed = path.join(temp.dir, 'missed');
			const locked = path.join(temp.dir, 'locked');
			git(repo, 'worktree', 'add', '-q', '-b', 'missed', missed);
			git(repo, 'worktree', 'add', '-q', '-b', 'locked', locked);
			git(repo, 'worktree', 'lock', locked);
			fs.writeFileSync(path.join(missed, 'new.txt'), 'mine');
			// The check missing a change: Git's own check without --force still refuses
			const { worktrees, idOf } = await windowWith([repo], {}, { hasChanges: async () => false });

			const results = [await removed(worktrees, idOf(missed)), await removed(worktrees, idOf(locked))];

			assert.deepStrictEqual(results.map(each => each.closed), [1, 0]);
			assert.match(results[0].outcome, /^deletion_failed \{"kind":"deletion_failed","name":"missed","detail":"fatal: '.*missed' contains modified or untracked files, use --force to delete it"\}$/);
			assert.strictEqual(results[1].outcome, 'worktree_locked {"kind":"worktree_locked","name":"locked"}');
			assert.ok(fs.existsSync(path.join(missed, 'new.txt')) && fs.existsSync(locked));
		});

		test('only a linked worktree no workspace folder is in: the main checkout, a plain folder, an opened worktree and one holding a workspace folder are refused untouched; a detached one goes', async () => {
			const plain = path.join(temp.dir, 'plain');
			const opened = path.join(temp.dir, 'opened');
			const holding = path.join(temp.dir, 'holding');
			const detached = path.join(temp.dir, 'detached');
			fs.mkdirSync(plain);
			git(repo, 'worktree', 'add', '-q', '-b', 'opened', opened);
			git(repo, 'worktree', 'add', '-q', '-b', 'holding', holding);
			fs.mkdirSync(path.join(holding, 'docs'));
			fs.writeFileSync(path.join(holding, 'docs', '.keep'), '');
			git(holding, 'add', '.');
			git(holding, 'commit', '-q', '-m', 'docs');
			git(repo, 'worktree', 'add', '-q', '--detach', detached);
			const { worktrees, idOf } = await windowWith([repo, plain, opened, path.join(holding, 'docs')]);
			const refused = (name: string) => ({ outcome: `invalid_argument {"kind":"not_deletable","name":"${name}"}`, closed: 0 });

			assert.deepStrictEqual([
				await removed(worktrees, idOf(repo)),
				await removed(worktrees, idOf(plain)),
				await removed(worktrees, idOf(opened)),
				await removed(worktrees, idOf(holding)),
				await removed(worktrees, 'loc-0000000000000000')
			], [refused('main'), refused('plain'), refused('opened'), refused('holding'), { outcome: 'invalid_argument {"kind":"no_location","id":"loc-0000000000000000"}', closed: 0 }]);
			assert.ok([repo, plain, opened, holding].every(each => fs.existsSync(each)));
			assert.deepStrictEqual(await removed(worktrees, idOf(detached)), { outcome: 'fulfilled', closed: 1 });
			assert.ok(!fs.existsSync(detached));
		});
	});
});
