/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from '../core/ports';

/** The core's Git port, with the git the git extension uses: the one the person set, or the one on PATH. */
export class HostGit implements Git {

	async worktreeOf(folder: string): Promise<string> {
		const git = await gitPath();
		try {
			const [gitDir, commonDir] = (await run(git, ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])).split(/\r?\n/);
			if (comparable(gitDir) === comparable(commonDir)) {
				return 'main';
			}
			return (await run(git, ['-C', folder, 'branch', '--show-current'])).trim() || path.basename(folder);
		} catch {
			return path.basename(folder);
		}
	}
}

function comparable(file: string | undefined): string {
	const resolved = path.resolve(file ?? '');
	return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function run(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => execFile(command, [...args], { windowsHide: true, timeout: 10_000 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())));
}

async function gitPath(): Promise<string> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): { git: { path: string } } }>('vscode.git');
	try {
		const api = (extension?.isActive ? extension.exports : await extension?.activate())?.getAPI(1);
		return api?.git.path ?? 'git';
	} catch {
		return 'git';
	}
}
