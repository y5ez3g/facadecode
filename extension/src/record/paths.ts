/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

/** The variable that puts the Facade home elsewhere, unless Facade: Home is set; tests always set it (ARCHITECTURE-3.1). */
export const FACADE_HOME_VARIABLE = 'FACADE_HOME';

/**
 * Whether `folder` names one folder whatever folder or drive a process is in (ARCHITECTURE-3.1): absolute, and on Windows on a drive
 * (`C:\`) or a share (`\\server\share`) - `\folder` alone is on the current drive, which the extension and an agent started on
 * another drive do not share.
 */
export function isFullyQualified(folder: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === 'win32' ? /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(folder) : path.posix.isAbsolute(folder);
}

/**
 * The execution environment's Facade directory: `extension` in the Facade home - `~/.facade`, or the absolute folder `FACADE_HOME`
 * names, which Facade: Home sets as the window starts (ARCHITECTURE-3.1). The root is shared with the Facade Code IDE; the extension keeps to its own `extension` folder in it.
 */
export function facadeHome(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(facadeRoot(env), 'extension');
}

/**
 * The Facade home in the execution environment: `~/.facade`, or the absolute folder `FACADE_HOME` names, which Facade: Home sets as
 * the window starts (ARCHITECTURE-3.1). Its `facade.json` is the settings file every Facade product there reads (CONFIGURATION-1.1).
 */
export function facadeRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
	const named = env[FACADE_HOME_VARIABLE];
	// A relative one is refused, not read as unset: a test or tool that meant its own root never works in the person's (ARCHITECTURE-3.1)
	if (named && !isFullyQualified(named, platform)) {
		throw new Error(`${FACADE_HOME_VARIABLE} must name an absolute folder; it names '${named}'.`);
	}
	return named || path.join(os.homedir(), '.facade');
}
