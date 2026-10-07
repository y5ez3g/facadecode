/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { replaceFile } from '../base/files';
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
		const named = identityOf(dir);
		if (named === workspace) {
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
