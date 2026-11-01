/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** The execution environment of this window's workspace (PRODUCT-5.3): `local`, or the remote it runs in. */
export function editorEnvironment(): string {
	// The remote authority names the host too (`ssh-remote+build-box`), so two hosts of one kind never share location IDs
	const authority = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.authority;
	return vscode.env.remoteName ? authority || vscode.env.remoteName : 'local';
}
