/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The ptyds listening for one Facade data directory, each by the build it runs from (ARCHITECTURE-2.4). A ptyd records itself
// once it listens and removes its record as it exits, so that a window of another build finds the runs it holds there and starts
// none of its own there. A record whose ptyd is gone stays until a window finds nothing listening at its socket.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** One ptyd as it recorded itself. */
export interface PtydRecord {
	readonly protocol: number;
	readonly build: string;
	readonly socket: string;
	readonly pid: number;
}

/** The folder of records beside ptyd's log in the Facade data directory's `ptyd` folder. */
export function ptydRecords(ptydFolder: string): string {
	return path.join(ptydFolder, 'sockets');
}

function fileOf(folder: string, socket: string): string {
	return path.join(folder, `${crypto.createHash('sha256').update(socket).digest('hex').slice(0, 16)}.json`);
}

/** Records the ptyd that now listens at `record.socket`, replacing any earlier record of that socket. */
export function recordPtyd(folder: string, record: PtydRecord): void {
	fs.mkdirSync(folder, { recursive: true });
	const file = fileOf(folder, record.socket);
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(record));
	fs.renameSync(temporary, file);
}

/** Removes the record of `socket`, where it is the record of process `pid`: a later ptyd's record of that socket stays. */
export function forgetPtyd(folder: string, socket: string, pid?: number): void {
	const file = fileOf(folder, socket);
	try {
		if (pid !== undefined) {
			const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PtydRecord>;
			if (record.pid !== pid) {
				return;
			}
		}
		fs.rmSync(file, { force: true });
	} catch {
		// Gone already, or unreadable: nothing to remove
	}
}

/** The ptyds recorded in `folder`; a record that cannot be read is left out. */
export function recordedPtyds(folder: string): readonly PtydRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(folder).filter(name => name.endsWith('.json'));
	} catch {
		return [];
	}
	const records: PtydRecord[] = [];
	for (const name of names.sort()) {
		try {
			const value = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as Partial<PtydRecord>;
			if (typeof value.protocol === 'number' && Number.isInteger(value.protocol) && typeof value.build === 'string' && /^[0-9a-f]{1,64}$/.test(value.build)
				&& typeof value.socket === 'string' && value.socket.length > 0 && typeof value.pid === 'number') {
				records.push({ protocol: value.protocol, build: value.build, socket: value.socket, pid: value.pid });
			}
		} catch {
			// Being written, or damaged: left out
		}
	}
	return records;
}

/**
 * The build a ptyd script of `version` at `script` is: its installation and the file itself, so that two installations - an update
 * beside the version it replaces, the same version installed twice, a script rebuilt in place - never share a ptyd, while every
 * window of one installation shares its own (ARCHITECTURE-2.4).
 */
export function ptydBuild(script: string, version: string): string {
	let written = '';
	try {
		written = String(fs.statSync(script).mtimeMs);
	} catch {
		// Not there to read: its path and version name it alone
	}
	return crypto.createHash('sha256').update(`${version}\0${path.resolve(script)}\0${written}`).digest('hex').slice(0, 10);
}
