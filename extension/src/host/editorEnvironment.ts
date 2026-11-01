/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * The execution environment of this window's workspace (PRODUCT-5.3): `local`, or the remote it runs in. In the local window
 * component's extension host a remote folder's URI names its authority, the host too (`ssh-remote+build-box`). In the workspace
 * extension's own remote host the editor gives its folders as `file:` URIs with no authority, so there it is the remote's kind alone
 * (`ssh-remote`): each environment's records are its own, and labels take the host from the window component's identity instead
 * (`environmentLabel`). Location IDs and conversation keys are made of the workspace extension's value and stored, so it stays as it is.
 */
export function editorEnvironment(): string {
	const authority = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.authority;
	return vscode.env.remoteName ? authority || vscode.env.remoteName : 'local';
}
