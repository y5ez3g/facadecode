/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// OpenCode 2.x's native session index. Shared servers may contain many roots: each row's directory is authoritative.

import * as path from 'path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { variableOf } from '../environment';
import { xdgDirOf } from '../executable';
import { Scope, titlesOf } from './scope';
import { openReadOnly } from './sqlite';
import type { Candidate, VendorStore } from './store';

export const OPENCODE_SESSION_ID = /^ses_[a-zA-Z0-9]+$/;

/** The query of the root sessions the index `db` lists - not a child session's, nor an archived one - by the table its version has. */
function sessionsQuery(db: DatabaseSync): string | undefined {
	const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
	const table = tables.has('session_v2') ? 'session_v2' : tables.has('session') ? 'session' : undefined;
	if (!table) { return undefined; }
	const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
	const archived = columns.has('time_archived') ? 'AND time_archived IS NULL' : '';
	return `SELECT id, directory AS cwd, title, time_updated AS at FROM ${table} WHERE parent_id IS NULL ${archived}`;
}

/** The session `row` of the index `file`, read whole from its row; none where it is not one of `scope`'s. */
function sessionCandidate(file: string, row: Record<string, SQLOutputValue>, scope: Scope): Candidate | undefined {
	if (typeof row.id !== 'string' || !OPENCODE_SESSION_ID.test(row.id) || typeof row.cwd !== 'string'
		|| !path.isAbsolute(row.cwd) || !scope.includes(row.cwd) || typeof row.at !== 'number' || !(row.at > 0)) { return undefined; }
	const titles = titlesOf(typeof row.title === 'string' ? row.title : undefined);
	return { cli: 'opencode', file: `${file}#${row.id}`, at: row.at, sessionId: row.id,
		found: { sessionId: row.id, cwd: path.normalize(row.cwd), ...titles } };
}

export function openCodeCandidates(file: string, scope: Scope): Candidate[] {
	const db = openReadOnly(file);
	if (!db) { return []; }
	try {
		const query = sessionsQuery(db);
		return query ? db.prepare(query).all().flatMap(row => sessionCandidate(file, row, scope) ?? []) : [];
	} catch {
		return [];
	} finally {
		db.close();
	}
}

/** Session `sessionId`, by its row alone. */
export function openCodeCandidateOf(file: string, scope: Scope, sessionId: string): Candidate | undefined {
	if (!OPENCODE_SESSION_ID.test(sessionId)) { return undefined; }
	const db = openReadOnly(file);
	if (!db) { return undefined; }
	try {
		const query = sessionsQuery(db);
		const row = query ? db.prepare(`${query} AND id = ?`).get(sessionId) : undefined;
		return row && sessionCandidate(file, row, scope);
	} catch {
		return undefined;
	} finally {
		db.close();
	}
}

export const OPENCODE_STORE: VendorStore = {
	cli: 'opencode',
	dirOf: (env, cwd) => {
		const data = path.join(xdgDirOf('data', env), 'opencode');
		const file = variableOf(env, 'OPENCODE_DB') || 'opencode.db';
		return file === ':memory:' ? file : path.resolve(cwd, data, file);
	},
	candidates: openCodeCandidates,
	candidateOf: openCodeCandidateOf,
	read: async candidate => candidate.found
};
