/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { tempDir } from './util';
import type { Catalog, ConversationEntry, CliChoice, CliChoices, LaunchRequest, Location, RunFacts, WorkspaceFolderInfo, WorktreePort } from '../core/ports';
import type { PanelFilter } from '../webview/protocol';
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
// The location a folder opened has the folder's own URI, as the catalog gives it
const MAIN = place('loc-main', 'main', SHOP, { opened: true, isMain: true, uri: SHOP.uri });
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

suite('Pickers: New Agent, Change Working Location, Change Name, Filter, Go to Agent (LIFECYCLE-1, 2, PANEL-2.3)', () => {
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
		/** What no CLI stands for: `facade.custom` wrong as a whole (CLIS-3.4). */
		let problems: CliChoices['problems'] = [];
		let last: { location?: string; cli?: string };
		let launched: LaunchRequest[];
		let selected: string[];
		let errors: string[];
		let listed: string[];
		let worktrees: WorktreePort;
		let availability: Awaited<ReturnType<WorktreePort['availability']>>;
		let planned: string[];
		let created: number;

		const start = (startAt?: string) => {
			const { newAgent } = load<typeof import('../ui/pickers/newAgent')>(require.resolve('../ui/pickers/newAgent'));
			return newAgent({
				agents: { launch: request => { launched.push(request); return 'run-new'; }, list: () => runs, close: async run => { closed.push(run); return 'terminated'; } },
				locations: { snapshot: () => catalog, refresh: async () => undefined, onDidChange: changed.event },
				clis: { list: async location => { listed.push(location.id); if (choices instanceof Error) { throw choices; } return { clis: choices, problems }; } },
				worktrees,
				history: { last: () => last, remember: () => undefined },
				select: run => selected.push(run),
				notifyError: text => errors.push(text),
				log: { event: () => undefined },
				media: { path: '/extension/media' } as never,
				suggest: () => 'Ada'
			}, startAt);
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

		test('from the filtered empty panel it starts at the filtered location, still changeable; one no longer offered gives way to the remembered location (LIFECYCLE-1.2)', async () => {
			let done = start(LOGIN.id);
			await settle();
			const filtered = { title: ui.current!.title, where: ui.current!.item('Change Working Location...').description };
			ui.current!.accept();
			await done;
			done = start('loc-gone');
			await settle();
			const gone = ui.current!.title;
			ui.current!.accept();
			await done;
			assert.deepStrictEqual([filtered, gone, launched.map(request => request.location)], [
				{ title: 'New Agent · Ada · login-fix', where: 'login-fix' },
				'New Agent · Ada · main',
				[LOGIN.id, MAIN.id]
			]);
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
			// A wrong facade.custom defines no CLI, so it is said by its setting, with the way to the settings (CLIS-3.4)
			problems = [{ setting: 'facade.custom', problem: 'facade.custom must be an object of custom CLIs by ID; received array', said: { kind: 'custom_type', values: ['facade.custom', 'array'] } }];
			done = start();
			await settle();
			const broken = [ui.current!.labels(), ui.current!.item('facade.custom').detail];
			ui.current!.accept('facade.custom');
			await done;
			problems = [];
			assert.deepStrictEqual([noFolder, noCli, nothing, broken, ui.commands, launched], [
				['Open Folder...'],
				[['Configure Agents...', 'Unavailable', 'Claude Code', 'Options', 'Change Working Location...', 'Change Name...'], ['Configure Agents...'], 'Install a supported CLI in this environment, or configure its path.', 'facade.claude.path is "/opt/claude", which is not a program that can be run', [['Claude Code', 'gear: Configure Agents']]],
				['Configure Agents...', 'Options', 'Change Working Location...', 'Change Name...'],
				[['Configure Agents...', 'Unavailable', 'facade.custom', 'Options', 'Change Working Location...', 'Change Name...'], 'facade.custom must be an object of custom CLIs by ID; received array'],
				[['vscode.openFolder'], ['facade.configureAgents'], ['facade.configureAgents'], ['facade.configureAgents'], ['facade.configureAgents']],
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

		test('Back from the branch step keeps New Worktree chosen on the step it returns to, and the branch typed, there again as the step comes back (UX-1.1)', async () => {
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.accept('New Worktree...');
			await settle();
			ui.current!.type('feature-x');
			await new Promise(resolve => setTimeout(resolve, 200));
			ui.current!.back();
			await settle();
			const active = ui.current!.activeItems.map(item => item.label);
			ui.current!.accept('New Worktree...');
			await settle();
			const value = ui.current!.value;
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([active, value], [['New Worktree...'], 'feature-x']);
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

	suite('Resume Agent', () => {
		const NOW = Date.UTC(2026, 9, 28, 12);
		const entry = (n: number, more: Partial<ConversationEntry> = {}): ConversationEntry => ({
			key: { environment: 'local', cli: n % 2 ? 'claude' : 'codex', sessionId: `s${n}` }, title: `Conversation ${n}`,
			cwd: n % 3 ? MAIN.path : `${LOGIN.path}/api`, activityAt: NOW - n * 60_000, ...more
		});
		let scopes: unknown[];
		let reads: number;
		let disposed: boolean;
		let did: string[];
		let resumedCwds: string[];
		let errors: string[];
		const open = (batches: readonly ConversationEntry[][], result: string | { running: string } = 'run-new', locations: readonly Location[] = [MAIN, LOGIN], running: readonly string[] = []) => {
			const { resumeAgent } = load<typeof import('../ui/pickers/resume')>(require.resolve('../ui/pickers/resume'));
			reads = 0;
			return resumeAgent({
				conversations: { open: scope => { scopes.push(scope); return { next: async () => { const entries = batches[reads] ?? []; reads++; return { entries, done: reads >= batches.length }; }, dispose: () => { disposed = true; } }; } },
				locations: { snapshot: () => ({ locations, folders: [SHOP], pending: false }) },
				running: key => running.includes(key.sessionId),
				resume: chosen => { resumedCwds.push(chosen.cwd); assert.strictEqual(chosen.cwdChoices, undefined); did.push(`resume ${chosen.key.sessionId}`); return result as never; },
				reveal: async run => void did.push(`reveal ${run}`),
				select: run => void did.push(`select ${run}`),
				notifyError: text => errors.push(text),
				media: { path: '/extension/media' } as never,
				language: 'en',
				now: () => NOW
			});
		};

		setup(() => {
			scopes = []; reads = 0; disposed = false; did = []; resumedCwds = []; errors = [];
		});

		test('LIFECYCLE-3.2: this window\'s locations\' histories, recent first, 100 at a time as the person scrolls on, every batch as they search, nothing read twice', async () => {
			const all = Array.from({ length: 250 }, (_, n) => entry(n));
			const done = open([all.slice(0, 100), all.slice(100, 200), all.slice(200)]);
			await settle();
			const picker = ui.current!;
			const first = [picker.title, picker.items.length, reads, picker.items.slice(0, 2).map(item => [item.label, item.description, item.detail])];
			picker.activate(50);
			await settle();
			const early = reads;
			picker.activate(95);
			await settle();
			const scrolled = [picker.items.length, reads];
			picker.type('Conversation 249');
			await settle();
			await settle();
			const searched = [picker.items.length, reads, picker.busy];
			picker.type('Conversation 2');
			picker.activate(picker.items.length - 1);
			await settle();
			picker.hide();
			await done;
			assert.deepStrictEqual([scopes, first, early, scrolled, searched, reads, disposed], [
				[{ environment: 'local', directories: [MAIN.path, LOGIN.path] }],
				['Resume Agent', 100, 1, [['Conversation 0', 'now \u00b7 login-fix/api', undefined], ['Conversation 1', '1 min. ago \u00b7 main', undefined]]],
				1,
				[200, 2],
				[250, 3, false],
				3,
				true
			]);
		});

		test('D64: each conversation is one line - its icon naming the CLI, then time and location; no CLI name or source as text', async () => {
			const done = open([[entry(4), entry(2)]]);
			await settle();
			const lines = ui.current!.items.map(item => [item.description, item.detail]);
			ui.current!.hide();
			await done;
			assert.deepStrictEqual(lines, [['2 min. ago \u00b7 main', undefined], ['4 min. ago \u00b7 main', undefined]]);
		});

		test('a location is named for a conversation its CLI recorded by the folder\'s other path - macOS\'s /var is /private/var', async () => {
			const temp = tempDir('fd-resume-');
			try {
				fs.mkdirSync(path.join(temp.dir, 'real', 'shop', 'api'), { recursive: true });
				fs.symlinkSync(path.join(temp.dir, 'real'), path.join(temp.dir, 'link'), 'junction');
				const linked = { ...MAIN, path: path.join(temp.dir, 'link', 'shop') };
				const real = fs.realpathSync.native(path.join(temp.dir, 'real', 'shop'));
				const done = open([[entry(1, { cwd: real }), entry(2, { cwd: path.join(real, 'api') })]], 'run-new', [linked]);
				await settle();
				const lines = ui.current!.items.map(item => item.description);
				ui.current!.hide();
				await done;
				assert.deepStrictEqual(lines, ['1 min. ago \u00b7 main', '2 min. ago \u00b7 main/api']);
			} finally {
				temp.remove();
			}
		});

		test('D69: a conversation an agent already holds - resumed here, or running in another window - is not listed again', async () => {
			const done = open([[entry(1), entry(2), entry(3)]], 'run-new', [MAIN, LOGIN], ['s1', 's3']);
			await settle();
			const listed = ui.current!.items.map(item => item.label);
			ui.current!.hide();
			await done;
			assert.deepStrictEqual(listed, ['Conversation 2']);
		});

		test('a native workspace set asks for its working location; Cancel launches nothing, and selection supplies the exact chosen cwd', async () => {
			const batch = [[entry(1, { cwdChoices: [MAIN.path, LOGIN.path] })]];
			let done = open(batch); await settle(); ui.current!.accept('Conversation 1'); await settle();
			assert.strictEqual(ui.current!.placeholder, 'Select a working location');
			ui.current!.hide(); await done; assert.deepStrictEqual(did, []);
			done = open(batch); await settle(); ui.current!.accept('Conversation 1'); await settle();
			ui.current!.accept('login-fix'); await done;
			assert.deepStrictEqual(resumedCwds, [LOGIN.path]);
		});

		test('a conversation listed twice shows once; one that cannot be resumed is not listed (D64); choosing one resumes it, shows the one already running here, or says it runs in another window (LIFECYCLE-3.2, 3.3)', async () => {
			const batch = [entry(1), entry(2, { unavailable: 'Codex cannot resume this conversation exactly' }), entry(1), entry(3)];
			let done = open([batch]);
			await settle();
			const picker = ui.current!;
			const listed = picker.items.map(item => item.label);
			picker.accept('Conversation 1');
			await done;
			done = open([batch], { running: 'run-here' });
			await settle();
			ui.current!.accept('Conversation 3');
			await done;
			done = open([batch], { running: 'elsewhere' });
			await settle();
			ui.current!.accept('Conversation 3');
			await done;
			assert.deepStrictEqual([listed, did, errors], [
				['Conversation 1', 'Conversation 3'],
				['resume s1', 'select run-new', 'resume s3', 'reveal run-here', 'resume s3'],
				['Conversation 3 is already running in another window.']
			]);
		});
	});

	suite('Filter by Working Location', () => {
		test('folder, location and temporarily missing filter labels preserve literal theme-icon syntax', () => {
			const { filterItems, folderItems } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const folder = { ...SHOP, name: '$(rocket) shop' };
			const main = { ...MAIN, label: '$(git-branch) main', folders: [folder] };
			const catalog = { folders: [folder, DOCS], locations: [main, LOGIN, GUIDE], pending: false };
			const model = { count: () => 1, currentFilter: () => undefined };
			assert.ok(filterItems(model, catalog).some(item => item.label === '\\$(rocket) shop'));
			assert.ok(folderItems(model, catalog, folder).some(item => item.label === '\\$(git-branch) main'));
			const missing = { kind: 'location' as const, id: 'missing', label: '$(warning) missing' };
			const item = filterItems({ ...model, currentFilter: () => missing }, catalog).at(-1)!;
			assert.strictEqual(item.label, '\\$(warning) missing');
			assert.deepStrictEqual(item.filter, missing, 'display escaping never changes the saved filter');
		});

		const counts: Record<string, number> = { all: 5, [MAIN.id]: 2, [LOGIN.id]: 1, [GUIDE.id]: 2, [SHOP.uri]: 3, [DOCS.uri]: 2 };
		const modelWith = (current?: PanelFilter, more: Record<string, number> = {}) => {
			const set: (PanelFilter | undefined)[] = [];
			return { set, model: { count: (filter: PanelFilter | undefined) => ({ ...counts, ...more })[filter?.id ?? 'all'] ?? 0, currentFilter: () => current, setFilter: (filter: PanelFilter | undefined) => void set.push(filter) } };
		};
		const two: Catalog = { locations: [MAIN, LOGIN, GUIDE], folders: [SHOP, DOCS], pending: false };
		const one: Catalog = { locations: [MAIN, LOGIN], folders: [SHOP], pending: false };
		const locationsOf = (catalog: () => Catalog, changed = new TestEmitter<void>()) => ({ snapshot: catalog, refresh: async () => undefined, onDidChange: changed.event });
		const log = { event: () => undefined };
		const show = (items: readonly { readonly label: string; readonly description?: string; readonly kind?: number }[]) => items.map(item => item.description ? `${item.label} (${item.description})` : item.kind === -1 ? `--${item.label}--` : item.label);
		const does = (items: readonly { readonly folder?: unknown; readonly filter?: 'all' | PanelFilter }[]) => items.map(item => item.folder ? 'step' : item.filter === 'all' ? 'all' : item.filter?.kind ?? '');
		const active = () => ui.current!.activeItems.map(item => item.label);
		/** The step the picker opens with, for `current`, and nothing chosen. */
		const opened = async (catalog: Catalog, current?: PanelFilter, more?: Record<string, number>) => {
			const { pickFilter } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const { set, model } = modelWith(current, more);
			const picking = pickFilter(model as never, locationsOf(() => catalog), log);
			await settle();
			const shown = [ui.current!.labels(), active()];
			ui.current!.hide();
			await picking;
			assert.deepStrictEqual(set, []);
			return shown;
		};

		test('PANEL-2.3, D82: steps by folder - All Locations, then each folder with cards, one in two or more locations opening All Worktrees and its locations, main checkout first, any other filtering at once; a window of one folder shows that step alone, All Locations outside Git; one separator, below each step\'s first item', () => {
			const { filterItems, folderItems } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const first = filterItems(modelWith().model, two);
			assert.deepStrictEqual([
				show(first),
				does(first),
				show(folderItems(modelWith().model, two, SHOP)),
				show(folderItems(modelWith().model, { locations: [LOGIN, GUIDE, MAIN], folders: [SHOP, DOCS], pending: false }, SHOP)),
				show(filterItems(modelWith().model, one)),
				show(filterItems(modelWith().model, { locations: [GUIDE], folders: [DOCS], pending: false })),
				show(filterItems(modelWith().model, { locations: [], folders: [], pending: false })),
				show(filterItems(modelWith(undefined, { all: 3, [GUIDE.id]: 0, [DOCS.uri]: 0 }).model, two))
			], [
				['All Locations (5 agents)', '----', 'shop (3 agents)', 'docs (2 agents)'],
				['all', '', 'step', 'folder'],
				['All Worktrees (3 agents)', '----', 'main (2 agents)', 'login-fix (1 agent)'],
				['All Worktrees (3 agents)', '----', 'main (2 agents)', 'login-fix (1 agent)'],
				['All Worktrees (5 agents)', '----', 'main (2 agents)', 'login-fix (1 agent)'],
				['All Locations (5 agents)', '----', 'guide (2 agents)'],
				['All Locations (5 agents)'],
				['All Locations (3 agents)', '----', 'shop (3 agents)']
			]);
		});

		test('a filtered location alone with cards in its folder opens the folder\'s step, where it stays in sight and Enter keeps it; one in a plain folder filters by the folder at once (PANEL-2.3, D82)', () => {
			const { filterItems, folderItems } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const login = modelWith({ kind: 'location', id: LOGIN.id, label: 'shop · login-fix' }, { all: 1, [MAIN.id]: 0, [GUIDE.id]: 0, [SHOP.uri]: 1, [DOCS.uri]: 0 }).model;
			const guide = modelWith({ kind: 'location', id: GUIDE.id, label: 'docs · guide' }, { all: 2, [MAIN.id]: 0, [LOGIN.id]: 0, [SHOP.uri]: 0 }).model;
			assert.deepStrictEqual([
				show(filterItems(login, two)),
				does(filterItems(login, two)),
				show(folderItems(login, two, SHOP)),
				show(filterItems(guide, two)),
				does(filterItems(guide, two))
			], [
				['All Locations (1 agent)', '----', 'shop (1 agent)'],
				['all', '', 'step'],
				['All Worktrees (1 agent)', '----', 'login-fix (1 agent)'],
				['All Locations (2 agents)', '----', 'docs (2 agents)'],
				['all', '', 'folder']
			]);
		});

		test('the current filter is highlighted - a location through its folder, then itself in the folder\'s step, titled with the folder, listed with no card left; Back returns to the first step at the folder; Escape in either step changes nothing (PANEL-2.3, D82)', async () => {
			const { pickFilter } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const { set, model } = modelWith({ kind: 'location', id: LOGIN.id, label: 'shop · login-fix' }, { [LOGIN.id]: 0 });
			let picking = pickFilter(model as never, locationsOf(() => two), log);
			await settle();
			const first = [ui.current!.title, ui.current!.placeholder, ui.current!.labels(), active(), ui.current!.buttons.length];
			ui.current!.accept('shop');
			await settle();
			const inFolder = [ui.current!.title, ui.current!.placeholder, show(ui.current!.items), active(), ui.current!.buttons.length];
			ui.current!.back();
			await settle();
			const back = [ui.current!.labels(), active()];
			ui.current!.hide();
			await picking;
			picking = pickFilter(model as never, locationsOf(() => two), log);
			await settle();
			ui.current!.accept('shop');
			await settle();
			ui.current!.hide();
			await picking;
			assert.deepStrictEqual([first, inFolder, back, set], [
				['Filter by Working Location', 'Select a working location to show its agents', ['All Locations', '', 'shop', 'docs'], ['shop'], 0],
				['Filter by Working Location · shop', 'Select a worktree to show its agents', ['All Worktrees (3 agents)', '----', 'main (2 agents)', 'login-fix (0 agents)'], ['login-fix'], 1],
				[['All Locations', '', 'shop', 'docs'], ['shop']],
				[]
			]);
		});

		test('a folder filter is highlighted at its folder, then at All Worktrees, and at the first item in a window of one folder; a filtered location the catalog does not list now stays last, highlighted, in either window (PANEL-2.3)', async () => {
			const shop: PanelFilter = { kind: 'folder', id: SHOP.uri, label: 'shop' };
			const gone: PanelFilter = { kind: 'location', id: 'loc-gone', label: 'shop · gone' };
			const { pickFilter } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const { model } = modelWith(shop);
			const picking = pickFilter(model as never, locationsOf(() => two), log);
			await settle();
			const folder = [active()];
			ui.current!.accept('shop');
			await settle();
			folder.push(active());
			ui.current!.hide();
			await picking;
			assert.deepStrictEqual([
				folder,
				await opened(one, shop),
				await opened(two, gone, { 'loc-gone': 1 }),
				await opened(one, gone, { 'loc-gone': 1 })
			], [
				[['shop'], ['All Worktrees']],
				[['All Worktrees', '', 'main', 'login-fix'], ['All Worktrees']],
				[['All Locations', '', 'shop', 'docs', 'shop · gone'], ['shop · gone']],
				[['All Worktrees', '', 'main', 'login-fix', 'shop · gone'], ['shop · gone']]
			]);
		});

		test('as the locations are read again while a step is up, its items, hint and busy state follow - All Worktrees once the folder is found in Git - the item under the cursor staying under it, else the step back at the current filter (PANEL-2.3)', async () => {
			const { pickFilter } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const polish = place('loc-polish', 'ui-polish', SHOP, { branch: 'ui-polish' });
			const changed = new TestEmitter<void>();
			// Until Git is read, the folder's opened location is a plain folder with no card
			let catalog: Catalog = { locations: [place('loc-shop', 'shop', SHOP, { kind: 'folder', opened: true })], folders: [SHOP], pending: true };
			const { set, model } = modelWith(undefined, { [polish.id]: 1 });
			let picking = pickFilter(model as never, locationsOf(() => catalog, changed), log);
			await settle();
			const picker = ui.current!;
			const pending = [picker.labels(), picker.placeholder, picker.busy];
			catalog = one;
			changed.fire();
			const read = [picker.labels(), picker.placeholder, picker.busy];
			picker.activeItems = [picker.item('login-fix')];
			catalog = { locations: [MAIN, LOGIN, polish], folders: [SHOP], pending: false };
			changed.fire();
			const kept = [picker.labels(), active(), picker.items.indexOf(picker.activeItems[0])];
			picker.hide();
			await picking;
			// In a folder's step too; and with the item under the cursor gone, the step is back at the current filter
			catalog = two;
			picking = pickFilter(model as never, locationsOf(() => catalog, changed), log);
			await settle();
			ui.current!.activeItems = [ui.current!.item('docs')];
			catalog = { locations: [MAIN, LOGIN, polish], folders: [SHOP, DOCS], pending: false };
			changed.fire();
			const fallen = [ui.current!.labels(), active(), ui.current!.items.indexOf(ui.current!.activeItems[0])];
			ui.current!.accept('shop');
			await settle();
			ui.current!.activeItems = [ui.current!.item('login-fix')];
			catalog = { locations: [polish, LOGIN, MAIN, GUIDE], folders: [SHOP, DOCS], pending: false };
			changed.fire();
			const inFolder = [ui.current!.labels(), active(), ui.current!.items.indexOf(ui.current!.activeItems[0])];
			ui.current!.hide();
			await picking;
			assert.deepStrictEqual([pending, read, kept, fallen, inFolder, set], [
				[['All Locations'], 'Select a working location to show its agents', true],
				[['All Worktrees', '', 'main', 'login-fix'], 'Select a worktree to show its agents', false],
				[['All Worktrees', '', 'main', 'login-fix', 'ui-polish'], ['login-fix'], 3],
				[['All Locations', '', 'shop'], ['All Locations'], 0],
				[['All Worktrees', '', 'main', 'ui-polish', 'login-fix'], ['login-fix'], 4],
				[]
			]);
		});

		test('choosing a location filters to it, a folder with one location by the folder at once, All Worktrees by the whole folder, and the first step\'s first item clears the filter (PANEL-2.3, D82)', async () => {
			const { pickFilter } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const { set, model } = modelWith();
			const choose = async (catalog: Catalog, ...labels: string[]) => {
				const picking = pickFilter(model as never, locationsOf(() => catalog), log);
				for (const label of labels) {
					await settle();
					ui.current!.accept(label);
				}
				await picking;
			};
			await choose(two, 'shop', 'login-fix');
			await choose(two, 'docs');
			await choose(two, 'shop', 'All Worktrees');
			await choose(two, 'All Locations');
			await choose(one, 'main');
			await choose(one, 'All Worktrees');
			assert.deepStrictEqual(set, [
				{ kind: 'location', id: LOGIN.id, label: 'shop · login-fix' },
				{ kind: 'folder', id: DOCS.uri, label: 'docs' },
				{ kind: 'folder', id: SHOP.uri, label: 'shop' },
				undefined,
				{ kind: 'location', id: MAIN.id, label: 'main' },
				undefined
			]);
		});
	});

	suite('Show Agent Launch: its location', () => {
		const log = { event: () => undefined };
		const locationsOf = (catalog: () => Catalog, changed = new TestEmitter<void>()) => ({ snapshot: catalog, refresh: async () => undefined, onDidChange: changed.event });
		// Its folder with two locations second, so that Back's highlight is not merely the first row's
		const two: Catalog = { locations: [GUIDE, LOGIN, MAIN], folders: [DOCS, SHOP], pending: false };
		const icons = () => ui.current!.items.map(item => (item.iconPath as { id: string }).id);

		test('CLIS-4.1, D84: in a window of several folders, the folders with their own icons - one with a single location choosing it at once, one with more opening its own step titled with it, main checkout first; Back returns to the folders at it; no separator; Escape chooses none', async () => {
			const { chooseLaunchLocation } = load<typeof import('../ui/pickers/launchLocation')>(require.resolve('../ui/pickers/launchLocation'));
			let choosing = chooseLaunchLocation(locationsOf(() => two), log);
			await settle();
			const first = [ui.current!.title, ui.current!.placeholder, ui.current!.labels(), ui.current!.items.map(item => item.description), icons(), ui.current!.buttons.length];
			ui.current!.accept('shop');
			await settle();
			const inFolder = [ui.current!.title, ui.current!.placeholder, ui.current!.labels(), ui.current!.buttons.length];
			ui.current!.back();
			await settle();
			const back = [ui.current!.labels(), ui.current!.activeItems.map(item => item.label)];
			ui.current!.accept('shop');
			await settle();
			ui.current!.accept('login-fix');
			const login = await choosing;
			choosing = chooseLaunchLocation(locationsOf(() => two), log);
			await settle();
			ui.current!.accept('docs');
			const guide = await choosing;
			choosing = chooseLaunchLocation(locationsOf(() => two), log);
			await settle();
			ui.current!.accept('shop');
			await settle();
			ui.current!.hide();
			assert.deepStrictEqual([first, inFolder, back, login?.id, guide?.id, await choosing], [
				['Show Agent Launch', 'Select a folder', ['docs', 'shop'], ['/', '/'], ['folder', 'repo'], 0],
				['Show Agent Launch · shop', 'Select a working location', ['main', 'login-fix'], 1],
				[['docs', 'shop'], ['shop']],
				LOGIN.id,
				GUIDE.id,
				null
			]);
		});

		test('in a window of one folder, its locations at once - main checkout first, each with its path - searched by path too; Escape chooses none (CLIS-4.1, D84)', async () => {
			const { chooseLaunchLocation } = load<typeof import('../ui/pickers/launchLocation')>(require.resolve('../ui/pickers/launchLocation'));
			const one: Catalog = { locations: [LOGIN, MAIN], folders: [SHOP], pending: false };
			let choosing = chooseLaunchLocation(locationsOf(() => one), log);
			await settle();
			const shown = [ui.current!.title, ui.current!.placeholder, ui.current!.labels(), ui.current!.items.map(item => item.description), ui.current!.matchOnDescription];
			ui.current!.accept('login-fix');
			const login = await choosing;
			choosing = chooseLaunchLocation(locationsOf(() => one), log);
			await settle();
			ui.current!.hide();
			assert.deepStrictEqual([shown, login?.id, await choosing], [['Show Agent Launch', 'Select a working location', ['main', 'login-fix'], ['/main', '/login-fix'], true], LOGIN.id, null]);
		});

		test('Show Agent Launch preserves literal location labels and paths while returning the original location', async () => {
			const { chooseLaunchLocation } = load<typeof import('../ui/pickers/launchLocation')>(require.resolve('../ui/pickers/launchLocation'));
			const literal = { ...MAIN, label: '$(git-branch) main', path: '/$(folder)/main' };
			const choosing = chooseLaunchLocation(locationsOf(() => ({ folders: [SHOP], locations: [literal], pending: false })), log);
			await settle();
			assert.deepStrictEqual([ui.current!.items[0].label, ui.current!.items[0].description], ['\\$(git-branch) main', '/\\$(folder)/main']);
			ui.current!.accept('\\$(git-branch) main');
			assert.strictEqual(await choosing, literal);
		});

		test('a location of two folders is listed under each; each folder has the icon of the location it opened, not another\'s listed under it (CLIS-4.1, WORKTREES-1.2)', async () => {
			const { chooseLaunchLocation } = load<typeof import('../ui/pickers/launchLocation')>(require.resolve('../ui/pickers/launchLocation'));
			const FEAT: WorkspaceFolderInfo = { index: 1, name: 'feat', uri: 'file:///feat', path: '/feat' };
			const shared: Location = { ...MAIN, folders: [SHOP, FEAT] };
			const feat = place('loc-feat', 'feat', FEAT, { opened: true, uri: FEAT.uri, branch: 'feat' });
			const choosing = chooseLaunchLocation(locationsOf(() => ({ locations: [shared, feat], folders: [SHOP, FEAT], pending: false })), log);
			await settle();
			const first = [ui.current!.labels(), icons()];
			ui.current!.accept('feat');
			await settle();
			const inFolder = [ui.current!.labels(), icons()];
			ui.current!.accept('main');
			assert.deepStrictEqual([first, inFolder, (await choosing)?.id], [[['shop', 'feat'], ['repo', 'worktree']], [['main', 'feat'], ['repo', 'worktree']], MAIN.id]);
		});

		test('as the locations are read again while a step is up, its items, hint and busy state follow, and the item under the cursor stays under it - a folder too, as it comes to have more locations (WORKTREES-1.3)', async () => {
			const { chooseLaunchLocation } = load<typeof import('../ui/pickers/launchLocation')>(require.resolve('../ui/pickers/launchLocation'));
			const notes = place('loc-notes', 'notes', DOCS, { kind: 'folder' });
			const polish = place('loc-polish', 'ui-polish', SHOP, { branch: 'ui-polish' });
			const changed = new TestEmitter<void>();
			let catalog: Catalog = { locations: [GUIDE, MAIN], folders: [DOCS, SHOP], pending: true };
			let choosing = chooseLaunchLocation(locationsOf(() => catalog, changed), log);
			await settle();
			let picker = ui.current!;
			const pending = [picker.labels(), picker.busy];
			picker.activeItems = [picker.item('docs')];
			catalog = { locations: [GUIDE, notes, MAIN, LOGIN], folders: [DOCS, SHOP], pending: false };
			changed.fire();
			const grown = [picker.labels(), picker.busy, picker.activeItems.map(item => item.label), picker.items.indexOf(picker.activeItems[0])];
			catalog = { locations: [MAIN, LOGIN], folders: [SHOP], pending: false };
			changed.fire();
			const oneFolder = [picker.labels(), picker.placeholder];
			picker.hide();
			const none = await choosing;
			catalog = two;
			choosing = chooseLaunchLocation(locationsOf(() => catalog, changed), log);
			await settle();
			ui.current!.accept('shop');
			await settle();
			picker = ui.current!;
			picker.activeItems = [picker.item('login-fix')];
			catalog = { locations: [polish, GUIDE, LOGIN, MAIN], folders: [DOCS, SHOP], pending: false };
			changed.fire();
			const inFolder = [picker.labels(), picker.activeItems.map(item => item.label), picker.items.indexOf(picker.activeItems[0])];
			picker.hide();
			assert.deepStrictEqual([pending, grown, oneFolder, none, inFolder, await choosing], [
				[['docs', 'shop'], true],
				[['docs', 'shop'], false, ['docs'], 0],
				[['main', 'login-fix'], 'Select a working location'],
				null,
				[['main', 'ui-polish', 'login-fix'], ['login-fix'], 2],
				null
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
				exitedWithCode: (code: string) => `Exited with code ${code}`, endedBySignal: (signal: string) => `Ended by signal ${signal}`, exitUnknown: 'Disconnected; exit cause unknown', window: (label: string) => `Window: ${label}`, locale: 'en'
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

		test('a name or CLI title that holds $(...) is shown word for word, not as the theme icon the editor would draw (PANEL-3.2)', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const { plainText } = load<typeof import('../ui/presentation')>(require.resolve('../ui/presentation'));
			const runs = [run(1, { name: '$(rocket) Ada', title: 'Fix $(build) and $(x' })];
			const words = {
				worktreeFailure: (reason: string) => reason,
				starting: 'Starting', startingCli: (cli: string) => `Starting ${cli}...`, working: 'Working', notWorking: 'Idle', error: (reason: string) => `Error: ${reason}`, activityUnavailable: 'Activity unavailable', readyForInput: 'Ready for input', needsPermission: 'Needs permission', needsSignIn: 'Sign-in required', hasQuestion: 'Waiting for an answer', creatingWorktree: 'Creating worktree...',
				exitedWithCode: (code: string) => `Exited with code ${code}`, endedBySignal: (signal: string) => `Ended by signal ${signal}`, exitUnknown: 'Disconnected; exit cause unknown', window: (label: string) => `Window: ${label}`, locale: 'en'
			};
			const done = goToAgent({
				model: { ordered: () => runs, placeOf: () => ({ label: 'main', qualified: 'main', full: 'main' }) },
				agents: { onDidChange: new TestEmitter<void>().event as never },
				words,
				media: { path: '/extension/media' } as never,
				reveal: async () => undefined,
				copyReference: async () => undefined,
				close: async () => undefined
			});
			const picker = ui.current!;
			const shown = [picker.items[0].label, picker.items[0].description];
			picker.hide();
			await done;
			assert.deepStrictEqual([shown, plainText('no icon here')], [['\\$(rocket) Ada', '#a1 · Claude Code · Working · main · Fix \\$(build) and \\$(x'], 'no icon here']);
		});
	});
});

