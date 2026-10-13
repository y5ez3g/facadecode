/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';

/**
 * Facade Code: the changes to the workspace's folders made for an agent's work in the background - a worktree
 * `stop_agent` deletes taken out of the workspace, or put back where git did not delete it - which are not the
 * person's (AGENT-LAUNCHER.md, L1). What reacts to the person's changes, as the extension host relauncher does,
 * tells them apart by the folder.
 */
export interface IBackgroundFolderChangesService {
	readonly _serviceBrand: undefined;

	/** Runs `change`, which adds `folders` to the workspace or takes them out of it, as background work. */
	run<T>(folders: readonly URI[], change: () => Promise<T>): Promise<T>;

	/** Whether `folder` is being added to the workspace or taken out of it as background work. */
	isChanging(folder: URI): boolean;
}

export const IBackgroundFolderChangesService = createDecorator<IBackgroundFolderChangesService>('backgroundFolderChangesService');

export class BackgroundFolderChangesService implements IBackgroundFolderChangesService {

	declare readonly _serviceBrand: undefined;

	/** The folders changing in the background, each once for every change of it running. */
	private readonly changing: URI[] = [];

	constructor(@IUriIdentityService private readonly uriIdentityService: IUriIdentityService) { }

	async run<T>(folders: readonly URI[], change: () => Promise<T>): Promise<T> {
		this.changing.push(...folders);
		try {
			return await change();
		} finally {
			for (const folder of folders) {
				this.changing.splice(this.changing.indexOf(folder), 1);
			}
		}
	}

	isChanging(folder: URI): boolean {
		return this.changing.some(each => this.uriIdentityService.extUri.isEqual(each, folder));
	}
}

registerSingleton(IBackgroundFolderChangesService, BackgroundFolderChangesService, InstantiationType.Delayed);
