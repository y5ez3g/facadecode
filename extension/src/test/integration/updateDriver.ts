/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The update journey's driver (VERIFICATION E05, J17): an extension beside an installed released build of Facade Code, in an
// editor that runs no extension tests, as a released build has none of the suite's commands. It starts an agent in the released
// build as a person does, reloads the window into the update the runner installed, and opens the agent's tab when asked. Each
// step is a line of FACADE_IT_UPDATE for the runner to judge, and the runner asks for the next by a file `<FACADE_IT_UPDATE>.<step>`.
// This driver is copied alone into the test window's extensions, so it imports nothing of the extension's at run time.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const OUT = process.env.FACADE_IT_UPDATE!;
const RECORD = process.env.FACADE_IT_RECORD!;

function write(line: object): void {
	fs.appendFileSync(OUT, `${JSON.stringify(line)}\n`);
}

function said(): { readonly phase: string }[] {
	return fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string }) : [];
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

/** The installed Facade Code's version. */
function version(): string | undefined {
	return (vscode.extensions.getExtension('facade.facadecode')?.packageJSON as { version?: string } | undefined)?.version;
}

/** The terminal tabs of each group, by label. */
function tabs(): string[][] {
	return vscode.window.tabGroups.all.map(group => group.tabs.filter(tab => tab.input instanceof vscode.TabInputTerminal).map(tab => tab.label));
}

/** The agents the fake CLI says started, by the files `<record>.#aN` holding their process IDs. */
function started(): string[] {
	const dir = path.dirname(RECORD), prefix = `${path.basename(RECORD)}.`;
	return fs.readdirSync(dir).filter(name => name.startsWith(prefix) && /^#a\d+$/.test(name.slice(prefix.length))).map(name => name.slice(prefix.length));
}

/** Runs `command`, then accepts its picker's selected item until `done` says it went. */
async function pick<T>(what: string, command: string, done: () => T | undefined): Promise<T> {
	void vscode.commands.executeCommand(command);
	return until(what, async () => {
		const value = done();
		if (value === undefined) {
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		}
		return value;
	}, 60_000);
}

export async function activate(): Promise<void> {
	try {
		if (!said().some(line => line.phase === 'reloading')) {
			// The released build: one agent, started as a person starts one, its tab open
			await until('the released build', async () => version() && (await vscode.commands.getCommands(true)).includes('facade.newAgent') ? true : undefined, 90_000);
			const alias = await pick('its agent', 'facade.newAgent', () => started()[0]);
			await until('its tab', async () => tabs().flat().length ? true : undefined);
			write({ phase: 'started', version: version(), alias, tabs: tabs() });
			await until('the update', async () => fs.existsSync(`${OUT}.reload`) ? true : undefined, 300_000);
			write({ phase: 'reloading' });
			// Its own extension host goes with the reload, which cancels the command's answer
			void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		// The update, the window reloaded into it: the agent comes back as the update shows it
		await until('the updated build', async () => (await vscode.commands.getCommands(true)).includes('facade.newAgent') ? true : undefined, 90_000);
		await new Promise(resolve => setTimeout(resolve, 8_000));
		write({ phase: 'updated', version: version(), tabs: tabs(), terminals: vscode.window.terminals.map(terminal => terminal.name) });
		await until('the opening', async () => fs.existsSync(`${OUT}.open`) ? true : undefined, 300_000);
		// Go to Agent's only agent
		await pick('its tab opened', 'facade.showActiveAgents', () => tabs().flat().length ? true : undefined);
		write({ phase: 'opened', tabs: tabs() });
	} catch (err) {
		write({ phase: 'error', message: err instanceof Error ? err.stack ?? err.message : String(err) });
	}
}

export function deactivate(): void {
	// Nothing to let go
}
