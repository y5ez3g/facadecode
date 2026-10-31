/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Real Claude Code agents working together through Facade (VERIFICATION G3, J12, M02, D84). It runs only where FACADE_IT_REAL asks
// for it - `FACADE_IT_ONLY=real` - as each run signs in and uses an account's usage. YOLO is off: the agent the person starts uses
// Facade's tools with no approval, starts a second Claude Code with a first task and messages it, and the second answers through
// Facade's tools. Every message is pasted whole into its recipient's input box and seen submitted (RULES-1.4, COLLABORATION-2.1).

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MessageRecord } from '../../core/messagePorts';
import type { Card, PanelState } from '../../webview/protocol';

const REAL = process.env.FACADE_IT_REAL;

async function state(): Promise<PanelState> {
	return await vscode.commands.executeCommand<PanelState>('facade.state');
}

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
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

const TASK = 'This is a test of Facade Code. Use only your facade MCP tools, and do exactly this: '
	+ '1) Call list_start_options without arguments, then with the window_id of the window you are in, to find its first location_id. '
	+ '2) Call start_agent with name "Echo", cli "claude", that window_id and location_id, and this prompt: "When a Facade message arrives, '
	+ 'reply to its sender with send_message, the text exactly PONG, and do nothing else." '
	+ '3) Call send_message to Echo\'s agent_id with the text PING. '
	+ '4) End your turn. When a Facade message with PONG reaches you, answer DONE and nothing else.';

(REAL === 'claude' ? suite : suite.skip)('Journey: real Claude Code agents work together through Facade (G3, J12, M02, D84)', () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('facade.facadecode')!.activate();
		await until('the panel state', async () => (await state())?.loading === false ? true : undefined, 30_000);
	});

	test('with YOLO off, an agent starts another with a first task and messages it, and the other answers it, each message pasted and submitted', async function () {
		this.timeout(600_000);
		const before = new Set((await state()).cards.map(each => each.runId));
		void vscode.commands.executeCommand('facade.newAgent');
		const first: Card = await until('the person\'s agent', async () => {
			const card = (await state()).cards.find(each => !before.has(each.runId));
			if (!card) {
				await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
			}
			return card;
		}, 60_000);
		const terminal = await until('its terminal', () => vscode.window.terminals.find(each => each.name.startsWith(first.name)), 30_000);
		// Typed as the person types: the task, then Enter on its own once Claude Code has taken the text
		await new Promise(resolve => setTimeout(resolve, 10_000));
		terminal.sendText(TASK, false);
		await new Promise(resolve => setTimeout(resolve, 2_000));
		terminal.sendText('\r', false);

		const second: Card = await until('the agent it starts', async () => (await state()).cards.find(each => !before.has(each.runId) && each.runId !== first.runId), 240_000);
		assert.ok(second.tooltip.some(line => line.startsWith('Started by') && line.includes(first.name)), second.tooltip.join(' | '));

		const delivered = (from: string, to: string, text: string) => messages().find(each => each.kind === 'message' && each.from.run === from && each.to.run === to
			&& each.text.includes(text) && each.delivery.status === 'success' ? each : undefined);
		// Its first task went in with its launch; the message after it was pasted into its input and submitted
		const task = await until('its first task', () => delivered(first.runId, second.runId, 'PONG'), 60_000);
		assert.strictEqual(task.delivery.via, 'launch', JSON.stringify(task));
		const ping = await until('PING to it', () => delivered(first.runId, second.runId, 'PING'), 240_000);
		assert.deepStrictEqual([ping.delivery.via, ping.delivery.effects.text_written, ping.delivery.effects.enter_written], ['terminal', 'full', true], JSON.stringify(ping));
		const pong = await until('its PONG back', () => delivered(second.runId, first.runId, 'PONG'), 240_000);
		assert.deepStrictEqual([pong.delivery.via, pong.delivery.effects.text_written, pong.delivery.effects.enter_written], ['terminal', 'full', true], JSON.stringify(pong));

		await vscode.commands.executeCommand('facade.closeAgent', { run_id: second.runId });
		await vscode.commands.executeCommand('facade.closeAgent', { run_id: first.runId });
	});
});
