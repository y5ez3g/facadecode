/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The engine switch's driver, an extension beside Facade Code in an editor that runs no extension tests: the switch needs real reloads,
// which end a test run's extension host. The window starts on the old engine (`facade.rustEngine` off) and starts two agents; the
// driver sets the setting to `auto` and reloads: the agents go on, on the old engine. Both are ended: a new agent is refused. Reload:
// the window is on the Rust engine, and Recent continues both conversations by their sessions. Each step is a line of
// FACADE_IT_SWITCH for the runner to judge; the editor's notice text is not readable by an extension, so the runner judges what
// the window did instead: which engine ran, which agents ran, and that nothing was started where the notice says to reload.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelState } from '../../webview/protocol';

const OUT = process.env.FACADE_IT_SWITCH!;
const RECORD = process.env.FACADE_IT_RECORD!;
const HOME = process.env.FACADE_HOME!;
const unspun = (title: string) => title.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u, '');

function write(line: object): void {
	fs.appendFileSync(OUT, `${JSON.stringify(line)}\n`);
}

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
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

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Core's daemon socket for this root, by the rule core and the extension share: there only while a daemon of it runs. On Windows its
 * named pipe, among the pipes, which listing does not connect to.
 */
function coreRuns(): boolean {
	const key = crypto.createHash('sha256').update(Buffer.from(HOME, 'utf8')).digest('hex').slice(0, 10);
	return process.platform === 'win32' ? fs.readdirSync('\\\\.\\pipe\\').includes(`facade-core-daemon-${key}`)
		: fs.existsSync(path.join('/tmp', `facade-core-${process.getuid?.() ?? 0}`, `daemon-${key}.sock`));
}

const aliasOf = (card: PanelState['cards'][number]) => card.alias;
const started = () => fs.readdirSync(path.dirname(RECORD)).filter(file => file.startsWith(`${path.basename(RECORD)}.args.`)).sort();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (alias: string) => fs.existsSync(`${RECORD}.${alias}`) ? Number(fs.readFileSync(`${RECORD}.${alias}`, 'utf8').trim()) : undefined;

/** New Agent with the preselected CLI, accepted as soon as its picker shows. */
async function newCard(): Promise<PanelState['cards'][number]> {
	const before = new Set((await state()).cards.map(card => card.runId));
	void vscode.commands.executeCommand('facade.newAgent');
	return until('a new card', async () => {
		const added = (await state()).cards.find(card => !before.has(card.runId));
		if (added) {
			return added;
		}
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		return undefined;
	});
}

export async function activate(): Promise<void> {
	try {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined, 90_000);
		const phases = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; [key: string]: unknown }) : [];
		const has = (phase: string) => phases.some(line => line.phase === phase);
		const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
		if (!has('two')) {
			// The old engine, switched off by the setting: two agents, each with the conversation its CLI keeps
			const agents: { runId: string; alias: string; name: string; pid: number; session: string }[] = [];
			for (let at = 0; at < 2; at++) {
				const card = await newCard();
				const alias = aliasOf(card);
				const pid = await until('its CLI to start', () => pidOf(alias));
				const session = await until('its session', () => {
					try {
						const id: unknown = JSON.parse(fs.readFileSync(path.join(HOME, 'extension', 'runs', `${card.runId}.session.json`), 'utf8')).session_id;
						return typeof id === 'string' && id ? id : undefined;
					} catch { return undefined; }
				});
				// What Claude Code keeps of a conversation, which Recent reads: the fixture this fake CLI does not write
				const store = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));
				fs.mkdirSync(store, { recursive: true });
				fs.writeFileSync(path.join(store, `${session}.jsonl`), [
					{ type: 'user', sessionId: session, cwd: folder, parentUuid: null, message: { role: 'user', content: `Switch journey conversation ${at + 1}` } },
					{ type: 'assistant', sessionId: session, timestamp: new Date(Date.now() + at * 60_000).toISOString(), message: { role: 'assistant', content: [] } },
					{ type: 'ai-title', sessionId: session, aiTitle: `Switch journey conversation ${at + 1}` }
				].map(value => JSON.stringify(value)).join('\n') + '\n');
				agents.push({ runId: card.runId, alias, name: card.name, pid, session });
			}
			const setting = vscode.workspace.getConfiguration('facade').inspect<string>('rustEngine')?.globalValue;
			await vscode.workspace.getConfiguration('facade').update('rustEngine', 'auto', vscode.ConfigurationTarget.Global);
			write({ phase: 'two', before: setting, agents, core: coreRuns() });
			void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		const two = phases.find(line => line.phase === 'two') as unknown as { agents: { runId: string; alias: string; pid: number; session: string }[] };
		if (!has('old-still')) {
			// `auto`, and old runs running: the same engine, the same agents
			const cards = (await state()).cards;
			write({ phase: 'old-still', cards: cards.map(card => card.runId), alive: two.agents.map(agent => alive(agent.pid)), core: coreRuns(), setting: vscode.workspace.getConfiguration('facade').get('rustEngine') });
			// Both ended: the old engine has nothing running, and a start is refused where it says to reload
			for (const agent of two.agents) {
				await vscode.commands.executeCommand('facade.stopAgent', { run_id: agent.runId });
			}
			await until('both to end', async () => (await state()).cardCount === 0 && two.agents.every(agent => !alive(agent.pid)) ? true : undefined);
			// The window learns the old runs are gone within its poll of ptyd; a start after that is refused
			await pause(12_000);
			const before = started();
			void vscode.commands.executeCommand('facade.newAgent');
			for (let at = 0; at < 8; at++) {
				await pause(1_000);
				await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			}
			write({ phase: 'refused', cards: (await state()).cardCount, newCli: started().filter(file => !before.includes(file)), core: coreRuns() });
			void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => undefined);
			return;
		}
		// The window opened on the Rust engine: Recent has both conversations, and each click continues one by its session
		const resumed: { alias: string; session: string }[] = [];
		const wanted = new Set(two.agents.map(agent => agent.session));
		for (let attempt = 0; attempt < 6 && resumed.length < wanted.size; attempt++) {
			const before = new Set((await state()).cards.map(card => card.runId));
			void vscode.commands.executeCommand('facade.history');
			await pause(1_500);
			for (let skip = 0; skip < attempt % 2; skip++) {
				await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
			}
			const card = await until('a card Recent starts', async () => {
				const added = (await state()).cards.find(each => !before.has(each.runId));
				if (added) { return added; }
				await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
				return undefined;
			}, 15_000).catch(() => undefined);
			if (!card) {
				await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
				continue;
			}
			const alias = aliasOf(card);
			const launch = await until('its CLI to start', () => fs.existsSync(`${RECORD}.args.${alias}`) ? JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8')) as { args: string[] } : undefined);
			const at = launch.args.indexOf('--resume');
			resumed.push({ alias, session: at >= 0 ? launch.args[at + 1] : `none: ${launch.args.join(' ')}` });
		}
		write({ phase: 'rust', core: coreRuns(), resumed, terminals: vscode.window.terminals.map(each => unspun(each.name)), cards: (await state()).cards.map(card => aliasOf(card)) });
	} catch (err) {
		write({ phase: 'error', error: String(err) });
	}
}

export function deactivate(): void { }
