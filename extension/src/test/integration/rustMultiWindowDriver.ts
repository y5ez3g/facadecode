/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each test window runs this workspace extension beside Facade. Files in the isolated test
// directory let the runner interleave actions in two editor windows of the same Facade home.

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HelloResult, StartArgs } from '../../base/coreProtocol';
import type { RustPin } from '../../core/ports';
import type { PanelState } from '../../webview/protocol';
import { coreCall, helloInCore, normalizeDriveLetter, until } from './editors';
import { RESUME_PICKER_STATE, type ResumePickerState } from './resumePickerFixture';
import { agentTab, facade, hasAgentTab, inspect, keepConversation, newCard, pin, resumeCard, running, state, stop } from './rustWindowDriver';
import type { WindowTerminalIdentity } from '../../base/windowIdentity';
import type { OwnerClaim } from '../../base/ownership';

type Action =
	| { readonly kind: 'snapshot' | 'filter' | 'window-component' | 'terminal-owner' | 'show-notifications' | 'show-failure-panel' | 'request-refused-agent' }
	| { readonly kind: 'start-fallback' }
	| { readonly kind: 'pin-owned'; readonly run: string }
	| { readonly kind: 'panel-generation' }
	| { readonly kind: 'stale-owner'; readonly previous: OwnerClaim; readonly current: OwnerClaim; readonly page: string; readonly runs: readonly [string, string] }
	| { readonly kind: 'stop-fallback'; readonly runId: string }
	| { readonly kind: 'open-shell-agent'; readonly name: string; readonly address: string; readonly text: string }
	| { readonly kind: 'shell-attach-view'; readonly grid?: vscode.TerminalDimensions; readonly text?: string; readonly resize?: boolean }
	| { readonly kind: 'settings-path'; readonly file: string }
	| { readonly kind: 'shell-pin'; readonly name: string; readonly set?: boolean }
	| { readonly kind: 'hide-shell-agent'; readonly name: string }
	| { readonly kind: 'start'; readonly screen?: string; readonly secondGroup?: boolean }
	| { readonly kind: 'adopt' | 'resume' | 'pin' | 'unpin' | 'stop' | 'remove' | 'inspect' | 'saved-pin'; readonly agent: string }
	| { readonly kind: 'remote-card'; readonly agent: string; readonly machine: string }
	| { readonly kind: 'running'; readonly agent: string; readonly screen?: string }
	| { readonly kind: 'send'; readonly to: string; readonly text: string }
	| { readonly kind: 'wait-for-exit'; readonly pid: number }
	| { readonly kind: 'worktree'; readonly branch: string }
	| { readonly kind: 'delete-worktree'; readonly folder: string };

export type WindowAction = Action | { readonly kind: 'close' };

export interface WindowReady {
	readonly folder: string;
	readonly remote: string | null;
	readonly home: string;
	readonly machineId: string | null;
	readonly platform: NodeJS.Platform;
	readonly hostPid: number;
}

export interface SavedPin {
	readonly file: string;
	readonly pin: RustPin;
}

export interface WindowView {
	readonly cards: readonly { readonly id: string; readonly name: string; readonly pinned: boolean; readonly column: number | null; readonly running: boolean }[];
	readonly terminals: number;
	readonly filter?: PanelState['filter'];
}

export interface AttachView {
	readonly capacity: vscode.TerminalDimensions;
	readonly grid: vscode.TerminalDimensions;
}

export type WindowAnswer = { readonly result: unknown } | { readonly error: string };

const control = process.env.FACADE_IT_WINDOW_CONTROL!;
let closing: string | undefined;
let attached: {
	readonly terminal: vscode.Terminal;
	readonly pty: vscode.Pseudoterminal & { readonly dimensions?: vscode.TerminalDimensions };
	readonly watching: vscode.Disposable;
	override?: vscode.TerminalDimensions;
	text: string;
} | undefined;

function answer(file: string, value: WindowAnswer): void {
	const temporary = `${file}.new`;
	fs.writeFileSync(temporary, JSON.stringify(value));
	fs.renameSync(temporary, file);
}

async function view(): Promise<WindowView> {
	const panel = await state();
	return {
		cards: panel.cards.map(card => ({
			id: card.alias, name: card.name, pinned: card.pinned === true,
			column: agentTab(card)?.group.viewColumn ?? null, running: card.orchestrator?.running === true
		})),
		terminals: vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTerminal).length,
		filter: panel.filter
	};
}

async function goToCard(reference: string): Promise<PanelState['cards'][number]> {
	const { agent } = await inspect(reference);
	assert.strictEqual(agent.process, 'running', `${agent.address} can be attached. Exit ${JSON.stringify(agent.exit)}`);
	const picker = vscode.commands.executeCommand('facade.goToAgent');
	let closed = false;
	void picker.then(() => { closed = true; }, () => { closed = true; });
	let observed: ResumePickerState | undefined;
	await until(`Go to Agent to select ${agent.address}`, async () => {
		if (closed) {
			await picker;
			throw new Error(`Go to Agent closed before selecting ${agent.address}`);
		}
		observed = await vscode.commands.executeCommand<ResumePickerState>(RESUME_PICKER_STATE).then(value => value, () => undefined);
		if (!observed || observed.busy) { return undefined; }
		const current = observed;
		const target = current.descriptions.findIndex((description, index) =>
			current.labels[index] === agent.name && description?.startsWith(`${agent.address} · `));
		if (target < 0) { return undefined; }
		if (target === current.active) { return true; }
		await vscode.commands.executeCommand(target < current.active ? 'workbench.action.quickOpenSelectPrevious' : 'workbench.action.quickOpenSelectNext');
		return undefined;
	}).catch(error => { throw new Error(`${(error as Error).message}; picker: ${JSON.stringify(observed)}`); });
	await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
	const card = await until(`${agent.address}'s attached card`, async () => (await state()).cards.find(card =>
		card.runId === `${agent.reference.machine_id}/${agent.reference.agent_id}` && card.orchestrator?.running));
	await picker;
	return card;
}

async function openSecondGroup(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
	for (const column of [vscode.ViewColumn.One, vscode.ViewColumn.Two]) {
		const file = path.join(folder, `view-${column}.md`);
		fs.writeFileSync(file, `Editor group ${column}\n`);
		await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: column, preview: false });
	}
}

async function filterByLocation(): Promise<void> {
	await until('the selected working-location filter', async () => {
		const panel = await state();
		if (panel.filter) { return panel.filter; }
		void vscode.commands.executeCommand('facade.filter');
		await new Promise(resolve => setTimeout(resolve, 2_500));
		await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		return (await state()).filter;
	}, 60_000);
}

function savedPin(id: string): SavedPin {
	const workspaces = path.join(process.env.FACADE_HOME!, 'extension', 'workspaces');
	const found = fs.readdirSync(workspaces).flatMap(key => {
		const file = path.join(workspaces, key, 'orchestrator-workspace.json');
		if (!fs.existsSync(file)) { return []; }
		const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { readonly pins: RustPin[] };
		return state.pins.filter(pin => pin.agent === id).map(pin => ({ file, pin }));
	});
	assert.strictEqual(found.length, 1, `one workspace saved a Pin for #${id}: ${JSON.stringify(found)}`);
	return found[0];
}

interface GenerationAction {
	readonly page: string;
	readonly action: string;
	readonly what: 'unpin';
	readonly target: string;
}

async function panelGeneration(actions: readonly GenerationAction[] = []): Promise<{ page: string; outcomes: readonly { action: string; page: string; ok: boolean }[] }> {
	const found = await vscode.commands.executeCommand<{ page: string; outcomes: readonly { action: string; page: string; ok: boolean }[] }>(
		'facade.probe', { op: 'generation-fixture', selector: JSON.stringify(actions) });
	assert.match(found.page, /^[0-9a-f]{32}$/u);
	return found;
}

async function perform(action: Action): Promise<unknown> {
	switch (action.kind) {
		case 'snapshot':
			return view();
		case 'show-notifications':
			await vscode.commands.executeCommand('notifications.showList');
			return true;
		case 'show-failure-panel':
			await vscode.commands.executeCommand('facade.agents.focus');
			return true;
		case 'request-refused-agent':
			await vscode.commands.executeCommand('notifications.clearAll');
			assert.strictEqual(await vscode.commands.executeCommand('facade.newAgent'), undefined);
			assert.strictEqual(vscode.window.terminals.length, 0);
			return true;
		case 'start-fallback': {
			const before = new Set((await state()).cards.map(card => card.runId));
			const picker = vscode.commands.executeCommand('facade.newAgent');
			void picker.then(undefined, () => undefined);
			const card = await until('the old-engine card and terminal', async () => {
				const panel = await state();
				const first = panel.cards.find(card => !before.has(card.runId));
				if (first && agentTab(first)) { return first; }
				await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
				return undefined;
			});
			await picker;
			assert.equal(card.orchestrator, undefined);
			assert.match(card.alias, /^#a\d+$/u);
			return { runId: card.runId, alias: card.alias, name: card.name };
		}
		case 'pin-owned': {
			const card = (await state()).cards.find(each => each.runId === action.run);
			assert.ok(card);
			await pin(card);
			return true;
		}
		case 'panel-generation':
			return (await panelGeneration()).page;
		case 'stale-owner': {
			const { previous, current, runs } = action;
			const cards = () => state().then(panel => panel.cards.filter(each => runs.includes(each.runId)));
			await until('both old-engine Pins and their tabs to return', async () => {
				const live = await cards();
				return live.length === 2 && live.every(card => card.pinned && !card.orchestrator && hasAgentTab(card))
					&& vscode.window.terminals.length === 2 || undefined;
			});
			const { page } = await panelGeneration();
			assert.notStrictEqual(page, action.page);
			const terminals = [...vscode.window.terminals];
			const request = (claim: OwnerClaim, value: object) => vscode.commands.executeCommand(
				'facade.window.terminals', { session: vscode.env.sessionId, claim, ...value });
			assert.strictEqual(await request(previous, { kind: 'activate' }), false);
			assert.strictEqual(await request(previous, { kind: 'retire', runs: [], hidden: [...runs] }), false);
			for (const run of runs) { assert.strictEqual(await request(previous, { kind: 'begin', run }), false); }
			assert.strictEqual(await request(current, { kind: 'activate' }), true);
			assert.ok(terminals.every(terminal => vscode.window.terminals.includes(terminal)));

			const replay = runs.map((target, index) => ({ page: action.page, action: `${action.page}-${index + 1}`, what: 'unpin' as const, target }));
			await panelGeneration(replay);
			assert.deepStrictEqual((await cards()).map(card => [card.runId, card.pinned]).sort(), runs.map(run => [run, true]).sort());
			const fresh = { page, action: `${page}-1`, what: 'unpin' as const, target: runs[0] };
			await panelGeneration([fresh]);
			await until('only the current generation’s exact target to unpin', async () => {
				const now = new Map((await cards()).map(card => [card.runId, card.pinned === true]));
				return now.get(runs[0]) === false && now.get(runs[1]) === true || undefined;
			});
			const observed = await until('the current generation’s action outcome', async () => {
				const seen = await panelGeneration();
				return seen.outcomes.some(outcome => outcome.action === fresh.action) ? seen.outcomes : undefined;
			});
			assert.deepStrictEqual(observed, [{ type: 'outcome', page, action: fresh.action, ok: true }]);
			assert.strictEqual(vscode.window.terminals.length, 2);
			assert.ok(terminals.every(terminal => vscode.window.terminals.includes(terminal)));
			return { page, refusedActions: replay.length };
		}
		case 'stop-fallback':
			await vscode.commands.executeCommand('facade.stopAgent', { run_id: action.runId });
			return true;
		case 'window-component':
			return vscode.extensions.getExtension('facade.facadecode-window') !== undefined;
		case 'terminal-owner': {
			assert.ok(vscode.extensions.getExtension('facade.facadecode-window')?.isActive);
			const session = vscode.env.sessionId;
			const command = 'facade.window.terminalOwner';
			const owner = await vscode.commands.executeCommand<WindowTerminalIdentity>(command, session);
			assert.strictEqual(owner?.version, 1);
			assert.strictEqual(owner.session, session);
			assert.match(owner.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
			assert.deepStrictEqual(await vscode.commands.executeCommand(command, session), owner,
				'the local terminal handover identity is stable');
			assert.strictEqual(await vscode.commands.executeCommand(command, `${session}-stale`), undefined);
			return true;
		}
		case 'settings-path':
			for (const command of ['facade.openSettings', 'facade.openSettingsFile']) {
				await vscode.commands.executeCommand(command);
				await until(`${command} to open the Orchestrator settings file`, () => {
					const file = vscode.window.activeTextEditor?.document.uri.fsPath;
					return file && normalizeDriveLetter(file) === normalizeDriveLetter(action.file) || undefined;
				});
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			}
			return true;
		case 'open-shell-agent': {
			const card = await goToCard(action.address);
			assert.strictEqual(card.name, action.name);
			const terminal = await until('Go to Agent to select the attached terminal', () => {
				const tab = agentTab(card);
				if (!tab?.isActive || !tab.group.isActive) { return undefined; }
				return vscode.window.terminals.find(each =>
					'pty' in each.creationOptions && each.creationOptions.name === card.name);
			});
			const pty = (terminal.creationOptions as vscode.ExtensionTerminalOptions).pty as NonNullable<typeof attached>['pty'];
			attached?.watching.dispose();
			const output = pty.onDidWrite(text => { if (attached?.terminal === terminal) { attached.text += text; } });
			const grid = pty.onDidOverrideDimensions?.(dimensions => {
				if (attached?.terminal === terminal) { attached.override = dimensions; }
			});
			attached = {
				terminal, pty, text: '', watching: vscode.Disposable.from(output, ...(grid ? [grid] : []))
			};
			terminal.sendText(action.text, true);
			await until('the editor input on the agent screen', () =>
				facade('screen', action.address, '--lines', '120').includes(action.text) || undefined);
			return action.address;
		}
		case 'shell-attach-view': {
			const view = attached;
			assert.ok(view, 'Go to Agent opened a terminal');
			const previous = view.pty.dimensions;
			if (action.resize) {
				await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
			}
			return await until('the terminal capacity and shared grid', () => {
				const capacity = view.pty.dimensions;
				const grid = view.override ?? capacity;
				if (!capacity || !grid) { return undefined; }
				if (action.resize && capacity.columns === previous?.columns && capacity.rows === previous?.rows) { return undefined; }
				if (action.grid && (grid.columns !== action.grid.columns || grid.rows !== action.grid.rows)) { return undefined; }
				if (action.text && !view.text.includes(action.text)) { return undefined; }
				return { capacity, grid } satisfies AttachView;
			});
		}
		case 'shell-pin': {
			const find = async () => (await state()).cards.find(card => card.name === action.name);
			const card = await until(`${action.name}'s card`, find);
			if (action.set) {
				await vscode.commands.executeCommand('facade.openTerminal', { run_id: card.runId });
				await vscode.commands.executeCommand('facade.pinAgent', { run_id: card.runId });
			}
			await until(`${action.name}'s pinned terminal`, async () => {
				const current = await find();
				return current?.pinned && hasAgentTab(current) || undefined;
			}).catch(async error => {
				const snapshot = await state();
				const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({
					label: tab.label, terminal: tab.input instanceof vscode.TabInputTerminal, column: group.viewColumn, pinned: tab.isPinned
				})));
				const terminals = vscode.window.terminals.map(terminal => ({ name: terminal.name, exit: terminal.exitStatus }));
				throw new Error(`${(error as Error).message}\n${JSON.stringify({ cards: snapshot.cards, tabs, terminals })}`);
			});
			return true;
		}
		case 'hide-shell-agent': {
			const card = await until(`${action.name}'s card`, async () =>
				(await state()).cards.find(each => each.name === action.name));
			await vscode.commands.executeCommand('facade.hideAgent', { run_id: card.runId });
			return true;
		}
		case 'start': {
			if (action.secondGroup) { await openSecondGroup(); }
			const card = await newCard();
			const agent = await running(card.alias);
			const screen = action.screen;
			keepConversation(agent.cwd, agent.session, screen ?? 'A session opened in this window');
			if (screen !== undefined) {
				facade('type', agent.id, screen, '--enter');
				let read = '';
				await until(`#${agent.id}'s screen text`, () => {
					read = facade('screen', agent.id, '--lines', '120');
					return read.includes(screen) || undefined;
				}).catch(error => { throw new Error(`${(error as Error).message}\n${read}`); });
			}
			return agent;
		}
		case 'filter':
			await filterByLocation();
			return true;
		case 'inspect':
			return inspect(action.agent);
		case 'saved-pin':
			return savedPin(action.agent);
		case 'adopt':
		case 'resume': {
			const card = await (action.kind === 'resume' ? resumeCard(action.agent) : goToCard(action.agent));
			assert.strictEqual(card.alias, action.agent, 'the picker opens the requested agent by its original number');
			await until(`#${action.agent}'s terminal tab`, () => hasAgentTab(card) || undefined);
			return running(action.agent);
		}
		case 'remote-card': {
			const { agent } = await inspect(action.agent);
			const card = await until(`${agent.address}'s card and details`, async () => (await state()).cards.find(card =>
				card.runId === `${agent.reference.machine_id}/${agent.reference.agent_id}` && card.details.machine?.value === action.machine));
			assert.strictEqual(card.details.address?.value, agent.address);
			assert.ok(!card.pinned, JSON.stringify(card));
			await until(`${card.alias}'s terminal tab`, () => hasAgentTab(card) || undefined);
			return agent.address;
		}
		case 'pin':
		case 'unpin':
		case 'stop':
		case 'remove': {
			const card = (await state()).cards.find(each => each.alias === action.agent);
			assert.ok(card, `#${action.agent} has a visible card`);
			if (action.kind === 'pin') { await pin(card); }
			else if (action.kind === 'unpin') {
				assert.ok(card.pinned);
				await vscode.commands.executeCommand('facade.unpinAgent', { run_id: card.runId });
				await until('the same card without its Pin', async () =>
					(await state()).cards.find(each => each.runId === card.runId && !each.pinned));
			}
			else if (action.kind === 'stop') { await stop(card); }
			else { await vscode.commands.executeCommand('facade.deleteAgent', { run_id: card.runId }); }
			return true;
		}
		case 'running': {
			const agent = await running(action.agent);
			if (action.screen !== undefined) {
				assert.ok(facade('screen', agent.id, '--lines', '120').includes(action.screen), `#${agent.id} keeps its screen text`);
			}
			return agent;
		}
		case 'send': {
			const { agent } = await inspect(action.to);
			const sent = facade('send', action.to, action.text).trimEnd();
			const message = /^Delivered (m\d+@[^\s]+) to /u.exec(sent)?.[1];
			assert.ok(message, sent);
			assert.strictEqual(sent, `Delivered ${message} to ${agent.name} (${agent.address}).`);
			await until('the message to appear on the recipient terminal', () =>
				facade('screen', action.to, '--lines', '120').includes(action.text) || undefined);
			const received = fs.readFileSync(`${process.env.FACADE_IT_RECORD}.received.#${agent.reference.agent_id}`, 'utf8')
				.trimEnd().split(/\r?\n/u).map(line => JSON.parse(line) as string);
			assert.strictEqual(received.filter(text => text.endsWith(` · ${message.split('@')[0]}\n${action.text}`)).length, 1);
			return true;
		}
		case 'wait-for-exit':
			await until(`PID ${action.pid} to exit`, () => {
				try {
					process.kill(action.pid, 0);
					return undefined;
				} catch (error) {
					assert.strictEqual((error as NodeJS.ErrnoException).code, 'ESRCH');
					return true;
				}
			});
			return true;
		case 'worktree': {
			const cwd = vscode.workspace.workspaceFolders![0].uri.fsPath;
			const home = process.env.FACADE_HOME!;
			const user = path.join(path.dirname(control), 'worktree-agent-home');
			// The Windows Node fixture needs SystemRoot to initialize its random number generator.
			const systemRoot = process.platform === 'win32' ? process.env.SystemRoot : undefined;
			fs.mkdirSync(user, { recursive: true });
			const args: StartArgs = {
				cli: 'claude', name: 'Worktree agent', folder: cwd, worktree: action.branch,
				env: {
					...(systemRoot ? { SystemRoot: systemRoot } : {}),
					PATH: process.env.PATH ?? '', HOME: user, USERPROFILE: user, FACADE_HOME: home,
					CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR!, FACADE_IT_RECORD: process.env.FACADE_IT_RECORD!
				},
				size: { cols: 80, rows: 24 }
			};
			const { agent: started } = await coreCall(home, 'agent.start', args);
			assert.ok(started.pid && fs.existsSync(started.cwd), JSON.stringify(started));
			return started;
		}
		case 'delete-worktree': {
			const cwd = vscode.workspace.workspaceFolders![0].uri.fsPath;
			execFileSync('git', ['-C', cwd, 'worktree', 'remove', action.folder], { timeout: 20_000 });
			assert.ok(!fs.existsSync(action.folder), 'Git removed the fixture worktree');
			return true;
		}
	}
}

async function actions(): Promise<void> {
	for (let number = 1; ; number++) {
		const request = `${control}.${number}.request`;
		const response = `${control}.${number}.answer`;
		try {
			const action = await until(`the runner's window action ${number}`, () =>
				fs.existsSync(request) ? JSON.parse(fs.readFileSync(request, 'utf8')) as WindowAction : undefined, 120_000);
			if (action.kind === 'close') {
				closing = response;
				void vscode.commands.executeCommand('workbench.action.closeWindow').then(undefined, error => {
					answer(response, { error: String(error) });
				});
				return;
			}
			answer(response, { result: await perform(action) });
		} catch (error) {
			answer(response, { error: error instanceof Error ? error.stack ?? error.message : String(error) });
			return;
		}
	}
}

export async function activate(): Promise<void> {
	try {
		const home = process.env.FACADE_HOME;
		assert.ok(home && normalizeDriveLetter(home).startsWith(normalizeDriveLetter(`${path.dirname(control)}${path.sep}`)),
			'the window and driver use the test Facade home');
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		assert.ok(folder, 'the test window has a workspace folder');
		const extension = vscode.extensions.getExtension('facade.facadecode')!;
		const incompatible = process.env.FACADE_IT_WINDOW_INCOMPATIBLE === '1';
		if (incompatible) {
			assert.strictEqual(vscode.workspace.getConfiguration('facade').get('rustEngine'), 'auto');
			assert.ok(vscode.extensions.getExtension('facade.facadecode-window'), 'the old engine has its Window Component available');
			await assert.rejects(async () => extension.activate(), /Facade core did not select an offered daemon API version\./u);
		} else {
			await extension.activate();
			await until('the panel snapshot', async () => (await state())?.loading === false || undefined, 90_000);
		}
		if (process.env.FACADE_IT_WINDOW_NO_COMPONENT === '1') {
			assert.strictEqual(vscode.extensions.getExtension('facade.facadecode-window'), undefined);
		}
		const oldEngine = vscode.workspace.getConfiguration('facade').get('rustEngine') === 'off';
		const fallback = process.env.FACADE_IT_WINDOW_FALLBACK === '1';
		let machineId: string | null = null;
		if (oldEngine || fallback) {
			assert.ok(vscode.extensions.getExtension('facade.facadecode-window'));
			if (fallback) { assert.strictEqual(vscode.workspace.getConfiguration('facade').get('rustEngine'), 'auto'); }
		} else if (!incompatible) {
			const hello = await helloInCore(home);
			assert.ok('result' in hello, JSON.stringify(hello));
			const core = hello.result as HelloResult;
			assert.ok(core.api_version === 1 && core.machine_id, JSON.stringify(hello));
			machineId = core.machine_id;
		}
		answer(`${control}.ready`, { result: {
			folder, remote: vscode.env.remoteName ?? null, home, machineId, platform: process.platform, hostPid: process.pid
		} satisfies WindowReady });
		void actions();
	} catch (error) {
		answer(`${control}.ready`, { error: error instanceof Error ? error.stack ?? error.message : String(error) });
	}
}

export function deactivate(): void {
	if (closing) {
		answer(closing, { result: true });
	}
}
