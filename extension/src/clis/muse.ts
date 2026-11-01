/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { CliAdapter, sigintExit } from './adapter';
import { RUN_VARIABLE } from './environment';
import { SERVER_NAME, serverEntry, sharedServer, ToolsIntegration } from './tools';

/** The project's MCP file Muse Code reads in a trusted folder, and where it reads skills there (CLIS-2.2). */
const MCP_FILE = '.mcp.json';
const SKILL_PATH = path.join('.agents', 'skills', SERVER_NAME, 'SKILL.md');

/** The variable a run's own entry names for the server's runtime variable: Muse Code takes only references in a run's entry. */
const RUNTIME_REFERENCE = 'FACADE_ELECTRON_RUN_AS_NODE';

/**
 * Muse Code is given the server for the run alone by `-c mcpServers.facade=<entry>`, and the skill in the project's
 * `.agents/skills/facade`, shared by the folder's runs; every launch trusts the folder, so it reads it (CLIS-2.2, 3.3). A run's
 * entry may name variables only by references to the CLI's environment, which carries the run's own. On Windows its arguments go
 * through cmd.exe, which cannot carry an entry's JSON: there the entry is the `facade` entry of the project's `.mcp.json`, merged
 * into the person's file and shared by the folder's runs, its variables `${NAME:-}` references - empty in a session the person
 * starts there by hand, whose server then serves nothing, where an unset reference would turn off every server of theirs. Either
 * entry is optional: Muse Code fails a whole run over a required server that does not start, and requires one by default (D107).
 */
const museTools: ToolsIntegration = {
	capability: { state: 'unverified', reason: 'the server by -c mcpServers.facade for the run alone - on Windows a facade entry merged into the project\'s .mcp.json, shared by the folder\'s runs - with references to the run\'s variables in the CLI\'s environment, and the skill in the project\'s .agents/skills/facade' },
	where: (_runDir, cwd) => `-c mcpServers.${SERVER_NAME} of the launch alone, on Windows mcpServers.${SERVER_NAME} in ${path.join(cwd, MCP_FILE)}, and the skill in ${path.join(cwd, SKILL_PATH)}, shared by the runs there`,
	inject: ({ server, skill, platform }) => {
		const shared = sharedServer(server);
		const skillFile = { kind: 'file', path: SKILL_PATH, content: skill } as const;
		if (platform === 'win32') {
			const references = Object.fromEntries([...Object.keys(shared.env), RUN_VARIABLE].map(name => [name, `\${${name}:-}`]));
			const entry = { ...serverEntry({ ...shared.server, env: { ...shared.server.env, ...references } }), mode: 'optional' };
			return { values: {}, runFiles: [], project: [{ kind: 'entry', path: MCP_FILE, keys: ['mcpServers', SERVER_NAME], value: entry }, skillFile], env: shared.env };
		}
		// Every variable a reference to the CLI's environment, the runtime's under a name of its own, which no program but the server reads
		const runtime = Object.fromEntries(Object.entries(shared.server.env).map(([name, value]) => [name === 'ELECTRON_RUN_AS_NODE' ? RUNTIME_REFERENCE : name, value]));
		const env = { ...runtime, ...shared.env };
		const references = Object.fromEntries([...Object.keys(server.env), RUN_VARIABLE].map(name => [name, `\${${name === 'ELECTRON_RUN_AS_NODE' ? RUNTIME_REFERENCE : name}}`]));
		const entry = { ...serverEntry({ command: server.command, args: server.args, env: references }), mode: 'optional' };
		return { values: {}, args: ['-c', `mcpServers.${SERVER_NAME}=${JSON.stringify(entry)}`], runFiles: [], project: [skillFile], env };
	}
};

/**
 * Muse Code in its own UI (CLIS-1.3). YOLO on: its tool approvals and its shell sandbox off for the run, `--disable-approval
 * --disable-sandbox` - not `--yolo`, which also withholds its question tool. YOLO off: its approvals and its sandbox as its own
 * configuration has them, the sandbox on unless that turns it off. Every launch trusts the folder it starts in for that launch alone
 * with `--trust-workspace`, as accepting its trust question would, writing nothing (CLIS-3.3, D62). On Windows its installer's
 * `muse.cmd` runs a PowerShell launcher that picks its current program, so it goes through cmd.exe, which takes these arguments
 * safely (CLIS-1.2). It reports its activity by OSC 7501 on Linux and macOS but sends nothing on Windows, where ptyd reads it from
 * its screen instead (CLIS-2.3, D80).
 */
export const museAdapter: CliAdapter = {
	id: 'muse',
	displayName: 'Muse Code',
	setting: 'facade.muse',
	command: 'muse',
	groups: {
		yoloOn: ['--disable-approval', '--disable-sandbox'],
		model: ['--model', '${model}'],
		// For the run alone, its values JSON: its own --reasoning-effort is kept in the person's settings, and the efforts its settings
		// keep for each model would win over this one
		effort: ['-c', 'reasoning_effort=${effortJson}', '-c', 'model_reasoning_efforts={}'],
		trust: ['--trust-workspace'],
		// After the end of its options, so that a prompt is never read as an option or a command
		prompt: ['--', '${prompt}']
	},
	takes: { model: true, effort: true },
	values: input => ({
		...input.model !== undefined ? { model: input.model } : {},
		...input.effort !== undefined ? { effortJson: JSON.stringify(input.effort) } : {}
	}),
	tools: museTools,
	initialPrompt: { state: 'unverified', reason: 'the prompt as its positional argument after --, which starts the interactive session with it' },
	// 1.4.14 reads a prompt that is one of its commands' names as that command, even after --, and refuses to start (D107)
	promptProblem: prompt => /^[a-z][a-z0-9-]*$/.test(prompt) ? 'Muse Code reads a prompt of one lowercase word as one of its commands, even after --' : undefined,
	screenStatus: 'muse',
	// Its input, recorded on macOS with Muse Code 1.4.14 (VERIFICATION G3): read by its layout, whatever the version (CLIS-2.1)
	input: { adapter: 'muse-frame', evidence: 'its input frame between two rules, its upper one labeled where it offers voice input: empty, a typed, pasted, multi-line, history or slash-command draft, and gone behind its trust question' },
	title: { names: ['Muse Code', 'Muse', 'muse'] },
	sandbox: yolo => yolo ? { state: 'off', by: ['--disable-sandbox'] } : { state: 'native' },
	approvals: yolo => yolo ? { state: 'bypassed', by: ['--disable-approval'] } : { state: 'native' },
	interruptExit: sigintExit
};
