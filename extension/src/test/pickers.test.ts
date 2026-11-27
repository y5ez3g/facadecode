/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentListEntry, CliListArgs, LocationListArgs, MachineInfo, ResumeCandidate, ResumeListArgs, StartArgs } from '../base/frameworkProtocol';
import type { Catalog, Location, WorkspaceFolderInfo, WorktreePort } from '../core/ports';
import type { PanelFilter } from '../webview/protocol';
import type { FrameworkPickerDeps } from '../ui/pickers/framework';
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
		EventEmitter: TestEmitter,
		window: {
			createQuickPick: () => new Input('pick', ui),
			createInputBox: () => new Input('text', ui),
			showWarningMessage: async (...args: unknown[]) => { ui.dialogs.push({ kind: 'warning', args, over: ui.current?.placeholder }); return ui.answer; }
		},
		QuickInputButtons: { Back: BACK_BUTTON },
		QuickPickItemKind: { Separator: -1, Default: 0 },
		ThemeIcon: class { constructor(readonly id: string) { } },
		Uri: {
			joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }),
			file: (path: string) => ({ path }),
			parse: (uri: string) => ({ path: uri, with: ({ path }: { path: string }) => ({ toString: () => new URL(path, uri).href }) })
		},
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
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Each item's buttons as `[icon, tooltip]`, for the items that have any. */
const buttonsOf = (input: Input) => input.items.filter(item => item.buttons?.length).map(item => [item.label, ...item.buttons!.map(button => {
	const { iconPath, tooltip } = button as { iconPath: { id: string }; tooltip: string };
	return `${iconPath.id}: ${tooltip}`;
})]);

suite('Pickers: New Agent, Change Working Location, Change Name, Filter, Stop Agent (LIFECYCLE-1, 2, PANEL-2.3)', () => {
	let ui: Ui;
	let load: <T>(file: string) => T;

	setup(() => {
		ui = new Ui();
		load = withModules({ vscode: vscodeFor(ui) });
	});

	function frameworkPickers(overrides: Partial<FrameworkPickerDeps>) {
		const { createFrameworkPickers } = load<typeof import('../ui/pickers/framework')>(require.resolve('../ui/pickers/framework'));
		const unexpected = () => assert.fail('unexpected picker operation');
		return createFrameworkPickers({
			media: { path: '/extension/media' } as never,
			locations: {
				snapshot: () => ({ locations: [], folders: ui.workspaceFolders, pending: false }),
				resolve: unexpected, refresh: unexpected, removalOf: unexpected,
				onDidChange: unexpected, onDidRemove: unexpected
			},
			hostMachineId: () => 'local-id', machines: () => [], listAgents: unexpected, listLocations: unexpected,
			listClis: unexpected, listResumes: unexpected, start: unexpected, stop: unexpected, resume: unexpected,
			select: unexpected, notifyError: unexpected, icons: cli => cli,
			...overrides
		});
	}

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
	});

	suite('New Agent', () => {
		test('RULES-6.5: New Agent chooses a saved machine and folder before loading its CLIs; the branch is sent at launch', async () => {
			const { FrameworkLocations } = load<typeof import('../host/framework/catalog')>(require.resolve('../host/framework/catalog'));
			const calls: unknown[][] = [];
			const starts: StartArgs[] = [];
			const selected: string[] = [];
			const remoteScope = { kind: 'machine', machine: '1234abcd' } as const;
			const foldersChanged = new TestEmitter<void>();
			ui.workspaceFolders = [SHOP, DOCS];
			const locations = new FrameworkLocations({
				folders: () => ui.workspaceFolders,
				onDidChangeFolders: foldersChanged.event,
				list: async args => {
					calls.push(['local locations', args]);
					const shared = { location_id: LOGIN.id, path: LOGIN.path, label: LOGIN.label, kind: 'worktree' as const };
					return { locations: [
						{ location_id: MAIN.id, path: SHOP.path, label: MAIN.label, kind: 'main', source_folder: SHOP.path },
						{ ...shared, source_folder: SHOP.path },
						{ location_id: GUIDE.id, path: DOCS.path, label: GUIDE.label, kind: 'folder', source_folder: DOCS.path },
						{ ...shared, source_folder: DOCS.path }
					] };
				},
				log: { event: assert.fail }
			});
			try {
				const pickers = frameworkPickers({
					locations,
					machines: () => [
						{ machine_id: 'local-id', short_id: '11111111', name: 'mbp', selector: 'mbp', state: 'online', connections: [] },
						{ machine_id: 'gpu-id', short_id: '1234abcd', name: 'gpu', selector: '1234abcd', state: 'sleeping', connections: [] }
					],
					listLocations: async (args: LocationListArgs) => {
						calls.push(['remote locations', args]);
						const folder = args.folders?.[0];
						if (folder) {
							return { locations: [{ location_id: 'loc-entered', path: '/canonical/work path', label: 'main', kind: 'main', source_folder: folder }] };
						}
						return { locations: [
							{ location_id: 'loc-home', path: '/home/dev', label: 'dev', kind: 'folder' },
							{ location_id: 'loc-app', path: '/server/app', label: 'GPU workspace', kind: 'main' }
						] };
					},
					listClis: async args => {
						calls.push(['clis', args]);
						const overrides = { model: false, effort: false };
						return { clis: args.scope?.kind === 'machine' ? [
							{ cli: 'muse', display_name: 'Muse Code', available: true, overrides },
							{ cli: 'codex', display_name: 'Codex', available: false, not_installed: true, overrides },
							{ cli: 'claude', display_name: 'Claude Code', available: false, problem: 'Disabled in facade.json', overrides }
						] : [{ cli: 'codex', display_name: 'Codex', available: true, overrides }] };
					},
					start: async args => { starts.push(args); return 'remote-run'; },
					select: run => selected.push(run)
				});
				assert.deepStrictEqual(calls, []);
				const done = pickers.newAgent(LOGIN.id);
				assert.strictEqual(ui.current!.busy, true);
				await settle();
				assert.strictEqual(ui.current!.title, 'New Agent · login-fix');
				assert.strictEqual(ui.current!.item('Change Name...').description, 'Auto-assign');
				assert.deepStrictEqual(locations.resolve(LOGIN.id)?.folders, [SHOP, DOCS]);
				assert.deepStrictEqual(calls, [['local locations', { folders: [SHOP.path, DOCS.path] }], ['clis', { folder: LOGIN.path, scope: undefined }]]);
				ui.current!.accept('Change Name...');
				await settle();
				ui.current!.type('  Chosen Name  ');
				ui.current!.accept();
				await settle();
				ui.current!.accept('Change Location...');
				await settle();
				assert.strictEqual(ui.current!.title, 'New Agent · Working Location');
				ui.current!.accept('Change Machine...');
				await settle();
				assert.strictEqual(ui.current!.title, 'New Agent · Machine');
				assert.deepStrictEqual(ui.current!.activeItems.map(item => [item.label, item.description]), [['This machine', 'mbp']]);
				ui.current!.accept('gpu');
				await settle();
				assert.deepStrictEqual(ui.current!.items.map(item => [item.label, item.description]), [
					['dev', '/home/dev'], ['GPU workspace', '/server/app'], ['', undefined],
					['Change Machine...', undefined], ['Enter Path...', undefined]
				]);
				assert.deepStrictEqual(buttonsOf(ui.current!), [['GPU workspace', 'git-branch: New Worktree...']]);
				const remoteList = ['remote locations', { scope: remoteScope, folders: [] }];
				const enteredPath = ['remote locations', { scope: remoteScope, folders: ['/another/work path'] }];
				assert.deepStrictEqual(calls.slice(2), [remoteList]);
				ui.current!.accept('Enter Path...');
				await settle();
				ui.current!.type('/another/work path');
				ui.current!.accept();
				await settle();
				assert.deepStrictEqual(calls.slice(2), [remoteList, enteredPath]);
				assert.strictEqual(ui.current!.activeItems[0]?.label, '/another/work path');
				const entered = ui.current!.item('/another/work path');
				ui.current!.press(ui.current!.items.indexOf(entered), entered.buttons![0]);
				await settle();
				assert.strictEqual(ui.current!.title, 'New Agent · New Worktree');
				assert.deepStrictEqual(calls.slice(2), [remoteList, enteredPath]);
				ui.current!.type('feat/ui');
				ui.current!.accept();
				await settle();
				assert.strictEqual(ui.current!.title, 'New Agent · Chosen Name · feat/ui (new)');
				assert.deepStrictEqual(ui.current!.labels(), ['Muse Code', 'Unavailable', 'Codex', 'Claude Code', 'Options', 'Change Location...', 'Change Name...']);
				assert.deepStrictEqual([ui.current!.item('Codex').detail, ui.current!.item('Claude Code').detail], ['Not installed', 'Disabled in facade.json']);
				assert.strictEqual(ui.current!.item('Change Location...').description, 'New worktree feat/ui from gpu · /another/work path');
				assert.deepStrictEqual(starts, []);
				ui.current!.accept('Muse Code');
				await done;
				assert.deepStrictEqual(calls.slice(2), [remoteList, enteredPath, ['clis', { scope: remoteScope, folder: '/another/work path' }]]);
				assert.deepStrictEqual(starts, [{
					cli: 'muse', scope: remoteScope, folder: '/another/work path', name: 'Chosen Name', worktree: 'feat/ui', size: { cols: 80, rows: 24 }
				}]);
				assert.deepStrictEqual(selected, ['remote-run']);
			} finally {
				locations.dispose();
			}
		});

		test('RULES-6.5: same-name machines keep their canonical selectors, including a saved sleeping machine', async () => {
			const { FrameworkLocations } = load<typeof import('../host/framework/catalog')>(require.resolve('../host/framework/catalog'));
			const localId = '11111111-0000-4000-8000-000000000000';
			const first: MachineInfo = {
				machine_id: '22222222-0000-4000-8000-000000000000', short_id: '22222222', name: 'buildbox', selector: '22222222', state: 'online', connections: []
			};
			const second: MachineInfo = {
				machine_id: '33333333-0000-4000-8000-000000000000', short_id: '33333333', name: 'buildbox',
				selector: '33333333-0000-4000-8000-000000000000', state: 'sleeping', connections: []
			};
			const local: MachineInfo = { machine_id: localId, short_id: '11111111', name: 'editor', selector: 'editor', state: 'online', route: [], connections: [
				{ machine_id: second.machine_id, initiator_machine_id: localId, kind: 'saved', transport: { kind: 'ssh', ssh_destination: 'buildbox', ssh_args: [] }, state: 'disconnected' }
			] };
			const targets = [
				{ machine: first, home: '/home/first', folders: [] },
				{ machine: second, home: '/home/second', folders: [DOCS] }
			];
			const queries: [string, LocationListArgs | CliListArgs][] = [];
			const starts: StartArgs[] = [];
			const selected: string[] = [];
			const scope = (machine: string) => ({ kind: 'machine', machine });
			const locations = new FrameworkLocations({
				folders: () => ui.workspaceFolders,
				onDidChangeFolders: new TestEmitter<void>().event,
				list: async args => {
					assert.deepStrictEqual(args, { folders: [DOCS.path] });
					return { locations: [{ location_id: GUIDE.id, path: DOCS.path, label: 'docs', kind: 'folder', source_folder: DOCS.path }] };
				},
				log: { event: assert.fail }
			});
			try {
				const { newAgent } = frameworkPickers({
					locations, hostMachineId: () => local.machine_id, machines: () => [local, first, second],
					listLocations: async args => {
						queries.push(['location.list', args]);
						const selector = args.scope?.kind === 'machine' ? args.scope.machine : undefined;
						const found = targets.find(({ machine }) => machine.selector === selector);
						assert.ok(found);
						return { locations: [{ location_id: 'loc-home', path: found.home, label: 'Login home', kind: 'folder' }] };
					},
					listClis: async args => {
						queries.push(['cli.list', args]);
						return { clis: [{ cli: 'claude', display_name: args.scope?.kind === 'machine' ? 'Remote Claude' : 'Claude Code', available: true, overrides: { model: false, effort: false } }] };
					},
					start: async args => { starts.push(args); return 'remote-run'; },
					select: run => selected.push(run)
				});
				for (const [index, { machine, home, folders }] of targets.entries()) {
					ui.workspaceFolders = folders;
					const done = newAgent();
					await settle();
					assert.strictEqual(ui.current!.labels()[0], folders.length ? 'Claude Code' : 'Open Folder...');
					ui.current!.accept('Change Location...');
					await settle();
					ui.current!.accept('Change Machine...');
					await settle();
					const picker = ui.current!;
					assert.deepStrictEqual(picker.items.map(item => [item.label, item.description]), [
						['This machine', local.name], ['buildbox', first.selector], ['buildbox', second.selector]
					]);
					picker.activate(index + 1);
					picker.accept();
					await settle();
					assert.strictEqual(ui.current!.title, 'New Agent · Working Location · buildbox');
					assert.strictEqual(ui.current!.item('Login home').description, home);
					ui.current!.accept('Login home');
					await settle();
					assert.deepStrictEqual(ui.current!.labels(), ['Remote Claude', 'Options', 'Change Location...', 'Change Name...']);
					if (folders.length) {
						ui.current!.accept('Change Location...');
						await settle();
						ui.current!.accept('Change Machine...');
						await settle();
						assert.strictEqual(ui.current!.activeItems[0]?.description, machine.selector);
						ui.current!.accept('This machine');
						await settle();
						ui.current!.accept('docs');
						await settle();
						assert.strictEqual(ui.current!.labels()[0], 'Claude Code');
						ui.current!.accept('Change Location...');
						await settle();
						ui.current!.accept('Change Machine...');
						await settle();
						assert.strictEqual(ui.current!.activeItems[0]?.label, 'This machine');
						ui.current!.activate(index + 1);
						ui.current!.accept();
						await settle();
						ui.current!.accept('Login home');
						await settle();
					}
					ui.current!.accept('Remote Claude');
					await done;
				}
				assert.deepStrictEqual(queries, [
					['location.list', { scope: scope(first.selector), folders: [] }], ['cli.list', { scope: scope(first.selector), folder: targets[0].home }],
					['cli.list', { folder: DOCS.path, scope: undefined }],
					['location.list', { scope: scope(second.selector), folders: [] }], ['cli.list', { scope: scope(second.selector), folder: targets[1].home }],
					['location.list', { scope: scope(second.selector), folders: [] }],
					['cli.list', { folder: DOCS.path, scope: undefined }],
					['location.list', { scope: scope(second.selector), folders: [] }], ['cli.list', { scope: scope(second.selector), folder: targets[1].home }]
				]);
				assert.deepStrictEqual(starts, targets.map(({ machine, home }) => ({ scope: scope(machine.selector), folder: home, cli: 'claude', size: { cols: 80, rows: 24 } })));
				assert.deepStrictEqual(selected, ['remote-run', 'remote-run']);
			} finally {
				locations.dispose();
			}
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
	});

	suite('Resume Agent', () => {

		test('LIFECYCLE-5.4: Resume uses one query per root and preserves distinct agents with the same session', async () => {
			ui.workspaceFolders = [SHOP, DOCS];
			const candidate = { cli: 'claude', folder: MAIN.path, machine_id: 'local-id', session: 'shared', title: 'Saved title' };
			const firstRef = { machine_id: candidate.machine_id, agent_id: 'a1' };
			const secondRef = { machine_id: candidate.machine_id, agent_id: 'a2' };
			const first: ResumeCandidate = { ...candidate, target: { kind: 'agent', reference: firstRef }, agent: firstRef };
			const second: ResumeCandidate = { ...candidate, target: { kind: 'agent', reference: secondRef }, agent: secondRef };
			const history: ResumeCandidate = {
				...candidate, session: 'session', title: 'CLI history',
				target: { kind: 'session', machine_id: candidate.machine_id, cli: candidate.cli, session: 'session', folder: MAIN.path }
			};
			const queries: ResumeListArgs[] = [];
			const picked: ResumeCandidate[] = [];
			const selected: string[] = [];
			const { resumeAgent } = frameworkPickers({
				listResumes: async args => {
					queries.push(args);
					return {
						items: args.folder === SHOP.path ? [first, second, history] : [second, history],
						machines: [{ machine_id: candidate.machine_id, short_id: '11111111', name: 'mbp', selector: 'mbp', state: 'online', status: 'answered' }]
					};
				},
				resume: async entry => { picked.push(entry); return 'resumed'; },
				select: run => selected.push(run)
			});
			const done = resumeAgent();
			await settle();
			const picker = ui.current!;
			assert.strictEqual(picker.title, 'Resume Agent');
			assert.deepStrictEqual(queries, [SHOP.path, DOCS.path].map(folder => ({ folder, scope: { kind: 'local' }, folder_scope: 'cwd' })));
			assert.deepStrictEqual(picker.items.map(item => item.description?.split(' · ').at(-1)), ['a1@mbp', 'a2@mbp', 'claude:session']);
			picker.activate(1);
			picker.accept();
			await done;
			assert.deepStrictEqual(picked, [second]);
			assert.strictEqual(picked[0], second);
			assert.deepStrictEqual(selected, ['resumed']);
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

	suite('Stop Agent and location icons', () => {
		test('LIFECYCLE-5.3: Stop lists managed rows in roster order and uses the exact selected reference', async () => {
			const local: AgentListEntry = {
				reference: { machine_id: 'local-id', agent_id: 'a1' }, address: 'a1@mbp', name: 'Ada', type: 'managed',
				state: 'working', cli: 'claude', folder: MAIN.path, started_at: '2026-11-19T01:00:00Z'
			};
			const remote: AgentListEntry = {
				...local, reference: { machine_id: 'gpu-id', agent_id: 'a1' }, address: 'a1@1234abcd', name: 'Remote Ada',
				title: 'Fix\nlogin', folder: '/server/app', started_at: '2026-11-19T01:01:00Z'
			};
			const guest: AgentListEntry = { ...local, reference: { machine_id: 'local-id', agent_id: 'a2' }, address: 'a2@mbp', type: 'guest', state: 'online' };
			const stopped: AgentListEntry[] = [];
			let queries = 0;
			const { stopAgent } = frameworkPickers({
				listAgents: async () => { queries++; return { agents: [remote, guest, local], machines: [] }; },
				stop: async entry => { stopped.push(entry); }
			});
			assert.strictEqual(queries, 0);
			const done = stopAgent();
			const picker = ui.current!;
			assert.strictEqual(picker.busy, true);
			await settle();
			assert.strictEqual(queries, 1);
			assert.deepStrictEqual(picker.items.map(item => [item.label, item.description, item.buttons]), [
				['Remote Ada', 'a1@1234abcd · /server/app', undefined],
				['Ada', `a1@mbp · ${MAIN.path}`, undefined]
			]);
			assert.strictEqual(picker.matchOnDescription, true);
			picker.accept('Remote Ada');
			await done;
			assert.deepStrictEqual(stopped, [remote]);
			assert.strictEqual(stopped[0], remote);
		});

		test('PANEL-1.5, WORKTREES-1.2: a location picker\'s icon is repo for a main checkout\'s root, worktree for a linked root, folder for a workspace folder opened inside a checkout and for a plain folder', () => {
			const { locationIcon } = load<typeof import('../ui/pickers/location')>(require.resolve('../ui/pickers/location'));
			const at = (more: Partial<Location>) => (locationIcon({ ...MAIN, ...more } as Location) as unknown as { id: string }).id;
			assert.deepStrictEqual([at({ kind: 'checkout', isMain: true }), at({ kind: 'checkout', isMain: false }), at({ kind: 'checkout', isMain: false, subfolder: true }), at({ kind: 'folder' })],
				['repo', 'worktree', 'folder', 'folder']);
		});
	});
});

