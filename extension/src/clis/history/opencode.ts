/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// OpenCode 2.x's native session index. Shared servers may contain many roots: each row's directory is authoritative.

import * as path from 'path';
import { variableOf } from '../environment';
import { homeOf } from '../executable';
import { inScope, titleOf } from './scope';
import { openReadOnly } from './sqlite';
import type { Candidate, VendorStore } from './store';

export const OPENCODE_SESSION_ID = /^ses_[a-zA-Z0-9]+$/;

export function openCodeCandidates(file: string, directories: readonly string[]): Candidate[] {
	const db = openReadOnly(file);
	if (!db) { return []; }
	try {
		const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
		const table = tables.has('session_v2') ? 'session_v2' : tables.has('session') ? 'session' : undefined;
		if (!table) { return []; }
		const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
		const archived = columns.has('time_archived') ? 'AND time_archived IS NULL' : '';
		const rows = db.prepare(`SELECT id, directory AS cwd, title, time_updated AS at FROM ${table} WHERE parent_id IS NULL ${archived}`).all();
		return rows.flatMap(row => {
			if (typeof row.id !== 'string' || !OPENCODE_SESSION_ID.test(row.id) || typeof row.cwd !== 'string'
				|| !path.isAbsolute(row.cwd) || !inScope(row.cwd, directories) || typeof row.at !== 'number' || !(row.at > 0)) { return []; }
			const title = typeof row.title === 'string' ? titleOf(row.title) : undefined;
			return [{ cli: 'opencode', file: `${file}#${row.id}`, at: row.at, sessionId: row.id,
				found: { sessionId: row.id, cwd: path.normalize(row.cwd), ...title ? { title } : {} } }];
		});
	} catch {
		return [];
	} finally {
		db.close();
	}
}

export const OPENCODE_STORE: VendorStore = {
	cli: 'opencode',
	dirOf: (env, cwd) => {
		const xdg = variableOf(env, 'XDG_DATA_HOME');
		const data = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env), '.local', 'share'), 'opencode');
		const file = variableOf(env, 'OPENCODE_DB') || 'opencode.db';
		return file === ':memory:' ? file : path.resolve(cwd, data, file);
	},
	candidates: openCodeCandidates,
	read: async candidate => candidate.found
};
