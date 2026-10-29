/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IActiveFolderService } from '../../activeFolder/common/activeFolder.js';
import { FolderScope, FolderScopeContext, IFolderScopeService } from '../common/folderScope.js';

const STORAGE_KEY = 'facade.folderScope';

export class FolderScopeService extends Disposable implements IFolderScopeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeScope = this._register(new Emitter<void>());
	readonly onDidChangeScope: Event<void> = this._onDidChangeScope.event;

	private _scope: FolderScope;
	get scope(): FolderScope { return this._scope; }

	private readonly scopeContext: IContextKey<string>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IActiveFolderService private readonly activeFolderService: IActiveFolderService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super();

		// ⚠️ `StorageScope.WORKSPACE`: how wide someone is looking is a fact about the window they
		// are looking in, not about them. Two windows on two workspaces hold it separately.
		this._scope = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE) === FolderScope.Workspace
			? FolderScope.Workspace
			: FolderScope.Folder;

		this.scopeContext = FolderScopeContext.bindTo(contextKeyService);
		this.scopeContext.set(this._scope);

		// The window moving changes what a folder-scoped search covers, which the surfaces have to
		// hear about in exactly the same way as a widening.
		this._register(this.activeFolderService.onDidChangeActiveFolder(() => {
			if (this._scope === FolderScope.Folder) {
				this._onDidChangeScope.fire();
			}
		}));

		// ⚠️ And so does the workspace's own list changing, in either scope. Widened, `folders()` is
		// that list. Narrowed, a folder leaving moves every file in it from "hidden by the scope" to
		// "outside the workspace", which `covers` never hides - the answer flips without anybody
		// moving or widening. A view that is not told goes on drawing the answer to a question that
		// has been changed underneath it.
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this._onDidChangeScope.fire()));
	}

	folders(): readonly IWorkspaceFolder[] {
		const all = this.contextService.getWorkspace().folders;
		if (this._scope === FolderScope.Workspace) {
			return all;
		}

		const active = this.activeFolderService.activeFolder;

		return active ? [active] : all;
	}

	covers(resource: URI): boolean {
		// ⚠️ A resource that is in none of the workspace's folders is covered by every scope. A file
		// opened from outside the workspace, and every file in a window that has no folders at all,
		// belongs to no folder - so there is no folder that could be hiding it, and narrowing it away
		// would lose it for good: widening does not bring it back either, because widening only ever
		// reaches the folders the workspace holds.
		const extUri = this.uriIdentityService.extUri;
		const inWorkspace = this.contextService.getWorkspace().folders.some(folder => extUri.isEqualOrParent(resource, folder.uri));

		return !inWorkspace || this.folders().some(folder => extUri.isEqualOrParent(resource, folder.uri));
	}

	setScope(scope: FolderScope): void {
		if (scope === this._scope) {
			return;
		}

		this._scope = scope;
		this.scopeContext.set(scope);
		this.storageService.store(STORAGE_KEY, scope, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChangeScope.fire();
	}
}

registerSingleton(IFolderScopeService, FolderScopeService, InstantiationType.Delayed);
