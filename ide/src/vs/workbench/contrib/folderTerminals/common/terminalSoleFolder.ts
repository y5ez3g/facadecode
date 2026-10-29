/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';

let soleFolderOf: ((terminal: object) => URI | undefined) | undefined;
const onDidChange = new Emitter<void>();

/**
 * The folder an editor-area terminal is labelled as alone in, as in a single-folder window (WORKSPACE.md W7);
 * undefined for other terminals, which keep the multi-root label. Without {@link setTerminalSoleFolder}, upstream's rule stands.
 */
export function terminalSoleFolder(terminal: object): URI | undefined {
	return soleFolderOf?.(terminal);
}

/** When {@link terminalSoleFolder} may answer otherwise for a terminal that has not itself changed. */
export const onDidChangeTerminalSoleFolder: Event<void> = onDidChange.event;

/** Answers {@link terminalSoleFolder} from now on, until disposed. */
export function setTerminalSoleFolder(of: (terminal: object) => URI | undefined): IDisposable {
	soleFolderOf = of;
	onDidChange.fire();
	return toDisposable(() => {
		if (soleFolderOf === of) {
			soleFolderOf = undefined;
			onDidChange.fire();
		}
	});
}

/** Says that {@link terminalSoleFolder} may answer otherwise now: terminals stopped or started being folders' own. */
export function refreshTerminalSoleFolders(): void {
	onDidChange.fire();
}
