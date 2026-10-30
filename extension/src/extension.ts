/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { activateFacade } from './host/service';

let deactivating: (() => Promise<void>) | undefined;

/** Facade Code: a panel of this window's agents, each CLI in its own editor terminal (PRODUCT-1.1). */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	deactivating = await activateFacade(context);
}

/** Detaches from the agents' processes: they keep running in ptyd, and a reload finds them again (RULES-4.1). */
export function deactivate(): Promise<void> | undefined {
	return deactivating?.();
}
