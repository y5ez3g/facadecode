/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The conversion journey's driver, an extension beside Facade Code in an editor that runs no extension tests: the editor refuses
// to enter a workspace in a test run, which is the journey (ARCHITECTURE-2.2, D70). In the folder window it starts an agent and
// adds a folder; the editor makes the window an untitled workspace and restarts the extensions, this one with them, which then
// says what Facade shows. Each step is a line of FACADE_IT_CONVERSION for the runner to judge.

import * as fs from 'fs';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';

const OUT = process.env.FACADE_IT_CONVERSION!;
const RECORD = process.env.FACADE_IT_RECORD!;

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

export async function activate(): Promise<void> {
	try {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
		if (!vscode.workspace.workspaceFile) {
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
			write({ phase: 'folder', runId: card.runId, name: card.name, pid });
			// As a folder dropped on the window adds it
			vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(process.env.FACADE_IT_SECOND!) });
			return;
		}
		const runId = (JSON.parse(fs.readFileSync(OUT, 'utf8').split('\n')[0]) as { runId: string }).runId;
		const card = await until('the same card in the workspace', async () => (await state()).cards.find(each => each.runId === runId)).catch(() => undefined);
		write({ phase: 'workspace', folders: vscode.workspace.workspaceFolders?.length, card: card ? { runId: card.runId, name: card.name } : null, terminals: vscode.window.terminals.map(each => each.name) });
	} catch (err) {
		write({ phase: 'error', error: String(err) });
	}
}
