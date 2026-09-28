/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizePath } from '../glob';

/*
 * Where a workspace's ledger and notebook live: `~/.facade/workspaces/<name>-<hash>`, named after
 * the workspace's first folder. Not the extension's storage folder, which changes when a folder window
 * becomes a workspace; the first folder is the one still there afterwards.
 */

export function workspacesRoot(): string {
	return path.join(os.homedir(), '.facade', 'workspaces');
}

export function workspaceDir(root: string, firstFolder: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(firstFolder);
	} catch {
		resolved = path.resolve(firstFolder);
	}
	let key = normalizePath(resolved);
	if (process.platform === 'win32' || process.platform === 'darwin') {
		key = key.toLowerCase();
	}
	const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
	const name = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 40) || 'workspace';
	return path.join(root, `${name}-${hash}`);
}
