/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Each test window runs this workspace extension beside Facade. Files in the isolated test
// directory let the runner interleave actions in two editor windows of the same Facade home.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentInfo, HelloResult, StartArgs, StartResult, WindowRef } from '../../base/coreProtocol';
import type { PanelState } from '../../webview/protocol';
import { callInCore, helloInCore, normalizeDriveLetter, until } from './editors';
import { agentTab, aliasOf, facade, facadeAs, hasAgentTab, keepConversation, listed, newCard, pickCard, pin, running, state, stop } from './rustWindowDriver';

type Action =
	| { readonly kind: 'snapshot' | 'notifications' | 'filter' }
	| { readonly kind: 'start'; readonly screen: string; readonly secondGroup?: boolean }
	| { readonly kind: 'adopt' | 'pin' | 'stop' | 'members' | 'saved-pin'; readonly agent: string }
	| { readonly kind: 'running'; readonly agent: string; readonly screen?: string }
	| { readonly kind: 'send'; readonly agent: string; readonly text: string }
	| { readonly kind: 'message'; readonly id: string }
	| { readonly kind: 'wait-for-exit'; readonly pid: number }
	| { readonly kind: 'worktree'; readonly source: WindowRef; readonly peer: WindowRef; readonly branch: string }
	| { readonly kind: 'worktree-removed'; readonly id: string; readonly folder: string };

export type WindowAction = Action | { readonly kind: 'close' };

export interface WindowReady {
	readonly folder: string;
	readonly remote: string | null;
	readonly home: string;
	readonly machineId: string;
}

export interface PinIdentity {
	readonly id: string;
	readonly agent?: string;
	readonly machine_id?: string;
}

export interface SavedPin {
	readonly file: string;
	readonly pin: PinIdentity;
}

export interface WindowView {
	readonly cards: readonly { readonly id: string; readonly pinned: boolean; readonly column: number | null; readonly selected: boolean }[];
	readonly terminals: number;
	readonly filter?: PanelState['filter'];
}

export type WindowAnswer = { readonly result: unknown } | { readonly error: string };

const control = process.env.FACADE_IT_WINDOW_CONTROL!;
const gitTrace = `${control}.git.jsonl`;
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
			id: card.alias.slice(1), pinned: card.pinned === true, column: agentTab(card)?.group.viewColumn ?? null, selected: card.selected
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
		const file = path.join(workspaces, key, 'workspace-state.json');
		if (!fs.existsSync(file)) { return []; }
		const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { readonly 'facade.pins'?: PinIdentity[] };
		return (state['facade.pins'] ?? []).filter(pin => pin.agent === id).map(pin => ({ file, pin }));
	});
	assert.strictEqual(found.length, 1, `one workspace saved a Pin for #${id}: ${JSON.stringify(found)}`);
	return found[0];
}

async function perform(action: Action): Promise<unknown> {
	switch (action.kind) {
		case 'snapshot':
			return view();
		case 'start': {
			if (action.secondGroup) { await openSecondGroup(); }
			const card = await newCard();
			const agent = await running(aliasOf(card).slice(1));
			keepConversation(agent.cwd, agent.session, action.screen);
			facade('type', agent.id, action.screen, '--enter');
			await until(`#${agent.id}'s screen text`, () => facade('screen', agent.id, '--lines', '120').includes(action.screen) || undefined);
			return agent;
		}
		case 'filter':
			await filterByLocation();
			return true;
		case 'members': {
			const record = listed().find(agent => agent.agent_id === action.agent);
			assert.ok(record?.windows?.length, `#${action.agent} has member windows`);
			return record.windows;
		}
		case 'saved-pin':
			return savedPin(action.agent);
		case 'adopt': {
			const card = await pickCard('facade.showActiveAgents');
			assert.strictEqual(aliasOf(card), `#${action.agent}`, 'the picker opens the requested agent by its original number');
			await until(`#${action.agent}'s terminal tab`, () => hasAgentTab(card) || undefined);
			return running(action.agent);
		}
		case 'pin':
		case 'stop': {
			const card = (await state()).cards.find(each => each.alias === `#${action.agent}`);
			assert.ok(card, `#${action.agent} has a visible card`);
			await (action.kind === 'pin' ? pin(card) : stop(card));
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
			const sent = facadeAs(action.agent, 'send', '#human', action.text);
			const id = /#(m\d+)/u.exec(sent)?.[1];
			assert.ok(id, sent);
			return id;
		}
		case 'notifications':
			await vscode.commands.executeCommand('notifications.showList');
			return true;
		case 'message': {
			const document = await until(`Open Message to open #${action.id}`, () => vscode.workspace.textDocuments.find(each =>
				each.uri.scheme === 'facade-message' && each.uri.query === action.id));
			return document.getText();
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
			fs.mkdirSync(user, { recursive: true });
			const args: StartArgs = {
				command: ['claude'], name: 'Agent in the other window', cwd, window: action.peer,
				location_source_window: action.source, worktree: { branch: action.branch, base_ref: 'HEAD' },
				env: {
					PATH: process.env.PATH ?? '', HOME: user, USERPROFILE: user, FACADE_HOME: home,
					CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR!, FACADE_IT_RECORD: process.env.FACADE_IT_RECORD!
				},
				cols: 80, rows: 24
			};
			const reply = await callInCore(home, 'agent.start', args);
			assert.ok(reply.result && !reply.error, JSON.stringify(reply));
			const started = (reply.result as StartResult).agent;
			assert.ok(started.pid && fs.existsSync(started.cwd), JSON.stringify(started));
			assert.deepStrictEqual(started.windows, [action.peer]);
			assert.deepStrictEqual(started.location_source_window, action.source);
			process.env.GIT_TRACE2_EVENT = gitTrace;
			void vscode.commands.executeCommand('facade.newAgent');
			return started;
		}
		case 'worktree-removed': {
			await until('Git to remove the fixture worktree', () => !fs.existsSync(action.folder) || undefined);
			const agents = JSON.parse(facade('list', '--json')) as AgentInfo[];
			const ended = agents.find(agent => agent.agent_id === action.id);
			assert.ok(ended?.process === 'ended' && ended.exit?.at, JSON.stringify(ended));
			const trace = fs.readFileSync(gitTrace, 'utf8').trim().split('\n')
				.map(line => JSON.parse(line) as { event: string; argv?: string[]; time: string });
			const folder = normalizeDriveLetter(action.folder);
			const removal = trace.find(entry => entry.event === 'start' && entry.argv?.some(word => normalizeDriveLetter(word) === folder)
				&& entry.argv.includes('worktree') && entry.argv.includes('remove'));
			assert.ok(removal, 'Git traced the worktree removal');
			assert.ok(Date.parse(ended.exit.at) <= Date.parse(removal.time), `#${action.id} ended before Git started removal`);
			delete process.env.GIT_TRACE2_EVENT;
			await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
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
		const hello = await helloInCore(home);
		const core = hello.result as HelloResult | undefined;
		assert.ok(core?.protocol === 2 && core.machine_id, JSON.stringify(hello));
		answer(`${control}.ready`, { result: { folder, remote: vscode.env.remoteName ?? null, home, machineId: core.machine_id } satisfies WindowReady });
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
