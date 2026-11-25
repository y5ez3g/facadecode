/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The legacy cutover's driver (ARCHITECTURE-1.4, VERIFICATION-5.2): an extension beside an installed released legacy build of Facade
// Code, in an editor that runs no extension tests, as the installed packages have none of the suite's commands. In the released build
// it starts two agents as a person does and pins the first, so their two distinct sessions and the one Pin are saved; the runner
// then installs the candidate pair and asks for a reload. Each window reports its actions to FACADE_IT_CUTOVER and accepts
// requests from `<FACADE_IT_CUTOVER>.<role>.<step>`. A released window can enter text into its own live terminal or stop its agents.
// A candidate window can show its notifications and exercise the Settings file action. The driver is copied alone.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WindowIdentity } from '../../base/windowIdentity';
import type { Directory } from './legacyDirectory';

const OUT = process.env.FACADE_IT_CUTOVER!;
const RECORD = process.env.FACADE_IT_RECORD!;
/** The original window or its peer, which can open either the same workspace or its own. */
const ROLE = process.env.FACADE_IT_CUTOVER_ROLE ?? 'primary';

function write(line: object): void {
	fs.appendFileSync(OUT, `${JSON.stringify({ role: ROLE, ...line })}\n`);
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 20_000): Promise<T> {
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

function version(extension: string): string | undefined {
	return (vscode.extensions.getExtension(`facade.${extension}`)?.packageJSON as { version?: string } | undefined)?.version;
}

function installedPair() {
	const main = vscode.extensions.getExtension('facade.facadecode');
	const component = vscode.extensions.getExtension('facade.facadecode-window');
	return { version: version('facadecode'), component: version('facadecode-window'),
		mainPath: main?.extensionPath, componentPath: component?.extensionPath };
}

/** The legacy agents the fake CLI says started, by the files `<record>.#aN` holding their process IDs. */
function started(): string[] {
	const dir = path.dirname(RECORD), prefix = `${path.basename(RECORD)}.`;
	return fs.readdirSync(dir).filter(name => name.startsWith(prefix) && /^#a\d+$/.test(name.slice(prefix.length))).map(name => name.slice(prefix.length));
}

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
	await until('the installed workspace extension', async () => version('facadecode') && (await vscode.commands.getCommands(true)).includes('facade.newAgent') ? true : undefined, 90_000);
}

async function newAgent(): Promise<string> {
	const existing = new Set(started());
	return pick('a new agent in this profile', 'facade.newAgent', () => started().find(item => !existing.has(item)));
}

/** The running legacy agents the installed Window Component publishes for this window. */
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
		return directory && agents && aliases.every(alias => agents.some(agent => agent.alias === alias)) ? agents : undefined;
	}, 30_000);
}

/** In the released legacy build: two agents with distinct sessions, the first pinned, and the saved Pin. */
async function legacy(): Promise<void> {
	await activated();
	const aliases = [await newAgent(), await newAgent()];
	const live = await published(aliases);
	const home = path.join(process.env.FACADE_HOME!, 'extension');
	const agents = await Promise.all(aliases.map(async alias => {
		const agent = live.find(each => each.alias === alias)!;
		const session = await until('the running conversation', () => {
			const file = path.join(home, 'runs', `${agent.run}.session.json`);
			const id: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).session_id : undefined;
			return typeof id === 'string' && id ? id : undefined;
		});
		return { alias, run: agent.run, name: agent.name, session };
	}));
	await vscode.commands.executeCommand('facade.pinAgent', { run_id: agents[0].run });
	type Pin = { id: string; conversation?: { sessionId?: string } };
	const workspaces = path.join(home, 'workspaces');
	const saved = await until('the one legacy Pin saved in a single workspace', () => {
		for (const dir of fs.existsSync(workspaces) ? fs.readdirSync(workspaces) : []) {
			const file = path.join(workspaces, dir, 'workspace-state.json');
			if (!fs.existsSync(file)) { continue; }
			const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { 'facade.workspaceKey'?: string; 'facade.pins'?: Pin[] };
			const pins = value['facade.pins'];
			if (value['facade.workspaceKey'] === dir && pins?.length === 1 && pins[0].conversation?.sessionId === agents[0].session) {
				return { key: dir, pins };
			}
		}
		return undefined;
	});
	const uri = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
	write({ phase: 'started', ...installedPair(), hostPid: process.pid, uri, agents, saved });
	for (;;) {
		const step = await until('a runner request for the released window', () =>
			['reload', 'stop', 'scope', 'input'].find(each => fs.existsSync(`${OUT}.${ROLE}.${each}`)), 300_000);
		const file = `${OUT}.${ROLE}.${step}`;
		const text = fs.readFileSync(file, 'utf8');
		fs.unlinkSync(file);
		if (step === 'stop') {
			for (const agent of agents) {
				await vscode.commands.executeCommand('facade.closeAgent', { run_id: agent.run });
			}
			write({ phase: 'stopped', runs: agents.map(agent => agent.run) });
			return;
		}
		if (step === 'reload') {
			write({ phase: 'reloading' });
			void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		if (step === 'scope') {
			const opened = await vscode.commands.executeCommand('facade.revealAgent', { run_id: text });
			write({ phase: 'foreign-run', run: text, opened, version: version('facadecode') });
			continue;
		}
		const [agent] = agents;
		if (!await vscode.commands.executeCommand('facade.revealAgent', { run_id: agent.run })) {
			throw new Error(`Could not open ${agent.run} in the released window`);
		}
		const terminal = await until('the released agent terminal', () => {
			const active = vscode.window.activeTerminal;
			return active && 'pty' in active.creationOptions && active.name.includes(agent.name) ? active : undefined;
		});
		terminal.sendText(text, true);
		write({ phase: 'input-sent', run: agent.run, terminal: terminal.name, text, version: version('facadecode'), hostPid: process.pid });
	}
}

/** In the candidate: report which packages and host are active, even while the host is waiting on cutover. */
async function candidate(): Promise<void> {
	await activated();
	write({ phase: 'candidate-loaded', ...installedPair(), hostPid: process.pid });
	for (;;) {
		const step = await until('a runner request for the candidate window', () =>
			['reload', 'showlist', 'settings'].find(each => fs.existsSync(`${OUT}.${ROLE}.${each}`)), 300_000).catch(() => undefined);
		if (!step) { return; }
		fs.unlinkSync(`${OUT}.${ROLE}.${step}`);
		if (step === 'reload') {
			void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		if (step === 'showlist') {
			await vscode.commands.executeCommand('notifications.showList');
		} else {
			await vscode.commands.executeCommand('facade.openSettingsFile');
			const opened = vscode.window.activeTextEditor?.document.uri.fsPath;
			write({ phase: 'settings', opened, hostPid: process.pid });
			if (opened === path.join(process.env.FACADE_HOME!, 'facade.json')) {
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			}
		}
	}
}

export async function activate(): Promise<void> {
	try {
		await (version('facadecode') === '0.1.5' ? legacy() : candidate());
	} catch (error) {
		write({ phase: 'error', message: String(error) });
	}
}
