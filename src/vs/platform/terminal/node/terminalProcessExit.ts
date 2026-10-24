/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { timeout } from '../../../base/common/async.js';
import { isWindows } from '../../../base/common/platform.js';
import { join } from '../../../base/common/path.js';

interface IProcessIdentity {
	readonly pid: number;
	readonly parent: number;
	readonly started: string;
	readonly alive: boolean;
}

/** Facade Code: native identities, read on the terminal's host, without trusting synthetic pty exit events. */
async function processes(): Promise<readonly IProcessIdentity[]> {
	const executable = isWindows ? join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/ps';
	const args = isWindows
		? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { '{0} {1} A {2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().Ticks }`]
		: ['-axo', 'pid=,ppid=,stat=,lstart='];
	const output = await new Promise<string>((resolve, reject) => {
		execFile(executable, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
	const result = output.split(/\r?\n/).flatMap(line => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
		return match ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[4], alive: !/^[ZX]/.test(match[3]) }] : [];
	});
	if (!result.length) {
		throw new Error('Could not read native terminal process identities.');
	}
	return result;
}

/**
 * Facade Code: retains a terminal's native process tree before shutdown, including children after their shell exits.
 * A timeout retains the identities for an explicit retry. No PID is signalled here; reuse cannot kill another process.
 */
export class TerminalProcessExitMonitor {
	private readonly identities = new Map<number, string>();

	private constructor(root: IProcessIdentity, snapshot: readonly IProcessIdentity[]) {
		this.identities.set(root.pid, root.started);
		this.includeChildren(snapshot);
	}

	static async create(pid: number): Promise<TerminalProcessExitMonitor | undefined> {
		const snapshot = await processes();
		const root = snapshot.find(item => item.pid === pid);
		return root ? new TerminalProcessExitMonitor(root, snapshot) : undefined;
	}

	/** Include children only of still-matching identities, never of a reused PID. */
	private includeChildren(snapshot: readonly IProcessIdentity[]): void {
		const byPid = new Map(snapshot.map(item => [item.pid, item]));
		let added: boolean;
		do {
			added = false;
			for (const item of snapshot) {
				const parent = byPid.get(item.parent);
				if (!this.identities.has(item.pid) && parent && this.identities.get(parent.pid) === parent.started) {
					this.identities.set(item.pid, item.started);
					added = true;
				}
			}
		} while (added);
	}

	/** Whether all observed native processes ended within the bound; zombies have already released their files. */
	async wait(milliseconds: number): Promise<boolean> {
		const deadline = Date.now() + milliseconds;
		do {
			const snapshot = await processes();
			this.includeChildren(snapshot);
			if (!snapshot.some(item => item.alive && this.identities.get(item.pid) === item.started)) {
				return true;
			}
			if (Date.now() >= deadline) {
				return false;
			}
			await timeout(50);
		} while (true);
	}
}
