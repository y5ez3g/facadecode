/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { tempDir } from './util';
import { folderKeyOf } from '../base/files';
import type { CliListResult, MachineInfo, MachinesChange } from '../base/coreProtocol';
import { locationIdOf } from '../core/locations/catalog';
import type { Catalog, ConversationEntry, CliChoice, CliChoices, LaunchRequest, Location, RunChange, RunFacts, WorkspaceFolderInfo, WorktreePort } from '../core/ports';
import type { PanelFilter } from '../webview/protocol';
import type { MachineLaunch, RemoteLaunchRequest } from '../ui/pickers/machineLaunch';
import type { DaemonLink, WatchListener } from '../host/rust/types';
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
	environment: 'local', yolo: true, createdAt: n, lifecycle: 'running', phase: 'running', activity: 'working', reporting: true,
	root: `run-${n}`, origin: 'human', tools: 'not_injected'
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
		const { askWorktreeBranch } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
		const checks = new Map<string, (plan: Awaited<ReturnType<WorktreePort['plan']>>) => void>();
		const port: WorktreePort = {
			availability: async () => ({ available: true }),
			plan: (_source, branch) => new Promise(resolve => checks.set(branch, resolve)),
			create: async () => { throw new Error('input must not create'); },
			remove: async () => undefined
		};
		const flow = new Flow();
		let accepted = false;
		const result = askWorktreeBranch(flow, port, MAIN, { title: 'New Agent', back: true }).then(value => { accepted = true; return value; });
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

	test('LIFECYCLE-1.3: a branch input that starts with git.branchPrefix alone says nothing of it until the person types; the prefix alone names no branch', async () => {
		const { Flow } = load<typeof import('../ui/pickers/stepping')>(require.resolve('../ui/pickers/stepping'));
		const { askWorktreeBranch } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
		ui.branchPrefix = 'feat/';
		const planned: string[] = [];
		const port: WorktreePort = {
			availability: async () => ({ available: true }),
			plan: async (source, branch) => { planned.push(branch); return { source, branch, baseRef: 'HEAD', baseCommit: 'abc', destination: `/repo.worktrees/${branch}` }; },
			create: async () => { throw new Error('input must not create'); },
			remove: async () => undefined
		};
		const result = askWorktreeBranch(new Flow(), port, MAIN, { title: 'New Agent', back: true });
		const input = ui.current!;
		await new Promise(resolve => setTimeout(resolve, 200));
		const opened = [input.value, input.prompt, input.validationMessage, [...planned]];
		input.type('feat/x');
		input.type('feat/');
		await new Promise(resolve => setTimeout(resolve, 200));
		const prefixAgain = [input.validationMessage, [...planned]];
		input.accept();
		await settle();
		const entered = [input.shown, input.validationMessage];
		input.hide();
		assert.strictEqual(await result, undefined);
		assert.deepStrictEqual([opened, prefixAgain, entered], [['feat/', 'Starts from main', undefined, []], ['Enter a branch name.', []], [true, 'Enter a branch name.']]);
	});

	test('UX-1.1: an Enter while the check of the same text is under way waits for that check, never asking Git again', async () => {
		const { Flow } = load<typeof import('../ui/pickers/stepping')>(require.resolve('../ui/pickers/stepping'));
		const asked: string[] = [];
		let answer!: () => void;
		const result = new Flow().text({ title: 'New Worktree', value: '', check: value => {
			asked.push(value);
			return new Promise(resolve => { answer = () => resolve({ prompt: `/repo.worktrees/${value}` }); });
		} });
		const input = ui.current!;
		input.type('feat/x');
		await new Promise(resolve => setTimeout(resolve, 200));
		input.accept();
		await settle();
		answer();
		assert.strictEqual(await result, 'feat/x');
		assert.deepStrictEqual(asked, ['feat/x']);
	});

	test('UX-2.4: list ages follow VS Code\'s short words - but just now under 30 s - its unit thresholds and rounding, including old conversations', () => {
		const { ago } = load<typeof import('../ui/presentation')>(require.resolve('../ui/presentation'));
		const now = Date.UTC(2026, 10, 1, 12);
		const cases: readonly [number, string][] = [
			[0, 'just now'], [29.499, 'just now'], [29.5, '30 secs ago'], [59.499, '59 secs ago'],
			[59.5, '1 min ago'], [90, '2 mins ago'], [300, '5 mins ago'], [3_599, '60 mins ago'],
			[3_600, '1 hr ago'], [79_200, '22 hrs ago'], [86_399, '24 hrs ago'],
			[86_400, '1 day ago'], [259_200, '3 days ago'], [604_799, '7 days ago'],
			[604_800, '1 wk ago'], [1_209_600, '2 wks ago'], [2_591_999, '4 wks ago'],
			[2_592_000, '1 mo ago'], [7_776_000, '3 mos ago'], [31_535_999, '12 mos ago'],
			[31_536_000, '1 yr ago'], [63_072_000, '2 yrs ago']
		];
		for (const [seconds, expected] of cases) {
			assert.strictEqual(ago(now - seconds * 1_000, now, 'en'), expected, `${seconds} seconds`);
		}
		const future = now + 60_000;
		assert.strictEqual(ago(future, now, 'en'), new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' }).format(future));
	});

	test('UX-2.4: time phrases use the shipped editor-language translations', () => {
		const translated = vscodeFor(ui);
		const bundle = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../l10n/bundle.l10n.zh-cn.json'), 'utf8')) as Record<string, string>;
		translated.l10n.t = (text, ...args) => (bundle[text] ?? text).replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)]));
		const { ago } = withModules({ vscode: translated })<typeof import('../ui/presentation')>(require.resolve('../ui/presentation'));
		const now = Date.UTC(2026, 10, 1, 12);
		assert.deepStrictEqual([0, 60, 300, 79_200, 86_400, 1_209_600, 7_776_000, 63_072_000].map(seconds => ago(now - seconds * 1_000, now, 'zh-cn')),
			['刚刚', '1 分钟前', '5 分钟前', '22 小时前', '1 天前', '2 周前', '3 个月前', '2 年前']);
	});

	test('a remote environment is named as VS Code\'s remote indicator names it, from the authority the local window sees (LIFECYCLE-1.1)', () => {
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
				ids(orderedClis([cli('claude', 'Claude Code', { available: false, problem: 'clis.claude.command is "/nope"' })], 'claude')),
				ids(orderedClis([cli('claude', 'Claude Code', { available: false, problem: 'claude was not found on the PATH', notInstalled: true })], undefined))
			], [[['other', 'claude'], []], [['claude', 'other'], []], [[], ['claude']], [[], []]]);
		});

		test('U06: a run ID, a short ID or a copied reference names its run exactly, whatever stale name comes with it', () => {
			const { referencedRun } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const runs = [{ id: `run-${'1'.padStart(32, '0')}`, alias: '#a1' }, { id: `run-${'2'.padStart(32, '0')}`, alias: '#a12' }];
			assert.deepStrictEqual(['#a12', '@Old Name #a1', 'Ada #a1', ` ${runs[1].id} `, 'Ada', '#a9', 'a1'].map(search => referencedRun(search, runs)?.alias), ['#a12', '#a1', '#a1', '#a12', undefined, undefined, undefined]);
			const remote = { id: 'remote-a1', alias: '#a1@gpu', address: '#a1@id:1234abcd' };
			assert.strictEqual(referencedRun('@Old Name #a1@id:1234abcd', [...runs, remote]), remote);
			assert.strictEqual(referencedRun('#a1', [remote, ...runs]), runs[0]);
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
		/** What the service refuses the launch with, before accepting it; none accepts it. */
		let refusal: Error | undefined;

		const start = (startAt?: string, network?: MachineLaunch) => {
			const { newAgent } = load<typeof import('../ui/pickers/newAgent')>(require.resolve('../ui/pickers/newAgent'));
			return newAgent({
				agents: { launch: request => { if (refusal) { throw refusal; } launched.push(request); return 'run-new'; }, list: () => runs, close: async run => { closed.push(run); return 'terminated'; } },
				locations: { snapshot: () => catalog, refresh: async () => undefined, onDidChange: changed.event },
				clis: { list: async location => { listed.push(location.id); if (choices instanceof Error) { throw choices; } return { clis: choices, problems }; } },
				worktrees,
				history: { last: () => last, remember: () => undefined },
				select: run => selected.push(run),
				notifyError: text => errors.push(text),
				log: { event: () => undefined },
				media: { path: '/extension/media' } as never,
				suggest: () => 'Ada',
				network
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
			refusal = undefined;
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

		test('LIFECYCLE-1.1, 1.3: New Agent opens with window CLIs, then follows a remote location and preserves choices after a refused preflight', async () => {
			const location = { label: 'GPU workspace', cwd: '/server/app', source: { machine_id: 'gpu-id', window_id: 'win-server' } };
			const attempts: [string, RemoteLaunchRequest][] = [];
			const starts: [string, RemoteLaunchRequest][] = [];
			const queried: string[] = [];
			last = { location: LOGIN.id, cli: 'codex' };
			choices = [cli('claude', 'Claude Code'), cli('codex', 'Codex')];
			const network: MachineLaunch = {
				machines: () => ({ local: { id: 'local-id', name: 'mbp' }, others: [{ id: 'gpu-id', name: 'gpu' }] }),
				catalog: async machine => {
					queried.push(machine);
					return { locations: [{ ...location, source: { ...location.source } }], clis: [cli('muse', 'Muse Code')] };
				},
				preflight: async (machine, request) => {
					attempts.push([machine, request]);
					if (attempts.length === 1) { throw new Error('Directory unavailable'); }
				},
				launch: (machine, request) => {
					starts.push([machine, request]);
					return 'remote-run';
				}
			};
			const done = start(undefined, network);
			await settle();
			assert.strictEqual(ui.current!.title, 'New Agent · Ada · login-fix');
			assert.deepStrictEqual(ui.current!.labels(), ['Codex', 'Claude Code', 'Options', 'Change Working Location...', 'Change Name...']);
			assert.deepStrictEqual(ui.current!.activeItems.map(item => item.label), ['Codex']);
			assert.deepStrictEqual(ui.current!.buttons, []);
			assert.deepStrictEqual(queried, []);
			ui.current!.accept('Change Name...');
			await settle();
			ui.current!.type('  Chosen Name  ');
			ui.current!.accept();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			assert.strictEqual(ui.current!.title, 'New Agent · Machine');
			assert.deepStrictEqual(ui.current!.activeItems.map(item => [item.label, item.description]), [['This machine', 'mbp']]);
			assert.deepStrictEqual(ui.current!.buttons, [BACK_BUTTON]);
			ui.current!.accept('gpu');
			await settle();
			assert.deepStrictEqual(ui.current!.labels(), ['~', 'GPU workspace', 'Change Working Location...']);
			ui.current!.accept('GPU workspace');
			await settle();
			assert.strictEqual(ui.current!.title, 'New Agent · Chosen Name · gpu · GPU workspace');
			assert.deepStrictEqual(ui.current!.labels(), ['Muse Code', 'Options', 'Change Working Location...', 'Change Name...']);
			assert.deepStrictEqual(ui.current!.buttons, []);
			ui.current!.accept('Change Working Location...');
			await settle();
			assert.deepStrictEqual(ui.current!.activeItems.map(item => item.label), ['gpu']);
			ui.current!.accept();
			await settle();
			assert.deepStrictEqual(ui.current!.activeItems.map(item => item.label), ['GPU workspace']);
			ui.current!.accept('Change Working Location...');
			await settle();
			assert.strictEqual(ui.current!.value, '/server/app');
			ui.current!.type('/another/path');
			ui.current!.back();
			await settle();
			assert.strictEqual(ui.current!.title, 'New Agent · Working Location');
			ui.current!.back();
			await settle();
			assert.deepStrictEqual(ui.current!.activeItems.map(item => item.label), ['gpu']);
			ui.current!.accept('This machine');
			await settle();
			assert.deepStrictEqual(ui.current!.activeItems.map(item => item.label), ['login-fix']);
			ui.current!.back();
			await settle();
			assert.deepStrictEqual(ui.current!.activeItems.map(item => item.label), ['This machine']);
			ui.current!.back();
			await settle();
			ui.current!.accept('Muse Code');
			await settle();
			assert.strictEqual(ui.current!.title, 'New Agent · Chosen Name · gpu · GPU workspace');
			assert.strictEqual(ui.current!.activeItems[0]?.detail, 'Directory unavailable');
			assert.deepStrictEqual([launched, starts], [[], []]);
			ui.current!.accept();
			await done;
			const wanted: [string, RemoteLaunchRequest] = ['gpu-id', { name: 'Chosen Name', cli: 'muse', location }];
			assert.deepStrictEqual([attempts, starts, selected, listed, queried], [[wanted, wanted], [wanted], ['remote-run'], [LOGIN.id, LOGIN.id], ['gpu-id', 'gpu-id']]);
		});

		test('LIFECYCLE-1.3: selects separate Facade homes by ID from a lone plain folder or no folder, and blocks machines without a route', async () => {
			const { RustMachines } = withModules({ vscode: {
				EventEmitter: TestEmitter,
				Disposable: { from: (...parts: { dispose(): void }[]) => ({ dispose: () => parts.forEach(part => part.dispose()) }) }
			} })<typeof import('../host/rust/machines')>(require.resolve('../host/rust/machines'));
			const [local, first, second, login, offline] = ['1', '2', '3', '4', '5'].map(digit => `${digit.repeat(8)}-0000-4000-8000-000000000000`);
			const window = { machine_id: local, window_id: 'editor' };
			const dispose = () => ({ dispose() { } });
			let snapshot!: WatchListener<readonly MachineInfo[], MachinesChange>['snapshot'];
			const queries: { op: string; machine: string }[] = [];
			const clis: CliListResult = { clis: [{ cli: 'claude', display_name: 'Remote Claude', available: true, overrides: { model: false, effort: false } }] };
			const link = {
				window, windowId: window.window_id, machineId: local, connected: true, onDidBind: dispose,
				watch: (topic: string, _args: object, listener: WatchListener<readonly MachineInfo[], MachinesChange>) => {
					assert.strictEqual(topic, 'machines');
					snapshot = listener.snapshot;
					return dispose();
				},
				call: async (op: string, { machine }: { machine: string }) => {
					queries.push({ op, machine });
					assert.ok(op === 'cli.list' || op === 'location.list', op);
					return op === 'cli.list' ? clis : { locations: [] };
				}
			} as unknown as DaemonLink;
			const machines = new RustMachines(link, () => id => id);
			const connection = (machine_id: string, remote_home: string, state: MachineInfo['connections'][number]['state']) =>
				({ machine_id, initiator_machine_id: local, remote_home, state, kind: 'saved' as const, ssh_destination: 'buildbox' });
			try {
				snapshot([
					{ machine_id: local, name: 'editor', route: [], connections: [
						connection(first, '~/facade-one', 'connected'),
						connection(second, '~/facade-two', 'ssh_interaction_required'),
						connection(login, '~/facade-login', 'ssh_interaction_required'),
						connection(offline, '~/facade-offline', 'unavailable')
					] },
					{ machine_id: first, name: 'buildbox', route: [first], connections: [] },
					{ machine_id: second, name: 'buildbox', route: [first, second], connections: [] },
					{ machine_id: login, name: 'other home', connections: [] },
					{ machine_id: offline, name: 'offline', connections: [] }
				]);
				const checks: string[] = [];
				const starts: string[] = [];
				const network: MachineLaunch = {
					onDidChange: machines.onDidChange, machines: () => machines.choices(), catalog: id => machines.catalog(id),
					preflight: async (id, request) => { assert.deepStrictEqual(request, { name: 'Ada', cli: 'claude' }); checks.push(id); },
					launch: (id, request) => { assert.deepStrictEqual(request, { name: 'Ada', cli: 'claude' }); starts.push(id); return 'remote-run'; }
				};
				for (const [index, id] of [[1, first], [2, second]] as const) {
					catalog = index === 1 ? { locations: [], folders: [], pending: false } : { locations: [GUIDE], folders: [DOCS], pending: false };
					const done = start(undefined, network);
					await settle();
					assert.deepStrictEqual(ui.current!.labels(), index === 1
						? ['Open Folder...', 'Options', 'Change Working Location...']
						: ['Claude Code', 'Options', 'Change Working Location...', 'Change Name...']);
					ui.current!.accept('Change Working Location...');
					await settle();
					const picker = ui.current!;
					assert.deepStrictEqual(picker.items.map(item => [
						item.label, item.detail, (item.iconPath as { id: string }).id
					]), [
						['This machine', undefined, 'device-desktop'],
						['buildbox (22222222)', undefined, 'globe'],
						['buildbox (33333333)', undefined, 'globe'],
						['other home', 'Needs SSH login', 'globe'],
						['offline', 'Unavailable', 'globe']
					]);
					const before = queries.length;
					for (const blocked of [3, 4]) {
						picker.activate(blocked);
						picker.accept();
						await settle();
						assert.strictEqual(ui.current, picker);
					}
					assert.strictEqual(queries.length, before);
					picker.activate(index);
					picker.accept();
					await settle();
					assert.strictEqual(ui.current!.title, 'New Agent · Working Location');
					ui.current!.accept('~');
					await settle();
					assert.deepStrictEqual(ui.current!.labels(), ['Remote Claude', 'Options', 'Change Working Location...', 'Change Name...']);
					if (index === 2) {
						// Returning to this window selects its only location, and the CLIs are the window's again.
						ui.current!.accept('Change Working Location...');
						await settle();
						assert.strictEqual(ui.current!.activeItems[0]?.label, 'buildbox (33333333)');
						ui.current!.accept('This machine');
						await settle();
						assert.strictEqual(ui.current!.title, 'New Agent · Ada');
						assert.deepStrictEqual(ui.current!.labels(), ['Claude Code', 'Options', 'Change Working Location...', 'Change Name...']);
						ui.current!.accept('Change Working Location...');
						await settle();
						assert.strictEqual(ui.current!.activeItems[0]?.label, 'This machine');
						ui.current!.accept('buildbox (33333333)');
						await settle();
						ui.current!.accept('~');
						await settle();
					}
					ui.current!.accept('Remote Claude');
					await done;
					const expectedQuery = ['location.list', 'cli.list'].map(op => ({ op, machine: `id:${id.replace(/-/g, '')}` }));
					assert.deepStrictEqual(queries.slice(before), index === 1 ? expectedQuery : [...expectedQuery, ...expectedQuery]);
				}
				assert.deepStrictEqual([checks, starts, selected, ui.commands, listed, launched], [
					[first, second], [first, second], ['remote-run', 'remote-run'], [], [GUIDE.id, GUIDE.id], []
				]);
			} finally {
				machines.dispose();
			}
		});

		test('J02: one picker titled New Agent - the last CLI first and selected but not started, the location with its environment and the editable name at the bottom; choosing a CLI closes it and starts the agent at once, selected', async () => {
			const done = start();
			await settle();
			const picker = ui.current!;
			const shown = { title: picker.title, placeholder: picker.placeholder, labels: picker.labels(), active: picker.activeItems.map(item => item.label), where: picker.item('Change Working Location...').description, name: picker.item('Change Name...').description, launched: launched.length };
			picker.accept();
			await done;
			assert.deepStrictEqual(shown, { title: 'New Agent · Ada · main', placeholder: 'Select a CLI', labels: ['Claude Code', 'Options', 'Change Working Location...', 'Change Name...'], active: ['Claude Code'], where: 'main', name: 'Ada', launched: 0 });
			assert.deepStrictEqual([launched, selected, picker.shown, ui.current], [[{ name: 'Ada', location: MAIN.id, cli: 'claude', origin: 'human' }], ['run-new'], false, undefined]);
		});

		test('a launch refused as its working location went meanwhile says so in the person\'s words, never by the location\'s ID (UX-2.4, LIFECYCLE-1.1)', async () => {
			const { FacadeError } = load<typeof import('../core/errors')>(require.resolve('../core/errors'));
			refusal = new FacadeError('INVALID', 'invalid_argument', `The working location ${MAIN.id} is not available in this window.`, { kind: 'location_gone', values: [] });
			const done = start();
			await settle();
			ui.current!.accept();
			await done;
			assert.deepStrictEqual([errors, selected], [['Could not start Ada: The working location is no longer available.'], []]);
		});

		test('a launch this window can take no number for says why in the person\'s words: its window component too old - update it on this computer, then reload - or the counter not answering (RULES-2.2, UX-2.4)', async () => {
			const { FacadeError } = load<typeof import('../core/errors')>(require.resolve('../core/errors'));
			for (const kind of ['component_outdated', 'numbers_unavailable']) {
				refusal = new FacadeError('UNAVAILABLE', 'unavailable', 'Nothing was started or sent.', { kind, values: [] });
				const done = start();
				await settle();
				ui.current!.accept();
				await done;
			}
			// Another window owning the workspace, in the same words, saying what to do (ARCHITECTURE-2.2)
			const { OWNERSHIP_LOST } = load<typeof import('../core/errors')>(require.resolve('../core/errors'));
			refusal = new FacadeError('INVALID', 'ownership_lost', 'This workspace is now owned by another window. Reload this window to take ownership.', OWNERSHIP_LOST);
			const owned = start();
			await settle();
			ui.current!.accept();
			await owned;
			// A settings file that stops every start is refused in the same words, by where it is wrong (UX-4.1, CONFIGURATION-4.1)
			refusal = new FacadeError('UNAVAILABLE', 'configuration_invalid', '~/.facade/facade.json:1:10: yolo must be true or false; received string', { kind: 'settings_yolo', values: ['~/.facade/facade.json', '1', '10', 'string'] });
			const done = start();
			await settle();
			ui.current!.accept();
			await done;
			assert.deepStrictEqual([errors, selected], [[
				'Could not start Ada: Facade Code requires a newer Window Component. Update "Facade Code Window Component" on this computer, then reload the window.',
				'Could not start Ada: This computer\'s counter could not give the agent a number. Try again.',
				'Could not start Ada: This workspace is owned by another window. Reload this window to take ownership.',
				'Could not start Ada: ~/.facade/facade.json:1:10: yolo must be true or false; received string.'
			], []]);
		});

		test('LIFECYCLE-1.3: a lone folder Git has not read yet offers no location change; Change Working Location comes once Git finds a repository there, the CLI in focus kept', async () => {
			const SHOP_FOLDER = place('loc-shop', 'shop', SHOP, { kind: 'folder', git: 'pending', opened: true, uri: SHOP.uri, path: SHOP.path });
			catalog = { locations: [SHOP_FOLDER], folders: [SHOP], pending: true };
			last = { location: SHOP_FOLDER.id, cli: 'claude' };
			const done = start();
			await settle();
			const picker = ui.current!;
			const pending = [picker.labels(), picker.activeItems.map(item => item.label)];
			catalog = { locations: [{ ...SHOP_FOLDER, kind: 'checkout', git: 'ok', isMain: true, branch: 'main' }], folders: [SHOP], pending: false };
			changed.fire();
			const read = [picker.labels(), picker.activeItems.map(item => item.label)];
			picker.hide();
			await done;
			assert.deepStrictEqual([pending, read, launched], [
				[['Claude Code', 'Options', 'Change Name...'], ['Claude Code']],
				[['Claude Code', 'Options', 'Change Working Location...', 'Change Name...'], ['Claude Code']],
				[]
			]);
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
			assert.deepStrictEqual([opened, empty, emptyLabel, renamed, backed, launched, selected], [['text', 'New Agent · Change Name', 'Ada', undefined, undefined], undefined, ['New Agent ·  · main', ''], 'human', 'human', [], []]);
		});

		test('WORKTREES-2.1: New Worktree for a destination Resume remembered inside a checkout starts from that checkout, its branch named - never the folder\'s first', async () => {
			const API = place('loc-api', 'api', SHOP, { path: `${LOGIN.path}/api`, kind: 'folder', git: 'none' });
			catalog = { locations: [MAIN, LOGIN, API], folders: [SHOP], pending: false };
			last = { location: API.id, cli: 'claude' };
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const offered = ui.current!.item('New Worktree...').description;
			ui.current!.accept('New Worktree...');
			await settle();
			ui.current!.type('feat/api');
			ui.current!.accept();
			await settle();
			await settle();
			const chosen = ui.current!.item('Change Working Location...').description;
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([offered, planned, chosen], ['from login-fix', ['loc-login feat/api'], 'New worktree feat/api from login-fix']);
		});

		test('WORKTREES-1.2, LIFECYCLE-1.3: a Resume cwd recorded within a lone plain folder is no place to change to: Options still offers only Change Name', async () => {
			catalog = { locations: [GUIDE, place('loc-guide-notes', 'notes', DOCS, { path: '/guide/notes', kind: 'folder', git: 'none', within: GUIDE.id })], folders: [DOCS], pending: false };
			last = { location: GUIDE.id, cli: 'claude' };
			const done = start();
			await settle();
			const labels = ui.current!.labels();
			ui.current!.hide();
			await done;
			assert.deepStrictEqual(labels, ['Claude Code', 'Options', 'Change Name...']);
		});

		test('LIFECYCLE-1.1, 1.3: a lone plain folder - the window\'s one place to work - goes unsaid in the title and offers no location change, under Options only Change Name, never an action that does nothing; a repository\'s only checkout still opens its step, saying why New Worktree is unavailable', async () => {
			catalog = { locations: [GUIDE], folders: [DOCS], pending: false };
			last = { location: GUIDE.id, cli: 'claude' };
			let done = start();
			await settle();
			const plain = [ui.current!.title, ui.current!.labels()];
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
				['New Agent · Ada', ['Claude Code', 'Options', 'Change Name...']],
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
			const folders = [ui.current!.title, ui.current!.placeholder, ui.current!.labels(), ui.current!.activeItems.map(item => item.label), ui.current!.items.map(item => (item.iconPath as { id: string } | undefined)?.id), ui.current!.items.map(item => item.description)];
			ui.current!.accept('docs');
			await settle();
			// docs has one location: that step is skipped, the CLI step again for it
			const there = [ui.current!.item('Change Working Location...').description, ui.current!.item('Change Working Location...').detail, [...listed]];
			ui.current!.accept('Change Working Location...');
			await settle();
			ui.current!.accept('shop');
			await settle();
			const locations = [ui.current!.title, ui.current!.placeholder, ui.current!.labels(), ui.current!.items.map(item => item.description)];
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
				['New Agent · Select Folder', 'Select a folder', ['shop', 'docs', '', 'Add Folder to Workspace...'], ['shop'], ['repo', 'folder', undefined, 'add'], ['/', '/', undefined, undefined]],
				['docs · guide', undefined, [MAIN.id, GUIDE.id]],
				['New Agent · Working Location', 'Select a branch or worktree', ['main', 'login-fix', '', 'New Worktree...'], ['/main', '/login-fix', undefined, 'from main']],
				['shop'],
				'docs · guide',
				[]
			]);
		});

		test('LIFECYCLE-1.1, 1.3, UX-1.3: no folder offers Open Folder or a discovered machine; no usable CLI offers Open Settings with why', async () => {
			catalog = { locations: [], folders: [], pending: false };
			let done = start();
			await settle();
			const noFolder = ui.current!.labels();
			ui.current!.accept();
			await done;

			const machineChanged = new TestEmitter<void>();
			let discovered = false;
			let offline!: (reason: Error) => void;
			const network: MachineLaunch = {
				onDidChange: machineChanged.event,
				machines: () => ({
					local: { id: 'local-id', name: 'editor' },
					others: discovered ? [{ id: 'remote-id', name: 'remote' }] : []
				}),
				catalog: () => new Promise((_resolve, reject) => { offline = reject; }),
				preflight: async () => assert.fail('No CLI was chosen'),
				launch: () => assert.fail('Escape does not launch')
			};
			done = start(undefined, network);
			const prerequisite = ui.current!;
			assert.deepStrictEqual(prerequisite.labels(), ['Open Folder...']);
			discovered = true;
			machineChanged.fire();
			assert.deepStrictEqual(prerequisite.labels(), ['Open Folder...', 'Options', 'Change Working Location...']);
			prerequisite.accept('Change Working Location...');
			await settle();
			ui.current!.accept('remote');
			await settle();
			assert.strictEqual(ui.current!.busy, true);
			ui.current!.back();
			await settle();
			const machine = ui.current!;
			assert.strictEqual(machine.title, 'New Agent · Machine');
			assert.strictEqual(machine.activeItems[0]?.label, 'remote');
			offline(new Error('Machine is offline'));
			await settle();
			assert.strictEqual(ui.current, machine);
			machine.accept();
			await settle();
			offline(new Error('Machine is offline'));
			await settle();
			const unavailable = ui.current!;
			assert.deepStrictEqual(unavailable.items.map(item => [item.label, item.detail]), [['Unavailable', 'Machine is offline']]);
			unavailable.accept();
			await settle();
			assert.strictEqual(ui.current, unavailable);
			unavailable.hide();
			await done;
			assert.deepStrictEqual([ui.current, launched, selected], [undefined, [], []]);

			catalog = { locations: [MAIN], folders: [SHOP], pending: false };
			choices = [cli('claude', 'Claude Code', { available: false, problem: 'clis.claude.command is "/opt/claude", and /opt/claude is not a program that can be run' })];
			done = start();
			await settle();
			const picker = ui.current!;
			const noCli = [picker.labels(), picker.activeItems.map(item => item.label), picker.item('Open Settings').detail, picker.item('Claude Code').detail, buttonsOf(picker)];
			picker.accept('Claude Code');
			await done;
			for (const configure of [(step: Input) => step.accept('Open Settings'), (step: Input) => step.press(step.labels().indexOf('Claude Code'), step.item('Claude Code').buttons![0])]) {
				done = start();
				await settle();
				configure(ui.current!);
				await done;
			}
			// Nothing installed at all: Open Settings with why, and no list of what is not installed
			choices = [cli('claude', 'Claude Code', { available: false, problem: 'claude was not found on the PATH', notInstalled: true })];
			done = start();
			await settle();
			const nothing = ui.current!.labels();
			ui.current!.hide();
			await done;
			// A settings file wrong as a whole leaves no CLI, so it is said by the file, with the way to it (CONFIGURATION-4.1)
			problems = [{ setting: '~/.facade/facade.json', problem: '~/.facade/facade.json:3:12: clis must be an object of CLIs by name; received array', said: { kind: 'settings_clis', values: ['~/.facade/facade.json', '3', '12', 'array'] } }];
			done = start();
			await settle();
			const broken = [ui.current!.labels(), ui.current!.item('~/.facade/facade.json').detail];
			ui.current!.accept('~/.facade/facade.json');
			await done;
			problems = [];
			assert.deepStrictEqual([noFolder, noCli, nothing, broken, ui.commands, launched], [
				['Open Folder...'],
				[['Open Settings', 'Unavailable', 'Claude Code', 'Options', 'Change Working Location...', 'Change Name...'], ['Open Settings'], 'Install a supported CLI in this environment, or configure its path.', 'clis.claude.command is "/opt/claude", and /opt/claude is not a program that can be run', [['Claude Code', 'gear: Open Settings']]],
				['Open Settings', 'Options', 'Change Working Location...', 'Change Name...'],
				[['Open Settings', 'Unavailable', '~/.facade/facade.json', 'Options', 'Change Working Location...', 'Change Name...'], '~/.facade/facade.json:3:12: clis must be an object of CLIs by name; received array'],
				[['vscode.openFolder'], ['facade.openSettings'], ['facade.openSettings'], ['facade.openSettings'], ['facade.openSettings']],
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
			const branchInput = [box.kind, box.title, box.value, box.placeholder, box.prompt];
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
				['text', 'New Agent · New Worktree', 'feat/', 'Branch name', 'Starts from main'],
				'Enter a branch name.',
				['\'feat/bad name\' is not a valid branch name.', false],
				['New Agent · Ada · feat/login (new)', 'New worktree feat/login from main'],
				['loc-app feat/bad name', 'loc-app feat/login'],
				0,
				[{ name: 'Ada', location: opened.id, cli: 'claude', origin: 'human', worktree: { branch: 'feat/login' } }]
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
				'"nul" is a reserved device name on Windows.',
				'Git could not read /main: fatal: bad object'
			]);
		});

		test('LIFECYCLE-1.3: the folder step ends in Add Folder to Workspace... and offers removing each folder while another stays; a single-folder window has no folder step, so neither', async () => {
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

		test('LIFECYCLE-1.3: Add Folder to Workspace... is the editor\'s own command, run with the step hidden; cancelled, the step is as it was; folders added, the step again with the first added selected', async () => {
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

		test('LIFECYCLE-1.3: a folder\'s X asks first, saying the agents its removal closes, and Cancel does nothing; Remove calls updateWorkspaceFolders(index, 1) and leaves its agents to the removal; one folder left goes on to its locations', async () => {
			catalog = { locations: [MAIN, LOGIN, GUIDE], folders: [SHOP, DOCS], pending: false };
			last = { location: GUIDE.id, cli: 'claude' };
			// One of docs' two a Resume in a cwd the catalog has no record of yet, still starting: it counts with the anchor it kept
			// And one accepted within shop whose cwd has since become docs' own location: shop's removal leaves it, docs' ends it
			runs = [runAt(1, GUIDE), { ...runAt(2, GUIDE), location: 'loc-guide-notes', within: GUIDE.id, cwd: '/guide/notes' }, runAt(3, MAIN), { ...runAt(4, GUIDE), within: MAIN.id }];
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
			const back = [ui.current!.title, ui.current!.placeholder, ui.current!.labels(), [...ui.updates]];
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
					{ kind: 'warning', args: ['Remove "shop" from this workspace? Files stay on disk.', { modal: true, detail: 'Its agent will be stopped.' }, 'Remove'], over: undefined },
					{ kind: 'warning', args: ['Remove "docs" from this workspace? Files stay on disk.', { modal: true, detail: '3 associated agents will be stopped.' }, 'Remove'], over: undefined },
					{ kind: 'warning', args: ['Remove "docs" from this workspace? Files stay on disk.', { modal: true, detail: '3 associated agents will be stopped.' }, 'Remove'], over: undefined }
				],
				['New Agent · Select Folder', 'Select a folder', ['shop', 'docs', '', 'Add Folder to Workspace...'], []],
				[[1, 1]],
				['Select a branch or worktree', ['main', 'login-fix', '', 'New Worktree...']],
				'main',
				// The location service's removal closes them (WORKTREES-3.3), not the picker
				[],
				[]
			]);
		});

		test('LIFECYCLE-1.3: the location step offers Delete Worktree on linked worktrees alone - not on the main checkout, a plain folder, a worktree a workspace folder opened or one a workspace folder is in', async () => {
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

		test('LIFECYCLE-1.3: Delete Worktree asks first - its folder, the branch kept, its agents - and Cancel does nothing; confirmed, the step is back at once without it, busy until it is gone, its own agents closed by the deletion', async () => {
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
				{ kind: 'warning', args: ['Delete worktree "login-fix"?', { modal: true, detail: 'Folder /login-fix will be deleted; branch login-fix is kept.\n\nIts agent will be stopped.' }, 'Delete'], over: undefined },
				[['main', 'login-fix', '', 'New Worktree...'], 0],
				[LOGIN.id],
				[['main', '', 'New Worktree...'], true, [], ['run-1']],
				[['main', '', 'New Worktree...'], false],
				[]
			]);
		});

		test('WORKTREES-3.2: Delete Worktree names and closes the agents launched inside it too - a resumed conversation\'s subdirectory, listed or not yet - and no other', async () => {
			const API = place('loc-login-api', 'api', SHOP, { kind: 'folder', path: `${LOGIN.path}/api`, uri: 'file:///login-fix/api' });
			catalog = { locations: [MAIN, LOGIN, API], folders: [SHOP], pending: false };
			const tools = `${LOGIN.path}/tools`;
			runs = [runAt(1, API), { ...runAt(2, MAIN), location: locationIdOf('local', folderKeyOf(tools)), cwd: tools }, runAt(3, MAIN)];
			ui.answer = 'Delete';
			remove = async (_id, closeAgents) => { await closeAgents(); };
			const done = start();
			await settle();
			ui.current!.accept('Change Working Location...');
			await settle();
			const offered = buttonsOf(ui.current!);
			ui.current!.press(1, ui.current!.items[1].buttons![0]);
			await settle();
			await settle();
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([offered, ui.dialogs[0].args, closed, errors], [
				[['login-fix', 'close: Delete Worktree']],
				['Delete worktree "login-fix"?', { modal: true, detail: 'Folder /login-fix will be deleted; branch login-fix is kept.\n\n2 associated agents will be stopped.' }, 'Delete'],
				['run-1', 'run-2'],
				[]
			]);
		});

		test('LIFECYCLE-1.3: a refused deletion is said - changes not committed, Git\'s own refusal - with the worktree back in the step and no agent closed by the picker; a detached worktree is asked about without a branch', async () => {
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

	test('WORKTREES-3.2: a link this Git would delete through, and a folder Git left behind, are said in the person\'s words', () => {
		const { worktreeProblemText } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
		assert.deepStrictEqual([
			worktreeProblemText({ problem: { kind: 'worktree_linked', name: 'feat', link: 'node_modules\\dep' } }, 'English'),
			worktreeProblemText({ problem: { kind: 'worktree_left', name: 'feat', folder: 'C:\\repo.worktrees\\feat' } }, 'English')
		], [
			'Cannot delete worktree "feat": it contains a link to another folder (node_modules\\dep), which this version of Git would delete through. Remove the link, or update Git to 2.54 or later, then try again.',
			'Deleted worktree "feat", but folder C:\\repo.worktrees\\feat was left behind.'
		]);
	});

	suite('Resume cwds within a location (WORKTREES-1.2)', () => {
		const NESTED = place('loc-main-api', 'api', SHOP, { path: '/main/api', uri: 'file:///main/api', kind: 'folder', git: 'none', within: MAIN.id });

		test('no picker offers a Resume cwd within a location: New Agent\'s remembered default is its anchor, a folder\'s locations leave it out, a filter on it starts at its anchor, and New Worktree\'s source is the folder\'s own', () => {
			const { defaultLocation } = load<typeof import('../ui/pickers/newAgent')>(require.resolve('../ui/pickers/newAgent'));
			const { locationsIn } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
			const { locationOfFilter } = load<typeof import('../ui/model')>(require.resolve('../ui/model'));
			const { sourceIn } = load<typeof import('../ui/commands/worktree')>(require.resolve('../ui/commands/worktree'));
			const catalog: Catalog = { locations: [NESTED, MAIN, LOGIN], folders: [SHOP], pending: false };
			assert.deepStrictEqual([
				defaultLocation(catalog, NESTED.id)?.id,
				locationsIn(catalog, SHOP).map(each => each.id),
				locationOfFilter({ kind: 'location', id: NESTED.id, label: 'api' }, catalog.locations),
				sourceIn(catalog, SHOP)?.id
			], [MAIN.id, [MAIN.id, LOGIN.id], MAIN.id, MAIN.id]);
		});

		test('Show Agent Command Line offers no Resume cwd within a location: with one location besides it, that one is shown without asking', async () => {
			const { chosen } = withModules({ vscode: { window: { createQuickPick: () => { throw new Error('asked'); } }, ThemeIcon: class { }, Uri: { from: (parts: object) => parts }, QuickPickItemKind: { Separator: -1 }, l10n: { t: (text: string) => text } } })<typeof import('../host/showLaunch')>(require.resolve('../host/showLaunch'));
			const locations = { snapshot: () => ({ locations: [NESTED, MAIN], folders: [SHOP], pending: false }), resolve: () => undefined, refresh: async () => undefined, onDidChange: () => ({ dispose() { } }) } as never;
			assert.strictEqual((await chosen(locations, undefined, { event: () => undefined } as never))?.id, MAIN.id);
		});
	});

	suite('Continue Session', () => {
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
		let savedNames: Map<string, string>;
		let nameReads: string[];
		const open = (batches: readonly ConversationEntry[][], result: string | { running: string } | Error = 'run-new', locations: readonly Location[] = [MAIN, LOGIN], running: readonly string[] = [],
			problems: CliChoices['problems'] = []) => {
			const { pickSession } = load<typeof import('../ui/pickers/resume')>(require.resolve('../ui/pickers/resume'));
			reads = 0;
			return pickSession({
				kind: 'continue',
				conversations: { open: scope => { scopes.push(scope); return { next: async () => { const entries = batches[reads] ?? []; reads++; return { entries, done: reads >= batches.length }; }, dispose: () => { disposed = true; } }; } },
				savedName: key => { nameReads.push(key.sessionId); return savedNames.get(key.sessionId); },
				locations: { snapshot: () => ({ locations, folders: [SHOP], pending: false }) },
				running: key => running.includes(key.sessionId),
				continueSession: chosen => { resumedCwds.push(chosen.cwd); assert.strictEqual(chosen.cwdChoices, undefined); did.push(`resume ${chosen.key.sessionId}`); if (result instanceof Error) { throw result; } return result as never; },
				reveal: async run => void did.push(`reveal ${run}`),
				select: run => void did.push(`select ${run}`),
				notifyError: text => errors.push(text),
				media: { path: '/extension/media' } as never,
				language: 'en',
				now: () => NOW,
				settingsProblems: () => problems
			});
		};

		setup(() => {
			scopes = []; reads = 0; disposed = false; did = []; resumedCwds = []; errors = []; savedNames = new Map(); nameReads = [];
		});

		test('CONFIGURATION-4.1, UX-1.3: a settings file wrong as a whole, which stops every resume, is said by the file as New Agent says it, choosing it running Open Settings; no conversation is read, none said to be missing', async () => {
			const problem = { setting: '~/.facade/facade.json', problem: '~/.facade/facade.json:3:12: clis must be an object of CLIs by name; received array', said: { kind: 'settings_clis', values: ['~/.facade/facade.json', '3', '12', 'array'] } };
			const done = open([[entry(1)]], 'run-new', [MAIN, LOGIN], [], [problem]);
			await settle();
			const picker = ui.current!;
			const shown = [picker.labels(), picker.item('~/.facade/facade.json').detail, (picker.item('~/.facade/facade.json').iconPath as { id: string }).id, buttonsOf(picker), picker.placeholder, picker.busy, scopes.length];
			picker.accept('~/.facade/facade.json');
			await done;
			// Its gear does the same
			const again = open([[entry(1)]], 'run-new', [MAIN, LOGIN], [], [problem]);
			await settle();
			ui.current!.press(0, ui.current!.item('~/.facade/facade.json').buttons![0]);
			await again;
			assert.deepStrictEqual([shown, ui.commands, did], [
				[['~/.facade/facade.json'], '~/.facade/facade.json:3:12: clis must be an object of CLIs by name; received array', 'gear', [['~/.facade/facade.json', 'gear: Open Settings']], 'Search by title, name, CLI, or location', false, 0],
				[['facade.openSettings'], ['facade.openSettings']],
				[]
			]);
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
				['Continue Session', 100, 1, [['Conversation 0', 'just now \u00b7 login-fix/api', undefined], ['Conversation 1', '1 min ago \u00b7 main', undefined]]],
				1,
				[200, 2],
				[250, 3, false],
				3,
				true
			]);
		});

		test('LIFECYCLE-3.2: each conversation is one line - its icon naming the CLI, then time and location; no CLI name or source as text', async () => {
			const done = open([[entry(4), entry(2)]]);
			await settle();
			const lines = ui.current!.items.map(item => [item.description, item.detail]);
			ui.current!.hide();
			await done;
			assert.deepStrictEqual(lines, [['2 mins ago \u00b7 main', undefined], ['4 mins ago \u00b7 main', undefined]]);
		});

		test('LIFECYCLE-3.2: in the window\'s one place to work a conversation there says its time alone; one in a subfolder still says where', async () => {
			const plain = place('loc-shop', 'shop', SHOP, { kind: 'folder', git: 'none', opened: true, path: '/shop', uri: SHOP.uri });
			const done = open([[entry(1, { cwd: '/shop' }), entry(2, { cwd: '/shop/api' })]], 'run-new', [plain]);
			await settle();
			const lines = ui.current!.items.map(item => item.description);
			// Left unsaid, the one place still matches a search
			ui.current!.type('shop');
			await settle();
			const found = ui.current!.items.filter(item => item.alwaysShow).map(item => item.label);
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([lines, found], [['1 min ago', '2 mins ago \u00b7 shop/api'], ['Conversation 1']]);
		});

		test('WORKTREES-1.2, LIFECYCLE-3.2: a conversation in a Resume cwd recorded within a location is named by that location, the cwd below it, never as a location of its own', async () => {
			const nested = place('loc-main-api', 'api', SHOP, { path: '/main/api', uri: 'file:///main/api', kind: 'folder', git: 'none', within: MAIN.id });
			const done = open([[entry(1, { cwd: '/main/api' })]], 'run-new', [MAIN, LOGIN, nested]);
			await settle();
			const description = ui.current!.items[0].description;
			ui.current!.hide();
			await done;
			assert.strictEqual(description, '1 min ago · main/api');
		});

		test('LIFECYCLE-2.3: title leads, saved names follow time/location even when equal; absent names stay absent and CLI search reaches later pages', async () => {
			savedNames.set('s0', 'Same title');
			savedNames.set('s1', '');
			savedNames.set('s3', 'Ada');
			const done = open([[entry(0, { title: 'Same title' }), entry(1), entry(2)], [entry(3)]]);
			await settle();
			const picker = ui.current!;
			assert.deepStrictEqual(picker.items.map(item => [item.label, item.description, item.detail]), [
				['Same title', 'just now · login-fix/api · Same title', undefined],
				['Conversation 1', '1 min ago · main', undefined],
				['Conversation 2', '2 mins ago · main', undefined]
			]);
			picker.type('Claude Code');
			await settle();
			await settle();
			assert.deepStrictEqual(picker.items.filter(item => item.alwaysShow).map(item => item.label), ['Conversation 1', 'Conversation 3']);
			picker.type('claude Ada');
			assert.deepStrictEqual(picker.items.filter(item => item.alwaysShow).map(item => item.label), ['Conversation 3']);
			picker.type('codex Same');
			assert.deepStrictEqual(picker.items.filter(item => item.alwaysShow).map(item => item.label), ['Same title']);
			assert.deepStrictEqual(nameReads, ['s0', 's1', 's2', 's3'], 'saved metadata is read once per entry, not on each search');
			assert.deepStrictEqual(did, [], 'browsing/searching never resumes or names a conversation');
			picker.hide();
			await done;
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
				assert.deepStrictEqual(lines, ['1 min ago \u00b7 main', '2 mins ago \u00b7 main/api']);
			} finally {
				temp.remove();
			}
		});

		test('LIFECYCLE-3.2: a conversation an agent already holds - resumed here, or running in another window - is not listed again', async () => {
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
			assert.deepStrictEqual([ui.current!.title, ui.current!.placeholder], ['Continue Session', 'Select a working location']);
			ui.current!.hide(); await done; assert.deepStrictEqual(did, []);
			done = open(batch); await settle(); ui.current!.accept('Conversation 1'); await settle();
			ui.current!.accept('login-fix'); await done;
			assert.deepStrictEqual(resumedCwds, [LOGIN.path]);
		});

		test('a conversation listed twice shows once; one that cannot be resumed is not listed (LIFECYCLE-3.2); choosing one resumes it, shows the one already running here, or says it runs in another window (LIFECYCLE-3.2, 3.3)', async () => {
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

		test('a continuation refused as another window owns the workspace says so in the person\'s words, with what to do (UX-2.4, LIFECYCLE-3.2)', async () => {
			const { FacadeError, OWNERSHIP_LOST } = load<typeof import('../core/errors')>(require.resolve('../core/errors'));
			const done = open([[entry(1)]], new FacadeError('INVALID', 'ownership_lost', 'Another window owns this workspace.', OWNERSHIP_LOST));
			await settle();
			ui.current!.accept('Conversation 1');
			await done;
			assert.deepStrictEqual(errors, ['Could not continue Conversation 1: This workspace is owned by another window. Reload this window to take ownership.']);
		});

		test('a conversation whose working location is not in this window is refused in the person\'s words, by its path (UX-2.4, LIFECYCLE-3.2)', async () => {
			const { FacadeError } = load<typeof import('../core/errors')>(require.resolve('../core/errors'));
			const refusal = new FacadeError('INVALID', 'not_found', 'The conversation\'s working location /far/away is not available in this window.', { kind: 'location_not_here', values: ['/far/away'] });
			const done = open([[entry(1)]], refusal);
			await settle();
			ui.current!.accept('Conversation 1');
			await done;
			assert.deepStrictEqual([did, errors], [['resume s1'], ['Could not continue Conversation 1: The working location /far/away is not available in this window.']]);
		});
	});

	suite('Resume Agent', () => {
		test('shows the session refusal after accepting the retained number and preserves the settings key and file spelling', async () => {
			const { pickSession } = load<typeof import('../ui/pickers/resume')>(require.resolve('../ui/pickers/resume'));
			const { FacadeError } = load<typeof import('../core/errors')>(require.resolve('../core/errors'));
			const cli = 'team "conversation"';
			const quoted = JSON.stringify(cli);
			const setting = `clis[${quoted}]`;
			const file = '~/work/this conversation/facade.json';
			const entry = { key: { environment: 'local', cli, sessionId: 'saved' }, cwd: MAIN.path, title: 'Saved title' };
			const picked: string[] = [];
			const errors: string[] = [];
			for (const refusal of [
				new FacadeError('INVALID', 'unsupported', `${setting} runs Codex now, but this conversation is Claude Code's; it cannot be resumed with it`,
					{ kind: 'resume_type_changed', values: [setting, 'Claude Code'] }),
				new FacadeError('UNAVAILABLE', 'unavailable', `${quoted} is no longer in clis of ${file}, so this conversation cannot be resumed with it.`,
					{ kind: 'resume_entry_gone', values: [quoted, file] }),
			]) {
				const done = pickSession({
					kind: 'resume', retained: () => [{ agent: 'a7@id:machine', alias: '#a7', name: 'Ada', entry }],
					resume: async agent => { picked.push(agent); throw refusal; },
					locations: { snapshot: () => ({ locations: [], folders: [], pending: false }) },
					running: () => false, reveal: async () => assert.fail(), select: () => assert.fail(),
					notifyError: message => errors.push(message), media: { path: '/extension/media' } as never, language: 'en'
				});
				await settle();
				ui.current!.accept('Saved title');
				await done;
			}
			assert.deepStrictEqual(picked, ['a7@id:machine', 'a7@id:machine']);
			assert.deepStrictEqual(errors, [
				`Could not resume Saved title: ${setting} runs another CLI now, but this session is Claude Code's; it cannot be resumed with it`,
				`Could not resume Saved title: ${quoted} is no longer in clis of ${file}, so this session cannot be resumed with it.`
			]);
		});

		test('LIFECYCLE-3.2: identities stay distinct when two ended agents share a session', async () => {
			const { pickSession } = load<typeof import('../ui/pickers/resume')>(require.resolve('../ui/pickers/resume'));
			const entry = { key: { environment: 'local', cli: 'claude', sessionId: 'shared' }, cwd: MAIN.path, title: 'Saved title' };
			const picked: string[] = [];
			const done = pickSession({
				kind: 'resume',
				retained: () => [
					{ agent: 'a1@id:machine', alias: '#a1', name: 'Ada', entry },
					{ agent: 'a2@id:machine', alias: '#a2', name: 'Ada', entry }
				],
				resume: async agent => { picked.push(agent); return agent; },
				locations: { snapshot: () => ({ locations: [], folders: [], pending: false }) },
				running: () => false, reveal: async () => undefined, select: () => undefined,
				notifyError: assert.fail, media: { path: '/extension/media' } as never, language: 'en'
			});
			await settle();
			const picker = ui.current!;
			assert.strictEqual(picker.title, 'Resume Agent');
			assert.deepStrictEqual(picker.items.map(item => item.description?.split(' · ').at(-1)), ['#a1', '#a2']);
			picker.activate(1);
			picker.accept();
			await done;
			assert.deepStrictEqual(picked, ['a2@id:machine']);
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

		test('PANEL-1.5: same-name folders keep their selection targets and show count before their distinct parent paths', () => {
			const { filterItems } = load<typeof import('../ui/pickers/filter')>(require.resolve('../ui/pickers/filter'));
			const folders = [SHOP, DOCS].map((folder, index) => ({ ...folder, name: 'app', path: `/projects/team-${index}/app`, uri: `file:///projects/team-${index}/app` }));
			const locations = folders.map((folder, index) => ({ ...GUIDE, id: `loc-${index}`, folders: [folder] }));
			const items = filterItems({ count: () => 1, currentFilter: () => undefined }, { folders, locations, pending: false }).filter(item => item.label === 'app');
			assert.deepStrictEqual(items.map(item => [item.label, item.description, item.filter]), folders.map((folder, index) => [
				'app', `1 agent · /projects/team-${index}`, { kind: 'folder', id: folder.uri, label: 'app' }
			]));
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

		test('PANEL-2.3: steps by folder - All Locations, then each folder with cards, one in two or more locations opening All Worktrees and its locations, main checkout first, any other filtering at once; a window of one folder shows that step alone, All Locations outside Git; one separator, below each step\'s first item', () => {
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
				['All Locations (5 agents)', '----', 'shop (3 agents · /)', 'docs (2 agents · /)'],
				['all', '', 'step', 'folder'],
				['All Worktrees (3 agents)', '----', 'main (2 agents)', 'login-fix (1 agent)'],
				['All Worktrees (3 agents)', '----', 'main (2 agents)', 'login-fix (1 agent)'],
				['All Worktrees (5 agents)', '----', 'main (2 agents)', 'login-fix (1 agent)'],
				['All Locations (5 agents)', '----', 'guide (2 agents)'],
				['All Locations (5 agents)'],
				['All Locations (3 agents)', '----', 'shop (3 agents · /)']
			]);
		});

		test('a filtered location alone with cards in its folder opens the folder\'s step, where it stays in sight and Enter keeps it; one in a plain folder filters by the folder at once (PANEL-2.3)', () => {
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
				['All Locations (1 agent)', '----', 'shop (1 agent · /)'],
				['all', '', 'step'],
				['All Worktrees (1 agent)', '----', 'login-fix (1 agent)'],
				['All Locations (2 agents)', '----', 'docs (2 agents · /)'],
				['all', '', 'folder']
			]);
		});

		test('the current filter is highlighted - a location through its folder, then itself in the folder\'s step, titled with the folder, listed with no card left; Back returns to the first step at the folder; Escape in either step changes nothing (PANEL-2.3)', async () => {
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

		test('choosing a location filters to it, a folder with one location by the folder at once, All Worktrees by the whole folder, and the first step\'s first item clears the filter (PANEL-2.3)', async () => {
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

	suite('Show Agent Command Line: its location', () => {
		const log = { event: () => undefined };
		const locationsOf = (catalog: () => Catalog, changed = new TestEmitter<void>()) => ({ snapshot: catalog, refresh: async () => undefined, onDidChange: changed.event });
		// Its folder with two locations second, so that Back's highlight is not merely the first row's
		const two: Catalog = { locations: [GUIDE, LOGIN, MAIN], folders: [DOCS, SHOP], pending: false };
		const icons = () => ui.current!.items.map(item => (item.iconPath as { id: string }).id);

		test('CLIS-4.1: in a window of several folders, the folders with their own icons - one with a single location choosing it at once, one with more opening its own step titled with it, main checkout first; Back returns to the folders at it; no separator; Escape chooses none', async () => {
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
				['Show Agent Command Line', 'Select a folder', ['docs', 'shop'], ['/', '/'], ['folder', 'repo'], 0],
				['Show Agent Command Line · shop', 'Select a working location', ['main', 'login-fix'], 1],
				[['docs', 'shop'], ['shop']],
				LOGIN.id,
				GUIDE.id,
				null
			]);
		});

		test('in a window of one folder, its locations at once - main checkout first, each with its path - searched by path too; Escape chooses none (CLIS-4.1)', async () => {
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
			assert.deepStrictEqual([shown, login?.id, await choosing], [['Show Agent Command Line', 'Select a working location', ['main', 'login-fix'], ['/main', '/login-fix'], true], LOGIN.id, null]);
		});

		test('Show Agent Command Line preserves literal location labels and paths while returning the original location', async () => {
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
			activity: 'working', reporting: true, root: `run-${String(n).padStart(32, '0')}`, origin: 'human', tools: 'not_injected', ...more
		});

		test('LIFECYCLE-2.3: local rows appear while remote discovery runs, and a qualified reference adopts the remote record', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const local = run(1);
			const remote = run(1, { id: 'gpu-a1', alias: '#a1@gpu', address: '#a1@id:1234abcd', name: 'Remote Ada' });
			const adopted: string[] = [];
			const report = new TestEmitter<void>();
			const done = goToAgent({
				model: { ordered: () => [local], placeOf: () => ({ label: 'main', qualified: 'main', context: 'main', path: MAIN.path, kind: 'repo' }), placesShown: () => true },
				agents: { onDidChange: new TestEmitter<RunChange>().event },
				media: { path: '/extension/media' } as never,
				reveal: async () => undefined, copyReference: async () => undefined, stop: async () => undefined, dismiss: async () => undefined,
				others: { list: () => [], query: async () => [{ facts: remote, windows: [] }], onDidChange: report.event,
					open: async id => void adopted.push(id), copyReference: async () => undefined, stop: async () => false }
			});
			const picker = ui.current!;
			assert.deepStrictEqual(picker.items.map(item => item.label), ['Ada']);
			await settle();
			assert.deepStrictEqual(picker.items.map(item => item.label), ['Ada', 'Remote Ada']);
			picker.type('@Old Name #a1@id:1234abcd');
			assert.deepStrictEqual(picker.items.map(item => item.label), ['Remote Ada']);
			picker.accept('Remote Ada');
			await done;
			assert.deepStrictEqual(adopted, [remote.id]);
		});

		test('LIFECYCLE-2.3: a confirmed stop removes only the matching network candidate', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const gpu = run(1, { id: '#a1@id:1234abcd', alias: '#a1@gpu', name: 'GPU agent' });
			const peer = run(1, { id: '#a1@id:4321abcd', alias: '#a1@server', name: 'Server agent' });
			const report = new TestEmitter<void>();
			const stopped: string[] = [];
			let confirmed = false;
			const done = goToAgent({
				model: { ordered: () => [], placeOf: () => ({ label: 'main', qualified: 'main', context: 'main', path: MAIN.path, kind: 'repo' }), placesShown: () => true },
				agents: { onDidChange: new TestEmitter<RunChange>().event },
				media: { path: '/extension/media' } as never,
				reveal: async () => undefined, copyReference: async () => undefined, stop: async () => undefined, dismiss: async () => undefined,
				others: {
					list: () => [], query: async () => [gpu, peer].map(facts => ({ facts, windows: [] })), onDidChange: report.event,
					open: async () => undefined, copyReference: async () => undefined,
					stop: async facts => { stopped.push(facts.id); return confirmed; }
				}
			});
			const picker = ui.current!;
			await settle();
			const stop = picker.item('GPU agent').buttons![1] as { tooltip: string };
			assert.strictEqual(stop.tooltip, 'Stop Agent');
			picker.press(0, stop);
			await settle();
			assert.deepStrictEqual(picker.labels(), ['GPU agent', 'Server agent']);
			confirmed = true;
			picker.press(0, stop);
			await settle();
			report.fire();
			assert.deepStrictEqual(picker.labels(), ['Server agent']);
			assert.deepStrictEqual(stopped, [gpu.id, gpu.id]);
			picker.hide();
			await done;
		});

		test('U06, LIFECYCLE-2.3: single-line names, IDs, location and conversation titles - none where its CLI saved none, and never a state; empty/equal names, hidden CLI search, copied references and item actions', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			let placesShown = true;
			let runs = [run(1, { title: 'Fix login' }), run(2, { lifecycle: 'ended', end: { kind: 'failed', at: 1 }, error: { reason: 'Not found', source: 'launch', at: 1 } }), run(3, { lifecycle: 'starting', phase: 'launching_cli' }), run(4, { name: '', title: 'Unnamed work' }), run(5, { name: 'Same', title: 'Same', cli: 'muse', displayName: 'Muse Code' })];
			const changed = new TestEmitter<RunChange>();
			const did: string[] = [];
			const done = goToAgent({
				model: { ordered: () => runs, placeOf: () => ({ label: 'main', qualified: 'main', context: 'main', path: MAIN.path, kind: 'repo' as const }), placesShown: () => placesShown },
				agents: { onDidChange: changed.event as never },
				media: { path: '/extension/media' } as never,
				reveal: async run => void did.push(`reveal ${run}`),
				copyReference: async run => void did.push(`copy ${run}`),
				stop: async run => void did.push(`stop ${run}`),
				dismiss: async run => {
					did.push(`dismiss ${run}`);
					runs = runs.filter(each => each.id !== run);
					changed.fire({ run, kind: 'removed', cause: 'close' });
				}
			});
			const picker = ui.current!;
			const listed = picker.items.map(item => [item.label, item.description, item.detail]);
			const searched = [picker.matchOnDescription, picker.matchOnDetail];
			picker.type('Muse Code');
			assert.deepStrictEqual(picker.items.filter(item => item.alwaysShow).map(item => item.label), ['Same']);
			picker.type('claude login');
			assert.deepStrictEqual(picker.items.filter(item => item.alwaysShow).map(item => item.label), ['Ada']);
			picker.type('#a2');
			const byId = picker.items.map(item => [item.description, item.alwaysShow]);
			picker.type('@Grace #a1');
			const byReference = picker.items.map(item => item.description);
			picker.type('Ada');
			const all = picker.items.length;
			const [copy, dismiss] = picker.items[1].buttons!;
			const stop = picker.items[2].buttons![1];
			assert.deepStrictEqual(picker.items.slice(0, 3).map(item => (item.buttons![1] as { tooltip: string }).tooltip), ['Stop Agent', 'Dismiss Agent', 'Stop Agent']);
			picker.press(0, copy);
			picker.press(2, stop);
			picker.press(1, dismiss);
			await settle();
			const afterClose = picker.items.map(item => item.description);
			// Every agent in the window's one place to work: none says it (PANEL-1.3)
			placesShown = false;
			changed.fire({ run: run(9).id, kind: 'removed', cause: 'close' });
			await settle();
			const onePlace = picker.items.map(item => item.description);
			// Left unsaid, the one place still matches a search (LIFECYCLE-2.3)
			picker.type('main');
			const byOnePlace = picker.items.filter(item => item.alwaysShow).length;
			picker.type('Ada');
			picker.accept();
			await done;
			assert.deepStrictEqual([picker.title, listed, searched, byId, byReference, all, afterClose, onePlace, byOnePlace, did], [
				'Go to Agent',
				[['Ada', '#a1 · main · Fix login', undefined], ['Ada', '#a2 · main', undefined], ['Ada', '#a3 · main', undefined], ['#a4', 'main · Unnamed work', undefined], ['Same', '#a5 · main · Same', undefined]],
				[true, false],
				[['#a2 · main', true]],
				['#a1 · main · Fix login'],
				5,
				['#a1 · main · Fix login', '#a3 · main', 'main · Unnamed work', '#a5 · main · Same'],
				['#a1 · Fix login', '#a3', 'Unnamed work', '#a5 · Same'],
				4,
				[`copy ${run(1).id}`, `stop ${run(3).id}`, `dismiss ${run(2).id}`, `reveal ${run(1).id}`]
			]);
		});

		test('PANEL-3.1: what a CLI reports reaches the open picker at most once per 300 ms, as it does the panel; an agent added or gone at once', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const runs = [run(1)];
			const changed = new TestEmitter<RunChange>();
			let reads = 0;
			const done = goToAgent({
				model: { ordered: () => { reads++; return runs; }, placeOf: () => ({ label: 'main', qualified: 'main', context: 'main', path: MAIN.path, kind: 'repo' as const }), placesShown: () => true },
				agents: { onDidChange: changed.event },
				media: { path: '/extension/media' } as never,
				reveal: async () => undefined,
				copyReference: async () => undefined,
				stop: async () => undefined, dismiss: async () => undefined
			});
			const picker = ui.current!;
			const before = reads;
			for (let i = 0; i < 20; i++) {
				changed.fire({ run: runs[0].id, kind: 'reported' });
			}
			const burst = reads - before;
			await new Promise(resolve => setTimeout(resolve, 350));
			const coalesced = reads - before;
			changed.fire({ run: runs[0].id, kind: 'added' });
			const added = reads - before;
			picker.hide();
			await done;
			assert.deepStrictEqual([burst, coalesced, added], [0, 1, 2]);
		});

		test('PANEL-1.5, WORKTREES-1.2: a location picker\'s icon is repo for a main checkout\'s root, worktree for a linked root, folder for a workspace folder opened inside a checkout and for a plain folder', () => {
			const { locationIcon } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
			const at = (more: Partial<Location>) => (locationIcon({ ...MAIN, ...more } as Location) as unknown as { id: string }).id;
			assert.deepStrictEqual([at({ kind: 'checkout', isMain: true }), at({ kind: 'checkout', isMain: false }), at({ kind: 'checkout', isMain: false, subfolder: true }), at({ kind: 'folder' })],
				['repo', 'worktree', 'folder', 'folder']);
		});

		test('LIFECYCLE-2.3: a stored title\'s lines are joined with a space in Go to Agent\'s one-line row, its stored text kept whole', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const runs = [run(1, { title: 'Fix the login\nand the logout\r\nflows' })];
			const done = goToAgent({
				model: { ordered: () => runs, placeOf: () => ({ label: 'main', qualified: 'main', context: 'main', path: MAIN.path, kind: 'repo' as const }), placesShown: () => true },
				agents: { onDidChange: new TestEmitter<void>().event as never },
				media: { path: '/extension/media' } as never,
				reveal: async () => undefined,
				copyReference: async () => undefined,
				stop: async () => undefined, dismiss: async () => undefined
			});
			const described = ui.current!.items[0].description;
			ui.current!.hide();
			await done;
			assert.deepStrictEqual([described, runs[0].title], ['#a1 · main · Fix the login and the logout flows', 'Fix the login\nand the logout\r\nflows']);
		});

		test('LIFECYCLE-2.3: Go to Agent says no state - working, idle, starting, waiting, red - only the ID, location and title', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const runs = [
				run(1, { title: 'Fix login' }),
				run(2, { activity: 'not_working' }),
				run(3, { lifecycle: 'starting', phase: 'launching_cli', activity: 'unknown', reporting: false }),
				run(4, { activity: 'not_working', blocker: { kind: 'permission', text: 'Allow Bash?' } }),
				run(5, { lifecycle: 'ended', end: { kind: 'failed', at: 1 }, error: { reason: 'claude was not found on PATH.', source: 'launch', at: 1 }, title: 'Parser' })
			];
			const done = goToAgent({
				model: { ordered: () => runs, placeOf: () => ({ label: 'main', qualified: 'main', context: 'main', path: MAIN.path, kind: 'repo' as const }), placesShown: () => true },
				agents: { onDidChange: new TestEmitter<void>().event as never },
				media: { path: '/extension/media' } as never,
				reveal: async () => undefined,
				copyReference: async () => undefined,
				stop: async () => undefined, dismiss: async () => undefined
			});
			const picker = ui.current!;
			const described = picker.items.map(item => item.description);
			picker.hide();
			await done;
			assert.deepStrictEqual(described, ['#a1 · main · Fix login', '#a2 · main', '#a3 · main', '#a4 · main', '#a5 · main · Parser']);
		});

		test('a name or conversation title that holds $(...) is shown word for word, not as the theme icon the editor would draw (PANEL-3.2)', async () => {
			const { goToAgent } = load<typeof import('../ui/pickers/goToAgent')>(require.resolve('../ui/pickers/goToAgent'));
			const { plainText } = load<typeof import('../ui/presentation')>(require.resolve('../ui/presentation'));
			const runs = [run(1, { name: '$(rocket) Ada', title: 'Fix $(build) and $(x' })];
			const done = goToAgent({
				model: { ordered: () => runs, placeOf: () => ({ label: 'main', qualified: 'main', context: 'main', path: MAIN.path, kind: 'repo' as const }), placesShown: () => true },
				agents: { onDidChange: new TestEmitter<void>().event as never },
				media: { path: '/extension/media' } as never,
				reveal: async () => undefined,
				copyReference: async () => undefined,
				stop: async () => undefined, dismiss: async () => undefined
			});
			const picker = ui.current!;
			const shown = [picker.items[0].label, picker.items[0].description];
			picker.hide();
			await done;
			assert.deepStrictEqual([shown, plainText('no icon here')], [['\\$(rocket) Ada', '#a1 · main · Fix \\$(build) and \\$(x'], 'no icon here']);
		});
	});
});

