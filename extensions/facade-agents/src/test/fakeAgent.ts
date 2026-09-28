/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/*
 * An agent for tests: a real process that starts Facade's MCP server the way Claude Code or Codex
 * would, from the launch it was given, speaks MCP to it over stdio, and does what its script says.
 *
 *   FACADE_FAKE_MCP        the MCP server launch: { command, args, env }
 *   FACADE_FAKE_BEHAVIOR   { rounds: [{ write: { path: content } }], ask?: string }
 *
 * Each round writes its files and submits; the agent stops once Facade says verified or stop.
 */

interface Behavior {
	readonly rounds: readonly { readonly write: Readonly<Record<string, string>> }[];
	readonly ask?: string;
}

class McpClient {

	private nextId = 1;
	private buffer = '';
	private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

	constructor(private readonly child: ChildProcess) {
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => {
			this.buffer += chunk;
			let newline: number;
			while ((newline = this.buffer.indexOf('\n')) >= 0) {
				const message = JSON.parse(this.buffer.slice(0, newline));
				this.buffer = this.buffer.slice(newline + 1);
				if (typeof message.id === 'number') {
					this.pending.get(message.id)?.(message);
					this.pending.delete(message.id);
				}
			}
		});
	}

	request(method: string, params: object): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
			this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
		});
	}

	notify(method: string): void {
		this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
	}

	async call(name: string, args: object = {}): Promise<{ text: string; data?: { status?: string; criteria?: { id: string }[] } }> {
		const result = await this.request('tools/call', { name, arguments: args }) as { content: { text: string }[]; structuredContent?: object };
		return { text: result.content[0].text, data: result.structuredContent };
	}
}

async function main(): Promise<void> {
	const launch = JSON.parse(process.env.FACADE_FAKE_MCP!) as { command: string; args: string[]; env: Record<string, string> };
	const behavior = JSON.parse(process.env.FACADE_FAKE_BEHAVIOR ?? '{"rounds":[]}') as Behavior;
	const server = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'inherit'] });
	const mcp = new McpClient(server);
	await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } });
	mcp.notify('notifications/initialized');
	const tools = await mcp.request('tools/list', {}) as { tools: { name: string }[] };
	if (!tools.tools.some(tool => tool.name === 'submit_result')) {
		throw new Error(`No worker tools: ${JSON.stringify(tools)}`);
	}
	const contract = await mcp.call('get_contract');
	const criteria = (contract.data?.criteria ?? []).map(criterion => ({ id: criterion.id, status: 'met' }));
	await mcp.call('report_progress', { steps: [{ title: 'Do it', status: 'active' }] });
	if (behavior.ask) {
		let answer = await mcp.call('ask_lead', { question: behavior.ask, wait_sec: 60 });
		while (answer.data?.status === 'pending') {
			answer = await mcp.call('ask_lead', { question_id: (answer.data as { question_id?: string }).question_id, wait_sec: 60 });
		}
	}
	for (const round of behavior.rounds) {
		for (const [file, content] of Object.entries(round.write)) {
			fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
			fs.writeFileSync(file, content);
		}
		const verdict = await mcp.call('submit_result', { outcome: 'done', summary: 'Did the round.', criteria });
		if (verdict.data?.status !== 'changes_required') {
			break;
		}
	}
	server.stdin!.end();
	server.kill();
}

main().then(() => process.exit(0), err => {
	process.stderr.write(`fake agent: ${(err as Error).stack}\n`);
	process.exit(1);
});
