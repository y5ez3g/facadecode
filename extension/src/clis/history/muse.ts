/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Muse Code's conversation store, read for list metadata only (LIFECYCLE-3.2): `muse` in its data folder, its `session-index.db` a
// row per conversation that its own Resume picker lists - ID, the real path of the folder it began in, first prompt, a name given
// by `/rename`, last activity and its log. Its delegated agents' conversations have no row. A fixture-tested compatibility reader of
// 1.4.14's index, probed with a real Muse Code (CLIS-5.1).

import * as fs from 'fs';
import * as path from 'path';
import type { Environment } from '../environment';
import { variableOf } from '../environment';
import { homeOf } from '../executable';
import { SESSION_ID } from '../identity';
import { inScope, titleOf } from './scope';
import { openReadOnly } from './sqlite';
import type { Candidate, Found, VendorStore } from './store';

/** A conversation row as read. */
interface Row {
	readonly id: unknown;
	readonly cwd: unknown;
	readonly prompt: unknown;
	readonly name: unknown;
	readonly at: unknown;
	readonly log: unknown;
}

/** Muse Code's data folder: `muse` in `XDG_DATA_HOME` where that is an absolute path, else in `.local/share` of the home folder. */
export function museDataDir(env: Environment): string {
	const set = variableOf(env, 'XDG_DATA_HOME');
	return path.join(set && path.isAbsolute(set) ? set : path.join(homeOf(env), '.local', 'share'), 'muse');
}

/**
 * The conversations of the index at `dir` in `directories` or a folder below them that Muse Code itself would offer to resume: one
 * with a prompt, valid, whose log is there. Each is read whole from its row; columns a version lacks are done without.
 */
export function museCandidates(dir: string, directories: readonly string[]): Candidate[] {
	const index = path.join(dir, 'session-index.db');
	const db = openReadOnly(index);
	if (!db) {
		return [];
	}
	let rows: Row[];
	try {
		const columns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as unknown as { readonly name: unknown }[]).map(column => column.name));
		const at = columns.has('msp_last_activity_at_us') ? 'COALESCE(msp_last_activity_at_us, updated_at_us)' : 'updated_at_us';
		const name = columns.has('session_name') ? 'session_name' : 'NULL';
		const root = columns.has('msp_kind') ? `AND (msp_kind IS NULL OR msp_kind = 'root')` : '';
		rows = db.prepare(`SELECT session_id AS id, workspace_root AS cwd, first_user_prompt AS prompt, ${name} AS name, ${at} AS at, session_log_path AS log
			FROM sessions WHERE status = 'valid' AND prompt_count > 0 ${root}`).all() as unknown as Row[];
	} catch {
		return [];
	} finally {
		db.close();
	}
	const candidates: Candidate[] = [];
	for (const row of rows) {
		const at = typeof row.at === 'number' || typeof row.at === 'bigint' ? Number(row.at) / 1000 : NaN;
		if (typeof row.id !== 'string' || !SESSION_ID.test(row.id) || typeof row.cwd !== 'string' || !inScope(row.cwd, directories)
			|| !(at > 0) || typeof row.log !== 'string' || !fs.existsSync(row.log)) {
			continue;
		}
		// A name the person gave it, else what they first asked
		const named = typeof row.name === 'string' && row.name.trim() ? row.name : typeof row.prompt === 'string' ? row.prompt : '';
		const title = titleOf(named);
		const found: Found = { sessionId: row.id, cwd: row.cwd, ...title ? { title } : {} };
		candidates.push({ cli: 'muse', file: `${index}#${row.id}`, at: Math.floor(at), sessionId: row.id, found });
	}
	return candidates;
}

/** Muse Code's store: its data folder, which `XDG_DATA_HOME` moves and no variable of its own does. */
export const MUSE_STORE: VendorStore = {
	cli: 'muse',
	dirOf: (env: Environment) => museDataDir(env),
	candidates: museCandidates,
	read: async candidate => candidate.found
};
