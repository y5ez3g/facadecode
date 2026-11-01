/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BUILT_IN_ADAPTERS } from '../../clis/catalog';
import type { Card, PanelState } from '../../webview/protocol';

const RECORD = process.env.FACADE_IT_RECORD!;
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
}

/** The fake CLI's record of its tool calls: every answer, as a JSON line. */
function linesOf(alias: string): Line[] {
	const file = `${RECORD}.mcp.${alias}`;
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Line) : [];
}

const phases = new Map<string, number>();

interface Step {
	readonly tool: string;
	readonly arguments: { readonly [key: string]: unknown };
	readonly save?: { readonly [name: string]: string };
	readonly until?: string;
	readonly wait?: number;
}

/** Has the agent `alias` run `steps` through its Facade tools, and answers what each step got, by the step's tool and its order. */
async function script(alias: string, steps: readonly Step[], ms = 90_000): Promise<{ readonly answer: (tool: string, nth?: number) => Answer['result']; readonly content: (tool: string, nth?: number) => any }> {
	const phase = phases.get(alias) ?? 0;
	phases.set(alias, phase + 1);
	fs.writeFileSync(`${RECORD}.mcp-script.${alias}`, JSON.stringify(steps));
	const lines = await until(`${alias} to finish its tool calls of phase ${phase}`, () => {
		const read = linesOf(alias).filter(line => line.phase === phase);
		return read.some(line => line.step === 'done') ? read : undefined;
	}, ms);
	const answer = (tool: string, nth = 0) => lines.filter(line => line.step === tool)[nth]?.answer?.result;
	return { answer, content: (tool: string, nth = 0) => answer(tool, nth)?.structuredContent };
}

/** The person's own agent of this suite: started from New Agent, its card the new one no agent started. */
async function personAgent(): Promise<{ readonly card: Card; readonly alias: string }> {
	const before = new Set((await state()).cards.map(each => each.runId));
	void vscode.commands.executeCommand('facade.newAgent');
	// The picker shows once its CLIs are found: accepted as soon as it is there, however long that takes
	const card = await until('a new card', async () => {
		const mine = (await state()).cards.find(each => !before.has(each.runId) && !each.tooltip.some(line => line.startsWith('Started by')));
		if (mine) {
			return mine;
		}
		await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
		return undefined;
	});
	const alias = card.tooltip.join(' ').match(/#a\d+/)![0];
	// Its server answered: the agent's Facade tools are there
	await until(`${alias}'s Facade server`, () => linesOf(alias).some(line => line.step === 'tools/list') ? true : undefined);
	return { card, alias };
}

/** The message blocks a fake agent's input box took, as it recorded them. */
function received(alias: string): string[] {
	const file = `${RECORD}.received.${alias}`;
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string) : [];
}

function argsOf(alias: string): { readonly cwd: string; readonly args: string[]; readonly env: { readonly [name: string]: string } } {
	return JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8'));
}

const after = (args: readonly string[], option: string) => args[args.indexOf(option) + 1];

/**
 * How the agent `alias` was given its Facade server and skill, as its CLI takes them (CLIS-2.2), and what keeps its tools from asking
 * with YOLO off (CLIS-1.3): checked by the files and arguments its launch had.
 */
function assertTools(alias: string): void {
	const { cwd, args, env } = argsOf(alias);
	const routes = (variables: { readonly [name: string]: string }) => ['FACADE_PTYD', 'FACADE_RUN'].every(name => typeof variables[name] === 'string' && variables[name] !== '');
	switch (CLI) {
		case 'claude': {
			const server = JSON.parse(fs.readFileSync(after(args, '--mcp-config'), 'utf8')).mcpServers.facade;
			assert.deepStrictEqual(Object.keys(server.env).sort(), ['ELECTRON_RUN_AS_NODE', 'FACADE_PTYD', 'FACADE_RUN']);
			assert.ok(fs.existsSync(path.join(after(args, '--plugin-dir'), 'skills', 'facade', 'SKILL.md')), 'its own skill plugin');
			assert.strictEqual(after(args, '--allowedTools'), 'mcp__facade', 'Facade\'s own tools never ask for approval (D90)');
			break;
		}
		case 'codex':
			assert.ok(args.includes('mcp_servers.facade.default_tools_approval_mode="approve"'), args.join(' '));
			assert.ok(args.some(arg => arg.startsWith('mcp_servers.facade.env=') && arg.includes('FACADE_RUN')), args.join(' '));
			assert.ok(fs.existsSync(path.join(cwd, '.agents', 'skills', 'facade', 'SKILL.md')), 'the skill in its folder');
			break;
		case 'agy': {
			assert.ok(JSON.parse(after(args, '--settings')).permissions.allow.includes('mcp(facade_facade/*)'), args.join(' '));
			const plugin = path.join(cwd, '.agents', 'plugins', 'facade');
			assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(plugin, 'mcp_config.json'), 'utf8')).mcpServers.facade.env), ['ELECTRON_RUN_AS_NODE']);
			assert.ok(fs.existsSync(path.join(plugin, 'skills', 'facade', 'SKILL.md')) && routes(env), 'the plugin, and the run\'s variables in its environment');
			// Its MCP panel was opened before its first turn: that turn has the tools (COLLABORATION-2.2)
			assert.ok(fs.existsSync(`${RECORD}.panel.${alias}`), 'its MCP panel opened before its first turn');
			break;
		}
		case 'muse': {
			// For the run alone by -c; on Windows, where it goes through cmd.exe, in the folder's .mcp.json
			const entry = process.platform === 'win32'
				? JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers.facade
				: JSON.parse(args.find(arg => arg.startsWith('mcpServers.facade='))!.slice('mcpServers.facade='.length));
			assert.deepStrictEqual(entry.env.FACADE_RUN, process.platform === 'win32' ? '${FACADE_RUN:-}' : '${FACADE_RUN}');
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
			assert.ok(fs.existsSync(path.join(after(args, '--skill'), 'SKILL.md')), 'its own skill folder');
			break;
		default:
			assert.fail(`no check for ${CLI}`);
	}
}

/** How a creation prompt goes in for this CLI (COLLABORATION-2.2): natively, the option before it, or after startup for Antigravity. */
const NATIVE: { readonly [cli: string]: string | undefined } = { claude: '--', codex: '--', muse: '--', pi: '--', opencode: '--prompt', agy: undefined };
/** The reader of each built-in's input (CLIS-2.1), as Copy Diagnostics names it. */
const INPUT: { readonly [cli: string]: string } = { claude: 'claude-frame', codex: 'codex-prompt', agy: 'agy-frame', muse: 'muse-frame', opencode: 'opencode-frame', pi: 'pi-frame' };

/**
 * A message block as a CLI is given it (COLLABORATION-2.1): its header, the whole text, its footer. The window's label is escaped
 * text there, its delimiters after a backslash - as in an SSH window's `app [SSH: host]`.
 */
function block(id: string, from: string, window: string, text: string): RegExp {
	const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const label = window.replace(/[\\|[\]#]/g, '\\$&');
	return new RegExp(`\\[Facade message ${escaped(id)} \\| from @[^\\]|]* ${escaped(from)} \\| window ${escaped(label)}\\]\\n${escaped(text)}\\n\\[/Facade message ${escaped(id)}\\]`);
}

const NINE = ['list_start_options', 'start_agent', 'list_agents', 'stop_agent', 'send_message', 'read_messages', 'read_screen', 'type_text', 'press_keys'];

// A custom CLI starts exactly as configured and has no MCP injection; its launch is checked by journey.it.ts.
(!PEER && BUILT_IN_ADAPTERS.some(adapter => adapter.id === CLI) ? suite : suite.skip)(`Journey: ${CLI} uses its Facade tools in this window (J12, M02, M03, M07, M15, M17)`, () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	test('its CLI gets the Facade server; it lists, starts a child with a first task, reads and types into it and stops it', async function () {
		this.timeout(120_000);
		const { card, alias } = await personAgent();
		assertTools(alias);
		const lines = linesOf(alias);
		const initialize = lines.find(line => line.step === 'initialize')?.answer?.result;
		assert.strictEqual(initialize?.serverInfo?.name, 'facade');
		assert.ok(initialize?.instructions?.includes(alias), 'the instructions name the agent');
		assert.deepStrictEqual(lines.find(line => line.step === 'tools/list')?.answer?.result?.tools?.map(tool => tool.name), NINE);

		const window = vscode.workspace.name!;
		const ran = await script(alias, [
			{ tool: 'list_start_options', arguments: {}, save: { window: 'data.windows.0.window_id', location: 'data.windows.0.locations.0.location_id' } },
			{ tool: 'start_agent', arguments: { name: 'Reviewer', window_id: '$window', location_id: '$location', cli: CLI, prompt: 'Review the README.' }, save: { child: 'data.agent_id' } },
			{ tool: 'list_agents', arguments: {} },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Review the README.', wait: 30_000 },
			{ tool: 'type_text', arguments: { agent: '$child', text: 'typed by its creator' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'typed by its creator' },
			{ tool: 'press_keys', arguments: { agent: '$child', keys: ['Ctrl+U'] } },
			{ tool: 'read_screen', arguments: { agent: '$child' } }
		]);
		const options = ran.content('list_start_options');
		assert.strictEqual(options?.status, 'success', JSON.stringify(options));
		assert.strictEqual(options.data.windows[0].label, window);

		const started = ran.content('start_agent');
		assert.strictEqual(started?.status, 'success', JSON.stringify(started));
		// Muse Code goes through cmd.exe on Windows, which cannot be given a message block as an argument: it goes after startup there
		const native = CLI === 'muse' && process.platform === 'win32' ? undefined : NATIVE[CLI];
		assert.deepStrictEqual([started.data.prompt.path, started.data.yolo, started.data.creator], [native ? 'native' : 'post_start', true, card.runId]);
		// After startup it may still be on its way when the start answers - a CLI slow to draw its input - and is delivered then (MCP-2.3)
		assert.ok(native ? started.data.prompt.status === 'success' : ['success', 'pending'].includes(started.data.prompt.status), JSON.stringify(started.data.prompt));
		const child = started.data.agent_id as string;
		const childAlias = started.data.alias as string;
		// The prompt is the caller's message as any message goes: its header, the whole text and its footer (COLLABORATION-2.1)
		const prompt = new RegExp(`^${block(started.data.prompt.alias, alias, window, 'Review the README.').source}$`);
		if (native) {
			const [option, given] = argsOf(childAlias).args.slice(-2);
			assert.strictEqual(option, native);
			assert.match(given, prompt, 'the prompt went in with the native argument');
		} else {
			// As its first message after startup - Antigravity's once its tools are ready: pasted and submitted
			await until('its first message', () => received(childAlias).some(each => prompt.test(each)) ? true : undefined, 30_000);
		}
		// The child's card opens in the background, says who started it, and the person's focus stays (LIFECYCLE-2.2, PANEL-1.5)
		const childCard = (await state()).cards.find(each => each.runId === child);
		assert.ok(childCard, 'the child has a card in this window');
		assert.ok(childCard.tooltip.includes(`Started by ${card.name} ${alias}`), childCard.tooltip.join(' | '));
		const listed = ran.content('list_agents')?.data.agents as { agent_id: string; creator?: string; root: string }[];
		assert.deepStrictEqual(listed.filter(each => each.agent_id === child).map(each => [each.creator, each.root]), [[card.runId, card.runId]], 'the child joins its creator\'s tree');

		assert.ok(JSON.stringify(ran.content('read_screen')).includes('Review the README.'), 'its screen is read, its first task on it');
		assert.deepStrictEqual([ran.content('type_text')?.status, ran.content('type_text')?.effects.text_written, ran.content('type_text')?.effects.enter_written], ['success', 'full', false]);
		assert.ok(JSON.stringify(ran.content('read_screen', 1)).includes('typed by its creator'), 'direct text is a draft in its box');
		assert.deepStrictEqual([ran.content('press_keys')?.status, ran.content('press_keys')?.effects.keys_sent], ['success', 1], JSON.stringify(ran.content('press_keys')));
		assert.ok(!JSON.stringify(ran.content('read_screen', 2)).includes('typed by its creator'), 'Ctrl+U cleared it');

		// What Copy Diagnostics copies, with both agents running (ARCHITECTURE-3.3, D116, D117): the versions, each agent with what its
		// input reads and its last rows, and the log with each tool call, the home folder written ~
		const diagnostics = await vscode.commands.executeCommand<string>('facade.diagnostics');
		const version = vscode.extensions.getExtension('facade.facadecode')!.packageJSON.version as string;
		assert.ok(diagnostics.startsWith('Facade Code diagnostics, ') && diagnostics.includes(`\nFacade Code ${version}; window component ${version}; `), diagnostics.slice(0, 400));
		for (const each of [alias, childAlias]) {
			assert.match(diagnostics, new RegExp(`^- @\\S+ ${each} run-\\w+: .*\\n {2}running, .*; input reader ${INPUT[CLI]}, reads usable\\n {2}\\| `, 'm'), diagnostics);
		}
		for (const tool of ['list_start_options', 'start_agent', 'list_agents', 'read_screen', 'type_text', 'press_keys']) {
			assert.match(diagnostics, new RegExp(`^\\S+ Tool ${tool} by ${alias}: success in \\d+ ms$`, 'm'), `${tool} is logged`);
		}
		assert.ok(!diagnostics.includes(os.homedir()), 'the home folder is written ~');

		const stop = await script(alias, [{ tool: 'stop_agent', arguments: { agent: child } }, { tool: 'list_agents', arguments: {} }]);
		assert.strictEqual(stop.content('stop_agent')?.status, 'success', JSON.stringify(stop.content('stop_agent')));
		await until('the child card to go', async () => (await state()).cards.some(each => each.runId === child) ? undefined : true);
		assert.ok(!(stop.content('list_agents')?.data.agents as { agent_id: string }[]).some(each => each.agent_id === child), 'a stopped child is no longer listed');

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
	});

	test('messages: one paste and Enter into the input box; a draft there is waited for, never typed over; an input it cannot read fails back to its sender; reading delivers it once', async function () {
		this.timeout(180_000);
		const { card, alias } = await personAgent();
		const window = vscode.workspace.name!;
		const first = await script(alias, [
			{ tool: 'list_start_options', arguments: {}, save: { window: 'data.windows.0.window_id', location: 'data.windows.0.locations.0.location_id' } },
			{ tool: 'start_agent', arguments: { name: 'Listener', window_id: '$window', location_id: '$location', cli: CLI, prompt: 'Wait for my messages.' }, save: { child: 'data.agent_id', childAlias: 'data.alias' } },
			// Its box is drawn, its first task taken: an ordinary message can go in now (RULES-1.4)
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Wait for my messages.', wait: 30_000 },
			{ tool: 'send_message', arguments: { to: '$child', text: 'Hello from your creator.\nTwo lines, one message.' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Two lines, one message.' },
			// A draft left in its box: the next message never goes over it, and waits for it to go (RULES-1.4, 1.5)
			{ tool: 'type_text', arguments: { agent: '$child', text: 'half-written' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'half-written' },
			{ tool: 'send_message', arguments: { to: '$child', text: 'Second message.' }, save: { second: 'data.message_id' } },
			{ tool: 'send_message', arguments: { to: '#human', text: 'Please look at this.' } }
		]);
		const started = first.content('start_agent');
		assert.strictEqual(started?.status, 'success', JSON.stringify(started));
		const childAlias = started.data.alias as string;

		const sent = first.content('send_message');
		assert.strictEqual(sent?.status, 'success', JSON.stringify(sent));
		assert.deepStrictEqual([sent.effects.outcome, sent.effects.text_written, sent.effects.enter_written, sent.data.disposition], ['confirmed', 'full', true, 'submitted_to_cli']);
		const message = sent.data.alias as string;
		assert.ok(received(childAlias).some(each => block(message, alias, window, 'Hello from your creator.\nTwo lines, one message.').test(each)), `its box took the whole message: ${JSON.stringify(received(childAlias))}`);
		assert.ok(JSON.stringify(first.content('read_screen', 1)).includes(`[/Facade message ${message}]`), 'its screen shows the message block');

		const waiting = first.content('send_message', 1);
		assert.strictEqual(waiting?.status, 'accepted', JSON.stringify(waiting));
		assert.deepStrictEqual([waiting.data.obstacle, waiting.effects.outcome, waiting.effects.text_written], ['input_draft', 'pending', 'none']);
		// Held by the draft: its deadline ten minutes on, not fifteen seconds (D106)
		assert.ok(Date.parse(waiting.data.deadline) - Date.now() > 500_000, waiting.data.deadline);
		const second = waiting.data.alias as string;

		const human = first.content('send_message', 2);
		assert.strictEqual(human?.status, 'success', JSON.stringify(human));
		assert.deepStrictEqual([human.data.target, human.data.disposition], ['#human', 'notified']);

		// Past fifteen seconds it still waits: nothing typed over the draft, and no failure for its sender
		await new Promise(resolve => setTimeout(resolve, 18_000));
		assert.ok(!received(childAlias).some(each => each.includes('Second message.')), 'nothing went over the draft');
		assert.ok(!received(alias).some(each => each.includes(`about ${second}`)), 'its sender heard of no outcome yet');
		// The draft goes: the message goes in at the next slot, alone, and its sender hears it was submitted
		await script(alias, [{ tool: 'press_keys', arguments: { agent: '$child', keys: ['Ctrl+U'] } }]);
		await until('the waiting message in its box', () => received(childAlias).find(each => each.includes('Second message.')), 20_000);
		assert.ok(received(childAlias).every(each => !each.includes('half-written')), 'the person\'s draft was never submitted');
		const delivered = await until('the delivery result in the sender\'s box', () => received(alias).find(each => each.includes(`about ${second}`)), 20_000);
		assert.ok(delivered.includes('was submitted to its CLI') && delivered.includes('This is a Facade result, not a reply from the recipient.'), delivered);

		// An input its reader cannot recognize: after its fifteen seconds the sender hears it failed (RULES-1.5, 1.7)
		fs.writeFileSync(`${RECORD}.quirks.${childAlias}`, JSON.stringify({ garble: true }));
		const third = (await script(alias, [
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Still loading the workspace', wait: 10_000 },
			{ tool: 'send_message', arguments: { to: '$child', text: 'Third message.' } }
		])).content('send_message');
		assert.deepStrictEqual([third?.status, third?.data.obstacle], ['accepted', 'input_unknown'], JSON.stringify(third));
		const result = await until('the failure result in the sender\'s box', () => received(alias).find(each => each.includes(`about ${third.data.alias}`)), 40_000);
		assert.match(result, /^\[Facade result #m\d+ \| about #m\d+/);
		assert.ok(result.includes('was not delivered') && result.includes('(input_unknown)') && result.includes('This is a Facade result, not a reply from the recipient.'), result);
		fs.rmSync(`${RECORD}.quirks.${childAlias}`);

		// The recipient reads what never reached it: delivered by that read, and only once (COLLABORATION-3.1, D88)
		const read = await script(childAlias, [
			{ tool: 'read_messages', arguments: {} },
			{ tool: 'read_messages', arguments: {}, until: 'Nothing is waiting', wait: 5_000 },
			{ tool: 'read_messages', arguments: { ids: [third.data.message_id] } }
		]);
		const unread = read.content('read_messages')?.data.messages as { alias: string; text: string; delivery: { status: string; reason?: string } }[];
		assert.deepStrictEqual(unread.map(each => [each.alias, each.text, each.delivery.status, each.delivery.reason]), [[third.data.alias, 'Third message.', 'failure', 'input_unknown']], JSON.stringify(unread));
		assert.deepStrictEqual(read.content('read_messages', 1)?.data.messages, [], JSON.stringify(read.content('read_messages', 1)));
		const again = read.content('read_messages', 2)?.data.messages as { delivery: { status: string; delivered_via?: string } }[];
		assert.deepStrictEqual(again.map(each => [each.delivery.status, each.delivery.delivered_via]), [['success', 'read']]);

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: started.data.agent_id });
		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
	});

	test('a submission its CLI takes slowly, or whose Enter it misses, is pasted once: Enter again over its own draft, never the text (RULES-1.6, D104)', async function () {
		this.timeout(120_000);
		const { card, alias } = await personAgent();
		const first = await script(alias, [
			{ tool: 'list_start_options', arguments: {}, save: { window: 'data.windows.0.window_id', location: 'data.windows.0.locations.0.location_id' } },
			{ tool: 'start_agent', arguments: { name: 'Slow', window_id: '$window', location_id: '$location', cli: CLI, prompt: 'Wait for my messages.' }, save: { child: 'data.agent_id', childAlias: 'data.alias' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Wait for my messages.', wait: 30_000 }
		]);
		const started = first.content('start_agent');
		const childAlias = started.data.alias as string;
		const quirks = `${RECORD}.quirks.${childAlias}`;
		const once = (text: string) => received(childAlias).filter(each => each.includes(text)).length;
		for (const [quirk, text] of [[{ slowMs: 4_500 }, 'Taken slowly.'], [{ swallow: 1 }, 'Enter missed once.']] as const) {
			fs.writeFileSync(quirks, JSON.stringify(quirk));
			const sent = (await script(alias, [{ tool: 'send_message', arguments: { to: '$child', text } }])).content('send_message');
			assert.ok(sent?.status === 'accepted' || sent?.status === 'success', JSON.stringify(sent));
			await until(`${text} in its box`, () => once(text) ? true : undefined, 30_000);
			// The next slots see its own draft, or its empty box: never typed again
			await new Promise(resolve => setTimeout(resolve, 10_000));
			assert.strictEqual(once(text), 1, JSON.stringify(received(childAlias)));
			if (sent.status === 'accepted') {
				const result = await until(`the result about ${text}`, () => received(alias).find(each => each.includes(`about ${sent.data.alias}`)), 20_000);
				assert.ok(result.includes('was submitted to its CLI'), result);
			}
			fs.rmSync(quirks, { force: true });
		}
		await vscode.commands.executeCommand('facade.closeAgent', { run_id: started.data.agent_id });
		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
	});
});

(CLI === 'claude' && PEER ? suite : suite.skip)('Journey: an agent works with an agent of another window on this computer (J15, M01, M03, COLLABORATION-1.1)', () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	test('it lists the other window, starts an agent there, messages it, reads its screen and stops it', async function () {
		this.timeout(120_000);
		const { alias } = await personAgent();
		const window = vscode.workspace.name!;
		// Listed and available: a window that is still starting is listed as unavailable
		const found = await script(alias, [{ tool: 'list_start_options', arguments: {}, until: `"label":${JSON.stringify(PEER)},"environment"`, wait: 30_000 }]);
		const options = found.content('list_start_options');
		const peer = (options?.data.windows as { window_id: string; label: string; environment: string; locations: { location_id: string; path: string }[] }[]).find(each => each.label === PEER);
		assert.ok(peer, `the other window is listed: ${JSON.stringify(options)}`);
		const location = peer.locations.find(each => each.path === PEER_DIR) ?? peer.locations[0];
		assert.ok(location, JSON.stringify(peer));

		const ran = await script(alias, [
			{ tool: 'start_agent', arguments: { name: 'Remote helper', window_id: peer.window_id, location_id: location.location_id, cli: 'claude', prompt: 'Help from afar.' }, save: { child: 'data.agent_id' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Try a task' },
			{ tool: 'send_message', arguments: { to: '$child', text: 'Hello across windows.' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Hello across windows.' },
			{ tool: 'list_agents', arguments: {} },
			{ tool: 'stop_agent', arguments: { agent: '$child' } },
			{ tool: 'list_agents', arguments: {} }
		], 90_000);
		const started = ran.content('start_agent');
		assert.strictEqual(started?.status, 'success', JSON.stringify(started));
		assert.strictEqual(started.data.window_id, peer.window_id, 'it started in the other window');
		const child = started.data.agent_id as string;
		const childAlias = started.data.alias as string;
		assert.ok(!(await state()).cards.some(each => each.runId === child), 'its card is in its own window, not this one');
		const listed = ran.content('list_agents')?.data.agents as { agent_id: string; window_id: string; cwd: string; environment: string }[];
		assert.deepStrictEqual(listed.filter(each => each.agent_id === child).map(each => [each.window_id, each.cwd, each.environment]), [[peer.window_id, location.path, peer.environment]],
			'its CLI runs in the other window\'s folder and environment');
		// Its first task and the message, each whole, on its screen as this window reads it
		const first = JSON.stringify(ran.content('read_screen'));
		assert.ok(first.includes('Help from afar.') && first.includes(`[/Facade message ${started.data.prompt.alias}]`), first);

		const sent = ran.content('send_message');
		assert.strictEqual(sent?.status, 'success', JSON.stringify(sent));
		assert.deepStrictEqual([sent.effects.text_written, sent.effects.enter_written, sent.data.window_id], ['full', true, peer.window_id]);
		const screen = JSON.stringify(ran.content('read_screen', 1));
		assert.ok(screen.includes('Hello across windows.') && screen.includes(`[/Facade message ${sent.data.alias}]`), screen);
		if (!PEER_ELSEWHERE) {
			const launch = argsOf(childAlias);
			assert.strictEqual(launch.cwd, location.path, 'its CLI runs in the other window\'s folder');
			const [dash, given] = launch.args.slice(-2);
			assert.strictEqual(dash, '--');
			assert.match(given, block(started.data.prompt.alias, alias, window, 'Help from afar.'), 'its first task names its sender\'s window');
			assert.ok(received(childAlias).some(each => block(sent.data.alias, alias, window, 'Hello across windows.').test(each)), JSON.stringify(received(childAlias)));
		}

		assert.strictEqual(ran.content('stop_agent')?.status, 'success', JSON.stringify(ran.content('stop_agent')));
		assert.ok(!(ran.content('list_agents', 1)?.data.agents as { agent_id: string }[]).some(each => each.agent_id === child), 'a stopped agent is no longer listed');
		if (!PEER_ELSEWHERE) {
			const pid = Number(fs.readFileSync(`${RECORD}.${childAlias}`, 'utf8').trim());
			await until('its process to end', () => alive(pid) ? undefined : true);
		}
	});
});
