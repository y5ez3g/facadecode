/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from './errors';

/**
 * Whether the running process `pid` runs the same program as this one - another Facade window's extension
 * host, say - rather than whatever program got its id after the one that had it ended; undefined where
 * the system cannot tell (Windows).
 */
export function isSameProgram(pid: number): boolean | undefined {
	if (process.platform === 'win32') {
		return undefined;
	}
	const found = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
	const program = found.status === 0 ? found.stdout.trim() : '';
	return program ? path.basename(program) === path.basename(process.execPath) : false;
}

/** How long reading the processes may take before what it found is taken as nothing. */
const PROCESS_READ_TIMEOUT_MS = 5_000;

/**
 * The folders each tree of processes works in - `roots`, and every process under them - by its root: where a
 * CLI went, or a shell it runs did with cd, which its terminal does not see. Nothing for a tree that cannot be
 * looked at, and nothing on Windows, where another process's folder is not to be read.
 */
export async function workingFoldersOf(roots: readonly number[]): Promise<ReadonlyMap<number, readonly string[]>> {
	const found = new Map<number, string[]>();
	if (process.platform === 'win32' || !roots.length) {
		return found;
	}
	const children = new Map<number, number[]>();
	for (const line of (await run('ps', ['-axo', 'pid=,ppid='])).split('\n')) {
		const [pid, parent] = line.trim().split(/\s+/).map(Number);
		if (Number.isInteger(pid) && Number.isInteger(parent)) {
			children.set(parent, [...children.get(parent) ?? [], pid]);
		}
	}
	const rootOf = new Map<number, number>();
	for (const root of roots) {
		for (const queue = [root]; queue.length;) {
			const pid = queue.shift()!;
			if (!rootOf.has(pid)) {
				rootOf.set(pid, root);
				queue.push(...children.get(pid) ?? []);
			}
		}
	}
	const folders = process.platform === 'linux' ? linuxFoldersOf([...rootOf.keys()]) : await lsofFoldersOf([...rootOf.keys()]);
	for (const [pid, folder] of folders) {
		const root = rootOf.get(pid);
		if (root !== undefined) {
			found.set(root, [...found.get(root) ?? [], folder]);
		}
	}
	return found;
}

/** Each process's folder, as `/proc` has it. */
function linuxFoldersOf(pids: readonly number[]): Map<number, string> {
	const folders = new Map<number, string>();
	for (const pid of pids) {
		try {
			folders.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
		} catch {
			// Gone, or another user's
		}
	}
	return folders;
}

/** Each process's folder, as `lsof` says: `p<pid>`, then `n<folder>`, for each. */
async function lsofFoldersOf(pids: readonly number[]): Promise<Map<number, string>> {
	const folders = new Map<number, string>();
	let pid: number | undefined;
	for (const line of (await run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')])).split('\n')) {
		if (line.startsWith('p')) {
			pid = Number(line.slice(1));
		} else if (line.startsWith('n') && pid !== undefined) {
			folders.set(pid, line.slice(1));
		}
	}
	return folders;
}

/** What `command` writes, whatever its exit: `lsof` fails for a process gone meanwhile, yet says the others. */
function run(command: string, args: readonly string[]): Promise<string> {
	return new Promise(resolve => execFile(command, [...args], { encoding: 'utf8', timeout: PROCESS_READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? ''))));
}

/**
 * When the process `pid` started, in milliseconds since the epoch, to the second; undefined where it is gone,
 * or the system does not say (Windows).
 */
export function processStartedAt(pid: number): number | undefined {
	if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	const found = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C' } });
	const time = found.status === 0 ? Date.parse(found.stdout.trim()) : NaN;
	return Number.isNaN(time) ? undefined : time;
}

/** Whether the operating system process `pid` is running, including one of another user's. */
export function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return codeOf(err) === 'EPERM';
	}
}
