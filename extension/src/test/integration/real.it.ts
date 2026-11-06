/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Real agents of one built-in working together through Facade (VERIFICATION G3, J10, M23, M32, CLIS-2.2). It runs only where FACADE_IT_REAL
// names the CLI - `FACADE_IT_ONLY=real` - as each run signs in and uses an account's usage. YOLO is off - on where FACADE_IT_REAL_YOLO
// says so, for a CLI with no rule for one server's tools - and the agent the person starts uses Facade's tools with no approval, starts a second agent of the same CLI with a first task and messages it, and the second
// answers through Facade's tools. Every message is pasted whole into its recipient's input box and seen submitted (RULES-1.4,
// COLLABORATION-2.1). What the models did is checked too (ARCHITECTURE-3.3): each message sent once, one agent started, and no tool called
// over and over while an answer is awaited, as the tools' instructions ask - the answer comes as a paste.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MessageRecord } from '../../core/messagePorts';
import type { Card, PanelState } from '../../webview/protocol';
import { linesOf } from '../detailLines';
import { unspun } from '../../base/tabSpinner';

const REAL = process.env.FACADE_IT_REAL;
const YOLO = process.env.FACADE_IT_REAL_YOLO === 'on' ? 'on' : 'off';

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		assertLookBudget();
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
}

/** The messages this window keeps, as Facade recorded them. */
function messages(): MessageRecord[] {
	const dir = path.join(process.env.FACADE_HOME!, 'extension', 'messages');
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir).filter(file => file.endsWith('.json')).flatMap(file => {
		try {
			return [JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as MessageRecord];
		} catch {
			return [];
		}
	});
}

/** Each tool call of this window's agents, as its agents log has it (ARCHITECTURE-3.3): when, which tool, by which alias, how it ended. */
function toolCalls(): { readonly at: number; readonly tool: string; readonly by: string; readonly status: string }[] {
	const dir = path.join(process.env.FACADE_HOME!, 'extension', 'workspaces');
	const logs = fs.existsSync(dir) ? fs.readdirSync(dir).map(key => path.join(dir, key, 'agents.log')).filter(file => fs.existsSync(file)) : [];
	return logs.flatMap(file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
		const match = /^(\S+) Tool (\w+) by (\S+): (\w+)/.exec(line);
		return match ? [{ at: Date.parse(match[1]), tool: match[2], by: match[3], status: match[4] }] : [];
	}));
}

/** How often an agent may call a tool that only looks, in the whole journey: more is polling for what a paste brings (ARCHITECTURE-3.3). */
const LOOKS = { read_messages: 2, list_agents: 4, read_screen: 2 } as const;

/** Stop a real model's failed journey promptly instead of paying for minutes of repetitive queries. */
function assertLookBudget(): void {
	const calls = toolCalls();
	for (const by of new Set(calls.map(call => call.by))) {
		for (const [tool, most] of Object.entries(LOOKS)) {
			const count = calls.filter(call => call.by === by && call.tool === tool).length;
			assert.ok(count <= most, `${by} called ${tool} ${count} times (limit ${most}); automatic delivery needs no polling`);
		}
	}
}

const TASK_LEAD = 'This is a test of Facade Code. ';
const TASK = TASK_LEAD + 'Use only your facade MCP tools, and do exactly this:\n'
	+ '1) Call list_agents without arguments to get current windows, locations, available CLIs and agents.\n'
	+ `2) Call start_agent with name "Echo", cli "${REAL}", that window_id and location_id, and this prompt: "Use your Facade initialization context to send your creator one message: `
	+ 'CONTEXT followed by your creator address, your own Facade short ID, and your initial message ID, separated by single spaces. '
	+ 'Then, only when a message whose entire body is PING arrives, reply to its sender with send_message, the text exactly PONG. Do nothing else."\n'
	+ '3) End your turn. When Echo sends its CONTEXT message, call send_message to Echo\'s agent_id with the text PING exactly once.\n'
	+ '4) When a Facade message with PONG reaches you, answer DONE and nothing else.';

(REAL ? suite : suite.skip)(`Journey: real ${REAL ?? 'CLI'} agents work together through Facade (G3, J10, M23, M32, CLIS-2.2)`, () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined, 30_000);
	});

	test(`with YOLO ${YOLO}, an agent starts another with a first task and messages it, and the other answers it, each message pasted and submitted`, async function () {
		this.timeout(600_000);
		try {
			await journey();
		} catch (err) {
			// What each agent shows, for whoever looks into why
			const screens = await Promise.all((await state()).cards.map(async card => `${card.name}:\n${await vscode.commands.executeCommand<{ text: string[] }>('facade.screen', card.runId)
				.then(read => read.text.join('\n'), () => '(its screen could not be read)')}`));
			throw new Error(`${(err as Error).message}\n\n${screens.join('\n\n')}`);
		} finally {
			// The isolated test owns every card here. Failed models must not keep spending usage during the window grace period.
			const cards = await state().then(current => current.cards, () => []);
			await Promise.allSettled(cards.map(card => vscode.commands.executeCommand('facade.closeAgent', { run_id: card.runId })));
		}
	});

	async function journey(): Promise<void> {
		const before = new Set((await state()).cards.map(each => each.runId));
		void vscode.commands.executeCommand('facade.newAgent');
		const first: Card = await until('the person\'s agent', async () => {
			const card = (await state()).cards.find(each => !before.has(each.runId));
			if (!card) {
				await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			}
			return card;
		}, 60_000);
		const terminal = await until('its terminal', () => vscode.window.terminals.find(each => unspun(each.name).startsWith(first.name)), 30_000);
		if (REAL === 'pi') {
			// Pi mounts its editor before downloading managed fd/rg, but refuses Enter until startup finishes.
			// Its session MCP connection follows that setup. Do not mistake an editable composer for readiness.
			await until('Pi startup and its session tools', async () => {
				const lines = (await vscode.commands.executeCommand<string>('facade.diagnostics')).split('\n');
				const at = lines.findIndex(line => line.startsWith('- ') && line.includes(first.runId));
				return at >= 0 && lines[at + 1]?.includes('; tools available;') ? true : undefined;
			}, 60_000);
		}
		// A fixed startup sleep can send the first task into onboarding or before the composer exists.
		await until('the CLI input to be usable', async () => await vscode.commands.executeCommand('facade.messageInput', first.runId) === 'usable' ? true : undefined, 60_000);
		// Claude folds a long one-line paste into an attachment without a size. A visible lead and counted multi-line body
		// let the same production reader verify this test's own draft before the test presses Enter.
		const lead = REAL === 'claude' ? TASK_LEAD : undefined;
		if (lead) {
			terminal.sendText(lead, false);
			await until('the test task lead', async () => await vscode.commands.executeCommand('facade.messageInput', first.runId, lead) === 'own' ? true : undefined, 30_000);
		}
		// sendText is raw terminal input: newlines would submit separate turns in Pi. Only Claude needs the counted
		// multi-line attachment; the other clients receive this test's single-line task, as before.
		const taskText = lead ? TASK : TASK.replaceAll('\n', ' ');
		terminal.sendText(lead ? taskText.slice(lead.length) : taskText, false);
		await until('the first task to show as its own draft', async () => await vscode.commands.executeCommand('facade.messageInput', first.runId, taskText, lead) === 'own' ? true : undefined, 30_000);
		terminal.sendText('\r', false);

		const second: Card = await until('the agent it starts', async () => (await state()).cards.find(each => !before.has(each.runId) && each.runId !== first.runId), 240_000);
		assert.ok(linesOf(second).some(line => line.startsWith('Started by') && line.includes(first.name)), linesOf(second).join(' | '));

		const delivered = (from: string, to: string, text: string) => messages().find(each => each.kind === 'message' && each.from.run === from && each.to.run === to
			&& each.text === text && each.delivery.status === 'success' ? each : undefined);
		// Its first task went in with its launch; the message after it was pasted into its input and submitted
		const task = await until('its first task delivery', () => messages().find(each => each.kind === 'message' && each.from.run === first.runId && each.to.run === second.runId && each.text.includes('PONG')
			&& ['success', 'unknown', 'failure'].includes(each.delivery.status)), 90_000);
		assert.ok(task.delivery.status === 'success' || task.delivery.status === 'unknown', JSON.stringify(task));
		// Natively where its CLI takes a first prompt it can use; Antigravity's after its tools are ready (COLLABORATION-2.2)
		assert.strictEqual(task.initialPrompt?.path, REAL === 'agy' ? 'post_start' : 'native', JSON.stringify(task));
		assert.ok(task.delivery.via === (REAL === 'agy' ? 'terminal' : 'launch') || task.delivery.via === 'read', JSON.stringify(task));
		const firstAlias = linesOf(first).join(' ').match(/#a\d+/)![0];
		const secondAlias = linesOf(second).join(' ').match(/#a\d+/)![0];
		const expectedContext = `CONTEXT ${firstAlias} ${secondAlias} ${task.alias}`;
		// Observe the first task before sending the next one: a native CLI may steer an in-progress turn with later input.
		// Concurrent delivery has its own tests; this journey measures launch-context availability independently of that race.
		const context = await until('the creator, own identity and initial message from launch context', () => delivered(second.runId, first.runId, expectedContext), 240_000);
		assert.strictEqual(context.text, expectedContext);
		const ping = await until('PING to it', () => delivered(first.runId, second.runId, 'PING'), 240_000);
		assert.deepStrictEqual([ping.delivery.via, ping.delivery.effects.text_written, ping.delivery.effects.enter_written], ['terminal', 'full', true], JSON.stringify(ping));
		const pong = await until('its PONG back', () => delivered(second.runId, first.runId, 'PONG'), 240_000);
		assert.deepStrictEqual([pong.delivery.via, pong.delivery.effects.text_written, pong.delivery.effects.enter_written], ['terminal', 'full', true], JSON.stringify(pong));

		// What the models did (ARCHITECTURE-3.3): the first answers its PONG, and neither sends a message twice, starts another agent, or polls
		await new Promise(resolve => setTimeout(resolve, 30_000));
		const sent = (from: string) => messages().filter(each => each.kind === 'message' && each.from.run === from && each.id !== task.id).map(each => each.text);
		assert.deepStrictEqual(sent(first.runId), ['PING']);
		assert.deepStrictEqual([...sent(second.runId)].sort(), [expectedContext, 'PONG'].sort(), 'each sends its message once, with no notification reply loop');
		assert.strictEqual((await state()).cards.filter(each => !before.has(each.runId)).length, 2, 'one agent started by the first');
		const calls = toolCalls();
		for (const card of [first, second]) {
			const alias = linesOf(card)[0].split(' · ')[1];
			const own = calls.filter(each => each.by === alias);
			for (const [tool, most] of Object.entries(LOOKS)) {
				assert.ok(own.filter(each => each.tool === tool).length <= most, `${card.name} called ${tool} more than ${most} times: ${own.map(each => each.tool).join(', ')}`);
			}
			assert.ok(own.filter(each => each.tool === 'start_agent' && each.status !== 'failure').length <= 1, `${card.name} started more than one agent`);
		}
		console.log(`Native collaboration calls: ${JSON.stringify(calls.map(({ tool, by, status }) => ({ tool, by, status })))}`);
		if (process.env.FACADE_IT_REAL_DECISIONS === '1') { await decisionProbe(first, terminal); }

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: second.runId });
		await vscode.commands.executeCommand('facade.closeAgent', { run_id: first.runId });
	}
});

/** Real-model interpretation of hypothetical outcomes, not proof of actual network-fault recovery. No scenario action is executed. */
async function decisionProbe(parent: Card, terminal: vscode.Terminal): Promise<void> {
	const expected = { lost_keyed_send: 'repeat_original_request', expired_key: 'inspect_effects', partial_input: 'inspect_effects', accepted_start: 'await_result', delivery_receipt: 'delivery_only', incomplete_agents: 'unknown' };
	const before = toolCalls().length;
	const results: unknown[] = [];
	for (let trial = 1; trial <= 3; trial++) {
		await until('the parent input before the decision probe', async () => await vscode.commands.executeCommand('facade.messageInput', parent.runId) === 'usable' ? true : undefined, 30_000);
		const prefix = `FACADE_DECISIONS_${trial} `;
		const lead = REAL === 'claude' ? 'Facade decision check. ' : undefined;
		const task = (lead ?? '') + 'This is a synthetic Facade interpretation test. Do not perform any of the hypothetical actions. '
			+ 'Send exactly one send_message to #human: text begins with ' + JSON.stringify(prefix) + ' followed by a JSON object. '
			+ 'Choose each value from repeat_original_request, inspect_effects, await_result, delivery_only, task_complete, retry_new_request, unknown, absent. '
			+ '\nlost_keyed_send: a send in the original window lost its reply; effects unknown; original request_id was chosen 30 seconds ago; which option retrieves that exact operation without creating a new one? '
			+ '\nexpired_key: the same case but the original request_id is two hours old; how do you avoid repeating uncertain effects? '
			+ '\npartial_input: type_text returned partial input and uncertain Enter; what is the safe next step? '
			+ '\naccepted_start: startup is accepted with a reserved result_message_id; choose the option that needs no new start or polling. '
			+ '\ndelivery_receipt: a notice says a message has been passed on; what does that prove? '
			+ '\nincomplete_agents: list_agents has no target but complete:false and an unavailable window; is the target absent or unknown? '
			+ '\nUse exactly those six keys. End your turn after sending the test answer.';
		const input = lead ? task : task.replaceAll('\n', ' ');
		// A large raw sendText can be read as multiple native inputs. Use the production terminal-mode-aware paste,
		// through a command compiled out of the shipped extension, then verify the entire draft before Enter.
		const pasted = await vscode.commands.executeCommand<{ outcome: string }>('facade.testPaste', parent.runId, lead ? input.slice(lead.length) : input, lead);
		assert.strictEqual(pasted?.outcome, 'applied');
		await until('the complete decision probe draft', async () => await vscode.commands.executeCommand('facade.messageInput', parent.runId, input, lead) === 'own' ? true : undefined, 30_000);
		terminal.sendText('\r', false);
		const answer = await until('the model decision report', () => messages().find(record => record.from.run === parent.runId && record.to.run === '@human' && record.text.startsWith(prefix)), 90_000);
		const decisions: unknown = JSON.parse(answer.text.slice(prefix.length));
		results.push({ trial, decisions });
		console.log(`Model decision probe: ${JSON.stringify({ trial, decisions })}`);
		assert.deepStrictEqual(decisions, expected, 'the first wrong answer fails; no success-only resampling');
		await new Promise(resolve => setTimeout(resolve, 2_000));
	}
	const extra = toolCalls().slice(before);
	assert.ok(extra.every(call => call.tool === 'send_message'), 'hypothetical actions are never executed');
	assert.strictEqual(extra.length, 3, 'one report per trial, no polling or duplicate reports');
	console.log(`Model decision summary: ${JSON.stringify({ evidence: 'hypothetical outcomes; three sequential trials in the same native session, not independent fault-injection runs', results })}`);
}
