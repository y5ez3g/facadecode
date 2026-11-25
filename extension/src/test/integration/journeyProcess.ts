/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { codeOf } from '../../base/errors';

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
