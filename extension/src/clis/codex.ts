/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { canonicalFolder } from '../base/files';
import { CliAdapter, sigintExit } from './adapter';
import { SERVER_NAME, ToolsIntegration } from './tools';

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
 * without its update prompt, which would hold back the first task it is given (CLIS-3.2, D95).
 */
export const codexAdapter: CliAdapter = {
	id: 'codex',
	displayName: 'Codex',
	setting: 'facade.codex',
	command: 'codex',
	groups: {
		connect: [
			'-c', 'mcp_servers.facade.command=${mcpCommand}',
			'-c', 'mcp_servers.facade.args=${mcpArgs}',
			'-c', 'mcp_servers.facade.env=${mcpEnv}',
			'-c', 'mcp_servers.facade.startup_timeout_sec=30',
			'-c', 'mcp_servers.facade.tool_timeout_sec=3600',
			'-c', 'mcp_servers.facade.default_tools_approval_mode="approve"',
			// Its first model request waits this long for the server, not its 1 s default, which leaves a slow start out (D95)
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
	title: { names: ['Codex', 'codex'] },
	interruptExit: sigintExit
};
