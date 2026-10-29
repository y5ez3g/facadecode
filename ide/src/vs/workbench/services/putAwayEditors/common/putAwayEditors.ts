/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IPutAwayEditorsService = createDecorator<IPutAwayEditorsService>('putAwayEditorsService');

/**
 * The unsaved text editors each folder out of sight holds, closed with their working copies left alive
 * (WORKSPACE.md W6.2). Kept with the workspace, so a reload knows which folder owns each.
 */
export interface IPutAwayEditorsService {
	readonly _serviceBrand: undefined;

	/** Fires when what some folder holds out of sight changes. */
	readonly onDidChange: Event<void>;

	/** Replaces what `folder` holds out of sight; none once its editors are back or it has left. */
	set(folder: URI, resources: readonly URI[]): void;

	/** The resources `folder` holds out of sight. */
	get(folder: URI): readonly URI[];

	/** Every folder holding something out of sight. */
	folders(): readonly URI[];

	/** Whether some folder holds an editor of `resource` out of sight. */
	isPutAway(resource: URI): boolean;
}
