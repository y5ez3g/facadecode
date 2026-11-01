/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where a CLI's program is, found with the destination environment its terminal starts with (CLIS-1.2), and how to start it so
// that its arguments reach it as an array: never through a shell string.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CliSaid } from './config';
import { Environment, variableOf } from './environment';

/**
 * The script npm's shim for a package's command runs with Node, and nothing between the two: `"%_prog%"
 * "%dp0%\node_modules\...\cli.js" %*`, or in older shims `"%~dp0\node.exe"` or `node` before it.
 */
const NPM_SHIM_SCRIPT = /(?:"%_prog%"|"%(?:~dp0|dp0%)\\node\.exe"|(?<![\w.%\\-])node(?:\.exe)?)\s+"%(?:~dp0|dp0%)\\(?<script>[^"%]+?\.[cm]?js)"\s+%\*/i;
/** What npm's shim sets `_prog` to: Node beside it, or Node on PATH - or another program, for a script that names one. */
const NPM_SHIM_PROGRAM = /SET\s+"_prog=(?<program>[^"]*)"/gi;
/**
 * npm's shim for a package's native program, as npm 7 and later write it, whole: it finds its own folder and runs the program
 * there with every argument, `"%dp0%\node_modules\...\opencode.exe" %*`, and nothing else.
 */
const NPM_NATIVE_SHIM = /^@ECHO off\r?\nGOTO start\r?\n:find_dp0\r?\nSET dp0=%~dp0\r?\nEXIT \/b\r?\n:start\r?\nSETLOCAL\r?\nCALL :find_dp0\r?\n"%dp0%\\(?<program>[^"%\r\n]+\.(?:exe|com))"[ \t]+%\*[ \t]*(?:\r?\n)?$/i;
/** A Node that runs as itself, not through cmd.exe as a `.cmd` or `.bat` of a version manager would. */
const NODE_EXECUTABLE = /\.(?:exe|com)$/i;
/**
 * What cmd.exe reads as its own in an argument, or which ends one: text with any of these that goes through it can run commands
 * or lose what follows (CLIS-1.2). Parentheses reach a launcher's `%*` whole, quoted or not, and are not among them.
 */
const CMD_SPECIAL = /["%^&|<>!\r\n]/;

/** The variable the operating system names the home folder in. */
function homeVariable(platform: NodeJS.Platform): string {
	return platform === 'win32' ? 'USERPROFILE' : 'HOME';
}

/** The home folder as `env` names it - where a leading `~` points - else this process's. */
export function homeOf(env: Environment = process.env, platform: NodeJS.Platform = process.platform): string {
	return variableOf(env, homeVariable(platform), platform) || os.homedir();
}

/** The file names `base` can be on `platform`: on Windows with each of PATHEXT's extensions too. */
function candidatesOf(base: string, env: Environment, platform: NodeJS.Platform): string[] {
	if (platform !== 'win32') {
		return [base];
	}
	const extensions = (variableOf(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => ext.toLowerCase());
	return path.extname(base) === '' ? extensions.map(ext => base + ext) : [base, ...extensions.map(ext => base + ext)];
}

/** Whether `file` is a file that can be run: on Windows any file, its extension saying how; elsewhere one marked executable. */
function isExecutable(file: string, platform: NodeJS.Platform): boolean {
	try {
		if (!fs.statSync(file).isFile()) {
			return false;
		}
		if (platform !== 'win32') {
			fs.accessSync(file, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/** The program at exactly `file`, with PATHEXT on Windows; undefined where none can be run there. */
export function executableAt(file: string, env: Environment = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
	return candidatesOf(file, env, platform).find(candidate => isExecutable(candidate, platform));
}

/**
 * Where the command `name` resolves on `env`'s PATH - entries in quotes too - with PATHEXT on Windows; undefined if nowhere. A
 * relative entry is from `cwd`, the folder the program is launched in, as the launch would find it (CLIS-1.2).
 */
export function which(name: string, env: Environment = process.env, platform: NodeJS.Platform = process.platform, cwd: string = process.cwd()): string | undefined {
	const separator = platform === 'win32' ? ';' : ':';
	for (const dir of (variableOf(env, 'PATH', platform) ?? '').split(separator).filter(Boolean)) {
		const found = executableAt(path.resolve(cwd, dir.replace(/^"(?<unquoted>.*)"$/, '$<unquoted>'), name), env, platform);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/** A program found, or why none was. */
export type FoundExecutable = { readonly executable: string; readonly problem?: undefined } | { readonly executable?: undefined; readonly problem: string; readonly said: CliSaid };

/**
 * The program a CLI's `path` setting names, for a launch in `cwd` with the environment `env` (CLIS-1.2): empty, its `command` on
 * PATH; a simple name, that name on PATH; a leading `~`, from the environment's home folder; a relative path, from `cwd`; an
 * absolute one, exactly. A path that names no program is a problem naming `setting`, never another CLI in its place.
 */
export function resolveExecutable(configured: string, command: string, setting: string, env: Environment, cwd: string, platform: NodeJS.Platform = process.platform): FoundExecutable {
	const separators = platform === 'win32' ? /[\\/]/ : /\//;
	if (!configured) {
		const found = which(command, env, platform, cwd);
		return found ? { executable: found } : { problem: `${command} was not found on the PATH of a terminal in ${cwd}, and ${setting}.path does not name its location`, said: { kind: 'not_on_path', values: [command, cwd, setting] } };
	}
	if (!separators.test(configured) && configured !== '~') {
		const found = which(configured, env, platform, cwd);
		return found ? { executable: found } : { problem: `${setting}.path is ${JSON.stringify(configured)}, which was not found on the PATH of a terminal in ${cwd}`, said: { kind: 'path_not_on_path', values: [setting, JSON.stringify(configured), cwd] } };
	}
	const file = configured === '~' || /^~[\\/]/.test(configured)
		? path.join(homeOf(env, platform), configured.slice(1))
		: path.resolve(cwd, configured);
	const found = executableAt(file, env, platform);
	return found ? { executable: found } : { problem: `${setting}.path is ${JSON.stringify(configured)}, and ${file} is not a program that can be run`, said: { kind: 'not_runnable', values: [setting, JSON.stringify(configured), file] } };
}

/** How to start a program so that its arguments reach it as they are. */
export interface LaunchTarget {
	readonly executable: string;
	/** Ahead of the CLI's own arguments: the script Node runs. */
	readonly args: readonly string[];
	/** Whether its arguments go through cmd.exe, which must be given no text it reads as its own (CLIS-1.2). */
	readonly throughCmd: boolean;
}

/** Node on the PATH of a launch in `cwd`, where it is a program of its own: not a `.cmd` or `.bat` of a version manager. */
export function nodeOnPath(env: Environment, platform: NodeJS.Platform, cwd: string): string | undefined {
	const node = which('node', env, platform, cwd);
	return node && NODE_EXECUTABLE.test(node) ? node : undefined;
}

/** `relative`, as a Windows launcher names a file beside it with backslashes, in `dir`; undefined for one that leaves `dir`. */
export function fileIn(dir: string, relative: string): string | undefined {
	// Only Windows reads backslashes as separators
	const target = path.join(dir, ...relative.split(/[\\/]/));
	const inside = path.relative(dir, target);
	return inside && inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside) ? target : undefined;
}

/**
 * How to start the program `file` on `platform` (CLIS-1.2). On Windows a `.cmd` or `.bat` runs through cmd.exe, which reads `&`,
 * `|` and `%` in its arguments as its own and ends an argument at a line break. npm's shim for a package's command is such a file:
 * one that runs the package's script with Node is run as that script with Node directly - the Node beside the shim, as the shim
 * would, or the one on the PATH of a launch in `cwd` where it is a program of its own; one that runs a native program of the package
 * is run as that program. Anything else stays as it is, marked `throughCmd`.
 */
export function launchTarget(file: string, platform: NodeJS.Platform = process.platform, env: Environment = process.env, cwd: string = process.cwd()): LaunchTarget {
	if (isNodeScript(file, platform)) {
		// A Node entry point, such as a package's cli.js: run with the Node on the PATH of a launch in `cwd`, as Windows cannot
		// run a script itself; where there is none, it stays as it is, for the plan to refuse
		const node = nodeOnPath(env, platform, cwd);
		return node ? { executable: node, args: [file], throughCmd: false } : { executable: file, args: [], throughCmd: false };
	}
	if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) {
		return { executable: file, args: [], throughCmd: false };
	}
	let text = '';
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		// Not readable: taken for what it is.
	}
	const dir = path.dirname(file);
	const shim = NPM_SHIM_SCRIPT.exec(text);
	const script = shim?.groups?.script;
	const programs = [...text.matchAll(NPM_SHIM_PROGRAM)].map(match => match.groups?.program ?? '');
	const runsNode = !shim?.[0].startsWith('"%_prog%"') || (programs.length > 0 && programs.every(program => /^(?:%dp0%\\node\.exe|node)$/i.test(program)));
	if (script && runsNode) {
		const target = path.join(dir, ...script.split(/[\\/]/));
		const beside = path.join(dir, 'node.exe');
		const node = fs.existsSync(beside) ? beside : nodeOnPath(env, platform, cwd);
		if (node && fs.existsSync(target)) {
			return { executable: node, args: [target], throughCmd: false };
		}
	}
	const native = NPM_NATIVE_SHIM.exec(text)?.groups?.program;
	const program = native === undefined ? undefined : fileIn(dir, native);
	if (program && isExecutable(program, platform)) {
		return { executable: program, args: [], throughCmd: false };
	}
	return { executable: file, args: [], throughCmd: true };
}

/** Whether `file` is a Node script Windows cannot run itself: elsewhere one marked executable runs by its `#!` line. */
export function isNodeScript(file: string, platform: NodeJS.Platform): boolean {
	return platform === 'win32' && /\.[cm]?js$/i.test(file);
}

/** Whether `arg` could not go through cmd.exe as it is (`throughCmd`). */
export function unsafeForCmd(arg: string): boolean {
	return CMD_SPECIAL.test(arg);
}

/** The first character of `arg` cmd.exe would read as its own, quoted as a problem names it; none where it has none. */
export function unsafeCharacterForCmd(arg: string): string | undefined {
	const found = CMD_SPECIAL.exec(arg);
	return found ? JSON.stringify(found[0]) : undefined;
}
