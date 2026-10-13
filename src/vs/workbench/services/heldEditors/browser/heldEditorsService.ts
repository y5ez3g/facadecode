/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IHeldEditorsService } from '../common/heldEditors.js';

export class HeldEditorsService implements IHeldEditorsService {

	declare readonly _serviceBrand: undefined;

	private readonly holds = new Set<readonly URI[]>();

	constructor(
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) { }

	hold(resources: readonly URI[], released: Promise<unknown>): void {
		if (!resources.length) {
			return;
		}

		const hold = [...resources];
		this.holds.add(hold);
		const release = () => this.holds.delete(hold);
		released.then(release, release);
	}

	isHeld(editor: EditorInput): boolean {
		if (!this.holds.size) {
			return false;
		}

		// One resource for a plain editor; both sides for a diff.
		const resources = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.BOTH });
		const shown = URI.isUri(resources) ? [resources] : [resources?.primary, resources?.secondary].filter((resource): resource is URI => !!resource);
		for (const hold of this.holds) {
			if (shown.some(resource => hold.some(held => this.uriIdentityService.extUri.isEqual(held, resource)))) {
				return true;
			}
		}

		return false;
	}
}

registerSingleton(IHeldEditorsService, HeldEditorsService, InstantiationType.Delayed);
