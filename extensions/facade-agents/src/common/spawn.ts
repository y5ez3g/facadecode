/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/*
 * Starting a program from an argument array on every platform. Node refuses to start a `.cmd` or
 * `.bat` without a shell (CVE-2024-27980), and `npm`, `npx` and most tools installed by npm are
 * exactly that on Windows. Those go through `cmd.exe /d /s /c` with every argument escaped for
 * cmd's parser, following cross-spawn (MIT): https://github.com/moxystudio/node-cross-spawn.
 * Nothing here ever joins arguments into a string for a POSIX shell.
 */

export type Environment = { readonly [name: string]: string | undefined };

const isWindows = process.platform === 'win32';

/** Where `command` resolves on `PATH`, with `PATHEXT` on Windows. Undefined if nowhere. */
export function which(command: string, env: Environment = process.env): string | undefined {
	const hasDirectory = command.includes('/') || (isWindows && command.includes('\\'));
	const extensions = isWindows ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
	const candidates = (base: string) => isWindows && path.extname(base) === '' ? extensions.map(ext => base + ext.toLowerCase()) : [base, ...(isWindows ? extensions.map(ext => base + ext.toLowerCase()) : [])];
	if (hasDirectory) {
		return candidates(path.resolve(command)).find(isExecutable);
	}
	const pathValue = env.PATH ?? env.Path ?? '';
	for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
		const found = candidates(path.join(dir.replace(/^"(.*)"$/, '$1'), command)).find(isExecutable);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function isExecutable(file: string): boolean {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) {
			return false;
		}
		if (!isWindows) {
			fs.accessSync(file, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

export interface Spawnable {
	readonly command: string;
	readonly args: readonly string[];
	/** Set when the command line was built for cmd.exe and must reach it unchanged. */
	readonly windowsVerbatimArguments?: boolean;
}

const cmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/g;

/** Escapes one argument for cmd.exe; `doubleEscape` for npm's `node_modules/.bin/*.cmd` shims. */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
	// Backslashes before a quote, and at the end, double; a quote becomes \" (https://qntm.org/cmd).
	let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
	escaped = `"${escaped}"`.replace(cmdMetaCharacters, '^$1');
	return doubleEscape ? escaped.replace(cmdMetaCharacters, '^$1') : escaped;
}

/** How to start `argv`: directly, or through cmd.exe for a batch file on Windows. */
export function toSpawnable(argv: readonly string[], env: Environment = process.env): Spawnable {
	if (argv.length === 0) {
		throw new Error('Nothing to run: the command is empty.');
	}
	const resolved = which(argv[0], env) ?? argv[0];
	if (!isWindows || !/\.(cmd|bat)$/i.test(resolved)) {
		return { command: resolved, args: argv.slice(1) };
	}
	const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
	const line = [path.normalize(resolved).replace(cmdMetaCharacters, '^$1'), ...argv.slice(1).map(arg => escapeCmdArgument(arg, doubleEscape))].join(' ');
	return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/** Ends a process and everything it started. */
export function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) {
		return;
	}
	if (isWindows) {
		execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone */ });
		return;
	}
	try {
		// Started with `detached`, the child leads its own process group.
		process.kill(-child.pid, 'SIGTERM');
		setTimeout(() => {
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				// Gone.
			}
		}, 5000).unref();
	} catch {
		child.kill('SIGKILL');
	}
}

export interface RunResult {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	/** Why it could not start, when it could not. */
	readonly spawnError?: string;
	readonly ms: number;
}

export interface RunOptions {
	readonly cwd: string;
	readonly env: Environment;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	/** Receives output as it arrives, stdout and stderr interleaved. */
	readonly onOutput?: (chunk: Buffer) => void;
}

/** Runs `argv` to its end or its timeout, and kills its whole tree on either timeout or cancel. */
export function runProcess(argv: readonly string[], options: RunOptions): Promise<RunResult> {
	const started = Date.now();
	return new Promise(resolve => {
		let spawnable: Spawnable;
		try {
			spawnable = toSpawnable(argv, options.env);
		} catch (err) {
			resolve({ exitCode: null, timedOut: false, cancelled: false, spawnError: (err as Error).message, ms: 0 });
			return;
		}
		const spawnOptions: SpawnOptions = {
			cwd: options.cwd,
			env: options.env as NodeJS.ProcessEnv,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			detached: !isWindows,
			windowsVerbatimArguments: spawnable.windowsVerbatimArguments
		};
		let child: ChildProcess;
		try {
			child = spawn(spawnable.command, [...spawnable.args], spawnOptions);
		} catch (err) {
			resolve({ exitCode: null, timedOut: false, cancelled: false, spawnError: (err as Error).message, ms: Date.now() - started });
			return;
		}
		let timedOut = false;
		let cancelled = false;
		let settled = false;
		const finish = (result: Omit<RunResult, 'ms' | 'timedOut' | 'cancelled'>) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
			resolve({ ...result, timedOut, cancelled, ms: Date.now() - started });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, options.timeoutMs);
		const onAbort = () => {
			cancelled = true;
			killTree(child);
		};
		options.signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout?.on('data', (chunk: Buffer) => options.onOutput?.(chunk));
		child.stderr?.on('data', (chunk: Buffer) => options.onOutput?.(chunk));
		child.on('error', err => finish({ exitCode: null, spawnError: err.message }));
		child.on('close', code => finish({ exitCode: code }));
	});
}

/** Keeps the last `lines` lines of a stream of output, without control sequences. */
export class OutputTail {

	private readonly lines: string[] = [];
	private partial = '';

	constructor(private readonly max: number) { }

	push(chunk: Buffer | string): void {
		const text = (this.partial + chunk.toString()).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
		const parts = text.split(/\r?\n/);
		this.partial = parts.pop() ?? '';
		for (const line of parts) {
			this.lines.push(line);
			if (this.lines.length > this.max) {
				this.lines.shift();
			}
		}
	}

	toString(): string {
		const all = this.partial ? [...this.lines, this.partial] : this.lines;
		return all.slice(-this.max).join('\n');
	}
}
