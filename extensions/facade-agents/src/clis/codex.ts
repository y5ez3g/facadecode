/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { AgentCli, Environment, launchArgs, launchUses, launchValues, skillMarkdown } from './cli';
import { homeOf } from './executable';

/** A TOML value for Codex's `-c`: a JSON string is a TOML basic string. */
function toml(value: string | readonly string[] | { readonly [name: string]: string }): string {
	if (typeof value === 'string') {
		return tomlString(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(tomlString).join(', ')}]`;
	}
	return `{ ${Object.entries(value).map(([key, item]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)} = ${tomlString(item)}`).join(', ')} }`;
}

/** The escapes of a TOML basic string, by the character: the rest of the control characters go as `\uXXXX`. */
const TOML_ESCAPES: { readonly [char: string]: string } = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };

/**
 * `text` as a TOML basic string, as TOML's own serializer writes one - not JSON's, which leaves DEL as it is
 * (X-61): the quote, the backslash and every control character escaped. Throws for half a character, which
 * no TOML string can hold.
 */
function tomlString(text: string): string {
	if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
		throw new Error(`${JSON.stringify(text)} contains an unpaired UTF-16 surrogate and cannot be stored in Codex's TOML configuration.`);
	}
	return `"${text.replace(/["\\\u0000-\u001F\u007F]/g, char => TOML_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)}"`;
}

/** The table Facade's server takes in Codex's configuration, its `-c` overrides merged into whatever is there. */
const SERVER_TABLE = ['mcp_servers', 'facade'];

/**
 * The configuration files Codex reads for a session in `folder`, as it finds them: its own, in `CODEX_HOME`
 * or `~/.codex`, and a project's `.codex/config.toml` in each folder from `folder` up to its project's root,
 * the first with a `.git` - the folder alone outside any.
 */
function codexConfigFiles(folder: string, env: Environment): string[] {
	const files = [path.join(env.CODEX_HOME || path.join(homeOf(env), '.codex'), 'config.toml')];
	const project: string[] = [];
	for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
		project.push(path.join(dir, '.codex', 'config.toml'));
		if (fs.existsSync(path.join(dir, '.git'))) {
			break;
		}
		if (path.dirname(dir) === dir) {
			project.splice(1);
			break;
		}
	}
	return [...files, ...project];
}

/**
 * Whether the TOML `text` gives anything at or under the key `target`: in a table's header, a dotted key, or
 * an inline table. Text that is no TOML gives nothing - Codex says what is wrong with it.
 */
function tomlDefines(text: string, target: readonly string[]): boolean {
	let at = 0;
	const fail = (): never => { throw new SyntaxError(`invalid TOML at offset ${at}`); };
	const under = (key: readonly string[]) => key.length >= target.length && target.every((part, i) => key[i] === part);
	const leadsTo = (key: readonly string[]) => key.length < target.length && key.every((part, i) => target[i] === part);
	const blank = (lines: boolean) => {
		for (; at < text.length; at++) {
			const char = text[at];
			if (char === '#') {
				while (at < text.length && text[at] !== '\n') {
					at++;
				}
				at--;
			} else if (char !== ' ' && char !== '\t' && char !== '\r' && !(lines && char === '\n')) {
				return;
			}
		}
	};
	const quoted = (): string => {
		const quote = text[at];
		const triple = text.startsWith(quote.repeat(3), at);
		const close = triple ? quote.repeat(3) : quote;
		let value = '';
		for (at += close.length; at < text.length; at++) {
			if (quote === '"' && text[at] === '\\') {
				value += text.slice(at, at + 2);
				at++;
			} else if (text.startsWith(close, at)) {
				// A closing triple quote may have one or two of the string's own quotes before it
				let end = at + close.length;
				while (triple && text[end] === quote && end - at < 5) {
					end++;
				}
				value += quote.repeat(end - at - close.length);
				at = end;
				if (quote === '\'') {
					return value;
				}
				try {
					return JSON.parse(`"${value.replace(/\n/g, '\\n')}"`);
				} catch {
					return value;
				}
			} else if (!triple && text[at] === '\n') {
				fail();
			} else {
				value += text[at];
			}
		}
		return fail();
	};
	const key = (): string[] => {
		const parts: string[] = [];
		for (; ;) {
			blank(false);
			if (text[at] === '"' || text[at] === '\'') {
				parts.push(quoted());
			} else {
				const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(at, at + 1024));
				if (!bare) {
					return fail();
				}
				parts.push(bare[0]);
				at += bare[0].length;
			}
			blank(false);
			if (text[at] !== '.') {
				return parts;
			}
			at++;
		}
	};
	// A value, skipped; one that is an inline table on the way to `target` looked into, at `place`.
	const value = (place: readonly string[] | undefined): boolean => {
		blank(false);
		const char = text[at];
		if (char === '"' || char === '\'') {
			quoted();
			return false;
		}
		if (char === '[') {
			at++;
			for (; ;) {
				blank(true);
				if (text[at] === ']') {
					at++;
					return false;
				}
				value(undefined);
				blank(true);
				if (text[at] === ',') {
					at++;
				} else if (text[at] !== ']') {
					fail();
				}
			}
		}
		if (char === '{') {
			at++;
			let found = false;
			for (; ;) {
				blank(true);
				if (text[at] === '}') {
					at++;
					return found;
				}
				const name = key();
				const inner = place && [...place, ...name];
				blank(false);
				if (text[at++] !== '=') {
					fail();
				}
				const within = value(inner && leadsTo(inner) ? inner : undefined);
				found = found || within || (inner !== undefined && under(inner));
				blank(true);
				if (text[at] === ',') {
					at++;
				} else if (text[at] !== '}') {
					fail();
				}
			}
		}
		const scalar = /^[^,\]}\n#]*/.exec(text.slice(at))?.[0] ?? '';
		if (!scalar.trim()) {
			fail();
		}
		at += scalar.length;
		return false;
	};
	try {
		let table: readonly string[] = [];
		for (; ;) {
			blank(true);
			if (at >= text.length) {
				return false;
			}
			if (text[at] === '[') {
				const array = text[at + 1] === '[';
				at += array ? 2 : 1;
				table = key();
				if (!text.startsWith(array ? ']]' : ']', at)) {
					fail();
				}
				at += array ? 2 : 1;
				if (under(table)) {
					return true;
				}
				continue;
			}
			const full = [...table, ...key()];
			blank(false);
			if (text[at++] !== '=') {
				fail();
			}
			if (under(full) || value(leadsTo(full) ? full : undefined)) {
				return true;
			}
		}
	} catch {
		return false;
	}
}

/** A folder as Codex keys its trust: its real path, with only ASCII letters lower-cased on Windows, as Codex does. */
function projectKey(folder: string): string {
	const real = canonicalFolder(folder);
	return process.platform === 'win32' ? real.replace(/[A-Z]/g, letter => letter.toLowerCase()) : real;
}

/**
 * Codex in its own UI. YOLO on: no approvals and no sandbox. YOLO off: its workspace-write sandbox, while its
 * server setting lets Facade's tools through unasked; the person's own agent asks them as their approval policy
 * has it, and one started through `start_agent`, where nobody may be watching, is refused unasked what would ask
 * (AGENT-LAUNCHER.md, L4). A project's hooks nobody reviewed: the person's own agent asks them as Codex does;
 * through `start_agent`, YOLO on trusts them for the run, YOLO off runs none (rule 3). Facade's MCP server comes
 * as `-c` overrides, and so do - through `start_agent` - the settings that would update it or show it tips and
 * nudges, or offer it its question tool outside plan mode, and the person's trust in the folder it starts in, for
 * the launch alone. Nothing is written into the person's own config.toml.
 */
export const codexCli: AgentCli = {
	id: 'codex',
	displayName: 'Codex',
	setting: 'facade.agents.codex',
	command: 'codex',
	defaults: {
		path: '',
		enabled: true,
		launch: {
			arguments: {
				connect: [
					'-c', 'mcp_servers.facade.command=${mcpCommand}',
					'-c', 'mcp_servers.facade.args=${mcpArgs}',
					'-c', 'mcp_servers.facade.env=${mcpEnv}',
					'-c', 'mcp_servers.facade.startup_timeout_sec=30',
					// start_agent may wait minutes for a child to come up.
					'-c', 'mcp_servers.facade.tool_timeout_sec=3600',
					'-c', 'mcp_servers.facade.required=true',
					// Facade's tools unasked, whatever the agent's YOLO.
					'-c', 'mcp_servers.facade.default_tools_approval_mode="approve"',
					// A process of its own: a session of the shared background server would run with the
					// environment of whoever started that server.
					'--no-daemon'
				],
				yoloOn: ['--dangerously-bypass-approvals-and-sandbox'],
				// Its sandbox alone: what it asks, and when, is the person's approval policy's (L4)
				yoloOff: ['--sandbox', 'workspace-write'],
				model: ['--model', '${model}'],
				// A whole TOML string, so that an effort with a quote or a line break in it stays one.
				effort: ['-c', 'model_reasoning_effort=${effortToml}'],
				task: ['--', '${task}']
			},
			environment: {},
			// The whole table: in `projects.<folder>` the folder would be split at its dots.
			trust: { arguments: ['-c', 'projects={ ${folderToml} = { trust_level = "trusted" } }'] },
			enterDelay: 300,
			taskDelay: 2000,
			unattended: {
				arguments: {
					quiet: ['-c', 'check_for_update_on_startup=false', '-c', 'tui.show_tooltips=false', '-c', 'notice.hide_rate_limit_model_nudge=true'],
					// Its request_user_input would leave its terminal waiting for someone to pick an answer: the feature that
					// offers it outside plan mode - default_mode_request_user_input, as 0.162.1 names it - is off for the run (L4)
					questions: ['-c', 'features.default_mode_request_user_input=false'],
					// The project's hooks run, trusted for this run, rather than stop it at their review screen (L4, rule 3)
					yoloOn: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
					// What would ask is refused unasked; and no hook runs, nor waits to be reviewed (L4, rule 3)
					yoloOff: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never', '-c', 'features.hooks=false']
				},
				environment: {}
			}
		}
	},
	task: 'argument',
	sandbox: { yoloOn: 'off', yoloOff: process.platform === 'win32' ? 'unavailable' : 'on' },
	exemption: 'precise',
	// Its request_user_input waits for a pick in its own UI, in plan mode - and outside it where the person's
	// configuration turns its feature on: its unattended questions group turns that off (L4)
	questionTool: 'removed',
	verified: '0.162.1',
	// Its `-c` overrides are merged into a server of the person's of the same name - its `url` beside Facade's
	// `command`, say: a server neither theirs nor Facade's (X-47)
	conflict(args, folder, env) {
		if (!args.some(arg => arg.startsWith(`${SERVER_TABLE.join('.')}.`) || arg.startsWith(`${SERVER_TABLE.join('.')}=`))) {
			return undefined;
		}
		for (const file of codexConfigFiles(folder, env)) {
			let text: string;
			try {
				text = fs.readFileSync(file, 'utf8');
			} catch {
				continue;
			}
			if (tomlDefines(text, SERVER_TABLE)) {
				return `${file} already defines an MCP server named facade. Codex would merge Facade's server into that entry. Rename or remove the existing entry.`;
			}
		}
		return undefined;
	},
	launch(input, executable) {
		const { connection } = input;
		return {
			executable,
			args: launchArgs(codexCli.setting + '.launch', input.config, {
				...launchValues(input),
				// The forms its `-c` arguments take: TOML values, and the folder as it keys its trust.
				...connection ? { mcpCommand: toml(connection.mcp.command), mcpArgs: toml(connection.mcp.args), mcpEnv: toml(connection.mcp.env) } : {},
				folderToml: toml(projectKey(input.folder)),
				...input.effort !== undefined ? { effortToml: toml(input.effort) } : {}
			}, launchUses(input)),
			env: input.config.launch.environment,
			cwd: input.folder,
			files: [],
			injected: connection ? input.skills.map(skill => ({ path: `.agents/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) })) : []
		};
	}
};
