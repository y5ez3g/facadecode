/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';

/**
 * The one workspace a window falls back to when it was asked to open nothing at all.
 *
 * ⚠️ A fixed path, not a setting and not a stored value. There is exactly one of these per
 * installation and the product decides where it is; a preference here would be one more thing that
 * can be pointed at a file that has been moved or deleted.
 *
 * ⚠️ The `User` directory and not the profile's, so the same file is the default whatever profile a
 * window is in. It sits beside `settings.json`, which is the other thing in that directory that
 * belongs to the person rather than to a window.
 *
 * ⚠️ A **file** URI, and the callers have to hand one over. `userRoamingDataHome` names the same
 * directory as `vscode-userdata:`, and `resolveLocalWorkspace` refuses anything that is not
 * `file:` - `if (uri.scheme !== Schemas.file) { return undefined; }`. Passing the roaming home
 * created the workspace file and then silently declined to open it, and the window came up empty
 * with no error anywhere.
 *
 * ⚠️ Said in one place because both sides need it: the main process opens it when a window would
 * otherwise be empty, and the workbench opens it from the File menu. Two derivations of one path is
 * two paths the day one of them is edited.
 */
export const DEFAULT_WORKSPACE_FILE_NAME = 'Default.code-workspace';

export function defaultWorkspaceUri(userDataPath: string): URI {
	return joinPath(URI.file(userDataPath), 'User', DEFAULT_WORKSPACE_FILE_NAME);
}

/** What the file is created with when it is not there yet: a workspace with no folders in it. */
export const DEFAULT_WORKSPACE_CONTENT = JSON.stringify({ folders: [] }, undefined, '\t');
