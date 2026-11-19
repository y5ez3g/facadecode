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
import type { HelloResult, V3StartArgs, V3StartResult } from '../../base/coreProtocol';
import type { RustPin } from '../../core/ports';
import type { PanelState } from '../../webview/protocol';
import { callInCore, helloInCore, normalizeDriveLetter, until } from './editors';
import { agentTab, facade, facadeAs, hasAgentTab, inspect, keepConversation, newCard, pickCard, pin, resumeCard, running, state, stop } from './rustWindowDriver';

type Action =
	| { readonly kind: 'snapshot' | 'notifications' | 'filter' | 'show-agent-picker' | 'window-component' }
	| { readonly kind: 'open-shell-agent'; readonly name: string; readonly address: string; readonly text: string }
	| { readonly kind: 'settings-path'; readonly file: string }
	| { readonly kind: 'shell-pin'; readonly name: string; readonly set?: boolean }
	| { readonly kind: 'hide-shell-agent'; readonly name: string }
	| { readonly kind: 'start'; readonly screen?: string; readonly secondGroup?: boolean }
	| { readonly kind: 'adopt' | 'resume' | 'remote-card' | 'pin' | 'stop' | 'remove' | 'inspect' | 'saved-pin'; readonly agent: string }
	| { readonly kind: 'running'; readonly agent: string; readonly screen?: string }
	| { readonly kind: 'send'; readonly agent: string; readonly to: string; readonly text: string }
	| { readonly kind: 'wait-for-exit'; readonly pid: number }
	| { readonly kind: 'worktree'; readonly branch: string }
	| { readonly kind: 'delete-worktree'; readonly folder: string };

export type WindowAction = Action | { readonly kind: 'close' };

export interface WindowReady {
	readonly folder: string;
	readonly remote: string | null;
	readonly home: string;
	readonly machineId: string;
	readonly platform: NodeJS.Platform;
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

export type WindowAnswer = { readonly result: unknown } | { readonly error: string };

const control = process.env.FACADE_IT_WINDOW_CONTROL!;
let closing: string | undefined;

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

async function perform(action: Action): Promise<unknown> {
	switch (action.kind) {
		case 'snapshot':
			return view();
		case 'window-component':
			return vscode.extensions.getExtension('facade.facadecode-window') !== undefined;
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
			const card = await pickCard('facade.goToAgent');
			assert.strictEqual(card.name, action.name);
			await until(`${action.address}'s terminal tab`, () => hasAgentTab(card) || undefined);
			const terminal = vscode.window.activeTerminal;
			assert.ok(terminal && terminal.name.startsWith(card.name), 'Go to Agent selected the attached terminal');
			terminal.sendText(action.text, true);
			await until('the editor input on the agent screen', () =>
				facade('screen', action.address, '--lines', '120').includes(action.text) || undefined);
			return action.address;
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
				await until(`#${agent.id}'s screen text`, () => facade('screen', agent.id, '--lines', '120').includes(screen) || undefined);
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
			const card = await (action.kind === 'resume' ? resumeCard(action.agent) : pickCard('facade.goToAgent'));
			assert.strictEqual(card.alias, action.agent, 'the picker opens the requested agent by its original number');
			await until(`#${action.agent}'s terminal tab`, () => hasAgentTab(card) || undefined);
			return running(action.agent);
		}
		case 'show-agent-picker':
			void vscode.commands.executeCommand('facade.goToAgent');
			return true;
		case 'remote-card': {
			const card = await until(action.agent + "'s card", async () => (await state()).cards.find(card => card.alias === action.agent));
			assert.ok(card.runningOn && !card.pinned, JSON.stringify(card));
			await until(`${card.alias}'s terminal tab`, () => hasAgentTab(card) || undefined);
			await until(`${card.alias}'s remote icon`, async () => {
				const icons = await vscode.commands.executeCommand<string[]>('facade.probe', { op: 'read', selector: '.remote-status .remote-icon' });
				return icons?.length === 1 || undefined;
			});
			return card.alias;
		}
		case 'pin':
		case 'stop':
		case 'remove': {
			const card = (await state()).cards.find(each => each.alias === action.agent);
			assert.ok(card, `#${action.agent} has a visible card`);
			if (action.kind === 'pin') { await pin(card); }
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
			const sent = facadeAs(action.agent, 'send', action.to, action.text);
			assert.match(sent.trim(), /^m\d+@[^\s]+$/u);
			await until('the message to appear on the recipient terminal', () =>
				facade('screen', action.to, '--lines', '120').includes(action.text) || undefined);
			return true;
		}
		case 'notifications':
			await vscode.commands.executeCommand('notifications.showList');
			return true;
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
			fs.mkdirSync(user, { recursive: true });
			const args: V3StartArgs = {
				cli: 'claude', name: 'Worktree agent', folder: cwd, worktree: action.branch,
				env: {
					PATH: process.env.PATH ?? '', HOME: user, USERPROFILE: user, FACADE_HOME: home,
					CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR!, FACADE_IT_RECORD: process.env.FACADE_IT_RECORD!
				},
				cols: 80, rows: 24
			};
			const reply = await callInCore(home, 'agent.start', args, [3, 3]);
			assert.ok(reply.result && !reply.error, JSON.stringify(reply));
			const started = (reply.result as V3StartResult).agent;
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
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel snapshot', async () => (await state())?.loading === false || undefined, 90_000);
		if (process.env.FACADE_IT_WINDOW_PROTOCOL === '3') {
			assert.strictEqual(vscode.extensions.getExtension('facade.facadecode-window'), undefined);
		}
		const hello = await helloInCore(home, [3, 3]);
		const core = hello.result as HelloResult | undefined;
		assert.ok(core?.protocol === 3 && core.machine_id, JSON.stringify(hello));
		answer(`${control}.ready`, { result: {
			folder, remote: vscode.env.remoteName ?? null, home, machineId: core.machine_id, platform: process.platform
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
