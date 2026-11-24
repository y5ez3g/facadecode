/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { codeOf } from '../../base/errors';
import { AGENTS_LOG } from '../../record/log';

/** The whole newline-terminated PID that this run's fake CLI published. */
export function fixturePid(file: string): number | undefined {
	try {
		const text = fs.readFileSync(file, 'utf8');
		const pid = /^[1-9]\d*\r?\n$/.test(text) ? Number(text) : NaN;
		return Number.isSafeInteger(pid) ? pid : undefined;
	} catch (error) {
		const code = codeOf(error);
		if (code !== 'ENOENT' && code !== 'EBUSY') { throw error; }
		return undefined;
	}
}

/** Windows signal zero can fail for access reasons even while the process is live. */
export function pidGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return codeOf(error) === 'ESRCH';
	}
}

const exec = promisify(execFile);

/** The OS creation time at its full resolution. Parsing it as a JavaScript Date would lose ticks. */
export async function windowsProcessStart(pid: number, timeout = 5_000): Promise<string | undefined> {
	if (!Number.isSafeInteger(pid) || pid <= 0) { return undefined; }
	try {
		const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
			`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)`],
		{ encoding: 'utf8', timeout, windowsHide: true });
		const ticks = stdout.trim();
		return /^[1-9]\d{0,18}$/.test(ticks) ? ticks : undefined;
	} catch {
		return undefined;
	}
}

/** Read only the matching result from the tail of the isolated workspace's agents log. */
export function legacyStopResult(home: string | undefined, run: string): string | undefined {
	if (!home) { return undefined; }
	try {
		const root = path.join(home, 'extension', 'workspaces');
		for (const workspace of fs.readdirSync(root)) {
			try {
				const file = fs.openSync(path.join(root, workspace, AGENTS_LOG), 'r');
				try {
					const tail = Buffer.alloc(64 * 1024);
					const start = Math.max(0, fs.fstatSync(file).size - tail.length);
					const bytes = fs.readSync(file, tail, 0, tail.length, start);
					for (const line of tail.toString('utf8', 0, bytes).split('\n').reverse()) {
						const match = /^\S+ Ending the process of (\S+): (terminated|already_exited|unconfirmed|failed)$/.exec(line.trimEnd());
						if (match?.[1] === run) { return match[2]; }
					}
				} finally {
					fs.closeSync(file);
				}
			} catch { /* The test still reports its original failure if a log is unavailable. */ }
		}
	} catch { /* The isolated workspace log directory may not have been made. */ }
	return undefined;
}
