/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Environment, InstalledCli } from './cli';

/**
 * The script npm's shim for a package's command runs with Node, and nothing between the two: `"%_prog%"
 * "%dp0%\node_modules\...\cli.js" %*`, or in older shims `"%~dp0\node.exe"` or `node` before it.
 */
const NPM_SHIM_SCRIPT = /(?:"%_prog%"|"%(?:~dp0|dp0%)\\node\.exe"|(?<![\w.%\\-])node(?:\.exe)?)\s+"%(?:~dp0|dp0%)\\(?<script>[^"%]+?\.[cm]?js)"\s+%\*/i;
/** What npm's shim sets `_prog` to: Node beside it, or Node on PATH - or another program, for a script that names one. */
const NPM_SHIM_PROGRAM = /SET\s+"_prog=(?<program>[^"]*)"/gi;
/** A Node that runs as itself, not through cmd.exe as a `.cmd` or `.bat` of a version manager would. */
const NODE_EXECUTABLE = /\.(?:exe|com)$/i;
/**
 * What cmd.exe reads as its own in an argument, or which ends one: text with any of these that goes
 * through it can run commands or lose what follows.
 */
const CMD_SPECIAL = /["%^&|<>!()\r\n]/;
/** How long a CLI may take to list its models, which it may fetch from its service. */
const LIST_TIMEOUT_MS = 30_000;

/** The person's home folder as the operating system says it in `env`: where the CLIs keep their settings. */
export function homeOf(env: Environment = process.env): string {
	return env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] || os.homedir();
}

/** Where `command` resolves on `PATH`, with `PATHEXT` on Windows, as `platform` looks for it. Undefined if nowhere. */
export function which(command: string, env: Environment = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
	const windows = platform === 'win32';
	const hasDirectory = command.includes('/') || (windows && command.includes('\\'));
	const extensions = windows ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
	const candidates = (base: string) => windows && path.extname(base) === '' ? extensions.map(ext => base + ext.toLowerCase()) : [base, ...(windows ? extensions.map(ext => base + ext.toLowerCase()) : [])];
	const found = (base: string) => candidates(base).find(file => isExecutable(file, windows));
	if (hasDirectory) {
		return found(path.resolve(command));
	}
	const pathValue = env.PATH ?? env.Path ?? '';
	for (const dir of pathValue.split(windows ? ';' : ':').filter(Boolean)) {
		const file = found(path.join(dir.replace(/^"(?<unquoted>.*)"$/, '$<unquoted>'), command));
		if (file) {
			return file;
		}
	}
	return undefined;
}

/** Whether `file` is a file that can be run: on Windows any file, its extension saying how; elsewhere one marked executable. */
function isExecutable(file: string, windows: boolean): boolean {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) {
			return false;
		}
		if (!windows) {
			fs.accessSync(file, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/** How to start a CLI that was found on PATH, so that its arguments reach it as they are. */
export interface LaunchTarget {
	readonly executable: string;
	/** Ahead of the CLI's own arguments: the script Node runs. */
	readonly args: readonly string[];
	/** Whether its arguments go through cmd.exe, which must be given no text of an agent's or the person's. */
	readonly throughCmd: boolean;
}

/**
 * On Windows a `.cmd` or `.bat` file runs through cmd.exe, which reads `&`, `|` and `%` in its
 * arguments as its own and ends an argument at a line break: a task given to it as an argument could
 * run commands, and one of several lines would lose all but its first. npm's shim for a package's
 * command is such a file, which runs the package's script with Node: that script is run with Node
 * directly - the Node beside the shim, as the shim would, or the one on PATH where it is a program of
 * its own. Anything else stays as it is, marked `throughCmd`: a shim that runs its script with another
 * program, or with options of its own, and one whose Node on PATH is itself a `.cmd`.
 */
export function launchTarget(file: string, platform: NodeJS.Platform = process.platform, env: Environment = process.env): LaunchTarget {
	if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) {
		return { executable: file, args: [], throughCmd: false };
	}
	let text = '';
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		// Not readable: taken for what it is.
	}
	const shim = NPM_SHIM_SCRIPT.exec(text);
	const script = shim?.groups?.script;
	const programs = [...text.matchAll(NPM_SHIM_PROGRAM)].map(match => match.groups?.program ?? '');
	const runsNode = !shim?.[0].startsWith('"%_prog%"') || (programs.length > 0 && programs.every(program => /^(?:%dp0%\\node\.exe|node)$/i.test(program)));
	if (script && runsNode) {
		const dir = path.dirname(file);
		// The shim names it with backslashes, which only Windows reads as separators.
		const target = path.join(dir, ...script.split(/[\\/]/));
		const beside = path.join(dir, 'node.exe');
		const node = fs.existsSync(beside) ? beside : which('node', env, platform);
		if (node && NODE_EXECUTABLE.test(node) && fs.existsSync(target)) {
			return { executable: node, args: [target], throughCmd: false };
		}
	}
	return { executable: file, args: [], throughCmd: true };
}

/** Whether `arg` could not go through cmd.exe as it is (`throughCmd`). */
export function unsafeForCmd(arg: string): boolean {
	return CMD_SPECIAL.test(arg);
}

/**
 * The ids of the models a CLI on this machine lists, for a CLI whose definition says how; undefined
 * when it cannot list them, lists none, or does not answer in time.
 */
export async function cliModels(installed: InstalledCli): Promise<readonly string[] | undefined> {
	const list = installed.cli.listModels;
	if (!list) {
		return undefined;
	}
	const output = await run(installed, list.args, LIST_TIMEOUT_MS);
	const models = output === undefined ? undefined : list.parse(output);
	return models?.length ? models : undefined;
}

/** What a CLI prints for `args`; undefined when it fails, or does not finish within `timeoutMs`. */
function run(installed: InstalledCli, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
	const target = launchTarget(installed.executable);
	// cmd.exe could read a % in the path as a variable.
	if (target.throughCmd && target.executable.includes('%')) {
		return Promise.resolve(undefined);
	}
	const command = target.throughCmd
		// The path in quotes, as a path with spaces would not run otherwise, and the whole line in quotes again, which /s takes off.
		? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `""${target.executable}" ${args.join(' ')}"`] }
		: { file: target.executable, args: [...target.args, ...args] };
	return new Promise(resolve => {
		try {
			execFile(command.file, command.args, { windowsHide: true, timeout: timeoutMs, windowsVerbatimArguments: target.throughCmd }, (err, stdout) => resolve(err ? undefined : stdout));
		} catch {
			resolve(undefined);
		}
	});
}
