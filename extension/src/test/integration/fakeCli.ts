/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The integration suite's agent CLI, run as Node in an agent's terminal in place of each built-in. It records its working directory,
// its arguments and the variables of Facade's it was given, and takes part in the Program Status Protocol (OSC 7501) as the built-ins
// do: it asks whether its terminal takes reports and, once answered, reports that it is idle. It waits as an agent does, drawing its
// input the way the built-in FACADE_IT_AS names draws its own - Claude Code's by default - so that Facade's reader for that CLI
// recognizes it (CLIS-2.1). Typed or pasted text is a draft; Enter submits it, clearing the box, printing what it got and appending
// it to `<record>.received.<agent>`; Ctrl+U clears it. A native prompt after `--`, or OpenCode's `--prompt`, is taken as its first
// message. It finds the Facade server where that built-in finds it (CLIS-2.2), starts it as the CLI would - Antigravity's only once
// its MCP panel opens, by `/mcp`, or its first turn - and runs each `<record>.mcp-script.<agent>` that appears, in turn, writing
// every answer to `<record>.mcp.<agent>` as a JSON line; `$name` strings take values earlier answers saved under that name, and
// `until` repeats a step until its answer holds a text. With FACADE_IT_SCREEN=muse it is Muse Code as it runs on Windows: it
// reports nothing, and ptyd reads its status from its screen (CLIS-2.3, D80). `<record>.quirks.<agent>`, while there, has it take
// Enter as a slow or busy CLI does - missing so many Enters, or taking a submission only so long after its Enter - or draw a
// screen no reader recognizes (RULES-1.6).

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';

const ESC = '\x1b';
const ST = `${ESC}\\`;
/** How ptyd's answer to the question starts: `OSC 7501 ; ? : states=...`. */
const ANSWER = `${ESC}]7501;?:`;

const record = process.env.FACADE_IT_RECORD!;
const agent = process.env.FACADE_AGENT!;
const args = process.argv.slice(2);
// With the variables of Facade's that reach it: the run's own, and OpenCode's inline configuration
const facadeEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^FACADE_(RUN|PTYD|AGENT)$|^OPENCODE_CONFIG_CONTENT$/.test(name)));
fs.writeFileSync(`${record}.args.${agent}`, JSON.stringify({ cwd: process.cwd(), args, env: facadeEnv }));
fs.writeFileSync(`${record}.${agent}`, `${process.pid}\n`);
// Simulate the vendor's identity report explicitly; a launch argument alone no longer enables Pin.
const sessionFile = process.env.FACADE_CODE_SESSION_FILE;
if (sessionFile) {
	const args = process.argv.slice(2);
	const flag = args.findIndex(arg => ['--session-id', '--resume', '--conversation', '--session', 'resume'].includes(arg));
	const session = flag >= 0 ? args[flag + 1] : randomUUID();
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	const muse = path.join(sessionFile.replace(/\.json$/, '.d'), 'muse.json');
	if (fs.existsSync(muse)) {
		const { data } = JSON.parse(fs.readFileSync(muse, 'utf8')) as { data: string };
		const runtime = path.join(data, 'runtime', 'muse');
		fs.mkdirSync(path.join(runtime, 'sessions'), { recursive: true });
		const endpoint = `ms-it${process.pid}.sock`, generation = `pid=${process.pid}`;
		const native = { schema_version: 1, endpoint_hint: endpoint, process_generation_hint: generation };
		fs.writeFileSync(path.join(runtime, `${endpoint}.lease`), JSON.stringify({ ...native, pid: process.pid }));
		fs.writeFileSync(path.join(runtime, 'sessions', `${session}.json`), JSON.stringify({ ...native, session_id: session, target_eligibility: 'message_capable' }));
		const log = path.join(data, `${session}.jsonl`);
		fs.writeFileSync(log, '{}\n');
		const db = new DatabaseSync(path.join(data, 'session-index.db'));
		db.exec('CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, workspace_root TEXT, status TEXT, prompt_count INTEGER, session_log_path TEXT, first_user_prompt TEXT, updated_at_us INTEGER)');
		db.prepare("INSERT OR REPLACE INTO sessions VALUES (?, ?, 'valid', 1, ?, 'Resume integration fixture', ?)").run(session, process.cwd(), log, Date.now() * 1000);
		db.close();
	}
	fs.writeFileSync(sessionFile, JSON.stringify({ session_id: session, cwd: process.cwd(), source: 'startup' }));
}
process.stdout.write('fake agent ready\r\n');

// ---------------------------------------------------------------------------------------------------------------------------
// The screen: what it printed, and its input box at the bottom

const NBSP = ' ';
const PLACEHOLDER = 'Try a task';
const lines: string[] = ['fake agent ready'];
let draft = '';
/** Where the paste in its draft starts: what was typed before it stays as typed, as a lead does (D108). */
let pastedFrom: number | undefined;

// A native prompt: after `--`, or OpenCode's `--prompt`
const prompt = args.includes('--prompt') ? args.indexOf('--prompt') : args.indexOf('--');
if (prompt >= 0 && args[prompt + 1] !== undefined) {
	lines.push(...args[prompt + 1].split('\n'));
}

/** The built-in it stands in for, whose input it draws as that CLI does, for that CLI's reader (CLIS-2.1): Claude Code by default. */
const as = process.env.FACADE_IT_AS ?? (process.env.FACADE_IT_SCREEN === 'muse' ? 'muse' : 'claude');

/** A row of its input as it draws it: its text, with SGR sequences, and the column the cursor stands at where it is on that row. */
interface Row {
	readonly text: string;
	readonly cursor?: number;
}

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`;

/**
 * Its input as each built-in draws its own, `shown` its draft or nothing (CLIS-2.1): Claude Code's frame with a dim placeholder;
 * Codex's prompt above its footer; Antigravity's `>` frame with its hints under it; Muse Code's frame, its upper rule labeled, its
 * model line under it; Pi's editor between two rules with its own cursor drawn, its folder and figures under it; OpenCode's box with
 * its bar, its placeholder words, its agent row and its bottom.
 */
function inputRows(width: number, shown: string): Row[] {
	const rule = '─'.repeat(width);
	const length = [...shown].length;
	switch (as) {
		case 'codex':
			return [{ text: `› ${shown || dim(PLACEHOLDER)}`, cursor: 2 + length }, { text: '' }, { text: `  gpt-fake max · ${process.cwd()}` }, { text: '  ? for shortcuts' }];
		case 'agy':
			return [{ text: rule }, { text: shown ? `> ${shown}` : '>', cursor: 2 + length }, { text: rule }, { text: '? for shortcuts' }];
		case 'muse': {
			const label = '── Voice input (⌥ + v to start) ';
			return [{ text: `${label}${'─'.repeat(Math.max(2, width - [...label].length))}` }, { text: shown ? `❯ ${shown}` : '❯', cursor: 2 + length }, { text: rule }, { text: `  muse-spark-1.3 · minimal · ${process.cwd()}` }];
		}
		case 'pi':
			return [{ text: rule }, { text: `${shown}${inverse(' ')}`, cursor: length }, { text: rule }, { text: process.cwd() }, { text: '↑0 ↓0 0.0%/131k (auto)' }];
		case 'opencode':
			return [{ text: '  ┃' }, { text: `  ┃  ${shown || 'Ask anything… "Fix broken tests"'}`, cursor: 5 + length }, { text: '  ┃' }, { text: '  ┃  Build · qwen3.8-flash' }, { text: `  ╹${'▀'.repeat(Math.max(2, width - 3))}` }];
		default:
			return [{ text: rule }, { text: `❯${NBSP}${shown || dim(PLACEHOLDER)}`, cursor: 2 + length }, { text: rule }];
	}
}

/** How a test has it take Enter and draw, from `<record>.quirks.<agent>`: as a CLI does where there is none. */
interface Quirks {
	/** Enters it misses, the draft staying. */
	readonly swallow?: number;
	/** How long after Enter it takes a submission, the draft shown until then and other Enters missed meanwhile. */
	readonly slowMs?: number;
	/** A screen no input reader recognizes, in place of its input. */
	readonly garble?: boolean;
}
const QUIRKS = `${record}.quirks.${agent}`;
function quirks(): Quirks {
	try {
		return JSON.parse(fs.readFileSync(QUIRKS, 'utf8')) as Quirks;
	} catch {
		return {};
	}
}

/** Redraws the whole screen in one synchronized update, so that no reading ever sees half of it. */
function draw(): void {
	const width = Math.max(20, process.stdout.columns || 80);
	const height = Math.max(8, process.stdout.rows || 24);
	if (quirks().garble) {
		// Its input gone behind a screen of its own: the cursor at its top, nothing a reader knows
		process.stdout.write(`\x1b[?2026h\x1b[H\x1b[2J\x1b[1;1HStill loading the workspace...\x1b[1;1H\x1b[?2026l`);
		return;
	}
	if (!draft) {
		pastedFrom = undefined;
	}
	// Each CLI's placeholder for a long paste, counted as that CLI counts it (CLIS-2.1), after what was typed before the paste
	const typed = draft.slice(0, pastedFrom ?? 0);
	const pasted = draft.slice(pastedFrom ?? 0);
	const lineCount = pasted.split('\n').length;
	const collapsed = as === 'opencode' ? `[Pasted ~${lineCount} lines]`
		: as === 'pi' ? `[paste #1 +${lineCount} lines]`
			: as === 'codex' || as === 'muse' ? `[Pasted Content ${[...pasted].length} chars]`
				: as === 'agy' ? `[Pasted text #1 +${lineCount} lines]`
					: `[Pasted text #1 +${lineCount - 1} lines]`;
	const shown = pasted.includes('\n') || [...draft].length > width - 6 ? `${typed}${collapsed}` : draft;
	const input: Row[] = panel
		// Antigravity's MCP panel in place of its input: its server ready once it was started
		? [{ text: 'MCP Servers' }, { text: '>  ✓ facade_facade  Tools: list_agents', cursor: 0 }, { text: 'Keyboard: esc Exit' }]
		: inputRows(width, shown);
	const body = lines.flatMap(line => line.match(new RegExp(`.{1,${width}}`, 'gu')) ?? ['']).slice(-(height - input.length));
	const out = ['\x1b[?2026h', '\x1b[H\x1b[2J'];
	// What it printed sits right above its input, as a CLI's transcript does
	const top = height - input.length;
	body.forEach((line, at) => out.push(`\x1b[${top - body.length + at + 1};1H${line}`));
	input.forEach((row, at) => out.push(`\x1b[${top + at + 1};1H${row.text}`));
	const at = input.findIndex(row => row.cursor !== undefined);
	out.push(`\x1b[${top + at + 1};${input[at].cursor! + 1}H`);
	out.push('\x1b[?2026l');
	process.stdout.write(out.join(''));
}

/** Whether Antigravity's MCP panel is open in place of its input, opened by `/mcp` and closed by Escape. */
let panel = false;

/** Whether a slow submission is being taken now: Enter does nothing until it is. */
let taking = false;

/** Enter: what the box held is taken, printed and recorded, and the box is empty again. */
function submit(): void {
	if (!draft || taking) {
		return;
	}
	const quirk = quirks();
	if (quirk.swallow) {
		// A missed Enter: the draft stays
		fs.writeFileSync(QUIRKS, JSON.stringify({ ...quirk, swallow: quirk.swallow - 1 }));
		return;
	}
	if (quirk.slowMs) {
		// Taken only after a while, its draft shown until then
		taking = true;
		setTimeout(() => {
			taking = false;
			take();
			draw();
		}, quirk.slowMs);
		return;
	}
	take();
}

/** The box's draft taken: Antigravity's MCP panel opened by `/mcp`, else recorded and printed, the box empty again. */
function take(): void {
	if (startsServer) {
		startsServer();
		startsServer = undefined;
		if (draft === '/mcp') {
			fs.appendFileSync(`${record}.panel.${agent}`, 'opened\n');
			panel = true;
			draft = '';
			return;
		}
	} else if (antigravity && draft === '/mcp') {
		panel = true;
		draft = '';
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
			pastedFrom ??= draft.length;
			pending = pending.slice(6);
			continue;
		}
		if (pending.startsWith(`${ESC}]`)) {
			// An OSC sequence, ended by ST or BEL: ptyd's answer to its question is taken - it reports idle then - never typed
			const end = /\x1b\\|\x07/.exec(pending);
			if (!end) {
				break;
			}
			if (pending.startsWith(ANSWER)) {
				process.stdout.write(`${ESC}]7501;state=idle${ST}`);
			}
			pending = pending.slice(end.index + end[0].length);
			continue;
		}
		if (pending === '\x1b') {
			// Escape on its own, as a key is written: it closes Antigravity's MCP panel
			pending = '';
			panel = false;
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

/** Takes its input, draws its screen and asks whether its terminal takes reports. */
function start(): void {
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
	}
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', received);
	process.stdout.on('resize', draw);
	// What a test asks of its screen shows within a fifth of a second
	let quirked = '';
	setInterval(() => {
		const now = fs.existsSync(QUIRKS) ? fs.readFileSync(QUIRKS, 'utf8') : '';
		if (now !== quirked) {
			quirked = now;
			draw();
		}
	}, 200).unref();
	// Bracketed paste on, as Claude Code turns it on: a paste comes whole, its line breaks no Enter
	process.stdout.write('\x1b[?2004h');
	draw();
	// Muse Code as it runs on Windows takes no part in the Program Status Protocol: its screen is read instead (CLIS-2.3, D80)
	if (process.env.FACADE_IT_SCREEN !== 'muse') {
		process.stdout.write(`${ESC}]7501;?${ST}`);
	}
	void serverOf().then(server => {
		if (!server) {
			return;
		}
		if (antigravity) {
			// Antigravity starts a folder's plugin servers only with its first turn or its MCP panel
			startsServer = () => void drive(server);
		} else {
			void drive(server);
		}
	});
}

/** Whether it stands in for Antigravity, whose launch with the tools gives it its session's settings (CLIS-2.2). */
const antigravity = args.includes('--settings') && /"permissions"/.test(args[args.indexOf('--settings') + 1] ?? '');
/** Starts the server Antigravity was given, at its first turn or once its MCP panel opens; nothing until then. */
let startsServer: (() => void) | undefined;

type Server = { command: string; args: string[]; env: { [name: string]: string } };

/** A TOML basic string, array or inline table of strings, as Codex's per-launch overrides give them: as JSON values. */
function tomlValue(text: string): unknown {
	const pairs = [...text.matchAll(/("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")/g)];
	return text.trim().startsWith('{') ? Object.fromEntries(pairs.map(([, key, value]) => [JSON.parse(key), JSON.parse(value)])) : JSON.parse(text);
}

/**
 * The Facade server it was given, found where each built-in finds it (CLIS-2.2): Claude Code's `--mcp-config`, Codex's
 * `-c mcp_servers.facade.*`, Pi's `-e` extension, OpenCode's inline configuration, Antigravity's plugin in its folder, Muse Code's
 * entry in the folder's `.mcp.json` with its `${NAME:-}` references read from its environment. None where it was given none.
 */
async function serverOf(): Promise<Server | undefined> {
	const config = args.indexOf('--mcp-config');
	if (config >= 0) {
		return JSON.parse(fs.readFileSync(args[config + 1], 'utf8')).mcpServers.facade;
	}
	const codex = (key: string) => args.find(arg => arg.startsWith(`mcp_servers.facade.${key}=`))?.slice(`mcp_servers.facade.${key}=`.length);
	if (codex('command') !== undefined) {
		return { command: tomlValue(codex('command')!) as string, args: tomlValue(codex('args') ?? '[]') as string[], env: tomlValue(codex('env') ?? '{}') as { [name: string]: string } };
	}
	const extension = args.indexOf('-e');
	if (extension >= 0) {
		let registered: Server | undefined;
		const load = new Function('url', 'return import(url)') as (url: string) => Promise<{ default: (pi: unknown) => void }>;
		(await load(pathToFileURL(args[extension + 1]).href)).default({ registerMcpServer: (_name: string, server: Server) => registered = server });
		return registered;
	}
	const inline = process.env.OPENCODE_CONFIG_CONTENT;
	if (inline !== undefined) {
		const facade = JSON.parse(inline).mcp?.facade as { command: string[]; environment: { [name: string]: string } } | undefined;
		return facade && { command: facade.command[0], args: facade.command.slice(1), env: facade.environment };
	}
	const plugin = path.join('.agents', 'plugins', 'facade', 'mcp_config.json');
	if (antigravity && fs.existsSync(plugin)) {
		return JSON.parse(fs.readFileSync(plugin, 'utf8')).mcpServers.facade;
	}
	// Muse Code's entry: for the run alone by `-c`, or on Windows in the folder's `.mcp.json`; its references read from its environment
	const museArg = args.find(arg => arg.startsWith('mcpServers.facade='));
	const museFile = args.includes('--trust-workspace') && fs.existsSync('.mcp.json') ? JSON.parse(fs.readFileSync('.mcp.json', 'utf8')).mcpServers?.facade as Server | undefined : undefined;
	const entry = museArg !== undefined ? JSON.parse(museArg.slice('mcpServers.facade='.length)) as Server : museFile;
	if (entry) {
		const expanded = (value: string) => value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_all, name: string, empty?: string) => process.env[name] ?? empty ?? '');
		return { ...entry, env: Object.fromEntries(Object.entries(entry.env ?? {}).map(([name, value]) => [name, expanded(value)])) };
	}
	return undefined;
}

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

start();
