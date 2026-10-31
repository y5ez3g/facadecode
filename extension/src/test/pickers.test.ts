/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { Catalog, CliChoice, LaunchRequest, Location, RunFacts, WorkspaceFolderInfo, WorktreePort } from '../core/ports';
import { TestEmitter, withModules } from './withModules';

const BACK_BUTTON = { id: 'back' };

/** The editor's quick inputs as the pickers drive them: one shown at a time, the next hiding the one before, as VS Code does. */
class Ui {
	current: Input | undefined;
	readonly commands: unknown[][] = [];
	readonly clipboard: string[] = [];
	branchPrefix: string | undefined;
	/** The editor's dialogs as they were asked, with the step up at the time: none, as a dialog hides it. */
	readonly dialogs: { readonly kind: 'warning' | 'addFolder'; readonly args: unknown[]; readonly over: string | undefined }[] = [];
	/** What a modal warning answers: the action chosen, or none for Cancel. */
	answer: string | undefined;
	/** The workspace folders as the editor has them. */
	workspaceFolders: readonly WorkspaceFolderInfo[] = [];
	/** What the editor's own Add Folder to Workspace... does once its dialog is answered: nothing where it is not set, as Cancel. */
	addRootFolder: (() => void) | undefined;
	/** `updateWorkspaceFolders` as it was called; `folders` applies a change the way the editor does, after it was asked. */
	readonly updates: unknown[][] = [];
	folders: ((start: number, deleteCount: number, added: readonly { readonly uri: { readonly path: string } }[]) => void) | undefined;
}

type Item = { label: string; description?: string; detail?: string; kind?: number; alwaysShow?: boolean; buttons?: readonly unknown[] } & Record<string, unknown>;

class Input {
	title: string | undefined;
	placeholder: string | undefined;
	prompt: string | undefined;
	value = '';
	valueSelection: unknown;
	validationMessage: string | undefined;
	busy = false;
	buttons: readonly unknown[] = [];
	items: readonly Item[] = [];
	activeItems: readonly Item[] = [];
	matchOnDescription = false;
	matchOnDetail = false;
	shown = false;
	private readonly accepted = new TestEmitter<void>();
	private readonly hidden = new TestEmitter<void>();
	private readonly button = new TestEmitter<unknown>();
	private readonly itemButton = new TestEmitter<{ item: Item; button: unknown }>();
	private readonly changed = new TestEmitter<string>();
	private readonly activeChanged = new TestEmitter<readonly Item[]>();
	readonly onDidChangeActive = this.activeChanged.event;
	readonly onDidAccept = this.accepted.event;
	readonly onDidHide = this.hidden.event;
	readonly onDidTriggerButton = this.button.event;
	readonly onDidTriggerItemButton = this.itemButton.event;
	readonly onDidChangeValue = this.changed.event;
	constructor(readonly kind: 'pick' | 'text', private readonly ui: Ui) { }
	show(): void {
		if (this.ui.current && this.ui.current !== this) {
			this.ui.current.hide();
		}
		this.ui.current = this;
		this.shown = true;
	}
	hide(): void {
		if (this.shown) {
			this.shown = false;
			if (this.ui.current === this) {
				this.ui.current = undefined;
			}
			this.hidden.fire();
		}
	}
	dispose(): void { /* nothing held */ }
	labels(): string[] { return this.items.map(item => item.label); }
	item(label: string): Item { return this.items.find(item => item.label === label)!; }
	/** Enter on the item `label`, else on the active item - the first that is not a separator where none is, as VS Code has it. */
	accept(label?: string): void {
		if (label !== undefined) {
			this.activeItems = [this.item(label)];
		} else if (!this.activeItems.length && this.items.length) {
			this.activeItems = this.items.filter(item => item.kind !== -1).slice(0, 1);
		}
		this.accepted.fire();
	}
	type(value: string): void { this.value = value; this.changed.fire(value); }
	/** Moves the keyboard to the `at`th item, as scrolling down the list does. */
	activate(at: number): void { this.activeItems = [this.items[at]]; this.activeChanged.fire(this.activeItems); }
	back(): void { this.button.fire(BACK_BUTTON); }
	header(button: unknown): void { this.button.fire(button); }
	/** Presses `button` on the `at`th item: labels can repeat. */
	press(at: number, button: unknown): void { this.itemButton.fire({ item: this.items[at], button }); }
}

function vscodeFor(ui: Ui) {
	return {
		window: {
			createQuickPick: () => new Input('pick', ui),
			createInputBox: () => new Input('text', ui),
			showWarningMessage: async (...args: unknown[]) => { ui.dialogs.push({ kind: 'warning', args, over: ui.current?.placeholder }); return ui.answer; }
		},
		QuickInputButtons: { Back: BACK_BUTTON },
		QuickPickItemKind: { Separator: -1, Default: 0 },
		ThemeIcon: class { constructor(readonly id: string) { } },
		Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }), parse: (uri: string) => ({ path: uri }) },
		workspace: {
			get workspaceFolders() { return ui.workspaceFolders.map(each => ({ index: each.index, name: each.name, uri: { toString: () => each.uri } })); },
			getConfiguration: (section: string) => ({ get: (key: string) => section === 'git' && key === 'branchPrefix' ? ui.branchPrefix : undefined }),
			updateWorkspaceFolders: (start: number, deleteCount: number, ...added: { readonly uri: { readonly path: string } }[]) => {
				ui.updates.push([start, deleteCount, ...added.map(each => each.uri.path)]);
				setImmediate(() => ui.folders?.(start, deleteCount, added));
				return true;
			}
		},
		l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)])) },
		commands: {
			executeCommand: async (...args: unknown[]) => {
				ui.commands.push(args);
				if (args[0] === 'workbench.action.addRootFolder') {
					ui.dialogs.push({ kind: 'addFolder', args: [], over: ui.current?.placeholder });
					ui.addRootFolder?.();
				}
			}
		},
		env: { clipboard: { writeText: async (text: string) => void ui.clipboard.push(text) } }
	};
}

const SHOP: WorkspaceFolderInfo = { index: 0, name: 'shop', uri: 'file:///shop', path: '/shop' };
const DOCS: WorkspaceFolderInfo = { index: 1, name: 'docs', uri: 'file:///docs', path: '/docs' };
const place = (id: string, label: string, folder: WorkspaceFolderInfo, more: Partial<Location> = {}): Location => ({ id, path: `/${label}`, uri: `file:///${label}`, environment: 'local', label, folders: [folder], kind: 'checkout', opened: false, git: 'ok', ...more });
const MAIN = place('loc-main', 'main', SHOP, { opened: true, isMain: true });
const LOGIN = place('loc-login', 'login-fix', SHOP, { branch: 'login-fix' });
const GUIDE = place('loc-guide', 'guide', DOCS, { kind: 'folder' });
const cli = (id: string, displayName: string, more: Partial<CliChoice & { notInstalled: boolean }> = {}): CliChoice => ({ id, displayName, available: true, ...more });

const settle = () => new Promise(resolve => setImmediate(resolve));

/** An agent running at `location`. */
const runAt = (n: number, location: Location): RunFacts => ({
	id: `run-${n}`, alias: `#a${n}`, name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: location.id, cwd: location.path,
	environment: 'local', yolo: true, createdAt: n, lifecycle: 'running', phase: 'running', activity: 'working', reporting: true
});

/** Each item's buttons as `[icon, tooltip]`, for the items that have any. */
const buttonsOf = (input: Input) => input.items.filter(item => item.buttons?.length).map(item => [item.label, ...item.buttons!.map(button => {
	const { iconPath, tooltip } = button as { iconPath: { id: string }; tooltip: string };
	return `${iconPath.id}: ${tooltip}`;
})]);

suite('Pickers: New Agent, Change Working Location, Change Name, Go to Agent (LIFECYCLE-1, 2)', () => {
	let ui: Ui;
	let load: <T>(file: string) => T;

	setup(() => {
		ui = new Ui();
		load = withModules({ vscode: vscodeFor(ui) });
	});

	test('shared worktree input copies only the current validated destination without accepting, including out-of-order checks and cancel', async () => {
		const { Flow } = load<typeof import('../ui/pickers/stepping')>(require.resolve('../ui/pickers/stepping'));
		const { askWorktreeRef } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
		const checks = new Map<string, (plan: Awaited<ReturnType<WorktreePort['plan']>>) => void>();
		const port: WorktreePort = {
			availability: async () => ({ available: true }),
			plan: (_source, branch) => new Promise(resolve => checks.set(branch, resolve)),
			create: async () => { throw new Error('input must not create'); },
			remove: async () => undefined
		};
		const flow = new Flow();
		let accepted = false;
		const result = askWorktreeRef(flow, port, MAIN, { kind: 'branch', title: 'New Agent', back: true }).then(value => { accepted = true; return value; });
		const input = ui.current!;
		const planFor = (branch: string) => ({ source: MAIN.id, branch, baseRef: 'HEAD', baseCommit: 'abc', destination: `/work/long-parent-folder/repo.worktrees/${branch}` });
		const type = async (value: string) => { input.type(value); await new Promise(resolve => setTimeout(resolve, 170)); };
		await type('first');
		checks.get('first')!(planFor('first')); await settle();
		const firstCopy = input.buttons[1];
		input.header(firstCopy); await settle();
		assert.deepStrictEqual(ui.clipboard, [planFor('first').destination]);
		assert.strictEqual(accepted, false);
		assert.strictEqual(input.shown, true);
		input.type(''); input.header(firstCopy);
		assert.deepStrictEqual(input.buttons, [BACK_BUTTON]);
		await type('second');
		input.header(firstCopy);
		await type('latest');
		checks.get('latest')!(planFor('latest')); await settle();
		const latestCopy = input.buttons[1];
		checks.get('second')!(planFor('second')); await settle();
		assert.strictEqual(input.buttons[1], latestCopy);
		input.header(latestCopy); await settle();
		assert.deepStrictEqual(ui.clipboard, [planFor('first').destination, planFor('latest').destination]);
		assert.match(input.prompt!, /latest \(base: main\)$/);
		await type('cancelled'); input.hide();
		checks.get('cancelled')!(planFor('cancelled')); await settle();
		input.header(latestCopy);
		assert.strictEqual(await result, undefined);
		assert.strictEqual(ui.clipboard.length, 2);
	});

	test('a remote environment is named as VS Code\'s remote indicator names it, from the authority the local window sees (LIFECYCLE-1.1, D67)', () => {
		const { environmentLabel } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
		const hex = Buffer.from(JSON.stringify({ hostName: 'build.example.com', user: 'me' })).toString('hex');
		assert.deepStrictEqual([
			environmentLabel('ssh-remote', 'ssh-remote+fxl527night'), environmentLabel('ssh-remote', `ssh-remote+${hex}`), environmentLabel('ssh-remote', 'ssh-remote+deadbeef'),
			environmentLabel('ssh-remote'), environmentLabel('wsl', 'wsl+Ubuntu'), environmentLabel('dev-container', 'dev-container+7b7d'), environmentLabel('codespaces')
		], ['SSH: fxl527night', 'SSH: build.example.com', 'SSH: deadbeef', 'SSH', 'WSL: Ubuntu', 'Dev Container', 'codespaces']);
	});

	test('worktree base labels preserve explicit refs while implicit HEAD uses its actual checkout', () => {
		const { worktreeBaseLabel } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
		const plan = { source: MAIN.id, branch: 'fix', baseRef: 'HEAD', baseCommit: 'abc', destination: '/work/fix' };
		assert.strictEqual(worktreeBaseLabel(plan, MAIN, undefined), 'main');
		assert.strictEqual(worktreeBaseLabel(plan, { ...MAIN, branch: undefined, detached: true }, undefined), 'HEAD');
		for (const explicit of ['HEAD', 'release/1', 'v1.0', 'abc123']) {
			assert.strictEqual(worktreeBaseLabel({ ...plan, baseRef: explicit }, MAIN, explicit), explicit);
		}
	});

	suite('choices', () => {
		test('LIFECYCLE-1.2: the remembered location while it is offered; else the first folder\'s first location without an unavailable-location note', () => {
			const { defaultLocation } = load<typeof import('../ui/pickers/newAgent')>(require.resolve('../ui/pickers/newAgent'));
			const catalog: Catalog = { locations: [MAIN, LOGIN, GUIDE], folders: [SHOP, DOCS], pending: false };
			assert.deepStrictEqual([
				defaultLocation(catalog, LOGIN.id),
				defaultLocation(catalog, 'loc-gone'),
				defaultLocation(catalog, undefined),
				defaultLocation({ locations: [], folders: [], pending: false }, undefined)
			], [LOGIN, MAIN, MAIN, undefined]);
		});

		test('LIFECYCLE-1.1: the last CLI used first, the others in the catalog\'s order; those whose configuration is invalid apart, with why; one not installed is not offered at all', () => {
			const { orderedClis } = load<typeof import('../ui/pickers/newAgent')>(require.resolve('../ui/pickers/newAgent'));
			const ids = (found: ReturnType<typeof orderedClis>) => [found.available.map(each => each.id), found.unavailable.map(each => each.id)];
			// Claude Code is the one built-in; another choice shows the order a catalog of several takes
			const choices = [cli('claude', 'Claude Code'), cli('other', 'Other CLI')];
			assert.deepStrictEqual([
				ids(orderedClis(choices, 'other')),
				ids(orderedClis(choices, 'gone')),
				ids(orderedClis([cli('claude', 'Claude Code', { available: false, problem: 'facade.claude.path is "/nope"' })], 'claude')),
				ids(orderedClis([cli('claude', 'Claude Code', { available: false, problem: 'claude was not found on the PATH', notInstalled: true })], undefined))
			], [[['other', 'claude'], []], [['claude', 'other'], []], [[], ['claude']], [[], []]]);
		});

		test('U06: a run ID, a short ID or a copied reference names its run exactly, whatever stale name comes with it', () => {
			const { referencedRun } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const runs = [{ id: `run-${'1'.padStart(32, '0')}`, alias: '#a1' }, { id: `run-${'2'.padStart(32, '0')}`, alias: '#a12' }];
			assert.deepStrictEqual(['#a12', '@Old Name #a1', 'Ada #a1', ` ${runs[1].id} `, 'Ada', '#a9', 'a1'].map(search => referencedRun(search, runs)?.alias), ['#a12', '#a1', '#a1', '#a12', undefined, undefined, undefined]);
		});
	});

	suite('New Agent', () => {
		let catalog: Catalog;
		let changed: TestEmitter<void>;
		let runs: RunFacts[];
		let closed: string[];
		let removing: { id: string; closeAgents: () => Promise<boolean> }[];
		let remove: WorktreePort['remove'];
		let choices: CliChoice[] | Error;
		let last: { location?: string; cli?: string };
		let launched: LaunchRequest[];
		let selected: string[];
		let errors: string[];
		let listed: string[];
		let worktrees: WorktreePort;
		let availability: Awaited<ReturnType<WorktreePort['availability']>>;
		let planned: string[];
		let created: number;

		const start = () => {
			const { newAgent } = load<typeof import('../ui/pickers/newAgent')>(require.resolve('../ui/pickers/newAgent'));
			return newAgent({
				agents: { launch: request => { launched.push(request); return 'run-new'; }, list: () => runs, close: async run => { closed.push(run); return 'terminated'; } },
				locations: { snapshot: () => catalog, refresh: async () => undefined, onDidChange: changed.event },
				clis: { list: async location => { listed.push(location.id); if (choices instanceof Error) { throw choices; } return choices; } },
				worktrees,
				history: { last: () => last, remember: () => undefined },
				select: run => selected.push(run),
				notifyError: text => errors.push(text),
				log: { event: () => undefined },
				media: { path: '/extension/media' } as never,
				suggest: () => 'Ada'
			});
		};

		setup(() => {
			catalog = { locations: [MAIN, LOGIN], folders: [SHOP], pending: false };
			choices = [cli('claude', 'Claude Code')];
			last = { location: MAIN.id, cli: 'claude' };
			launched = [];
			selected = [];
			errors = [];
			listed = [];
			availability = { available: true };
			planned = [];
			created = 0;
			changed = new TestEmitter<void>();
			runs = [];
			closed = [];
			removing = [];
			remove = async () => undefined;
			worktrees = {
				availability: async () => availability,
				plan: async (source, branch) => {
					planned.push(`${source} ${branch}`);
					if (branch.includes(' ')) {
						throw new Error(`'${branch}' is not a valid branch name.`);
					}
					return { source, branch, baseRef: 'main', baseCommit: 'abc123', destination: `/shop.worktrees/${branch.replace(/\//g, '-')}` };
				},
				create: async () => { created++; throw new Error('the UI never creates'); },
				remove: async (id, closeAgents) => { removing.push({ id, closeAgents }); await remove(id, closeAgents); }
			};
		});

		test('J02: one picker titled New Agent - the last CLI first and selected but not started, the location with its environment and the editable name at the bottom; choosing a CLI closes it and starts the agent at once, selected', async () => {
			const done = start();
			await settle();
			const picker = ui.current!;
			const shown = { title: picker.title, placeholder: picker.placeholder, labels: picker.labels(), active: picker.activeItems.map(item => item.label), where: picker.item('Change Working Location...').description, name: picker.item('Change Name...').description, launched: launched.length };
			picker.accept();
			await done;
			assert.deepStrictEqual(shown, { title: 'New Agent · Ada · main', placeholder: 'Select a CLI', labels: ['Claude Code', 'Options', 'Change Working Location...', 'Change Name...'], active: ['Claude Code'], where: 'main', name: 'Ada', launched: 0 });
			assert.deepStrictEqual([launched, selected, picker.shown, ui.current], [[{ name: 'Ada', location: MAIN.id, cli: 'claude' }], ['run-new'], false, undefined]);
		});

		test('Change Name: uses the native hint only and accepts empty labels and human; Back keeps the name it had; Escape ends the launch with nothing done (UX-1.1)', async () => {
			const done = start();
			await settle();
			ui.current!.accept('Change Name...');
			await settle();
			const box = ui.current!;
			const opened = [box.kind, box.title, box.value, box.prompt, box.validationMessage];
			box.type('  ');
			const empty = box.validationMessage;
			box.accept();
			await settle();
			const emptyLabel = [ui.current!.title, ui.current!.item('Change Name...').description];
			ui.current!.accept('Change Name...');
			await settle();
			ui.current!.type('human');
			ui.current!.accept();
			await settle();
			const renamed = ui.current!.item('Change Name...').description;
			ui.current!.accept('Change Name...');
			await settle();
			ui.current!.type('Bo');
			ui.current!.back();
			await settle();
			const backed = ui.current!.item('Change Name...').description;
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([opened, empty, emptyLabel, renamed, backed, launched, selected], [['text', 'New Agent', 'Ada', undefined, undefined], undefined, ['New Agent ·  · main', ''], 'human', 'human', [], []]);
		});

		test('LIFECYCLE-1.3, D63: a lone plain folder is said as a label, never an action that does nothing; a repository\'s only checkout still opens its step, saying why New Worktree is unavailable', async () => {
			catalog = { locations: [GUIDE], folders: [DOCS], pending: false };
			last = { location: GUIDE.id, cli: 'claude' };
			let done = start();
			await settle();
			const plain = ui.current!.labels();
			ui.current!.hide();
			await done;
			catalog = { locations: [MAIN], folders: [SHOP], pending: false };
			last = { location: MAIN.id, cli: 'claude' };
			availability = { available: false, reason: '/main has no commits yet.', problem: { kind: 'no_commit', path: '/main' } } as typeof availability;
			done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const step = [ui.current!.placeholder, ui.current!.labels(), ui.current!.item('New Worktree...').detail];
			ui.current!.accept('New Worktree...');
			await settle();
			const stayed = ui.current!.placeholder;
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([plain, step, stayed], [
				['Claude Code', 'guide', 'Change Name...'],
				['Select a branch or worktree', ['main', '', 'New Worktree...'], '/main has no commits yet.'],
				'Select a branch or worktree'
			]);
		});

		test('J02, LIFECYCLE-1.3: Change Working Location picks the folder, then the location, a single-choice step skipped; Back keeps the choices; a gone previous location falls back silently; the CLIs follow the location', async () => {
			catalog = { locations: [MAIN, LOGIN, GUIDE], folders: [SHOP, DOCS], pending: false };
			last = { location: 'loc-gone', cli: 'claude' };
			const done = start();
			await settle();
			const first = ui.current!.item('Change Working Location...');
			const said = [ui.current!.title, first.description, first.detail];
			ui.current!.accept('Change Working Location...');
			await settle();
			// A folder that opened a repository's main checkout shows as one, a plain folder as a folder
			const folders = [ui.current!.placeholder, ui.current!.labels(), ui.current!.activeItems.map(item => item.label), ui.current!.items.map(item => (item.iconPath as { id: string } | undefined)?.id), ui.current!.items.map(item => item.description)];
			ui.current!.accept('docs');
			await settle();
			// docs has one location: that step is skipped, the CLI step again for it
			const there = [ui.current!.item('Change Working Location...').description, ui.current!.item('Change Working Location...').detail, [...listed]];
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.accept('shop');
			await settle();
			const locations = [ui.current!.placeholder, ui.current!.labels(), ui.current!.items.map(item => item.description)];
			ui.current!.back();
			await settle();
			const backToFolders = ui.current!.activeItems.map(item => item.label);
			ui.current!.back();
			await settle();
			const kept = ui.current!.item('Change Working Location...').description;
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([said, folders, there, locations, backToFolders, kept, launched], [
				['New Agent · Ada · shop · main', 'shop · main', undefined],
				// Each folder's name, then the folder that holds it
				['Select a folder', ['shop', 'docs', '', 'Add Folder to Workspace...'], ['shop'], ['repo', 'folder', undefined, 'add'], ['/', '/', undefined, undefined]],
				['docs · guide', undefined, [MAIN.id, GUIDE.id]],
				['Select a branch or worktree', ['main', 'login-fix', '', 'New Worktree...'], ['/main', '/login-fix', undefined, 'from main']],
				['shop'],
				'docs · guide',
				[]
			]);
		});

		test('LIFECYCLE-1.1, UX-1.3: no folder offers Open Folder; no usable CLI offers its settings with why, and one that cannot start says its reason - Configure Agents..., the CLI and its gear each running Configure Agents', async () => {
			catalog = { locations: [], folders: [], pending: false };
			let done = start();
			await settle();
			const noFolder = ui.current!.labels();
			ui.current!.accept();
			await done;
			catalog = { locations: [MAIN], folders: [SHOP], pending: false };
			choices = [cli('claude', 'Claude Code', { available: false, problem: 'facade.claude.path is "/opt/claude", which is not a program that can be run' })];
			done = start();
			await settle();
			const picker = ui.current!;
			const noCli = [picker.labels(), picker.activeItems.map(item => item.label), picker.item('Configure Agents...').detail, picker.item('Claude Code').detail, buttonsOf(picker)];
			picker.accept('Claude Code');
			await done;
			for (const configure of [(step: Input) => step.accept('Configure Agents...'), (step: Input) => step.press(step.labels().indexOf('Claude Code'), step.item('Claude Code').buttons![0])]) {
				done = start();
				await settle();
				configure(ui.current!);
				await done;
			}
			// Nothing installed at all: Configure Agents with why, and no list of what is not installed
			choices = [cli('claude', 'Claude Code', { available: false, problem: 'claude was not found on the PATH', notInstalled: true })];
			done = start();
			await settle();
			const nothing = ui.current!.labels();
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([noFolder, noCli, nothing, ui.commands, launched], [
				['Open Folder...'],
				[['Configure Agents...', 'Unavailable', 'Claude Code', 'Options', 'Change Working Location...', 'Change Name...'], ['Configure Agents...'], 'Install a supported CLI in this environment, or configure its path.', 'facade.claude.path is "/opt/claude", which is not a program that can be run', [['Claude Code', 'gear: Configure Agents']]],
				['Configure Agents...', 'Options', 'Change Working Location...', 'Change Name...'],
				[['vscode.openFolder'], ['facade.configureAgents'], ['facade.configureAgents'], ['facade.configureAgents']],
				[]
			]);
		});

		test('LIFECYCLE-1.3, WORKTREES-2.1: New Worktree, where the repository can have one, asks its branch - prefilled with git.branchPrefix, checked as it is typed - and is made only by the launch the CLI accepts', async () => {
			// An opened subfolder remains the default/source even though the picker puts the main checkout first.
			const APP: WorkspaceFolderInfo = { index: 0, name: 'app', uri: 'file:///main/app', path: '/main/app' };
			const opened = place('loc-app', 'app', APP, { path: APP.path, uri: APP.uri, opened: true, branch: 'main' });
			catalog = { locations: [opened, { ...MAIN, folders: [APP], opened: false }, { ...LOGIN, folders: [APP] }], folders: [APP], pending: false };
			last = { cli: 'claude' };
			ui.branchPrefix = 'feat/';
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const step = [ui.current!.labels(), ui.current!.activeItems.map(item => item.label), ui.current!.item('New Worktree...').description];
			ui.current!.accept('New Worktree...');
			await settle();
			const box = ui.current!;
			const branchInput = [box.kind, box.value, box.placeholder, box.prompt];
			box.type('  ');
			const empty = box.validationMessage;
			box.type('feat/bad name');
			await new Promise(resolve => setTimeout(resolve, 250));
			const refused = [box.validationMessage, box.busy];
			box.type('feat/login');
			box.accept();
			await settle();
			await settle();
			const chosen = [ui.current!.title, ui.current!.item('Change Working Location...').description];
			ui.current!.accept('Claude Code');
			await done;
			assert.deepStrictEqual([step, branchInput, empty, refused, chosen, planned, created, launched], [
				[['main', 'app', 'login-fix', '', 'New Worktree...'], ['app'], 'from main'],
				['text', 'feat/', 'Branch name', 'Starts from main'],
				'Enter a branch name.',
				['\'feat/bad name\' is not a valid branch name.', false],
				['New Agent · Ada · feat/login (new)', 'New worktree feat/login from main'],
				['loc-app feat/bad name', 'loc-app feat/login'],
				0,
				[{ name: 'Ada', location: opened.id, cli: 'claude', worktree: { branch: 'feat/login' } }]
			]);
		});

		test('Back from the branch keeps the location chosen; Escape there makes nothing; a prerequisite missing is said and cannot be chosen; a plain folder offers no worktree (LIFECYCLE-1.3, PANEL-1.2)', async () => {
			let done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.accept('New Worktree...');
			await settle();
			ui.current!.back();
			await settle();
			const backToStep = ui.current!.labels();
			ui.current!.back();
			await settle();
			const kept = ui.current!.item('Change Working Location...').description;
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.accept('New Worktree...');
			await settle();
			ui.current!.hide();
			await done;
			availability = { available: false, reason: 'shop has no commits yet' };
			done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const step = ui.current!;
			const reason = step.item('New Worktree...').detail;
			step.accept('New Worktree...');
			await settle();
			const stayed = ui.current === step;
			step.hide();
			await done;
			catalog = { locations: [GUIDE, place('loc-notes', 'notes', DOCS, { kind: 'folder' })], folders: [DOCS], pending: false };
			last = { location: GUIDE.id, cli: 'claude' };
			done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const plain = ui.current!.labels();
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([backToStep, kept, reason, stayed, plain, launched, created], [['main', 'login-fix', '', 'New Worktree...'], 'main', 'shop has no commits yet', true, ['guide', 'notes'], [], 0]);
		});

		test('UX-2.4: Facade\'s own reasons a worktree cannot be made are said in the person\'s words, Git\'s own words kept as Git said them; an answer with no problem keeps its reason', async () => {
			availability = { available: false, reason: '/main has no commits yet.', problem: { kind: 'no_commit', path: '/main' } } as typeof availability;
			worktrees = {
				...worktrees,
				plan: async (_source, branch) => {
					throw Object.assign(new Error(`English for agents: ${branch}`), branch.endsWith('x')
						? { problem: { kind: 'git_failed', path: '/main', detail: 'fatal: bad object' } }
						: { problem: { kind: 'folder_name', name: branch, why: 'device' } });
				}
			};
			let done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const unavailable = ui.current!.item('New Worktree...').detail;
			ui.current!.hide();
			await done;
			availability = { available: true };
			done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.accept('New Worktree...');
			await settle();
			const box = ui.current!;
			box.type('nul');
			box.accept();
			await settle();
			const device = box.validationMessage;
			box.type('x');
			box.accept();
			await settle();
			const git = box.validationMessage;
			box.hide();
			await done;
			assert.deepStrictEqual([unavailable, device, git], [
				'/main has no commits yet.',
				'"nul" is a name Windows keeps for a device, so a folder cannot have it.',
				'Git could not read /main: fatal: bad object'
			]);
		});

		test('D73, LIFECYCLE-1.3: the folder step ends in Add Folder to Workspace... and offers removing each folder while another stays; a single-folder window has no folder step, so neither', async () => {
			catalog = { locations: [MAIN, LOGIN, GUIDE], folders: [SHOP, DOCS], pending: false };
			let done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const several = [ui.current!.labels(), buttonsOf(ui.current!)];
			ui.current!.hide();
			await done;
			catalog = { locations: [MAIN, LOGIN], folders: [SHOP], pending: false };
			done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const single = [ui.current!.placeholder, ui.current!.labels()];
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([several, single], [
				[['shop', 'docs', '', 'Add Folder to Workspace...'], [['shop', 'close: Remove Folder from Workspace'], ['docs', 'close: Remove Folder from Workspace']]],
				['Select a branch or worktree', ['main', 'login-fix', '', 'New Worktree...']]
			]);
		});

		test('D73: Add Folder to Workspace... is the editor\'s own command, run with the step hidden; cancelled, the step is as it was; folders added, the step again with the first added selected', async () => {
			catalog = { locations: [MAIN, LOGIN, GUIDE], folders: [SHOP, DOCS], pending: false };
			ui.workspaceFolders = [SHOP, DOCS];
			const API: WorkspaceFolderInfo = { index: 2, name: 'api', uri: 'file:///api', path: '/api' };
			const WEB: WorkspaceFolderInfo = { index: 3, name: 'web', uri: 'file:///web', path: '/web' };
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.accept('Add Folder to Workspace...');
			await settle();
			const cancelled = [ui.current!.labels(), ui.current!.activeItems.map(item => item.label), [...ui.commands]];
			// The editor appends the folders chosen in its dialog; the catalog has them a moment after its command returns
			ui.addRootFolder = () => {
				ui.workspaceFolders = [SHOP, DOCS, API, WEB];
				setImmediate(() => {
					catalog = { locations: [MAIN, LOGIN, GUIDE, place('loc-api', 'api', API, { kind: 'folder', opened: true }), place('loc-web', 'web', WEB, { kind: 'folder', opened: true })], folders: [SHOP, DOCS, API, WEB], pending: false };
					changed.fire();
				});
			};
			ui.current!.accept('Add Folder to Workspace...');
			await settle();
			await settle();
			const added = [ui.current!.placeholder, ui.current!.labels(), ui.current!.activeItems.map(item => item.label)];
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([ui.dialogs, cancelled, added, ui.commands, ui.updates, launched], [
				[{ kind: 'addFolder', args: [], over: undefined }, { kind: 'addFolder', args: [], over: undefined }],
				[['shop', 'docs', '', 'Add Folder to Workspace...'], ['shop'], [['workbench.action.addRootFolder']]],
				['Select a folder', ['shop', 'docs', 'api', 'web', '', 'Add Folder to Workspace...'], ['api']],
				[['workbench.action.addRootFolder'], ['workbench.action.addRootFolder']],
				// The editor's command adds them: Facade asks for no change of the folders itself
				[],
				[]
			]);
		});

		test('D73: a folder\'s X asks first, saying the agents its removal closes, and Cancel does nothing; Remove calls updateWorkspaceFolders(index, 1) and leaves its agents to the removal; one folder left goes on to its locations', async () => {
			catalog = { locations: [MAIN, LOGIN, GUIDE], folders: [SHOP, DOCS], pending: false };
			last = { location: GUIDE.id, cli: 'claude' };
			runs = [runAt(1, GUIDE), runAt(2, GUIDE), runAt(3, MAIN)];
			ui.folders = () => {
				catalog = { locations: [MAIN, LOGIN], folders: [SHOP], pending: false };
				changed.fire();
			};
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.press(0, ui.current!.items[0].buttons![0]);
			await settle();
			const back = [ui.current!.placeholder, ui.current!.labels(), [...ui.updates]];
			ui.current!.press(1, ui.current!.items[1].buttons![0]);
			await settle();
			ui.answer = 'Remove';
			ui.current!.press(1, ui.current!.items[1].buttons![0]);
			await settle();
			await settle();
			const left = [ui.current!.placeholder, ui.current!.labels()];
			// Back: the CLI step again, its location one that is still there
			ui.current!.back();
			await settle();
			const cli = ui.current!.item('Change Working Location...').description;
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([ui.dialogs, back, ui.updates, left, cli, closed, launched], [
				[
					{ kind: 'warning', args: ['Remove "shop" from this workspace? Files stay on disk.', { modal: true, detail: 'Its agent will be closed.' }, 'Remove'], over: undefined },
					{ kind: 'warning', args: ['Remove "docs" from this workspace? Files stay on disk.', { modal: true, detail: '2 associated agents will be closed.' }, 'Remove'], over: undefined },
					{ kind: 'warning', args: ['Remove "docs" from this workspace? Files stay on disk.', { modal: true, detail: '2 associated agents will be closed.' }, 'Remove'], over: undefined }
				],
				['Select a folder', ['shop', 'docs', '', 'Add Folder to Workspace...'], []],
				[[1, 1]],
				['Select a branch or worktree', ['main', 'login-fix', '', 'New Worktree...']],
				'main',
				// The location service's removal closes them (WORKTREES-3.3), not the picker
				[],
				[]
			]);
		});

		test('D73: the location step offers Delete Worktree on linked worktrees alone - not on the main checkout, a plain folder, a worktree a workspace folder opened or one a workspace folder is in', async () => {
			const NOTES: WorkspaceFolderInfo = { index: 1, name: 'notes', uri: 'file:///holder/notes', path: '/holder/notes' };
			catalog = {
				locations: [
					MAIN, LOGIN, place('loc-loose', 'loose', SHOP, { detached: true }), place('loc-holder', 'holder', SHOP, { branch: 'holder' }),
					place('loc-notes', 'notes', NOTES, { path: '/holder/notes', opened: true }),
					GUIDE, place('loc-extra', 'extra', DOCS, { kind: 'folder' })
				],
				folders: [SHOP, NOTES, DOCS],
				pending: false
			};
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const offered: unknown[] = [];
			for (const folder of ['shop', 'notes', 'docs']) {
				ui.current!.accept(folder);
				await settle();
				offered.push([ui.current!.labels(), buttonsOf(ui.current!)]);
				ui.current!.back();
				await settle();
			}
			ui.current!.hide();
			await done;
			assert.deepStrictEqual(offered, [
				[['main', 'login-fix', 'loose', 'holder', '', 'New Worktree...'], [['login-fix', 'close: Delete Worktree'], ['loose', 'close: Delete Worktree']]],
				[['notes', '', 'New Worktree...'], []],
				[['guide', 'extra'], []]
			]);
		});

		test('D73: Delete Worktree asks first - its folder, the branch kept, its agents - and Cancel does nothing; confirmed, the step is back at once without it, busy until it is gone, its own agents closed by the deletion', async () => {
			runs = [runAt(1, LOGIN), runAt(2, MAIN)];
			let release!: () => void;
			remove = async (_id, closeAgents) => {
				await closeAgents();
				await new Promise<void>(resolve => { release = resolve; });
				catalog = { locations: [MAIN], folders: [SHOP], pending: false };
				changed.fire();
			};
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.press(1, ui.current!.items[1].buttons![0]);
			await settle();
			const cancelled = [ui.current!.labels(), removing.length];
			ui.answer = 'Delete';
			ui.current!.press(1, ui.current!.items[1].buttons![0]);
			await settle();
			const during = [ui.current!.labels(), ui.current!.busy, buttonsOf(ui.current!), [...closed]];
			release();
			await settle();
			const after = [ui.current!.labels(), ui.current!.busy];
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([ui.dialogs[0], cancelled, removing.map(each => each.id), during, after, errors], [
				{ kind: 'warning', args: ['Delete worktree "login-fix"?', { modal: true, detail: 'Folder /login-fix will be deleted; branch login-fix is kept.\n\nIts agent will be closed.' }, 'Delete'], over: undefined },
				[['main', 'login-fix', '', 'New Worktree...'], 0],
				[LOGIN.id],
				[['main', '', 'New Worktree...'], true, [], ['run-1']],
				[['main', '', 'New Worktree...'], false],
				[]
			]);
		});

		test('D73: a refused deletion is said - changes not committed, Git\'s own refusal - with the worktree back in the step and no agent closed by the picker; a detached worktree is asked about without a branch', async () => {
			catalog = { locations: [MAIN, LOGIN, place('loc-loose', 'loose', SHOP, { detached: true })], folders: [SHOP], pending: false };
			runs = [runAt(1, LOGIN)];
			ui.answer = 'Delete';
			remove = async () => { throw Object.assign(new Error('English for agents'), { problem: { kind: 'worktree_changed', name: 'login-fix' } }); };
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.press(1, ui.current!.items[1].buttons![0]);
			await settle();
			await settle();
			const refused = [ui.current!.labels(), ui.current!.busy];
			remove = async () => { throw Object.assign(new Error('English for agents'), { problem: { kind: 'deletion_failed', name: 'login-fix', detail: 'fatal: cannot remove a locked working tree' } }); };
			ui.current!.press(1, ui.current!.items[1].buttons![0]);
			await settle();
			await settle();
			ui.answer = undefined;
			ui.current!.press(2, ui.current!.items[2].buttons![0]);
			await settle();
			const loose = ui.dialogs.at(-1);
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([refused, errors, closed, loose], [
				[['main', 'login-fix', 'loose', '', 'New Worktree...'], false],
				['Cannot delete worktree "login-fix": uncommitted changes present. Commit or stash them with Git, then try again.', 'Could not delete worktree "login-fix": fatal: cannot remove a locked working tree'],
				[],
				{ kind: 'warning', args: ['Delete worktree "loose"?', { modal: true, detail: 'Folder /loose will be deleted (detached HEAD).' }, 'Delete'], over: undefined }
			]);
		});
	});

	suite('Go to Agent', () => {
		const run = (n: number, more: Partial<RunFacts> = {}): RunFacts => ({
			id: `run-${String(n).padStart(32, '0')}`, alias: `#a${n}`, name: 'Ada', cli: 'claude', displayName: 'Claude Code', command: 'claude', location: MAIN.id,
			cwd: MAIN.path, environment: 'local', yolo: true, createdAt: n, lifecycle: 'running', phase: 'running',
			activity: 'working', reporting: true, ...more
		});

		test('U06, LIFECYCLE-2.3: this window\'s agents, one line each - the name, then short ID, CLI, state, location and title, searched alike - duplicates told apart by short ID; an ID or copied reference finds its run; each copies or closes; choosing shows its terminal', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			let runs = [run(1, { title: 'Fix login' }), run(2, { lifecycle: 'ended', end: { kind: 'failed', at: 1 }, error: { reason: 'Not found', source: 'launch', at: 1 } }), run(3, { lifecycle: 'starting', phase: 'launching_cli' })];
			const changed = new TestEmitter<void>();
			const did: string[] = [];
			const words = {
				worktreeFailure: (reason: string) => reason,
				starting: 'Starting', startingCli: (cli: string) => `Starting ${cli}...`, working: 'Working', notWorking: 'Idle', error: (reason: string) => `Error: ${reason}`, activityUnavailable: 'Activity unavailable', readyForInput: 'Ready for input', needsPermission: 'Needs permission', needsSignIn: 'Sign-in required', hasQuestion: 'Waiting for an answer', creatingWorktree: 'Creating worktree...',
				exitedWithCode: (code: string) => `Exited with code ${code}`, endedBySignal: (signal: string) => `Ended by signal ${signal}`, window: (label: string) => `Window: ${label}`
			};
			const done = goToAgent({
				model: { ordered: () => runs, placeOf: () => ({ label: 'main', qualified: 'main', full: 'main' }) },
				agents: { onDidChange: changed.event as never },
				words,
				media: { path: '/extension/media' } as never,
				reveal: async run => void did.push(`reveal ${run}`),
				copyReference: async run => void did.push(`copy ${run}`),
				close: async run => { did.push(`close ${run}`); runs = runs.filter(each => each.id !== run); changed.fire(); }
			});
			const picker = ui.current!;
			const listed = picker.items.map(item => [item.label, item.description, item.detail]);
			const searched = [picker.matchOnDescription, picker.matchOnDetail];
			picker.type('#a2');
			const byId = picker.items.map(item => [item.description, item.alwaysShow]);
			picker.type('@Grace #a1');
			const byReference = picker.items.map(item => item.description);
			picker.type('Ada');
			const all = picker.items.length;
			const [copy, close] = picker.items[1].buttons!;
			picker.press(0, copy);
			picker.press(1, close);
			await settle();
			const afterClose = picker.items.map(item => item.description);
			picker.accept();
			await done;
			assert.deepStrictEqual([picker.title, listed, searched, byId, byReference, all, afterClose, did], [
				'Go to Agent',
				[['Ada', '#a1 · Claude Code · Working · main · Fix login', undefined], ['Ada', '#a2 · Claude Code · Error: Not found · main', undefined], ['Ada', '#a3 · Claude Code · Starting · main', undefined]],
				[true, false],
				[['#a2 · Claude Code · Error: Not found · main', true]],
				['#a1 · Claude Code · Working · main · Fix login'],
				3,
				['#a1 · Claude Code · Working · main · Fix login', '#a3 · Claude Code · Starting · main'],
				[`copy ${run(1).id}`, `close ${run(2).id}`, `reveal ${run(1).id}`]
			]);
		});
	});
});

