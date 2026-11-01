/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The conversion journey's driver, an extension beside Facade Code in an editor that runs no extension tests: the editor refuses
// to enter a workspace in a test run, which is the journey (ARCHITECTURE-2.2, D70). In the folder window it checks Pin and Unpin
// across real reloads, then adds a folder. The editor restarts the extensions, this one with them, which then says what Facade
// shows. Each step is a line of FACADE_IT_CONVERSION for the runner to judge; setup runs only on the first activation.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';

const OUT = process.env.FACADE_IT_CONVERSION!;
const RECORD = process.env.FACADE_IT_RECORD!;
const REOPEN = process.env.FACADE_IT_REOPEN === '1';

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

/** Observe the saved card before revealing its terminal, then let the deferred native Pin follow that activation. */
async function pinState(runId: string, pinned: boolean): Promise<void> {
	const card = await until(`the card ${pinned ? 'pinned' : 'unpinned'}`, async () => {
		const card = (await state()).cards.find(each => each.runId === runId);
		return card && !!card.pinned === pinned ? card : undefined;
	});
	await vscode.commands.executeCommand('facade.revealAgent', { run_id: runId });
	await until('its native tab to agree', async () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
		.some(tab => tab.input instanceof vscode.TabInputTerminal && tab.label.startsWith(card.name) && tab.isPinned === pinned) || undefined);
}

export async function activate(): Promise<void> {
	try {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
		const steps = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)
			.map(line => JSON.parse(line) as { phase: string; runId?: string }) : [];
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
			const pid = await until('the fake CLI to start', async () => fs.existsSync(`${RECORD}.${alias}`) ? Number(fs.readFileSync(`${RECORD}.${alias}`, 'utf8').trim()) : undefined);
			// Its terminal open, as a person sees it before adding a folder: one the restart beat to opening tells the editor no
			// process, which leaves its tab beside the new one, as Facade retires no tab it cannot tell from another's (ARCHITECTURE-2.2)
			const terminal = await until('its terminal', async () => vscode.window.terminals.find(each => each.name === card.name));
			let opened = false;
			void Promise.resolve(terminal.processId).then(() => { opened = true; }, () => { opened = true; });
			await until('its terminal to open', async () => opened || undefined);
			await until('its native session identity', async () => (await state()).cards.find(each => each.runId === card.runId)?.menu.pin || undefined);
			await vscode.commands.executeCommand('facade.pinAgent', { run_id: card.runId });
			await pinState(card.runId, true);
			const session = JSON.parse(fs.readFileSync(path.join(process.env.FACADE_HOME!, 'extension', 'runs', `${card.runId}.session.json`), 'utf8')).session_id;
			write({ phase: 'folder', runId: card.runId, name: card.name, pid, session });
			// Reload tears down this host, which may cancel its command promise after the window accepted the request.
			void vscode.commands.executeCommand(REOPEN ? 'workbench.action.closeWindow' : 'workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		if (REOPEN) {
			const card = await until('the reopened pinned agent', async () => (await state()).cards.find(each => each.pinned));
			await pinState(card.runId, true);
			const alias = card.tooltip.join(' ').match(/#a\d+/)![0];
			const pid = await until('the restored CLI process', async () => fs.existsSync(`${RECORD}.${alias}`) ? Number(fs.readFileSync(`${RECORD}.${alias}`, 'utf8').trim()) : undefined);
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
				write({ phase: 'reload-pinned', runId });
				await vscode.commands.executeCommand('facade.unpinAgent', { run_id: runId });
				await pinState(runId, false);
				write({ phase: 'unpin', runId });
				void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
				return;
			}
			await pinState(runId, false);
			write({ phase: 'reload-unpinned', runId });
			await vscode.commands.executeCommand('workbench.action.pinEditor');
			await pinState(runId, true);
			// As a folder dropped on the window adds it
			vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(process.env.FACADE_IT_SECOND!) });
			return;
		}
		await pinState(runId, true);
		const card = await until('the same card in the workspace', async () => (await state()).cards.find(each => each.runId === runId)).catch(() => undefined);
		// The editor closes the terminals of the extension host it restarted in its own time: what the window settles to is judged
		await until('one terminal of the agent', async () => vscode.window.terminals.filter(each => each.name === card?.name).length === 1 ? true : undefined, 15_000).catch(() => undefined);
		write({ phase: 'workspace', folders: vscode.workspace.workspaceFolders?.length, card: card ? { runId: card.runId, name: card.name, pinned: card.pinned } : null, terminals: vscode.window.terminals.map(each => each.name) });
	} catch (err) {
		write({ phase: 'error', error: String(err) });
	}
}

export function deactivate(): void {
	if (REOPEN) { write({ phase: 'closed' }); }
}
