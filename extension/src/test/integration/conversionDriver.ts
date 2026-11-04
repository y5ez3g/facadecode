/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The conversion journey's driver, an extension beside Facade Code in an editor that runs no extension tests: the editor refuses
// to enter a workspace in a test run, which is the journey (ARCHITECTURE-2.2). In the folder window it checks Pin and Unpin
// across real reloads, then adds a folder. The editor restarts the extensions, this one with them, which then says what Facade
// shows. Each step is a line of FACADE_IT_CONVERSION for the runner to judge; setup runs only on the first activation.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';

/**
 * A tab title without the spinner's frame a busy agent's tab shows before its name (LIFECYCLE-2.2). This driver is copied alone into the
 * test window's extensions, so it imports nothing of the extension's at run time.
 */
const unspun = (title: string) => title.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, '');

const OUT = process.env.FACADE_IT_CONVERSION!;
const RECORD = process.env.FACADE_IT_RECORD!;
const REOPEN = process.env.FACADE_IT_REOPEN === '1';
const NATIVE = process.env.FACADE_IT_NATIVE;
/** Agents started beside the journey's own before it reloads, so that each reload's claim is timed in a busy window (VERIFICATION G2). */
const LOAD = Number(process.env.FACADE_IT_LOAD ?? 0);

/** A native process is observed from this isolated window's launch log, never from the owner's process list. */
function pidOf(alias: string): number | undefined {
	if (!NATIVE) { return fs.existsSync(`${RECORD}.${alias}`) ? Number(fs.readFileSync(`${RECORD}.${alias}`, 'utf8').trim()) : undefined; }
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
	const saved = (dir: string): unknown => {
		try { return (JSON.parse(fs.readFileSync(path.join(root, dir, 'workspace-state.json'), 'utf8')) as Record<string, unknown>)['facade.pins']; } catch { return undefined; }
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
		.some(tab => tab.input instanceof vscode.TabInputTerminal && unspun(tab.label).startsWith(card.name) && tab.isPinned === pinned) || undefined);
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
			const card = await until('a new card', async () => {
				const now = await state();
				if (now.cardCount) {
					return now.cards[0];
				}
				await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
				return undefined;
			});
			const alias = card.tooltip.join(' ').match(/#a\d+/)![0];
			const pid = await until('the CLI to start', async () => pidOf(alias));
			// Its terminal open, as a person sees it before adding a folder: one the restart beat to opening tells the editor no
			// process, which leaves its tab beside the new one, as Facade retires no tab it cannot tell from another's (ARCHITECTURE-2.2)
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
			const session = await until('the persisted native session ID', async () => {
				try {
					const id: unknown = JSON.parse(fs.readFileSync(path.join(process.env.FACADE_HOME!, 'extension', 'runs', `${card.runId}.session.json`), 'utf8')).session_id;
					return typeof id === 'string' && id ? id : undefined;
				} catch { return undefined; }
			}, NATIVE ? 60_000 : 20_000);
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
			write({ phase: 'folder', runId: card.runId, name: card.name, pid, session, at: Date.now() });
			// Reload tears down this host, which may cancel its command promise after the window accepted the request.
			void vscode.commands.executeCommand(REOPEN ? 'workbench.action.closeWindow' : 'workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		if (REOPEN) {
			const card = await until('the reopened pinned agent', async () => (await state()).cards.find(each => each.pinned));
			await pinState(card.runId, true);
			if (NATIVE) { await nativeTurn(card.runId, card.name); }
			const alias = card.tooltip.join(' ').match(/#a\d+/)![0];
			const pid = await until('the restored CLI process', async () => pidOf(alias));
			const sessionFile = path.join(process.env.FACADE_HOME!, 'extension', 'runs', `${card.runId}.session.json`);
			const session = await until('the restored native session identity', async () => {
				try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')).session_id as string | undefined; } catch { return undefined; }
			});
			write({ phase: 'reopened', runId: card.runId, pid, session, terminals: vscode.window.terminals.length });
			return;
		}
		const runId = steps[0].runId!;
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
			await vscode.commands.executeCommand('workbench.action.pinEditor');
			await pinState(runId, true);
			// As a folder dropped on the window adds it
			vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(process.env.FACADE_IT_SECOND!) });
			return;
		}
		await pinState(runId, true);
		const card = await until('the same card in the workspace', async () => (await state()).cards.find(each => each.runId === runId)).catch(() => undefined);
		// The editor closes the terminals of the extension host it restarted in its own time: what the window settles to is judged
		await until('one terminal of the agent', async () => vscode.window.terminals.filter(each => unspun(each.name) === card?.name).length === 1 ? true : undefined, 15_000).catch(() => undefined);
		write({ phase: 'workspace', folders: vscode.workspace.workspaceFolders?.length, card: card ? { runId: card.runId, name: card.name, pinned: card.pinned } : null, terminals: vscode.window.terminals.map(each => unspun(each.name)) });
	} catch (err) {
		const screens = await state().then(current => Promise.all(current.cards.map(async card => ({ name: card.name,
			text: await vscode.commands.executeCommand('facade.screen', card.runId, 500) }))), () => []);
		write({ phase: 'error', error: String(err), screens });
	}
}

export function deactivate(): void {
	// The extension host's process: the window has closed once it ends
	if (REOPEN) { write({ phase: 'closed', host: process.pid }); }
}
