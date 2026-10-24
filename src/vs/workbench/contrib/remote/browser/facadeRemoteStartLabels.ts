/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Facade Code: the remote menu's entry for starting a remote extension Facade Code builds in or offers, in
 * the window's language. `product.json` holds its English, which no language pack reaches (REMOTE.md R5;
 * LOCALIZATION.md LC3). Undefined for any other extension: its entry is the product's.
 */
export function facadeRemoteStartLabel(extensionId: string): string | undefined {
	switch (extensionId.toLowerCase()) {
		case 'jeanp413.open-remote-ssh':
			return localize('facadeRemote.connectToHost', "Connect to Host...");
		case 'jeanp413.open-remote-wsl':
			return localize('facadeRemote.connectToWsl', "Connect to WSL");
		default:
			return undefined;
	}
}
