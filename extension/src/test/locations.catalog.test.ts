/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { buildCatalog, CatalogInput, FolderFacts, isDeletableWorktree, locationIdOf, RepositoryFacts, WorktreeFacts } from '../core/locations/catalog';
import { Catalog, Location, WorkspaceFolderInfo } from '../core/ports';

const REMOTE = 'vscode-remote://ssh-remote+box';

function folderInfo(index: number, folderPath: string, name = folderPath.split('/').pop() ?? folderPath): WorkspaceFolderInfo {
	return { index, name, uri: `${REMOTE}${folderPath}`, path: folderPath };
}

/** A folder whose key is its path, in the checkout at `root` of `repository`, or a plain folder. */
function folder(index: number, folderPath: string, checkout?: { root: string; repository: string }, more: Partial<FolderFacts> = {}): FolderFacts {
	return { folder: folderInfo(index, folderPath), key: folderPath, git: 'ok', ...(checkout ? { checkout: { rootKey: checkout.root, repository: checkout.repository } } : {}), ...more };
}

function worktree(worktreePath: string, more: Partial<WorktreeFacts> = {}): WorktreeFacts {
	return { path: worktreePath, key: worktreePath, main: false, detached: false, ...more };
}

/** `/w/repo` on main, with worktrees on `zeta`, `alpha` and a detached one, one of them outside the folder. */
const REPO: RepositoryFacts = {
	git: 'ok',
	worktrees: [
		worktree('/w/repo', { main: true, branch: 'main' }),
		worktree('/w/repo.worktrees/zeta', { branch: 'zeta' }),
		worktree('/elsewhere/alpha', { branch: 'alpha' }),
		worktree('/w/repo.worktrees/loose', { detached: true })
	]
};

function catalogInput(folders: readonly FolderFacts[]): CatalogInput {
	return {
		environment: 'ssh-remote',
		folders,
		repositories: new Map([['/w/repo/.git', REPO]]),
		// The fake editor derives a URI by putting the path under the folder URI's scheme and authority
		uriOf: (folderUri, location) => `${folderUri.split('/', 3).join('/')}${location}`
	};
}

function catalog(folders: readonly FolderFacts[], more: Partial<CatalogInput> = {}): Catalog {
	return buildCatalog({ ...catalogInput(folders), ...more });
}

const rows = (locations: readonly Location[]) => locations.map(each => `${each.label} ${each.path}${each.opened ? ' (opened)' : ''}`);

suite('Locations: one catalog per window (WORKTREES-1.2; VERIFICATION J03)', () => {

	test('a plain folder is a location as it is: labeled by its folder name, with its original URI, no Git facts', () => {
		const plain = catalog([folder(0, '/w/notes', undefined, { git: 'none', folder: folderInfo(0, '/w/notes', 'My Notes') })]);

		assert.deepStrictEqual(plain.locations, [{
			id: locationIdOf('ssh-remote', '/w/notes'), path: '/w/notes', uri: `${REMOTE}/w/notes`, environment: 'ssh-remote', label: 'My Notes',
			folders: [folderInfo(0, '/w/notes', 'My Notes')], kind: 'folder', opened: true, git: 'none'
		}]);
		assert.strictEqual(plain.pending, false);
	});

	test('the opened main checkout comes first, then every registered worktree - from any tool, outside the folder too - by label; a detached HEAD gets no invented branch', () => {
		const listed = catalog([folder(0, '/w/repo', { root: '/w/repo', repository: '/w/repo/.git' })]).locations;

		assert.deepStrictEqual(rows(listed), ['main /w/repo (opened)', 'alpha /elsewhere/alpha', 'loose /w/repo.worktrees/loose', 'zeta /w/repo.worktrees/zeta']);
		assert.deepStrictEqual(listed.map(each => [each.kind, each.isMain, each.branch, each.detached]), [
			['checkout', true, 'main', false], ['checkout', false, 'alpha', false], ['checkout', false, undefined, true], ['checkout', false, 'zeta', false]
		]);
		// A worktree outside the folder keeps the window's remote authority: its URI is derived from the folder's
		assert.strictEqual(listed[1].uri, `${REMOTE}/elsewhere/alpha`);
	});

	test('an opened worktree is first in its folder, its main checkout elsewhere second, then the others', () => {
		const listed = catalog([folder(0, '/w/repo.worktrees/zeta', { root: '/w/repo.worktrees/zeta', repository: '/w/repo/.git' })]).locations;

		assert.deepStrictEqual(rows(listed), ['zeta /w/repo.worktrees/zeta (opened)', 'main /w/repo', 'alpha /elsewhere/alpha', 'loose /w/repo.worktrees/loose']);
		assert.deepStrictEqual([listed[0].isMain, listed[1].isMain], [false, true]);
	});

	test('an opened subfolder stays the first location, named by its folder, on its checkout\'s branch; the checkout itself follows', () => {
		const listed = catalog([folder(0, '/w/repo/packages/app', { root: '/w/repo', repository: '/w/repo/.git' })]).locations;

		assert.deepStrictEqual(rows(listed).slice(0, 2), ['app /w/repo/packages/app (opened)', 'main /w/repo']);
		assert.deepStrictEqual([listed[0].kind, listed[0].branch, listed[0].isMain], ['checkout', 'main', false]);
	});

	test('a physical path is listed once - an opened folder under its own folder - and keeps every folder association', () => {
		const listed = catalog([
			folder(0, '/w/repo', { root: '/w/repo', repository: '/w/repo/.git' }),
			folder(1, '/w/repo.worktrees/zeta', { root: '/w/repo.worktrees/zeta', repository: '/w/repo/.git' })
		]).locations;

		assert.deepStrictEqual(rows(listed), ['main /w/repo (opened)', 'alpha /elsewhere/alpha', 'loose /w/repo.worktrees/loose', 'zeta /w/repo.worktrees/zeta (opened)']);
		assert.deepStrictEqual(listed.map(each => each.folders.map(info => info.index)), [[0, 1], [0, 1], [0, 1], [1, 0]]);
	});

	test('one directory opened twice - through a link, or in another case where the platform ignores case - is one location: identity is its canonical key', () => {
		const twice = catalog([
			{ folder: folderInfo(0, '/w/link-to-notes'), key: '/w/notes', git: 'none' },
			{ folder: folderInfo(1, '/W/Notes'), key: '/w/notes', git: 'none' }
		]);

		assert.deepStrictEqual(twice.locations.map(each => [each.id, each.path, each.folders.length]), [[locationIdOf('ssh-remote', '/w/notes'), '/w/link-to-notes', 2]]);
	});

	test('an ID is the same on every build and differs by environment; a branch never enters it', () => {
		const input = [folder(0, '/w/repo', { root: '/w/repo', repository: '/w/repo/.git' })];
		const first = catalog(input).locations.map(each => each.id);
		const renamed = catalog(input, { repositories: new Map([['/w/repo/.git', { git: 'ok', worktrees: REPO.worktrees.map(each => ({ ...each, branch: `${each.branch}-renamed` })) }]]) });

		assert.deepStrictEqual(catalog(input).locations.map(each => each.id), first);
		assert.deepStrictEqual(renamed.locations.map(each => each.id), first);
		assert.notStrictEqual(catalog(input, { environment: 'local' }).locations[0].id, first[0]);
		assert.match(first[0], /^loc-[0-9a-f]{16}$/);
	});

	test('folders keep editor order, mixed plain folders and repositories alike (PRODUCT-5.5)', () => {
		const listed = catalog([folder(0, '/w/notes', undefined, { git: 'missing' }), folder(1, '/w/repo', { root: '/w/repo', repository: '/w/repo/.git' })]).locations;

		assert.deepStrictEqual(listed.map(each => [each.path, each.folders[0].index, each.git]).slice(0, 2), [['/w/notes', 0, 'missing'], ['/w/repo', 1, 'ok']]);
	});

	test('what is still being read is pending, what a failed read kept is stale - each worktree on its own facts', () => {
		const pending = catalog([folder(0, '/w/repo', { root: '/w/repo', repository: '/w/repo/.git' }, { git: 'pending' })]);
		const stale = catalog([folder(0, '/w/repo', { root: '/w/repo', repository: '/w/repo/.git' })], {
			repositories: new Map([['/w/repo/.git', { git: 'ok', worktrees: [REPO.worktrees[0], { ...REPO.worktrees[1], stale: true }] }]])
		});

		assert.strictEqual(pending.pending, true);
		assert.deepStrictEqual(stale.locations.map(each => each.git), ['ok', 'stale']);
		assert.strictEqual(stale.pending, false);
	});

	test('one rule says which worktree may be deleted, by canonical keys: a linked one no workspace folder opened or is in (WORKTREES-3.2, D73)', () => {
		const linked = { id: 'loc-l', path: '/Work/App.worktrees/Fix', uri: 'file:///Work/App.worktrees/Fix', environment: 'local', label: 'fix', kind: 'checkout', isMain: false, opened: false, git: 'ok', folders: [] } as unknown as Location;
		// A case-folding file system: the opened folder names the worktree in other letters
		const keyOf = (path: string) => path.toLowerCase();
		const folder = (path: string): WorkspaceFolderInfo => ({ index: 0, name: 'x', uri: `file://${path}`, path });
		assert.deepStrictEqual([
			isDeletableWorktree(linked, [folder('/work/app')], keyOf),
			isDeletableWorktree(linked, [folder('/work/app.worktrees/fix/src')], keyOf),
			isDeletableWorktree({ ...linked, isMain: true }, [], keyOf),
			isDeletableWorktree({ ...linked, opened: true }, [], keyOf),
			isDeletableWorktree({ ...linked, kind: 'folder' } as Location, [], keyOf)
		], [true, false, false, false, false]);
	});
});
