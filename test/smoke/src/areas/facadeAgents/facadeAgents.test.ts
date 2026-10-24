/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { Application, Logger } from '../../../../automation';
import { installAllHandlers } from '../../utils';

// The extension's own stdio MCP client, as compiled: the test drives the window's
// agents the way an agent CLI does, through the person's token.
interface McpTestClient {
	initialize(): Promise<Record<string, unknown>>;
	tools(): Promise<string[]>;
	call(name: string, args?: object): Promise<{ text: string; isError: boolean; data?: Record<string, unknown> }>;
	stop(): Promise<void>;
}
const { StdioMcpClient } = require(path.join(repoRoot(), 'extensions', 'facade-agents', 'out', 'test', 'mcpClient.js')) as { StdioMcpClient: { start(args: readonly string[], env?: NodeJS.ProcessEnv): McpTestClient } };

function repoRoot(): string {
	// Compiled to test/smoke/out/areas/facadeAgents/.
	return path.join(__dirname, '..', '..', '..', '..', '..');
}

interface WindowRecord {
	readonly pipe: string;
	readonly enabled: boolean;
}

async function waitFor<T>(what: string, ms: number, attempt: () => T | undefined): Promise<T> {
	const deadline = Date.now() + ms;
	for (; ;) {
		let found: T | undefined;
		try {
			found = attempt();
		} catch {
			found = undefined;
		}
		if (found !== undefined) {
			return found;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
}

async function waitForAsync<T>(what: string, ms: number, attempt: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + ms;
	for (; ;) {
		try {
			const found = await attempt();
			if (found !== undefined) {
				return found;
			}
		} catch {
			// Not there yet, or going away: a reload is between hosts.
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
}

/**
 * The window's record, as the server wrote it: the workspaces folder under `home` whose
 * identity names `marker`. The extension activates on startup; the record appears once it
 * has. A local window's record is keyed to the workspace it opened with - often the
 * profile's default workspace file, not the folder opened after - so the marker is the
 * run's profile, which only this run has; a remote record names the remote folder.
 */
async function waitForRecord(home: string, marker: string, ms: number): Promise<string> {
	return waitFor(`the record of ${marker}`, ms, () => {
		const root = path.join(home, '.facade', 'workspaces');
		// Every run of the same folder leaves a record with the same marker; only
		// one has a window behind it. A record counts once its window listens -
		// and still lives, as a crashed window's record keeps its file.
		const found: { dir: string; time: number }[] = [];
		for (const id of fs.readdirSync(root, { encoding: 'utf8' }) as string[]) {
			try {
				const dir = path.join(root, id);
				const identity = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'));
				const window = JSON.parse(fs.readFileSync(path.join(dir, 'window.json'), 'utf8')) as { pipe?: string; pid?: number };
				if (typeof identity.workspace !== 'string' || !identity.workspace.includes(marker) || !window.pipe || typeof window.pid !== 'number') {
					continue;
				}
				try {
					process.kill(window.pid, 0);
				} catch {
					continue; // Its window is gone; its record is stale.
				}
				found.push({ dir, time: fs.statSync(path.join(dir, 'window.json')).mtimeMs });
			} catch {
				// Not a record, or not fully written yet.
			}
		}
		found.sort((a, b) => b.time - a.time);
		return found[0]?.dir;
	});
}

export function setup(logger: Logger) {
	describe('Facade Agents', () => {
		installAllHandlers(logger, opts => {
			// The app gets a home of its own beside its user-data folder, so its
			// records never touch the person's ~/.facade; the server inherits it
			// through the resolver. The test server may be kept across the reload.
			const home = path.join(path.dirname(opts.userDataDir!), 'home');
			fs.mkdirSync(home, { recursive: true });
			return {
				...opts,
				extraEnv: {
					...(opts.extraEnv ?? {}),
					HOME: home,
					USERPROFILE: home,
					TESTRESOLVER_KEEP_SERVER: '1',
				},
			};
		});

		let app: Application;

		before(async function () {
			this.timeout(10 * 60 * 1000);
			// The shared handler started the app already, with a profile of its own.
			app = this.app as Application;

			// The fake CLI, as a custom agent of the person's: the server starts it in a
			// terminal of its own. Custom agents are read when one starts, so writing the
			// setting now is in time. `warmUp`, the first group, is the script `node`
			// runs, so the `connect` pair after lands in its argv, not `node`'s;
			// `connect` is Facade's tools, the run's MCP server file (L9), which the
			// script starts like a real CLI - without it the agent cannot be messaged.
			// The fixture compiles with the suite; the server runs the compiled file.
			const smokeping = path.join(repoRoot(), 'test', 'smoke', 'out', 'areas', 'facadeAgents', 'smokeping.js');
			const entry = {
				path: process.execPath,
				launch: { arguments: { warmUp: [smokeping], connect: ['--mcp-config', '${mcpConfig}'] } }
			};
			// Custom agents are machine-scoped: in a remote window the server's own
			// machine settings count, in its user-data folder under its data folder.
			for (const userDataDir of app.remote ? [`${app.userDataPath}-server/data`] : [app.userDataPath]) {
				const settings = path.join(userDataDir!, app.remote ? 'Machine' : 'User', 'settings.json');
				fs.mkdirSync(path.dirname(settings), { recursive: true });
				const current = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')) : {};
				current['facade.agents.custom'] = { ...(current['facade.agents.custom'] ?? {}), smokeping: entry };
				fs.writeFileSync(settings, JSON.stringify(current, null, '\t'));
			}
			// RM-27(a): YOLO off in the local user settings only. Machine-scoped, it
			// must not reach the remote: the remote's next agent still starts with
			// YOLO on.
			if (app.remote) {
				const settings = path.join(app.userDataPath!, 'User', 'settings.json');
				fs.mkdirSync(path.dirname(settings), { recursive: true });
				const current = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')) : {};
				current['facade.agents.yolo'] = false;
				fs.writeFileSync(settings, JSON.stringify(current, null, '\t'));
			}

		});

		it('runs an agent end to end, the same in a remote window as in a local one (RM-02; RM-26; RM-27)', async function () {
			this.timeout(15 * 60 * 1000);
			const home = app.extraEnv?.HOME;
			assert.ok(home, 'the app runs with a home of its own');
			const marker = app.remote ? path.basename(app.workspacePathOrFolder) : path.basename(app.userDataPath!);
			const recordDir = await waitForRecord(home, marker, 120_000);

			// RM-26: a local window with the SSH extension installed and enabled. The
			// dev window loads it as a built-in; its command in the palette proves
			// the running window has it, and the synced copy is the pinned one.
			if (!app.remote) {
				const names = await app.workbench.quickaccess.getVisibleCommandNames('Remote-SSH: Connect to Host');
				assert.ok(names.some(name => name.includes('Connect to Host')), `SSH commands in the palette: ${names.join(', ')}`);
				const builtin = path.join(repoRoot(), '.build', 'builtInExtensions', 'jeanp413.open-remote-ssh', 'package.json');
				assert.ok(fs.existsSync(builtin), `run 'node build/lib/builtInExtensions.ts' first: ${builtin} is missing`);
				const pinned = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'product.json'), 'utf8')).builtInExtensions.find((entry: { name?: string }) => entry.name === 'jeanp413.open-remote-ssh');
				assert.strictEqual(JSON.parse(fs.readFileSync(builtin, 'utf8')).version, pinned.version);
			}

			if (app.remote) {
				// RM-27(b): Configure Agents opens the remote's settings, not the
				// local user settings: the settings editor's Remote tab is checked.
				await app.workbench.quickaccess.runCommand('facade.agent.configure');
				await app.code.waitForElement('.settings-editor .settings-tabs-widget .action-label.checked', el => !!el && el.textContent.includes('Remote'));
				await app.workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
				// RM-27(c): a remote folder's menu has no Reveal: the remote is no
				// place the person has a File Explorer. Remove Folder proves the menu
				// is the folder's, so the absence cannot pass on an empty read.
				await app.code.waitForElement('.workspacebar-list .workspacebar-row');
				await app.code.driver.clickSelector('.workspacebar-list .workspacebar-row', { button: 'right' });
				const menu = await app.code.waitForElements('.context-view .action-menu-item', false, els => els.length > 0);
				const labels = menu.map(each => each.textContent);
				assert.ok(labels.some(label => label.includes('Remove Folder')), `the folder's menu: ${labels.join(' | ')}`);
				assert.ok(!labels.some(label => label.includes('Reveal')), `no Reveal on a remote folder: ${labels.join(' | ')}`);
				await app.code.dispatchKeybinding('escape', async () => { });
			}

			const token = fs.readFileSync(path.join(recordDir, 'you.token'), 'utf8');

			const openClient = () => waitForAsync('an answering window', 180_000, async () => {
				const record = fs.existsSync(path.join(recordDir, 'window.json')) ? JSON.parse(fs.readFileSync(path.join(recordDir, 'window.json'), 'utf8')) as WindowRecord : undefined;
				if (!record?.enabled || !record.pipe) {
					return undefined;
				}
				// The test's own environment may carry Facade variables of a window of its
				// own - an agent running this test is one such; its record would win over
				// the pipe, and the window would refuse the token. Only this window counts.
				const client = StdioMcpClient.start([], { FACADE_AGENTS_RECORD: '', FACADE_AGENTS_PIPE: record.pipe, FACADE_AGENTS_TOKEN: token.trim() });
				try {
					// An answer that never comes is a no: the host is between lives.
					await Promise.race([
						client.initialize(),
						new Promise((_, reject) => setTimeout(() => reject(new Error('no hello')), 10_000)),
					]);
					return client;
				} catch {
					await client.stop().catch(() => undefined);
					return undefined;
				}
			});

			let client = await openClient();
			assert.deepStrictEqual((await client.tools()).sort(), ['list_agents', 'press_keys', 'read_messages', 'read_screen', 'send_message', 'start_agent', 'stop_agent', 'type_text']);

			// Start, and talk to it.
			const started = await client.call('start_agent', { name: 'smoke1', cli: 'smokeping' });
			assert.strictEqual(started.isError, false, started.text);
			const id = (started.data as { id?: number } | undefined)?.id ?? Number(/#a(\d+)/.exec(started.text)?.[1]);
			const ref = `#a${id}`;
			// Its screen: ready means the CLI is up and its server answered its
			// initialize, which is what says hello to the window.
			const seen = await pollScreen(client, ref, 'smokeping ready', 90_000);
			assert.ok(seen.includes('smokeping ready'), seen);
			const state = await waitForAgentState(client, 'smoke1', ['running'], 120_000);
			assert.strictEqual(state, 'running', `the agent never said hello; its screen:\n${seen}`);
			const listed = await client.call('list_agents', { all: true });
			const agents = ((listed.data as { agents?: { name?: string; state?: string; folder?: string; yolo?: boolean }[] } | undefined)?.agents ?? []);
			const smoke = agents.find(each => each.name === 'smoke1');
			assert.ok(smoke?.folder && fs.existsSync(smoke.folder), 'the agent\u2019s folder is the server\u2019s');
			if (app.remote) {
				// RM-27(a): the local YOLO off did not reach the remote's agent.
				assert.strictEqual(smoke?.yolo, true);
				// RM-02: its process is the server's - under the test server, as its record says it launched
				const launched = fs.readFileSync(path.join(recordDir, 'ledger.jsonl'), 'utf8').split(/\r?\n/).filter(line => line.trim())
					.map(line => JSON.parse(line) as { type?: string; id?: number; processId?: number })
					.find(event => event.type === 'agent.launched' && event.id === id);
				const server = (JSON.parse(fs.readFileSync(path.join(`${app.userDataPath}-server`, 'test-resolver-server.json'), 'utf8')) as { pid?: number }).pid;
				assert.ok(launched?.processId && server && ancestorsOf(launched.processId).includes(server), `the agent's process ${launched?.processId} does not run under the test server ${server}`);
			}

			const sent = await client.call('send_message', { to: [`@smoke1 ${ref}`], text: 'smoke says hello' });
			assert.strictEqual(sent.isError, false, sent.text);
			// The send names the message; the person reads it back by number -
			// and the agent's doorbell rings in its terminal, which echoes it.
			const messageId = (sent.data as { messages?: { id?: number }[] } | undefined)?.messages?.[0]?.id ?? Number(/Sent #m(\d+)/.exec(sent.text)?.[1]);
			assert.ok(messageId, `no message number in the send: ${sent.text}`);
			const mail = await client.call('read_messages', { ids: [`#m${messageId}`] });
			assert.strictEqual(mail.isError, false, mail.text);
			assert.ok(mail.text.includes('smoke says hello'), mail.text);
			const rung = await pollScreen(client, ref, 'got:[facade] 1 unread message', 60_000);
			assert.ok(rung.includes('got:[facade] 1 unread message'), rung);

			// Typed text and keys.
			await client.call('type_text', { agent: ref, text: 'ping', enter: true });
			const typed = await pollScreen(client, ref, 'got:ping', 60_000);
			assert.ok(typed.includes('got:ping'), typed);
			await client.call('press_keys', { agent: ref, keys: ['h', 'i', 'Enter'] });
			const keyed = await pollScreen(client, ref, 'got:hi', 60_000);
			assert.ok(keyed.includes('got:hi'), keyed);

			// The record is the server's.
			const ledger = path.join(recordDir, 'ledger.jsonl');
			assert.ok(fs.existsSync(ledger), 'the workspace\u2019s ledger');
			assert.ok(fs.readFileSync(ledger, 'utf8').includes('smoke1'), 'the agent is in the ledger');

			// Reload: the server keeps the agent, the window takes its record back over.
			await app.workbench.quickaccess.runCommand('workbench.action.reloadWindow').catch((err: Error) => {
				if (!/closed|disconnect|destroyed/i.test(String(err))) {
					throw err;
				}
			});
			await client.stop().catch(() => undefined);
			client = await openClient();
			const relisted = await client.call('list_agents', { all: true });
			const resumed = (((relisted.data as { agents?: { name?: string; state?: string }[] } | undefined)?.agents ?? [])).find(each => each.name === 'smoke1');
			assert.strictEqual(resumed?.state, 'running', 'the agent survives the reload');
			const reread = await client.call('read_screen', { agent: ref });
			assert.ok(reread.text.includes('smokeping ready'), reread.text);

			// Stop it.
			const stopped = await client.call('stop_agent', { agent: ref });
			assert.strictEqual(stopped.isError, false, stopped.text);
			const ended = await waitForAgentState(client, 'smoke1', ['ended'], 120_000);
			assert.strictEqual(ended, 'ended');
			const final = await client.call('list_agents', { all: true });
			const smokeEnd = (((final.data as { agents?: { name?: string; end?: { kind?: string } }[] } | undefined)?.agents ?? [])).find(each => each.name === 'smoke1')?.end?.kind;
			assert.strictEqual(smokeEnd, 'stopped');
			await client.stop();
		});

		after(async function () {
			// The kept test server outlives the window, so a reload reconnects to it;
			// nothing shuts it down by itself. Stop it now, so no server holds the
			// run's logs when the next run clears them - but only while its port
			// still answers, so the pid cannot have been reused by another process.
			if (!app?.remote) {
				return;
			}
			try {
				const file = path.join(`${app.userDataPath}-server`, 'test-resolver-server.json');
				const recorded = JSON.parse(fs.readFileSync(file, 'utf8')) as { port?: unknown; pid?: unknown };
				if (typeof recorded.port === 'number' && typeof recorded.pid === 'number' && await portAnswers(recorded.port)) {
					endTree(recorded.pid);
				}
			} catch {
				// Gone already, or never booted.
			}
		});
	});
}

/**
 * Ends `pid` and what it started: the dev launcher records the server's own process, the packaged one the
 * shell that runs it, whose child the server is.
 */
function endTree(pid: number): void {
	if (process.platform === 'win32') {
		cp.spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
		return;
	}
	cp.spawnSync('pkill', ['-TERM', '-P', String(pid)], { stdio: 'ignore' });
	process.kill(pid);
}

/** The processes above `pid`, nearest first, as the system's process table has them. */
function ancestorsOf(pid: number): number[] {
	const table = process.platform === 'win32'
		? cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8' })
		: cp.execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
	const parents = new Map<number, number>();
	for (const line of table.split(/\r?\n/)) {
		const [child, parent] = line.trim().split(/\s+/).map(Number);
		if (child > 0) {
			parents.set(child, parent);
		}
	}
	const chain: number[] = [];
	for (let at = parents.get(pid); at !== undefined && at > 0 && !chain.includes(at) && chain.length < 64; at = parents.get(at)) {
		chain.push(at);
	}
	return chain;
}

/** Whether something answers on `port` of this machine, as the test resolver's reuse probes it. */
async function portAnswers(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const probe = net.createConnection({ host: '127.0.0.1', port });
		probe.on('connect', () => { probe.end(); resolve(true); });
		probe.on('error', () => resolve(false));
		probe.setTimeout(2000, () => { probe.destroy(); resolve(false); });
	});
}

async function pollScreen(client: { call(name: string, args: object): Promise<{ text: string }> }, ref: string, line: string, ms: number): Promise<string> {
	const deadline = Date.now() + ms;
	let text = '';
	for (; ;) {
		text = (await client.call('read_screen', { agent: ref })).text;
		if (text.includes(line) || Date.now() >= deadline) {
			return text;
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
}

async function waitForAgentState(client: { call(name: string, args: object): Promise<{ data?: Record<string, unknown> }> }, name: string, states: string[], ms: number): Promise<string> {
	const deadline = Date.now() + ms;
	for (; ;) {
		const listed = await client.call('list_agents', { all: true });
		const state = (((listed.data as { agents?: { name?: string; state?: string }[] } | undefined)?.agents ?? [])).find(each => each.name === name)?.state;
		if ((state && states.includes(state)) || Date.now() >= deadline) {
			return state ?? '(gone)';
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
}
