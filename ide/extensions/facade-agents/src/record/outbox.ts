/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../base/errors';
import { isJsonObject } from '../base/json';
import { FacadeKind, ForeignAgent, isForeign, isId } from './messages';

/**
 * A notice one workspace leaves for an agent of another (AGENT-ORCHESTRATION.md, O8): for the agent `to` of that
 * workspace, about `about` - an agent of the workspace that wrote it - its text and kind, and, for a message it settles,
 * that message's number. Its key - kind, subject and the workspace that raised it - makes it one notice however often it
 * is written.
 */
export interface OutboxNotice {
	readonly key: string;
	/** The agent of that workspace it is for, or the person there. */
	readonly to: number | 'human';
	readonly text: string;
	readonly kind: FacadeKind;
	readonly about: ForeignAgent;
	readonly message?: number;
}

/** A notice waiting in a workspace's outbox, and its file. */
export interface WaitingNotice {
	readonly file: string;
	readonly notice: OutboxNotice;
}

/** A notice's key as a file name: what a file name may hold, the rest a hash. */
function fileOf(dir: string, key: string): string {
	const plain = key.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
	const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
	return path.join(dir, `${plain}.${hash}.json`);
}

/**
 * Writes `notice` into the outbox of the workspace `record`, under `root`: once - a notice already written under its key
 * stays as it is. Written whole, then put in place, so that a workspace taking its notices never reads half of one.
 */
export function postNotice(root: string, record: string, notice: OutboxNotice): void {
	const dir = path.join(root, record);
	fs.mkdirSync(dir, { recursive: true });
	const file = fileOf(dir, notice.key);
	if (fs.existsSync(file)) {
		return;
	}
	const writing = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
	fs.writeFileSync(writing, JSON.stringify(notice), { mode: 0o600 });
	try {
		fs.renameSync(writing, file);
	} finally {
		fs.rmSync(writing, { force: true });
	}
}

/** The notices waiting in the outbox of the workspace `record`, oldest first; a file that is no notice is left alone. */
export function noticesFor(root: string, record: string): WaitingNotice[] {
	const dir = path.join(root, record);
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter(name => name.endsWith('.json'));
	} catch (err) {
		if (codeOf(err) !== 'ENOENT') {
			throw err;
		}
		return [];
	}
	const found: { file: string; notice: OutboxNotice; time: number }[] = [];
	for (const name of names) {
		const file = path.join(dir, name);
		try {
			const notice = noticeOf(JSON.parse(fs.readFileSync(file, 'utf8')));
			if (notice) {
				found.push({ file, notice, time: fs.statSync(file).mtimeMs });
			}
		} catch {
			// Gone meanwhile, or not yet whole
		}
	}
	return found.sort((a, b) => a.time - b.time).map(({ file, notice }) => ({ file, notice }));
}

/** Removes a notice taken. */
export function removeNotice(file: string): void {
	fs.rmSync(file, { force: true });
}

const KINDS: ReadonlySet<string> = new Set<FacadeKind>(['returned', 'ended', 'taskNotFetched', 'delayed']);

/** A notice as read, each field checked; undefined where it is none. */
function noticeOf(value: unknown): OutboxNotice | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}
	const { key, to, text, kind, about, message } = value;
	if (typeof key !== 'string' || !key || !(isId(to) || to === 'human') || typeof text !== 'string' || !text || typeof kind !== 'string' || !KINDS.has(kind) || !isForeign(about) || (message !== undefined && !isId(message))) {
		return undefined;
	}
	return { key, to: to as number | 'human', text, kind: kind as FacadeKind, about, ...(message !== undefined ? { message } : {}) };
}
