/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Records how a built-in CLI draws its input box as text is typed and pasted into it - never submitted, so its model is asked
// nothing - and checks Facade's input readers against each screen (CLIS-2.1, VERIFICATION G3): the state the reader reads, and
// whether a pasted message reads as its own draft, with its lead where its CLI takes one (RULES-1.6, D102). Run it once a CLI
// updates: a failed check is a reader or a placeholder to update, and the screens it saved are the new recorded cases.
//
//   npm run compile
//   node scripts/capture-inputs.mjs <claude|codex|agy|muse|opencode|pi> [--path <program>] [--home <temporary folder>] [--cwd <temporary folder>] [--out <folder>] [--rows <n>]
//
// `--rows` sets the terminal's height, 40 by default: an editor panel's terminal is often 20 to 30 rows, where an input box that
// grows with its text may scroll.
//
// Its home and working folder are temporary. `--home` can name a temporary home signed in for testing; FACADE_CAPTURE_ENV supplies
// explicit credentials or temporary configuration overrides. No personal CLI state is inherited. A trust or sign-in question is
// recorded as a blocked capture, never answered. Each case starts the CLI afresh and ends it after.

import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'build', 'out');
if (!fs.existsSync(path.join(out, 'ptyd', 'drafts.js'))) {
	console.error('Run `npm run compile` first.');
	process.exit(2);
}
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { inputScreenOf, readInput } = require(path.join(out, 'ptyd', 'composer.js'));
const { isOwnDraft } = require(path.join(out, 'ptyd', 'drafts.js'));
const { pasteSequence } = require(path.join(out, 'ptyd', 'keys.js'));
const { MESSAGE_LEAD } = require(path.join(out, 'core', 'messages.js'));
const { codexAdapter } = require(path.join(out, 'clis', 'codex.js'));
const { assertTemporaryState, probeEnvironment } = require(path.join(out, 'test', 'integration', 'probeState.js'));

/** Each built-in: its program, its input reader, what it is started with here, and whether it takes a message's lead. */
const CLIS = {
	claude: { command: 'claude', adapter: 'claude-frame', args: [], lead: true },
	codex: { command: 'codex', adapter: 'codex-prompt', args: ['-c', 'check_for_update_on_startup=false'] },
	agy: { command: 'agy', adapter: 'agy-frame', args: [] },
	muse: { command: 'muse', adapter: 'muse-frame', args: ['--trust-workspace'] },
	// Its own server process, as a run with Facade's tools has it (CLIS-2.2)
	opencode: { command: 'opencode', adapter: 'opencode-frame', args: ['--standalone'] },
	pi: { command: 'pi', adapter: 'pi-frame', args: ['--approve'] }
};

const message = (n, body) => `[Facade message #m${n} | from @probe #a0 | window Probe]\n${body}\n[/Facade message #m${n}]`;
const long = Array.from({ length: 100 }, (_, line) => `${String(line + 1).padStart(3, '0')} ${'abcdefghij'.repeat(7)}`).join('\n');

/** The cases: what goes into the input, typed or pasted, and what the reader is to read; a pasted one is to read as its own draft. */
const CASES = [
	{ name: 'empty', expect: 'usable' },
	{ name: 'typed', type: 'hello there', expect: 'draft' },
	{ name: 'pasted', paste: 'first pasted line\nsecond pasted line\nthird pasted line', expect: 'draft', own: true },
	{ name: 'message-pasted', paste: message(1, 'Reply with exactly the word ACK-TWO and nothing else.'), expect: 'draft', own: true },
	{ name: 'cjk-pasted', paste: message(2, '请检查 login 流程 🚀\nそして結果を報告してください。'), expect: 'draft', own: true },
	{ name: 'long-pasted', paste: message(3, long), expect: 'draft', own: true },
	// Taller than an input box a third of a small terminal high, under the line counts CLIs fold a paste from
	{ name: 'medium-pasted', paste: message(5, Array.from({ length: 7 }, (_, n) => `Step ${n + 1}: check the handler and its tests.`).join('\n')), expect: 'draft', own: true },
	// Few lines of many characters, over the counts some CLIs fold a paste from
	{ name: 'wide-pasted', paste: message(6, `${'Review the login flow and report what fails there. '.repeat(13)}\n${'Then fix it and say what changed. '.repeat(16)}`), expect: 'draft', own: true },
	{ name: 'lead-pasted', paste: message(4, 'Review the API.'), lead: true, expect: 'draft', own: true }
];

const args = process.argv.slice(2);
const cli = CLIS[args[0]];
if (!cli) {
	console.error(`Usage: node scripts/capture-inputs.mjs <${Object.keys(CLIS).join('|')}> [--path <program>] [--cwd <folder>] [--out <folder>]`);
	process.exit(2);
}
const option = name => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const program = option('--path') ?? cli.command;
const overrides = probeEnvironment(JSON.parse(process.env.FACADE_CAPTURE_ENV ?? '{}'), false);
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fcp-')));
const children = new Set();
process.once('exit', () => {
	for (const child of children) {
		try { child.kill(); } catch { /* already exited */ }
	}
	fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const probeHome = path.resolve(option('--home') ?? path.join(temporary, 'home'));
const cwd = path.resolve(option('--cwd') ?? path.join(temporary, 'workspace'));
assertTemporaryState(probeHome, '--home');
assertTemporaryState(cwd, '--cwd');
fs.mkdirSync(probeHome, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
const state = {
	HOME: probeHome, USERPROFILE: probeHome,
	CLAUDE_CONFIG_DIR: path.join(probeHome, '.claude'), CODEX_HOME: path.join(probeHome, '.codex'),
	XDG_CONFIG_HOME: path.join(probeHome, '.config'), XDG_DATA_HOME: path.join(probeHome, '.local', 'share'),
	XDG_CACHE_HOME: path.join(probeHome, '.cache'), XDG_STATE_HOME: path.join(probeHome, '.local', 'state'),
	...overrides
};
if (args[0] === 'codex') {
	// Trusted for this launch alone, as Facade's launches trust it (CLIS-3.3): its trust question would stand in for its input
	cli.args.push('-c', `projects={ ${codexAdapter.values({ cwd, platform: process.platform, yolo: false }).folderToml} = { trust_level = "trusted" } }`);
	if (args.includes('--embedded')) {
		cli.args.push('--no-daemon');
	}
}
const rows = Number(option('--rows') ?? 40);
if (!Number.isInteger(rows) || rows < 10) {
	console.error('--rows takes a whole number of rows, 10 or more.');
	process.exit(2);
}
const saved = path.resolve(option('--out') ?? path.join(root, 'build', 'captures', rows === 40 ? args[0] : `${args[0]}-${rows}`));
fs.mkdirSync(saved, { recursive: true });
const cols = 120;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The CLI started in a pseudo-terminal drawn by a headless one, answering what a terminal answers its program. */
function start() {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|CODEX_|GEMINI_|ANTIGRAVITY_|MUSE_|OPENCODE_|PI_|ANTHROPIC_|OPENAI_|QWEN_|FACADE_|MCP_|XDG_|HOME$|USERPROFILE$|ELECTRON_RUN_AS_NODE$|VSCODE_)/i.test(name)));
	const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
	term.loadAddon(new Unicode11Addon());
	term.unicode.activeVersion = '11';
	const child = pty.spawn(program, cli.args, { name: 'xterm-256color', cols, rows, cwd, env: { ...env, ...state, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'vscode' } });
	children.add(child);
	let exited;
	child.onData(data => {
		term.write(data);
		if (data.includes('\x1b[c')) {
			child.write('\x1b[?62;22c');
		}
		if (data.includes('\x1b[6n')) {
			child.write(`\x1b[${term.buffer.active.cursorY + 1};${term.buffer.active.cursorX + 1}R`);
		}
		for (const [, n, end] of data.matchAll(/\x1b\](1[01]);\?(\x07|\x1b\\)/g)) {
			child.write(`\x1b]${n};${n === '10' ? 'rgb:cccc/cccc/cccc' : 'rgb:1f1f/1f1f/1f1f'}${end}`);
		}
	});
	child.onExit(event => { exited = event; children.delete(child); });
	const flush = () => new Promise(resolve => term.write('', resolve));
	const reading = async () => {
		await flush();
		return readInput(inputScreenOf(term), cli.adapter);
	};
	return { term, child, reading, exited: () => exited, flush };
}

/** A screen as the recorded cases keep it: each row's characters, its trailing spaces cut, and its dim and inverse runs. */
function compact(name, expect, term) {
	const screen = inputScreenOf(term);
	const runs = (row, key) => {
		const found = [];
		row.forEach((cell, x) => {
			if (cell[key]) {
				const last = found[found.length - 1];
				if (last && last[1] === x) {
					last[1] = x + 1;
				} else {
					found.push([x, x + 1]);
				}
			}
		});
		return found;
	};
	return {
		name, expect, cols, cursor: screen.cursor, rows: screen.rows.map(row => {
			let end = row.length;
			while (end > 0 && row[end - 1].chars === ' ' && !row[end - 1].dim && !row[end - 1].inverse) {
				end--;
			}
			const cut = row.slice(0, end);
			const chars = cut.map(cell => cell.chars);
			const dim = runs(cut, 'dim');
			const inverse = runs(cut, 'inverse');
			return { cells: chars.every(char => [...char].length === 1) ? chars.join('') : chars, ...dim.length ? { dim } : {}, ...inverse.length ? { inverse } : {} };
		})
	};
}

const results = [];
for (const each of CASES) {
	if (each.lead && !cli.lead) {
		continue;
	}
	const run = start();
	let ready;
	for (const end = Date.now() + 60_000; Date.now() < end && !run.exited();) {
		ready = await run.reading();
		if (ready.state === 'usable' || ready.state === 'interaction') {
			break;
		}
		await sleep(250);
	}
	if (ready?.state !== 'usable') {
		// What it showed instead, saved to look at: a question of its own, a sign-in, an update
		const shown = run.term.buffer.active;
		const text = Array.from({ length: rows }, (_, y) => shown.getLine(shown.viewportY + y)?.translateToString(true) ?? '').join('\n');
		fs.writeFileSync(path.join(saved, `${each.name}.blocked.txt`), text);
		results.push({ name: each.name, ok: false, why: run.exited() ? `it exited (${JSON.stringify(run.exited())})` : `its input never read usable: ${ready?.state} (${ready?.evidence}); its screen is in ${each.name}.blocked.txt` });
		run.child.kill();
		continue;
	}
	// What a person would see settle before typing
	await sleep(800);
	const lead = each.lead ? MESSAGE_LEAD : undefined;
	if (each.type !== undefined) {
		for (const char of each.type) {
			run.child.write(char);
			await sleep(15);
		}
	}
	if (each.paste !== undefined) {
		run.child.write(`${lead ?? ''}${pasteSequence(true, each.paste)}`);
	}
	// As long as a paste of its size takes, and its CLI to draw it
	await sleep(1_500 + Math.ceil(Buffer.byteLength(each.paste ?? '') / 64));
	const read = await run.reading();
	const own = each.paste !== undefined && read.draft !== undefined && isOwnDraft(read.draft, each.paste, cli.adapter, lead, read.hidden);
	const ok = read.state === each.expect && (each.own === undefined || own === each.own);
	results.push({ name: each.name, ok, read: read.state, evidence: read.evidence, ...each.own ? { own } : {}, ...ok ? {} : { draft: read.draft } });
	// A paste's text kept with its screen, so that a test checks it reads as its own draft (RULES-1.6)
	fs.writeFileSync(path.join(saved, `${each.name}.json`), JSON.stringify({ ...compact(each.name, each.expect, run.term), ...each.paste !== undefined ? { paste: each.paste, ...lead ? { lead } : {} } : {} }));
	run.child.kill();
	await sleep(300);
}

let failed = 0;
for (const result of results) {
	failed += result.ok ? 0 : 1;
	console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}: ${result.why ?? `${result.read}${result.own !== undefined ? `, own ${result.own}` : ''} - ${result.evidence}`}${result.draft !== undefined ? `\n     drawn: ${JSON.stringify(result.draft).slice(0, 300)}` : ''}`);
}
console.log(`${results.length - failed} of ${results.length} as expected; the screens are in ${saved}`);
process.exit(failed ? 1 : 0);
