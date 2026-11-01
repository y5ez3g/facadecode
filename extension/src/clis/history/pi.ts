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
import { formsOf, headLines, mtimeOf, namesIn, PROMPT_BYTES, tailLines, titleOf } from './scope';
import type { Candidate, Found, VendorStore } from './store';

/** The folder Pi 1.4 keeps the sessions of `cwd` in by default: its path, a leading separator dropped, each separator and colon a dash, between `--`. */
export function piSessionFolderName(cwd: string): string {
	return `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/**
 * The session files in the store at `dir` that may be of `directories` or a folder below them (LIFECYCLE-3.2): in the default layout,
 * those of the folders named for them, as `claudeCandidates` lists Claude Code's - a sibling's that shares a prefix is read and left
 * out by its header - and every file a session-dir override keeps directly, which has no folder per cwd.
 */
export function piCandidates(dir: string, directories: readonly string[] = []): Candidate[] {
	const caseless = process.platform === 'win32' || process.platform === 'darwin';
	const compared = (name: string) => caseless ? name.toLowerCase() : name;
	const prefixes = [...new Set(directories.flatMap(formsOf).map(each => compared(piSessionFolderName(each).slice(0, -2))))];
	const scoped = (name: string) => !directories.length || prefixes.some(prefix => compared(name) === `${prefix}--` || compared(name).startsWith(`${prefix}-`));
	const folders = [dir, ...namesIn(dir, /^--.*--$/).filter(scoped).map(name => path.join(dir, name))];
	return folders.flatMap(directory => namesIn(directory, /\.jsonl$/).flatMap(name => {
		const file = path.join(directory, name);
		const at = mtimeOf(file);
		return at === undefined ? [] : [{ cli: 'pi', file, at }];
	}));
}

/** Whether `line` is a user's message: the first gives a session its title where it has no name. */
function userMessage(line: { readonly [key: string]: unknown }): boolean {
	return line.type === 'message' && isJsonObject(line.message) && line.message.role === 'user';
}

export async function piConversation(candidate: Candidate): Promise<Found | undefined> {
	// The head first, read on only where it holds no first message - a long first line, or a long preamble - as far as list metadata goes
	let lines = await headLines(candidate.file);
	if (!lines.some(userMessage)) {
		lines = await headLines(candidate.file, PROMPT_BYTES);
	}
	const header = lines[0];
	if (header?.type !== 'session' || typeof header.id !== 'string' || !SESSION_ID.test(header.id) || typeof header.cwd !== 'string') {
		return undefined;
	}
	const tail = await tailLines(candidate.file);
	const name = [...lines, ...tail].findLast(line => line.type === 'session_info' && typeof line.name === 'string')?.name;
	const first = lines.find(userMessage);
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
