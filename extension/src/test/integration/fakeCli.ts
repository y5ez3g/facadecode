/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The integration suite's agent CLI, run as Node in an agent's terminal in place of each built-in. It records its working directory
// and arguments, takes part in the Program Status Protocol (OSC 7501) as the built-ins do - it asks whether its terminal takes
// reports and, once answered, reports that it is idle - then waits as an agent does. With FACADE_IT_SCREEN=muse it is Muse Code
// as it runs on Windows instead: it reports nothing and draws its input frame, which ptyd reads (CLIS-2.3, D80).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const ESC = '\x1b';
const ST = `${ESC}\\`;
/** How ptyd's answer to the question starts: `OSC 7501 ; ? : states=...`. */
const ANSWER = `${ESC}]7501;?:`;

const record = process.env.FACADE_IT_RECORD!;
const agent = process.env.FACADE_AGENT!;
fs.writeFileSync(`${record}.args.${agent}`, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
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

if (process.env.FACADE_IT_SCREEN === 'muse') {
	process.stdout.write(`\x1b[2J\x1b[H  Muse Code 1.4.14\r\n\r\n── Voice input (Alt+V to start) ${'─'.repeat(40)}\r\n❯\r\n${'─'.repeat(72)}\r\n  muse-spark-1.3 · minimal · ${process.cwd()} · Launch overrides\r\n`);
	setInterval(() => undefined, 60_000);
} else {
	answerReports();
}

/** Asks whether its terminal takes reports, and reports idle once it is answered. */
function answerReports(): void {
	let heard = '';
	process.stdin.setRawMode?.(true);
	process.stdin.on('data', chunk => {
		heard += chunk.toString('utf8');
		const answer = heard.indexOf(ANSWER);
		if (answer >= 0 && heard.indexOf(ST, answer) >= 0) {
			heard = '';
			process.stdout.write(`${ESC}]7501;state=idle${ST}`);
		} else if (heard.length > 4096) {
			heard = heard.slice(-ANSWER.length);
		}
	});
	process.stdout.write(`${ESC}]7501;?${ST}`);
	setInterval(() => undefined, 60_000);
}
