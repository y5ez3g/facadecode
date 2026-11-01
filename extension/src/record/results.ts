/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';

/** Screen files go after thirty days, as diagnostics do; a message file goes sooner, with the first message in it (COLLABORATION-4.2). */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How often writing a result also cleans up after the ones before it. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const RESULT_FILE = /^(messages|screen)-[0-9TZ]+-[0-9a-f]{12}\.txt$/;
const IDS_SUFFIX = '.ids.json';

/** When each Facade directory's results were last cleaned up by this process. */
const pruned = new Map<string, number>();

/** The folder of the long read results in a Facade directory (COLLABORATION-4.2). */
export function resultsFolder(home: string): string {
	return path.join(home, 'results');
}

/**
 * Writes a read result too long to return inline as a temporary UTF-8 file under `<home>/results/` (COLLABORATION-4.2, MCP-4.2,
 * 5.1), and answers its path and size in bytes. A messages file names the messages it holds beside it, so that it goes as soon as
 * any of them expires; a later read writes the messages still kept again.
 */
export function writeResult(home: string, kind: 'messages' | 'screen', text: string, messageIds: readonly string[] = []): { path: string; size: number } {
	const folder = resultsFolder(home);
	const now = Date.now();
	if (now - (pruned.get(folder) ?? Number.NEGATIVE_INFINITY) >= PRUNE_EVERY_MS) {
		pruneResults(home, now);
	}
	const stamp = new Date(now).toISOString().replace(/[-:]|\.\d+/g, '');
	const file = path.join(folder, `${kind}-${stamp}-${crypto.randomBytes(6).toString('hex')}.txt`);
	if (kind === 'messages') {
		// The IDs first: a file is never left without them
		replaceFile(`${file}${IDS_SUFFIX}`, `${JSON.stringify([...new Set(messageIds.map(messageIdOf))])}\n`);
	}
	const content = Buffer.from(text, 'utf8');
	replaceFile(file, content);
	return { path: file, size: content.byteLength };
}

/**
 * Removes the result files that are past their time: any older than thirty days, and each messages file that holds a message
 * `kept` says is no longer kept - one that expired. Without `kept`, only age decides. Files of other names are left alone.
 */
export function pruneResults(home: string, now: number, kept?: (id: string) => boolean): void {
	const folder = resultsFolder(home);
	pruned.set(folder, now);
	let names: string[];
	try {
		names = fs.readdirSync(folder);
	} catch {
		return;
	}
	const present = new Set(names);
	for (const name of names) {
		const file = path.join(folder, name);
		if (name.endsWith(IDS_SUFFIX)) {
			// IDs whose file went, or never came
			if (RESULT_FILE.test(name.slice(0, -IDS_SUFFIX.length)) && !present.has(name.slice(0, -IDS_SUFFIX.length)) && isOlder(file, now, PRUNE_EVERY_MS)) {
				fs.rmSync(file, { force: true });
			}
			continue;
		}
		const match = RESULT_FILE.exec(name);
		if (!match) {
			continue;
		}
		const expired = isOlder(file, now, RETENTION_MS) || (match[1] === 'messages' && !!kept && idsOf(`${file}${IDS_SUFFIX}`).some(id => !kept(id)));
		if (expired) {
			fs.rmSync(file, { force: true });
			fs.rmSync(`${file}${IDS_SUFFIX}`, { force: true });
		}
	}
}

/** `m-42` for `m-42` or `#m42`; any other text as it is. */
function messageIdOf(id: string): string {
	const alias = /^#m(\d+)$/.exec(id);
	return alias ? `m-${alias[1]}` : id;
}

function idsOf(file: string): string[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

function isOlder(file: string, now: number, ms: number): boolean {
	try {
		return now - fs.statSync(file).mtimeMs > ms;
	} catch {
		return false;
	}
}
