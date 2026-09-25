/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ObjectTree } from '../../../../../base/browser/ui/tree/objectTree.js';
import { IObjectTreeElement } from '../../../../../base/browser/ui/tree/tree.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMenuService, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, ContextKeyValue, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { NEW_WORKTREE_COMMAND, WorkspaceBarRowKindContext, WorkspaceBarRowToolbar } from '../../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarRepository, IWorkspaceBarWorktree, WorkspaceBarGit, WorkspaceBarGroup } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { moveRow, orderWorktrees, rowsOfFolders } from '../../../../browser/parts/workspacebar/workspaceBar.js';
import { WorkspaceBarModel } from '../../../../browser/parts/workspacebar/workspaceBarModel.js';
import { WorkspaceBarSwitcher } from '../../../../browser/parts/workspacebar/workspaceBarSwitcher.js';
import { carriesMark, isOnWorktreeOf, WorkspaceBarIdentityProvider, workspaceBarRows, WorkspaceBarRow, WorkspaceBarView } from '../../../../browser/parts/workspacebar/workspaceBarView.js';
import { TestStorageService } from '../../../common/workbenchTestServices.js';
import { workbenchInstantiationService } from '../../workbenchTestServices.js';

suite('Workspace bar - the rows it draws', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const key = (uri: URI) => uri.toString();

	function folder(path: string, index = 0): IWorkspaceFolder {
		return new WorkspaceFolder({ uri: URI.file(path), index, name: path.slice(path.lastIndexOf('/') + 1) });
	}

	function worktree(path: string, label: string, member?: IWorkspaceFolder): IWorkspaceBarWorktree {
		return { uri: URI.file(path), branch: label, label, exists: true, folder: member };
	}

	/** One line per row, a worktree indented under its repository; `+` where the row offers a worktree. */
	function summary(rows: IObjectTreeElement<WorkspaceBarRow>[]): string[] {
		return rows.flatMap(row => {
			const element = row.element;
			const line = element.kind === 'folder'
				? `${element.repository ? 'repository' : 'folder'} ${element.uri.path}${element.folder ? '' : ' (not in the workspace)'}${element.offersWorktree ? ' +' : ''}`
				: '?';
			const children = [...(row.children ?? [])] as IObjectTreeElement<WorkspaceBarRow>[];
			return [line, ...children.map(child => child.element.kind === 'worktree' ? `  worktree ${child.element.worktree.label}` : '?')];
		});
	}

	const notes = folder('/notes');
	const lab = folder('/lab', 1);
	const w2 = folder('/wt/w2', 2);
	const fix = folder('/wt/fix', 3);
	const groups: WorkspaceBarGroup[] = [
		{ kind: 'folder', folder: notes },
		{ kind: 'repository', main: URI.file('/lab'), folder: lab, branch: 'main', members: [lab, w2], worktrees: [worktree('/wt/w2', 'w2', w2), worktree('/wt/w10', 'w10')] },
		{ kind: 'repository', main: URI.file('/api'), folder: undefined, branch: 'main', members: [fix], worktrees: [worktree('/wt/fix', 'fix', fix)] },
	];

	test('a repository opens onto its worktrees; a plain folder has none; every folder offers one', () => {
		const rows = workspaceBarRows({ folders: [notes, lab, w2, fix], groups, worktrees: true, key });

		assert.deepStrictEqual(summary(rows), [
			'folder /notes +',
			'repository /lab +',
			'  worktree w2',
			'  worktree w10',
			'repository /api (not in the workspace) +',
			'  worktree fix',
		]);
	});

	test('a repository with no worktrees has nothing under it, and offers the first on its row', () => {
		const solo = folder('/solo');
		const rows = workspaceBarRows({
			folders: [solo],
			groups: [{ kind: 'repository', main: URI.file('/solo'), folder: solo, branch: 'main', members: [solo], worktrees: [] }],
			worktrees: true,
			key
		});

		assert.deepStrictEqual(summary(rows), [
			'repository /solo +',
		]);
	});

	test('folders[] ahead of git\'s last read: a folder that left is not drawn, one that joined is where git\'s records put it, and one they do not name is at the end', () => {
		// `notes` has left, and `/wt/fix` with it - at the last read, all of `/api` in the workspace. Since
		// then `/wt/w10`, a worktree git records for `/lab`, has joined, and so has `/api` itself; git's
		// records name `fresh` nowhere.
		const fresh = folder('/fresh', 4);
		const w10 = folder('/wt/w10', 5);
		const api = folder('/api', 6);
		const ahead = workspaceBarRows({ folders: [lab, w2, fresh, w10, api], groups, worktrees: true, key });
		// Switched on: nothing is read yet.
		const switchedOn = workspaceBarRows({ folders: [notes, lab], groups: [], worktrees: true, key });

		assert.deepStrictEqual({
			ahead: summary(ahead),
			worktreesInTheWorkspace: ahead.flatMap(row => [...(row.children ?? [])]).flatMap(child => child.element.kind === 'worktree' && child.element.worktree.folder ? [child.element.worktree.folder.uri.path] : []),
			switchedOn: summary(switchedOn)
		}, {
			ahead: ['repository /lab +', '  worktree w2', '  worktree w10', 'repository /api +', '  worktree fix', 'folder /fresh +'],
			worktreesInTheWorkspace: ['/wt/w2', '/wt/w10'],
			switchedOn: ['folder /notes +', 'folder /lab +'],
		});
	});

	test('a worktree being deleted has no row, and its folder is not drawn at the end either; a repository with nothing else in the workspace goes with it', () => {
		// Both still in folders[]; `fix` is all of `/api` the workspace has.
		const rows = workspaceBarRows({ folders: [notes, lab, w2, fix], groups, worktrees: true, key, leaving: uri => ['/wt/w2', '/wt/fix'].includes(uri.path) });

		assert.deepStrictEqual(summary(rows), [
			'folder /notes +',
			'repository /lab +',
			'  worktree w10',
		]);
	});

	test('a repository added under two spellings is one row: each of its folders is on it, and on no other', () => {
		const link = folder('/link-lab', 4);
		const rows = workspaceBarRows({
			folders: [lab, link],
			groups: [{ kind: 'repository', main: lab.uri, folder: lab, branch: 'main', members: [lab, link], worktrees: [] }],
			worktrees: true,
			key
		});

		assert.deepStrictEqual(summary(rows), ['repository /lab +']);
	});

	test('switched off, or before git has been read, the bar is folders[] exactly, and offers none', () => {
		const rows = workspaceBarRows({ folders: [notes, lab, w2], groups, worktrees: false, key });

		assert.deepStrictEqual(summary(rows), [
			'folder /notes',
			'folder /lab',
			'folder /wt/w2',
		]);
	});

	test('a repository without worktrees neither opens nor closes, and its next first worktree shows', () => {
		// A real tree, because it is the tree that keeps a row's node, and whether it is closed, across
		// a rebuild by its id: a repository closed before its last worktree went kept `collapsed`, which a
		// row that cannot open never loses - and the first worktree made after arrived hidden.
		const tree = store.add(new ObjectTree<WorkspaceBarRow>('WorkspaceBarTest', mainWindow.document.createElement('div'),
			{ getHeight: () => 28, getTemplateId: () => 'row' },
			[{ templateId: 'row', renderTemplate: () => undefined, renderElement: () => { }, disposeTemplate: () => { } }],
			{ identityProvider: new WorkspaceBarIdentityProvider(key) }));

		const repository = (worktrees: IWorkspaceBarWorktree[]): WorkspaceBarGroup[] => [{ kind: 'repository', main: URI.file('/lab'), folder: lab, branch: 'main', members: [lab, ...worktrees.flatMap(worktree => worktree.folder ? [worktree.folder] : [])], worktrees }];
		const row = () => tree.getNode().children[0];
		const state = () => ({ collapsible: row().collapsible, collapsed: row().collapsed });

		tree.setChildren(null, workspaceBarRows({ folders: [lab], groups: repository([worktree('/wt/w2', 'w2')]), worktrees: true, key }));
		tree.collapse(row().element!);
		const closed = state();

		tree.setChildren(null, workspaceBarRows({ folders: [lab], groups: repository([]), worktrees: true, key }));
		const empty = state();

		tree.setChildren(null, workspaceBarRows({ folders: [lab], groups: repository([worktree('/wt/w3', 'w3')]), worktrees: true, key }));

		assert.deepStrictEqual({ closed, empty, next: state() }, {
			closed: { collapsible: true, collapsed: true },
			empty: { collapsible: false, collapsed: false },
			next: { collapsible: true, collapsed: false },
		});
	});

	test('the rows over folders[]: a repository\'s folders on one row, where the first of them is; any other folder on its own', () => {
		const [a, repo, one, c, api, fix] = ['/a', '/repo', '/wt/one', '/c', '/api', '/wt/fix'].map(path => URI.file(path));
		const repositoryOf = (folder: URI) => [repo, one].some(member => key(member) === key(folder)) ? repo : key(folder) === key(fix) ? api : undefined;

		assert.deepStrictEqual(rowsOfFolders([a, one, repo, c, fix], repositoryOf, key).map(row => ({ uri: row.uri.path, folders: row.folders.map(folder => folder.path) })), [
			{ uri: '/a', folders: ['/a'] },
			{ uri: '/repo', folders: ['/wt/one', '/repo'] },
			{ uri: '/c', folders: ['/c'] },
			{ uri: '/api', folders: ['/wt/fix'] },
		]);
	});

	test('moving a repository\'s row takes its worktrees in the workspace with it, past the whole of the next row', () => {
		const [a, repo, one, c, api, fix] = ['/a', '/repo', '/wt/one', '/c', '/api', '/wt/fix'].map(path => URI.file(path));
		// A repository's row is where its first folder is; `/api`'s main checkout is not in the workspace.
		const rows = [{ uri: a, folders: [a] }, { uri: repo, folders: [repo, one] }, { uri: c, folders: [c] }, { uri: api, folders: [fix] }];
		const paths = (order: URI[] | undefined) => order?.map(uri => uri.path);

		assert.deepStrictEqual({
			down: paths(moveRow(rows, repo, 1, key)),
			upByItsWorktree: paths(moveRow(rows, one, -1, key)),
			repositoryNotInTheWorkspace: paths(moveRow(rows, api, -1, key)),
			pastTheEnd: moveRow(rows, a, -1, key),
		}, {
			down: ['/a', '/c', '/repo', '/wt/one', '/wt/fix'],
			upByItsWorktree: ['/repo', '/wt/one', '/a', '/c', '/wt/fix'],
			repositoryNotInTheWorkspace: ['/a', '/repo', '/wt/one', '/wt/fix', '/c'],
			pastTheEnd: undefined,
		});
	});

	test('the mark: a row\'s own folder, and a repository standing in for a worktree that cannot be seen', () => {
		const [, repository, worktreeRow] = workspaceBarRows({ folders: [notes, lab, w2], groups, worktrees: true, key })
			.flatMap(row => [row, ...([...(row.children ?? [])] as IObjectTreeElement<WorkspaceBarRow>[])])
			.map(row => row.element);

		const onW2 = URI.file('/wt/w2');
		assert.deepStrictEqual({
			'worktree row, window on it': carriesMark(worktreeRow, onW2, false, key),
			'repository row, its worktree visible': carriesMark(repository, onW2, false, key),
			'repository row, its worktree hidden': carriesMark(repository, onW2, true, key),
			'repository row, window on the repository': carriesMark(repository, URI.file('/lab'), false, key),
			'repository row, window elsewhere, hidden': carriesMark(repository, URI.file('/notes'), true, key),
			'no folder at all': carriesMark(repository, undefined, true, key),
		}, {
			'worktree row, window on it': true,
			'repository row, its worktree visible': false,
			'repository row, its worktree hidden': true,
			'repository row, window on the repository': true,
			'repository row, window elsewhere, hidden': false,
			'no folder at all': false,
		});
	});

	test('worktrees are in the order they were made until somebody moves one; then theirs come first, and new ones after', () => {
		const [w2, w10, fix, fresh] = ['/wt/w2', '/wt/w10', '/wt/fix', '/wt/new'].map(path => URI.file(path));
		const made = [fix, w2, w10];   // as the reader gives them, oldest first
		const moved = [w10, fix, w2];
		const order = (items: URI[], placed: URI[] | undefined) => orderWorktrees(items, placed, uri => uri, key).map(uri => uri.path);

		assert.deepStrictEqual({
			'never moved': order(made, undefined),
			'moved': order(made, moved),
			'one made since': order([...made, fresh], moved),
			'one deleted since': order([fix, w2], moved),
		}, {
			'never moved': ['/wt/fix', '/wt/w2', '/wt/w10'],
			'moved': ['/wt/w10', '/wt/fix', '/wt/w2'],
			'one made since': ['/wt/w10', '/wt/fix', '/wt/w2', '/wt/new'],
			'one deleted since': ['/wt/fix', '/wt/w2'],
		});
	});

	test('closing a repository sends the window to it only when the window is on a worktree the close hides', () => {
		const [notesRow, repository, worktreeRow] = workspaceBarRows({ folders: [notes, lab, w2], groups, worktrees: true, key })
			.flatMap(row => [row, ...([...(row.children ?? [])] as IObjectTreeElement<WorkspaceBarRow>[])])
			.map(row => row.element);

		assert.deepStrictEqual({
			'on its worktree': isOnWorktreeOf(repository, URI.file('/wt/w2'), key),
			'on the repository itself': isOnWorktreeOf(repository, URI.file('/lab'), key),
			'on another folder': isOnWorktreeOf(repository, URI.file('/notes'), key),
			'a plain folder': isOnWorktreeOf(notesRow, URI.file('/notes'), key),
			'a worktree row': isOnWorktreeOf(worktreeRow, URI.file('/wt/w2'), key),
			'no folder at all': isOnWorktreeOf(repository, undefined, key),
		}, {
			'on its worktree': true,
			'on the repository itself': false,
			'on another folder': false,
			'a plain folder': false,
			'a worktree row': false,
			'no folder at all': false,
		});
	});
});

suite('Workspace bar - the view', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const key = (uri: URI) => uri.toString();
	const lab = new WorkspaceFolder({ uri: URI.file('/lab'), index: 0, name: 'lab' });
	const notes = new WorkspaceFolder({ uri: URI.file('/notes'), index: 1, name: 'notes' });
	const w2 = new WorkspaceFolder({ uri: URI.file('/wt/w2'), index: 2, name: 'w2' });

	function repository(worktreeFolder: IWorkspaceFolder | undefined): IWorkspaceBarRepository {
		return { kind: 'repository', main: lab.uri, folder: lab, branch: 'main', members: worktreeFolder ? [lab, worktreeFolder] : [lab], worktrees: [{ uri: URI.file('/wt/w2'), branch: 'w2', label: 'w2', exists: true, folder: worktreeFolder }] };
	}

	/**
	 * The bar's view over `groups`, with the window on `active` and `contextKeys` set: what it asked the
	 * commands and the switcher to do, and its rows as a screen reader hears them.
	 */
	function view(folders: IWorkspaceFolder[], groups: WorkspaceBarGroup[], active: URI, names = new Map<string, string>(), contextKeys: Record<string, ContextKeyValue> = {}, storage?: IStorageService) {
		// Real context keys and menus: what a row's toolbar offers is decided by them.
		const instantiationService = workbenchInstantiationService({ contextKeyService: () => store.add(new ContextKeyService(new TestConfigurationService())) }, store);
		if (storage) {
			instantiationService.stub(IStorageService, storage);
		}
		const contextKeyService = instantiationService.get(IContextKeyService);
		for (const [key, value] of Object.entries(contextKeys)) {
			contextKeyService.createKey(key, value);
		}
		const asked: string[] = [];
		instantiationService.stub(ICommandService, {
			executeCommand: async <T>(id: string, ...args: unknown[]) => {
				asked.push([id, ...args.map(arg => URI.isUri(arg) ? arg.path : String(arg))].join(' '));
				return undefined as T;
			}
		});
		// After the command service: a menu's items run their commands through the one it was made with.
		instantiationService.stub(IMenuService, store.add(instantiationService.createInstance(MenuService)));
		instantiationService.stub(IWorkspaceBarCustomizationService, {
			onDidChange: Event.None,
			get: uri => names.has(uri.path) ? { name: names.get(uri.path) } : undefined,
			nameFor: folder => names.get(folder.uri.path) ?? folder.name,
			worktreeOrder: () => undefined
		});

		let current = groups;
		const gitChanged = store.add(new Emitter<void>());
		// Reads of git's files, which the test finishes (`read`).
		const reads: DeferredPromise<void>[] = [];
		const git = upcastPartial<WorkspaceBarGit>({
			get groups() { return current; },
			ready: true,
			onDidChange: gitChanged.event,
			refresh: () => {
				const read = new DeferredPromise<void>();
				reads.push(read);
				return read.p;
			}
		});
		const model = upcastPartial<WorkspaceBarModel>({ folders, key, onDidChange: Event.None, isUnavailable: () => false });
		const switcher = upcastPartial<WorkspaceBarSwitcher>({ active, onDidChangeActive: Event.None, switchTo: async uri => { asked.push(`switch to ${uri.path}`); } });

		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		store.add(toDisposable(() => container.remove()));
		const barView = store.add(instantiationService.createInstance(WorkspaceBarView, container, model, git, switcher, () => false, Event.None, async (uri: URI) => { asked.push(`show ${uri.path}`); }));
		barView.layout(300, 400);

		return {
			asked,
			barView,
			// As a keybinding sees it: in the list's own context.
			rowKind: () => contextKeyService.getContext(container.querySelector<HTMLElement>('.monaco-list')).getValue(WorkspaceBarRowKindContext.key),
			rows: () => [...container.querySelectorAll<HTMLElement>('.monaco-list-row')]
				.sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
				.map(row => row.getAttribute('aria-label')),
			find: (selector: string, index = 0) => container.querySelector<HTMLElement>(`.monaco-list-row[data-index="${index}"] ${selector}`)!,
			has: (selector: string, index = 0) => !!container.querySelector(`.monaco-list-row[data-index="${index}"] ${selector}`),
			regroup: (groups: WorkspaceBarGroup[]) => {
				current = groups;
				gitChanged.fire();
			},
			/** Finishes the reads of git's files asked for so far, which found `groups`. */
			read: async (groups: WorkspaceBarGroup[]) => {
				current = groups;
				gitChanged.fire();
				for (const read of reads.splice(0)) {
					read.complete();
				}
				await timeout(0);
			}
		};
	}

	function click(element: HTMLElement, detail = 1): void {
		element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
	}

	/** As a browser sends one: two clicks, the second with `detail` 2, then `dblclick`. */
	function doubleClick(element: HTMLElement): void {
		click(element, 1);
		click(element, 2);
		element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
	}

	test('the triangle opens and closes a repository, and a double-click on it is one click', () => {
		const bar = view([lab], [repository(undefined)], lab.uri, new Map([['/wt/w2', 'Payments']]));
		const triangle = () => bar.find('.workspacebar-twistie');

		const open = bar.rows();
		click(triangle());
		const closed = bar.rows();
		doubleClick(triangle());
		const afterDoubleClick = bar.rows();

		assert.deepStrictEqual({ open, closed, afterDoubleClick, asked: bar.asked }, {
			open: ['lab', 'Payments, worktree'],
			closed: ['lab'],
			afterDoubleClick: ['lab', 'Payments, worktree'],
			asked: [],
		});
	});

	test('a folder\'s + is New Worktree... from its row\'s menu, run for that folder - and not there while the menu leaves it out', () => {
		// As New Worktree adds itself: there only while Git can run (WT-5.1), not a button that does nothing.
		store.add(MenuRegistry.appendMenuItem(WorkspaceBarRowToolbar, {
			command: { id: NEW_WORKTREE_COMMAND, title: 'New Worktree...', icon: Codicon.add },
			group: 'navigation',
			when: ContextKeyExpr.equals('facadeTestGitRuns', true)
		}));
		const plus = '.workspacebar-row-toolbar .action-label.codicon-add';

		const withoutGit = view([lab], [repository(undefined)], lab.uri, undefined, { facadeTestGitRuns: false });
		const withGit = view([lab], [repository(undefined)], lab.uri, undefined, { facadeTestGitRuns: true });
		click(withGit.find(plus));

		assert.deepStrictEqual({ withoutGit: withoutGit.has(plus), withGit: withGit.has(plus), asked: withGit.asked }, {
			withoutGit: false,
			withGit: true,
			asked: [`${NEW_WORKTREE_COMMAND} /lab`],
		});
	});

	test('a repository somebody closed is closed again after a reload, and one opened again is open', () => {
		const storage = store.add(new TestStorageService());
		const reload = () => view([lab], [repository(undefined)], lab.uri, undefined, undefined, storage);

		click(reload().find('.workspacebar-twistie'));
		const reloaded = reload();
		const afterClosing = reloaded.rows();
		click(reloaded.find('.workspacebar-twistie'));

		assert.deepStrictEqual({ afterClosing, afterOpening: reload().rows() }, {
			afterClosing: ['lab'],
			afterOpening: ['lab', 'w2, worktree'],
		});
	});

	test('closing a repository while the window is on one of its worktrees takes the window to the repository', () => {
		const bar = view([lab, w2], [repository(w2)], w2.uri);

		click(bar.find('.workspacebar-twistie'));

		assert.deepStrictEqual(bar.asked, ['switch to /lab']);
	});

	test('a worktree being deleted loses its row at once, and gets it back only if git still lists it when its files are next read', async () => {
		// After step 4 of a delete: out of folders[], still in git's records.
		const deleted = view([lab], [repository(undefined)], lab.uri);
		const failed = view([lab], [repository(undefined)], lab.uri);

		const deleting = deleted.barView.hideWorktree(w2.uri);
		const failing = failed.barView.hideWorktree(w2.uri);
		const whileDeleting = deleted.rows();
		deleting.dispose();
		failing.dispose();
		// Git's records still list it until they are read again: a row back before then flashes.
		await timeout(0);
		const untilRead = [deleted.rows(), failed.rows()];
		await deleted.read([{ ...repository(undefined), worktrees: [] }]);
		await failed.read([repository(undefined)]);

		assert.deepStrictEqual({ whileDeleting, untilRead, deleted: deleted.rows(), failed: failed.rows() }, {
			whileDeleting: ['lab'],
			untilRead: [['lab'], ['lab']],
			deleted: ['lab'],
			failed: ['lab', 'w2, worktree'],
		});
	});

	test('when a rebuild takes the focused row away, the row kind no longer says the row was a worktree', () => {
		// A rebuild changes focus without a focus event; left saying "worktree", Alt+Up ran Move
		// Worktree Up on whatever row focus was on next.
		const bar = view([lab, notes], [repository(undefined), { kind: 'folder', folder: notes }], lab.uri);

		click(bar.find('.workspacebar-row', 1));
		const onWorktree = { kind: bar.rowKind(), focused: bar.barView.focused()?.path };
		bar.regroup([{ ...repository(undefined), worktrees: [] }, { kind: 'folder', folder: notes }]);

		assert.deepStrictEqual({ onWorktree, afterRebuild: { kind: bar.rowKind(), focused: bar.barView.focused()?.path } }, {
			onWorktree: { kind: 'worktree', focused: '/wt/w2' },
			afterRebuild: { kind: 'folder', focused: undefined },
		});
	});
});
