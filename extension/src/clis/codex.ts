/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { CliAdapter, configOverrides, sigintExit } from './adapter';
import { createHash } from 'crypto';
import { parse as parseToml } from 'smol-toml';
import { isJsonObject } from '../base/json';
import type { SessionIntegration, SessionIntegrationInput } from './identity';

/**
 * Codex 0.166's SessionFlags layer and normalized hook fingerprint. Trust only our own command, for this launch. Per-launch hooks it
 * cannot read stay as configured, for Codex to say what is wrong with them, and the launch claims no identity tracking (CLIS-2.4).
 */
export function codexSession({ hook, platform, extra }: SessionIntegrationInput): SessionIntegration {
	let configured: Record<string, unknown> = {};
	for (const { key, value: text } of configOverrides(extra)) {
		if (text === undefined || (key !== 'hooks' && !key.startsWith('hooks.'))) { continue; }
		let value: unknown;
		try { value = parseToml(`value=${text}`).value; }
		catch { return { unavailable: true }; }
		if (key === 'hooks') {
			if (!isJsonObject(value)) { return { unavailable: true }; }
			configured = { ...value };
		} else {
			const keys = key.slice(6).split('.');
			let at = configured;
			for (const part of keys.slice(0, -1)) {
				const next = Object.hasOwn(at, part) && isJsonObject(at[part]) ? { ...at[part] } : {};
				Object.defineProperty(at, part, { value: next, enumerable: true, writable: true, configurable: true });
				at = next;
			}
			Object.defineProperty(at, keys.at(-1)!, { value, enumerable: true, writable: true, configurable: true });
		}
	}
	const source = platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml';
	const state = { ...isJsonObject(configured.state) ? configured.state : {} };
	for (const [event, label] of [['SessionStart', 'session_start'], ['SessionEnd', 'session_end']]) {
		const timeout = event === 'SessionEnd' ? 3 : 5;
		const groups = configured[event] ?? [];
		if (!Array.isArray(groups)) { return { unavailable: true }; }
		const fingerprint = JSON.stringify({ event_name: label, hooks: [{ async: false, command: hook, timeout, type: 'command' }] });
		const hash = `sha256:${createHash('sha256').update(fingerprint).digest('hex')}`;
		state[`${source}:${label}:${groups.length}:0`] = { enabled: true, trusted_hash: hash };
		configured[event] = [...groups, { hooks: [{ type: 'command', command: hook, timeout }] }];
	}
	// CLI dotted-key parsing is literal: the state key contains dots and must be inside the TOML value.
	let hooks: string | undefined;
	try { hooks = inlineToml({ ...configured, state }); }
	catch { hooks = undefined; }
	return hooks === undefined ? { unavailable: true } : { args: ['-c', `hooks=${hooks}`] };
}

/**
 * `value` as an inline TOML value; none where it holds what this writer does not carry over as it is, such as a date. Throws for text
 * TOML cannot hold.
 */
function inlineToml(value: unknown): string | undefined {
	if (typeof value === 'string') { return tomlString(value); }
	if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') { return String(value); }
	const table = isJsonObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);
	const parts = Array.isArray(value) ? value.map(inlineToml) : table ? Object.entries(value).map(([key, item]) => { const inline = inlineToml(item); return inline === undefined ? undefined : `${tomlString(key)}=${inline}`; }) : undefined;
	if (!parts || parts.some(part => part === undefined)) { return undefined; }
	return Array.isArray(value) ? `[${parts.join(',')}]` : `{${parts.join(',')}}`;
}
import { MOST_CALL_SECONDS, SERVER_NAME, ToolsIntegration } from './tools';

/** A TOML basic string for Codex's per-launch configuration (CLIS-3.2), including every control character. */
export function tomlString(text: string): string {
	if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
		throw new Error('A Codex configuration value contains an unpaired UTF-16 surrogate.');
	}
	const escapes: Readonly<Record<string, string>> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
	return `"${text.replace(/["\\\u0000-\u001F\u007F]/g, char => escapes[char] ?? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)}"`;
}

/** A TOML array of strings. */
function tomlArray(items: readonly string[]): string {
	return `[${items.map(tomlString).join(', ')}]`;
}

/** A TOML inline table of strings, its keys quoted. */
function tomlTable(entries: { readonly [name: string]: string }): string {
	return `{ ${Object.entries(entries).map(([name, value]) => `${tomlString(name)} = ${tomlString(value)}`).join(', ')} }`;
}

/** Where Codex reads skills from in a project: the skill is a project file every run in the folder shares (CLIS-2.2, D50). */
const SKILL_PATH = path.join('.agents', 'skills', SERVER_NAME, 'SKILL.md');

/**
 * Codex is given the server by `-c mcp_servers.facade.*` overrides of the launch alone, each value a TOML value, its tools approved
 * without asking - with YOLO off too, the CLI's own commands keeping their approvals (CLIS-1.3) - and the skill in the project's
 * `.agents/skills/facade`, which it reads skills from: a project file shared by the folder's runs (CLIS-2.2).
 */
const codexTools: ToolsIntegration = {
	capability: { state: 'unverified', reason: 'the server in -c mcp_servers.facade.* overrides of the launch alone, its tools approved by default_tools_approval_mode, and the skill in the project\'s .agents/skills/facade' },
	where: (_runDir, cwd) => `-c mcp_servers.${SERVER_NAME}.* arguments of the launch alone, and the skill in ${path.join(cwd, SKILL_PATH)}, a project file shared by the runs there`,
	inject: ({ server, skill }) => ({
		values: { mcpCommand: tomlString(server.command), mcpArgs: tomlArray(server.args), mcpEnv: tomlTable(server.env) },
		runFiles: [],
		project: [{ kind: 'file', path: SKILL_PATH, content: skill }],
		env: {}
	})
};

/**
 * Codex in its interactive terminal (CLIS-1.3, 3.3): trust applies to this launch through a TOML override, without writing its
 * configuration. YOLO bypasses approvals and sandbox; otherwise workspace-write keeps its native approval policy. It starts
 * without its update prompt, which would hold back the first task it is given (CLIS-3.2, D101).
 */
export const codexAdapter: CliAdapter = {
	id: 'codex',
	sessionIdentity: true,
	sessionIntegration: codexSession,
	identityOptions: ['--last'],
	displayName: 'Codex',
	setting: 'facade.codex',
	command: 'codex',
	// Its short options and its `--yolo`, the same options as these: one configured so would undo the run's YOLO mapping (CLIS-3.1)
	aliases: { '--model': ['-m'], '--sandbox': ['-s'], '--dangerously-bypass-approvals-and-sandbox': ['--yolo'] },
	groups: {
		resume: ['resume', '${sessionId}'],
		connect: [
			'-c', 'mcp_servers.facade.command=${mcpCommand}',
			'-c', 'mcp_servers.facade.args=${mcpArgs}',
			'-c', 'mcp_servers.facade.env=${mcpEnv}',
			'-c', 'mcp_servers.facade.startup_timeout_sec=30',
			'-c', `mcp_servers.facade.tool_timeout_sec=${MOST_CALL_SECONDS}`,
			'-c', 'mcp_servers.facade.default_tools_approval_mode="approve"',
			// Its first model request waits this long for the server, not its 1 s default, which leaves a slow start out (D101)
			'-c', 'mcp_optional_startup_grace_ms=10000'
		],
		// Embedded, as -c overrides need it: 0.166.0 otherwise warns of it under its input, and runs embedded all the same
		quiet: ['-c', 'check_for_update_on_startup=false', '--no-daemon'],
		yoloOn: ['--dangerously-bypass-approvals-and-sandbox'],
		yoloOff: ['--sandbox', 'workspace-write'],
		model: ['--model', '${model}'],
		// One TOML string, so that an effort with a quote or a line break in it stays one value
		effort: ['-c', 'model_reasoning_effort=${effortToml}'],
		// The whole table: in `projects.<folder>` the folder would be split at its dots
		trust: ['-c', 'projects={ ${folderToml} = { trust_level = "trusted" } }'],
		// After the end of its options, so that a prompt is never read as an option or a subcommand
		prompt: ['--', '${prompt}']
	},
	takes: { model: true, effort: true },
	values: ({ cwd, platform, model, effort }) => {
		const folder = canonicalFolder(cwd);
		return {
			folderToml: tomlString(platform === 'win32' ? folder.replace(/[A-Z]/g, letter => letter.toLowerCase()) : folder),
			...model !== undefined ? { model } : {},
			...effort !== undefined ? { effortToml: tomlString(effort) } : {}
		};
	},
	tools: codexTools,
	// Its input above its footer, recorded signed in on macOS with 0.165.0 (VERIFICATION G3): read by its layout, whatever the version
	input: { adapter: 'codex-prompt', evidence: 'its input above its footer: empty, a typed, pasted, multi-line, history or slash-command draft, and gone behind its trust question' },
	initialPrompt: { state: 'unverified', reason: 'the prompt as its positional argument after --, which starts the interactive session with it' },
	sandbox: yolo => yolo ? { state: 'off', by: ['--dangerously-bypass-approvals-and-sandbox'] } : { state: 'on', by: ['--sandbox', 'workspace-write'] },
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--dangerously-bypass-approvals-and-sandbox'] } : { state: 'native' },
	interruptExit: sigintExit
};
