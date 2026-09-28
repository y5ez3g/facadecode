/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { normalizePath } from './glob';

/*
 * How a lead's MCP process finds its Facade window. The plugin's `.mcp.json` is the same for every
 * session, so it cannot carry a session's token. Each window instead writes one small file naming
 * its pipe, a lead token, and its folders; the MCP process picks the live window whose folders
 * hold the folder it was started in. The files are the user's own, like everything the agents
 * already run as.
 */

export interface InstanceRecord {
	readonly pipe: string;
	readonly token: string;
	/** The extension host's process: a file whose process is gone is stale. */
	readonly pid: number;
	readonly folders: readonly string[];
	readonly updatedAt: number;
}

export function writeInstance(dir: string, id: string, record: InstanceRecord): void {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.json`);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
	fs.renameSync(temp, file);
}

export function removeInstance(dir: string, id: string): void {
	fs.rmSync(path.join(dir, `${id}.json`), { force: true });
}

/** The live window whose folders contain `cwd` most closely. */
export function findInstance(dir: string, cwd: string, isAlive: (pid: number) => boolean = processAlive): InstanceRecord | undefined {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
	} catch {
		return undefined;
	}
	const target = comparable(cwd);
	let best: { record: InstanceRecord; length: number } | undefined;
	for (const name of entries) {
		let record: InstanceRecord;
		try {
			record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
		} catch {
			continue;
		}
		if (!isAlive(record.pid)) {
			continue;
		}
		for (const folder of record.folders) {
			const root = comparable(folder);
			if ((target === root || target.startsWith(`${root}/`)) && (!best || root.length > best.length)) {
				best = { record, length: root.length };
			}
		}
	}
	return best?.record;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function comparable(file: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(file);
	} catch {
		resolved = path.resolve(file);
	}
	const normalized = normalizePath(resolved);
	return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
}
