/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { folderKeyOf } from '../base/files';
import { locationIdOf } from '../core/locations/catalog';
import { LocationRemoval, WorkspaceFolderInfo } from '../core/ports';
import { Checkout, checkoutOf, GitError, ListedWorktree, worktreesOf } from '../host/locations/gitRead';
import { KnownLocations, LocationRefreshError, LocationService, LocationServiceDeps, PathState } from '../host/locations/service';
import { tempDir } from './util';

const COMMON = '/w/repo/.git';
const MAIN = '/w/repo';
const FEAT = '/w/repo.worktrees/feat';
const FIX = '/x/fix';
const NOTES = '/w/notes';

const id = (location: string) => locationIdOf('local', location);
const settled = () => new Promise(resolve => setTimeout(resolve, 20));

function listed(worktreePath: string, more: Partial<ListedWorktree> = {}): ListedWorktree {
	return { path: worktreePath, main: false, bare: false, detached: false, locked: false, prunable: false, ...more };
}

/** A disk, a Git and an editor as the service sees them: paths are their own canonical keys. */
class World {
	folders: WorkspaceFolderInfo[] = [];
	readonly present = new Set<string>([MAIN, FEAT, FIX, NOTES]);
	/** Paths whose probe gets no answer, as a permission error gives none. */
	readonly unanswered = new Set<string>();
	readonly checkouts = new Map<string, Checkout | Error>([
		[MAIN, { root: MAIN, gitDir: COMMON, commonDir: COMMON }],
		[FEAT, { root: FEAT, gitDir: `${COMMON}/worktrees/feat`, commonDir: COMMON }]
	]);
	readonly lists = new Map<string, readonly ListedWorktree[] | Error>([[COMMON, [listed(MAIN, { main: true, branch: 'main' }), listed(FEAT, { branch: 'feat' }), listed(FIX, { detached: true })]]]);
	executable: string | undefined = 'git';
	readonly calls: string[] = [];
	/** Holds every Git read while set. */
	gate: Promise<void> | undefined;
	readonly log: string[] = [];
	readonly known: KnownLocations & { value: unknown } = {
		value: undefined,
		get() { return this.value; },
		// As workspace storage keeps it: JSON
		set(state) { this.value = JSON.parse(JSON.stringify(state)); }
	};
	private readonly folderListeners = new Set<() => void>();
	private readonly watchers = new Map<string, () => void>();

	setFolders(...paths: string[]): void {
		this.folders = paths.map((each, index) => ({ index, name: path.posix.basename(each), uri: `file://${each}`, path: each }));
		this.folderListeners.forEach(listener => listener());
	}

	fireGit(commonDir: string): void {
		this.watchers.get(commonDir)?.();
	}

	deps(more: Partial<LocationServiceDeps> = {}): LocationServiceDeps {
		return {
			environment: 'local',
			folders: {
				folders: () => this.folders,
				onDidChange: listener => {
					this.folderListeners.add(listener);
					return { dispose: () => this.folderListeners.delete(listener) };
				}
			},
			git: {
				executable: async () => this.executable,
				checkoutOf: async (_git, folder) => {
					this.calls.push(`checkout ${folder}`);
					await this.gate;
					const answer = this.checkouts.get(folder);
					if (answer instanceof Error) {
						throw answer;
					}
					return answer;
				},
				worktreesOf: async (_git, commonDir) => {
					this.calls.push(`list ${commonDir}`);
					await this.gate;
					const answer = this.lists.get(commonDir) ?? new GitError('fatal: not a git repository', 128);
					if (answer instanceof Error) {
						throw answer;
					}
					return answer;
				}
			},
			watch: (commonDir, _folder, onEvent) => {
				this.watchers.set(commonDir, onEvent);
				return { dispose: () => this.watchers.delete(commonDir) };
			},
			uriOf: (_folderUri, location) => `file://${location}`,
			known: this.known,
			log: { event: text => this.log.push(text) },
			keyOf: location => location,
			probe: async (location): Promise<PathState> => this.unanswered.has(location) ? 'unknown' : this.present.has(location) ? 'present' : 'missing',
			isDirectory: location => this.present.has(location),
			eventDelayMs: 0,
			...more
		};
	}
}

/** A service whose removals are collected from the moment it exists. */
function serviceIn(world: World, more: Partial<LocationServiceDeps> = {}): { service: LocationService; removals: LocationRemoval[] } {
	const service = new LocationService(world.deps(more));
	const removals: LocationRemoval[] = [];
	service.onDidRemove(removal => removals.push(removal));
	return { service, removals };
}

const rows = (service: LocationService) => service.snapshot().locations.map(each => `${each.label} ${each.path} ${each.kind} ${each.git}`);

suite('Locations: the window\'s location service (WORKTREES-1, 3; RULES-2.4)', () => {

	let world: World;
	let services: LocationService[];

	setup(() => {
		world = new World();
		services = [];
	});

	teardown(() => {
		services.forEach(each => each.dispose());
	});

	function start(more: Partial<LocationServiceDeps> = {}): { service: LocationService; removals: LocationRemoval[] } {
		const started = serviceIn(world, more);
		services.push(started.service);
		return started;
	}

	test('workspace folders are usable locations at once, while Git is still read and without it; Git metadata follows (WORKTREES-1.1; J01)', async () => {
		world.setFolders(NOTES, MAIN);
		let release = () => { };
		world.gate = new Promise(resolve => release = resolve);
		const { service } = start();

		assert.deepStrictEqual(rows(service), [`notes ${NOTES} folder pending`, `repo ${MAIN} folder pending`]);
		assert.strictEqual(service.snapshot().pending, true);
		assert.strictEqual(service.resolve(id(NOTES))?.path, NOTES);
		release();
		await service.refresh();

		assert.deepStrictEqual(rows(service), [`notes ${NOTES} folder none`, `main ${MAIN} checkout ok`, `feat ${FEAT} checkout ok`, `fix ${FIX} checkout ok`]);
		assert.strictEqual(service.snapshot().pending, false);
	});

	test('missing Git is normal: every folder a plain one, and no error for anyone (WORKTREES-1.1)', async () => {
		world.setFolders(MAIN);
		world.executable = undefined;
		const { service } = start();
		await service.refresh();

		assert.deepStrictEqual(rows(service), [`repo ${MAIN} folder missing`]);
		assert.deepStrictEqual(world.log, []);
	});

	test('a failed read keeps what was known, stale, removes nothing and goes to whoever asked - a Git event\'s to the log only (WORKTREES-1.1, 1.3; W06)', async () => {
		world.setFolders(MAIN);
		const { service, removals } = start();
		await service.refresh();
		world.lists.set(COMMON, new GitError('fatal: unable to read tree 1234', 128));

		await assert.rejects(service.refresh(), (err: unknown) => err instanceof LocationRefreshError && err.failures.length === 1 && err.failures[0].message === 'fatal: unable to read tree 1234');
		assert.deepStrictEqual(rows(service), [`main ${MAIN} checkout stale`, `feat ${FEAT} checkout stale`, `fix ${FIX} checkout stale`]);
		world.checkouts.set(MAIN, new GitError('fatal: bad config line 1', 128));
		world.fireGit(COMMON);
		await settled();

		assert.deepStrictEqual(removals, []);
		assert.ok(world.log.some(line => line.includes('fatal: unable to read tree 1234')));
		await assert.rejects(service.refresh(), /bad config line 1/);
		assert.deepStrictEqual(rows(service).map(row => row.split(' ').pop()), ['stale', 'stale', 'stale']);
	});

	test('a worktree is deleted only when a successful read no longer lists it - or lists it prunable - and its root does not exist (WORKTREES-1.3, 3.3; W05)', async () => {
		world.setFolders(MAIN);
		const { service, removals } = start();
		await service.refresh();
		// Unregistered while its directory is still there: kept, stale
		world.lists.set(COMMON, [listed(MAIN, { main: true, branch: 'main' }), listed(FIX, { detached: true })]);
		await service.refresh();
		assert.deepStrictEqual(rows(service), [`main ${MAIN} checkout ok`, `feat ${FEAT} checkout stale`, `fix ${FIX} checkout ok`]);
		// Its root unanswerable, as a permission error leaves it: still no deletion
		world.present.delete(FEAT);
		world.unanswered.add(FEAT);
		await service.refresh();
		assert.deepStrictEqual(removals, []);
		// Its root gone: confirmed
		world.unanswered.delete(FEAT);
		await service.refresh();
		assert.deepStrictEqual(removals, [{ ids: [id(FEAT)], cause: 'deleted' }]);
		// Listed prunable with its root gone: confirmed as well
		world.lists.set(COMMON, [listed(MAIN, { main: true, branch: 'main' }), listed(FIX, { detached: true, prunable: true })]);
		world.present.delete(FIX);
		world.fireGit(COMMON);
		await settled();

		assert.deepStrictEqual(removals, [{ ids: [id(FEAT)], cause: 'deleted' }, { ids: [id(FIX)], cause: 'deleted' }]);
		assert.deepStrictEqual(rows(service), [`main ${MAIN} checkout ok`]);
	});

	test('an opened worktree that Git deletes closes its agents; the folder stays as a plain folder, its workspace root untouched (WORKTREES-3.3)', async () => {
		world.setFolders(FEAT);
		const { service, removals } = start();
		await service.refresh();
		assert.deepStrictEqual(rows(service), [`feat ${FEAT} checkout ok`, `main ${MAIN} checkout ok`, `fix ${FIX} checkout ok`]);
		world.lists.set(COMMON, [listed(MAIN, { main: true, branch: 'main' }), listed(FIX, { detached: true })]);
		world.present.delete(FEAT);
		world.fireGit(COMMON);
		await settled();

		assert.deepStrictEqual(removals, [{ ids: [id(FEAT)], cause: 'deleted' }]);
		assert.deepStrictEqual(rows(service), [`feat ${FEAT} folder none`]);
		assert.strictEqual(service.resolve(id(FEAT)), undefined);
	});

	test('removing a workspace folder reports its locations at once; a location another folder still has stays (RULES-2.4; W05)', async () => {
		world.setFolders(MAIN, FEAT, NOTES);
		const { service, removals } = start();
		await service.refresh();
		world.setFolders(MAIN, NOTES);

		assert.deepStrictEqual(removals, []);
		assert.ok(service.resolve(id(FEAT)));
		world.setFolders(NOTES);

		assert.deepStrictEqual(removals, [{ ids: [id(MAIN), id(FEAT), id(FIX)], cause: 'folder' }]);
		assert.deepStrictEqual(rows(service), [`notes ${NOTES} folder none`]);
		assert.strictEqual(service.removalOf(id(FEAT)), 'folder');
	});

	test('an added folder is listed at once, its Git metadata after; nothing is read while nothing happens; a burst of Git events is one read (WORKTREES-1.3)', async () => {
		world.setFolders(NOTES);
		const { service } = start();
		await service.refresh();
		world.setFolders(NOTES, MAIN);
		assert.deepStrictEqual(rows(service), [`notes ${NOTES} folder none`, `repo ${MAIN} folder pending`]);
		await settled();
		assert.strictEqual(rows(service).length, 4);
		const before = world.calls.length;
		await settled();
		assert.strictEqual(world.calls.length, before);
		for (let n = 0; n < 5; n++) {
			world.fireGit(COMMON);
		}
		await settled();

		assert.deepStrictEqual(world.calls.slice(before), [`list ${COMMON}`]);
	});

	test('refreshes asked for during a read share one read after it: reads are coalesced per repository (WORKTREES-1.3)', async () => {
		world.setFolders(MAIN);
		let release = () => { };
		world.gate = new Promise(resolve => release = resolve);
		const { service } = start();
		await Promise.resolve();
		const asked = [service.refresh(), service.refresh(), service.refresh()];
		release();
		await Promise.all(asked);

		assert.deepStrictEqual(world.calls, [`checkout ${MAIN}`, `list ${COMMON}`, `checkout ${MAIN}`, `list ${COMMON}`]);
	});

	test('a reload shows what was known at once, pending, and reports nothing (RULES-2.4)', async () => {
		world.setFolders(MAIN, NOTES);
		const first = start().service;
		await first.refresh();
		first.dispose();
		const { service, removals } = start();

		assert.deepStrictEqual(rows(service), [`main ${MAIN} checkout pending`, `feat ${FEAT} checkout pending`, `fix ${FIX} checkout pending`, `notes ${NOTES} folder pending`]);
		await service.refresh();
		await settled();
		assert.deepStrictEqual(removals, []);
		assert.deepStrictEqual(rows(service), [`main ${MAIN} checkout ok`, `feat ${FEAT} checkout ok`, `fix ${FIX} checkout ok`, `notes ${NOTES} folder none`]);
	});

	test('ARCHITECTURE-4.2: what an earlier build stored of the locations is ignored, never translated, with one line in the agents log; a current record says nothing', async () => {
		world.setFolders(MAIN, NOTES);
		const first = start().service;
		await first.refresh();
		first.dispose();
		const current = world.known.value as { folders: unknown[] };
		const ignored = 'Ignored stored working locations this build does not read, as from an earlier build';
		const said = () => world.log.filter(line => line === ignored).length;
		start().service.dispose();
		const quiet = said();
		world.known.value = { ...current, folders: [...current.folders, { path: '/w/old', label: 'old' }] };
		start().service.dispose();
		const partly = said();
		world.known.value = { locations: [{ path: MAIN }] };
		const { service } = start();
		await service.refresh();

		assert.deepStrictEqual([quiet, partly, said()], [0, 1, 2]);
		assert.deepStrictEqual(rows(service), [`main ${MAIN} checkout ok`, `feat ${FEAT} checkout ok`, `fix ${FIX} checkout ok`, `notes ${NOTES} folder none`]);
	});

	test('a folder removed while no extension host ran - as removing the first one restarts it - is reported on the next activation (RULES-2.4)', async () => {
		world.setFolders(MAIN, NOTES);
		const first = start().service;
		await first.refresh();
		first.dispose();
		world.setFolders(NOTES);
		const { service, removals } = start();
		await settled();

		assert.deepStrictEqual(removals, [{ ids: [id(MAIN), id(FEAT), id(FIX)], cause: 'folder' }]);
		assert.strictEqual(service.removalOf(id(MAIN)), 'folder');
	});

	test('a worktree deleted while no extension host ran is reported once Git confirms it; a failed first read reports nothing (RULES-2.4; W06)', async () => {
		world.setFolders(MAIN);
		const first = start().service;
		await first.refresh();
		first.dispose();
		world.lists.set(COMMON, new GitError('fatal: index file corrupt', 128));
		world.present.delete(FEAT);
		const failing = start();
		await settled();

		assert.deepStrictEqual(failing.removals, []);
		assert.deepStrictEqual(rows(failing.service), [`main ${MAIN} checkout stale`, `feat ${FEAT} checkout stale`, `fix ${FIX} checkout stale`]);
		failing.service.dispose();
		world.lists.set(COMMON, [listed(MAIN, { main: true, branch: 'main' }), listed(FIX, { detached: true })]);
		const { service, removals } = start();
		await settled();

		assert.deepStrictEqual(removals, [{ ids: [id(FEAT)], cause: 'deleted' }]);
		assert.deepStrictEqual(rows(service), [`main ${MAIN} checkout ok`, `fix ${FIX} checkout ok`]);
	});

	test('a location is revalidated on use: one whose directory is gone resolves to nothing, though its folder is still listed (WORKTREES-1.2)', async () => {
		world.setFolders(NOTES);
		const { service } = start();
		await service.refresh();
		world.present.delete(NOTES);

		assert.strictEqual(service.resolve(id(NOTES)), undefined);
		assert.deepStrictEqual(rows(service), [`notes ${NOTES} folder none`]);
	});
});

suite('Locations: the service on a real disk and Git (WORKTREES-1.2, 1.3; VERIFICATION J03, W05)', () => {

	let temp: { dir: string; remove(): void };
	let service: LocationService | undefined;

	setup(() => {
		temp = tempDir('fd-locations-');
	});

	teardown(() => {
		service?.dispose();
		temp.remove();
	});

	test('a main checkout opened through a link - and in another case where the platform ignores it - is one location with the real path\'s identity; Git\'s own removal of an opened worktree is a confirmed deletion', async () => {
		const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, stdio: 'pipe' });
		const repo = path.join(temp.dir, 'repo');
		const feat = path.join(temp.dir, 'repo.worktrees', 'feat');
		git(temp.dir, 'init', '-q', '-b', 'main', repo);
		git(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
		git(repo, 'worktree', 'add', '-q', '-b', 'feat', feat);
		const link = path.join(temp.dir, 'link');
		fs.symlinkSync(repo, link, 'dir');
		const caseBlind = process.platform === 'darwin' || process.platform === 'win32';
		const opened = [link, feat, ...(caseBlind ? [path.join(temp.dir, 'REPO')] : [])];
		const world = new World();
		world.setFolders(...opened);
		// Real Git and the real disk: canonical keys, probes and directory checks are the service's own
		const started = new LocationService(world.deps({ git: { executable: async () => 'git', checkoutOf, worktreesOf }, keyOf: undefined, probe: undefined, isDirectory: undefined }));
		service = started;
		const removals: LocationRemoval[] = [];
		started.onDidRemove(removal => removals.push(removal));
		await started.refresh();

		assert.deepStrictEqual(started.snapshot().locations.map(each => [each.path, each.label, each.isMain, each.opened, each.folders.length]), [
			[link, 'main', true, true, caseBlind ? 3 : 2],
			// The case variant opens the same repository, so its worktree belongs to that folder too
			[feat, 'feat', false, true, caseBlind ? 3 : 2]
		]);
		assert.strictEqual(started.snapshot().locations[0].id, locationIdOf('local', folderKeyOf(repo)));
		git(repo, 'worktree', 'remove', feat);
		await started.refresh();

		assert.deepStrictEqual(removals, [{ ids: [locationIdOf('local', folderKeyOf(feat))], cause: 'deleted' }]);
		assert.deepStrictEqual(started.snapshot().locations.map(each => [each.path, each.kind]), [[link, 'checkout'], [feat, 'folder']]);
	});
});
