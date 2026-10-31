/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The integration suite's Claude Code, run as Node in an agent's terminal. It records its working directory and arguments, then
// waits as an agent does, drawing its input the way Claude Code draws its own - a full-width rule, its `❯` prompt row with a dim
// placeholder, another rule - so that Facade's `claude-frame` reader recognizes it (CLIS-2.1). Typed or pasted text is a draft;
// Enter submits it, clearing the box, printing what it got and appending it to `<record>.received.<agent>`; Ctrl+U clears it. A
// native prompt after `--` is taken as its first message. Given `--mcp-config`, it starts the Facade server that file names as
// Claude would (MCP-6.1) and runs each `<record>.mcp-script.<agent>` that appears, in turn, writing every answer to
// `<record>.mcp.<agent>` as a JSON line; `$name` strings take values earlier answers saved under that name, and `until` repeats a
// step until its answer holds a text.

import { spawn } from 'child_process';
import * as fs from 'fs';

const record = process.env.FACADE_IT_RECORD!;
const agent = process.env.FACADE_AGENT!;
const args = process.argv.slice(2);
fs.writeFileSync(`${record}.args.${agent}`, JSON.stringify({ cwd: process.cwd(), args }));
fs.writeFileSync(`${record}.${agent}`, `${process.pid}\n`);

// ---------------------------------------------------------------------------------------------------------------------------
// The screen: what it printed, and its input box at the bottom

const NBSP = ' ';
const PLACEHOLDER = 'Try a task';
const lines: string[] = ['fake agent ready'];
let draft = '';

const prompt = args.indexOf('--');
if (prompt >= 0 && args[prompt + 1] !== undefined) {
	lines.push(...args[prompt + 1].split('\n'));
}

/** Redraws the whole screen in one synchronized update, so that no reading ever sees half of it. */
function draw(): void {
	const width = Math.max(20, process.stdout.columns || 80);
	const height = Math.max(6, process.stdout.rows || 24);
	const body = lines.flatMap(line => line.match(new RegExp(`.{1,${width}}`, 'gu')) ?? ['']).slice(-(height - 3));
	const shown = draft.includes('\n') || [...draft].length > width - 3 ? `[Pasted text #1 +${draft.split('\n').length} lines]` : draft;
	const rule = '─'.repeat(width);
	const out = ['\x1b[?2026h', '\x1b[H\x1b[2J'];
	// What it printed sits right above its input, as a CLI's transcript does
	body.forEach((line, at) => out.push(`\x1b[${height - 3 - body.length + at + 1};1H${line}`));
	out.push(`\x1b[${height - 2};1H${rule}`);
	out.push(`\x1b[${height - 1};1H❯${NBSP}${shown ? shown : `\x1b[2m${PLACEHOLDER}\x1b[22m`}`);
	out.push(`\x1b[${height};1H${rule}`);
	out.push(`\x1b[${height - 1};${3 + [...shown].length}H`);
	out.push('\x1b[?2026l');
	process.stdout.write(out.join(''));
}

/** Enter: what the box held is taken, printed and recorded, and the box is empty again. */
function submit(): void {
	if (!draft) {
		return;
	}
	fs.appendFileSync(`${record}.received.${agent}`, `${JSON.stringify(draft)}\n`);
	lines.push(...draft.split('\n'));
	draft = '';
}

// What comes in: printable text and pastes go into the box; Enter, Ctrl+U, Backspace and Ctrl+C do what Claude Code's do
let pending = '';
let pasting = false;
function received(chunk: string): void {
	pending += chunk;
	for (;;) {
		if (pasting) {
			const end = pending.indexOf('\x1b[201~');
			if (end < 0) {
				// Keep what could be the start of the end marker for the next chunk
				const keep = Math.min(pending.length, 5);
				draft += pending.slice(0, pending.length - keep);
				pending = pending.slice(pending.length - keep);
				break;
			}
			draft += pending.slice(0, end).replace(/\r\n?/g, '\n');
			pending = pending.slice(end + 6);
			pasting = false;
			continue;
		}
		if (!pending) {
			break;
		}
		if (pending.startsWith('\x1b[200~')) {
			pasting = true;
			pending = pending.slice(6);
			continue;
		}
		if (pending.startsWith('\x1b')) {
			// An escape sequence: a key the box does not use; an unfinished one waits for the rest
			const sequence = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|[^[O])/.exec(pending);
			if (!sequence) {
				break;
			}
			pending = pending.slice(sequence[0].length);
			continue;
		}
		const char = String.fromCodePoint(pending.codePointAt(0)!);
		pending = pending.slice(char.length);
		if (char === '\r' || char === '\n') {
			submit();
		} else if (char === '\x15') {
			draft = '';
		} else if (char === '\x7f' || char === '\b') {
			draft = [...draft].slice(0, -1).join('');
		} else if (char === '\x03') {
			process.stdin.setRawMode?.(false);
			process.kill(process.pid, 'SIGINT');
			return;
		} else if (char >= ' ') {
			draft += char;
		}
	}
	draw();
}

if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', received);
process.stdout.on('resize', draw);
// Bracketed paste on, as Claude Code turns it on: a paste comes whole, its line breaks no Enter
process.stdout.write('\x1b[?2004h');
draw();

// ---------------------------------------------------------------------------------------------------------------------------
// Its Facade tools: the server `--mcp-config` names, and each script that appears for this agent

interface Step {
	readonly tool: string;
	readonly arguments: { readonly [key: string]: unknown };
	/** Saves a value of this answer's structured content, by its dotted path, for later steps. */
	readonly save?: { readonly [name: string]: string };
	/** Repeats the call, a fifth of a second apart, until its answer contains this text, for at most `wait` milliseconds (10 s). */
	readonly until?: string;
	readonly wait?: number;
}

const config = args.indexOf('--mcp-config');
if (config >= 0) {
	void drive(JSON.parse(fs.readFileSync(args[config + 1], 'utf8')).mcpServers.facade);
}

async function drive(server: { command: string; args: string[]; env: { [name: string]: string } }): Promise<void> {
	const shim = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'ignore'] });
	const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
	let buffer = '';
	shim.stdout.setEncoding('utf8');
	shim.stdout.on('data', (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
			const message = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			waiting.get(message.id)?.(message);
		}
	});
	let id = 0;
	const request = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: unknown }>(resolve => {
		waiting.set(++id, resolve);
		shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
	});
	const out = (value: unknown) => fs.appendFileSync(`${record}.mcp.${agent}`, `${JSON.stringify(value)}\n`);
	out({ step: 'initialize', answer: await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } }) });
	shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	out({ step: 'tools/list', answer: await request('tools/list', {}) });
	const saved: { [name: string]: unknown } = {};
	const filled = (value: unknown): unknown => typeof value === 'string' && value.startsWith('$') ? saved[value.slice(1)]
		: Array.isArray(value) ? value.map(filled) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, each]) => [key, filled(each)])) : value;
	const script = `${record}.mcp-script.${agent}`;
	for (let phase = 0; ; phase++) {
		// The next script, taken as it appears: renamed first, so that it runs once
		while (!fs.existsSync(script)) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		const taken = `${script}.${phase}`;
		fs.renameSync(script, taken);
		const steps = JSON.parse(fs.readFileSync(taken, 'utf8')) as Step[];
		for (const step of steps) {
			let answer = await request('tools/call', { name: step.tool, arguments: filled(step.arguments) });
			const end = Date.now() + (step.wait ?? 10_000);
			while (step.until && !JSON.stringify(answer).includes(step.until) && Date.now() < end) {
				await new Promise(resolve => setTimeout(resolve, 200));
				answer = await request('tools/call', { name: step.tool, arguments: filled(step.arguments) });
			}
			const structured = (answer.result as { structuredContent?: unknown } | undefined)?.structuredContent;
			for (const [name, at] of Object.entries(step.save ?? {})) {
				saved[name] = at.split('.').reduce<unknown>((value, key) => (value as { [key: string]: unknown } | undefined)?.[key], structured);
			}
			out({ step: step.tool, phase, answer });
		}
		out({ step: 'done', phase });
	}
}
