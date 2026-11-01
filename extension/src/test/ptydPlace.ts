/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where a test's own ptyd listens and what its runs run, alike on every platform: Windows listens on named pipes, not files, and
// has no POSIX shell, so a run's program is Node.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PtydPlace {
	/** A private folder of the test's own. */
	readonly dir: string;
	/** Where its ptyd listens. */
	readonly socket: string;
	/** Another listening place beside it, named `name`. */
	pipe(name: string): string;
}

/** A ptyd place of a test's own: a private folder, its sockets there, or on Windows named pipes of the folder's unique name. */
export function ptydPlace(prefix: string): PtydPlace {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.chmodSync(dir, 0o700);
	const pipe = (name: string) => process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}-${name}` : path.join(dir, `${name}.sock`);
	return { dir, socket: pipe('ptyd'), pipe };
}

/** What a test's program is given: its PATH and terminal type, and on Windows the system folder Node needs. */
export function programEnv(): { [name: string]: string } {
	return {
		PATH: process.env.PATH ?? '',
		TERM: 'xterm-256color',
		...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
	};
}

/** A run's program as ptyd spawns it: Node, running `source`. */
export function program(source: string): { readonly file: string; readonly args: string[]; readonly env: { [name: string]: string } } {
	return { file: process.execPath, args: ['-e', source], env: programEnv() };
}

/** A program that runs, doing nothing, until it is ended. */
export const IDLE = 'setInterval(() => {}, 1000);';

/** Writes `text` to its terminal, then ends with `code` once it is written: a terminal's writes may be asynchronous. */
export const finish = (text: string, code: number) => `process.stdout.write(${text}, () => process.exit(${code}));`;

/**
 * Reads its terminal raw, as an agent CLI does, and runs `then` with each line typed - `line`, up to Enter - in turn. Without echo:
 * what it shows is what it writes.
 */
export const eachLine = (then: string) =>
	`process.stdin.setRawMode(true); let typed = ''; process.stdin.on('data', chunk => { typed += chunk; for (let end = /\\r\\n?|\\n/.exec(typed); end; end = /\\r\\n?|\\n/.exec(typed)) { const line = typed.slice(0, end.index); typed = typed.slice(end.index + end[0].length); ${then} } });`;
