/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const IHeldEditorsService = createDecorator<IHeldEditorsService>('heldEditorsService');

/**
 * Editors a program outside the window waits on, such as a `git commit` message opened with `--wait`.
 * Folder switches keep them on screen, since closing one tells the program to go on (WORKSPACE.md W6.2).
 */
export interface IHeldEditorsService {
	readonly _serviceBrand: undefined;

	/** Holds the editors of `resources` until `released` settles, however it settles. */
	hold(resources: readonly URI[], released: Promise<unknown>): void;

	/** Whether `editor` shows a held resource, on either side of a diff. */
	isHeld(editor: EditorInput): boolean;
}
