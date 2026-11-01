/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Exact conversation identity (CLIS-2.4): only what is tied to a run by construction - a session ID Facade gives a new
// conversation at launch, the ID of the conversation a run resumes, and the report of a CLI hook that runs inside that very
// run. Never the newest file of a folder, a time window or a made-up ID: where none of these exists, the identity is unknown.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isJsonObject } from '../base/json';
import type { Environment } from './environment';

export interface SessionIntegrationInput {
	readonly file: string;
	readonly hook: string;
	readonly env: Environment;
	readonly platform: NodeJS.Platform;
	readonly cwd: string;
	readonly extra: readonly string[];
}

/** Per-process integration only. The host materializes owned files after validating the complete launch. */
export interface SessionIntegration {
	/** Native settings were unreadable: let the CLI show its own error, without claiming identity tracking. */
	readonly unavailable?: boolean;
	readonly args?: readonly string[];
	/** Config overrides merged into the integration replace only their original argument pair. */
	readonly extra?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly files?: readonly { readonly file: string; readonly content: string }[];
}

/** A conversation ID as the CLIs that take one write it: a UUID. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The variable naming the file a run's session hook records its conversation in: a run variable (CLIS-1.2). */
export const SESSION_FILE_VARIABLE = 'FACADE_CODE_SESSION_FILE';

/** A new conversation's ID, as Facade gives it to a CLI that takes one (`--session-id`). */
export function newSessionId(): string {
	return crypto.randomUUID();
}

/** The file run `run`'s session hook records its conversation in, in the execution environment's Facade directory. */
export function sessionFileOf(home: string, run: string): string {
	return path.join(home, 'runs', `${run}.session.json`);
}

/** A session file's name, or the name of the hook's copy being written in its place: its run, by its ID. */
const SESSION_FILE_NAME = /^(?<run>.+)\.session\.(?:json(?:\.\d+\.tmp)?|d)$/;

/** The session files in the Facade directory `home` - the hook's unfinished copies too - by the run they are of (RULES-5.3). */
export function sessionFilesIn(home: string): readonly { readonly run: string; readonly file: string }[] {
	const dir = path.dirname(sessionFileOf(home, 'run'));
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap(name => {
		const run = SESSION_FILE_NAME.exec(name)?.groups?.run;
		return run === undefined ? [] : [{ run, file: path.join(dir, name) }];
	});
}

/**
 * The hook's script, run as Node: data capture only (CLIS-2.4). It reads the hook input and, for a SessionStart of a conversation
 * with a UUID, writes its ID and how the session started to the file the run's {@link SESSION_FILE_VARIABLE} names - whole, by a
 * rename. Anything else - another event, input that is no JSON, no such variable - it leaves alone; it never fails the session.
 */
export const SESSION_HOOK_SCRIPT = [
	'const fs = require("fs"), path = require("path");',
	`const file = process.argv.at(-1)?.endsWith(".session.json") ? process.argv.at(-1) : process.env.${SESSION_FILE_VARIABLE};`,
	'const chunks = [];',
	'process.stdin.on("data", chunk => chunks.push(chunk));',
	'process.stdin.on("end", () => { const data = Buffer.concat(chunks); let input; try {',
	'if (!file || !path.isAbsolute(file) || !file.endsWith(".session.json")) return;',
	'input = JSON.parse(data.toString("utf8"));',
	'const status = input && input.product === "antigravity" && typeof input.conversation_id === "string";',
	'if (!input || (!status && !["SessionStart","UserPromptSubmit","Stop","SessionEnd"].includes(input.hook_event_name))) return;',
	'if (process.env.MUSE_THREAD_ID && process.env.MUSE_SESSION_ID && process.env.MUSE_THREAD_ID !== process.env.MUSE_SESSION_ID) return;',
	'let id = status ? input.conversation_id || null : input.session_id;',
	`if (id !== null && (typeof id !== "string" || !${SESSION_ID.toString()}.test(id))) return;`,
	'let previous; try { previous = JSON.parse(fs.readFileSync(file,"utf8")); } catch {}',
	'if (["Stop","SessionEnd"].includes(input.hook_event_name) && previous?.pending_session_id && previous.pending_session_id !== id) return;',
	'const pending = id;',
	'if (input.hook_event_name === "SessionEnd" || (!status && typeof input.transcript_path === "string" && input.transcript_path && !fs.existsSync(input.transcript_path))) id = null;',
	'fs.mkdirSync(path.dirname(file), { recursive: true });',
	'const temp = file + "." + process.pid + ".tmp";',
	'fs.writeFileSync(temp, JSON.stringify({ session_id: id, pending_session_id: pending, transcript_path: input.transcript_path, cwd: input.cwd, source: status ? "status" : input.source || input.hook_event_name }), { mode: 0o600 });',
	'fs.renameSync(temp, file);',
	'} catch { }',
	// The native title callback is a process-bound state report. Forward an existing user command unchanged, with the same input.
	'if (input && input.product === "antigravity" && process.env.FACADE_CODE_TITLE_COMMAND) {',
	'const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;',
	'const command = env.FACADE_CODE_TITLE_COMMAND.replace(/^~(?=[/\\\\])/, require("os").homedir());',
	'const child = require("child_process").spawn(command, {shell: process.platform === "win32" ? env.COMSPEC || "cmd.exe" : "/bin/sh", env, stdio:["pipe","inherit","inherit"]});',
	'child.on("error", () => {}); child.stdin.on("error", () => {}); child.stdin.end(data);',
	'} });',
	'process.stdin.resume();'
].join(' ');

/** `text` as one word of the POSIX shell a hook command runs in - Git Bash on Windows. */
function shellWord(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command of the session hook: `runtime` - the extension host's own binary, run as Node for this command alone, as an agent's
 * environment does not carry ELECTRON_RUN_AS_NODE (CLIS-1.2) - with the script, each one shell word; a Windows path with forward
 * slashes, which Git Bash takes. Never a `node` from PATH, which a CLI's installation need not have.
 */
export function sessionHookCommand(runtime: string, platform: NodeJS.Platform = process.platform, cli = 'claude', file?: string, script?: string): string {
	if (platform === 'win32' && cli !== 'claude') {
		// Native Windows hooks use cmd.exe, not Claude's Git Bash. Encoded PowerShell keeps paths and JS out of cmd parsing.
		const word = (value: string) => `'${value.replace(/'/g, "''")}'`;
		const command = `$env:ELECTRON_RUN_AS_NODE='1'; & ${word(runtime)} ${script ? word(script) : `-e ${word(SESSION_HOOK_SCRIPT)}`}${file ? ` ${word(file)}` : ''}; exit $LASTEXITCODE`;
		return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, 'utf16le').toString('base64')}`;
	}
	const program = platform === 'win32' ? runtime.replace(/\\/g, '/') : runtime;
	return `ELECTRON_RUN_AS_NODE=1 ${shellWord(program)} ${script ? shellWord(platform === 'win32' ? script.replace(/\\/g, '/') : script) : `-e ${shellWord(SESSION_HOOK_SCRIPT)}`}${file ? ` ${shellWord(file)}` : ''}`;
}

/** The conversation a run's session file records; none where there is no valid record. */
export function recordedSession(file: string): { readonly sessionId: string | null; readonly cwd?: string; readonly source?: string } | undefined {
	try {
		const record: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (isJsonObject(record) && (record.session_id === null || (typeof record.session_id === 'string' && (SESSION_ID.test(record.session_id) || /^ses_[a-zA-Z0-9]+$/.test(record.session_id))))) {
			const saved = record.session_id === null && record.source !== 'SessionEnd' && typeof record.pending_session_id === 'string' && SESSION_ID.test(record.pending_session_id)
				&& typeof record.transcript_path === 'string' && path.isAbsolute(record.transcript_path) && fs.existsSync(record.transcript_path) && fs.statSync(record.transcript_path).size > 0;
			return { sessionId: saved ? record.pending_session_id as string : record.session_id, ...typeof record.cwd === 'string' && path.isAbsolute(record.cwd) ? { cwd: record.cwd } : {}, ...typeof record.source === 'string' ? { source: record.source } : {} };
		}
	} catch {
		// None yet, or one being replaced
	}
	return undefined;
}
