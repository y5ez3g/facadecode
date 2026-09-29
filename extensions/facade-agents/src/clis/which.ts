/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

export type Environment = { readonly [name: string]: string | undefined };

const isWindows = process.platform === 'win32';

/** Where `command` resolves on `PATH`, with `PATHEXT` on Windows. Undefined if nowhere. */
export function which(command: string, env: Environment = process.env): string | undefined {
	const hasDirectory = command.includes('/') || (isWindows && command.includes('\\'));
	const extensions = isWindows ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
	const candidates = (base: string) => isWindows && path.extname(base) === '' ? extensions.map(ext => base + ext.toLowerCase()) : [base, ...(isWindows ? extensions.map(ext => base + ext.toLowerCase()) : [])];
	if (hasDirectory) {
		return candidates(path.resolve(command)).find(isExecutable);
	}
	const pathValue = env.PATH ?? env.Path ?? '';
	for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
		const found = candidates(path.join(dir.replace(/^"(?<unquoted>.*)"$/, '$<unquoted>'), command)).find(isExecutable);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function isExecutable(file: string): boolean {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) {
			return false;
		}
		if (!isWindows) {
			fs.accessSync(file, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}
