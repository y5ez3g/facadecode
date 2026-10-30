/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

/** The variable that puts Facade's root directory elsewhere; tests always set it (ARCHITECTURE-3.1). */
export const FACADE_HOME_VARIABLE = 'FACADE_HOME';

/**
 * The execution environment's Facade directory: `extension` in Facade's root - `~/.facade`, or the absolute folder `FACADE_HOME`
 * names (ARCHITECTURE-3.1). The root is shared with the Facade Code IDE; the extension keeps to its own `extension` folder in it.
 */
export function facadeHome(env: NodeJS.ProcessEnv = process.env): string {
	const named = env[FACADE_HOME_VARIABLE];
	return path.join(named && path.isAbsolute(named) ? named : path.join(os.homedir(), '.facade'), 'extension');
}
