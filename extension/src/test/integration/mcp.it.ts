/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
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
async function script(alias: string, steps: readonly Step[], ms = 45_000): Promise<{ readonly answer: (tool: string, nth?: number) => Answer['result']; readonly content: (tool: string, nth?: number) => any }> {
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

function argsOf(alias: string): { readonly cwd: string; readonly args: string[] } {
	return JSON.parse(fs.readFileSync(`${RECORD}.args.${alias}`, 'utf8'));
}

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

(CLI === 'claude' && !PEER ? suite : suite.skip)('Journey: an agent uses its Facade tools in this window (J12, M02, M03, M07, M15, M17)', () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined);
	});

	test('its CLI gets the Facade server; it lists, starts a child with a native prompt, reads and types into it and stops it', async () => {
		const { card, alias } = await personAgent();
		const launch = argsOf(alias);
		const config = launch.args[launch.args.indexOf('--mcp-config') + 1];
		assert.ok(fs.existsSync(config), 'its own --mcp-config file');
		const server = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers.facade;
		assert.deepStrictEqual(Object.keys(server.env).sort(), ['ELECTRON_RUN_AS_NODE', 'FACADE_PTYD', 'FACADE_RUN']);
		assert.ok(fs.existsSync(path.join(launch.args[launch.args.indexOf('--plugin-dir') + 1], 'skills', 'facade', 'SKILL.md')), 'its own skill plugin');
		assert.strictEqual(launch.args[launch.args.indexOf('--allowedTools') + 1], 'mcp__facade', 'Facade\'s own tools never ask for approval (D84)');
		const lines = linesOf(alias);
		const initialize = lines.find(line => line.step === 'initialize')?.answer?.result;
		assert.strictEqual(initialize?.serverInfo?.name, 'facade');
		assert.ok(initialize?.instructions?.includes(alias), 'the instructions name the agent');
		assert.deepStrictEqual(lines.find(line => line.step === 'tools/list')?.answer?.result?.tools?.map(tool => tool.name), NINE);

		const window = vscode.workspace.name!;
		const ran = await script(alias, [
			{ tool: 'list_start_options', arguments: {}, save: { window: 'data.windows.0.window_id', location: 'data.windows.0.locations.0.location_id' } },
			{ tool: 'start_agent', arguments: { name: 'Reviewer', window_id: '$window', location_id: '$location', cli: 'claude', prompt: 'Review the README.' }, save: { child: 'data.agent_id' } },
			{ tool: 'list_agents', arguments: {} },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Try a task' },
			{ tool: 'type_text', arguments: { agent: '$child', text: 'typed by its creator' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'typed by its creator' },
			{ tool: 'press_keys', arguments: { agent: '$child', keys: ['Ctrl+U'] } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Try a task' }
		]);
		const options = ran.content('list_start_options');
		assert.strictEqual(options?.status, 'success', JSON.stringify(options));
		assert.strictEqual(options.data.windows[0].label, window);

		const started = ran.content('start_agent');
		assert.strictEqual(started?.status, 'success', JSON.stringify(started));
		assert.deepStrictEqual([started.data.prompt.path, started.data.prompt.status, started.data.yolo, started.data.creator], ['native', 'success', true, card.runId]);
		const child = started.data.agent_id as string;
		const childAlias = started.data.alias as string;
		// The native argument is the caller's message as any message goes: its header, the whole text and its footer (COLLABORATION-2.1)
		const [dash, given] = argsOf(childAlias).args.slice(-2);
		assert.strictEqual(dash, '--');
		assert.match(given, new RegExp(`^${block(started.data.prompt.alias, alias, window, 'Review the README.').source}$`), 'the prompt went in with the native argument');
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

		const stop = await script(alias, [{ tool: 'stop_agent', arguments: { agent: child } }, { tool: 'list_agents', arguments: {} }]);
		assert.strictEqual(stop.content('stop_agent')?.status, 'success', JSON.stringify(stop.content('stop_agent')));
		await until('the child card to go', async () => (await state()).cards.some(each => each.runId === child) ? undefined : true);
		assert.ok(!(stop.content('list_agents')?.data.agents as { agent_id: string }[]).some(each => each.agent_id === child), 'a stopped child is no longer listed');

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId });
	});

	test('messages: one paste and Enter into the input box; a draft there makes it wait, then fail back to its sender; reading delivers it once', async function () {
		this.timeout(120_000);
		const { card, alias } = await personAgent();
		const window = vscode.workspace.name!;
		const first = await script(alias, [
			{ tool: 'list_start_options', arguments: {}, save: { window: 'data.windows.0.window_id', location: 'data.windows.0.locations.0.location_id' } },
			{ tool: 'start_agent', arguments: { name: 'Listener', window_id: '$window', location_id: '$location', cli: 'claude', prompt: 'Wait for my messages.' }, save: { child: 'data.agent_id', childAlias: 'data.alias' } },
			// Its box is drawn: an ordinary message can go in now (RULES-1.4)
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Try a task' },
			{ tool: 'send_message', arguments: { to: '$child', text: 'Hello from your creator.\nTwo lines, one message.' } },
			{ tool: 'read_screen', arguments: { agent: '$child' }, until: 'Two lines, one message.' },
			// A draft left in its box: the next message never goes over it (RULES-1.4)
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
		const second = waiting.data.alias as string;

		const human = first.content('send_message', 2);
		assert.strictEqual(human?.status, 'success', JSON.stringify(human));
		assert.deepStrictEqual([human.data.target, human.data.disposition], ['#human', 'notified']);

		// After its fifteen seconds, the sender hears it failed: a Facade result typed into the sender's own box (RULES-1.5, 1.7)
		const result = await until('the failure result in the sender\'s box', () => received(alias).find(each => each.includes(`about ${second}`)), 40_000);
		assert.match(result, /^\[Facade result #m\d+ \| about #m\d+/);
		assert.ok(result.includes('was not delivered') && result.includes('(input_draft)') && result.includes('This is a Facade result, not a reply from the recipient.'), result);
		assert.ok(!received(childAlias).some(each => each.includes('Second message.')), 'nothing went over the draft');

		// The recipient reads what never reached it: delivered by that read, and only once (COLLABORATION-3.1, D82)
		const read = await script(childAlias, [
			{ tool: 'read_messages', arguments: {} },
			{ tool: 'read_messages', arguments: {}, until: 'Nothing is waiting', wait: 5_000 },
			{ tool: 'read_messages', arguments: { ids: [second] } }
		]);
		const unread = read.content('read_messages')?.data.messages as { alias: string; text: string; delivery: { status: string; reason?: string } }[];
		assert.deepStrictEqual(unread.map(each => [each.alias, each.text, each.delivery.status, each.delivery.reason]), [[second, 'Second message.', 'failure', 'input_draft']], JSON.stringify(unread));
		assert.deepStrictEqual(read.content('read_messages', 1)?.data.messages, [], JSON.stringify(read.content('read_messages', 1)));
		const again = read.content('read_messages', 2)?.data.messages as { delivery: { status: string; delivered_via?: string } }[];
		assert.deepStrictEqual(again.map(each => [each.delivery.status, each.delivery.delivered_via]), [['success', 'read']]);

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
