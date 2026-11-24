/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Response, DaemonHelloParams, InspectResult, ScreenText } from '../../base/frameworkProtocol';
import { lineReader } from '../../base/lines';
import { unspun } from '../../base/tabSpinner';
import { isWindowIdentity, WINDOW_IDENTITY_COMMAND } from '../../base/windowIdentity';
import { AGENTS_ROUTE_COMMAND, type Directory, type RouteResponse, WINDOW_DIRECTORY_COMMAND, WINDOW_ROUTE_COMMAND } from '../../base/windowNetwork';
import type { GuestCaller, RoutedCall } from '../../contract/network';
import { TOOL_PROTOCOL } from '../../schema/protocol';
import type { Result } from '../../schema/result';
import { linesOf as cardLines } from '../detailLines';
import { frameworkCall, frameworkSocket, localFolderIdentity, normalizeDriveLetter } from './editors';
import { BUILT_IN_ADAPTERS } from '../../clis/catalog';
import type { Card, PanelState } from '../../webview/protocol';
import { observeAcceptanceImplementation } from './acceptanceImplementation';

const RECORD = process.env.FACADE_IT_RECORD!;
/** Whether the windows run on the Framework: Facade's tools are framework's, with framework's arguments and results. */
const FRAMEWORK = process.env.FACADE_IT_IMPLEMENTATION === 'framework';
const DELIVERY_WAIT = FRAMEWORK ? { wait_for: 'delivery', timeout_seconds: 30 } : {};
const CLI = process.env.FACADE_IT_CLI ?? 'claude';
/** The label of the other editor window of a cross-window run, and its folder: none in a run of one window. */
const PEER = process.env.FACADE_IT_PEER;
const PEER_DIR = process.env.FACADE_IT_PEER_DIR;
/**
 * Whether the other window's agents run on another computer - one window local, the other over SSH: what they record stays there,
 * and what they did is read through the tools alone.
 */
const PEER_ELSEWHERE = !!process.env.FACADE_IT_PEER_ELSEWHERE;

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

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface Answer {
	readonly result?: { readonly isError?: boolean; readonly structuredContent?: any; readonly serverInfo?: { name: string }; readonly instructions?: string; readonly tools?: { name: string }[]; readonly content?: { text: string }[] };
}

interface Line {
	readonly step: string;
	readonly phase?: number;
	readonly answer?: Answer;
	readonly elapsedMs?: number;
	readonly cancellation?: { readonly requestId: number; readonly messageNumber: number; readonly relay: string };
}

/** The fake CLI's record of its tool calls: every answer, as a JSON line. */
function linesOf(alias: string): Line[] {
	const file = `${RECORD}.mcp.${alias}`;
	const lines: Line[] = [];
	if (fs.existsSync(file)) {
		// The fake CLI can still be appending the last record while this test reads it.
		const read = lineReader(line => lines.push(JSON.parse(line) as Line), error => { throw error; });
		read(fs.readFileSync(file));
	}
	return lines;
}

/** Raw terminal input recorded by the fake CLI itself. */
function terminalInputOf(alias: string): string {
	const file = `${RECORD}.stdin.${alias}`;
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
		.map(line => (JSON.parse(line) as { data: string }).data).join('') : '';
}

const phases = new Map<string, number>();

interface Step {
	readonly tool: string;
	readonly arguments: { readonly [key: string]: unknown };
	readonly save?: { readonly [name: string]: string };
	readonly until?: string;
	readonly untilAbsent?: string;
	readonly wait?: number;
	readonly timed?: boolean;
	readonly cancelWhenPending?: true;
}

/** Has the agent `alias` run `steps` through its Facade tools, and answers what each step got, by the step's tool and its order. */
async function script(alias: string, steps: readonly Step[], ms = 90_000): Promise<{
	readonly answer: (tool: string, nth?: number) => Answer['result'];
	readonly content: (tool: string, nth?: number) => any;
	readonly elapsedMs: (tool: string, nth?: number) => number | undefined;
	readonly recorded: (tool: string, nth?: number) => Line | undefined;
}> {
	const phase = phases.get(alias) ?? 0;
	phases.set(alias, phase + 1);
	fs.writeFileSync(`${RECORD}.mcp-script.${alias}`, JSON.stringify(steps));
	const lines = await until(`${alias} to finish its tool calls of phase ${phase}`, () => {
		const read = linesOf(alias).filter(line => line.phase === phase);
		return read.some(line => line.step === 'done') ? read : undefined;
	}, ms);
	for (const line of lines) {
		const result = line.answer?.result;
		if (result?.structuredContent !== undefined) {
			assert.deepStrictEqual(JSON.parse(result.content![0].text!), result.structuredContent, `${line.step}: both MCP representations agree`);
		}
	}
	const step = (tool: string, nth = 0) => lines.filter(line => line.step === tool)[nth];
	const answer = (tool: string, nth?: number) => step(tool, nth)?.answer?.result;
	return { answer, content: (tool, nth) => answer(tool, nth)?.structuredContent, elapsedMs: (tool, nth) => step(tool, nth)?.elapsedMs, recorded: step };
}

function fakeAlias(address: string): string {
	assert.match(address, /^a\d+@[^\s]+$/u);
	return `#${address.split('@')[0]}`;
}

/** The person's own agent of this suite: started from New Agent, its card the new one no agent started. */
async function personAgent(): Promise<{ readonly card: Card; readonly alias: string; readonly address: string }> {
	const before = new Set((await state()).cards.map(each => each.runId));
	void vscode.commands.executeCommand('facade.newAgent');
	// The picker shows once its CLIs are found: accepted as soon as it is there, however long that takes
	const card = await until('a new card', async () => {
		const mine = (await state()).cards.find(each => !before.has(each.runId) && !cardLines(each).some(line => line.startsWith('Started by')));
		if (mine && (FRAMEWORK ? mine.alias : /#a\d+/.test(cardLines(mine).join(' ')))) {
			return mine;
		}
		if (!mine) {
			await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		}
		return undefined;
	});
	const address = FRAMEWORK ? await until(`${card.name} in the shared roster`, async () => {
		const { agents } = await frameworkCall(process.env.FACADE_HOME!, 'agent.list', {});
		return agents.find(row => row.type === 'managed' && row.name === card.name && row.reference.agent_id === card.alias)?.address;
	}) : cardLines(card).join(' ').match(/#a\d+/)![0];
	const alias = FRAMEWORK ? fakeAlias(address) : address;
	// Its server answered: the agent's Facade tools are there
	await until(`${alias}'s Facade server`, () => linesOf(alias).some(line => line.step === 'tools/list') ? true : undefined)
		.catch(async (error: Error) => {
			if (FRAMEWORK && CLI === 'agy') {
				try { await frameworkAgentRecord(alias, address); }
				catch (diagnostic) { console.error(`Framework agy startup diagnostics unavailable: ${diagnostic}`); }
				throw error;
			}
			throw new Error(`${error.message}\n${startRecord(alias)}`);
		});
	return { card, alias, address };
}

/** Capture the current state of a fixture agent after an MCP failure, through its existing Orchestrator. */
async function frameworkAgentRecord(alias: string, address: string): Promise<void> {
	console.error(`Framework MCP diagnostics ${JSON.stringify({ started_at: new Date().toISOString(), alias, platform: process.platform, arch: process.arch })}`);
	try {
		const configured = process.env.FACADE_HOME;
		if (!configured || !RECORD || !path.isAbsolute(configured) || !path.isAbsolute(RECORD) || fakeAlias(address) !== alias) {
			throw new Error('unavailable: missing run root/record prefix or mismatched card alias');
		}
		// RECORD is a prefix, not a file; run.ts puts this case's root in <run>/home/<case> beside <run>/fake-cli.log.
		const root = fs.realpathSync(path.dirname(RECORD));
		const home = fs.realpathSync(configured);
		const record = path.join(root, path.basename(RECORD));
		if (path.dirname(home) !== path.join(root, 'home') || path.basename(RECORD) !== 'fake-cli.log') {
			throw new Error('unavailable: Facade root and fake record prefix do not belong to the same integration run');
		}
		console.error(`diagnostic root given=${configured}; real=${home}; fake record prefix=${record}`);
		try {
			// A single terminal connection: no startup, takeover, window, reconnect, watch, attach, input or resize.
			const hello: DaemonHelloParams = { api_versions: [1], build: 'integration-test-diagnostics', kind: 'terminal' };
			const requests = [{ method: 'hello', params: hello },
				{ method: 'call', params: { op: 'agent.inspect', args: { target: address } } },
				{ method: 'call', params: { op: 'agent.screen', args: { target: address, lines: 400 } } }];
			const socket = net.createConnection(frameworkSocket(configured));
			const timer = setTimeout(() => socket.destroy(new Error('diagnostic connection exceeded 5 seconds')), 5_000);
			try {
				await new Promise<void>((resolve, reject) => {
					let id = 0;
					const next = () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, ...requests[id - 1] })}\n`);
					socket.once('connect', next);
					socket.once('error', reject);
					socket.once('close', () => reject(new Error('diagnostic connection closed')));
					socket.on('data', lineReader(line => {
						try {
							const response = JSON.parse(line) as Response;
							if (response.id !== id) { return; }
							const label = ['hello', 'agent.inspect', 'agent.screen (current screen captured after wait failure)'][id - 1];
							if ('error' in response) {
								console.error(`${label} unavailable at ${new Date().toISOString()}: ${JSON.stringify(response.error)}`);
								if (id === 1) { reject(new Error('diagnostic hello refused')); return; }
							} else if (id > 1) {
								const inspect = response.result as InspectResult;
								const screen = response.result as ScreenText;
								const returned = id === 2 ? inspect?.agent?.reference.agent_id : screen?.reference.agent_id;
								if (returned?.replace(/^#/, '') !== alias.slice(1)) {
									console.error(`${label} unavailable: returned agent_id does not match ${alias}`);
								} else {
									console.error(`${label} at ${new Date().toISOString()}:\n${JSON.stringify(response.result)}`);
									if (id === 2) { console.error(`dimensions from inspect.agent: cols=${inspect.agent.size?.cols ?? 'unknown'} rows=${inspect.agent.size?.rows ?? 'unknown'}; screen.line_count is not rows`); }
								}
							}
							if (id < requests.length) { next(); } else { resolve(); }
						} catch (error) { reject(error); }
					}, reject));
				});
			} finally { clearTimeout(timer); socket.destroy(); }
		} catch (error) { console.error(`remaining framework diagnostics unavailable: ${error}`); }
		for (const [file, base64] of [[path.join(home, 'framework', 'logs', 'daemon.log'), false], [path.join(home, 'framework', 'logs', 'keeper.log'), false],
			[`${record}.stdin.${alias}`, false], [`${record}.bytes.${alias}`, true], [`${record}.panel.${alias}`, false]] as const) {
			try {
				if (fs.realpathSync(file) !== file) { throw new Error('diagnostic file resolves outside its expected run path'); }
				console.error(`${file}${base64 ? ' (base64)' : ''} at ${new Date().toISOString()}:\n${fs.readFileSync(file).toString(base64 ? 'base64' : 'utf8')}`);
			} catch (error) { console.error(`${file} unavailable: ${error}`); }
		}
	} finally { console.error(`Framework MCP diagnostics ended_at=${new Date().toISOString()}`); }
}

async function expectSent(receipt: { readonly status?: string } | undefined, alias: string, address?: string): Promise<void> {
	if (address && receipt?.status !== 'success') {
		try { await frameworkAgentRecord(alias, address); }
		catch (error) { console.error(`Framework MCP delivery diagnostics unavailable: ${error}`); }
	}
	assert.strictEqual(receipt?.status, 'success', JSON.stringify(receipt));
}

/** What a start that brought no Facade server left: the daemon's lines about the agent, and the fake CLI's records of its MCP panel and its input. */
function startRecord(alias: string): string {
	const last = (file: string, mine: (line: string) => boolean = () => true) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(line => line && mine(line)).slice(-20).join('\n') : '(none)');
	const named = new RegExp(`${alias}(?!\\d)`);
	return [`daemon.log:\n${last(path.join(process.env.FACADE_HOME ?? '', 'framework', 'logs', 'daemon.log'), line => named.test(line))}`,
		`${alias}.panel:\n${last(`${RECORD}.panel.${alias}`)}`, `${alias}.stdin:\n${last(`${RECORD}.stdin.${alias}`)}`].join('\n');
}

/** The message blocks a fake agent's input box took, as it recorded them. */
function received(alias: string): string[] {
	const file = `${RECORD}.received.${alias}`;
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string) : [];
}

async function closePublicAgent(alias: string): Promise<void> {
	const card = (await state()).cards.find(each => each.alias === alias);
	assert.ok(card, `No card for ${alias}`);
	await vscode.commands.executeCommand(card.menu.dismiss ? 'facade.dismissAgent' : 'facade.stopAgent', { run_id: card.runId });
}

function argsOf(alias: string): { readonly cwd: string; readonly args: string[]; readonly env: { readonly [name: string]: string } } {
	return JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8'));
}

const after = (args: readonly string[], option: string) => args[args.indexOf(option) + 1];

/**
 * Check the Facade server and approval settings the agent received at launch, including the legacy skill plugin.
 * See CLIS-1.3 and CLIS-2.2.
 */
function assertTools(alias: string): void {
	const { cwd, args, env } = argsOf(alias);
	if (FRAMEWORK && CLI !== 'claude') {
		// Framework wires each CLI its own way (a hook, a plugin, an extension, per-start overrides): what every one has is framework's relay or a file of
		// the run's own folder in what the CLI was given
		const given = `${args.join('\n')}\n${Object.values(env).join('\n')}\n${[...args.entries()].flatMap(([at, arg]) => ['-e', '--settings'].includes(args[at - 1] ?? '') && fs.existsSync(arg) ? [fs.readFileSync(arg, 'utf8')] : []).join('\n')}`;
		// The run's folder with the system's separator: backslashes on Windows
		assert.ok(/facade-mcp|[\\/]framework[\\/]runs[\\/]/.test(given), `${CLI} is given framework's relay or its run's files: ${args.join(' ')}`);
		return;
	}
	const routes = (variables: { readonly [name: string]: string }) => ['FACADE_PTYD', 'FACADE_RUN'].every(name => typeof variables[name] === 'string' && variables[name] !== '');
	switch (CLI) {
		case 'claude': {
			const server = JSON.parse(fs.readFileSync(after(args, '--mcp-config'), 'utf8')).mcpServers.facade;
			if (FRAMEWORK) {
				assert.deepStrictEqual(Object.keys(server.env), ['FACADE_HOME']);
				assert.strictEqual(server.env.FACADE_HOME, process.env.FACADE_HOME);
				assert.ok(path.isAbsolute(server.command));
				assert.ok(server.args[0] === '--run-credential' && typeof server.args[1] === 'string' && server.args[1].length > 0,
					'framework wrote the actual run credential into the private MCP configuration');
				assert.ok(!args.includes('--plugin-dir'), 'framework launches without the Facade skill plugin');
			} else {
				assert.deepStrictEqual(Object.keys(server.env).sort(), ['ELECTRON_RUN_AS_NODE', 'FACADE_AGENT', 'FACADE_LAUNCH_CONTEXT', 'FACADE_PTYD', 'FACADE_RUN']);
				assert.strictEqual(`#${server.env.FACADE_AGENT.replace(/^#/, '')}`, alias, 'the MCP child receives its own short ID explicitly');
				assert.ok(fs.existsSync(path.join(after(args, '--plugin-dir'), 'skills', 'facade', 'SKILL.md')), 'its own skill plugin');
			}
			assert.strictEqual(after(args, '--allowedTools'), 'mcp__facade', 'Facade\'s own tools never ask for approval (CLIS-2.2)');
			break;
		}
		case 'codex':
			assert.ok(args.includes('mcp_servers.facade.default_tools_approval_mode="approve"'), args.join(' '));
			assert.ok(args.some(arg => arg.startsWith('mcp_servers.facade.env=') && arg.includes('FACADE_RUN')), args.join(' '));
			assert.ok(fs.existsSync(path.join(cwd, '.agents', 'skills', 'facade', 'SKILL.md')), 'the skill in its folder');
			break;
		case 'agy': {
			// Its session's settings are a file of the run, given by its path, never inline (CONFIGURATION-4.2)
			assert.ok(JSON.parse(fs.readFileSync(after(args, '--settings'), 'utf8')).permissions.allow.includes('mcp(facade_facade/*)'), args.join(' '));
			const plugin = path.join(cwd, '.agents', 'plugins', 'facade');
			assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(plugin, 'mcp_config.json'), 'utf8')).mcpServers.facade.env), ['ELECTRON_RUN_AS_NODE']);
			assert.ok(fs.existsSync(path.join(plugin, 'skills', 'facade', 'SKILL.md')) && routes(env), 'the plugin, and the run\'s variables in its environment');
			// Its MCP panel was opened before its first turn: that turn has the tools (COLLABORATION-2.2)
			assert.ok(fs.existsSync(`${RECORD}.panel.${alias}`), 'its MCP panel opened before its first turn');
			break;
		}
		case 'muse': {
			// For the run alone by -c, optional, on Windows too, where its program starts directly (CLIS-2.2)
			const entry = JSON.parse(args.find(arg => arg.startsWith('mcpServers.facade='))!.slice('mcpServers.facade='.length));
			assert.deepStrictEqual([entry.env.FACADE_RUN, entry.mode], ['${FACADE_RUN}', 'optional']);
			assert.ok(args.includes('--trust-workspace') && routes(env), args.join(' '));
			assert.ok(fs.existsSync(path.join(cwd, '.agents', 'skills', 'facade', 'SKILL.md')), 'the skill in its folder');
			break;
		}
		case 'opencode': {
			const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
			assert.deepStrictEqual([config.permission['facade_*'], args[0]], ['allow', '--standalone']);
			assert.ok(fs.existsSync(config.instructions.at(-1)) && routes(config.mcp.facade.environment), JSON.stringify(config));
			break;
		}
		case 'pi':
			assert.ok(fs.readFileSync(after(args, '-e'), 'utf8').includes('"exposure":"direct"'), 'its own extension');
			assert.ok(!args.includes('--skill'), 'the native resource hook avoids a duplicate project skill');
			assert.ok(fs.existsSync(path.join(path.dirname(after(args, '-e')), 'skills', 'facade', 'SKILL.md')), 'its private skill remains available to the hook');
			break;
		default:
			assert.fail(`no check for ${CLI}`);
	}
}

/** How a creation prompt goes in for this CLI (COLLABORATION-2.2): natively, the option before it, or after startup for Antigravity. */
const NATIVE: { readonly [cli: string]: string | undefined } = { claude: '--', codex: '--', muse: '--', pi: '--', opencode: '--prompt', agy: undefined };
/** The reader of each built-in's input (CLIS-2.1), as the diagnostics report names it. */
const INPUT: { readonly [cli: string]: string } = { claude: 'claude-frame', codex: 'codex-prompt', agy: 'agy-frame', muse: 'muse-frame', opencode: 'opencode-frame', pi: 'pi-frame' };

/**
 * A message block as a CLI is given it (COLLABORATION-2.1): its header and the whole text. The window's label is escaped
 * text there, its delimiters after a backslash - as in an SSH window's `app [SSH: host]`.
 */
function block(id: string, from: string, window: string, text: string): RegExp {
	const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const label = window.replace(/[\\|[\]#]/g, '\\$&');
	return new RegExp(String.raw`📨 Message from [^\n]*\(${escaped(from)}\) · ${escaped(id)}(?: · From ${escaped(label)})?\n${escaped(text)}$`);
}

/** The discovery and start steps for each implementation. The Framework address goes back into tool calls. */
const discover = (): Step => FRAMEWORK
	? { tool: 'list_agents', arguments: {} }
	: { tool: 'list_agents', arguments: {}, save: { window: 'data.windows.0.window_id', location: 'data.windows.0.locations.0.location_id' } };
const startChild = (name: string, prompt: string): Step => FRAMEWORK
	? { tool: 'start_agent', arguments: { name, cli: CLI, prompt }, save: { child: 'data.id' } }
	: { tool: 'start_agent', arguments: { name, window_id: '$window', location_id: '$location', cli: CLI, prompt }, save: { child: 'data.agent_id', childAlias: 'data.agent_id' } };
/** The alias the fake CLI uses for evidence about the child. */
const childOf = (started: { data: { id?: string; agent_id?: string } }): string => FRAMEWORK ? fakeAlias(started.data.id!) : started.data.agent_id!;

const EIGHT = [ 'start_agent', 'list_agents', 'stop_agent', 'send_message', 'read_messages', 'read_screen', 'type_text', 'press_keys'];

// A custom CLI starts exactly as configured and has no MCP injection; its launch is checked by journey.it.ts.
(!PEER && BUILT_IN_ADAPTERS.some(adapter => adapter.id === CLI) ? suite : suite.skip)(`Journey: ${CLI} uses its Facade tools in this window (J10, M02, M03, M07, M15, M17)`, () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	test('two helpers appear in their creator\'s workspace and reply through MCP', async function () {
		if (!FRAMEWORK) { this.skip(); }
		this.timeout(120_000);
		const { card, alias, address } = await personAgent();
		observeAcceptanceImplementation(this, card);
		assertTools(alias);
		const lines = linesOf(alias);
		const initialize = lines.find(line => line.step === 'initialize')?.answer?.result;
		assert.strictEqual(initialize?.serverInfo?.name, 'facade');
		assert.deepStrictEqual(lines.find(line => line.step === 'tools/list')?.answer?.result?.tools?.map(tool => tool.name), EIGHT);
		const terminalNames = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
			.filter(tab => tab.input instanceof vscode.TabInputTerminal).map(tab => unspun(tab.label));
		await until('the creator’s terminal tab', () => terminalNames().includes(card.name) || undefined);
		const helpers = [
			{ name: 'Reviewer', prompt: 'Review the README.', reply: 'I reviewed the README.' },
			{ name: 'Verifier', prompt: 'Verify the test setup.', reply: 'I verified the test setup.' }
		];
		const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
		const machine = card.runId.split('/')[0];
		const started = await script(alias, [
			...helpers.map(({ name, prompt }) => ({ tool: 'start_agent', arguments: { name, cli: CLI, folder, prompt } })),
			{ tool: 'list_agents', arguments: {} }
		]);
		const publicList = started.content('list_agents');
		assert.ok(publicList?.data.agents.some((agent: { id: string }) => agent.id === address), 'the actual relay reaches its own active Agent');
		const references = helpers.map((helper, index) => {
			const result = started.content('start_agent', index);
			assert.strictEqual(result?.status, 'success', JSON.stringify(result));
			assert.strictEqual(result.data.machine_id, machine);
			assert.strictEqual(normalizeDriveLetter(result.data.folder), normalizeDriveLetter(folder));
			const child = result.data.id as string;
			return { ...helper, address: child, alias: fakeAlias(child) };
		});
		assert.strictEqual(new Set(references.map(helper => helper.address)).size, references.length);
		for (const helper of references) {
			assert.strictEqual(publicList.data.agents.filter((agent: { name: string; id: string }) =>
				agent.name === helper.name && agent.id === helper.address).length, 1);
		}
		await until('both helper cards', async () => {
			const cards = (await state()).cards;
			return references.every(helper => cards.some(each => each.name === helper.name)) || undefined;
		});
		const openTabs = terminalNames();
		assert.ok(openTabs.includes(card.name), 'the creator’s terminal stays open');
		assert.ok(references.every(helper => !openTabs.includes(helper.name)), `helpers add cards without opening terminals: ${openTabs.join(', ')}`);
		for (const child of references) {
			const original = await until(`${child.name} to accept its first task`, () =>
				received(child.alias).find(text => text.endsWith(child.prompt)));
			assert.strictEqual(normalizeDriveLetter(argsOf(child.alias).cwd), normalizeDriveLetter(folder));
			const id = / · (m\d+)$/u.exec(original.split('\n')[0])?.[1];
			assert.ok(id && original.includes(address), original);
			const sent = await script(child.alias, [{ tool: 'send_message', arguments: { to: address, text: child.reply, reply_to: id } }]);
			const receipt = sent.content('send_message');
			await expectSent(receipt, alias, address);
			const returned = /^(m\d+)@([^@\s]+)$/u.exec(receipt.data.id);
			assert.ok(returned, JSON.stringify(receipt));
			const [, replyId, machine] = returned;
			assert.strictEqual(machine, address.split('@')[1], JSON.stringify(receipt));
			const reply = await until(`${child.name}'s reply at the parent terminal`, () =>
				received(alias).find(text => text.endsWith(child.reply)));
			assert.strictEqual(reply, `📨 Message from ${child.name} (${child.address}) · ${replyId} · Reply to ${id}\n${child.reply}`);
		}
		const [reviewer, verifier] = references;
		const typed = 'typed by its creator 中文 🚀';
		const ran = await script(alias, [
			{ tool: 'read_screen', arguments: { agent: reviewer.address }, until: reviewer.prompt },
			{ tool: 'read_screen', arguments: { agent: verifier.address }, until: verifier.prompt },
			{ tool: 'type_text', arguments: { agent: reviewer.address, text: typed, enter: false } },
			{ tool: 'read_screen', arguments: { agent: reviewer.address }, until: typed },
			{ tool: 'press_keys', arguments: { agent: reviewer.address, keys: ['Ctrl+U'] } },
			{ tool: 'read_screen', arguments: { agent: reviewer.address }, until: reviewer.prompt, untilAbsent: 'typed by its creator' }
		]);
		for (const [index, helper] of references.entries()) {
			const screen = ran.content('read_screen', index);
			assert.strictEqual(screen?.status, 'success', JSON.stringify(screen));
			assert.deepStrictEqual([screen.data.address, screen.data.agent_id], [helper.address, helper.address.split('@')[0]]);
			assert.ok(screen.data.text.includes(helper.prompt), 'the intended helper\'s prompt is returned inline');
		}
		assert.strictEqual(ran.content('type_text')?.status, 'success', JSON.stringify(ran.content('type_text')));
		assert.ok(ran.content('read_screen', 2)?.data.text.includes(typed), 'direct text is a draft in its box');
		assert.strictEqual(terminalInputOf(reviewer.alias).split(typed).length - 1, 1, 'the intended process received the exact Unicode text once');
		assert.ok(!terminalInputOf(verifier.alias).includes(typed), 'the second helper received none of the typed text');
		assert.ok(!received(reviewer.alias).some(text => text.includes(typed)), 'the typed text was never submitted');
		assert.strictEqual(ran.content('press_keys')?.status, 'success', JSON.stringify(ran.content('press_keys')));
		assert.ok(!JSON.stringify(ran.content('read_screen', 3)).includes('typed by its creator'), 'Ctrl+U cleared it');
		const stopped = await script(alias, references.map(child => ({ tool: 'stop_agent', arguments: { agent: child.address } })));
		references.forEach((_, index) => assert.strictEqual(stopped.content('stop_agent', index)?.status, 'success'));
		const input = terminalInputOf(alias);
		for (const helper of references) {
			assert.strictEqual(input.split(helper.reply).length - 1, 1, 'each reply was pasted once at the creator');
			assert.strictEqual(received(alias).filter(text => text.endsWith(helper.reply)).length, 1,
				'each matching reply was submitted once to the creator');
		}
		assert.ok(card.runId);
		await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId }).then(undefined, () => undefined);
	});

	// MCP-7.1, RULES-6.7
	test('cancels the original pending Framework MCP send on its relay without a paste or inbox entry', async function () {
		if (!FRAMEWORK || CLI !== 'claude') { this.skip(); }
		this.timeout(120_000);
		const sender = await personAgent();
		const agents = [sender];
		try {
			observeAcceptanceImplementation(this, sender.card);
			assertTools(sender.alias);
			const recipient = await personAgent();
			agents.push(recipient);
			assertTools(recipient.alias);
			const draft = 'Held Framework MCP draft';
			const pasted = await script(sender.alias, [
				{ tool: 'type_text', arguments: { agent: recipient.address, text: draft, enter: false } },
			]);
			assert.strictEqual(pasted.content('type_text')?.status, 'success');
			const inspect = async () => (await frameworkCall(process.env.FACADE_HOME!, 'agent.inspect', { target: recipient.address })).input;
			await until('the Framework to recognize the recipient draft', async () => (await inspect()).state === 'draft' || undefined, 10_000);
			const rawBytes = () => fs.readFileSync(`${RECORD}.bytes.${recipient.alias}`);
			const before = rawBytes();
			assert.ok(before.includes(draft), 'the recipient CLI received the controlled draft');
			assert.deepStrictEqual(received(recipient.alias), [], 'the draft has never been submitted');
			const send = (text: string) => ({ to: recipient.address, text, ...DELIVERY_WAIT });
			const cancelledText = 'This pending message must never be pasted';
			const call = (await script(sender.alias, [
				{ tool: 'send_message', arguments: send(cancelledText), cancelWhenPending: true },
			], 40_000)).recorded('send_message');
			assert.ok(call?.cancellation, 'the fake client observed the pending send and wrote its cancellation');
			const { requestId, messageNumber, relay } = call.cancellation;
			assert.match(relay, /^facade-mcp(?:\.exe)?$/u);
			assert.ok(Number.isSafeInteger(messageNumber) && messageNumber > 0, 'a persisted send was pending');
			assert.deepStrictEqual(call.answer, {
				jsonrpc: '2.0', id: requestId,
				error: { code: -32800, message: 'the client cancelled this call; nothing was sent' },
			});
			const inbox = async () => {
				const result = (await script(recipient.alias, [{ tool: 'read_messages', arguments: { last: 10 } }])).content('read_messages');
				assert.strictEqual(result?.status, 'success', JSON.stringify(result));
				return result.data.messages as { text: string }[];
			};
			assert.deepStrictEqual(await inbox(), [], 'the recipient inbox has no cancelled message');
			assert.deepStrictEqual(rawBytes(), before, 'no bytes reached the recipient during cancellation');
			assert.deepStrictEqual(received(recipient.alias), [], 'nothing was submitted during cancellation');
			assert.strictEqual((await inspect()).state, 'draft');

			const cleared = await script(sender.alias, [
				{ tool: 'press_keys', arguments: { agent: recipient.address, keys: ['Ctrl+U'] } },
				{ tool: 'read_screen', arguments: { agent: recipient.address }, untilAbsent: draft },
			]);
			assert.strictEqual(cleared.content('press_keys')?.status, 'success');
			const screen = cleared.content('read_screen');
			assert.strictEqual(screen?.status, 'success');
			assert.ok(!screen.data.text.includes(draft), 'the draft cleared');
			assert.deepStrictEqual(rawBytes(), Buffer.concat([before, Buffer.from([0x15])]), 'only the clear key reached the recipient');
			const followUp = 'One delivery after relay cancellation';
			const delivered = (await script(sender.alias, [{ tool: 'send_message', arguments: send(followUp) }])).content('send_message');
			await expectSent(delivered, recipient.alias, recipient.address);
			const submissions = await until('the follow-up submission', () => {
				const texts = received(recipient.alias);
				return texts.length ? texts : undefined;
			});
			assert.strictEqual(submissions.length, 1);
			assert.ok(submissions[0].includes(followUp));
			assert.ok(!rawBytes().includes(cancelledText), 'clearing the draft did not deliver the cancelled paste');
			assert.deepStrictEqual((await inbox()).map(message => message.text), [followUp]);
			console.log('Framework MCP cancellation ' + JSON.stringify({ relay, requestId, messageNumber, error: -32800,
				recipient: recipient.address, pastedBytes: 0, inboxEntries: 0, followUpSubmissions: 1 }));
		} finally {
			for (const { card } of agents.reverse()) {
				await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
			}
		}
	});

	test('its CLI gets the Facade server; it lists, starts a child with a first task, reads and types into it and stops it', async function () {
		this.timeout(120_000);
		if (FRAMEWORK) { this.skip(); }
		const { card, alias } = await personAgent();
		observeAcceptanceImplementation(this, card);
		assertTools(alias);
		const lines = linesOf(alias);
		const initialize = lines.find(line => line.step === 'initialize')?.answer?.result;
		assert.strictEqual(initialize?.serverInfo?.name, 'facade');
		assert.ok(initialize?.instructions?.includes(alias), 'the instructions name the agent');
		assert.ok(initialize?.instructions?.includes('Launch IDs: window_id='));
		assert.ok(initialize?.instructions?.includes('Facade history log ('));
		assert.deepStrictEqual(lines.find(line => line.step === 'tools/list')?.answer?.result?.tools?.map(tool => tool.name), EIGHT);

		const window = vscode.workspace.name!;
		const ran = await script(alias, [
			{ tool: 'list_agents', arguments: {}, save: { window: 'data.windows.0.window_id', location: 'data.windows.0.locations.0.location_id' } },
			{ tool: 'start_agent', arguments: { name: 'Reviewer', window_id: '$window', location_id: '$location', cli: CLI, prompt: 'Review the README.' }, save: { child: 'data.agent_id' } },
			{ tool: 'list_agents', arguments: { details: true } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Review the README.', wait: 30_000 },
			{ tool: 'type_text', arguments: { agent: '$child', text: 'typed by its creator' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'typed by its creator' },
			{ tool: 'press_keys', arguments: { agent: '$child', keys: ['Ctrl+U'] } },
			// Keys sent is not a redraw barrier: wait for the CLI to consume Ctrl+U and paint its now-empty input.
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Review the README.', untilAbsent: 'typed by its creator' }
		]);
		const options = ran.content('list_agents');
		assert.strictEqual(options?.status, 'success', JSON.stringify(options));
		assert.deepStrictEqual(options.data.windows.map((each: { label: string }) => each.label), [window]);
		assert.strictEqual(options.data.scope, 'all');
		const logFile = options.data.windows[0].history_log.path as string;
		const events = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
		for (const event of ['window_attached', 'locations_scanned', 'cli_scan']) { assert.ok(events().some(each => each.event === event), event); }

		const started = ran.content('start_agent');
		assert.strictEqual(started?.status, 'success', JSON.stringify(started));
		// These fixtures run directly, including the Node-backed Muse fixture on Windows. The adapter's unknown-batch-wrapper
		// fallback is checked separately; it must not change what this direct launch can carry as a native prompt.
		const native = NATIVE[CLI];
		assert.deepStrictEqual([started.data.prompt.path, started.data.yolo, started.data.creator], [native ? 'native' : 'post_start', true, card.runId]);
		// A native argument alone does not verify acceptance. Post-start delivery may still be under way (MCP-2.3).
		if (native) {
			assert.deepStrictEqual([started.data.prompt.capability.state, started.data.prompt.status, started.data.prompt.effects.outcome], ['unverified', 'unknown', 'unknown']);
			assert.strictEqual(started.data.prompt.delivered_via, undefined);
		} else {
			assert.ok(['success', 'pending'].includes(started.data.prompt.status), JSON.stringify(started.data.prompt));
		}
		const child = started.data.agent_id as string;
		const childAlias = started.data.agent_id as string;
		for (const event of ['agent_start_requested', 'agent_started']) { assert.ok(events().some(each => each.event === event && each.alias === childAlias), event); }
		assert.ok(!fs.readFileSync(logFile, 'utf8').includes('Review the README.'), 'history excludes prompt bodies');
		// The prompt is the caller's message as any message goes: its header, the whole text and its footer (COLLABORATION-2.1)
		const prompt = new RegExp(`^${block(started.data.prompt.message_id, alias, window, 'Review the README.').source}$`);
		if (native) {
			const [option, given] = argsOf(childAlias).args.slice(-2);
			assert.strictEqual(option, native);
			assert.match(given, prompt, 'the prompt went in with the native argument');
		} else {
			// As its first message after startup - Antigravity's once its tools are ready: pasted and submitted
			await until('its first message', () => received(childAlias).some(each => prompt.test(each)) ? true : undefined, 30_000);
		}
		// The child's card opens in the background, says who started it, and the person's focus stays (LIFECYCLE-2.2, PANEL-1.5)
		const childCard = (await state()).cards.find(each => each.alias === child);
		assert.ok(childCard, 'the child has a card in this window');
		assert.ok(cardLines(childCard).includes(`Started by: ${card.name} ${alias}`), cardLines(childCard).join(' | '));
		const listed = ran.content('list_agents', 1)?.data.agents as { agent_id: string; creator?: string; root: string }[];
		assert.deepStrictEqual(listed.filter(each => each.agent_id === child).map(each => [each.creator, each.root]), [[card.runId, card.runId]], 'the child joins its creator\'s tree');

		const initialScreen = ran.content('read_screen');
		assert.strictEqual(initialScreen?.status, 'success', JSON.stringify(initialScreen));
		assert.deepStrictEqual([initialScreen.data.agent_id, initialScreen.data.text_format], [childCard.alias, 'facade-styled']);
		assert.ok(initialScreen.data.text.includes('Review the README.'), 'its screen is read, its first task on it');
		assert.deepStrictEqual([ran.content('type_text')?.status, ran.content('type_text')?.effects.text_written, ran.content('type_text')?.effects.enter_written], ['success', 'full', false]);
		assert.ok(JSON.stringify(ran.content('read_screen', 1)).includes('typed by its creator'), 'direct text is a draft in its box');
		assert.strictEqual(terminalInputOf(childAlias).split('typed by its creator').length - 1, 1, 'the selected process received the text once');
		assert.ok(!received(childAlias).some(text => text.includes('typed by its creator')), 'the typed text was never submitted');
		assert.deepStrictEqual([ran.content('press_keys')?.status, ran.content('press_keys')?.effects.keys_sent], ['success', 1], JSON.stringify(ran.content('press_keys')));
		assert.strictEqual(ran.content('read_screen', 2)?.status, 'success', JSON.stringify(ran.content('read_screen', 2)));
		assert.ok(JSON.stringify(ran.content('read_screen', 2)).includes('Review the README.'), 'the completed screen keeps its earlier output');
		assert.ok(!JSON.stringify(ran.content('read_screen', 2)).includes('typed by its creator'), 'Ctrl+U cleared it');

		// What the diagnostics report holds, with both agents running (ARCHITECTURE-3.3): the versions, each agent with what its
		// input reads and its last rows, and the log with each tool call, the home folder written ~
		const inputLine = (each: string) => new RegExp(`^- @\\S+ ${each} run-\\w+: .*\\n {2}running, .*; tools available; input reader ${INPUT[CLI]}, reads usable\\n {2}\\| `, 'm');
		let diagnostics = '';
		// The background terminal can still receive its first resize after the child prints its task. During that redraw
		// an unknown input is correct; judge the completed screen and tool connection, not an arbitrary startup instant.
		await until('both agents\' completed diagnostic screens', async () => {
			diagnostics = await vscode.commands.executeCommand<string>('facade.diagnostics');
			return [alias, childAlias].every(each => inputLine(each).test(diagnostics)) ? true : undefined;
		}, 10_000).catch(error => { throw new Error(`${String(error)}\n${diagnostics}`); });
		const version = vscode.extensions.getExtension('facade.facadecode')!.packageJSON.version as string;
		assert.ok(diagnostics.startsWith('Facade Code diagnostics, ') && diagnostics.includes(`\nFacade Code ${version}; window component ${version}; `), diagnostics.slice(0, 400));
		for (const each of [alias, childAlias]) {
			assert.match(diagnostics, inputLine(each), diagnostics);
		}
		for (const tool of ['start_agent', 'list_agents', 'read_screen', 'type_text', 'press_keys']) {
			assert.match(diagnostics, new RegExp(`^\\S+ Tool ${tool} by ${alias}: success in \\d+ ms; `, 'm'), `${tool} is logged`);
		}
		assert.ok(!diagnostics.includes(os.homedir()), 'the home folder is written ~');

		const stop = await script(alias, [{ tool: 'stop_agent', arguments: { agent: child } }, { tool: 'list_agents', arguments: {} }]);
		assert.strictEqual(stop.content('stop_agent')?.status, 'success', JSON.stringify(stop.content('stop_agent')));
		await until('the child card to go', async () => (await state()).cards.some(each => each.alias === child) ? undefined : true);
		assert.ok(!(stop.content('list_agents')?.data.agents as { agent_id: string }[]).some(each => each.agent_id === child), 'a stopped child is no longer listed');

		await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
	});

	test('the legacy supervisor serves editor terminal input and starts an MCP child in a linked worktree', async function () {
		if (FRAMEWORK || CLI !== 'claude') { this.skip(); }
		this.timeout(90_000);
		const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
		const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
		const original = git(folder, 'rev-parse', 'HEAD');
		const status = git(folder, 'status', '--porcelain');
		const branch = 'editor-acceptance';
		const checkout = path.join(`${folder}.worktrees`, branch);
		git(folder, 'worktree', 'add', '-b', branch, checkout, original);
		assert.strictEqual(git(checkout, 'rev-parse', 'HEAD'), original);
		assert.strictEqual(git(checkout, 'branch', '--show-current'), branch);
		assert.strictEqual(git(folder, 'branch', '--show-current'), 'main');
		assert.strictEqual(git(folder, 'status', '--porcelain'), status, 'worktree creation leaves the original checkout unchanged');
		const { card, alias } = await personAgent();
		let child: string | undefined;
		try {
			observeAcceptanceImplementation(this, card);
			assertTools(alias);
			const component = vscode.extensions.getExtension('facade.facadecode-window');
			assert.ok(component?.isActive, 'the local Window Component activates in the workspace');
			const session = vscode.env.sessionId;
			const identity: unknown = await vscode.commands.executeCommand(WINDOW_IDENTITY_COMMAND, session);
			assert.ok(isWindowIdentity(identity, session));
			assert.strictEqual(identity.component, component.packageJSON.version);
			assert.strictEqual(await vscode.commands.executeCommand(WINDOW_IDENTITY_COMMAND, `${session}-stale`), undefined);
			const windowId = `win-${createHash('sha256').update(`facade-window:${identity.token}`).digest('hex').slice(0, 16)}`;
			await until('the local Window Component publishes the creator under this session', async () => {
				const directory = await vscode.commands.executeCommand<Directory>(WINDOW_DIRECTORY_COMMAND, session);
				assert.strictEqual(directory.self, windowId);
				assert.strictEqual(directory.windows[0].window, windowId);
				return directory.windows[0].agents.some(agent => agent.alias === alias && agent.run === card.runId) || undefined;
			});
			const terminal = vscode.window.terminals.find(each => unspun(each.name) === card.name);
			assert.ok(terminal, 'the creator has its editor terminal');
			const text = 'worktree fixture input';
			terminal.sendText(text, false);
			await until('the legacy supervisor terminal input at the fake CLI', () => {
				const bytes = `${RECORD}.bytes.${alias}`;
				return fs.existsSync(bytes) && fs.readFileSync(bytes).includes(Buffer.from(text)) || undefined;
			});

			const { window, location } = await until('the linked worktree is available as an MCP location', async () => {
				const listing = (await script(alias, [{ tool: 'list_agents', arguments: {} }])).content('list_agents');
				assert.strictEqual(listing?.status, 'success');
				const window = listing.data.windows[0];
				const location = (window.locations as { path?: string; location_id: string }[]).find(each =>
					each.path && normalizeDriveLetter(each.path) === normalizeDriveLetter(checkout));
				return location ? { window, location } : undefined;
			}, 15_000);
			assert.deepStrictEqual(vscode.workspace.workspaceFolders!.map(each => each.uri.fsPath), [folder]);

			const prompt = 'Read this worktree';
			const ran = await script(alias, [
				{ tool: 'start_agent', arguments: { name: 'Worktree helper', cli: CLI, window_id: window.window_id, location_id: location.location_id, prompt }, save: { worktreeChild: 'data.agent_id' } },
				{ tool: 'read_screen', arguments: { agent: '$worktreeChild' }, until: prompt, wait: 30_000 }
			]);
			const started = ran.content('start_agent');
			assert.strictEqual(started?.status, 'success', JSON.stringify(started));
			child = started.data.agent_id as string;
			assert.match(child, /^#a\d+$/u);
			assert.strictEqual(started.data.creator, card.runId);
			assert.strictEqual(normalizeDriveLetter(fs.realpathSync(argsOf(child).cwd)), normalizeDriveLetter(fs.realpathSync(checkout)));
			const screen = ran.content('read_screen');
			assert.strictEqual(screen?.status, 'success', JSON.stringify(screen));
			assert.ok(JSON.stringify(screen).includes(prompt), 'the selected legacy supervisor child drew its prompt');
		} finally {
			if (child) { await closePublicAgent(child); }
			await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
		}
	});

	test('messages: one paste and Enter into the input box; a draft there is waited for, never typed over, and the send fails within its thirty seconds, nothing coming after; an input it cannot read fails the same; reading delivers it once', async function () {
		this.timeout(180_000);
		const { card, alias } = await personAgent();
		observeAcceptanceImplementation(this, card);
		const window = vscode.workspace.name!;
		const first = await script(alias, [
			discover(),
			startChild('Listener', 'Wait for my messages.'),
			// Its box is drawn, its first task shown - taken, or still going in
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Wait for my messages.', wait: 30_000 }
		]);
		const started = first.content('start_agent');
		assert.strictEqual(started?.status, 'success', JSON.stringify(started));
		const childAlias = childOf(started);
		// A first task that goes in after startup holds the agent's other messages until it went in (RULES-1.10): the start's one later
		// result, its outcome, says when an ordinary message can go in (RULES-1.4)
		if (!FRAMEWORK && started.data.prompt?.path === 'post_start') {
			await script(alias, [{ tool: 'read_messages', arguments: { all: true }, until: 'after startup', wait: 30_000 }]);
		}
		const greeting = 'Hello from your creator.\nTwo lines, one message.';
		const forbidden = 'Second message.';
		const drafting: Step[] = [
			{ tool: 'send_message', arguments: { to: '$child', text: greeting, ...DELIVERY_WAIT } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Two lines, one message.' },
			// A draft left in its box: the next message never goes over it, waiting for it within its thirty seconds (RULES-1.4, 1.5)
			{ tool: 'type_text', arguments: { agent: '$child', text: 'half-written' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'half-written' }
		];
		const askHuman: Step = { tool: 'send_message', arguments: { to: '#human', text: 'Please look at this.' } };

		if (FRAMEWORK) {
			const drafted = await script(alias, drafting);
			const delivered = drafted.content('send_message');
			await expectSent(delivered, childAlias, started.data.id);
			assert.strictEqual(delivered.data.delivery, 'typed_into_input', JSON.stringify(delivered));
			assert.ok(received(childAlias).some(each => each.includes(greeting)), `its box took the whole message: ${JSON.stringify(received(childAlias))}`);
			assert.ok(JSON.stringify(drafted.content('read_screen')).includes('Two lines, one message.'), 'its screen shows the message');
			const inspectInput = async () => (await frameworkCall(process.env.FACADE_HOME!, 'agent.inspect', { target: started.data.id })).input;
			const draft = await until('Framework to recognize the listener’s draft', async () => {
				const input = await inspectInput();
				return input.state === 'draft' ? input : undefined;
			}, 10_000);
			const rawBytes = () => fs.readFileSync(`${RECORD}.bytes.${childAlias}`);
			const before = rawBytes();
			assert.ok(before.includes('half-written'), 'the listener received the controlled draft');
			const submitted = received(childAlias);
			assert.ok(submitted.every(text => !text.includes('half-written')), 'the held draft has never been submitted');
			const sending = await script(alias, [
				{ tool: 'send_message', arguments: { to: '$child', text: forbidden, ...DELIVERY_WAIT }, timed: true },
				askHuman
			]);
			const held = sending.content('send_message');
			if (held?.status === 'failure' && held.reason === 'unavailable' && held.data?.unavailable?.execution === 'outcome_unknown') {
				console.error(`Framework MCP blocked send ${JSON.stringify({ elapsed_ms: sending.elapsedMs('send_message'), envelope: held })}`);
				try {
					const after = rawBytes();
					console.error(`Framework MCP blocked input ${JSON.stringify({
						before: { bytes_base64: before.toString('base64'), submissions: submitted },
						after: { bytes_base64: after.toString('base64'), submissions: received(childAlias) },
						bytes_equal: before.equals(after)
					})}`);
				} catch (error) { console.error(`Framework MCP blocked input diagnostics unavailable: ${error}`); }
				await frameworkAgentRecord(childAlias, started.data.id).catch(error => console.error(`Framework MCP blocked send diagnostics unavailable: ${error}`));
			}
			const human = sending.content('send_message', 1);
			assert.strictEqual(held?.status, 'failure', JSON.stringify(held));
			if (held.reason === 'timeout') {
				// The deadline can win before the typist reports the blocking state (RULES-1.5).
				const recipient = childAlias.slice(1);
				assert.strictEqual(held.message, `the deadline passed before ${recipient} took the message; nothing was typed; it was withdrawn from ${recipient}'s inbox, so it is safe to send it again later`);
			} else {
				assert.strictEqual(held.reason, 'input_draft', JSON.stringify(held));
			}
			assert.strictEqual(human?.status, 'failure', JSON.stringify(human));
			assert.strictEqual(human?.data?.window_delivery, undefined);
			assert.deepStrictEqual(rawBytes(), before, 'no terminal bytes reached the listener during the blocked send');
			assert.strictEqual((await inspectInput()).state, 'draft', 'Framework still sees the original draft');
			const cleared = await script(alias, [
				{ tool: 'press_keys', arguments: { agent: '$child', keys: ['Ctrl+U'] } },
				{ tool: 'read_screen', arguments: { agent: '$child' }, untilAbsent: 'half-written' }
			]);
			assert.strictEqual(cleared.content('press_keys')?.status, 'success');
			const screenAfterClear = cleared.content('read_screen');
			assert.strictEqual(screenAfterClear?.status, 'success', JSON.stringify(screenAfterClear));
			assert.ok(!screenAfterClear.data.text.includes('half-written'), 'the draft cleared');
			await new Promise(resolve => setTimeout(resolve, 8_000));
			assert.deepStrictEqual(rawBytes(), Buffer.concat([before, Buffer.from([0x15])]), 'only Ctrl+U reached the listener after the failed send');
			assert.deepStrictEqual(received(childAlias), submitted, 'clearing the draft did not submit any input');
			const inbox = (await script(childAlias, [{ tool: 'read_messages', arguments: { last: 10 } }])).content('read_messages');
			assert.strictEqual(inbox?.status, 'success', JSON.stringify(inbox));
			const texts = (inbox.data.messages as { text: string }[]).map(message => message.text);
			assert.ok(texts.includes(greeting), 'the listener’s history contains the delivered message');
			assert.ok(!texts.includes(forbidden), 'the withdrawn message is absent from the listener’s history');
			console.log(`      Framework ${CLI} draft: ${draft.state}, ${held.reason}, zero bytes while blocked, only Ctrl+U afterward, no submission or inbox entry`);
			// An input its reader cannot recognize: the send fails within its thirty seconds
			fs.writeFileSync(`${RECORD}.quirks.${childAlias}`, JSON.stringify({ garble: true }));
			const third = (await script(alias, [
				{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Still loading the workspace', wait: 10_000 },
				{ tool: 'send_message', arguments: { to: '$child', text: 'Third message.', ...DELIVERY_WAIT } }
			])).content('send_message');
			assert.deepStrictEqual([third?.status, third?.reason], ['failure', 'input_unknown'], JSON.stringify(third));
			fs.rmSync(`${RECORD}.quirks.${childAlias}`);
			const stopped = await script(alias, [{ tool: 'stop_agent', arguments: { agent: '$child' } }]);
			assert.strictEqual(stopped.content('stop_agent')?.status, 'success');
			await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
			return;
		}
		const sending = await script(alias, [
			...drafting,
			{ tool: 'send_message', arguments: { to: '$child', text: forbidden }, save: { second: 'data.message_id' } },
			askHuman
		]);
		const sent = sending.content('send_message');
		assert.strictEqual(sent?.status, 'success', JSON.stringify(sent));
		assert.deepStrictEqual([sent.effects.outcome, sent.effects.text_written, sent.effects.enter_written, sent.data.disposition], ['confirmed', 'full', true, 'submitted_to_cli']);
		const message = sent.data.message_id as string;
		assert.strictEqual(received(childAlias).filter(each => block(message, alias, window, 'Hello from your creator.\nTwo lines, one message.').test(each)).length, 1,
			`its box took the whole message once: ${JSON.stringify(received(childAlias))}`);
		assert.ok(JSON.stringify(sending.content('read_screen')).includes(message), 'its screen shows the message block');

		// Held by the draft through its thirty seconds: it fails with nothing typed, its outcome in its answer (RULES-1.2, 1.4, 1.5)
		const waiting = sending.content('send_message', 1);
		assert.strictEqual(waiting?.status, 'failure', JSON.stringify(waiting));
		assert.deepStrictEqual([waiting.error.reason, waiting.effects.outcome, waiting.effects.text_written], ['input_draft', 'none', 'none'], JSON.stringify(waiting));
		const second = waiting.data.message_id as string;

		const human = sending.content('send_message', 2);
		assert.strictEqual(human?.status, 'success', JSON.stringify(human));
		assert.deepStrictEqual([human.data.target, human.data.disposition], ['#human', 'notified']);

		assert.ok(!received(childAlias).some(each => each.includes('Second message.')), 'nothing went over the draft');
		// The draft goes: the failed message is never typed later, and nothing about it reaches its sender (RULES-1.2, 1.7)
		await script(alias, [{ tool: 'press_keys', arguments: { agent: '$child', keys: ['Ctrl+U'] } }]);
		await new Promise(resolve => setTimeout(resolve, 8_000));
		assert.ok(!received(childAlias).some(each => each.includes('Second message.')), 'a failed message is never typed later');
		assert.ok(received(childAlias).every(each => !each.includes('half-written')), 'the person\'s draft was never submitted');
		assert.ok(!received(alias).some(each => each.includes(`message ${second}`)), 'no receipt follows a send');

		// An input its reader cannot recognize: the send fails within its thirty seconds, and no receipt follows (RULES-1.5, 1.7)
		fs.writeFileSync(`${RECORD}.quirks.${childAlias}`, JSON.stringify({ garble: true }));
		const third = (await script(alias, [
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Still loading the workspace', wait: 10_000 },
			{ tool: 'send_message', arguments: { to: '$child', text: 'Third message.' } }
		])).content('send_message');
		assert.deepStrictEqual([third?.status, third?.error?.reason], ['failure', 'input_unknown'], JSON.stringify(third));
		await new Promise(resolve => setTimeout(resolve, 3_000));
		assert.ok(!received(alias).some(each => each.includes(`message ${third.data.message_id}`)), 'no receipt follows a send');
		fs.rmSync(`${RECORD}.quirks.${childAlias}`);

		// A native first prompt is also unconfirmed until this explicit handoff; it is never pasted again (MCP-2.3).
		const unconfirmedPrompt = started.data.prompt.status === 'unknown' ? started.data.prompt.message_id as string : undefined;
		const initialPastes = received(childAlias).filter(each => each.includes('Wait for my messages.')).length;
		// The second, held by the draft until its thirty seconds ended, failed as the third did: both are the recipient's to read
		const readIds = [...unconfirmedPrompt ? [unconfirmedPrompt] : [], second, third.data.message_id];
		// The recipient reads what is failed or unconfirmed: delivered by that read, and only once (COLLABORATION-3.1).
		const read = await script(childAlias, [
			{ tool: 'read_messages', arguments: {} },
			{ tool: 'read_messages', arguments: {}, until: '"messages":[]', wait: 5_000 },
			{ tool: 'read_messages', arguments: { ids: readIds } }
		]);
		const unread = read.content('read_messages')?.data.messages as { message_id: string; text: string; delivery: { status: string; reason?: string } }[];
		assert.deepStrictEqual(unread.map(each => [each.message_id, each.text, each.delivery.status, each.delivery.reason]), [
			...unconfirmedPrompt ? [[unconfirmedPrompt, 'Wait for my messages.', 'unknown', 'submission_unconfirmed']] : [],
			[second, 'Second message.', 'failure', 'input_draft'],
			[third.data.message_id, 'Third message.', 'failure', 'input_unknown']
		], JSON.stringify(unread));
		assert.deepStrictEqual(read.content('read_messages', 1)?.data.messages, [], JSON.stringify(read.content('read_messages', 1)));
		const again = read.content('read_messages', 2)?.data.messages as { message_id: string; delivery: { status: string; delivered_via?: string } }[];
		assert.deepStrictEqual(again.map(each => [each.message_id, each.delivery.status, each.delivery.delivered_via]), readIds.map(id => [id, 'success', 'read']));
		assert.strictEqual(received(childAlias).filter(each => each.includes('Wait for my messages.')).length, initialPastes, 'the inbox handoff starts no second prompt paste');

		await closePublicAgent(childOf(started));
		await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
	});

	test('a slow submission is pasted once and a missed Enter follows the implementation\'s delivery rule', async function () {
		this.timeout(120_000);
		const { card, alias } = await personAgent();
		observeAcceptanceImplementation(this, card);
		const first = await script(alias, [
			discover(),
			startChild('Slow', 'Wait for my messages.'),
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Wait for my messages.', wait: 30_000 }
		]);
		const started = first.content('start_agent');
		const childAlias = childOf(started);
		const quirks = `${RECORD}.quirks.${childAlias}`;
		const once = (text: string) => received(childAlias).filter(each => each.includes(text)).length;
		const transcript = `${RECORD}.stdin.${childAlias}`;
		const input = () => (fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8') : '').trim().split('\n').filter(Boolean)
			.map(line => (JSON.parse(line) as { data: string }).data).join('');
		for (const [quirk, text] of [[{ slowMs: 4_500 }, 'Taken slowly.'], [{ swallow: 1 }, 'Enter missed once.']] as const) {
			const before = input().length;
			fs.writeFileSync(quirks, JSON.stringify(quirk));
			const sent = (await script(alias, [{ tool: 'send_message', arguments: { to: '$child', text, ...DELIVERY_WAIT } }])).content('send_message');
			await expectSent(sent, childAlias, FRAMEWORK ? started.data.id : undefined);
			await new Promise(resolve => setTimeout(resolve, 5_000));
			const missed = FRAMEWORK && 'swallow' in quirk;
			assert.strictEqual(input().slice(before).split(text).length - 1, 1, 'the message was pasted once');
			assert.strictEqual(once(text), missed ? 0 : 1, JSON.stringify(received(childAlias)));
			if (missed) {
				assert.strictEqual(sent.data.delivery, 'typed_into_input', JSON.stringify(sent));
				assert.strictEqual(JSON.parse(fs.readFileSync(quirks, 'utf8')).swallow, 0, 'the CLI saw and ignored the written Enter');
			}
			fs.rmSync(quirks, { force: true });
		}
		if (FRAMEWORK) {
			const stopped = await script(alias, [{ tool: 'stop_agent', arguments: { agent: '$child' } }]);
			const receipt = stopped.content('stop_agent');
			if (receipt?.status !== 'success') {
				await frameworkAgentRecord(childAlias, started.data.id).catch(error => console.error(`Framework MCP stop diagnostics unavailable: ${error}`));
			}
			assert.strictEqual(receipt?.status, 'success', JSON.stringify(receipt));
		} else {
			await closePublicAgent(childAlias);
		}
		await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
	});
});

(CLI === 'claude' && PEER ? suite : suite.skip)('Journey: an agent works with an agent of another window on this computer (J15, M01, M03, COLLABORATION-1.1)', () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	test('the Orchestrator starts in the other workspace folder and shows the child in its creator\'s workspace', async function () {
		if (!FRAMEWORK) { this.skip(); }
		this.timeout(120_000);
		const { alias, card } = await personAgent();
		observeAcceptanceImplementation(this, card);
		const folder = PEER_DIR;
		assert.ok(folder && normalizeDriveLetter(folder) !== normalizeDriveLetter(vscode.workspace.workspaceFolders![0].uri.fsPath), 'the peer has a distinct folder');
		const ran = await script(alias, [
			{ tool: 'start_agent', arguments: { name: 'Other folder helper', folder, cli: 'claude', prompt: 'Help from afar.' }, save: { child: 'data.id' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Try a task' },
			{ tool: 'send_message', arguments: { to: '$child', text: 'Hello across windows.', ...DELIVERY_WAIT } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Hello across windows.' },
			{ tool: 'list_agents', arguments: {} }
		], 90_000);
		const started = ran.content('start_agent');
		assert.strictEqual(started?.status, 'success', JSON.stringify(started));
		assert.strictEqual(normalizeDriveLetter(started.data.folder), normalizeDriveLetter(folder));
		const child = started.data.id as string;
		assert.deepStrictEqual([ran.content('send_message')?.status, ran.content('send_message')?.data.delivery], ['success', 'typed_into_input'], JSON.stringify(ran.content('send_message')));
		assert.ok(JSON.stringify(ran.content('read_screen', 1)).includes('Hello across windows.'), 'its screen shows the message');
		const listed = ran.content('list_agents')?.data.agents as { id: string; name: string; folder: string }[];
		assert.deepStrictEqual(listed.filter(each => each.id === child).map(each => [each.name, normalizeDriveLetter(each.folder)]),
			[['Other folder helper', normalizeDriveLetter(folder)]]);
		const childId = fakeAlias(child).slice(1);
		await until('the creator workspace to show the child card', async () => (await state()).cards.find(each => each.alias === childId));
		assert.ok(!vscode.window.terminals.some(terminal => terminal.name === 'Other folder helper'), 'the child has no terminal view before Attach');
		const stopped = await script(alias, [{ tool: 'stop_agent', arguments: { agent: '$child' } }, { tool: 'list_agents', arguments: {} }]);
		assert.strictEqual(stopped.content('stop_agent')?.status, 'success');
		assert.ok(!(stopped.content('list_agents')?.data.agents as { id: string }[]).some(each => each.id === child), 'the stopped child leaves the active roster');
		await vscode.commands.executeCommand('facade.deleteAgent', { run_id: card.runId });
	});

	if (!FRAMEWORK && !PEER_ELSEWHERE) {
		test('the actual Window Component routes to the exact peer and refuses stale sessions and malformed calls', async function () {
			this.timeout(90_000);
			const { card, alias } = await personAgent();
			observeAcceptanceImplementation(this, card);
			let child: { run: string; pid: number } | undefined;
			try {
				const session = vscode.env.sessionId;
				const directory = await until('this component’s peer and exact local agent', async () => {
					const now = await vscode.commands.executeCommand<Directory>(WINDOW_DIRECTORY_COMMAND, session);
					return now?.windows.some(window => window.window === now.self && window.agents.some(agent => agent.run === card.runId)) &&
						now.windows.some(window => window.label === PEER) ? now : undefined;
				});
				const peer = directory.windows.find(window => window.label === PEER)!;
				const local = directory.windows.find(window => window.window === directory.self)!.agents.find(agent => agent.run === card.runId)!;
				const caller: GuestCaller = { id: local.run, alias: local.alias, name: local.name, root: local.root, yolo: false, window: directory.self };
				const response = (tool: string, args: unknown, id: string): RoutedCall =>
					({ protocol: TOOL_PROTOCOL, tool, arguments: args, caller, callId: id, elapsedMs: 0, inline: true });
				const route = async (op: string, args: unknown) => {
					const answer = await vscode.commands.executeCommand<RouteResponse>(WINDOW_ROUTE_COMMAND, session, { to: peer.window, op, args, deadlineMs: 30_000 });
					assert.ok(answer?.ok, JSON.stringify(answer));
					return answer.result;
				};
				const received = async <T>(tool: string, args: unknown, id: string): Promise<Result<T>> =>
					(await route('call', response(tool, args, id)) as { result: Result<T> }).result;
				const snapshot = await route('agents', { caller }) as {
					window: {
						window_id: string;
						folders: { path: string; uri: string }[];
						locations: { location_id: string; path: string; opened: boolean; folder_uris: string[] }[];
					};
				};
				assert.strictEqual(snapshot.window.window_id, peer.window);
				const expected = localFolderIdentity(PEER_DIR);
				assert.ok(expected, `the fixture peer folder exists: ${PEER_DIR}`);
				const source = vscode.workspace.workspaceFolders![0].uri;
				const sourceFolder = localFolderIdentity(source.fsPath);
				assert.ok(sourceFolder, `the fixture source folder exists: ${source.toString()}`);
				assert.notStrictEqual(sourceFolder, expected, 'the two workspaces have distinct folders');

				const folders = snapshot.window.folders.filter(each => localFolderIdentity(each.path) === expected);
				assert.strictEqual(folders.length, 1, `the receiving window opened the exact fixture folder: ${JSON.stringify({ expected: PEER_DIR, folders: snapshot.window.folders })}`);
				const folder = folders[0];
				const uri = vscode.Uri.parse(folder.uri, true);
				assert.deepStrictEqual([uri.scheme, uri.authority], [source.scheme, source.authority], 'the receiving workspace URI is on this host');
				assert.strictEqual(localFolderIdentity(uri.fsPath), expected, `the receiving workspace URI names the fixture folder: ${folder.uri}`);
				const locations = snapshot.window.locations.filter(each =>
					each.opened && each.folder_uris.includes(folder.uri) && localFolderIdentity(each.path) === expected);
				assert.strictEqual(locations.length, 1, `the receiving workspace supplies its own exact launch location: ${JSON.stringify({ folder, locations: snapshot.window.locations })}`);
				const location = locations[0];
				const launches = () => fs.readdirSync(path.dirname(RECORD))
					.filter(file => file.startsWith(path.basename(RECORD) + '.starts.')).sort();
				const original = new Set(launches());
				const startArgs = { name: 'Exact window route', cli: 'claude', window_id: peer.window, location_id: location.location_id };
				const request = { to: peer.window, op: 'call', args: response('start_agent', startArgs, 'stale-fixture-route'), deadlineMs: 30_000 };
				assert.strictEqual(await vscode.commands.executeCommand(WINDOW_ROUTE_COMMAND, session + '-stale', request), undefined);
				const { deadlineMs: _, ...malformed } = request;
				assert.strictEqual(await vscode.commands.executeCommand(WINDOW_ROUTE_COMMAND, session, malformed), undefined);
				await assert.rejects(Promise.resolve(vscode.commands.executeCommand(AGENTS_ROUTE_COMMAND, {
					op: 'call', args: response('stop_agent', { agent: local.run }, 'incomplete-fixture-route'), deadlineMs: 30_000
				})), /The routed request was incomplete/);
				const sourcePid = Number(fs.readFileSync(RECORD + '.' + alias, 'utf8').trim());
				assert.ok(alive(sourcePid));
				assert.deepStrictEqual(launches(), [...original], 'invalid requests start no agent');
				const started = await received<{ agent_id: string; alias: string; window_id: string; cwd: string; root: string; creator: string }>(
					'start_agent', startArgs, 'valid-fixture-route');
				assert.strictEqual(started.status, 'success', JSON.stringify(started));
				const facts = started.data;
				assert.match(facts.alias, /^#a\d+$/u);
				assert.notStrictEqual(facts.alias, alias);
				const launchLog = RECORD + '.starts.' + facts.alias;
				const pid = await until('the actual peer CLI to record its start', () => {
					if (!fs.existsSync(launchLog)) { return undefined; }
					const text = fs.readFileSync(launchLog, 'utf8').trim();
					return /^\d+$/u.test(text) ? Number(text) : undefined;
				});
				child = { run: facts.agent_id, pid };
				assert.deepStrictEqual([facts.window_id, facts.root, facts.creator], [peer.window, local.root, local.run]);
				assert.strictEqual(localFolderIdentity(facts.cwd), expected, `the routed start records the receiving folder: ${facts.cwd}`);
				const fakeCwd = argsOf(facts.alias).cwd;
				assert.strictEqual(localFolderIdentity(fakeCwd), expected, `the actual fake process runs in the receiving folder: ${fakeCwd}`);
				assert.ok(pid > 0 && alive(pid));
				assert.deepStrictEqual(launches().filter(name => !original.has(name)), [path.basename(RECORD) + '.starts.' + facts.alias]);
				assert.deepStrictEqual(fs.readFileSync(RECORD + '.starts.' + facts.alias, 'utf8').trim().split(/\r?\n/u).map(Number), [pid]);
				await until('the screen from the exact peer agent', async () => {
					const screen = await received<{ text: string; agent_id: string; window_id: string }>('read_screen', { agent: facts.agent_id }, 'read-fixture-route');
					assert.strictEqual(screen.status, 'success', JSON.stringify(screen));
					assert.deepStrictEqual([screen.data.agent_id, screen.data.window_id], [facts.agent_id, peer.window]);
					return screen.data.text.includes('Try a task') || undefined;
				});
				const blocked = await route('call', {
					...response('stop_agent', { agent: facts.agent_id }, 'blocked-fixture-route'), caller: { ...caller, root: 'run-' + '0'.repeat(32) }
				}) as { result: Result };
				assert.deepStrictEqual([blocked.result.status, blocked.result.error?.reason, blocked.result.effects.outcome], ['failure', 'out_of_tree', 'none']);
				assert.ok(alive(pid) && alive(sourcePid), 'an out-of-tree stop leaves both original processes');
				const stopped = await received('stop_agent', { agent: child.run }, 'stop-fixture-route');
				assert.strictEqual(stopped.status, 'success', JSON.stringify(stopped));
				await until('the exact peer process to stop', () => !alive(pid) || undefined);
				child = undefined;
				console.log('  Window route observation ' + JSON.stringify({
					source: { window: directory.self, run: local.run, pid: sourcePid },
					peer: { window: facts.window_id, run: facts.agent_id, cwd: facts.cwd, pid },
					folders: { fixture: PEER_DIR, workspace: folder.path, uri: folder.uri, location: location.path, process: fakeCwd },
					refused: ['stale-session', 'malformed-window-request', 'incomplete-workspace-request', 'out_of_tree']
				}));
			} finally {
				try {
					if (child && alive(child.pid)) {
						await script(alias, [{ tool: 'stop_agent', arguments: { agent: child.run } }]);
					}
				} finally {
					await vscode.commands.executeCommand('facade.stopAgent', { run_id: card.runId });
				}
			}
		});
	}

	test('it lists the other window, starts an agent there, messages it, reads its screen and stops it', async function () {
		this.timeout(120_000);
		if (FRAMEWORK) { this.skip(); }
		const { card, alias } = await personAgent();
		observeAcceptanceImplementation(this, card);
		const window = vscode.workspace.name!;
		// Listed and available: a window that is still starting is listed as unavailable
		const found = await script(alias, [{ tool: 'list_agents', arguments: {}, until: `"label":${JSON.stringify(PEER)},"environment"`, wait: 30_000 }]);
		const options = found.content('list_agents');
		const peer = (options?.data.windows as { window_id: string; label: string; environment: string; counts: { agents: number }; clis: { cli: string; available: boolean }[]; locations: { location_id: string; path: string }[] }[]).find(each => each.label === PEER);
		assert.ok(peer, `the other window is listed: ${JSON.stringify(options)}`);
		assert.strictEqual(peer.counts.agents, 0, 'an empty window remains a launch destination');
		assert.ok(peer.clis.some(each => each.cli === 'claude' && each.available), 'the destination supplies its own CLI availability');
		const location = peer.locations.find(each => each.path === PEER_DIR) ?? peer.locations[0];
		assert.ok(location, JSON.stringify(peer));
		if (process.env.FACADE_IT_EXPECT_TESTS) {
			assert.strictEqual(location.path, PEER_DIR, 'the exact local journey selects the advertised peer folder');
		}

		const ran = await script(alias, [
			{ tool: 'start_agent', arguments: { name: 'Remote helper', window_id: peer.window_id, location_id: location.location_id, cli: 'claude', prompt: 'Help from afar.' }, save: { child: 'data.agent_id' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Try a task' },
			{ tool: 'send_message', arguments: { to: '$child', text: 'Hello across windows.' } }
		], 90_000);
		const started = ran.content('start_agent');
		assert.strictEqual(started?.status, 'success', JSON.stringify(started));
		assert.strictEqual(started.data.window_id, peer.window_id, 'it started in the other window');
		// Submitted within its thirty seconds, the other window's time included, its outcome in its answer (RULES-1.2)
		const sent = ran.content('send_message');
		assert.strictEqual(sent?.status, 'success', JSON.stringify(sent));
		assert.strictEqual(sent.data.window_id, peer.window_id);
		assert.deepStrictEqual([sent.effects.text_written, sent.effects.enter_written], ['full', true]);
		const after = await script(alias, [
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Hello across windows.' },
			{ tool: 'list_agents', arguments: { details: true } },
			{ tool: 'stop_agent', arguments: { agent: '$child' } },
			{ tool: 'list_agents', arguments: {} }
		], 90_000);
		const child = childOf(started);
		const childAlias = childOf(started);
		assert.ok(!(await state()).cards.some(each => each.alias === child), 'its card is in its own window, not this one');
		const listed = after.content('list_agents')?.data.agents as { agent_id: string; window_id: string; cwd: string; environment: string }[];
		assert.deepStrictEqual(listed.filter(each => each.agent_id === child).map(each => [each.window_id, each.cwd, each.environment]), [[peer.window_id, location.path, peer.environment]],
			'its CLI runs in the other window\'s folder and environment');
		// Its first task and the message, each whole, on its screen as this window reads it
		const first = JSON.stringify(ran.content('read_screen'));
		assert.ok(first.includes('Help from afar.') && first.includes(started.data.prompt.message_id), first);

		const screen = JSON.stringify(after.content('read_screen'));
		assert.ok(screen.includes('Hello across windows.') && screen.includes(sent.data.message_id), screen);
		if (!PEER_ELSEWHERE) {
			const launch = argsOf(childAlias);
			assert.strictEqual(launch.cwd, location.path, 'its CLI runs in the other window\'s folder');
			const [dash, given] = launch.args.slice(-2);
			assert.strictEqual(dash, '--');
			assert.match(given, block(started.data.prompt.message_id, alias, window, 'Help from afar.'), 'its first task names its sender\'s window');
			assert.ok(received(childAlias).some(each => block(sent.data.message_id, alias, window, 'Hello across windows.').test(each)), JSON.stringify(received(childAlias)));
		}

		assert.strictEqual(after.content('stop_agent')?.status, 'success', JSON.stringify(after.content('stop_agent')));
		assert.ok(!(after.content('list_agents', 1)?.data.agents as { agent_id: string }[]).some(each => each.agent_id === child), 'a stopped agent is no longer listed');
		if (!PEER_ELSEWHERE) {
			const pid = Number(fs.readFileSync(`${RECORD}.${childAlias}`, 'utf8').trim());
			await until('its process to end', () => alive(pid) ? undefined : true);
		}
	});
});
