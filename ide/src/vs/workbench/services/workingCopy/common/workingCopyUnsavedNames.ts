/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkingCopy } from './workingCopy.js';

/** Facade Code: what names the files a close would lose, in VS Code's dialogs before shutdown (WORKSPACE.md W11). */
type UnsavedNames = (workingCopies: readonly IWorkingCopy[]) => string[];

let names: UnsavedNames | undefined;

/**
 * The names VS Code's dialogs before shutdown - its question, and the error when backing up fails - list `workingCopies`
 * by: each with its place where Facade tells it, else its own.
 */
export function unsavedNamesOf(workingCopies: readonly IWorkingCopy[]): string[] {
	return names?.(workingCopies) ?? workingCopies.map(workingCopy => workingCopy.name);
}

/** Names the files of VS Code's dialogs before shutdown from now on, until disposed. */
export function setUnsavedNames(value: UnsavedNames): IDisposable {
	names = value;
	return toDisposable(() => {
		if (names === value) {
			names = undefined;
		}
	});
}
