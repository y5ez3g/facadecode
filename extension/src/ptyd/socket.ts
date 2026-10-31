/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codeOf } from '../base/errors';

/**
 * ptyd receives whole launch environments and terminal input. On Unix its socket must live in a real private directory
 * owned by this user, and an existing socket must be theirs too. Checked before both connecting and listening; never repair
 * someone else's directory or follow a symlink. The private parent prevents a different user replacing the checked socket.
 */
export function ensurePtydSocket(socket: string, what = 'ptyd socket'): void {
	if (process.platform === 'win32') {
		return;
	}
	const dir = path.dirname(socket);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const uid = os.userInfo().uid;
	const parent = fs.lstatSync(dir);
	if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
		throw new Error(`Cannot use the ${what}: ${dir} must be a private directory owned by this user.`);
	}
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(socket);
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return;
		}
		throw error;
	}
	if (!stat.isSocket() || stat.uid !== uid) {
		throw new Error(`Cannot use the ${what}: ${socket} must be a socket owned by this user.`);
	}
}
