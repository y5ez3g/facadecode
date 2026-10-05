/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isEqualPath } from '../base/files';

/** Where each workspace's record is: `~/.facade/workspaces`. */
export function workspacesRoot(): string {
	return path.join(os.homedir(), '.facade', 'workspaces');
}

/** The record of the files Facade put into folders, which every window shares. */
export function injectedFile(): string {
	return path.join(os.homedir(), '.facade', 'injected.json');
}

/**
 * The record a workspace's agents are in: the one the workspace `kept`, while it is under `root`, and
 * either one of the workspace's `folders` names it or an agent of it still runs, as `hasRunningAgents`
 * says; else the first folder's. A folder that left the workspace with its agents gets a record anew.
 */
export function recordDir(root: string, kept: unknown, folders: readonly string[], hasRunningAgents: (dir: string) => boolean): string {
	if (typeof kept === 'string' && isEqualPath(path.dirname(kept), root) && fs.existsSync(kept)
		&& (folders.some(folder => isEqualPath(workspaceDir(root, folder), kept)) || hasRunningAgents(kept))) {
		return kept;
	}
	return workspaceDir(root, folders[0]);
}

/**
 * Where a workspace's agents are recorded: `<root>/<name>-<hash>`, by the workspace's first folder.
 * Not the extension's storage folder, which changes when a folder window becomes a workspace.
 */
export function workspaceDir(root: string, firstFolder: string): string {
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
