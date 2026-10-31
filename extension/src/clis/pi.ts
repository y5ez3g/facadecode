/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { CliAdapter, sigintExit } from './adapter';
import { Environment, variableOf } from './environment';
import { LaunchTarget, nodeOnPath } from './executable';

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
		trust: ['--approve']
	},
	values: () => ({}),
	launchTarget: piInstallerTarget,
	// `π - {folder}`, or `π - {session name} - {folder}` once the session is named
	title: { names: ['π', 'Pi', 'pi'] },
	interruptExit: sigintExit
};
