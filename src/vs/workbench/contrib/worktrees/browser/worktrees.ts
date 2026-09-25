/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../base/common/htmlContent.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { Schemas } from '../../../../base/common/network.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { basename, joinPath, toLocalResource } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { isObject } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalExitReason, TerminalSettingId } from '../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { asCodeSpan } from '../../../browser/parts/workspacebar/workspaceBar.js';
import { DELETE_WORKTREE_COMMAND, NEW_WORKTREE_COMMAND, WORKSPACE_BAR_CATEGORY, WORKTREES_SHOWN, WorkspaceBarContextMenu, WorkspaceBarRowKindContext, WorkspaceBarRowToolbar } from '../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarCustomizationService, worktreeNameFor } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarDialogService } from '../../../browser/parts/workspacebar/workspaceBarCustomize.js';
import { findWorktree, IWorkspaceBarRepository } from '../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { getShellIntegrationTimeout } from '../../terminal/common/terminalEnvironment.js';

/*
 * Making and deleting worktrees from the workspace bar (WORKTREE.md sections 7 to 10). A contribution
 * rather than part of the bar, because setup runs in a terminal and `vs/workbench/browser` may not
 * import `contrib/terminal`.
 */

/** Where the product puts worktrees: `<home>/.facade/worktrees/<repository>/<name>` (WT-2.1). */
const WORKTREES = ['.facade', 'worktrees'];

/** Windows device names, refused as a worktree's folder on every OS (WT-2.2). */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * The folder name a branch gets: `/` becomes `-`, as upstream's `createWorktree` does, and so does
 * every character Windows forbids in a file name - on every OS, so one branch makes one directory
 * everywhere. Undefined for a name that cannot be a folder at all.
 */
export function worktreeFolderName(branch: string): string | undefined {
	const name = branch.trim().replace(/[\/\\<>:"|?*]/g, '-');
	return name && !DEVICE_NAME.test(name) ? name : undefined;
}

/** `<parent>/<name>`, or `-1`, `-2`... after it until the path is free (WT-2.3). */
export async function freeWorktreeUri(parent: URI, name: string, exists: (uri: URI) => Promise<boolean>): Promise<URI> {
	let candidate = joinPath(parent, name);
	for (let suffix = 1; await exists(candidate); suffix++) {
		candidate = joinPath(parent, `${name}-${suffix}`);
	}

	return candidate;
}

/**
 * The name `freeWorktreeUri` would choose, given the names already `taken`, for the dialog to show as
 * the branch is typed. `freeWorktreeUri` still decides, against the disk when the worktree is made.
 */
export function freeWorktreeName(name: string, taken: (candidate: string) => boolean): string {
	let candidate = name;
	for (let suffix = 1; taken(candidate); suffix++) {
		candidate = `${name}-${suffix}`;
	}

	return candidate;
}

type SetupCommands =
	| { readonly kind: 'none' }
	| { readonly kind: 'lines'; readonly lines: readonly string[] }
	| { readonly kind: 'invalid' };

/**
 * The lines `.facade/worktrees.json` asks for on this OS - Cursor's format (WT-7.2): the OS's own key,
 * `setup-worktree-windows` or `setup-worktree-unix`, and `setup-worktree` when it has none.
 */
export function readSetupCommands(content: string, windows: boolean): SetupCommands {
	const errors: ParseError[] = [];
	const value: unknown = parse(content, errors);
	if (errors.length || !isObject(value)) {
		return { kind: 'invalid' };
	}

	const settings = value as Record<string, unknown>;
	const lines = settings[windows ? 'setup-worktree-windows' : 'setup-worktree-unix'] ?? settings['setup-worktree'];
	if (lines === undefined) {
		return { kind: 'none' };
	}

	if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) {
		return { kind: 'invalid' };
	}

	// An empty list is how one OS says it needs no setup, so no terminal is opened.
	return lines.length > 0 ? { kind: 'lines', lines } : { kind: 'none' };
}

/** A failure the git extension's worktree commands return (`extensions/git/src/worktreeAt.ts`). */
type WorktreeAtError = { readonly kind: 'error'; readonly code: string | undefined; readonly message: string };

/**
 * What `_git.createWorktreeAt` returns. `created` says what `.worktreeinclude` could not copy, and
 * git's words when its post-checkout hook failed - after git had made the worktree, which it keeps.
 */
type CreateWorktreeAtResult =
	| { readonly kind: 'created'; readonly copyFailures: readonly string[]; readonly hookFailure: string | undefined }
	| WorktreeAtError;

/** What `_git.prepareWorktreeBaseAt` returns. */
type WorktreeBaseAtResult =
	| { readonly kind: 'ready' }
	| { readonly kind: 'uninitialized'; readonly files: number; readonly identity: boolean | undefined; readonly enclosing: string | undefined }
	| { readonly kind: 'unborn'; readonly files: number; readonly identity: boolean }
	| WorktreeAtError;

/** A failure with one of the fork's own codes, in the product's words; `undefined` for git's own. */
function explainFailure(error: WorktreeAtError | undefined, main: URI, branch?: string): string | undefined {
	switch (error?.code) {
		// What reaches the extension as other than a folder on disk: a virtual file system's, say.
		case 'InvalidArgument':
			return localize('worktrees.notOnDisk', "\"{0}\" is not a folder on disk, which is where Git works.", basename(main));
		case 'UnreadableGitDirectory':
			return localize('worktrees.notARepository', "\"{0}\" has a .git folder that Git cannot read as a repository.", basename(main));
		// Git's own words for it end with the way out, which a notification of its first line would lose.
		case 'NotASafeGitRepository':
			return localize('worktrees.unsafeRepository', "Git does not open \"{0}\", which is owned by another user. To trust it, run {1}, then try again.", basename(main), `git config --global --add safe.directory ${main.scheme === Schemas.file ? main.fsPath : main.path}`);
		case 'InheritedGitEnvironment':
			return localize('worktrees.inheritedEnvironment', "This window was started with GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE set, which points Git at another repository. Open the folder in a new window.");
		case 'InvalidBranchName':
			return localize('worktrees.invalidBranchName', "\"{0}\" is not a valid branch name.", branch ?? '');
		case 'InitialBranch':
			return localize('worktrees.initialBranch', "The initial commit goes on \"{0}\", so the worktree needs a branch with another name.", branch ?? '');
		case 'UnbornBranch':
			return localize('worktrees.unbornBranch', "\"{0}\" is on a branch with no commits yet. Switch to a branch with commits, or commit on this one, and try again.", basename(main));
		case 'WorktreeContainsChanges':
			return localize('worktrees.changedSinceCheck', "Files in the worktree changed after it was checked. Try again to see what would be lost.");
		case 'NoIdentity':
			return noIdentityMessage();
		default:
			return undefined;
	}
}

/** A failure in git's words. */
function gitMessage(error: WorktreeAtError | undefined): string {
	return error?.message ?? localize('worktrees.noAnswer', "Git did not answer.");
}

/**
 * The git extension's `command` could not run at all: the extension is not running - turned off, or
 * not started in this window - or it failed.
 */
function gitUnreachable(command: string, err: unknown): string {
	return CommandsRegistry.getCommand(command)
		? localize('worktrees.noGit', "Git could not be reached to make the worktree: {0}", toErrorMessage(err))
		: gitExtensionNotRunning();
}

function gitExtensionNotRunning(): string {
	return localize('worktrees.noGitExtension', "Worktrees are made and deleted with the Git extension, which is not running in this window.");
}

function noIdentityMessage(): string {
	return localize('worktrees.noIdentity', "Git user name and email are not configured, and a commit requires them. Set them with {0} and {1}, then try again.", 'git config --global user.name', 'git config --global user.email');
}

/** A path spelled for the OS the folder is on - the remote's, for a folder on a remote. */
function toOsPath(uri: URI, windows: boolean): string {
	if (uri.scheme === Schemas.file) {
		return uri.fsPath;
	}

	return windows ? uri.path.replace(/^\/(?=[a-zA-Z]:)/, '').replace(/\//g, '\\') : uri.path;
}

/**
 * Whether the git extension can run git. Not part of `WORKTREES_SHOWN`: the bar reads worktrees from
 * git's files and lists them without git.
 */
const GIT_AVAILABLE = ContextKeyExpr.and(ContextKeyExpr.notEquals('config.git.enabled', false), ContextKeyExpr.not('git.missing'));

/** How long to wait for the switch to put the new worktree's editors up before running setup anyway. */
const RESTORE_TIMEOUT = 5000;

/**
 * How long the git extension is given to register its commands once trust starts it - the time the
 * command service gives extensions starting up before it calls a command missing.
 */
const GIT_START_TIMEOUT = 30000;

/** How many files a confirmation names before it says how many more there are. */
const LISTED_FILES = 10;

/** How many of the files `.worktreeinclude` could not copy a notification names. */
const LISTED_COPY_FAILURES = 3;

/**
 * What `_git.deleteWorktreeAt` returns. `checked`, for `check`: the files whose changes would be lost,
 * and whether it has submodules checked out, which git deletes only by force.
 */
type DeleteWorktreeAtResult =
	| { readonly kind: 'checked'; readonly files: readonly string[]; readonly submodules: boolean }
	| { readonly kind: 'removed' }
	| WorktreeAtError;

export const IWorktreeService = createDecorator<IWorktreeService>('worktreeService');

/** Making and deleting the workspace bar's worktrees (WORKTREE.md sections 7 to 10). */
export interface IWorktreeService {
	readonly _serviceBrand: undefined;

	/**
	 * New Worktree for `target`, or for the row the bar's commands act on. A worktree's own row makes
	 * one of its repository; a folder the bar does not know as part of a repository makes one of
	 * itself, becoming a repository first if it has to (WT-5.8).
	 */
	createWorktree(target: URI | undefined): Promise<void>;

	/** Delete Worktree for `target`, or for the row the bar's commands act on. */
	deleteWorktree(target: URI | undefined): Promise<void>;
}

export class WorktreeService implements IWorktreeService {

	declare readonly _serviceBrand: undefined;

	/** The repositories being given a worktree and the worktrees being deleted: one run for each at a time. */
	private readonly running: ResourceSet;

	constructor(
		@IWorkspaceBarService private readonly workspaceBarService: IWorkspaceBarService,
		@IWorkspaceBarCustomizationService private readonly customizationService: IWorkspaceBarCustomizationService,
		@IWorkspaceBarDialogService private readonly workspaceBarDialogService: IWorkspaceBarDialogService,
		@IActiveFolderService private readonly activeFolderService: IActiveFolderService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceTrustEnablementService private readonly workspaceTrustEnablementService: IWorkspaceTrustEnablementService,
		@IWorkspaceTrustRequestService private readonly workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IFolderTerminalsService private readonly folderTerminalsService: IFolderTerminalsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILabelService private readonly labelService: ILabelService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
	) {
		this.running = new ResourceSet(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
	}

	async createWorktree(target: URI | undefined): Promise<void> {
		target ??= this.workspaceBarService.folderForCommand();
		if (!target) {
			return;
		}

		const repository = this.workspaceBarService.repositoryFor(target);
		const main = repository?.main ?? target;
		const worktree = await this.runOnce(main, () => this.doCreateWorktree(main, repository));

		// WT-7, once the run is over: a setup line can take minutes or never end - a server - and neither
		// holds up the repository's next worktree, nor whoever asked for this one, which is ready.
		if (worktree) {
			this.runSetup(main, worktree).catch(onUnexpectedError);
		}
	}

	async deleteWorktree(target: URI | undefined): Promise<void> {
		target ??= this.workspaceBarService.folderForCommand();
		if (!target) {
			return;
		}

		const repository = this.workspaceBarService.repositoryFor(target);
		const worktree = findWorktree(repository, target, this.uriIdentityService.extUri);
		if (!repository || !worktree) {
			this.notificationService.info(localize('worktrees.notWorktree', "{0} is not a worktree the workspace knows.", this.labelService.getUriLabel(target)));
			return;
		}

		await this.runOnce(worktree.uri, () => this.doDeleteWorktree(repository.main, worktree.uri, worktree.branch, worktreeNameFor(this.customizationService, worktree)));
	}

	/**
	 * Runs `task` for `uri` unless a run for it is still going - a second click on a row that is being
	 * worked on - and returns what it returned.
	 */
	private async runOnce<T>(uri: URI, task: () => Promise<T>): Promise<T | undefined> {
		if (this.running.has(uri)) {
			return undefined;
		}

		this.running.add(uri);
		try {
			return await task();
		} finally {
			this.running.delete(uri);
		}
	}

	/**
	 * Whether the workspace is trusted, asking for it if not: the git extension does not run in
	 * Restricted Mode. Trust given here starts the extension only after it is given, so the git
	 * extension's `command` is waited for rather than reported missing.
	 */
	private async requestWorkspaceTrust(command: string): Promise<boolean> {
		if (!this.workspaceTrustEnablementService.isWorkspaceTrustEnabled() || this.workspaceTrustManagementService.isWorkspaceTrusted()) {
			return true;
		}

		if (!await this.workspaceTrustRequestService.requestWorkspaceTrust({ message: localize('worktrees.restricted', "Worktrees are made and deleted with Git, which does not run in Restricted Mode.") })) {
			return false;
		}

		await this.progressService.withProgress(
			{ location: ProgressLocation.Window, title: localize('worktrees.startingGit', "Starting Git...") },
			() => whenRegistered(command, GIT_START_TIMEOUT));
		return true;
	}

	/**
	 * WT-5.6, in its order: look, name, prepare, create, trust, expand, show, wait - and returns the
	 * worktree, for setup to run in once the window is on it.
	 *
	 * `repository` is what the bar last read of `main`, and undefined for a folder it does not know as a
	 * repository - one that has none of its own yet, which this makes it (WT-5.8).
	 */
	private async doCreateWorktree(main: URI, repository: IWorkspaceBarRepository | undefined): Promise<URI | undefined> {
		const trustEnabled = this.workspaceTrustEnablementService.isWorkspaceTrustEnabled();
		if (!await this.requestWorkspaceTrust('_git.prepareWorktreeBaseAt')) {
			return undefined;
		}

		// WT-5.1: an untrusted repository gets no worktree - a new one would be trusted as it is made.
		if (trustEnabled && !(await this.workspaceTrustManagementService.getUriTrustInfo(main)).trusted
			&& !await this.workspaceTrustRequestService.requestResourcesTrust({ uri: main, message: localize('worktrees.untrusted', "A worktree of {0} is trusted as it is made. Trust {0} first.", this.labelService.getUriLabel(main)) })) {
			return undefined;
		}

		// WT-5.8: whether the folder has a commit to start from, and if not, what giving it one will take -
		// asked before the dialog, so the dialog can say so. Nothing on disk changes here.
		let base: WorktreeBaseAtResult | undefined;
		try {
			base = await this.progressService.withProgress(
				{ location: ProgressLocation.Window, title: localize('worktrees.inspecting', "Reading {0}...", basename(main)) },
				() => this.commandService.executeCommand<WorktreeBaseAtResult>('_git.prepareWorktreeBaseAt', main, 'inspect'));
		} catch (err) {
			this.notificationService.error(gitUnreachable('_git.prepareWorktreeBaseAt', err));
			return undefined;
		}

		if (!base || base.kind === 'error') {
			this.notificationService.error(explainFailure(base, main)
				?? localize('worktrees.inspectFailed', "Git could not read {0}: {1}", this.labelService.getUriLabel(main), gitMessage(base)));
			return undefined;
		}

		const prepare = base.kind === 'ready' ? undefined : {
			notice: [
				// A folder inside another repository is told so: "not a Git repository" would not be true of it.
				base.kind === 'uninitialized' && base.enclosing
					? localize('worktrees.insideRepository', "\"{0}\" is inside the Git repository \"{1}\". It will get a repository of its own, initialized using git init.", basename(main), base.enclosing)
					: base.kind === 'uninitialized'
						? localize('worktrees.notRepositoryYet', "\"{0}\" is not a Git repository. It will be initialized using git init.", basename(main))
						: localize('worktrees.noCommitsYet', "\"{0}\" has no commits for a worktree to branch off from.", basename(main)),
				base.files === 0
					? localize('worktrees.firstCommitEmpty', "An empty initial commit will be created as the base for the new worktree.")
					: base.files === 1
						? localize('worktrees.firstCommitOne', "An initial commit of the 1 file not excluded by .gitignore will be created as the base for the new worktree.")
						: localize('worktrees.firstCommitMany', "An initial commit of the {0} files not excluded by .gitignore will be created as the base for the new worktree.", base.files)
			],
			action: localize('worktrees.initializeAndCreate', "Initialize and Create"),
			// Said before anything is done: without a name and an email, git refuses the commit. Not when
			// that is for the new repository to decide, as `includeIf` can; then the commit says so.
			blocked: base.identity === false ? noIdentityMessage() : undefined
		};

		const parent = joinPath(await this.pathService.userHome(), ...WORKTREES, basename(main));

		// From the home folder, so the part the branch makes fits on the dialog's line.
		const separator = this.labelService.getSeparator(parent.scheme, parent.authority);
		const parentLabel = ['~', ...WORKTREES, basename(main)].join(separator) + separator;

		// The names already taken, so the Location line shows the `-1` the worktree will get.
		const caseSensitive = this.fileService.hasCapability(parent, FileSystemProviderCapabilities.PathCaseSensitive);
		const nameKey = (candidate: string) => caseSensitive ? candidate : candidate.toLowerCase();
		const taken = new Set<string>();
		try {
			for (const child of (await this.fileService.resolve(parent)).children ?? []) {
				taken.add(nameKey(child.name));
			}
		} catch {
			// No folder yet for this repository's worktrees: nothing in it is taken.
		}

		// WT-5.2: the branch, where it starts and the folder it goes in, with the name and colour beside it.
		const origin = prepare
			? localize('worktrees.startsAtFirst', "Branches off from the initial commit.")
			: localize('worktrees.startsAt', "Branches off from HEAD of \"{0}\".", basename(main));
		const answer = await this.workspaceBarDialogService.showNewWorktreeDialog(basename(main), origin, value => {
			const trimmed = value.trim();
			if (!trimmed) {
				// The folder it will be made in, waiting for the branch to finish its name.
				return { message: localize('worktrees.folder', "Location: {0}", parentLabel), valid: false };
			}

			const folder = worktreeFolderName(trimmed);
			if (!folder) {
				return { message: localize('worktrees.badName', "\"{0}\" cannot be the name of a folder on Windows.", trimmed), valid: false, error: true };
			}

			return { message: localize('worktrees.folder', "Location: {0}", parentLabel + freeWorktreeName(folder, candidate => taken.has(nameKey(candidate)))), valid: true };
		}, prepare);

		const branch = answer?.branch;
		const name = branch && worktreeFolderName(branch);
		if (!answer || !branch || !name) {
			return undefined;
		}

		// WT-5.8: the repository and its initial commit, now that the button that says so was pressed.
		if (prepare) {
			let prepared: WorktreeBaseAtResult | undefined;
			try {
				prepared = await this.progressService.withProgress(
					{ location: ProgressLocation.Notification, title: localize('worktrees.preparing', "Creating the initial commit of \"{0}\"...", basename(main)) },
					// With the branch, so a name git refuses is caught before anything changes.
					() => this.commandService.executeCommand<WorktreeBaseAtResult>('_git.prepareWorktreeBaseAt', main, 'initialize', branch));
			} catch (err) {
				this.notificationService.error(gitUnreachable('_git.prepareWorktreeBaseAt', err));
				return undefined;
			}

			if (prepared?.kind !== 'ready') {
				const error = prepared?.kind === 'error' ? prepared : undefined;
				const message = gitMessage(error);
				this.logService.warn(`[worktrees] preparing ${main.toString(true)} failed: ${message}`);
				this.notificationService.error(explainFailure(error, main, branch)
					?? localize('worktrees.prepareFailed', "Could not create the initial commit of \"{0}\": {1}", basename(main), message));
				return undefined;
			}
		}

		const worktree = await freeWorktreeUri(parent, name, candidate => this.fileService.exists(candidate));

		// Before git writes its record, which the bar reads a row from while the files are still being
		// checked out. Written even when nothing was chosen: customizations are kept by path, and one left
		// by a worktree deleted outside the bar would otherwise be worn by this one. Taken back if none is made.
		this.customizationService.set(worktree, answer.customization);

		// WT-5.4: not cancellable - a half-made worktree is worse than waiting.
		let result: CreateWorktreeAtResult | undefined;
		try {
			result = await this.progressService.withProgress(
				{ location: ProgressLocation.Notification, title: localize('worktrees.creating', "Creating worktree {0}...", answer.customization.name || branch) },
				() => this.commandService.executeCommand<CreateWorktreeAtResult>('_git.createWorktreeAt', main, worktree, branch));
		} catch (err) {
			this.customizationService.set(worktree, {});
			this.notificationService.error(gitUnreachable('_git.createWorktreeAt', err));
			return undefined;
		}

		if (!result || result.kind === 'error') {
			this.customizationService.set(worktree, {});
			this.reportCreateFailure(main, repository, branch, worktree, result);
			return undefined;
		}

		// WT-6.4: a file that did not copy is said once, and stops nothing.
		if (result.copyFailures.length > 0) {
			this.notificationService.warn(localize('worktrees.copyFailed', "{0} of what .worktreeinclude names could not be copied into the worktree: {1}", result.copyFailures.length, result.copyFailures.slice(0, LISTED_COPY_FAILURES).join(', ')));
		}

		// Nor does a hook that failed: git kept the worktree, and so does this.
		if (result.hookFailure) {
			this.notificationService.warn(localize('worktrees.hookFailed', "The worktree was created, but a Git hook failed: {0}", result.hookFailure));
		}

		if (trustEnabled) {
			await this.workspaceTrustManagementService.setUrisTrust([worktree], true);
		}

		// So the row the window is about to go to can be seen.
		this.workspaceBarService.setExpanded(main, true);

		// WT-5.7: setup waits for the switch to restore the worktree's editors, which closes whatever
		// else is in the editor area. Subscribed before the switch; cancelled however it ends.
		const restored = Event.toPromise(this.workspaceBarService.onDidRestoreEditors);
		try {
			await this.workspaceBarService.show(worktree);
			await raceTimeout(restored, RESTORE_TIMEOUT);
		} finally {
			restored.cancel();
		}

		return worktree;
	}

	/** WT-5.3 and WT-5.5: git's errors are the checks, and each is said on screen in words. */
	private reportCreateFailure(main: URI, repository: IWorkspaceBarRepository | undefined, branch: string, worktree: URI, result: CreateWorktreeAtResult | undefined): void {
		const error = result?.kind === 'error' ? result : undefined;
		this.logService.warn(`[worktrees] creating ${worktree.toString(true)} failed: ${error?.message ?? 'no answer'}`);

		if (error?.code === 'BranchAlreadyExists') {
			// Always `-b`, so this is any branch that exists. When a checkout has it, offer to go there.
			const holder = repository?.branch === branch
				? repository.main
				: repository?.worktrees.find(candidate => candidate.branch === branch)?.uri;
			if (holder) {
				this.notificationService.prompt(Severity.Info,
					localize('worktrees.branchCheckedOut', "Branch {0} is already checked out in {1}.", branch, this.labelService.getUriLabel(holder)),
					[{ label: localize('worktrees.goThere', "Go There"), run: () => this.workspaceBarService.show(holder) }]);
				return;
			}

			this.notificationService.error(localize('worktrees.branchExists', "A branch named {0} already exists. Choose another name.", branch));
			return;
		}

		if (error?.code === 'WorktreeAlreadyExists') {
			this.notificationService.error(localize('worktrees.pathExists', "Something is already at {0}.", this.labelService.getUriLabel(worktree)));
			return;
		}

		this.notificationService.error(explainFailure(error, main, branch)
			?? localize('worktrees.createFailed', "The worktree could not be made: {0}", gitMessage(error)));
	}

	/**
	 * WT-7: the lines of `.facade/worktrees.json`, run in a terminal of the worktree - in the person's
	 * own shell, with the output on screen. A failing line leaves the worktree usable.
	 */
	private async runSetup(main: URI, worktree: URI): Promise<void> {
		const content = await this.readFirst([joinPath(worktree, '.facade', 'worktrees.json'), joinPath(main, '.facade', 'worktrees.json')]);
		if (content === undefined) {
			return;
		}

		// The OS the terminal will run on - the remote's, for a folder on a remote.
		const windows = (await this.pathService.path).sep === '\\';
		const setup = readSetupCommands(content, windows);
		if (setup.kind === 'none') {
			return;
		}

		if (setup.kind === 'invalid') {
			this.notificationService.warn(localize('worktrees.badSetup', ".facade/worktrees.json could not be read: each setup key has to be a list of command lines. Nothing was run."));
			return;
		}

		const terminal = await this.terminalService.createTerminal({
			config: {
				name: localize('worktrees.setupTerminal', "Worktree Setup"),
				cwd: worktree,
				// Cursor's name for it, so a script written for Cursor's worktrees.json works here.
				env: { ROOT_WORKTREE_PATH: toOsPath(main, windows) }
			}
		});
		this.terminalService.setActiveInstance(terminal);
		await this.terminalService.revealTerminal(terminal);

		// WT-7.4: each line whatever the one before did, one at a time: the next is sent once shell
		// integration says the last finished, or straight after it without shell integration.
		const detection = await this.commandDetection(terminal);
		for (const line of setup.lines) {
			if (!await runSetupLine(terminal, detection, line)) {
				return;
			}
		}
	}

	/**
	 * The shell integration of a terminal that has only just started, given as long to light up as the
	 * terminal's own commands give it; undefined without it.
	 */
	private async commandDetection(terminal: ITerminalInstance): Promise<ICommandDetectionCapability | undefined> {
		const detection = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (detection) {
			return detection;
		}

		const injected = this.configurationService.getValue(TerminalSettingId.ShellIntegrationEnabled) === true;
		const store = new DisposableStore();
		try {
			return await raceTimeout(Event.toPromise(terminal.capabilities.onDidAddCommandDetectionCapability, store), getShellIntegrationTimeout(this.configurationService, injected, terminal.hasRemoteAuthority));
		} finally {
			store.dispose();
		}
	}

	/** The first of these files that can be read. */
	private async readFirst(candidates: readonly URI[]): Promise<string | undefined> {
		for (const candidate of candidates) {
			try {
				return (await this.fileService.readFile(candidate)).value.toString();
			} catch {
				// Not there; the next one, then.
			}
		}

		return undefined;
	}

	/**
	 * WT-8, in its order: everything that could hold the directory open is gone before git is asked to
	 * delete it. `branch` is undefined for a worktree on a detached HEAD.
	 */
	private async doDeleteWorktree(main: URI, worktree: URI, branch: string | undefined, name: string): Promise<void> {
		if (!await this.requestWorkspaceTrust('_git.deleteWorktreeAt')) {
			return;
		}

		const run = (mode: 'check' | 'remove' | 'force') => this.commandService.executeCommand<DeleteWorktreeAtResult>('_git.deleteWorktreeAt', main, worktree, mode);

		// 1  check: what would be lost, before anybody is asked.
		let check: DeleteWorktreeAtResult | undefined;
		try {
			check = await run('check');
		} catch (err) {
			this.notificationService.error(CommandsRegistry.getCommand('_git.deleteWorktreeAt') ? localize('worktrees.noGitDelete', "Git could not be reached to delete the worktree: {0}", toErrorMessage(err)) : gitExtensionNotRunning());
			return;
		}

		if (!check || check.kind !== 'checked') {
			const error = check?.kind === 'error' ? check : undefined;
			this.notificationService.error(explainFailure(error, main)
				?? localize('worktrees.checkFailed', "The worktree could not be checked before deleting it: {0}", gitMessage(error)));
			return;
		}

		// 2  confirm: always, naming what would be lost (WT-8.1, WT-8.2) - and anything running in a terminal
		//    that goes with it: one working inside it, or one of its editor area whatever it started in.
		const running = [...await this.terminalsInside(worktree), ...this.folderTerminalsService.terminalsOf(worktree)].some(instance => instance.hasChildProcesses);
		if (!(await this.confirmDelete(worktree, branch, check, running))) {
			return;
		}

		// 3 to 6 under one progress: a large tree takes a while to delete, and its row stays until git's
		// records change.
		const force = check.files.length > 0 || check.submodules;
		const result = await this.progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('worktrees.deleting', "Deleting worktree {0}...", name) },
			async (): Promise<DeleteWorktreeAtResult | undefined> => {
				// 3  move off, to the repository's own row rather than whichever folder is next in the list (WT-8.3).
				const active = this.activeFolderService.activeFolder;
				if (active && this.uriIdentityService.extUri.isEqual(active.uri, worktree)) {
					await this.workspaceBarService.show(main);
				}

				// 4  leave folders[] - which also makes folderTerminals dispose what it parked for it (WT-8.4).
				await this.workspaceBarService.remove([worktree]);

				// 5  close whatever else works inside it - the panel's terminals, say. A shell can take a moment
				//    to let go of the folder after its terminal is disposed; the git extension's delete allows for that.
				for (const instance of await this.terminalsInside(worktree)) {
					instance.dispose(TerminalExitReason.User);
				}

				// 6  delete. `force` only when the confirmation named what it throws away.
				try {
					return await run(force ? 'force' : 'remove');
				} catch (err) {
					return { kind: 'error', code: undefined, message: toErrorMessage(err) };
				}
			});

		// 7  nothing to refresh: the bar's reader sees git's records change (WT-8.6 when it went wrong).
		if (result?.kind !== 'removed') {
			const error = result?.kind === 'error' ? result : undefined;
			const message = gitMessage(error);
			this.logService.warn(`[worktrees] deleting ${worktree.toString(true)} failed: ${message}`);
			this.notificationService.error(explainFailure(error, main) ?? localize('worktrees.deleteFailed', "The worktree could not be deleted: {0}", message));
			return;
		}

		// Its name, colour, place and the trust it was given go with it: they are kept by path, and the next
		// worktree of the same branch lands on the same path.
		this.customizationService.set(worktree, {});
		const order = this.customizationService.worktreeOrder(main);
		if (order) {
			this.customizationService.setWorktreeOrder(main, order.filter(candidate => !this.uriIdentityService.extUri.isEqual(candidate, worktree)));
		}
		if (this.workspaceTrustEnablementService.isWorkspaceTrustEnabled()) {
			await this.workspaceTrustManagementService.setUrisTrust([worktree], false);
		}
	}

	/**
	 * The terminals working inside the worktree - where they are now, or where they started. Only
	 * terminals on the worktree's own machine: a cwd is a path of the machine its terminal runs on.
	 */
	private async terminalsInside(worktree: URI): Promise<ITerminalInstance[]> {
		const remoteAuthority = worktree.scheme === Schemas.vscodeRemote ? worktree.authority : undefined;
		if (worktree.scheme !== Schemas.file && !remoteAuthority) {
			return [];
		}

		const inside: ITerminalInstance[] = [];
		for (const instance of this.terminalService.instances) {
			if (instance.remoteAuthority !== remoteAuthority) {
				continue;
			}

			for (const cwd of [instance.cwd, instance.initialCwd]) {
				// `fileURI` spells the path for the remote's OS, as a `file` URI: the worktree's is the remote's own.
				const location = cwd && (remoteAuthority ? toLocalResource(await this.pathService.fileURI(cwd), remoteAuthority, Schemas.vscodeRemote) : URI.file(cwd));
				if (location && this.uriIdentityService.extUri.isEqualOrParent(location, worktree)) {
					inside.push(instance);
					break;
				}
			}
		}

		return inside;
	}

	private async confirmDelete(worktree: URI, branch: string | undefined, check: { readonly files: readonly string[]; readonly submodules: boolean }, running: boolean): Promise<boolean> {
		const { files, submodules } = check;
		const detail = new MarkdownString();
		detail.appendMarkdown(`${asCodeSpan(this.labelService.getUriLabel(worktree))}\n\n`);

		if (files.length > 0) {
			detail.appendMarkdown(escapeMarkdownSyntaxTokens(localize('worktrees.loses', "These changes have not been committed and will be lost:")));
			detail.appendMarkdown('\n\n');
			for (const file of files.slice(0, LISTED_FILES)) {
				detail.appendMarkdown(`- ${asCodeSpan(file)}\n`);
			}
			if (files.length > LISTED_FILES) {
				detail.appendMarkdown(`- ${escapeMarkdownSyntaxTokens(localize('worktrees.andMore', "and {0} more", files.length - LISTED_FILES))}\n`);
			}
			detail.appendMarkdown('\n');
		}

		// A worktree's submodules keep their git directories in its own, which goes with it.
		if (submodules) {
			detail.appendMarkdown(escapeMarkdownSyntaxTokens(localize('worktrees.submodules', "Its submodules will be deleted with it, including any of their commits that have not been pushed.")));
			detail.appendMarkdown('\n\n');
		}

		if (running) {
			detail.appendMarkdown(escapeMarkdownSyntaxTokens(localize('worktrees.running', "Something is running in one of its terminals; it will be stopped.")));
			detail.appendMarkdown('\n\n');
		}

		// A worktree on a detached HEAD has no branch to keep, and is not told it has one.
		if (branch) {
			detail.appendMarkdown(escapeMarkdownSyntaxTokens(localize('worktrees.branchKept', "The associated branch \"{0}\" will not be deleted.", branch)));
		}

		const { confirmed } = await this.dialogService.confirm({
			type: files.length > 0 || submodules ? 'warning' : 'none',
			message: localize('worktrees.deleteMessage', "Delete Worktree?"),
			detail,
			primaryButton: files.length > 0
				? localize({ key: 'worktrees.deleteDiscardButton', comment: ['&& denotes a mnemonic'] }, "&&Delete and Discard Changes")
				: localize({ key: 'worktrees.deleteButton', comment: ['&& denotes a mnemonic'] }, "&&Delete"),
			custom: {
				classes: ['facade-dialog', 'workspacebar-confirm'],
				disableCloseButton: true
			}
		});

		return confirmed;
	}
}

/**
 * Runs one setup line; false once the terminal is gone.
 *
 * With shell integration, it waits for the line's own command to finish - known by the id it is run
 * with, as the next command the shell reports finishing need not be this one. Without, the line is
 * typed straight after the last: nothing would say when that one finished.
 */
async function runSetupLine(terminal: ITerminalInstance, detection: ICommandDetectionCapability | undefined, line: string): Promise<boolean> {
	if (terminal.isDisposed) {
		return false;
	}

	if (!detection) {
		await terminal.sendText(line, true);
		return !terminal.isDisposed;
	}

	const store = new DisposableStore();
	try {
		const id = generateUuid();
		const finished = Event.toPromise(Event.filter(detection.onCommandFinished, command => command.id === id), store).then(() => true);
		const disposed = Event.toPromise(terminal.onDisposed, store).then(() => false);
		await terminal.runCommand(line, true, id);
		return await Promise.race([finished, disposed]);
	} finally {
		store.dispose();
	}
}

/** Resolves once `command` is registered, or after `timeoutMs`, whichever comes first. */
async function whenRegistered(command: string, timeoutMs: number): Promise<void> {
	if (CommandsRegistry.getCommand(command)) {
		return;
	}

	const store = new DisposableStore();
	try {
		await raceTimeout(Event.toPromise(Event.filter(CommandsRegistry.onDidRegisterCommand, id => id === command), store), timeoutMs);
	} finally {
		store.dispose();
	}
}

export class NewWorktreeAction extends Action2 {

	constructor() {
		super({
			id: NEW_WORKTREE_COMMAND,
			title: localize2('worktrees.newWorktree', "New Worktree..."),
			category: WORKSPACE_BAR_CATEGORY,
			icon: Codicon.add,
			f1: true,
			// Off in the palette too while the bar lists no worktrees (WORKTREE.md section 11).
			precondition: ContextKeyExpr.and(WORKTREES_SHOWN, GIT_AVAILABLE),
			menu: [{
				// First in the menu, as the explorer puts New File first. On every folder's row: a folder
				// without a repository is made one first (WT-5.8).
				id: WorkspaceBarContextMenu, group: 'navigation', order: 1,
				when: ContextKeyExpr.and(WorkspaceBarRowKindContext.notEqualsTo('worktree'), WORKTREES_SHOWN)
			}, {
				// The row's `+`, there only while it can be used (WT-5.1, WT-5.5). A worktree's row has none.
				id: WorkspaceBarRowToolbar, group: 'navigation', order: 1,
				when: ContextKeyExpr.and(WORKTREES_SHOWN, GIT_AVAILABLE)
			}]
		});
	}

	override run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		return accessor.get(IWorktreeService).createWorktree(URI.isUri(uri) ? uri : undefined);
	}
}

export class DeleteWorktreeAction extends Action2 {

	constructor() {
		super({
			id: DELETE_WORKTREE_COMMAND,
			title: localize2('worktrees.deleteWorktree', "Delete Worktree..."),
			category: WORKSPACE_BAR_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(WORKTREES_SHOWN, GIT_AVAILABLE),
			menu: { id: WorkspaceBarContextMenu, group: '9_remove', order: 2, when: WorkspaceBarRowKindContext.isEqualTo('worktree') }
		});
	}

	override run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		return accessor.get(IWorktreeService).deleteWorktree(URI.isUri(uri) ? uri : undefined);
	}
}
