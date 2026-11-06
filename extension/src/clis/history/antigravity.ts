/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Antigravity's conversation store, read for list metadata only (LIFECYCLE-3.2): `.gemini/antigravity-cli` in the home folder, its
// `conversation_summaries.db` a row per conversation - ID, generated title, first prompt, folders and last change - and
// `conversations/<id>.db` each conversation it can still resume: it keeps 500 and drops the oldest's file, not its row. A
// fixture-tested compatibility reader of 1.4.10's store, probed with a real Antigravity (CLIS-5.1).

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Environment } from '../environment';
import { homeOf } from '../executable';
import { SESSION_ID } from '../identity';
import { Scope, titlesOf } from './scope';
import { openReadOnly } from './sqlite';
import type { Candidate, Found, VendorStore } from './store';

/** A summary row as read. */
interface Row {
	readonly id: unknown;
	readonly title: unknown;
	readonly preview: unknown;
	readonly at: unknown;
	readonly uris: unknown;
}

/** The folders of a row's `workspace_uris`: its working directory and those `--add-dir` gave it, sorted, as `PWD` named them. */
function foldersOf(uris: unknown): string[] {
	let list: unknown;
	try {
		list = typeof uris === 'string' && uris ? JSON.parse(uris) : [];
	} catch {
		return [];
	}
	const folders: string[] = [];
	for (const uri of Array.isArray(list) ? list : []) {
		try {
			if (typeof uri === 'string' && uri.startsWith('file:')) {
				folders.push(fileURLToPath(uri));
			}
		} catch {
			// Not a local folder
		}
	}
	return folders;
}

/**
 * The conversations of the store at `dir` in `scope` or a folder below it: one its own agents began - a subagent's, with a
 * parent - not listed, as Antigravity lists none either, nor one whose file it dropped. Each is read whole from its row.
 */
export function antigravityCandidates(dir: string, scope: Scope): Candidate[] {
	return rowsOf(dir).flatMap(row => antigravityCandidate(dir, row, scope) ?? []);
}

/** Conversation `sessionId`, by its summary row alone. */
export function antigravityCandidateOf(dir: string, scope: Scope, sessionId: string): Candidate | undefined {
	const [row] = SESSION_ID.test(sessionId) ? rowsOf(dir, sessionId) : [];
	return row && antigravityCandidate(dir, row, scope);
}

/** The summary rows of the store at `dir` of the conversations Antigravity lists - `sessionId`'s alone where it is given. */
function rowsOf(dir: string, sessionId?: string): Row[] {
	const db = openReadOnly(path.join(dir, 'conversation_summaries.db'));
	if (!db) {
		return [];
	}
	try {
		const query = `SELECT conversation_id AS id, title, preview, last_modified_time AS at, workspace_uris AS uris
			FROM conversation_summaries WHERE parent_conversation_id = ''`;
		return (sessionId === undefined ? db.prepare(query).all() : db.prepare(`${query} AND conversation_id = ?`).all(sessionId)) as unknown as Row[];
	} catch {
		return [];
	} finally {
		db.close();
	}
}

/** The conversation `row` of the store at `dir`, read whole from its row; none where it is no conversation of `scope`'s, or its file is dropped. */
function antigravityCandidate(dir: string, row: Row, scope: Scope): Candidate | undefined {
	const at = typeof row.at === 'string' ? Date.parse(row.at.replace(' ', 'T')) : NaN;
	if (typeof row.id !== 'string' || !SESSION_ID.test(row.id) || !(at > 0) || !fs.existsSync(path.join(dir, 'conversations', `${row.id}.db`))) {
		return undefined;
	}
	// This native set is sorted and loses the original cwd when --add-dir is used. Keep the alternatives, never guess.
	const folders = [...new Set(foldersOf(row.uris))];
	const choices = folders.filter(folder => scope.includes(folder));
	const cwd = choices[0];
	if (cwd === undefined) {
		return undefined;
	}
	const found: Found = { sessionId: row.id, cwd, ...folders.length > 1 ? { cwdChoices: choices } : {}, ...titlesOf(typeof row.title === 'string' ? row.title : undefined, typeof row.preview === 'string' ? row.preview : undefined) };
	return { cli: 'agy', file: `${path.join(dir, 'conversation_summaries.db')}#${row.id}`, at, sessionId: row.id, found };
}

/** Antigravity's store: `.gemini/antigravity-cli` in the home folder, which no variable of its moves. */
export const ANTIGRAVITY_STORE: VendorStore = {
	cli: 'agy',
	dirOf: (env: Environment) => path.join(homeOf(env), '.gemini', 'antigravity-cli'),
	candidates: antigravityCandidates,
	candidateOf: antigravityCandidateOf,
	read: async candidate => candidate.found
};
