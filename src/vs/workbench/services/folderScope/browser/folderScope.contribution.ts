/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { FolderScope, FolderScopeContext, IFolderScopeService } from '../common/folderScope.js';

const allFoldersIcon = registerIcon('facade-all-folders', Codicon.folderLibrary,
	localize('allFoldersIcon', 'Icon for toggling view scope between the current folder and the entire workspace.'));

/**
 * The way back to the whole workspace, in the title of every view that narrows.
 *
 * ⚠️ One action and one scope rather than one per view: a person who widens to find something and
 * then looks at a second view does not want to widen again. It is registered here, beside the
 * service, so that a view added to the list is one more `when` clause rather than one more toggle.
 */
export const TOGGLE_FOLDER_SCOPE_COMMAND_ID = 'facade.action.toggleFolderScope';

/** The views that narrow, and so have something to widen. */
const NARROWING_VIEWS = ['workbench.view.search', 'workbench.panel.markers.view'];

registerAction2(class ToggleFolderScopeAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_FOLDER_SCOPE_COMMAND_ID,
			title: localize2('toggleFolderScope', "Show All Folders"),
			category: localize2('facadeCategory', "Workspace"),
			icon: allFoldersIcon,
			f1: true,
			toggled: {
				condition: FolderScopeContext.isEqualTo(FolderScope.Workspace),
				title: localize('toggleFolderScope.toggled', "Showing All Folders")
			},
			menu: NARROWING_VIEWS.map(view => ({
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 0,
				// Nothing to widen to in a window holding one folder.
				when: ContextKeyExpr.and(ContextKeyExpr.equals('view', view), ContextKeyExpr.greater('workspaceFolderCount', 1))
			}))
		});
	}

	run(accessor: ServicesAccessor): void {
		const folderScopeService = accessor.get(IFolderScopeService);
		folderScopeService.setScope(folderScopeService.scope === FolderScope.Workspace ? FolderScope.Folder : FolderScope.Workspace);
	}
});
