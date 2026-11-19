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
import type { Said, V2AgentInfo, V2AgentListResult } from '../../base/coreProtocol';
import type { Pin } from '../../core/ports';
import type { PanelState } from '../../webview/protocol';
import { normalizeDriveLetter, until, windowsInCore } from './editors';

type Card = PanelState['cards'][number];
type SavedPin = Pin & { readonly agent?: string; readonly home?: string; readonly machine_id?: string };

export type ListedAgent = Omit<V2AgentInfo, 'cwd' | 'said'> & {
	readonly folder: string;
	readonly last_input?: Said;
};

export interface RunningAgent {
	readonly id: string;
	readonly pid: number;
	readonly session: string;
	readonly cwd: string;
}

export interface LegacyPinFixture {
	readonly agent: RunningAgent;
	readonly pin: Pin;
	readonly mirror: string;
}

type Closing =
	| { readonly after: 'reload'; readonly before: RunningAgent; readonly windowId: string; readonly screenText: string }
	| { readonly after: 'pins'; readonly before: RunningAgent; readonly unpinned: RunningAgent; readonly removed: string; readonly legacy: LegacyPinFixture }
	| { readonly after: 'repinned'; readonly before: RunningAgent };

export type Step = { readonly phase: 'started'; readonly agent: RunningAgent }
	| ({ readonly phase: 'closed' } & Closing)
	| { readonly phase: 'reloaded' | 'reopened' | 'replaced' | 'pins' | 'legacy' | 'done' | 'error'; readonly detail?: unknown };

// Kept on the screen by the fake CLI after Enter, even if the terminal is resized on reopening.
const WINDOW_TEXT = 'Window lifetime screen';

const HOME = process.env.FACADE_HOME!;
const OUT = process.env.FACADE_IT_WINDOW_LIFETIME!;
let closing: Closing | undefined;

export async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

export async function pickCard(command: string): Promise<Card> {
	const before = new Set((await state()).cards.map(card => card.runId));
	void vscode.commands.executeCommand(command);
	return until(`a card from ${command}`, async () => {
		const added = (await state()).cards.find(card => !before.has(card.runId));
		if (added?.alias) { return added; }
		if (!added) { await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); }
		return undefined;
	});
}

export const newCard = () => pickCard('facade.newAgent');
export const resumeCard = () => pickCard('facade.resumeAgent');

export function aliasOf(card: Card): string {
	assert.match(card.alias, /^#a\d+$/u, 'the card shows its agent number');
	return card.alias;
}

export function agentTab(card: Card): vscode.Tab | undefined {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => {
		const label = tab.label.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, '');
		return tab.input instanceof vscode.TabInputTerminal && (label === card.name || label.startsWith(`${card.name} `));
	});
}

export const hasAgentTab = (card: Card) => agentTab(card) !== undefined;

export function facade(...args: string[]): string {
	return facadeAs(undefined, ...args);
}

export function facadeAs(agent: string | undefined, ...args: string[]): string {
	const program = path.join(vscode.extensions.getExtension('facade.facadecode')!.extensionPath, 'bin', process.platform === 'win32' ? 'facade.exe' : 'facade');
	const { FACADE_AGENT: _agent, ...env } = process.env;
	if (agent !== undefined) { env.FACADE_AGENT = agent; }
	return execFileSync(program, args, { env, encoding: 'utf8', timeout: 20_000 });
}

export function listed(): ListedAgent[] {
	return (JSON.parse(facade('list', '--json')) as Omit<V2AgentListResult, 'agents'> & { readonly agents: ListedAgent[] }).agents;
}

function windowOf(id: string): string {
	const record = listed().find(each => each.agent_id === id);
	assert.ok(record?.windows?.length === 1 && record.windows[0].window_id !== 'terminal', `#${id} belongs to one editor window`);
	return record.windows[0].window_id;
}

/** The services of the Facade that responds, or undefined while none does: `facade status` never starts Facade. */
function servicePids(): { readonly daemon: number; readonly keeper: number } | undefined {
	const text = facade('status', '--json');
	const status = JSON.parse(text) as { running?: boolean; daemon?: { pid?: number }; keeper?: { pid?: number } | null };
	if (status.running !== true) { return undefined; }
	assert.ok(typeof status.daemon?.pid === 'number' && typeof status.keeper?.pid === 'number', text);
	return { daemon: status.daemon.pid, keeper: status.keeper.pid };
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
	return until(`#${id} to run with its session`, () => {
		const agent = listed().find(each => each.agent_id === id);
		if (!agent?.pid || !agent.session || agent.process !== 'running') { return undefined; }
		process.kill(agent.pid, 0);
		return { id, pid: agent.pid, session: agent.session, cwd: agent.folder };
	});
}

async function pinnedCard(id: string): Promise<Card> {
	return until(`#${id}'s card and pinned terminal tab`, async () => {
		const card = (await state()).cards.find(each => each.alias === `#${id}`);
		return card?.pinned && agentTab(card)?.isPinned ? card : undefined;
	});
}

export async function pin(card: Card): Promise<void> {
	await until('Pin to be offered', async () => (await state()).cards.find(each => each.alias === card.alias)?.menu.pin || undefined);
	await vscode.commands.executeCommand('facade.pinAgent', { run_id: card.runId });
	await pinnedCard(card.alias.slice(1));
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
	assert.deepStrictEqual(listed().map(each => each.agent_id), [before.id]);
}

export async function stop(card: Card): Promise<void> {
	await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
	await until(`#${card.alias.slice(1)} to stop and its card to close`, async () => {
		const agent = listed().find(each => `#${each.agent_id}` === card.alias);
		assert.ok(agent, `Stop Agent keeps ${card.alias}'s record`);
		return agent.process === 'ended' && !(await state()).cards.some(each => each.alias === card.alias) && !hasAgentTab(card) || undefined;
	});
}

function workspaceFile(): string {
	const dir = path.join(HOME, 'extension', 'workspaces');
	const stores = fs.readdirSync(dir).map(key => path.join(dir, key, 'workspace-state.json')).filter(file => fs.existsSync(file));
	assert.strictEqual(stores.length, 1, 'one isolated workspace state');
	return stores[0];
}

function pins(file = workspaceFile()): readonly SavedPin[] {
	return (JSON.parse(fs.readFileSync(file, 'utf8'))['facade.pins'] ?? []) as SavedPin[];
}

function savedPin(agent: RunningAgent): SavedPin {
	const machine = listed().find(record => record.agent_id === agent.id)?.machine_id;
	const saved = pins().find(pin => pin.agent === agent.id && !!machine && pin.machine_id === machine);
	assert.ok(saved, `#${agent.id} has a saved Pin for this Facade machine`);
	return saved;
}

async function restored(before: RunningAgent): Promise<RunningAgent> {
	await pinnedCard(before.id);
	const after = await running(before.id);
	assert.strictEqual(after.session, before.session);
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
			closeWindow({ after: 'reload', before: began.agent, windowId: windowOf(began.agent.id), screenText: WINDOW_TEXT });
			return;
		}
		if (previous.after === 'reload') {
			await checkLive(began.agent);
			write({ phase: 'reopened', detail: began.agent });
			const windowId = windowOf(began.agent.id);
			const before = servicePids();
			assert.ok(before && Number.isSafeInteger(before.daemon) && before.daemon > 1, 'Facade runs with this window');
			process.kill(before.daemon, 'SIGKILL');
			// Until the keeper starts the replacement, no Facade responds
			const replacement = await until('the replacement daemon', () => {
				const next = servicePids();
				return next && next.daemon !== before.daemon ? next : undefined;
			});
			assert.strictEqual(replacement.keeper, before.keeper, 'the same keeper starts the replacement daemon');
			await until(`window ${windowId} to reconnect to the new daemon`, async () =>
				(await windowsInCore(HOME)).some(window => window.window_id === windowId && window.connected) || undefined);
			await checkLive(began.agent);
			write({ phase: 'replaced', detail: { daemon: before.daemon, replacement: replacement.daemon, keeper: before.keeper, windowId, connected: true, agent: began.agent } });
			if (remote) { write({ phase: 'done' }); return; }

			const unpinned = await newCard();
			const unpinnedAgent = await running(aliasOf(unpinned).slice(1));
			const removed = await newCard();
			const removedAgent = await running(aliasOf(removed).slice(1));
			await pin(removed);
			const legacyCard = await newCard();
			const legacyAgent = await running(aliasOf(legacyCard).slice(1));
			await pin(legacyCard);
			await stop(unpinned);
			await stop(await pinnedCard(began.agent.id));
			await stop(legacyCard);
			const { home: _home, agent: _agent, machine_id: _machine, ...pinWithoutIdentity } = savedPin(legacyAgent);
			savedPin(began.agent);
			savedPin(removedAgent);
			keepConversation(legacyAgent.cwd, legacyAgent.session, 'Legacy Pin conversation');
			const legacy = { agent: legacyAgent, pin: pinWithoutIdentity, mirror: workspaceFile() };
			closeWindow({ after: 'pins', before: began.agent, unpinned: unpinnedAgent, removed: removedAgent.id, legacy });
			return;
		}
		if (previous.after === 'pins') {
			// Waiting for the restored Pin's marked tab lets the automatic restoration finish before we use Resume Agent.
			const again = await restored(previous.before);
			await until('the removed agent’s Pin to clear', () => pins().every(pin => pin.agent !== previous.removed) || undefined);
			const others = listed().filter(each => each.agent_id !== again.id);
			const { agent, pin: oldPin } = previous.legacy;
			assert.deepStrictEqual(others.map(each => [each.agent_id, each.pid, each.process]).sort(),
				[previous.unpinned, agent].map(each => [each.id, each.pid, 'ended']).sort(), 'the unpinned and legacy agents remain ended, and the removed agent is gone');
			assert.deepStrictEqual((await state()).cards.map(each => each.alias), [`#${again.id}`]);
			assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTerminal).length, 1);
			write({ phase: 'pins', detail: { ...again, stopped: previous.unpinned.id, removed: previous.removed } });
			assert.deepStrictEqual(pins().find(pin => pin.id === oldPin.id), oldPin, 'the legacy Pin stays in workspace storage');
			const card = await resumeCard();
			assert.strictEqual(aliasOf(card), `#${agent.id}`);
			const resumed = await running(agent.id);
			await pin(card);
			assert.strictEqual(savedPin(resumed).id, oldPin.id, 'pinning the card updates the original Pin with its home and number');
			await stop(card);
			write({ phase: 'legacy', detail: resumed });
			closeWindow({ after: 'repinned', before: resumed });
			return;
		}
		write({ phase: 'done', detail: await restored(previous.before) });
	} catch (error) {
		write({ phase: 'error', detail: error instanceof Error ? error.stack : String(error) });
	}
}

export function deactivate(): void {
	if (closing) { write({ phase: 'closed', ...closing }); }
}
