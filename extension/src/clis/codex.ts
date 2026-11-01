/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { canonicalFolder } from '../base/files';
import { CliAdapter, sigintExit } from './adapter';
import { createHash } from 'crypto';
import { parse as parseToml } from 'smol-toml';
import { isJsonObject } from '../base/json';
import type { SessionIntegration, SessionIntegrationInput } from './identity';

/** Codex 0.166's SessionFlags layer and normalized hook fingerprint. Trust only our own command, for this launch. */
export function codexSession({ hook, platform, extra }: SessionIntegrationInput): SessionIntegration {
	let configured: Record<string, unknown> = {};
	for (let i = 0; i < extra.length; i++) {
		const arg = extra[i] === '-c' || extra[i] === '--config' ? extra[++i] : extra[i].startsWith('--config=') ? extra[i].slice(9) : undefined;
		const split = arg?.indexOf('=') ?? -1;
		const key = arg?.slice(0, split).trim();
		if (split < 0 || !key || (key !== 'hooks' && !key.startsWith('hooks.'))) { continue; }
		let value: unknown;
		try { value = parseToml(`value=${arg!.slice(split + 1)}`).value; }
		catch { throw new Error('Codex per-launch hooks must be valid TOML.'); }
		if (key === 'hooks') {
			if (!isJsonObject(value)) { throw new Error('Codex hooks configuration must be a table.'); }
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
		if (!Array.isArray(groups)) { throw new Error(`Codex ${event} hooks must be an array.`); }
		const fingerprint = JSON.stringify({ event_name: label, hooks: [{ async: false, command: hook, timeout, type: 'command' }] });
		const hash = `sha256:${createHash('sha256').update(fingerprint).digest('hex')}`;
		state[`${source}:${label}:${groups.length}:0`] = { enabled: true, trusted_hash: hash };
		configured[event] = [...groups, { hooks: [{ type: 'command', command: hook, timeout }] }];
	}
	const hooks = { ...configured, state };
	// CLI dotted-key parsing is literal: the state key contains dots and must be inside the TOML value.
	return { args: ['-c', `hooks=${inlineToml(hooks)}`] };
}

function inlineToml(value: unknown): string {
	if (typeof value === 'string') { return tomlString(value); }
	if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') { return String(value); }
	if (Array.isArray(value)) { return `[${value.map(inlineToml).join(',')}]`; }
	if (isJsonObject(value)) { return `{${Object.entries(value).map(([key, item]) => `${tomlString(key)}=${inlineToml(item)}`).join(',')}}`; }
	throw new Error('Codex hooks contain an unsupported configuration value.');
}

/** A TOML basic string for Codex's per-launch configuration (CLIS-3.2), including every control character. */
export function tomlString(text: string): string {
	if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
		throw new Error('A Codex configuration value contains an unpaired UTF-16 surrogate.');
	}
	const escapes: Readonly<Record<string, string>> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };
	return `"${text.replace(/["\\\u0000-\u001F\u007F]/g, char => escapes[char] ?? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)}"`;
}

/**
 * Codex in its interactive terminal (CLIS-1.3, 3.3): trust applies to this launch through a TOML override, without writing its
 * configuration. YOLO bypasses approvals and sandbox; otherwise workspace-write keeps its native approval policy.
 */
export const codexAdapter: CliAdapter = {
	id: 'codex',
	sessionIdentity: true,
	sessionIntegration: codexSession,
	identityOptions: ['--last'],
	displayName: 'Codex',
	setting: 'facade.codex',
	command: 'codex',
	groups: {
		resume: ['resume', '${sessionId}'],
		yoloOn: ['--dangerously-bypass-approvals-and-sandbox'],
		yoloOff: ['--sandbox', 'workspace-write'],
		trust: ['-c', 'projects={ ${folderToml} = { trust_level = "trusted" } }']
	},
	values: ({ cwd, platform }) => {
		const folder = canonicalFolder(cwd);
		return { folderToml: tomlString(platform === 'win32' ? folder.replace(/[A-Z]/g, letter => letter.toLowerCase()) : folder) };
	},
	title: { names: ['Codex', 'codex'] },
	sandbox: yolo => yolo ? { state: 'off', by: ['--dangerously-bypass-approvals-and-sandbox'] } : { state: 'on', by: ['--sandbox', 'workspace-write'] },
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--dangerously-bypass-approvals-and-sandbox'] } : { state: 'native' },
	interruptExit: sigintExit
};
