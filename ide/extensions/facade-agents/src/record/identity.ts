/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isEqualPath, replaceFile } from '../base/files';
import { isJsonObject } from '../base/json';

/** The file of a record that names the workspace it belongs to. */
const IDENTITY_FILE = 'identity.json';
/** A workspace's id, as Facade makes it: a UUID. */
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The record a workspace's agents are in: its id, its folder, and whether it was made just now. */
export interface WorkspaceRecord {
	readonly id: string;
	readonly dir: string;
	readonly isNew: boolean;
}

/**
 * The record a build before workspace ids kept for a workspace, where there is one: by the path its storage
 * kept, `kept`, under `root`, else by the workspace's first folder - `<name>-<hash>`, as it named one. A
 * record that names a workspace is this build's own, not one of those.
 */
export function earlierRecordOf(root: string, kept: unknown, firstFolder: string): string | undefined {
	const candidates = [
		...typeof kept === 'string' && path.dirname(path.resolve(kept)) === path.resolve(root) ? [path.resolve(kept)] : [],
		earlierRecordDir(root, firstFolder)
	];
	return candidates.find(dir => fs.existsSync(dir) && identityOf(dir) === undefined && !isWorkspaceId(path.basename(dir)));
}

/** Where a build before workspace ids kept the record of a workspace whose first folder is `firstFolder`. */
function earlierRecordDir(root: string, firstFolder: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(firstFolder);
	} catch {
		resolved = path.resolve(firstFolder);
	}
	let key = resolved.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	if (process.platform === 'win32' || process.platform === 'darwin') {
		key = key.toLowerCase();
	}
	const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
	const name = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 40) || 'workspace';
	return path.join(root, `${name}-${hash}`);
}

/** Whether `value` is a workspace's id, as Facade makes one. */
export function isWorkspaceId(value: unknown): value is string {
	return typeof value === 'string' && WORKSPACE_ID.test(value);
}

/** Where the record of the workspace `id` is, under `root`. */
export function recordDirOf(root: string, id: string): string {
	return path.join(root, id);
}

/**
 * The workspace the record in `dir` belongs to, as its URI's text - its folder, its `.code-workspace`
 * file, or its untitled workspace - or undefined where the record names none, or cannot be read.
 */
export function identityOf(dir: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, IDENTITY_FILE), 'utf8'));
		return isJsonObject(parsed) && typeof parsed.workspace === 'string' && parsed.workspace ? parsed.workspace : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether two workspaces, as their URIs' texts, are one: a folder or a `.code-workspace` file the file system
 * names by both - in another case, say, where case is ignored (C-REC-18; REC-13) - or the same text.
 */
export function isSameWorkspace(a: string, b: string): boolean {
	if (a === b) {
		return true;
	}
	try {
		const [first, second] = [new URL(a), new URL(b)];
		return first.protocol === 'file:' && second.protocol === 'file:' && first.host === second.host && isEqualPath(fileURLToPath(first), fileURLToPath(second));
	} catch {
		return false;
	}
}

/**
 * Throws where the record in `dir` has an identity file that cannot be read: that record may be a running
 * workspace's, and a new one in its place would leave its agents unseen (C-REC-17). One with none is new.
 */
function assertIdentityReadable(dir: string): void {
	const file = path.join(dir, IDENTITY_FILE);
	if (fs.existsSync(file) && identityOf(dir) === undefined) {
		throw new Error(`Cannot read ${file}, so Facade cannot identify the workspace that owns the record in ${dir}. Correct the identity file to contain {"workspace": "<workspace URI>"}, or move the record aside, then reload the window.`);
	}
}

/** Names `workspace` as the one the record in `dir` belongs to, making the record's folder where there is none. */
export function writeIdentity(dir: string, workspace: string): void {
	fs.mkdirSync(dir, { recursive: true });
	replaceFile(path.join(dir, IDENTITY_FILE), `${JSON.stringify({ workspace }, undefined, '\t')}\n`);
}

/**
 * The record of `workspace`, under `root`. The one the workspace's storage names, `storedId`, while that
 * record names this workspace, or names another one this very window had, as `wasThisWindows` says: its
 * folder window became a workspace, or it was saved under another name, and VS Code carried its storage
 * over - the record goes with it, its agents running on. Any other workspace that comes with the same id,
 * the old file after Save As, or the folder opened on its own again, gets a new record, as does one with
 * none.
 */
export function recordFor(root: string, storedId: unknown, workspace: string, wasThisWindows: (dir: string) => boolean): WorkspaceRecord {
	if (isWorkspaceId(storedId)) {
		const dir = recordDirOf(root, storedId);
		assertIdentityReadable(dir);
		const named = identityOf(dir);
		if (named !== undefined && isSameWorkspace(named, workspace)) {
			return { id: storedId, dir, isNew: false };
		}
		if (named !== undefined && wasThisWindows(dir)) {
			writeIdentity(dir, workspace);
			return { id: storedId, dir, isNew: false };
		}
	}
	const id = crypto.randomUUID();
	const dir = recordDirOf(root, id);
	writeIdentity(dir, workspace);
	return { id, dir, isNew: true };
}
