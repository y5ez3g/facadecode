/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Native driver for a clean install of the workspace and Window Component packages.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WindowIdentity } from '../../base/windowIdentity';

const OUT = process.env.FACADE_IT_UPDATE!;
const RECORD = process.env.FACADE_IT_RECORD!;

function write(line: object): void {
	fs.appendFileSync(OUT, `${JSON.stringify(line)}\n`);
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

async function activated(): Promise<void> {
	await until('the installed workspace extension', async () => version() && (await vscode.commands.getCommands(true)).includes('facade.newAgent') ? true : undefined, 90_000);
}

async function newAgent(): Promise<string> {
	const existing = new Set(started());
	return pick('a new agent in this profile', 'facade.newAgent', () => started().find(item => !existing.has(item)));
}

async function installCandidate(): Promise<void> {
	await activated();
	const alias = await newAgent();
	const installed = await until('both components of the installed pair', async () => {
		const main = vscode.extensions.getExtension('facade.facadecode');
		const component = vscode.extensions.getExtension('facade.facadecode-window');
		if (!main?.isActive || !component?.isActive) { return undefined; }
		const session = vscode.env.sessionId;
		const identity = await vscode.commands.executeCommand<WindowIdentity>('facade.window.identity', session);
		if (!identity || identity.session !== session || !identity.token) { return undefined; }
		return {
			version: version(), mainPath: main.extensionPath,
			component: identity.component, componentPath: component.extensionPath, token: identity.token
		};
	});
	await until('one installed agent terminal', async () => tabs().flat().length === 1 || undefined);
	write({ phase: 'started', alias, tabs: tabs(), ...installed });
}

export async function activate(): Promise<void> {
	try {
		await installCandidate();
	} catch (error) {
		write({ phase: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) });
	}
}
