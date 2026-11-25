/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The legacy cutover's driver (ARCHITECTURE-1.4, VERIFICATION-5.2): an extension beside an installed released legacy build of Facade
// Code, in an editor that runs no extension tests, as the installed packages have none of the suite's commands. In the released build
// it starts two agents as a person does and pins the first, so their two distinct sessions and the one Pin are saved; the runner
// then installs the candidate pair and asks for a reload. In the candidate it says which build activated and, when the runner asks,
// runs VS Code's primary-action command for the cutover's notification, or opens the notification center. Each step is a line of FACADE_IT_CUTOVER for the runner to judge; the runner asks for the
// next by a file `<FACADE_IT_CUTOVER>.<step>` or, for one window, `<FACADE_IT_CUTOVER>.<role>.<step>`. A legacy window that still owns
// its agents ends them when asked. It is copied alone into the test window's extensions, so it imports nothing of the
// extension's at run time.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WindowIdentity } from '../../base/windowIdentity';
import type { Directory } from '../../base/windowNetwork';

const OUT = process.env.FACADE_IT_CUTOVER!;
const RECORD = process.env.FACADE_IT_RECORD!;
/** `primary`, the window that starts the legacy agents, or `second`, another window of the same workspace on the candidate. */
const ROLE = process.env.FACADE_IT_CUTOVER_ROLE ?? 'primary';
/** The command the cutover's single action runs, when the variant accepts it. */
const ACCEPT = process.env.FACADE_IT_CUTOVER_COMMAND || undefined;

function write(line: object): void {
	fs.appendFileSync(OUT, `${JSON.stringify({ role: ROLE, ...line })}\n`);
}

function said(): { readonly phase: string; readonly role?: string }[] {
	return fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; role?: string }) : [];
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

function version(): string | undefined {
	return (vscode.extensions.getExtension('facade.facadecode')?.packageJSON as { version?: string } | undefined)?.version;
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
	await until('the installed workspace extension', async () => version() && (await vscode.commands.getCommands(true)).includes('facade.newAgent') ? true : undefined, 90_000);
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
	write({ phase: 'started', version: version(), hostPid: process.pid, agents, saved });
	const next = await until('the candidate pair to be installed, or the owner to end its agents',
		() => fs.existsSync(`${OUT}.reload`) ? 'reload' : fs.existsSync(`${OUT}.${ROLE}.stop`) ? 'stop' : undefined, 300_000);
	if (next === 'stop') {
		// The window that still owns the legacy runs ends them, as a person does with End Agent there
		for (const agent of agents) {
			await vscode.commands.executeCommand('facade.closeAgent', { run_id: agent.run });
		}
		write({ phase: 'stopped', runs: agents.map(agent => agent.run) });
		return;
	}
	write({ phase: 'reloading' });
	void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
}

/** In the candidate: which build activated, then the cutover's action when the runner asks for it. */
async function candidate(): Promise<void> {
	await activated();
	write({ phase: ROLE === 'second' ? 'second-active' : 'updated', version: version(), hostPid: process.pid });
	// The notification center, when the runner asks to read a toast the window may have hidden
	void until('the runner to ask for the notification center', () => fs.existsSync(`${OUT}.${ROLE}.showlist`) || undefined, 300_000)
		.then(() => vscode.commands.executeCommand('notifications.showList'), () => undefined);
	await until('the runner to ask for the cutover action', () => fs.existsSync(`${OUT}.${ROLE}.accept`) || undefined, 300_000);
	if (!ACCEPT) {
		write({ phase: 'accept-unavailable' });
		return;
	}
	const known = (await vscode.commands.getCommands(true)).includes(ACCEPT);
	try {
		const result: unknown = known ? await vscode.commands.executeCommand(ACCEPT) : undefined;
		write({ phase: 'accepted', command: ACCEPT, registered: known, result: result ?? null });
	} catch (error) {
		write({ phase: 'accepted', command: ACCEPT, registered: known, failed: String(error) });
	}
}

export async function activate(): Promise<void> {
	try {
		const first = said().some(line => line.phase === 'started');
		await (ROLE === 'primary' && !first ? legacy() : candidate());
	} catch (error) {
		write({ phase: 'error', message: String(error) });
	}
}
