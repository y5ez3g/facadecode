/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Claude Code's conversation store, read for list metadata only (LIFECYCLE-3.2): `projects/<folder>/<session ID>.jsonl` in its
// config folder, the project folder named by the path with every character but a letter or digit as a dash. That name is lossy,
// so each conversation's own lines confirm its ID and working directory. A fixture-tested compatibility reader (CLIS-4.2).

import * as path from 'path';
import * as fs from 'fs';
import { isJsonObject, type JsonObject } from '../../base/json';
import { SESSION_ID } from '../identity';
import { edgeLines, formsOf, HEAD_BYTES, headLines, mtimeOf, namesIn, PROMPT_BYTES, titleOf } from './scope';
import type { Environment } from '../environment';
import { variableOf } from '../environment';
import { homeOf } from '../executable';
import type { Candidate, Found, VendorStore } from './store';

/** The name Claude Code keeps a project's conversations under: its path with each character but a letter or digit a dash. */
export function claudeProjectFolderName(folder: string): string {
	return folder.replace(/[^A-Za-z0-9]/g, '-');
}

/** The conversation files that may be of `directories` or folders below them: their project folders and those named below. */
export function claudeCandidates(configDir: string, directories: readonly string[]): Candidate[] {
	const projects = path.join(configDir, 'projects');
	const prefixes = [...new Set(directories.flatMap(formsOf).map(claudeProjectFolderName))];
	const candidates: Candidate[] = [];
	for (const name of namesIn(projects)) {
		if (!prefixes.some(prefix => name === prefix || name.startsWith(`${prefix}-`))) {
			continue;
		}
		for (const file of namesIn(path.join(projects, name), /\.jsonl$/)) {
			const id = file.slice(0, -'.jsonl'.length);
			const full = path.join(projects, name, file);
			const at = SESSION_ID.test(id) ? mtimeOf(full) : undefined;
			if (at !== undefined) {
				candidates.push({ cli: 'claude', file: full, at, sessionId: id });
			}
		}
	}
	return candidates;
}

/** The first prompt among `lines`: a user message's text, or its first text part. */
function firstPrompt(lines: readonly JsonObject[]): string | undefined {
	for (const line of lines) {
		if (line.isMeta === true || line.isCompactSummary === true) {
			continue;
		}
		const message = line.type === 'user' && isJsonObject(line.message) ? line.message : undefined;
		const content = message?.content;
		if (Array.isArray(content) && content.some(part => isJsonObject(part) && part.type === 'tool_result')) {
			continue;
		}
		const text = typeof content === 'string' ? content : Array.isArray(content)
			? content.map(part => isJsonObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : undefined).find(each => each !== undefined)
			: undefined;
		if (text?.trim() && !text.trim().startsWith('<')) {
			return text;
		}
	}
	return undefined;
}

/** Last native metadata record wins, including an empty value that clears an earlier one. */
function latest(lines: readonly JsonObject[], type: string, field: string): string | undefined {
	const value = lines.findLast(line => line.type === type && typeof line[field] === 'string')?.[field];
	return typeof value === 'string' ? value : undefined;
}

/** A continuation stops superseding its source once the person submits another prompt or the model completes a turn there. */
function continuation(lines: readonly JsonObject[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.type === 'continued-in' && typeof line.continuedInSessionId === 'string' && SESSION_ID.test(line.continuedInSessionId)) {
			return line.continuedInSessionId;
		}
		if (firstPrompt([line]) !== undefined || (line.type === 'assistant' && line.isApiErrorMessage !== true
			&& isJsonObject(line.message) && typeof line.message.stop_reason === 'string')) {
			return undefined;
		}
	}
	return undefined;
}

/** Native titles can be appended to the transcript or kept in a sidecar when an old rename is outside the tail. */
async function sidecarTitle(candidate: Candidate, dependOn: (file: string) => void): Promise<string | undefined> {
	const file = path.join(path.dirname(candidate.file), candidate.sessionId!, 'custom-title.json');
	dependOn(file);
	try {
		const value: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
		return isJsonObject(value) && typeof value.customTitle === 'string' && value.customTitle.trim() ? value.customTitle : undefined;
	} catch {
		return undefined;
	}
}

/** Claude 2.1's list metadata: bounded head/tail, native rename precedence and message activity rather than housekeeping writes. */
export async function claudeConversation(candidate: Candidate, dependOn: (file: string) => void = () => {}): Promise<Found | undefined> {
	const edges = await edgeLines(candidate.file);
	let head = edges.head;
	const tail = edges.tail;
	// A long initial instruction block can leave no cwd or prompt in the ordinary head.
	if (edges.size > HEAD_BYTES && (!head.some(line => typeof line.cwd === 'string') || firstPrompt(head) === undefined)) {
		head = await headLines(candidate.file, PROMPT_BYTES);
	}
	const lines = [...head, ...tail];
	// A native fork may copy its parent's records; its own metadata confirms the new ID.
	if (!lines.some(line => line.sessionId === candidate.sessionId)) {
		return undefined;
	}
	const cwd = latest(tail, 'relocated', 'relocatedCwd') ?? head.map(line => line.cwd).find((each): each is string => typeof each === 'string');
	if (cwd === undefined || head.some(line => line.isSidechain === true || Boolean(line.teamName)
		|| line.sessionKind === 'daemon' || line.sessionKind === 'daemon-worker')) {
		return undefined;
	}
	const successor = continuation(tail);
	if (successor && successor !== candidate.sessionId) {
		const file = path.join(path.dirname(candidate.file), `${successor}.jsonl`);
		dependOn(file);
		const next = await edgeLines(file);
		// An empty or missing successor must not make the original conversation disappear.
		if ([...next.head, ...next.tail].some(line => Object.hasOwn(line, 'parentUuid'))) {
			return undefined;
		}
	}
	const custom = latest(tail, 'custom-title', 'customTitle') ?? await sidecarTitle(candidate, dependOn) ?? latest(head, 'custom-title', 'customTitle');
	const ai = latest(tail, 'ai-title', 'aiTitle') ?? latest(head, 'ai-title', 'aiTitle');
	const summary = latest(tail, 'summary', 'summary') ?? latest(head, 'summary', 'summary');
	const prompt = latest(tail, 'last-prompt', 'lastPrompt') || firstPrompt(head) || firstPrompt(tail);
	const title = titleOf(custom || ai || summary || prompt || '');
	const lastMessage = tail.findLast(line => (line.type === 'user' || line.type === 'assistant')
		&& typeof line.timestamp === 'string' && Number.isFinite(Date.parse(line.timestamp)));
	const activityAt = lastMessage ? Math.min(Date.parse(lastMessage.timestamp as string), candidate.at) : candidate.at;
	return { sessionId: candidate.sessionId!, cwd, activityAt, ...title ? { title } : {} };
}

/** Claude Code's store: its config folder - `CLAUDE_CONFIG_DIR`, else `.claude` in the home folder - and its projects there. */
export const CLAUDE_STORE: VendorStore = {
	cli: 'claude',
	dirOf: (env: Environment, cwd: string) => path.resolve(cwd, variableOf(env, 'CLAUDE_CONFIG_DIR') || path.join(homeOf(env), '.claude')),
	candidates: claudeCandidates,
	read: claudeConversation
};
