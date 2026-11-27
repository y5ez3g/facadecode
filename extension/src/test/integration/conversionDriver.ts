/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The conversion journey's driver, an extension beside Facade Code Extension in an editor that runs no extension tests: the editor refuses
// to enter a workspace in a test run, which is the journey (ARCHITECTURE-2.2). In the folder window it checks Pin and Unpin
// across real reloads, then adds a folder. The editor restarts the extensions, this one with them, which then says what Facade Code Extension
// shows. Each step is a line of FACADE_IT_CONVERSION for the runner to judge; setup runs only on the first activation.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';
import { frameworkCall } from './editors';

/**
 * A tab title without the spinner's frame a busy agent's tab shows before its name (LIFECYCLE-2.2).
 */
const unspun = (title: string) => title.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, '');

const OUT = process.env.FACADE_IT_CONVERSION!;
const RECORD = process.env.FACADE_IT_RECORD!;
const REOPEN = process.env.FACADE_IT_REOPEN === '1';
const NATIVE = process.env.FACADE_IT_NATIVE;
const FRAMEWORK = process.env.FACADE_IT_IMPLEMENTATION === 'framework';
const HOME = process.env.FACADE_HOME!;

/** The active agents in Facade Code Framework's roster, by address. */
async function frameworkAgents(): Promise<string[]> {
	return (await frameworkCall(HOME, 'agent.list', {})).agents.map(agent => agent.address);
}

/** Read the native session from the legacy run file or Facade Code Framework's Inspect response. */
async function sessionOf(runId: string, alias: string): Promise<string | undefined> {
	if (!FRAMEWORK) {
		try {
			const id: unknown = JSON.parse(fs.readFileSync(path.join(process.env.FACADE_HOME!, 'extension', 'runs', `${runId}.session.json`), 'utf8')).session_id;
			return typeof id === 'string' && id ? id : undefined;
		} catch { return undefined; }
	}
	return (await frameworkCall(HOME, 'agent.inspect', { target: alias })).agent.session || undefined;
}
/** Agents started beside the journey's own before it reloads, so that each reload's claim is timed in a busy window (VERIFICATION G2). */
const LOAD = Number(process.env.FACADE_IT_LOAD ?? 0);

/** A native process is observed from this isolated window's launch log, never from the owner's process list. */
function pidOf(alias: string): number | undefined {
	if (!NATIVE) {
		const file = `${RECORD}.${FRAMEWORK ? '#' : ''}${alias}`;
		return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) : undefined;
	}
	const dir = path.join(process.env.FACADE_HOME!, 'extension', 'workspaces');
	const logs = fs.existsSync(dir) ? fs.readdirSync(dir).map(key => path.join(dir, key, 'agents.log')).filter(file => fs.existsSync(file)) : [];
	for (const file of logs) {
		for (const line of fs.readFileSync(file, 'utf8').split('\n').reverse()) {
			const match = / Started (#a\d+) \([^)]*\) pid (\d+):/.exec(line);
			if (match?.[1] === alias) { return Number(match[2]); }
		}
	}
	return undefined;
}

function write(line: object): void {
	fs.appendFileSync(OUT, `${JSON.stringify(line)}\n`);
}

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

/**
 * Whether a saved Pin of this window's workspaces restores `session`: a Pin made before its CLI named its conversation takes it once
 * the window hears it (LIFECYCLE-3.4), and a window closed before that restores a new conversation instead.
 */
function pinHolds(session: string): boolean {
	const root = path.join(process.env.FACADE_HOME!, 'extension', 'workspaces');
	const file = FRAMEWORK ? 'orchestrator-workspace.json' : 'workspace-state.json';
	const entry = FRAMEWORK ? 'pins' : 'facade.pins';
	const saved = (dir: string): unknown => {
		try { return (JSON.parse(fs.readFileSync(path.join(root, dir, file), 'utf8')) as Record<string, unknown>)[entry]; } catch { return undefined; }
	};
	try {
		return fs.readdirSync(root).some(dir => {
			const pins = saved(dir);
			return Array.isArray(pins) && pins.some(pin => (pin as { conversation?: { sessionId?: unknown } } | null)?.conversation?.sessionId === session);
		});
	} catch {
		return false;
	}
}

/** Finish a native turn before closing: a preallocated ID alone is not a persisted conversation. */
async function nativeTurn(runId: string, name: string): Promise<void> {
	await until('native CLI input', async () => await vscode.commands.executeCommand('facade.messageInput', runId) === 'usable' ? true : undefined, 60_000);
	const terminal = await until('its native terminal', async () => vscode.window.terminals.find(each => unspun(each.name).startsWith(name)));
	const answer = `READY_${Date.now().toString(36).toUpperCase()}`;
	const prompt = `Reply with exactly ${answer}. Do not use tools.`;
	terminal.sendText(prompt, false);
	await until('the native probe draft', async () => await vscode.commands.executeCommand('facade.messageInput', runId, prompt) === 'own' ? true : undefined);
	terminal.sendText('\r', false);
	await until('the native answer and empty input', async () => {
		const screen = await vscode.commands.executeCommand<{ text: string[] }>('facade.screen', runId, 500);
		return screen?.text.some(line => new RegExp(`^\\s*[^\\p{L}\\p{N}]*${answer}\\s*$`, 'u').test(line))
			&& await vscode.commands.executeCommand('facade.messageInput', runId) === 'usable' ? true : undefined;
	}, 60_000);
}

/** Observe the saved card before revealing its terminal, then let the deferred native Pin follow that activation. */
async function pinState(runId: string, pinned: boolean): Promise<void> {
	const card = await until(`the card ${pinned ? 'pinned' : 'unpinned'}`, async () => {
		const card = (await state()).cards.find(each => each.runId === runId);
		return card && !!card.pinned === pinned ? card : undefined;
	});
	await vscode.commands.executeCommand('facade.revealAgent', { run_id: runId });
	await until('its native tab to agree', async () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
		.some(tab => tab.input instanceof vscode.TabInputTerminal && unspun(tab.label).startsWith(card.name) && (FRAMEWORK || tab.isPinned === pinned)) || undefined);
}

export async function activate(): Promise<void> {
	try {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		// The window's runs are claimed and shown once its state stops loading: how long after the reload was asked for (RULES-4.1)
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined, 90_000);
		const claimedAt = Date.now();
		const steps = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)
			.map(line => JSON.parse(line) as { phase: string; runId?: string; at?: number }) : [];
		const reloadedAt = steps[steps.length - 1]?.at;
		const claim = reloadedAt !== undefined ? { claimMs: claimedAt - reloadedAt, agents: (await state()).cardCount } : {};
		if (!steps.length) {
			void vscode.commands.executeCommand('facade.newAgent');
			const card = await until('the new card with its agent ID', async () => {
				const now = await state();
				if (!now.cardCount) {
					await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
				}
				// The Facade Code Framework shows a pending card before framework assigns its agent ID.
				return now.cards.find(each => each.alias);
			});
			const alias = card.alias;
			const pid = await until(`the CLI to start for ${alias}`, async () => pidOf(alias));
			// Its terminal open, as a person sees it before adding a folder: one the restart beat to opening tells the editor no
			// process, which leaves its tab beside the new one, as Facade Code Extension retires no tab it cannot tell from another's (ARCHITECTURE-2.2)
			const terminal = await until('its terminal', async () => vscode.window.terminals.find(each => unspun(each.name).startsWith(card.name)));
			let opened = false;
			void Promise.resolve(terminal.processId).then(() => { opened = true; }, () => { opened = true; });
			await until('its terminal to open', async () => opened || undefined);
			if (NATIVE) {
				await nativeTurn(card.runId, card.name);
			}
			await until('Pin offered', async () => (await state()).cards.find(each => each.runId === card.runId)?.menu.pin || undefined, NATIVE ? 60_000 : 20_000);
			await vscode.commands.executeCommand('facade.pinAgent', { run_id: card.runId });
			await pinState(card.runId, true);
			const session = await until('the persisted native session ID', async () => sessionOf(card.runId, alias), NATIVE ? 60_000 : 20_000);
			// Pin is offered before the CLI names its conversation (LIFECYCLE-3.4): its record takes the session once the window hears it
			await until('the Pin to take the session', async () => pinHolds(session) || undefined, NATIVE ? 60_000 : 20_000);
			// A busy window: more agents beside it, each running, for the reload to claim (VERIFICATION G2, J14)
			for (let started = 1; started <= LOAD; started++) {
				void vscode.commands.executeCommand('facade.newAgent');
				await until(`agent ${started} of the load`, async () => {
					if ((await state()).cardCount > started) {
						return true;
					}
					await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
					return undefined;
				});
			}
			write({ phase: 'folder', runId: card.runId, name: card.name, pid, session, others: (await state()).cards.filter(each => each.runId !== card.runId).map(each => each.alias), at: Date.now() });
			// Reload tears down this host, which may cancel its command promise after the window accepted the request.
			void vscode.commands.executeCommand(REOPEN ? 'workbench.action.closeWindow' : 'workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		if (REOPEN) {
			const card = await until('the reopened pinned agent', async () => (await state()).cards.find(each => each.pinned));
			await pinState(card.runId, true);
			if (NATIVE) { await nativeTurn(card.runId, card.name); }
			const alias = card.alias;
			const pid = await until('the restored CLI process', async () => pidOf(alias));
			const session = await until('the restored native session identity', async () => sessionOf(card.runId, alias));
			// The reopened window's cards and terminals, and the Facade Code Framework records in this Facade home (RULES-4.1).
			const { cards } = await state();
			write({ phase: 'reopened', runId: card.runId, pid, session, terminals: vscode.window.terminals.length, cards: cards.map(each => ({ alias: each.alias, dot: each.dot })), ...FRAMEWORK ? { framework: await frameworkAgents() } : {} });
			return;
		}
		const first = steps[0] as unknown as { runId: string; name: string };
		const runId = first.runId;
		if (!vscode.workspace.workspaceFile) {
			if (!steps.some(step => step.phase === 'unpin')) {
				await pinState(runId, true);
				write({ phase: 'reload-pinned', runId, ...claim });
				await vscode.commands.executeCommand('facade.unpinAgent', { run_id: runId });
				await pinState(runId, false);
				write({ phase: 'unpin', runId, at: Date.now() });
				void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
				return;
			}
			await pinState(runId, false);
			write({ phase: 'reload-unpinned', runId, ...claim });
			if (FRAMEWORK) {
				await vscode.commands.executeCommand('facade.pinAgent', { run_id: runId });
			} else {
				await vscode.commands.executeCommand('workbench.action.pinEditor');
			}
			await pinState(runId, true);
			// As a folder dropped on the window adds it
			vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(process.env.FACADE_IT_SECOND!) });
			return;
		}
		if (FRAMEWORK) {
			// The new workspace already shows the original Managed Agent. Open its exact card to restore the terminal.
			await until('the original running agent in the new workspace', async () =>
				(await state()).cards.find(each => each.runId === runId && each.orchestrator?.running));
			const opened = await vscode.commands.executeCommand('facade.openTerminal', { run_id: runId });
			if (opened !== true) { throw new Error('Could not open the original agent in the new workspace.'); }
			await vscode.commands.executeCommand('facade.pinAgent', { run_id: runId });
		}
		await pinState(runId, true);
		const card = await until('the same card in the workspace', async () => (await state()).cards.find(each => each.runId === runId)).catch(() => undefined);
		// A predecessor tab without a current pseudoterminal can remain after a workspace URI changes.
		const terminals = () => vscode.window.terminals.filter(each => !FRAMEWORK || 'pty' in each.creationOptions)
			.map(each => unspun(each.name));
		await until('one live terminal of the agent', async () => terminals().filter(name => name === card?.name).length === 1 || undefined);
		if (FRAMEWORK && card) {
			await until('one Facade Code Framework view of the original agent', async () =>
				(await frameworkCall(HOME, 'agent.inspect', { target: card.alias })).viewers.length === 1 || undefined);
		}
		write({ phase: 'workspace', folders: vscode.workspace.workspaceFolders?.length,
			card: card ? { runId: card.runId, name: card.name, pinned: card.pinned } : null, terminals: terminals() });
	} catch (err) {
		const screens = await Promise.race([state().then(current => Promise.all(current.cards.map(async card => ({ name: card.name, alias: card.alias,
			text: await Promise.resolve(vscode.commands.executeCommand('facade.screen', card.runId, 500)).catch(() => undefined) }))), () => []), new Promise<never[]>(resolve => setTimeout(() => resolve([]), 5_000))]);
		write({ phase: 'error', error: String(err), screens });
	}
}

export function deactivate(): void {
	// The extension host's process: the window has closed once it ends
	if (REOPEN) { write({ phase: 'closed', host: process.pid }); }
}
