/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A workspace extension beside Facade Code exercises real close and reload (RULES-4.1, LIFECYCLE-3.5).
// The runner keeps this workspace's profile and starts the next window when this one deactivates.

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentListEntry, HelloResult, V3AgentInfo, V3InspectResult } from '../../base/coreProtocol';
import type { RustPin } from '../../core/ports';
import type { PanelState } from '../../webview/protocol';
import { CoreConnectionClosed, coreCall, helloInCore, normalizeDriveLetter, until } from './editors';

type Card = PanelState['cards'][number];

export interface RunningAgent {
	readonly id: string;
	readonly pid: number;
	readonly session: string;
	readonly cwd: string;
}

type Closing =
	| { readonly after: 'reload'; readonly before: RunningAgent; readonly screenText: string }
	| { readonly after: 'pins'; readonly before: RunningAgent; readonly unpinned: RunningAgent; readonly removed: string };

export type Step = { readonly phase: 'started'; readonly agent: RunningAgent }
	| ({ readonly phase: 'closed' } & Closing)
	| { readonly phase: 'reloaded' | 'reopened' | 'replaced' | 'done' | 'error'; readonly detail?: unknown };

// Kept on the screen by the fake CLI after Enter, even if the terminal is resized on reopening.
const WINDOW_TEXT = 'Window lifetime screen';

const HOME = process.env.FACADE_HOME!;
const OUT = process.env.FACADE_IT_WINDOW_LIFETIME!;
let closing: Closing | undefined;

export async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

export async function pickCard(command: string, resumeId?: string): Promise<Card> {
	const before = new Set((await state()).cards.map(card => card.runId));
	const picker = vscode.commands.executeCommand(command);
	void picker.then(undefined, () => undefined);
	const card = await until(`a card from ${command}`, async () => {
		const added = (await state()).cards.find(card => card.orchestrator?.running &&
			(resumeId === undefined ? !before.has(card.runId) : card.alias === resumeId));
		if (added) { return added; }
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		return undefined;
	});
	await picker;
	return card;
}

export const newCard = () => pickCard('facade.newAgent');
export const resumeCard = (id?: string) => pickCard('facade.resumeAgent', id);

export function aliasOf(card: Card): string {
	assert.match(card.alias, /^a\d+$/u, 'the card shows its agent number');
	return `#${card.alias}`;
}

export function agentTab(card: Card): vscode.Tab | undefined {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => {
		const label = tab.label.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, '');
		return tab.input instanceof vscode.TabInputTerminal && (label === card.name || label.startsWith(`${card.name} `));
	});
}

export const hasAgentTab = (card: Card) => agentTab(card) !== undefined;

export function facade(...args: string[]): string {
	const program = path.join(vscode.extensions.getExtension('facade.facadecode')!.extensionPath, 'bin', process.platform === 'win32' ? 'facade.exe' : 'facade');
	const { FACADE_AGENT: _agent, ...env } = process.env;
	return execFileSync(program, args, { env, encoding: 'utf8', timeout: 20_000 });
}

export async function listed(): Promise<AgentListEntry[]> {
	return (await coreCall(HOME, 'agent.list', {})).agents;
}

export async function inspect(id: string): Promise<V3InspectResult> {
	return await coreCall(HOME, 'agent.inspect', { agent: id });
}

export async function recordOf(id: string): Promise<V3AgentInfo> {
	return (await inspect(id)).agent;
}

/** Daemon and keeper PIDs from a passive hello while the daemon is available. */
async function servicePids(): Promise<{ readonly daemon: number; readonly keeper: number } | undefined> {
	let hello;
	try {
		hello = await helloInCore(HOME, [3, 3]);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (error instanceof CoreConnectionClosed || code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
			return undefined;
		}
		throw error;
	}
	assert.ok(!hello.error, JSON.stringify(hello.error));
	const { pid, keeper } = hello.result as HelloResult;
	if (keeper === undefined) { return undefined; }
	assert.ok(Number.isSafeInteger(pid) && Number.isSafeInteger(keeper.pid), JSON.stringify(hello.result));
	return { daemon: pid, keeper: keeper.pid };
}

/** The fake CLI reports the session to core. Give its transcript a title and an activity time for the Resume picker. */
export function keepConversation(cwd: string, session: string, title: string): void {
	const store = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
	fs.mkdirSync(store, { recursive: true });
	fs.writeFileSync(path.join(store, `${session}.jsonl`), [
		{ type: 'user', sessionId: session, cwd, parentUuid: null, message: { role: 'user', content: title } },
		{ type: 'assistant', sessionId: session, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [] } },
		{ type: 'ai-title', sessionId: session, aiTitle: title }
	].map(value => JSON.stringify(value)).join('\n') + '\n');
}

function write(step: Step): void {
	fs.appendFileSync(OUT, `${JSON.stringify(step)}\n`);
}

function closeWindow(step: Closing): void {
	closing = step;
	void vscode.commands.executeCommand('workbench.action.closeWindow').then(undefined, () => undefined);
}

export async function running(id: string): Promise<RunningAgent> {
	return until(`${id} to run with its session`, async () => {
		const agent = await recordOf(id);
		if (!agent.pid || !agent.session || agent.process !== 'running') { return undefined; }
		process.kill(agent.pid, 0);
		return { id, pid: agent.pid, session: agent.session, cwd: agent.cwd };
	});
}

async function pinnedCard(id: string): Promise<Card> {
	return until(`#${id}'s card and pinned terminal tab`, async () => {
		const card = (await state()).cards.find(each => each.alias === id);
		return card?.pinned && agentTab(card) ? card : undefined;
	});
}

export async function pin(card: Card): Promise<void> {
	await until('Pin to be offered', async () => (await state()).cards.find(each => each.alias === card.alias)?.menu.pin || undefined);
	await vscode.commands.executeCommand('facade.pinAgent', { run_id: card.runId });
	await pinnedCard(card.alias);
}

function verifyScreen(id: string): void {
	assert.ok(facade('screen', id, '--lines', '120').includes(WINDOW_TEXT), `#${id}'s original screen text`);
}

async function checkLive(before: RunningAgent): Promise<void> {
	await pinnedCard(before.id);
	const restored = await running(before.id);
	assert.deepStrictEqual({ ...restored, cwd: normalizeDriveLetter(restored.cwd) },
		{ ...before, cwd: normalizeDriveLetter(before.cwd) }, 'the original number, PID, session and working folder');
	verifyScreen(before.id);
	assert.deepStrictEqual((await listed()).map(each => each.reference.agent_id), [before.id]);
}

export async function stop(card: Card): Promise<void> {
	await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
	await until(`${card.alias} to stop and retain its ended card`, async () => {
		const agent = await recordOf(card.alias);
		return agent.process === 'ended' && (await state()).cards.some(each => each.alias === card.alias && each.orchestrator?.running === false)
			&& !hasAgentTab(card) || undefined;
	});
}

function workspaceFile(): string {
	const dir = path.join(HOME, 'extension', 'workspaces');
	const stores = fs.readdirSync(dir).map(key => path.join(dir, key, 'orchestrator-workspace.json')).filter(file => fs.existsSync(file));
	assert.strictEqual(stores.length, 1, 'one isolated workspace state');
	return stores[0];
}

function pins(): readonly RustPin[] {
	return (JSON.parse(fs.readFileSync(workspaceFile(), 'utf8')) as { readonly pins: RustPin[] }).pins;
}

async function restored(before: RunningAgent): Promise<RunningAgent> {
	await pinnedCard(before.id);
	const after = await running(before.id);
	assert.strictEqual(after.session, before.session);
	assert.strictEqual(normalizeDriveLetter(after.cwd), normalizeDriveLetter(before.cwd));
	assert.notStrictEqual(after.pid, before.pid, 'the stopped agent resumes in a new process');
	return after;
}

export async function activate(): Promise<void> {
	try {
		assert.ok(HOME.startsWith(`${path.dirname(OUT)}${path.sep}`), 'this editor uses the journey’s own Facade home');
		const remote = vscode.env.remoteName;
		assert.strictEqual(remote, process.env.FACADE_IT_WINDOW_LIFETIME_SSH ? 'ssh-remote' : undefined);
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel snapshot', async () => (await state())?.loading === false || undefined, 90_000);
		const steps: Step[] = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Step) : [];
		const began = steps.find(step => step.phase === 'started');
		if (!began) {
			const card = await newCard();
			const agent = await running(aliasOf(card).slice(1));
			await pin(card);
			facade('type', agent.id, WINDOW_TEXT, '--enter');
			await until('the fake CLI to show the screen text', () => facade('screen', agent.id, '--lines', '120').includes(WINDOW_TEXT) || undefined);
			write({ phase: 'started', agent });
			void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		const previous = steps.findLast(step => step.phase === 'closed');
		if (!previous) {
			await checkLive(began.agent);
			write({ phase: 'reloaded', detail: began.agent });
			closeWindow({ after: 'reload', before: began.agent, screenText: WINDOW_TEXT });
			return;
		}
		if (previous.after === 'reload') {
			await checkLive(began.agent);
			write({ phase: 'reopened', detail: began.agent });
			const before = await servicePids();
			assert.ok(before && Number.isSafeInteger(before.daemon) && before.daemon > 1, 'Facade runs with this window');
			process.kill(before.daemon, 'SIGKILL');
			// Until the keeper starts the replacement, no Facade responds
			const replacement = await until('the replacement daemon', async () => {
				const next = await servicePids();
				return next && next.daemon !== before.daemon ? next : undefined;
			});
			assert.strictEqual(replacement.keeper, before.keeper, 'the same keeper starts the replacement daemon');
			await until('the editor terminal to reattach to the replacement daemon', async () =>
				(await inspect(began.agent.id)).viewers.length === 1 || undefined);
			await checkLive(began.agent);
			write({ phase: 'replaced', detail: { daemon: before.daemon, replacement: replacement.daemon, keeper: before.keeper, agent: began.agent } });
			if (remote) { write({ phase: 'done' }); return; }

			const unpinned = await newCard();
			const unpinnedAgent = await running(aliasOf(unpinned).slice(1));
			const removed = await newCard();
			const removedAgent = await running(aliasOf(removed).slice(1));
			await pin(removed);
			await stop(unpinned);
			await stop(await pinnedCard(began.agent.id));
			assert.deepStrictEqual(pins().map(pin => pin.agent).sort(), [began.agent.id, removedAgent.id].sort());
			closeWindow({ after: 'pins', before: began.agent, unpinned: unpinnedAgent, removed: removedAgent.id });
			return;
		}
		const again = await restored(previous.before);
		await until('the removed agent’s Pin to clear', () => pins().every(pin => pin.agent !== previous.removed) || undefined);
		const ended = await recordOf(previous.unpinned.id);
		assert.deepStrictEqual([ended.process, ended.session], ['ended', previous.unpinned.session]);
		assert.deepStrictEqual((await listed()).map(each => each.reference.agent_id), [again.id], 'only the pinned agent resumed');
		assert.deepStrictEqual((await state()).cards.map(each => each.alias).sort(), [again.id, previous.unpinned.id].sort());
		assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTerminal).length, 1);
		write({ phase: 'done', detail: { ...again, stopped: previous.unpinned.id, removed: previous.removed } });
	} catch (error) {
		write({ phase: 'error', detail: error instanceof Error ? error.stack : String(error) });
	}
}

export function deactivate(): void {
	if (closing) { write({ phase: 'closed', ...closing }); }
}
