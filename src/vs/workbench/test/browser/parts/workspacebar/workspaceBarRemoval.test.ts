/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { basename, extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IRunningWork, IWorkspaceBarAgentsService } from '../../../../browser/parts/workspacebar/workspaceBarAgents.js';
import { IWorkspaceBarCustomizationService } from '../../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarRepository } from '../../../../browser/parts/workspacebar/workspaceBarGit.js';
import { WorkspaceBarModel } from '../../../../browser/parts/workspacebar/workspaceBarModel.js';
import { foldersToRemove, rowsLeavingWith, stoppingNames, WorkspaceBarRemoval } from '../../../../browser/parts/workspacebar/workspaceBarRemoval.js';
import { IRemoveOptions, RemoveResult } from '../../../../browser/parts/workspacebar/workspaceBarService.js';
import { IEditorIdentifier } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { IPutAwayEditorsService } from '../../../../services/putAwayEditors/common/putAwayEditors.js';
import { IActiveFolderService } from '../../../../services/activeFolder/common/activeFolder.js';

/** A file by its path; `untitled:Untitled-1` for a new file never saved (Ctrl+N). */
const fileOf = (path: string) => path.startsWith('untitled:') ? URI.from({ scheme: Schemas.untitled, path: path.slice('untitled:'.length) }) : URI.file(path);

/** A file with unsaved changes, and what was done to it, in order, into `steps`. */
class TestWorkingCopy {

	dirty = true;

	constructor(readonly resource: URI, private readonly steps: string[]) { }

	isDirty(): boolean { return this.dirty; }

	async revert(): Promise<void> {
		this.steps.push(`revert ${this.resource.path}`);
		this.dirty = false;
	}
}

suite('Workspace bar - removing folders', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const isEqual = (a: URI, b: URI) => extUri.isEqual(a, b);
	const member = (path: string) => new WorkspaceFolder({ uri: URI.file(path), index: 0, name: basename(URI.file(path)) });

	const lab: IWorkspaceBarRepository = {
		kind: 'repository',
		main: URI.file('/lab'),
		folder: member('/lab'),
		branch: 'main',
		// The checkout under a second spelling too - a link to it - which is one row with the first.
		members: [member('/lab'), member('/link-lab'), member('/wt/w2')],
		worktrees: [
			{ uri: URI.file('/wt/w2'), branch: 'w2', label: 'w2', exists: true, folder: member('/wt/w2') },
			{ uri: URI.file('/wt/w10'), branch: 'w10', label: 'w10', exists: true, folder: undefined },
		]
	};

	test('a repository takes every other folder of its row with it; anything else goes alone', () => {
		assert.deepStrictEqual({
			'repository row': foldersToRemove(URI.file('/lab'), lab, isEqual).map(uri => uri.path),
			'plain folder': foldersToRemove(URI.file('/notes'), undefined, isEqual).map(uri => uri.path),
			'a worktree itself': foldersToRemove(URI.file('/wt/w2'), lab, isEqual).map(uri => uri.path),
		}, {
			'repository row': ['/lab', '/link-lab', '/wt/w2'],
			'plain folder': ['/notes'],
			'a worktree itself': ['/wt/w2'],
		});
	});

	test('the rows that go with the last of a repository\'s folders: its worktrees\' that never joined, and its checkout\'s when that did not either', () => {
		// Only `api`'s worktree `fix` is in the workspace; its checkout and worktree `login` are not
		const fix = member('/wt/fix');
		const api: IWorkspaceBarRepository = {
			kind: 'repository', main: URI.file('/api'), folder: undefined, branch: 'main', members: [fix],
			worktrees: [
				{ uri: fix.uri, branch: 'fix', label: 'fix', exists: true, folder: fix },
				{ uri: URI.file('/wt/login'), branch: 'login', label: 'login', exists: true, folder: undefined },
			]
		};
		const rows = (path: string, of: IWorkspaceBarRepository) => rowsLeavingWith(of, foldersToRemove(URI.file(path), of, isEqual), isEqual).map(uri => uri.path);

		assert.deepStrictEqual({
			'repository row': rows('/lab', lab),
			'a worktree, the repository staying': rows('/wt/w2', lab),
			'a repository\'s last folder, a worktree': rows('/wt/fix', api),
		}, {
			'repository row': ['/wt/w10'],
			'a worktree, the repository staying': [],
			'a repository\'s last folder, a worktree': ['/wt/login', '/api'],
		});
	});

	interface IWindowOptions {
		readonly folders: readonly string[];
		/** The folder the window is on, by its path; the first when not given. */
		readonly active?: string;
		/** What runs in each folder or row, by its path. */
		readonly work?: Map<string, IRunningWork[]>;
		/** The files with unsaved changes. */
		readonly unsaved?: readonly { path: string }[];
		/** Editors open, by the path of their file. */
		readonly editors?: readonly string[];
		/** What each folder holds out of sight, by its path: the paths of the files of its put-away editors. */
		readonly putAway?: ReadonlyMap<string, readonly string[]>;
		readonly repository?: IWorkspaceBarRepository;
		/** The names rows were given in Customize, by the folder's path; the others go by the folder's own. */
		readonly names?: ReadonlyMap<string, string>;
		/** The button pressed on each question, in turn, by its label; undefined for Cancel or Escape. */
		readonly answers?: readonly (string | undefined)[];
		/** What happens while a question is up, before it is answered. */
		readonly whileAsked?: (window: { folders: IWorkspaceFolder[]; work: Map<string, IRunningWork[]> }) => void;
		/** The workspace not taking the edit, as one whose file cannot be written. */
		readonly editFails?: boolean;
	}

	interface IOutcome {
		readonly result: RemoveResult | string;
		/** Each question: its message, paragraphs, and buttons. */
		readonly asked: { message: string; detail: string[]; buttons: string[] }[];
		/** What was done, in order: the workspace edit, reverts, editors closed. */
		readonly steps: string[];
		readonly folders: string[];
		readonly said: string[];
	}

	async function remove(paths: readonly string[], options: IWindowOptions, removeOptions?: IRemoveOptions, during?: (removal: WorkspaceBarRemoval) => void): Promise<IOutcome> {
		const steps: string[] = [];
		const said: string[] = [];
		const asked: IOutcome['asked'] = [];
		const window = {
			folders: options.folders.map((path, index) => new WorkspaceFolder({ uri: URI.file(path), index, name: basename(URI.file(path)) })) as IWorkspaceFolder[],
			work: new Map(options.work ?? [])
		};
		const copies = (options.unsaved ?? []).map(file => new TestWorkingCopy(fileOf(file.path), steps));
		const answers = [...(options.answers ?? [])];

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IWorkspaceContextService, {
			getWorkspace: () => upcastPartial<IWorkspace>({ id: 'test', folders: window.folders }),
			getWorkspaceFolder: (resource: URI) => window.folders.filter(folder => extUri.isEqualOrParent(resource, folder.uri)).sort((a, b) => b.uri.path.length - a.uri.path.length)[0] ?? null
		});
		instantiationService.stub(IWorkspaceBarAgentsService, { workIn: (folder: URI) => window.work.get(folder.path) ?? [] });
		instantiationService.stub(IWorkingCopyService, { get dirtyWorkingCopies() { return copies.filter(copy => copy.isDirty()) as unknown as IWorkingCopy[]; } });
		instantiationService.stub(IEditorService, {
			getEditors: () => (options.editors ?? []).map(path => ({ groupId: 1, editor: upcastPartial<EditorInput>({ resource: fileOf(path) }) })),
			closeEditors: async (editors: readonly IEditorIdentifier[]) => { steps.push(`close ${editors.map(({ editor }) => editor.resource?.path).join(', ')}`); }
		});
		instantiationService.stub(IDialogService, {
			prompt: async <T>(prompt: IPrompt<T>) => {
				const detail = typeof prompt.detail === 'string' ? prompt.detail : '';
				const labels = (prompt.buttons ?? []).map(button => button.label.replace('&&', ''));
				asked.push({ message: prompt.message, detail: detail.split('\n\n'), buttons: labels });
				options.whileAsked?.(window);
				const answer = answers.shift();
				const button = (prompt.buttons ?? []).find(candidate => candidate.label.replace('&&', '') === answer);
				return { result: button ? await button.run({ checkboxChecked: false }) : undefined };
			}
		});
		instantiationService.stub(ILabelService, { getUriLabel: (uri: URI) => uri.path });
		instantiationService.stub(INotificationService, { warn: (message: string) => { said.push(message); }, error: (message: string) => { said.push(message); } });
		instantiationService.stub(IUriIdentityService, { extUri });
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IPutAwayEditorsService, {
			get: (folder: URI) => (options.putAway?.get(folder.path) ?? []).map(path => URI.file(path)),
			folders: () => [...(options.putAway?.keys() ?? [])].map(path => URI.file(path))
		});
		instantiationService.stub(IActiveFolderService, {
			get activeFolder() { return window.folders.find(folder => folder.uri.path === (options.active ?? options.folders[0])); }
		});
		instantiationService.stub(IWorkspaceBarCustomizationService, { nameFor: (folder: IWorkspaceFolder) => options.names?.get(folder.uri.path) ?? folder.name });

		const model = upcastPartial<WorkspaceBarModel>({
			resolve: async (uri: URI) => window.folders.find(folder => isEqual(folder.uri, uri)),
			remove: async (uris: readonly URI[]) => {
				steps.push(`edit ${uris.map(uri => `-${uri.path}`).join(' ')}`);
				during?.(removal);
				if (!options.editFails) {
					window.folders = window.folders.filter(folder => !uris.some(uri => isEqual(uri, folder.uri)));
				}
				return [];
			}
		});
		const repository = options.repository;
		const removal = instantiationService.createInstance(WorkspaceBarRemoval, model, (uri: URI) => repository && (isEqual(repository.main, uri) || repository.members.some(folder => isEqual(folder.uri, uri))) ? repository : undefined);

		const result = await removal.remove(paths.map(path => URI.file(path)), removeOptions);
		return {
			result: result.kind === 'removed' ? `removed ${result.folders.map(uri => uri.path).join(' ')}` : result,
			asked, steps, said,
			folders: window.folders.map(folder => folder.uri.path)
		};
	}

	const agent = (id: number, name: string): IRunningWork => ({ id, kind: 'agent', name });
	const terminal = (id: number, name: string): IRunningWork => ({ id, kind: 'terminal', name });

	test('WS-33 a folder where nothing would be lost is removed at once: nothing asked, nothing said', async () => {
		assert.deepStrictEqual(await remove(['/w/notes'], { folders: ['/w/api', '/w/notes'] }), {
			result: 'removed /w/notes', asked: [], steps: ['edit -/w/notes'], said: [], folders: ['/w/api']
		});
	});

	test('WS-33 one question names the folder as its row does, and all that would be lost - agents, terminals running a process, unsaved files - and Remove and Discard Changes throws the changes away and closes their editors once the folder has left', async () => {
		const outcome = await remove(['/w/notes'], {
			folders: ['/w/api', '/w/notes'],
			names: new Map([['/w/notes', 'Notes']]),
			work: new Map([['/w/notes', [agent(1, 'Claude Code'), terminal(2, 'npm run dev')]]]),
			unsaved: [{ path: '/w/notes/todo.md' }, { path: '/w/api/index.ts' }],
			editors: ['/w/notes/todo.md', '/w/notes/readme.md', '/w/api/index.ts'],
			answers: ['Remove and Discard Changes']
		});

		assert.deepStrictEqual(outcome, {
			result: 'removed /w/notes',
			asked: [{
				message: 'Are you sure you want to remove \'Notes\' from the workspace?',
				detail: [
					'Claude Code and terminal \'npm run dev\' will be terminated, and unsaved changes in todo.md will be discarded. Files on disk will not be deleted.'
				],
				buttons: ['Remove and Discard Changes']
			}],
			steps: ['edit -/w/notes', 'revert /w/notes/todo.md', 'close /w/notes/todo.md'],
			said: [],
			folders: ['/w/api']
		});
	});

	test('WS-33 what stops, in a sentence: agents by name, terminals by title, those that share a name counted once', () => {
		assert.deepStrictEqual({
			mixed: stoppingNames([agent(1, 'Pinger'), terminal(2, 'PING'), terminal(3, 'PING'), terminal(4, 'npm test')], true),
			terminalsFirst: stoppingNames([terminal(2, 'PING'), terminal(3, 'PING')], true),
			oneTerminal: stoppingNames([terminal(2, 'PING')], true),
			inFolders: stoppingNames([agent(1, 'Pinger'), terminal(2, 'PING')], true, item => item.kind === 'agent' ? 'alpha' : 'beta'),
		}, {
			mixed: 'Pinger, 2 \'PING\' terminals, and terminal \'npm test\'',
			terminalsFirst: '2 \'PING\' terminals',
			oneTerminal: 'Terminal \'PING\'',
			inFolders: 'Pinger in folder \'alpha\' and terminal \'PING\' in folder \'beta\'',
		});
	});

	test('WS-33 several folders at once: one question, which lists them one to a line', async () => {
		const outcome = await remove(['/w/notes', '/w/docs'], {
			folders: ['/w/api', '/w/notes', '/w/docs'],
			names: new Map([['/w/notes', 'Notes']]),
			work: new Map([['/w/docs', [terminal(2, 'npm run dev')]]]),
			answers: ['Remove']
		});

		assert.deepStrictEqual({ result: outcome.result, asked: outcome.asked }, {
			result: 'removed /w/notes /w/docs',
			asked: [{
				message: 'Are you sure you want to remove the following 2 folders from the workspace?',
				detail: [
					'Notes\ndocs',
					'Terminal \'npm run dev\' will be terminated. Files on disk will not be deleted.'
				],
				buttons: ['Remove']
			}]
		});
	});

	test('WS-33 what a folder holds out of sight is its own wherever the file is, and goes with it; what is also on screen, or held by a folder that stays, is not lost and not asked about', async () => {
		const outcome = await remove(['/w/notes'], {
			folders: ['/w/api', '/w/notes'],
			unsaved: [{ path: '/w/api/draft.ts' }, { path: '/w/api/shown.ts' }, { path: '/w/api/shared.ts' }],
			putAway: new Map([['/w/notes', ['/w/api/draft.ts', '/w/api/shown.ts', '/w/api/shared.ts']], ['/w/api', ['/w/api/shared.ts']]]),
			editors: ['/w/api/shown.ts'],
			answers: ['Remove and Discard Changes']
		});

		// The unsaved files' paragraph is the one before the last, which says what is not lost
		assert.deepStrictEqual({ unsaved: outcome.asked.map(question => question.detail.at(-1)), steps: outcome.steps }, {
			unsaved: ['Unsaved changes in draft.ts will be discarded. Files on disk will not be deleted.'],
			steps: ['edit -/w/notes', 'revert /w/api/draft.ts']
		});
	});

	test('WS-33 a new file never saved (Ctrl+N) is the folder\'s the window is on: removing that folder names it and Remove and Discard Changes throws it away; removing another folder leaves it alone', async () => {
		const window = { folders: ['/w/api', '/w/notes'], active: '/w/notes', unsaved: [{ path: 'untitled:Untitled-1' }], editors: ['untitled:Untitled-1'] };

		const theOneItIsOn = await remove(['/w/notes'], { ...window, answers: ['Remove and Discard Changes'] });
		const another = await remove(['/w/api'], window);

		assert.deepStrictEqual({
			theOneItIsOn: { unsaved: theOneItIsOn.asked.map(question => question.detail.at(-1)), steps: theOneItIsOn.steps },
			another: { asked: another.asked, steps: another.steps }
		}, {
			theOneItIsOn: { unsaved: ['Unsaved changes in Untitled-1 will be discarded. Files on disk will not be deleted.'], steps: ['edit -/w/notes', 'revert Untitled-1', 'close Untitled-1'] },
			another: { asked: [], steps: ['edit -/w/api'] }
		});
	});

	test('WTA-25 WS-33 a repository takes its row\'s folders, and names the agents under its rows that never joined', async () => {
		const outcome = await remove(['/lab'], {
			folders: ['/lab', '/link-lab', '/wt/w2', '/notes'],
			repository: lab,
			work: new Map([['/wt/w10', [agent(7, 'Codex')]]]),
			unsaved: [{ path: '/wt/w2/app.ts' }],
			editors: ['/wt/w2/app.ts'],
			answers: ['Remove and Discard Changes']
		});

		assert.deepStrictEqual({ ...outcome, asked: outcome.asked.map(question => [question.message, ...question.detail]) }, {
			result: 'removed /lab /link-lab /wt/w2',
			asked: [[
				// The checkout's other spelling, a link to it, is the same row and not counted as a worktree
				'Are you sure you want to remove \'lab\' and its worktree from the workspace?',
				'Codex will be terminated, and unsaved changes in app.ts will be discarded. Files on disk will not be deleted.'
			]],
			steps: ['edit -/lab -/link-lab -/wt/w2', 'revert /wt/w2/app.ts', 'close /wt/w2/app.ts'],
			said: [],
			folders: ['/notes']
		});
	});

	test('WS-60 with unsaved files the question has two buttons, as Delete Worktree has; Cancel removes, stops and throws away nothing', async () => {
		const outcome = await remove(['/w/notes'], {
			folders: ['/w/api', '/w/notes'],
			work: new Map([['/w/notes', [agent(1, 'Claude Code')]]]),
			unsaved: [{ path: '/w/notes/todo.md' }],
			editors: ['/w/notes/todo.md'],
			answers: [undefined]
		});

		assert.deepStrictEqual({ result: outcome.result, buttons: outcome.asked.map(question => question.buttons), steps: outcome.steps, said: outcome.said, folders: outcome.folders }, {
			result: { kind: 'cancelled' },
			buttons: [['Remove and Discard Changes']],
			steps: [],
			said: [],
			folders: ['/w/api', '/w/notes']
		});
	});

	test('WS-33 Cancel, or Escape, changes nothing', async () => {
		const outcome = await remove(['/w/notes'], {
			folders: ['/w/api', '/w/notes'],
			work: new Map([['/w/notes', [terminal(2, 'npm run dev')]]]),
			answers: [undefined]
		});

		assert.deepStrictEqual({ result: outcome.result, buttons: outcome.asked.map(question => question.buttons), steps: outcome.steps, folders: outcome.folders }, {
			result: { kind: 'cancelled' },
			buttons: [['Remove']],
			steps: [],
			folders: ['/w/api', '/w/notes']
		});
	});

	test('WS-60 a workspace that does not take the edit: failed, with the changes the person said to throw away still there', async () => {
		const outcome = await remove(['/w/notes'], {
			folders: ['/w/api', '/w/notes'],
			unsaved: [{ path: '/w/notes/todo.md' }],
			editors: ['/w/notes/todo.md'],
			answers: ['Remove and Discard Changes'],
			editFails: true
		});

		assert.deepStrictEqual({ result: outcome.result, steps: outcome.steps, folders: outcome.folders }, {
			result: { kind: 'failed', reason: 'failed to write the workspace configuration file' },
			steps: ['edit -/w/notes'],
			folders: ['/w/api', '/w/notes']
		});
	});

	test('WS-60 what started while the question was up is asked about again, and a folder that left meanwhile is not taken out twice', async () => {
		let started = false;
		const again = await remove(['/w/notes'], {
			folders: ['/w/api', '/w/notes'],
			work: new Map([['/w/notes', [agent(1, 'Claude Code')]]]),
			answers: ['Remove', 'Remove'],
			whileAsked: window => {
				if (!started) {
					started = true;
					window.work.set('/w/notes', [agent(1, 'Claude Code'), terminal(3, 'npm test')]);
				}
			}
		});
		const gone = await remove(['/w/notes'], {
			folders: ['/w/api', '/w/notes'],
			work: new Map([['/w/notes', [agent(1, 'Claude Code')]]]),
			answers: ['Remove'],
			whileAsked: window => { window.folders = window.folders.filter(folder => folder.uri.path !== '/w/notes'); }
		});

		assert.deepStrictEqual({
			again: { result: again.result, asked: again.asked.map(question => question.detail), steps: again.steps },
			gone: { result: gone.result, steps: gone.steps }
		}, {
			again: {
				result: 'removed /w/notes',
				asked: [['Claude Code will be terminated. Files on disk will not be deleted.'], ['Claude Code and terminal \'npm test\' will be terminated. Files on disk will not be deleted.']],
				steps: ['edit -/w/notes']
			},
			gone: { result: 'removed ', steps: [] }
		});
	});

	test('the folders being taken out say so while their edit runs, for what runs in them to stop, and not after', async () => {
		let during: boolean[] = [];
		let removal: WorkspaceBarRemoval | undefined;
		await remove(['/w/notes'], { folders: ['/w/api', '/w/notes'] }, undefined, which => {
			removal = which;
			during = [which.isRemoving(URI.file('/w/notes')), which.isRemoving(URI.file('/w/api'))];
		});

		assert.deepStrictEqual({ during, after: removal!.isRemoving(URI.file('/w/notes')) }, { during: [true, false], after: false });
	});

	test('a caller that asked already - deleting a worktree - is asked nothing more', async () => {
		const outcome = await remove(['/wt/w2'], {
			folders: ['/lab', '/wt/w2'],
			repository: lab,
			work: new Map([['/wt/w2', [agent(1, 'Claude Code')]]]),
			unsaved: [{ path: '/wt/w2/app.ts' }]
		}, { confirmed: true });

		assert.deepStrictEqual({ result: outcome.result, asked: outcome.asked.length, steps: outcome.steps }, { result: 'removed /wt/w2', asked: 0, steps: ['edit -/wt/w2'] });
	});
});
