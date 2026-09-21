/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ISCMViewService, ISCMRepository, ISCMService, ISCMViewVisibleRepositoryChangeEvent, ISCMMenus, ISCMProvider, ISCMRepositorySortKey, ISCMRepositorySelectionMode } from '../common/scm.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SCMMenus } from './menus.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { debounce } from '../../../../base/common/decorators.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { compareFileNames, comparePaths } from '../../../../base/common/comparers.js';
import { basename } from '../../../../base/common/resources.js';
import { binarySearch } from '../../../../base/common/arrays.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { autorun, derived, derivedObservableWithCache, derivedOpts, IObservable, ISettableObservable, latestChangedValue, observableFromEventOpts, observableValue, runOnChange } from '../../../../base/common/observable.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorResourceAccessor } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { getSCMRepositoryIcon, repositoryBelongsToFolder } from './util.js';

function getProviderStorageKey(provider: ISCMProvider): string {
	return `${provider.providerId}:${provider.label}${provider.rootUri ? `:${provider.rootUri.toString()}` : ''}`;
}

function getRepositoryName(workspaceContextService: IWorkspaceContextService, repository: ISCMRepository): string {
	if (!repository.provider.rootUri) {
		return repository.provider.label;
	}

	const folder = workspaceContextService.getWorkspaceFolder(repository.provider.rootUri);
	return folder?.uri.toString() === repository.provider.rootUri.toString() ? folder.name : basename(repository.provider.rootUri);
}

export const RepositoryContextKeys = {
	RepositorySortKey: new RawContextKey<ISCMRepositorySortKey>('scmRepositorySortKey', ISCMRepositorySortKey.DiscoveryTime),
	RepositorySelectionMode: new RawContextKey<ISCMRepositorySelectionMode>('scmRepositorySelectionMode', ISCMRepositorySelectionMode.Single),
};

export type RepositoryQuickPickItem = IQuickPickItem & { repository: 'auto' | ISCMRepository };

export class RepositoryPicker {
	private readonly _autoQuickPickItem: RepositoryQuickPickItem;

	constructor(
		private readonly _placeHolder: string,
		private readonly _autoQuickItemDescription: string,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ISCMViewService private readonly _scmViewService: ISCMViewService
	) {
		this._autoQuickPickItem = {
			label: localize('auto', "Auto"),
			description: this._autoQuickItemDescription,
			repository: 'auto'
		} satisfies RepositoryQuickPickItem;
	}

	async pickRepository(): Promise<RepositoryQuickPickItem | undefined> {
		const picks: (RepositoryQuickPickItem | IQuickPickSeparator)[] = [
			this._autoQuickPickItem,
			{ type: 'separator' }
		];

		const activeRepository = this._scmViewService.activeRepository.get();
		const repository = activeRepository?.repository;
		const pinned = activeRepository?.pinned === true;

		picks.push(...this._scmViewService.repositories.map(r => {
			const icon = getSCMRepositoryIcon(activeRepository, r);

			return {
				label: r.provider.name,
				description: r.provider.rootUri?.fsPath,
				iconClass: ThemeIcon.asClassName(icon),
				repository: r
			};
		}));

		const activeItem = pinned
			? picks.find(p => p.type !== 'separator' && p.repository === repository) as RepositoryQuickPickItem | undefined
			: this._autoQuickPickItem;

		return this._quickInputService.pick(picks, { placeHolder: this._placeHolder, activeItem });
	}
}

interface ISCMRepositoryView {
	readonly repository: ISCMRepository;
	readonly discoveryTime: number;
	focused: boolean;
	selectionIndex: number;
}

export interface ISCMViewServiceState {
	readonly all: string[];
	readonly visible: number[];
	readonly sortKey: ISCMRepositorySortKey;
}

export class SCMViewService implements ISCMViewService {

	declare readonly _serviceBrand: undefined;

	readonly menus: ISCMMenus;
	readonly explorerEnabledConfig: IObservable<boolean>;
	readonly selectionModeConfig: IObservable<ISCMRepositorySelectionMode>;
	readonly graphShowIncomingChangesConfig: IObservable<boolean>;
	readonly graphShowOutgoingChangesConfig: IObservable<boolean>;

	private didSelectRepository: boolean = false;
	private previousState: ISCMViewServiceState | undefined;
	private readonly disposables = new DisposableStore();

	private _repositories: ISCMRepositoryView[] = [];

	get repositories(): ISCMRepository[] {
		return this._repositories
			.filter(r => r.repository.provider.isHidden !== true)
			.map(r => r.repository);
	}

	readonly didFinishLoadingRepositories = observableValue<boolean>(this, false);

	/**
	 * The repositories the person has chosen to see, whichever folder they belong to.
	 *
	 * ⚠️ Use this, never the public `visibleRepositories`, for anything that reads the set in order
	 * to write it back. The public one is narrowed to the folder the window is on, so a
	 * read-modify-write through it drops every other folder's choice - the same shape of bug as
	 * `doUpdateFolders` losing folders from a `.code-workspace`.
	 */
	private get selectedRepositories(): ISCMRepository[] {
		// In order to match the legacy behaviour, when the repositories are sorted by discovery time,
		// the visible repositories are sorted by the selection index instead of the discovery time.
		if (this._repositoriesSortKey === ISCMRepositorySortKey.DiscoveryTime) {
			return this._repositories
				.filter(r => r.repository.provider.isHidden !== true && r.selectionIndex !== -1)
				.sort((r1, r2) => r1.selectionIndex - r2.selectionIndex)
				.map(r => r.repository);
		}

		return this._repositories
			.filter(r => r.repository.provider.isHidden !== true && r.selectionIndex !== -1)
			.map(r => r.repository);
	}

	/**
	 * What the source control views show: the chosen repositories that belong to the folder the
	 * window is on.
	 *
	 * ⚠️ A third reason a repository is not on screen, beside the two that were already here - the
	 * provider hiding itself, and the person deselecting it. It composes with them rather than
	 * replacing them: a repository deselected in one folder stays deselected when you come back,
	 * and one belonging to another folder is not lost, only off screen until you are in it.
	 */
	get visibleRepositories(): ISCMRepository[] {
		return this.repositoriesIn(this.activeFolderService.activeFolder);
	}

	/**
	 * The chosen repositories that belong to `folder`: what the views show while the window is on it.
	 * See `repositoryBelongsToFolder`. A window on no folder at all is shown everything.
	 */
	private repositoriesIn(folder: IWorkspaceFolder | undefined): ISCMRepository[] {
		return this.selectedRepositories.filter(repository =>
			repositoryBelongsToFolder(repository.provider.rootUri, folder?.uri, this.uriIdentityService.extUri));
	}

	/**
	 * ⚠️ Not narrowed: what is written here is the person's choice, for every folder. The narrowing
	 * lives in the getter, which is why anything reading in order to write back has to go through
	 * `selectedRepositories` instead.
	 */
	set visibleRepositories(visibleRepositories: ISCMRepository[]) {
		const set = new Set(visibleRepositories);
		const added = new Set<ISCMRepository>();
		const removed = new Set<ISCMRepository>();

		for (const repositoryView of this._repositories) {
			// Selected -> !Selected
			if (!set.has(repositoryView.repository) && repositoryView.selectionIndex !== -1) {
				repositoryView.selectionIndex = -1;
				removed.add(repositoryView.repository);
			}
			// Selected | !Selected -> Selected
			if (set.has(repositoryView.repository)) {
				if (repositoryView.selectionIndex === -1) {
					added.add(repositoryView.repository);
				}
				repositoryView.selectionIndex = visibleRepositories.indexOf(repositoryView.repository);
			}
		}

		if (added.size === 0 && removed.size === 0) {
			return;
		}

		this._onDidSetVisibleRepositories.fire({ added, removed });

		// Update focus if the focused repository is not visible anymore
		if (this._repositories.find(r => r.focused && r.selectionIndex === -1)) {
			this.focus(this._repositories.find(r => r.selectionIndex !== -1)?.repository);
		}
	}

	private _onDidChangeRepositories = new Emitter<ISCMViewVisibleRepositoryChangeEvent>();
	readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

	private _onDidSetVisibleRepositories = new Emitter<ISCMViewVisibleRepositoryChangeEvent>();
	readonly onDidChangeVisibleRepositories = Event.any(
		this._onDidSetVisibleRepositories.event,
		Event.debounce(
			this._onDidChangeRepositories.event,
			(last, e) => {
				if (!last) {
					return e;
				}

				const added = new Set(last.added);
				const removed = new Set(last.removed);

				for (const repository of e.added) {
					if (!removed.delete(repository)) {
						added.add(repository);
					}
				}
				for (const repository of e.removed) {
					if (!added.delete(repository)) {
						removed.add(repository);
					}
				}

				return { added, removed };
			}, 0, undefined, undefined, undefined, this.disposables)
	);

	get focusedRepository(): ISCMRepository | undefined {
		return this._repositories.find(r => r.focused)?.repository;
	}

	private _onDidFocusRepository = new Emitter<ISCMRepository | undefined>();
	readonly onDidFocusRepository = this._onDidFocusRepository.event;

	readonly activeRepository: IObservable<{ repository: ISCMRepository; pinned: boolean } | undefined>;
	private readonly _activeEditorObs: IObservable<EditorInput | undefined>;
	private readonly _activeEditorRepositoryObs: IObservable<ISCMRepository | undefined>;

	/**
	* The focused repository takes precedence over the active editor repository when the observable
	* values are updated in the same transaction (or during the initial read of the observable value).
	*/
	private readonly _activeRepositoryObs: IObservable<ISCMRepository | undefined>;
	private readonly _activeFolderObs: IObservable<IWorkspaceFolder | undefined>;
	private readonly _activeRepositoryPinnedObs: ISettableObservable<ISCMRepository | undefined>;
	private readonly _focusedRepositoryObs: IObservable<ISCMRepository | undefined>;

	private _repositoriesSortKey: ISCMRepositorySortKey;
	private _sortKeyContextKey: IContextKey<ISCMRepositorySortKey>;

	private _selectionModelContextKey: IContextKey<ISCMRepositorySelectionMode>;

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IExtensionService extensionService: IExtensionService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IActiveFolderService private readonly activeFolderService: IActiveFolderService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService
	) {
		// ⚠️ Registered, not merely created: upstream never disposed it, which costs nothing in a
		// window (this service lives as long as the window does) and leaks in a test.
		this.menus = this.disposables.add(instantiationService.createInstance(SCMMenus));

		const explorerEnabledConfig = observableConfigValue<boolean>('scm.repositories.explorer', false, this.configurationService);
		this.graphShowIncomingChangesConfig = observableConfigValue<boolean>('scm.graph.showIncomingChanges', true, this.configurationService);
		this.graphShowOutgoingChangesConfig = observableConfigValue<boolean>('scm.graph.showOutgoingChanges', true, this.configurationService);
		this.selectionModeConfig = observableConfigValue<ISCMRepositorySelectionMode>('scm.repositories.selectionMode', ISCMRepositorySelectionMode.Multiple, this.configurationService);
		this.explorerEnabledConfig = derived(reader => {
			return explorerEnabledConfig.read(reader) === true && this.selectionModeConfig.read(reader) === ISCMRepositorySelectionMode.Single;
		});

		try {
			this.previousState = JSON.parse(storageService.get('scm:view:visibleRepositories', StorageScope.WORKSPACE, ''));

			// If previously there were multiple visible repositories but the
			// view mode is `single`, only restore the first visible repository.
			if (this.previousState && this.previousState.visible.length > 1 && this.selectionModeConfig.get() === ISCMRepositorySelectionMode.Single) {
				this.previousState = {
					...this.previousState,
					visible: [this.previousState.visible[0]]
				};
			}
		} catch {
			// noop
		}

		this._focusedRepositoryObs = observableFromEventOpts<ISCMRepository | undefined>(
			{
				owner: this,
				equalsFn: () => false
			}, this.onDidFocusRepository, () => this.focusedRepository);

		this._activeEditorObs = observableFromEventOpts({
			owner: this,
			equalsFn: () => false
		}, this.editorService.onDidActiveEditorChange, () => this.editorService.activeEditor);

		this._activeEditorRepositoryObs = derivedObservableWithCache<ISCMRepository | undefined>(this,
			(reader, lastValue) => {
				const activeEditor = this._activeEditorObs.read(reader);
				const activeResource = EditorResourceAccessor.getOriginalUri(activeEditor);
				if (!activeResource) {
					return lastValue;
				}

				const repository = this.scmService.getRepository(activeResource);
				if (!repository) {
					return lastValue;
				}

				return Object.create(repository);
			});

		/*
		 * A switch changes what is on screen without anything being set, so say so.
		 *
		 * ⚠️ As a diff against what was showing, not as "everything changed": the views add and
		 * remove repositories from a tree they keep, and handing them a repository they already have
		 * or removing one they never had leaves that tree wrong.
		 *
		 * ⚠️ Kept as the folder that was on screen, not as the list of repositories that were. A list
		 * is a snapshot, and this one would be taken before the git extension has opened a single
		 * repository: every repository that arrives afterwards is missing from it, so leaving a
		 * folder announces nothing to remove and the views keep the rows. A folder is not a snapshot
		 * - the set is derived from it at the moment of the switch, out of a selection whose own
		 * changes the setter has already announced.
		 */
		let folderOnScreen = this.activeFolderService.activeFolder;
		this.disposables.add(this.activeFolderService.onDidChangeActiveFolder(() => {
			const previous = this.repositoriesIn(folderOnScreen);
			folderOnScreen = this.activeFolderService.activeFolder;
			const onScreen = this.visibleRepositories;

			const added = onScreen.filter(r => !previous.includes(r));
			const removed = previous.filter(r => !onScreen.includes(r));

			if (added.length === 0 && removed.length === 0) {
				return;
			}

			this._onDidSetVisibleRepositories.fire({ added, removed });
		}));

		this._activeFolderObs = observableFromEventOpts({
			owner: this,
			equalsFn: () => false
		}, this.activeFolderService.onDidChangeActiveFolder, () => this.activeFolderService.activeFolder);

		this._activeRepositoryPinnedObs = observableValue<ISCMRepository | undefined>(this, undefined);

		/*
		 * ⚠️ Constrained to the folder the window is on, not merely one more source of "most recent
		 * wins". An editor or a focused row from another folder must not move this: the window says
		 * which folder it is on, and the graph and the status bar have to agree with it.
		 *
		 * ⚠️ And read through the active-folder observable, or nothing recomputes on a switch: with
		 * no editor open, `latestChangedValue` never changes, so the first repository stays and the
		 * graph goes on drawing a history the window has left.
		 */
		const latest = latestChangedValue(this, [this._activeEditorRepositoryObs, this._focusedRepositoryObs]);
		this._activeRepositoryObs = derived(this, reader => {
			this._activeFolderObs.read(reader);

			const visible = this.visibleRepositories;
			const candidate = latest.read(reader);

			return (candidate && visible.some(r => r.id === candidate.id)) ? candidate : visible[0];
		});

		this.activeRepository = derivedOpts<{ repository: ISCMRepository; pinned: boolean } | undefined>({
			owner: this,
			equalsFn: (r1, r2) => r1?.repository.id === r2?.repository.id && r1?.pinned === r2?.pinned
		}, reader => {
			const activeRepository = this._activeRepositoryObs.read(reader);
			const activeRepositoryPinned = this._activeRepositoryPinnedObs.read(reader);

			const repository = activeRepositoryPinned ?? activeRepository;
			const pinned = !!activeRepositoryPinned;

			return repository ? { repository, pinned } : undefined;
		});

		this.disposables.add(runOnChange(this.selectionModeConfig, selectionMode => {
			if (selectionMode === ISCMRepositorySelectionMode.Single && this.selectedRepositories.length > 1) {
				const repository = this.selectedRepositories[0];
				this.visibleRepositories = [repository];
			} else if (selectionMode === ISCMRepositorySelectionMode.Multiple && this.repositories.length > 1) {
				this.visibleRepositories = this.repositories;
			}
		}));

		this._repositoriesSortKey = this.previousState?.sortKey ?? this.getViewSortOrder();
		this._sortKeyContextKey = RepositoryContextKeys.RepositorySortKey.bindTo(contextKeyService);
		this._sortKeyContextKey.set(this._repositoriesSortKey);

		this._selectionModelContextKey = RepositoryContextKeys.RepositorySelectionMode.bindTo(contextKeyService);
		this.disposables.add(autorun(reader => {
			const selectionMode = this.selectionModeConfig.read(reader);
			this._selectionModelContextKey.set(selectionMode);
		}));

		scmService.onDidAddRepository(this.onDidAddRepository, this, this.disposables);
		scmService.onDidRemoveRepository(this.onDidRemoveRepository, this, this.disposables);

		for (const repository of scmService.repositories) {
			this.onDidAddRepository(repository);
		}

		storageService.onWillSaveState(this.onWillSaveState, this, this.disposables);

		// Maintain repository selection when the extension host restarts.
		// Extension host is restarted after installing an extension update
		// or during a profile switch.
		extensionService.onWillStop(() => {
			this.onWillSaveState();
			this.didFinishLoadingRepositories.set(false, undefined);
		}, this, this.disposables);
	}

	private onDidAddRepository(repository: ISCMRepository): void {
		if (!this.didFinishLoadingRepositories.get()) {
			this.eventuallyFinishLoading();
		}

		const repositoryView = {
			repository, discoveryTime: Date.now(), focused: false, selectionIndex: -1
		} satisfies ISCMRepositoryView;

		let removed: Iterable<ISCMRepository> = Iterable.empty();

		if (this.previousState && !this.didFinishLoadingRepositories.get()) {
			const index = this.previousState.all.indexOf(getProviderStorageKey(repository.provider));

			if (index === -1) {
				// This repository is not part of the previous state which means that it
				// was either manually closed in the previous session, or the repository
				// was added after the previous session. In this case, we should select
				// all of the repositories.
				const added: ISCMRepository[] = [];

				this.insertRepositoryView(this._repositories, repositoryView);

				if (this.selectionModeConfig.get() === ISCMRepositorySelectionMode.Multiple || !this._repositories.find(r => r.selectionIndex !== -1)) {
					// Multiple selection mode or single selection mode (select first repository)
					this._repositories.forEach((repositoryView, index) => {
						if (repositoryView.selectionIndex === -1) {
							added.push(repositoryView.repository);
						}
						repositoryView.selectionIndex = index;
					});

					this._onDidChangeRepositories.fire({ added, removed: Iterable.empty() });
				}

				this.didSelectRepository = false;
				return;
			}

			if (this.previousState.visible.indexOf(index) === -1) {
				// Explicit selection started
				if (this.didSelectRepository) {
					this.insertRepositoryView(this._repositories, repositoryView);
					this._onDidChangeRepositories.fire({ added: Iterable.empty(), removed: Iterable.empty() });
					return;
				}
			} else {
				// First visible repository
				if (!this.didSelectRepository) {
					removed = [...this.visibleRepositories];
					this._repositories.forEach(r => {
						r.focused = false;
						r.selectionIndex = -1;
					});

					this.didSelectRepository = true;
				}
			}
		}

		if (this.selectionModeConfig.get() === ISCMRepositorySelectionMode.Multiple || !this._repositories.find(r => r.selectionIndex !== -1)) {
			// Multiple selection mode or single selection mode (select first repository)
			const maxSelectionIndex = this.getMaxSelectionIndex();
			this.insertRepositoryView(this._repositories, { ...repositoryView, selectionIndex: maxSelectionIndex + 1 });
			this._onDidChangeRepositories.fire({ added: [repositoryView.repository], removed });
		} else {
			// Single selection mode (add subsequent repository)
			this.insertRepositoryView(this._repositories, repositoryView);
			this._onDidChangeRepositories.fire({ added: Iterable.empty(), removed });
		}

		// Focus repository if nothing is focused
		if (!this._repositories.find(r => r.focused)) {
			this.focus(repository);
		}
	}

	private onDidRemoveRepository(repository: ISCMRepository): void {
		if (!this.didFinishLoadingRepositories.get()) {
			this.eventuallyFinishLoading();
		}

		const repositoriesIndex = this._repositories.findIndex(r => r.repository === repository);

		if (repositoriesIndex === -1) {
			return;
		}

		let added: Iterable<ISCMRepository> = Iterable.empty();
		const removed = this._repositories.splice(repositoriesIndex, 1);

		// ⚠️ `selectedRepositories`: this writes a selection, so it has to ask whether anything is
		// chosen, not whether anything is on screen. A window sitting on a folder with no repository
		// in it would otherwise select another folder's the moment any repository is removed.
		if (this._repositories.length > 0 && this.selectedRepositories.length === 0) {
			this._repositories[0].selectionIndex = 0;
			added = [this._repositories[0].repository];
		}

		this._onDidChangeRepositories.fire({ added, removed: removed.map(r => r.repository) });

		// Check if the focused repository was removed
		if (removed.length === 1 && removed[0].focused && this.visibleRepositories.length > 0) {
			this.focus(this.visibleRepositories[0]);
		}

		// Check if the last repository was removed
		if (removed.length === 1 && this._repositories.length === 0) {
			this._onDidFocusRepository.fire(undefined);
		}

		// Check if the pinned repository was removed
		if (removed.length === 1 && removed[0].repository === this._activeRepositoryPinnedObs.get()) {
			this._activeRepositoryPinnedObs.set(undefined, undefined);
		}
	}

	/**
	 * ⚠️ Whether the person has chosen this repository, not whether it is on screen: a repository
	 * chosen in another folder answers `true` here while `visibleRepositories` leaves it out. That is
	 * what its callers want - they draw the checkbox in the Repositories view and guard `focus` - but
	 * the name reads the other way, so it is worth saying.
	 */
	isVisible(repository: ISCMRepository): boolean {
		return this._repositories.find(r => r.repository === repository)?.selectionIndex !== -1;
	}

	toggleVisibility(repository: ISCMRepository, visible?: boolean): void {
		if (typeof visible === 'undefined') {
			visible = !this.isVisible(repository);
		} else if (this.isVisible(repository) === visible) {
			return;
		}

		if (visible) {
			if (this.selectionModeConfig.get() === ISCMRepositorySelectionMode.Single) {
				this.visibleRepositories = [repository];
			} else if (this.selectionModeConfig.get() === ISCMRepositorySelectionMode.Multiple) {
				this.visibleRepositories = [...this.selectedRepositories, repository];
			}
		} else {
			const index = this.selectedRepositories.indexOf(repository);

			if (index > -1) {
				this.visibleRepositories = [
					...this.selectedRepositories.slice(0, index),
					...this.selectedRepositories.slice(index + 1)
				];
			}
		}
	}

	toggleSortKey(sortKey: ISCMRepositorySortKey): void {
		this._repositoriesSortKey = sortKey;
		this._sortKeyContextKey.set(this._repositoriesSortKey);
		this._repositories.sort(this.compareRepositories.bind(this));

		this._onDidChangeRepositories.fire({ added: Iterable.empty(), removed: Iterable.empty() });
	}

	toggleSelectionMode(selectionMode: 'multiple' | 'single'): void {
		this.configurationService.updateValue('scm.repositories.selectionMode', selectionMode);
	}

	focus(repository: ISCMRepository | undefined): void {
		if (repository && !this.isVisible(repository)) {
			return;
		}

		this._repositories.forEach(r => r.focused = r.repository === repository);

		if (this._repositories.find(r => r.focused)) {
			this._onDidFocusRepository.fire(repository);
		}
	}

	pinActiveRepository(repository: ISCMRepository | undefined): void {
		this._activeRepositoryPinnedObs.set(repository, undefined);
	}

	private compareRepositories(op1: ISCMRepositoryView, op2: ISCMRepositoryView): number {
		// Sort by discovery time
		if (this._repositoriesSortKey === ISCMRepositorySortKey.DiscoveryTime) {
			return op1.discoveryTime - op2.discoveryTime;
		}

		// Sort by path
		if (this._repositoriesSortKey === 'path' && op1.repository.provider.rootUri && op2.repository.provider.rootUri) {
			return comparePaths(op1.repository.provider.rootUri.fsPath, op2.repository.provider.rootUri.fsPath);
		}

		// Sort by name, path
		const name1 = getRepositoryName(this.workspaceContextService, op1.repository);
		const name2 = getRepositoryName(this.workspaceContextService, op2.repository);

		const nameComparison = compareFileNames(name1, name2);
		if (nameComparison === 0 && op1.repository.provider.rootUri && op2.repository.provider.rootUri) {
			return comparePaths(op1.repository.provider.rootUri.fsPath, op2.repository.provider.rootUri.fsPath);
		}

		return nameComparison;
	}

	private getMaxSelectionIndex(): number {
		return this._repositories.length === 0 ? -1 :
			Math.max(...this._repositories.map(r => r.selectionIndex));
	}

	private getViewSortOrder(): ISCMRepositorySortKey {
		const sortOder = this.configurationService.getValue<'discovery time' | 'name' | 'path'>('scm.repositories.sortOrder');
		switch (sortOder) {
			case 'discovery time':
				return ISCMRepositorySortKey.DiscoveryTime;
			case 'name':
				return ISCMRepositorySortKey.Name;
			case 'path':
				return ISCMRepositorySortKey.Path;
			default:
				return ISCMRepositorySortKey.DiscoveryTime;
		}
	}

	private insertRepositoryView(repositories: ISCMRepositoryView[], repositoryView: ISCMRepositoryView): void {
		const index = binarySearch(repositories, repositoryView, this.compareRepositories.bind(this));
		repositories.splice(index < 0 ? ~index : index, 0, repositoryView);
	}

	private onWillSaveState(): void {
		if (!this.didFinishLoadingRepositories.get()) {
			// Don't remember state, if the workbench didn't really finish loading
			return;
		}

		const all = this.repositories.map(r => getProviderStorageKey(r.provider));
		// ⚠️ `selectedRepositories`, never the narrowed getter. What is written here is the person's
		// choice and it outlives the window: writing what was on screen records the folder the window
		// happened to be closed on as a deselection of every other folder's repository, and nothing
		// ever puts them back.
		const visible = this.selectedRepositories.map(r => all.indexOf(getProviderStorageKey(r.provider)));
		this.previousState = { all, visible, sortKey: this._repositoriesSortKey } satisfies ISCMViewServiceState;

		this.storageService.store('scm:view:visibleRepositories', JSON.stringify(this.previousState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	@debounce(5000)
	private eventuallyFinishLoading(): void {
		this.finishLoading();
	}

	private finishLoading(): void {
		if (this.didFinishLoadingRepositories.get()) {
			return;
		}

		this.didFinishLoadingRepositories.set(true, undefined);
	}

	dispose(): void {
		this.disposables.dispose();
		this._onDidFocusRepository.dispose();
		this._onDidChangeRepositories.dispose();
		this._onDidSetVisibleRepositories.dispose();
	}
}
