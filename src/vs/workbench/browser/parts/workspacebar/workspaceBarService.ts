/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * What the bar offers the rest of the workbench.
 *
 * In its own file so that an action can reach the bar without importing the part that registers it:
 * the part imports the actions, so the other direction would be a cycle.
 *
 * `layout.ts` also resolves this to force the part into existence before the grid is built.
 */
export interface IWorkspaceBarService {
	readonly _serviceBrand: undefined;

	/** Puts folders in the workspace, in the order given, skipping the ones already there. */
	add(uris: readonly URI[]): Promise<void>;

	/** Takes folders out of the workspace, leaving them where they are on disk. */
	remove(uris: readonly URI[]): Promise<void>;

	/**
	 * What a command that was invoked without a folder should act on: the row the list has focus
	 * on, and failing that the folder the window is currently in.
	 */
	folderForCommand(): URI | undefined;

	focus(): void;
}

export const IWorkspaceBarService = createDecorator<IWorkspaceBarService>('workspaceBarService');
