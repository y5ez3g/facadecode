/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce } from '../../../../base/common/arrays.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopy } from '../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { IRunningWork, IWorkspaceBarAgentsService } from './workspaceBarAgents.js';
import { IWorkspaceBarCustomizationService } from './workspaceBarCustomization.js';
import { IDeletedWorktree, IWorkspaceBarRepository } from './workspaceBarGit.js';
import { WorkspaceBarModel } from './workspaceBarModel.js';
import { agentsFirst, discardedHeading, fileLine, listedFiles, listedSessions, placeNameFor, terminatedHeading, workLine } from './workspaceBarQuestions.js';
import { IRemoveOptions, RemoveResult } from './workspaceBarService.js';
import { IPutAwayEditorsService } from '../../../services/putAwayEditors/common/putAwayEditors.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';

/** The folders Remove Folder takes out for `folder`: on a repository's row, also its worktrees and other spellings (WORKTREE.md WT-8.8). */
export function foldersToRemove(folder: URI, repository: IWorkspaceBarRepository | undefined, isEqual: (a: URI, b: URI) => boolean): URI[] {
	if (!repository || !isEqual(repository.main, folder)) {
		return [folder];
	}

	return [folder, ...repository.members.map(member => member.uri).filter(uri => !isEqual(uri, folder))];
}

/** The rows that leave with the last of `repository`'s folders without being workspace folders themselves. */
export function rowsLeavingWith(repository: IWorkspaceBarRepository | undefined, leaving: readonly URI[], isEqual: (a: URI, b: URI) => boolean): URI[] {
	const repositoryLeaves = !!repository && repository.members.every(member => leaving.some(uri => isEqual(uri, member.uri)));
	return repository && repositoryLeaves
		? [...repository.worktrees.filter(worktree => !worktree.folder).map(worktree => worktree.uri), ...(repository.folder ? [] : [repository.main])]
		: [];
}

/** What taking folders out of the workspace would lose, named in one confirmation (WORKSPACE.md W9.6). */
export interface IRemovalLoss {
	/** The agents, and the terminals running a process, that stop with the folders. */
	readonly work: readonly IRunningWork[];

	/** The unsaved working copies of the folders, those put away with them, and untitled ones on screen when the active folder leaves. */
	readonly unsaved: readonly IWorkingCopy[];

	/** Where each of `work` runs, and each of `unsaved` goes from: a folder leaving, or a row leaving with it. */
	readonly places: ReadonlyMap<IRunningWork | IWorkingCopy, URI>;
}

/** Whether `loss` loses nothing beyond what the person `agreed` to. */
export function isCoveredBy(loss: IRemovalLoss, agreed: IRemovalLoss | undefined): boolean {
	if (!loss.work.length && !loss.unsaved.length) {
		return true;
	}
	if (!agreed) {
		return false;
	}

	const work = new Set(agreed.work.map(item => item.id));
	const unsaved = new Set(agreed.unsaved);
	return loss.work.every(item => work.has(item.id)) && loss.unsaved.every(workingCopy => unsaved.has(workingCopy));
}

/** The person's answer: remove and discard unsaved changes, or just remove. */
type Answer = 'discard' | 'remove';

/** Takes folders out of the workspace for every caller alike, asking first only when something would be lost (WORKSPACE.md W9.6). */
export class WorkspaceBarRemoval {

	private readonly removing: ResourceSet;
	private readonly deleting: ResourceSet;

	constructor(
		private readonly model: WorkspaceBarModel,
		private readonly repositoryFor: (uri: URI) => IWorkspaceBarRepository | undefined,
		@IDialogService private readonly dialogService: IDialogService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceBarAgentsService private readonly agentsService: IWorkspaceBarAgentsService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@IPutAwayEditorsService private readonly putAwayEditorsService: IPutAwayEditorsService,
		@IActiveFolderService private readonly activeFolderService: IActiveFolderService,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
	) {
		this.removing = new ResourceSet(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		this.deleting = new ResourceSet(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
	}

	/** Whether `folder` is leaving through `remove`, so its terminals stop with it rather than move to the panel. */
	isRemoving(folder: URI): boolean {
		return this.removing.has(folder);
	}

	/** Whether `folder` is leaving through `remove` for its worktree's deletion, which stops its terminals itself. */
	isDeleting(folder: URI): boolean {
		return this.deleting.has(folder);
	}

	async remove(uris: readonly URI[], options: IRemoveOptions = {}): Promise<RemoveResult> {
		let agreed: IRemovalLoss | undefined;
		let discarded: readonly IWorkingCopy[] = [];
		let requested: IWorkspaceFolder[];
		let leaving: IWorkspaceFolder[];

		// Worked out again after every answer, as anything may have changed while the dialog was up
		for (; ;) {
			({ requested, leaving } = await this.leaving(uris));
			if (!leaving.length) {
				return { kind: 'removed', folders: [] };
			}
			if (options.confirmed) {
				break;
			}

			const loss = this.lossOf(leaving);
			if (isCoveredBy(loss, agreed)) {
				break;
			}

			const answer = await this.ask(requested, leaving, loss);
			if (!answer) {
				return { kind: 'cancelled' };
			}

			discarded = answer === 'discard' ? loss.unsaved : [];
			agreed = loss;
		}

		this.logService.trace(`[workspaceBar] Removing ${leaving.map(folder => folder.uri.toString(true)).join(', ')}`);
		const marked = options.deleting ? this.deleting : this.removing;
		for (const folder of leaving) {
			marked.add(folder.uri);
		}
		try {
			await this.model.remove(leaving.map(folder => folder.uri));
		} catch (error) {
			const reason = toErrorMessage(error);
			this.notificationService.error(localize('workspaceBar.notRemoved', "Failed to update workspace: {0}", reason));
			return { kind: 'failed', reason };
		} finally {
			for (const folder of leaving) {
				marked.delete(folder.uri);
			}
		}

		// The edit did not apply and the workspace has reported why: nothing stopped or was discarded
		if (leaving.some(folder => this.isMember(folder.uri))) {
			return { kind: 'failed', reason: localize('workspaceBar.notRemovedReason', "failed to write the workspace configuration file") };
		}

		await this.closeUnsaved(discarded);
		return { kind: 'removed', folders: leaving.map(folder => folder.uri) };
	}

	/**
	 * Takes out of the workspace the folders that were worktrees git no longer records (WORKTREE.md WT-3.8), as a folder
	 * leaves where nothing could ask (WORKSPACE.md W9.6): nothing asked, and not marked as removing, so that the disk is
	 * left alone, unsaved editors are kept and what runs in them moves to the panel. The window on one goes to its
	 * repository's row first, through `switchTo`, where that is in the workspace, and once it has left the person is
	 * told why. What each was made with goes with it (WT-1.12). Resolves with whether they left.
	 */
	async removeDeleted(deleted: readonly IDeletedWorktree[], switchTo: (folder: URI) => Promise<void>): Promise<boolean> {
		// A window on one folder has no workspace to take it out of
		if (this.contextService.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
			return false;
		}

		// Another read's may have taken them out already
		const members = deleted.filter(({ folder }) => this.isMember(folder.uri));
		if (!members.length) {
			return true;
		}

		const active = this.activeFolderService.activeFolder?.uri;
		const onScreen = active && members.find(({ folder }) => this.uriIdentityService.extUri.isEqual(folder.uri, active));
		// Named as the window shows it now: once it has left, nothing names it
		const name = onScreen && this.customizationService.nameFor(onScreen.folder);
		if (onScreen) {
			const main = await this.model.resolve(onScreen.main);
			if (main) {
				await switchTo(main.uri);
			}
		}

		const uris = members.map(({ folder }) => folder.uri);
		this.logService.info(`[workspaceBar] Removing worktrees git no longer records: ${uris.map(uri => uri.toString(true)).join(', ')}`);
		try {
			await this.model.remove(uris);
		} catch (error) {
			this.notificationService.error(localize('workspaceBar.notRemoved', "Failed to update workspace: {0}", toErrorMessage(error)));
			return false;
		}

		// The edit did not apply, and the workspace has reported why
		if (uris.some(uri => this.isMember(uri))) {
			return false;
		}

		members.forEach(({ folder }) => this.customizationService.forget(folder.uri));
		if (name) {
			this.notificationService.info(localize('workspaceBar.worktreeDeleted', "Worktree '{0}' was deleted and removed from the workspace.", name));
		}
		return true;
	}

	/** The requested workspace folders, and every workspace folder that leaves with them (`foldersToRemove`). */
	private async leaving(uris: readonly URI[]): Promise<{ requested: IWorkspaceFolder[]; leaving: IWorkspaceFolder[] }> {
		const isEqual = (a: URI, b: URI) => this.uriIdentityService.extUri.isEqual(a, b);
		const resolved = coalesce(await Promise.all(uris.map(uri => this.model.resolve(uri))));
		const going = resolved.flatMap(folder => foldersToRemove(folder.uri, this.repositoryFor(folder.uri), isEqual));

		const folders = this.contextService.getWorkspace().folders;
		return {
			requested: folders.filter(folder => resolved.some(other => isEqual(other.uri, folder.uri))),
			leaving: folders.filter(folder => going.some(uri => isEqual(uri, folder.uri)))
		};
	}

	/** What would be lost if `leaving` left now. */
	private lossOf(leaving: readonly IWorkspaceFolder[]): IRemovalLoss {
		const isEqual = (a: URI, b: URI) => this.uriIdentityService.extUri.isEqual(a, b);
		const uris = leaving.map(folder => folder.uri);

		const repositories = new Map<string, IWorkspaceBarRepository>();
		for (const uri of uris) {
			const repository = this.repositoryFor(uri);
			if (repository) {
				repositories.set(this.uriIdentityService.extUri.getComparisonKey(repository.main), repository);
			}
		}
		const rows = [...repositories.values()].flatMap(repository => rowsLeavingWith(repository, uris, isEqual));

		const work = new Map<number, IRunningWork>();
		const places = new Map<IRunningWork | IWorkingCopy, URI>();
		for (const uri of [...uris, ...rows]) {
			for (const item of this.agentsService.workIn(uri)) {
				if (!work.has(item.id)) {
					work.set(item.id, item);
					places.set(item, uri);
				}
			}
		}

		// The workspace folder that contains a file owns it, so a file of a nested folder that stays is kept
		const ofLeaving = (resource: URI) => {
			const folder = this.contextService.getWorkspaceFolder(resource);
			return folder && uris.some(uri => isEqual(uri, folder.uri)) ? folder.uri : undefined;
		};

		// A put-away file is lost with its folder unless it is also on screen or held by a folder that stays
		const holds = (folder: URI, resource: URI) => this.putAwayEditorsService.get(folder).some(held => isEqual(held, resource));
		const onScreen = this.editorService.getEditors(EditorsOrder.SEQUENTIAL).flatMap(({ editor }) => editor.resource ? [editor.resource] : []);
		const staying = this.putAwayEditorsService.folders().filter(folder => !uris.some(uri => isEqual(uri, folder)));
		const putAwayInLeaving = (resource: URI) => !onScreen.some(shown => isEqual(shown, resource)) && !staying.some(folder => holds(folder, resource))
			? uris.find(uri => holds(uri, resource))
			: undefined;

		// An untitled file on screen belongs to the active folder, and leaves with it (WORKSPACE.md W6.2)
		const active = this.activeFolderService.activeFolder?.uri;
		const activeLeaves = !!active && uris.some(uri => isEqual(uri, active));
		const newOnScreen = (resource: URI) => activeLeaves && resource.scheme === Schemas.untitled && onScreen.some(shown => isEqual(shown, resource)) ? active : undefined;

		const unsaved: IWorkingCopy[] = [];
		for (const workingCopy of this.workingCopyService.dirtyWorkingCopies) {
			const from = ofLeaving(workingCopy.resource) ?? putAwayInLeaving(workingCopy.resource) ?? newOnScreen(workingCopy.resource);
			if (from) {
				unsaved.push(workingCopy);
				places.set(workingCopy, from);
			}
		}

		return { work: [...work.values()].sort((a, b) => a.id - b.id), unsaved, places };
	}

	/** Asks once, worded as VS Code's delete confirmation (WORKSPACE.md W10.7); undefined for Cancel. */
	private async ask(requested: readonly IWorkspaceFolder[], leaving: readonly IWorkspaceFolder[], loss: IRemovalLoss): Promise<Answer | undefined> {
		const extUri = this.uriIdentityService.extUri;
		const worktrees = leaving.filter(folder => !requested.some(other => extUri.isEqual(other.uri, folder.uri))
			&& !!this.repositoryFor(folder.uri)?.worktrees.some(worktree => extUri.isEqual(worktree.uri, folder.uri)));
		const names = [...requested, ...worktrees].map(folder => this.customizationService.nameFor(folder));

		// Each line says where it is, but where the question names the one folder all of it is in
		const named = requested.length === 1 && !worktrees.length ? requested[0].uri : undefined;
		const placed = !named || [...loss.places.values()].some(uri => !extUri.isEqual(uri, named));
		const placeOf = (item: IRunningWork | IWorkingCopy) => {
			const uri = placed ? loss.places.get(item) : undefined;
			const folder = uri && this.contextService.getWorkspace().folders.find(candidate => extUri.isEqual(candidate.uri, uri));
			return uri && placeNameFor(this.customizationService, uri, folder, this.repositoryFor(uri), extUri);
		};

		// Each list under what becomes of it, then what does not (WORKSPACE.md W10.7)
		const paragraphs: string[] = [];
		if (requested.length > 1) {
			paragraphs.push(names.join('\n'));
		}
		if (loss.work.length) {
			const work = agentsFirst(loss.work);
			paragraphs.push([terminatedHeading(work), ...listedSessions(work.map(item => workLine(item, placeOf(item))))].join('\n'));
		}
		if (loss.unsaved.length) {
			paragraphs.push([discardedHeading(loss.unsaved.length), ...listedFiles(loss.unsaved.map(workingCopy => fileLine(workingCopy.name, placeOf(workingCopy))))].join('\n'));
		}
		paragraphs.push(localize('workspaceBar.removeKeepsDisk', "Files on disk will not be deleted."));

		const { result } = await this.dialogService.prompt<Answer>({
			type: 'warning',
			message: requested.length > 1
				? localize('workspaceBar.removeFoldersQuestion', "Are you sure you want to remove the following {0} folders from the workspace?", names.length)
				: !worktrees.length
					? localize('workspaceBar.removeFolderQuestion', "Are you sure you want to remove '{0}' from the workspace?", names[0])
					: worktrees.length === 1
						? localize('workspaceBar.removeFolderAndWorktree', "Are you sure you want to remove '{0}' and its worktree from the workspace?", names[0])
						: localize('workspaceBar.removeFolderAndWorktrees', "Are you sure you want to remove '{0}' and its {1} worktrees from the workspace?", names[0], worktrees.length),
			detail: paragraphs.join('\n\n'),
			buttons: loss.unsaved.length
				? [{ label: localize({ key: 'workspaceBar.removeAndDiscard', comment: ['&& denotes a mnemonic'] }, "&&Remove and Discard Changes"), run: () => 'discard' }]
				: [{ label: localize({ key: 'workspaceBar.removeFolderButton', comment: ['&& denotes a mnemonic'] }, "&&Remove"), run: () => 'remove' }],
			cancelButton: true
		});

		return result;
	}

	/** Discards the changes the person agreed to lose, and closes their editors. */
	private async closeUnsaved(discarded: readonly IWorkingCopy[]): Promise<void> {
		for (const workingCopy of discarded) {
			if (workingCopy.isDirty()) {
				await workingCopy.revert({ soft: true });
			}
		}

		const resources = new ResourceSet(discarded.map(workingCopy => workingCopy.resource), uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		const editors = this.editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => !!editor.resource && resources.has(editor.resource));
		if (editors.length) {
			await this.editorService.closeEditors(editors, { preserveFocus: true });
		}
	}

	private isMember(uri: URI): boolean {
		return this.contextService.getWorkspace().folders.some(folder => this.uriIdentityService.extUri.isEqual(folder.uri, uri));
	}
}
