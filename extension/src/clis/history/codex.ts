/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Codex's conversation store, read for list metadata only (LIFECYCLE-3.2): `sessions/<year>/<month>/<day>/rollout-*.jsonl` in its
// home, each rollout's first line a `session_meta` record with the conversation's ID, working directory and start. There is no
// index by folder, so every rollout is a candidate, read only once per picker session. A fixture-tested compatibility reader.

import * as path from 'path';
import * as fs from 'fs';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { isJsonObject } from '../../base/json';
import { SESSION_ID } from '../identity';
import { headLines, mtimeOf, namesIn, PROMPT_BYTES, Scope, titleOf, titlesOf } from './scope';
import { openReadOnly } from './sqlite';
import type { Environment } from '../environment';
import { variableOf } from '../environment';
import { homeOf } from '../executable';
import type { Candidate, Found, VendorStore } from './store';

/** The query of the threads of Codex's index `db`, by the columns its version has. */
function threadsQuery(db: DatabaseSync): string {
	const columns = new Set((db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]).map(row => row.name));
	const at = columns.has('recency_at_ms') ? 'COALESCE(recency_at_ms, updated_at * 1000)' : 'updated_at * 1000';
	const name = columns.has('name') ? 'COALESCE(name, title)' : 'title';
	const mode = columns.has('history_mode') ? 'history_mode' : "'legacy'";
	return `SELECT id, cwd, ${name} AS title, ${at} AS at, rollout_path, ${mode} AS history_mode, archived, source FROM threads`;
}

/**
 * The thread `row` of the index `file` as Resume lists it, read whole from its row: none where it lists none of it - archived, a
 * subagent's, another folder's, or its rollout gone.
 */
function threadCandidate(file: string, row: Record<string, SQLOutputValue>, scope: Scope): Candidate | undefined {
	if (typeof row.id !== 'string' || row.archived || typeof row.cwd !== 'string' || (scope.directories.length && !scope.includes(row.cwd))
		|| typeof row.at !== 'number' || !(row.at > 0) || (typeof row.source === 'string' && row.source.includes('subagent'))
		|| (row.history_mode !== 'paginated' && (typeof row.rollout_path !== 'string' || !fs.existsSync(row.rollout_path)))) {
		return undefined;
	}
	const titles = titlesOf(typeof row.title === 'string' ? row.title : undefined);
	return { cli: 'codex', file: `${file}#${row.id}`, at: row.at, sessionId: row.id, found: { sessionId: row.id, cwd: row.cwd, ...titles } };
}

/** The session ID a rollout's name ends with, as Codex names them. */
function rolloutId(name: string): string | undefined {
	return /([0-9a-f-]{36})\.jsonl$/i.exec(name)?.[1];
}

/** The rollouts of the store whose names `taken` takes, by day as Codex keeps them, with their last change. */
function rollouts(codexHome: string, taken: (name: string) => boolean): Candidate[] {
	const root = path.join(codexHome, 'sessions');
	const candidates: Candidate[] = [];
	for (const year of namesIn(root, /^\d{4}$/)) {
		for (const month of namesIn(path.join(root, year), /^\d{2}$/)) {
			for (const day of namesIn(path.join(root, year, month), /^\d{2}$/)) {
				const dir = path.join(root, year, month, day);
				for (const name of namesIn(dir, /^rollout-.*\.jsonl$/)) {
					if (!taken(name)) { continue; }
					const file = path.join(dir, name);
					const at = mtimeOf(file);
					if (at !== undefined) {
						candidates.push({ cli: 'codex', file, at });
					}
				}
			}
		}
	}
	return candidates;
}

/** Every rollout of the store: Codex keeps no index by folder. */
export function codexCandidates(codexHome: string, scope: Scope = new Scope([])): Candidate[] {
	const candidates: Candidate[] = [];
	const indexed = new Set<string>();
	// Current Codex keeps paginated sessions in SQLite. Rollouts remain a fallback for pre-index and older installations.
	const file = path.join(codexHome, 'state_5.sqlite');
	const db = openReadOnly(file);
	if (db) {
		try {
			for (const row of db.prepare(threadsQuery(db)).all()) {
				if (typeof row.id !== 'string' || !SESSION_ID.test(row.id)) { continue; }
				indexed.add(row.id);
				const candidate = threadCandidate(file, row, scope);
				if (candidate) { candidates.push(candidate); }
			}
		} catch {
			// A missing/older schema cannot prevent reading native rollouts.
		} finally { db.close(); }
	}
	candidates.push(...rollouts(codexHome, name => { const id = rolloutId(name); return !id || !indexed.has(id); }));
	return candidates;
}

/**
 * Conversation `sessionId`, by its ID: its thread in the index - which decides, as it does for the list - else, not indexed, the
 * rollout named for it, its most recently changed where it has several.
 */
export function codexCandidateOf(codexHome: string, scope: Scope, sessionId: string): Candidate | undefined {
	if (!SESSION_ID.test(sessionId)) {
		return undefined;
	}
	const file = path.join(codexHome, 'state_5.sqlite');
	const db = openReadOnly(file);
	if (db) {
		try {
			const row = db.prepare(`${threadsQuery(db)} WHERE id = ?`).get(sessionId);
			if (row) {
				return threadCandidate(file, row, scope);
			}
		} catch {
			// A missing/older schema cannot prevent reading native rollouts.
		} finally { db.close(); }
	}
	return rollouts(codexHome, name => rolloutId(name) === sessionId).sort((a, b) => b.at - a.at)[0];
}

/** The first prompt the person gave among `lines`: a user message's text, not the environment context Codex adds. */
function firstPrompt(lines: readonly { readonly [key: string]: unknown }[]): string | undefined {
	for (const line of lines) {
		const payload = line.type === 'response_item' && isJsonObject(line.payload) ? line.payload : undefined;
		if (payload?.role !== 'user' || !Array.isArray(payload.content)) {
			continue;
		}
		const text = payload.content.map(part => isJsonObject(part) && typeof part.text === 'string' ? part.text : undefined).find(each => each !== undefined);
		if (text?.trim() && !text.trim().startsWith('<')) {
			return text;
		}
	}
	return undefined;
}

/** A Codex conversation's list metadata from its rollout's head; none where its first line is no `session_meta` record. */
export async function codexConversation(candidate: Candidate): Promise<Found | undefined> {
	// Codex writes its instructions, skills and environment before the first prompt: read on for it where the head ends first
	const head = await headLines(candidate.file);
	const lines = head[0]?.type === 'session_meta' && firstPrompt(head.slice(1)) !== undefined ? head : await headLines(candidate.file, PROMPT_BYTES);
	const meta = lines[0];
	const payload = meta?.type === 'session_meta' && isJsonObject(meta.payload) ? meta.payload : undefined;
	if (typeof payload?.id !== 'string' || !SESSION_ID.test(payload.id) || typeof payload.cwd !== 'string') {
		return undefined;
	}
	const prompt = firstPrompt(lines.slice(1));
	const title = prompt === undefined ? undefined : titleOf(prompt);
	return { sessionId: payload.id, cwd: payload.cwd, ...title ? { title } : {} };
}

/** Codex's store: its home - `CODEX_HOME`, else `.codex` in the home folder - every rollout there, as it keeps no index by folder. */
export const CODEX_STORE: VendorStore = {
	cli: 'codex',
	dirOf: (env: Environment, cwd: string) => path.resolve(cwd, variableOf(env, 'CODEX_HOME') || path.join(homeOf(env), '.codex')),
	candidates: codexCandidates,
	candidateOf: codexCandidateOf,
	read: codexConversation
};
