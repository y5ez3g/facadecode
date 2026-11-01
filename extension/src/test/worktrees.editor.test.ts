/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as os from 'os';
import { FacadeError } from '../core/errors';
import { Catalog, Location, WorkspaceFolderInfo, WorktreeError, WorktreePlan, WorktreePort } from '../core/ports';
import { TestEmitter, withModules } from './withModules';

class FakeUri {
	constructor(readonly value: string) { }
	static parse(value: string): FakeUri {
		return new FakeUri(value);
	}
	toString(): string {
		return this.value;
	}
}

type Item = { label: string; description?: string; kind?: number; iconPath?: { id: string }; buttons?: readonly { tooltip?: string }[] };

/** A quick pick or input box: the test types, accepts and hides as a person would. */
class FakeInput {
	title = '';
	value = '';
	prompt: string | undefined;
	placeholder = '';
	validationMessage: string | undefined;
	busy = false;
	buttons: unknown[] = [];
	items: Item[] = [];
	activeItems: unknown[] = [];
	valueSelection: unknown;
	hidden = false;
	readonly accepted = new TestEmitter<void>();
	readonly changed = new TestEmitter<string>();
	readonly hid = new TestEmitter<void>();
	readonly button = new TestEmitter<unknown>();
	readonly itemButton = new TestEmitter<unknown>();
	readonly onDidAccept = this.accepted.event;
	readonly onDidTriggerItemButton = this.itemButton.event;
	readonly onDidChangeValue = this.changed.event;
	readonly onDidHide = this.hid.event;
	readonly onDidTriggerButton = this.button.event;
	constructor(private readonly shownTo: (input: FakeInput) => void) { }
	show(): void {
		this.shownTo(this);
	}
	hide(): void {
		if (!this.hidden) {
			this.hidden = true;
			this.hid.fire();
		}
	}
	dispose(): void { }
	labels(): string[] { return this.items.map(item => item.label); }
	/** Enter on the item `label`. */
	choose(label: string): void {
		this.activeItems = [this.items.find(item => item.label === label)];
		this.accepted.fire();
	}
	active(): string | undefined { return (this.activeItems[0] as Item | undefined)?.label; }
}

/**
 * The editor as New Worktree uses it. `workspace.folders` are its workspace folders; `addFolder` is what its own Add Folder to
 * Workspace... does once its dialog is answered - nothing where it is not set, as a dialog cancelled.
 */
function fakeEditor(extension?: unknown) {
	const handlers = new Map<string, (arg?: unknown) => Promise<unknown>>();
	const executed: unknown[][] = [];
	const clipboard: string[] = [];
	const waiting: ((input: FakeInput) => void)[] = [];
	const shown: FakeInput[] = [];
	/** Shown before the test asked for it: a step a command shows as it starts. */
	const unseen: FakeInput[] = [];
	/** The view's progress as it was asked for, with whether it still shows. */
	const progress: { options: unknown; showing: boolean }[] = [];
	const workspace: { folders: readonly WorkspaceFolderInfo[]; addFolder?: () => void } = { folders: [] };
	const onShow = (input: FakeInput) => {
		shown.push(input);
		const waiter = waiting.shift();
		if (waiter) {
			waiter(input);
		} else {
			unseen.push(input);
		}
	};
	const vscode = {
		env: { clipboard: { writeText: async (text: string) => void clipboard.push(text) } },
		Uri: FakeUri,
		ThemeIcon: class { constructor(readonly id: string) { } },
		QuickInputButtons: { Back: { back: true } },
		QuickPickItemKind: { Separator: -1, Default: 0 },
		l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, at: string) => String(args[Number(at)])) },
		commands: {
			registerCommand: (id: string, handler: (arg?: unknown) => Promise<unknown>) => {
				handlers.set(id, handler);
				return { dispose: () => handlers.delete(id) };
			},
			executeCommand: async (...args: unknown[]) => {
				executed.push(args);
				if (args[0] === 'workbench.action.addRootFolder') {
					workspace.addFolder?.();
				}
			}
		},
		window: {
			withProgress: (options: unknown, task: () => Promise<unknown>) => {
				const entry = { options, showing: true };
				progress.push(entry);
				return task().finally(() => { entry.showing = false; });
			},
			createInputBox: () => new FakeInput(onShow),
			createQuickPick: () => new FakeInput(onShow)
		},
		workspace: {
			get workspaceFolders() { return workspace.folders.map(each => ({ index: each.index, name: each.name, uri: FakeUri.parse(each.uri) })); },
			getConfiguration: () => ({ get: (key: string) => key === 'branchPrefix' ? 'me/' : undefined })
		},
		extensions: { getExtension: () => extension }
	};
	const load = withModules({ vscode });
	return {
		handlers, executed, shown, workspace, clipboard, progress,
		/** The next quick input shown: one shown already that the test has not had yet, else the next to show. */
		next: () => unseen.length ? Promise.resolve(unseen.shift()!) : new Promise<FakeInput>(resolve => waiting.push(resolve)),
		commands: load<typeof import('../ui/commands/worktree')>(require.resolve('../ui/commands/worktree')),
		/** The ports module as the loaded commands have it: its error classes are theirs. */
		ports: load<typeof import('../core/ports')>(require.resolve('../core/ports')),
		native: load<typeof import('../host/locations/nativeGit')>(require.resolve('../host/locations/nativeGit'))
	};
}

const folderAt = (index: number, at: string): WorkspaceFolderInfo => ({ index, name: at.split('/').pop()!, uri: `file://${at}`, path: at });
const REPO_FOLDER = folderAt(0, '/w/repo');
const REPO: Location = { id: 'loc-repo', path: '/w/repo', uri: 'file:///w/repo', environment: 'local', label: 'main', folders: [REPO_FOLDER], kind: 'checkout', isMain: true, branch: 'main', detached: false, opened: true, git: 'ok' };
const MADE: Location = { ...REPO, id: 'loc-new', path: '/w/repo.worktrees/feat', label: 'me/feat', isMain: false, branch: 'me/feat', opened: false };
/** A linked worktree of REPO. */
const LINKED: Location = { ...REPO, id: 'loc-linked', path: '/w/repo.worktrees/old', uri: 'file:///w/repo.worktrees/old', label: 'old', isMain: false, branch: 'old', opened: false };
/** A plain folder in the home folder, which the person reads as `~/notes`. */
const NOTES_PATH = `${os.homedir()}/notes`;
const NOTES_FOLDER: WorkspaceFolderInfo = { index: 1, name: 'notes', uri: `file://${NOTES_PATH}`, path: NOTES_PATH };
const NOTES: Location = { id: 'loc-notes', path: NOTES_PATH, uri: `file://${NOTES_PATH}`, environment: 'local', label: 'notes', folders: [NOTES_FOLDER], kind: 'folder', opened: true, git: 'none' };
/** Another repository's main checkout, the third folder. */
const OTHER_FOLDER = folderAt(2, '/w/other');
const OTHER: Location = { ...REPO, id: 'loc-other', path: '/w/other', uri: 'file:///w/other', folders: [OTHER_FOLDER] };
/** How the person reads NOTES in an error: with the home folder as ~, which Windows does not say (UX-1.3). */
const NOTES_SAID = process.platform === 'win32' ? NOTES_PATH : '~/notes';

/**
 * A worktree port that plans `<repo>.worktrees/<name>` and records what it is asked. A location of a repository can have one; the
 * plain folder answers as the host does, its problem with it.
 */
function fakeWorktrees(more: Partial<WorktreePort> = {}): WorktreePort & { readonly calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		calls,
		availability: async id => {
			calls.push(['availability', id]);
			return id === NOTES.id ? { available: false, reason: `${NOTES_PATH} is not in a Git repository.`, problem: { kind: 'not_repository', path: NOTES_PATH } } as Awaited<ReturnType<WorktreePort['availability']>>
				: { available: true };
		},
		plan: async (source, branch, baseRef) => {
			calls.push(['plan', source, branch, baseRef]);
			if (branch.includes('..')) {
				throw new WorktreeError(`Git rejects "${branch}" as a branch name`, 'invalid_argument');
			}
			return { source, branch, baseRef: baseRef ?? 'HEAD', baseCommit: 'c0ffee'.repeat(6) + 'beef', destination: `/w/repo.worktrees/${branch.split('/').pop()}` };
		},
		create: async (plan: WorktreePlan) => {
			calls.push(['create', plan.branch, plan.baseRef, plan.destination]);
			return MADE;
		},
		remove: async id => void calls.push(['remove', id]),
		...more
	};
}

/** The window's catalog: these folders, these locations; `set` changes it as the location service does, and says so. */
function catalogOf(folders: readonly WorkspaceFolderInfo[], ...locations: Location[]) {
	const changed = new TestEmitter<void>();
	let catalog: Catalog = { locations, folders, pending: false };
	return { snapshot: () => catalog, onDidChange: changed.event, set: (next: Catalog) => { catalog = next; changed.fire(); } };
}

const settled = () => new Promise(resolve => setTimeout(resolve, 10));
/** No agent in the window: a folder's removal would close none. */
const NO_AGENTS = { list: () => [] };
const quiet = { event: () => undefined };

suite('Worktrees: New Worktree in this window (UX-3.1; WORKTREES-2.1, 4.3)', () => {

	test('Copy Path in the standalone confirmation copies the full destination without creating or leaving the step', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!();
		const branch = await editor.next();
		branch.value = 'me/feat'; branch.accepted.fire();
		const confirm = await editor.next();
		const copy = confirm.buttons.find(button => (button as { tooltip?: string }).tooltip?.startsWith('Copy Path ('));
		assert.ok(copy);
		confirm.button.fire(copy); await settled();
		assert.deepStrictEqual(editor.clipboard, ['/w/repo.worktrees/feat']);
		assert.strictEqual(confirm.hidden, false);
		assert.strictEqual(worktrees.calls.some(call => call[0] === 'create'), false);
		confirm.hide(); await running;
	});

	test('{location_id, branch} creates at once from that location\'s HEAD and answers what was made; no notification', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		const errors: string[] = [];
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: text => errors.push(text), log: quiet });
		const result = await editor.handlers.get('facade.newWorktree')!({ location_id: REPO.id, branch: 'me/feat' });

		assert.deepStrictEqual(result, { location_id: MADE.id, destination: MADE.path, branch: 'me/feat' });
		assert.deepStrictEqual(worktrees.calls, [['plan', REPO.id, 'me/feat', undefined], ['create', 'me/feat', 'HEAD', '/w/repo.worktrees/feat']]);
		assert.deepStrictEqual(errors, []);
	});

	test('arguments of any other shape fail without a guess, before anything is planned', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const run = editor.handlers.get('facade.newWorktree')!;

		for (const wrong of [{ location_id: REPO.id }, { location_id: REPO.id, branch: 'x', name: 'y' }, { location_id: REPO.id, branch: 'x', base_ref: 3 }, 'loc-repo',
			{ preserveFocus: false, location_id: REPO.id, branch: 'x' }, { preserveFocus: 'yes' }]) {
			await assert.rejects(run(wrong), (err: unknown) => (err as FacadeError).code === 'INVALID' && (err as FacadeError).reason === 'invalid_argument');
		}
		assert.deepStrictEqual(worktrees.calls, []);
	});

	test('what the editor\'s own menu gives - nothing, null, or a mouse click\'s { preserveFocus } - is no request: the person chooses (WORKTREES-4.3)', async () => {
		const shown: unknown[] = [];
		for (const given of [undefined, null, { preserveFocus: false }, { preserveFocus: true }]) {
			const editor = fakeEditor();
			const worktrees = fakeWorktrees();
			const errors: string[] = [];
			editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: text => errors.push(text), log: quiet });
			const running = editor.handlers.get('facade.newWorktree')!(given);
			const branch = await editor.next();
			shown.push([branch.value, errors]);
			branch.hide();
			assert.strictEqual(await running, undefined);
		}
		assert.deepStrictEqual(shown, Array(4).fill(['me/', []]));
	});

	test('a failure goes to the person with what it actually left, kept', async () => {
		const editor = fakeEditor();
		const errors: string[] = [];
		const worktrees = fakeWorktrees({ create: async () => { throw new editor.ports.WorktreeError('Git could not create the worktree: fatal: disk full.', 'creation_failed', { branchCreated: true, destinationCreated: '/w/repo.worktrees/feat' }); } });
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: text => errors.push(text), log: quiet });

		assert.strictEqual(await editor.handlers.get('facade.newWorktree')!({ location_id: REPO.id, branch: 'feat', base_ref: 'main' }), undefined);
		assert.deepStrictEqual(errors, ['Could not create worktree: Git could not create the worktree: fatal: disk full. Branch feat and folder /w/repo.worktrees/feat were created and kept.']);
	});

	test('without arguments in a window of one folder: no folder step; the branch, prefilled with git.branchPrefix and planned as it is typed, then branch, base and destination shown before anything is made', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!();
		const branch = await editor.next();
		assert.deepStrictEqual([branch.value, branch.buttons.length, editor.shown.length], ['me/', 0, 1]);
		branch.value = 'me/a..b';
		branch.accepted.fire();
		await settled();
		assert.match(branch.validationMessage ?? '', /Git rejects "me\/a\.\.b"/);
		branch.value = 'me/feat';
		branch.accepted.fire();
		const confirm = await editor.next();

		assert.deepStrictEqual(confirm.items.map(item => item.label), ['Create Worktree', 'Change Base...']);
		assert.ok(!worktrees.calls.some(call => call[0] === 'create'));
		confirm.activeItems = [confirm.items[0]];
		confirm.accepted.fire();
		assert.deepStrictEqual(await running, { location_id: MADE.id, destination: MADE.path, branch: 'me/feat' });
		assert.deepStrictEqual(worktrees.calls.filter(call => call[0] === 'create'), [['create', 'me/feat', 'HEAD', '/w/repo.worktrees/feat']]);
	});

	test('UX-1.1: in a window of one folder, the view shows its progress at once while Git is asked whether a worktree can be made there, before any step is up', async () => {
		const editor = fakeEditor();
		let answer!: (state: { available: true }) => void;
		const worktrees = fakeWorktrees({ availability: () => new Promise(resolve => { answer = resolve; }) });
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!();
		await settled();
		const asking = [editor.shown.length, editor.progress.map(each => [each.options, each.showing])];
		answer({ available: true });
		const branch = await editor.next();
		const answered = editor.progress.map(each => each.showing);
		branch.hide();
		await running;
		assert.deepStrictEqual([asking, answered], [[0, [[{ location: { viewId: 'facade.agents' } }, true]]], [false]]);
	});

	test('from the view\'s own `…` menu, which gives `null`, the person chooses as without arguments', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!(null);
		const branch = await editor.next();
		const asked = branch.value;
		branch.hide();
		assert.deepStrictEqual([asked, await running, worktrees.calls.filter(call => call[0] === 'create')], ['me/', undefined, []]);
	});

	test('Escape at any step ends New Worktree with no effect', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		const errors: string[] = [];
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER, NOTES_FOLDER], REPO, NOTES), worktrees, agents: NO_AGENTS, notifyError: text => errors.push(text), log: quiet });
		const atFolder = editor.handlers.get('facade.newWorktree')!();
		(await editor.next()).hide();
		assert.strictEqual(await atFolder, undefined);
		const atBranch = editor.handlers.get('facade.newWorktree')!();
		(await editor.next()).choose('repo');
		(await editor.next()).hide();
		assert.strictEqual(await atBranch, undefined);
		const atConfirm = editor.handlers.get('facade.newWorktree')!();
		(await editor.next()).choose('repo');
		const branch = await editor.next();
		branch.value = 'me/feat';
		branch.accepted.fire();
		(await editor.next()).hide();

		assert.strictEqual(await atConfirm, undefined);
		assert.deepStrictEqual([worktrees.calls.filter(call => call[0] === 'create'), errors], [[], []]);
	});

	test('WORKTREES-2.1: a folder\'s repository is its source by its main checkout, whatever checkout comes first; the base can be changed before anything is made', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], LINKED, REPO), worktrees, agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!();
		const branch = await editor.next();
		const first = [branch.items.length, branch.value, branch.buttons.length];
		branch.value = 'me/feat';
		branch.accepted.fire();
		let confirm = await editor.next();
		confirm.activeItems = [confirm.items[1]];
		confirm.accepted.fire();
		const base = await editor.next();
		const offered = [base.value, base.buttons.length];
		base.value = 'release/1';
		base.accepted.fire();
		confirm = await editor.next();
		const changed = confirm.items[1].description;
		confirm.button.fire(confirm.buttons[0]);
		const branchAgain = await editor.next();
		const sourcePrompt = branchAgain.prompt;
		branchAgain.accepted.fire();
		confirm = await editor.next();
		confirm.activeItems = [confirm.items[0]];
		confirm.accepted.fire();
		await running;

		assert.deepStrictEqual([first, offered, changed, sourcePrompt, confirm.hidden], [[0, 'me/', 0], ['HEAD', 1], 'release/1', 'Starts from release/1', true]);
		assert.deepStrictEqual(worktrees.calls, [['availability', REPO.id], ['plan', REPO.id, 'me/feat', undefined], ['plan', REPO.id, 'me/feat', 'release/1'], ['plan', REPO.id, 'me/feat', 'release/1'], ['create', 'me/feat', 'release/1', '/w/repo.worktrees/feat']]);
	});

	test('WORKTREES-2.1: one folder that is no Git repository ends New Worktree at once with why, the folder said with ~, and asks nothing', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		const errors: string[] = [];
		editor.commands.registerWorktreeCommands({ locations: catalogOf([NOTES_FOLDER], NOTES), worktrees, agents: NO_AGENTS, notifyError: text => errors.push(text), log: quiet });

		assert.strictEqual(await editor.handlers.get('facade.newWorktree')!(), undefined);
		assert.deepStrictEqual([errors, editor.shown.length, worktrees.calls], [[`New Worktree is unavailable: ${NOTES_SAID} is not in a Git repository.`], 0, [['availability', NOTES.id]]]);
	});

	test('LIFECYCLE-1.3, D73: several folders are chosen among first, in Change Working Location\'s folder step - every folder, a plain one too, with the folder that holds it and its X - then a line and Add Folder to Workspace... last', async () => {
		const editor = fakeEditor();
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER, NOTES_FOLDER, OTHER_FOLDER], REPO, NOTES, OTHER), worktrees: fakeWorktrees(), agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!();
		const step = await editor.next();
		const shown = {
			title: step.title, placeholder: step.placeholder, back: step.buttons.length, active: step.active(),
			items: step.items.map(item => [item.label, item.description, item.kind, item.iconPath?.id, item.buttons?.map(button => button.tooltip)])
		};
		step.hide();
		await running;

		assert.deepStrictEqual(shown, {
			title: 'New Worktree', placeholder: 'Select a folder', back: 0, active: 'repo',
			items: [
				['repo', '/w', undefined, 'repo', ['Remove Folder from Workspace']],
				['notes', process.platform === 'win32' ? os.homedir() : '~', undefined, 'folder', ['Remove Folder from Workspace']],
				['other', '/w', undefined, 'repo', ['Remove Folder from Workspace']],
				['', undefined, -1, undefined, undefined],
				['Add Folder to Workspace...', undefined, undefined, 'add', undefined]
			]
		});
	});

	test('WORKTREES-2.1: a folder chosen that is no Git repository ends the flow with why; nothing is made', async () => {
		const editor = fakeEditor();
		const worktrees = fakeWorktrees();
		const errors: string[] = [];
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER, NOTES_FOLDER], REPO, NOTES), worktrees, agents: NO_AGENTS, notifyError: text => errors.push(text), log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!();
		const step = await editor.next();
		step.choose('notes');

		assert.strictEqual(await running, undefined);
		assert.deepStrictEqual([errors, step.hidden, editor.shown.length, worktrees.calls], [[`New Worktree is unavailable: ${NOTES_SAID} is not in a Git repository.`], true, 1, [['availability', NOTES.id]]]);
	});

	test('UX-1.1, WORKTREES-2.1: a repository chosen goes on to its branch, the folder step busy while Git is asked; Back returns to the folder step, the folder chosen still selected', async () => {
		const editor = fakeEditor();
		let answer!: () => void;
		const worktrees = fakeWorktrees({ availability: () => new Promise(resolve => { answer = () => resolve({ available: true }); }) });
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER, NOTES_FOLDER, OTHER_FOLDER], REPO, NOTES, OTHER), worktrees, agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!();
		const step = await editor.next();
		step.choose('other');
		await settled();
		const checking = [step.busy, step.hidden];
		answer();
		const branch = await editor.next();
		const asked = [branch.title, branch.value, branch.prompt, branch.buttons.length, step.hidden];
		branch.button.fire(branch.buttons[0]);
		const again = await editor.next();
		const back = [again.placeholder, again.active(), branch.hidden];
		again.hide();

		assert.strictEqual(await running, undefined);
		assert.deepStrictEqual([checking, asked, back], [
			[true, false],
			['New Worktree', 'me/', 'Starts from main', 1, true],
			['Select a folder', 'other', true]
		]);
		assert.deepStrictEqual(worktrees.calls, []);
	});

	test('D73: Add Folder to Workspace... is the editor\'s own command - the step hidden meanwhile; cancelled, the step is as it was; a folder added, the step again with it selected', async () => {
		const editor = fakeEditor();
		const API_FOLDER = folderAt(2, '/w/api');
		const API: Location = { ...NOTES, id: 'loc-api', path: '/w/api', uri: 'file:///w/api', label: 'api', folders: [API_FOLDER] };
		const locations = catalogOf([REPO_FOLDER, NOTES_FOLDER], REPO, NOTES);
		editor.workspace.folders = [REPO_FOLDER, NOTES_FOLDER];
		editor.commands.registerWorktreeCommands({ locations, worktrees: fakeWorktrees(), agents: NO_AGENTS, notifyError: () => undefined, log: quiet });
		const running = editor.handlers.get('facade.newWorktree')!();
		const first = await editor.next();
		first.choose('Add Folder to Workspace...');
		const cancelled = await editor.next();
		const unchanged = [first.hidden, cancelled.labels(), cancelled.active()];
		// The editor adds the folder chosen in its dialog, and the location service hears of it after the command returns
		editor.workspace.addFolder = () => {
			editor.workspace.folders = [REPO_FOLDER, NOTES_FOLDER, API_FOLDER];
			setTimeout(() => locations.set({ locations: [REPO, NOTES, API], folders: [REPO_FOLDER, NOTES_FOLDER, API_FOLDER], pending: false }), 5);
		};
		cancelled.choose('Add Folder to Workspace...');
		const added = await editor.next();
		const shown = [added.labels(), added.active()];
		added.hide();
		await running;

		assert.deepStrictEqual([unchanged, shown, editor.executed], [
			[true, ['repo', 'notes', '', 'Add Folder to Workspace...'], 'repo'],
			[['repo', 'notes', 'api', '', 'Add Folder to Workspace...'], 'api'],
			[['workbench.action.addRootFolder'], ['workbench.action.addRootFolder']]
		]);
	});

	test('UX-2.4: Facade\'s own reasons are said to the person in their words, when New Worktree is unavailable and when a creation fails', async () => {
		const editor = fakeEditor();
		const errors: string[] = [];
		const english = 'This editor\'s Git extension cannot create worktrees: its API has no worktree creation.';
		const worktrees = fakeWorktrees({
			availability: async () => ({ available: false, reason: english, problem: { kind: 'no_native_creation' } }) as Awaited<ReturnType<WorktreePort['availability']>>,
			create: async () => { throw Object.assign(new editor.ports.WorktreeError(english, 'unavailable'), { problem: { kind: 'no_native_creation' } }); }
		});
		editor.commands.registerWorktreeCommands({ locations: catalogOf([REPO_FOLDER], REPO), worktrees, agents: NO_AGENTS, notifyError: text => errors.push(text), log: quiet });
		await editor.handlers.get('facade.newWorktree')!();
		await editor.handlers.get('facade.newWorktree')!({ location_id: REPO.id, branch: 'feat' });

		assert.deepStrictEqual(errors, ['New Worktree is unavailable: This editor\'s Git extension cannot create worktrees.', 'Could not create worktree: This editor\'s Git extension cannot create worktrees.']);
	});
});

suite('Worktrees: the editor\'s native creation, feature-detected (WORKTREES-4.1)', () => {

	test('no Git extension, or one whose repositories have no createWorktree, is unavailable with why', async () => {
		const none = fakeEditor(undefined).native.editorNativeGit();
		const old = fakeEditor({ isActive: true, exports: { getAPI: () => ({ repositories: [{ rootUri: FakeUri.parse('file:///w/repo') }], getRepository: () => ({ rootUri: FakeUri.parse('file:///w/repo') }) }) } }).native.editorNativeGit();

		assert.deepStrictEqual([await none.unsupported(), await none.repository(['file:///w/repo']), await old.unsupported(), await old.repository(['file:///w/repo'])], [
			{ kind: 'git_extension_missing' }, { kind: 'git_extension_missing' }, { kind: 'no_native_creation' }, { kind: 'no_native_creation' }
		]);
	});

	test('the repository of the source, else of another checkout of it, else one opened natively, creates with the explicit path, branch and commit', async () => {
		const made: unknown[] = [];
		const main = { rootUri: FakeUri.parse('file:///w/repo'), async createWorktree(this: unknown, options: unknown) { made.push([this === main, options]); return '/w/repo.worktrees/feat'; } };
		const opened: string[] = [];
		const api = {
			repositories: [main],
			getRepository: (uri: FakeUri) => uri.value === 'file:///w/repo' ? main : null,
			openRepository: async (uri: FakeUri) => { opened.push(uri.value); return main; }
		};
		const native = fakeEditor({ isActive: true, exports: { getAPI: () => api } }).native.editorNativeGit();
		const creator = await native.repository(['file:///w/other-worktree', 'file:///w/repo']);
		assert.ok(!('kind' in creator));
		assert.strictEqual(await creator.createWorktree({ path: '/w/repo.worktrees/feat', branch: 'feat', commitish: 'abc' }), '/w/repo.worktrees/feat');
		assert.deepStrictEqual(made, [[true, { path: '/w/repo.worktrees/feat', branch: 'feat', commitish: 'abc' }]]);
		assert.strictEqual(await native.unsupported(), undefined);
		assert.ok(!('kind' in await native.repository(['file:///elsewhere'])));

		assert.deepStrictEqual(opened, ['file:///elsewhere']);
	});
});
