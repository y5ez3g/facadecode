/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { CliAdapter, sigintExit } from './adapter';
import { Environment, variableOf } from './environment';
import { LaunchTarget, nodeOnPath } from './executable';
import { McpServer, SERVER_NAME, ToolsIntegration } from './tools';

/** `line` as a regular expression that matches it alone. */
const literal = (line: string) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The line of Pi's installer that chooses its own Node, where it installed one, while that is there. */
const OWN_NODE = 'IF EXIST "%LOCALAPPDATA%\\pi-node\\current\\node.exe" SET "node=%LOCALAPPDATA%\\pi-node\\current\\node.exe"';

/**
 * The `pi.cmd` Pi's own installer writes (pi.dev, for Pi 1.4.0), whole, its line endings aside: `node` chosen, then its own Node
 * where it installed one; its `pi-launcher.js` beside it run with every argument; and, where no Node is found, a message whose words
 * may change. Nothing else: a line of any other kind may make the shim run another program, Node or environment.
 */
const INSTALLER_SHIM = new RegExp([
	'^@ECHO off',
	'SETLOCAL',
	'SET "node=node"',
	`(?<own>${literal(OWN_NODE)}\\n)?"%node%" "%~dp0pi-launcher\\.js" %\\*`,
	...['SET "pi_exit_code=%ERRORLEVEL%"', 'IF "%pi_exit_code%"=="9009" (', '  IF "%node%"=="node" (', '    "%SystemRoot%\\System32\\where.exe" /Q node',
		'    IF ERRORLEVEL 1 GOTO node_missing', '  ) ELSE IF NOT EXIST "%node%" GOTO node_missing', ')', 'EXIT /B %pi_exit_code%', ':node_missing'].map(literal),
	'ECHO [^\\n&|<>]* 1>&2',
	'EXIT /B %pi_exit_code%\\n?$'
].join('\\n'));

/**
 * How the `pi.cmd` of Pi's own installer starts it, where `file` is that launcher as the installer wrote it (CLIS-1.2): its
 * `pi-launcher.js` with the Node it chooses - the installer's own Node in `LOCALAPPDATA` where it names one and it is there, else
 * `node` on the PATH of a launch in `cwd` - as an argument array, never through cmd.exe. Undefined for any other file; npm's own shim
 * for Pi is started as `launchTarget` starts any npm shim.
 */
export function piInstallerTarget(file: string, platform: NodeJS.Platform, env: Environment, cwd: string): LaunchTarget | undefined {
	if (platform !== 'win32' || !/\.cmd$/i.test(file)) {
		return undefined;
	}
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
	const shim = INSTALLER_SHIM.exec(text.replace(/\r\n?/g, '\n'));
	const script = path.join(path.dirname(file), 'pi-launcher.js');
	if (!shim || !fs.existsSync(script)) {
		return undefined;
	}
	const local = variableOf(env, 'LOCALAPPDATA', platform);
	const ownNode = shim.groups?.own && local ? path.join(local, 'pi-node', 'current', 'node.exe') : undefined;
	const node = ownNode !== undefined && fs.existsSync(ownNode) ? ownNode : nodeOnPath(env, platform, cwd);
	return node === undefined ? undefined : { executable: node, args: [script], throughCmd: false };
}

/** The run's own Pi extension, which registers the server, and its skill's folder: files of the run alone (CLIS-2.2). */
const EXTENSION = 'facade-pi.mjs';
const SKILL_DIR = path.join('skills', SERVER_NAME);

/** How long one call to the server may take: Pi's default minute is shorter than a start or a long screen wait may be. */
const CALL_SECONDS = 3_600;

/**
 * The extension Pi loads with `-e`: it registers `server` for its session alone - nothing saved - its tools declared to the model
 * directly, as Pi's MCP servers otherwise reach the model only through its codemode scripts (CLIS-2.2).
 */
export function piExtensionText(server: McpServer): string {
	const config = {
		command: server.command,
		args: [...server.args],
		env: { ...server.env },
		exposure: 'direct',
		timeout: CALL_SECONDS,
		description: 'Facade Code: start, stop and list agents, send and read messages, and read or type into agent terminals.'
	};
	return `// Facade Code: this run's tools, registered for its session alone\nexport default function (pi) {\n\tpi.registerMcpServer(${JSON.stringify(SERVER_NAME)}, ${JSON.stringify(config)});\n}\n`;
}

/**
 * Pi is given the server by a per-run extension, `-e`, which registers it for the session, and the skill in a per-run `--skill`
 * folder: nothing in the project or the person's settings (CLIS-2.2). Pi has no approvals, so Facade's tools never ask (CLIS-1.3).
 */
const piTools: ToolsIntegration = {
	capability: { state: 'unverified', reason: 'the server registered for the session by a per-run extension, -e, its tools declared to the model directly, and the skill in a per-run --skill folder' },
	where: runDir => `-e ${path.join(runDir, EXTENSION)} and --skill ${path.join(runDir, SKILL_DIR)}, files of the run alone`,
	inject: ({ server, skill, runDir }) => ({
		values: { extension: path.join(runDir, EXTENSION), skillDir: path.join(runDir, SKILL_DIR) },
		runFiles: [
			{ path: path.join(runDir, EXTENSION), content: piExtensionText(server) },
			{ path: path.join(runDir, SKILL_DIR, 'SKILL.md'), content: skill }
		],
		project: [],
		env: {}
	})
};

/**
 * Pi in its own UI (CLIS-1.3). It has no approvals and no sandbox, so YOLO has nothing to map: on or off, it runs as it natively
 * does (D79). Every launch trusts the folder it starts in for that launch alone with `--approve` - its project's settings,
 * extensions and skills loaded, as accepting its trust question does - writing nothing (CLIS-3.3, D62). It reports by OSC 7501 once
 * its probe is answered (CLIS-2.3). Two Ctrl+C exit it with 0, a normal exit.
 */
export const piAdapter: CliAdapter = {
	id: 'pi',
	displayName: 'Pi',
	setting: 'facade.pi',
	command: 'pi',
	groups: {
		connect: ['-e', '${extension}', '--skill', '${skillDir}'],
		model: ['--model', '${model}'],
		effort: ['--thinking', '${effort}'],
		trust: ['--approve'],
		// After the end of its options: its messages follow, where one that starts with @ would name a file
		prompt: ['--', '${prompt}']
	},
	takes: { model: true, effort: true },
	values: input => ({
		...input.model !== undefined ? { model: input.model } : {},
		...input.effort !== undefined ? { effort: input.effort } : {}
	}),
	tools: piTools,
	initialPrompt: { state: 'unverified', reason: 'the prompt as its message argument after --, which starts the interactive session with it' },
	promptProblem: prompt => prompt.startsWith('@') ? 'Pi reads an argument that starts with @ as a file to attach' : undefined,
	launchTarget: piInstallerTarget,
	// `π - {folder}`, or `π - {session name} - {folder}` once the session is named
	// Its input, recorded on macOS with Pi 1.4.0 (VERIFICATION G3): read by its layout, whatever the version (CLIS-2.1)
	input: { adapter: 'pi-frame', evidence: 'its editor between two rules above its footer, its own cursor drawn there: empty, a typed, pasted, multi-line, long-paste, history or slash-command draft, while working, and gone behind its trust question and model picker' },
	title: { names: ['π', 'Pi', 'pi'] },
	interruptExit: sigintExit
};
