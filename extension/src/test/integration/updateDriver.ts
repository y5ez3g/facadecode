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
import type { WindowIdentity } from '../../base/windowIdentity';
import type { Directory } from '../../base/windowNetwork';

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

async function activated(): Promise<void> {
	await until('the installed workspace extension', async () => version() && (await vscode.commands.getCommands(true)).includes('facade.newAgent') ? true : undefined, 90_000);
}

async function newAgent(): Promise<string> {
	const existing = new Set(started());
	return pick('a new agent in this profile', 'facade.newAgent', () => started().find(item => !existing.has(item)));
}

/** The actual installed component and the running agents it publishes. */
async function published(aliases: readonly string[]) {
	return until('the installed Window Component to publish the exact live agents', async () => {
		const main = vscode.extensions.getExtension('facade.facadecode');
		const component = vscode.extensions.getExtension('facade.facadecode-window');
		if (!main?.isActive || !component?.isActive) { return undefined; }
		const token = vscode.env.sessionId;
		const answer = await vscode.commands.executeCommand<WindowIdentity>('facade.window.identity', token);
		if (!answer || answer.session !== token) { return undefined; }
		const directory = await vscode.commands.executeCommand<Directory>('facade.window.directory', token);
		const agents = directory?.windows.find(window => window.window === directory.self)?.agents.filter(agent => agent.lifecycle === 'running');
		return directory && agents && aliases.every(alias => agents.some(agent => agent.alias === alias)) ? {
			version: version(), mainPath: main.extensionPath, component: answer.component, componentPath: component.extensionPath,
			window: directory.self, token: answer.token, hostPid: process.pid, agents
		} : undefined;
	}, 30_000);
}

/** Observe a running agent in the fresh install or a replaced Window Component. */
async function replacement(): Promise<void> {
	const first = said().find(line => line.phase === 'started') as { phase: string; alias: string } | undefined;
	await activated();
	const alias = first?.alias ?? await newAgent();
	const { agents, ...identity } = await published([alias]);
	const agent = agents.find(each => each.alias === alias)!;
	write({ phase: first ? 'updated' : 'started', ...identity, run: agent.run, alias });
	if (!first && process.env.FACADE_IT_UPDATE_ROLE === 'receiver') {
		await until('the replacement install', async () => fs.existsSync(`${OUT}.reload`) ? true : undefined, 120_000);
		write({ phase: 'reloading', at: Date.now() });
		void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
	}
}

/** Real Pins and their exact workspace and conversation records across an installed update. */
async function upgradePair(): Promise<void> {
	const first = said().find(line => line.phase === 'started') as { phase: string; aliases: string[] } | undefined;
	await activated();
	const aliases = first?.aliases ?? [await newAgent(), await newAgent(), await newAgent()];
	const pinned = aliases.slice(0, 2);
	const { agents: publishedAgents, ...identity } = await published(aliases);
	const home = path.join(process.env.FACADE_HOME!, 'extension');
	const agents = await Promise.all(aliases.map(async alias => {
		const agent = publishedAgents.find(each => each.alias === alias)!;
		const session = await until('the running conversation', async () => {
			const file = path.join(home, 'runs', agent.run + '.session.json');
			const id: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).session_id : undefined;
			return typeof id === 'string' && id ? id : undefined;
		});
		return { ...agent, session };
	}));
	const terminalTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
		.filter(tab => tab.input instanceof vscode.TabInputTerminal)
		.map(tab => ({ alias: agents.find(agent => tab.label.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, '') === agent.name)?.alias, pinned: tab.isPinned }));
	if (!first) {
		await until('all newly started agent tabs unpinned', async () => {
			const observed = terminalTabs();
			return observed.length === aliases.length &&
				aliases.every(alias => observed.some(tab => tab.alias === alias && !tab.pinned)) || undefined;
		});
		for (const agent of agents.slice(0, pinned.length)) {
			await vscode.commands.executeCommand('facade.pinAgent', { run_id: agent.run });
			await until('the deliberately pinned terminal', async () => terminalTabs().some(tab => tab.alias === agent.alias && tab.pinned) || undefined);
		}
	}
	type Pin = { id: string; name: string; cwd: string; conversation?: { sessionId?: string } };
	const workspaces = path.join(home, 'workspaces');
	const sessions = agents.slice(0, pinned.length).map(agent => agent.session);
	const saved = await until('the real Pins in a single workspace', async () => {
		for (const dir of fs.readdirSync(workspaces)) {
			const file = path.join(workspaces, dir, 'workspace-state.json');
			if (!fs.existsSync(file)) { continue; }
			const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { 'facade.workspaceKey'?: string; 'facade.pins'?: Pin[] };
			const pins = value['facade.pins'];
			if (value['facade.workspaceKey'] === dir && pins?.length === pinned.length &&
				pins.every((pin, index) => pin.conversation?.sessionId === sessions[index])) {
				const workspace = JSON.parse(fs.readFileSync(path.join(workspaces, dir, 'identity.json'), 'utf8')).workspace as string;
				return { key: dir, workspace, pins };
			}
		}
		return undefined;
	});
	const marked = await until('the expected native terminal tabs and Pin marks', async () => {
		const expectedTabs = first ? pinned : aliases;
		const observed = terminalTabs();
		return observed.length === expectedTabs.length &&
			expectedTabs.every(alias => observed.some(tab => tab.alias === alias && tab.pinned === pinned.includes(alias))) ? observed : undefined;
	}, 30_000).catch((error: unknown) => {
		const groups = vscode.window.tabGroups.all.map(group => group.tabs.filter(tab => tab.input instanceof vscode.TabInputTerminal)
			.map(tab => ({ label: tab.label, pinned: tab.isPinned })));
		write({ phase: 'pin-restore-observation', ...identity, aliases, agents, saved, groups });
		throw error;
	});
	write({ phase: first ? 'updated' : 'started', ...identity, aliases, agents, saved, marked });
	if (!first) {
		await until('the candidate pair to be installed', async () => fs.existsSync(OUT + '.reload') || undefined, 120_000);
		write({ phase: 'reloading' });
		void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
	}
}

export async function activate(): Promise<void> {
	try {
		if (process.env.FACADE_IT_UPDATE_ROLE === 'upgrade') { return await upgradePair(); }
		if (process.env.FACADE_IT_UPDATE_ROLE) { return await replacement(); }
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
		await pick('its tab opened', 'facade.goToAgent', () => tabs().flat().length ? true : undefined);
		write({ phase: 'opened', tabs: tabs() });
	} catch (err) {
		write({ phase: 'error', message: err instanceof Error ? err.stack ?? err.message : String(err) });
	}
}

export function deactivate(): void {
	// Nothing to let go
}
