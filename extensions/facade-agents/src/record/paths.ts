/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

/** Where each workspace's record is: `~/.facade/workspaces/<its id>`. */
export function workspacesRoot(): string {
	return path.join(os.homedir(), '.facade', 'workspaces');
}

/** The record of the files Facade put into folders, which every window shares. */
export function injectedFile(): string {
	return path.join(os.homedir(), '.facade', 'injected.json');
}
