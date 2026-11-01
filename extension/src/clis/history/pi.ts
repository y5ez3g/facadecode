/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pi 1.4's native JSONL sessions. Folder encodings are lossy: the header, not the filename, establishes cwd and identity.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Environment } from '../environment';
import { isJsonObject } from '../../base/json';
import { variableOf } from '../environment';
import { homeOf } from '../executable';
import { SESSION_ID } from '../identity';
import { headLines, mtimeOf, namesIn, PROMPT_BYTES, tailLines, titleOf } from './scope';
import type { Candidate, Found, VendorStore } from './store';

export function piCandidates(dir: string): Candidate[] {
	// A session-dir override stores files directly; the default has one encoded directory per cwd.
	const directories = [dir, ...namesIn(dir, /^--.*--$/).map(name => path.join(dir, name))];
	return directories.flatMap(directory => namesIn(directory, /\.jsonl$/).flatMap(name => {
		const file = path.join(directory, name);
		const at = mtimeOf(file);
		return at === undefined ? [] : [{ cli: 'pi', file, at }];
	}));
}

export async function piConversation(candidate: Candidate): Promise<Found | undefined> {
	const lines = await headLines(candidate.file, PROMPT_BYTES);
	const header = lines[0];
	if (header?.type !== 'session' || typeof header.id !== 'string' || !SESSION_ID.test(header.id) || typeof header.cwd !== 'string') {
		return undefined;
	}
	const tail = await tailLines(candidate.file);
	const name = [...lines, ...tail].findLast(line => line.type === 'session_info' && typeof line.name === 'string')?.name;
	const first = lines.find(line => line.type === 'message' && isJsonObject(line.message) && line.message.role === 'user');
	const message = first && isJsonObject(first.message) ? first.message : undefined;
	const content = message?.content;
	const prompt = typeof content === 'string' ? content : Array.isArray(content)
		? content.flatMap(part => isJsonObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';
	const title = titleOf(typeof name === 'string' && name.trim() ? name : prompt);
	return { sessionId: header.id, cwd: header.cwd, ...title ? { title } : {} };
}

/** Pi's precedence: --session-dir, environment, project settings, global settings, default. */
export function piSessionDirectory(env: Environment, cwd: string, args: readonly string[] = []): string {
	const normalize = (value: string) => {
		if (value === '~') { return homeOf(env); }
		if (/^~[/\\]/.test(value)) { return path.join(homeOf(env), value.slice(2)); }
		try { if (value.startsWith('file://')) { return fileURLToPath(value); } } catch { /* An invalid override cannot name a store. */ }
		return value;
	};
	const agent = path.resolve(cwd, normalize(variableOf(env, 'PI_CODING_AGENT_DIR') || path.join(homeOf(env), '.pi', 'agent')));
	const setting = (file: string): string | undefined => {
		try { const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8')); return isJsonObject(value) && typeof value.sessionDir === 'string' ? value.sessionDir : undefined; }
		catch { return undefined; }
	};
	let override: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--session-dir') { override = args[++i]; }
		else if (args[i].startsWith('--session-dir=')) { override = args[i].slice(14); }
	}
	return path.resolve(cwd, normalize(override || variableOf(env, 'PI_CODING_AGENT_SESSION_DIR')
		|| setting(path.join(cwd, '.pi', 'settings.json')) || setting(path.join(agent, 'settings.json')) || path.join(agent, 'sessions')));
}

export const PI_STORE: VendorStore = {
	cli: 'pi',
	dirOf: piSessionDirectory,
	candidates: piCandidates,
	read: piConversation
};
