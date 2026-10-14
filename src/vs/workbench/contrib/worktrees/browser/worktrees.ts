/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { Schemas } from '../../../../base/common/network.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { basename, joinPath, toLocalResource } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { EditorsOrder } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopy } from '../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
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
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService, IWorkspaceTrustRequestService, WorkspaceTrustRequestButton } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService, isSingleFolderWorkspaceIdentifier, toWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { unreachable } from '../../../browser/parts/workspacebar/workspaceBar.js';
import { DELETE_WORKTREE_COMMAND, NEW_WORKTREE_COMMAND, WORKSPACE_BAR_CATEGORY, WORKTREES_SHOWN, WorkspaceBarContextMenu, WorkspaceBarRowKindContext, WorkspaceBarRowToolbar } from '../../../browser/parts/workspacebar/workspaceBarActions.js';
import { freeWorktreeColor, IFolderCustomization, IWorkspaceBarCustomizationService, worktreeNameFor } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarDialogService } from '../../../browser/parts/workspacebar/workspaceBarCustomize.js';
import { findWorktree, IWorkspaceBarRepository } from '../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { getShellIntegrationTimeout } from '../../terminal/common/terminalEnvironment.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/*
 * Making and deleting worktrees from the workspace bar (WORKTREE.md WT-5 to WT-8). A contribution
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
			return localize('worktrees.notOnDisk', "'{0}' is not a valid folder on disk.", basename(main));
		case 'UnreadableGitDirectory':
			return localize('worktrees.notARepository', "'{0}' contains a .git folder that cannot be read as a valid Git repository.", basename(main));
		// Git's own words for it end with the way out, which a notification of its first line would lose.
		case 'NotASafeGitRepository':
			return localize('worktrees.unsafeRepository', "Git cannot open '{0}' because it is owned by another user. Run '{1}' to mark it safe, then try again.", basename(main), `git config --global --add safe.directory ${main.scheme === Schemas.file ? main.fsPath : main.path}`);
		case 'InheritedGitEnvironment':
			return localize('worktrees.inheritedEnvironment', "This window was started with GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE set, redirecting Git to another repository. Please open the folder in a new window.");
		case 'InvalidBranchName':
			return localize('worktrees.invalidBranchName', "'{0}' is not a valid branch name.", branch ?? '');
		case 'InitialBranch':
			return localize('worktrees.initialBranch', "The initial commit is on '{0}'. Please choose a different branch name for the new worktree.", branch ?? '');
		case 'UnbornBranch':
			return localize('worktrees.unbornBranch', "Repository '{0}' has no commits on the current branch. Create a commit or switch branches first.", basename(main));
		case 'WorktreeContainsChanges':
			return localize('worktrees.changedSinceCheck', "Files in the worktree were modified after verification. Please review changes and try again.");
		case 'NoIdentity':
			return noIdentityMessage();
		default:
			return undefined;
	}
}

/** A failure in git's words. */
function gitMessage(error: WorktreeAtError | undefined): string {
	return error?.message ?? localize('worktrees.noAnswer', "Git process did not respond.");
}

/**
 * The git extension's `command` could not run at all: the extension is not running - turned off, or
 * not started in this window - or it failed.
 */
function gitUnreachable(command: string, err: unknown): string {
	return CommandsRegistry.getCommand(command)
		? localize('worktrees.noGit', "Failed to execute the Git command to create the worktree: {0}", toErrorMessage(err))
		: gitExtensionNotRunning();
}

function gitExtensionNotRunning(): string {
	return localize('worktrees.noGitExtension', "Worktree operations require the built-in Git extension, which is not active in this window.");
}

function noIdentityMessage(): string {
	return localize('worktrees.noIdentity', "Git user name and email are not configured. Run '{0}' and '{1}', then try again.", 'git config --global user.name', 'git config --global user.email');
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

/**
 * How long the git extension is given to register its commands once trust starts it - the time the
 * command service gives extensions starting up before it calls a command missing.
 */
const GIT_START_TIMEOUT = 30000;

/** How many files a confirmation names before it says how many more there are. */
const LISTED_FILES = 10;

/** How many ignored paths a confirmation names before it says how many more there are. */
const LISTED_IGNORED = 5;

/** How many of the files `.worktreeinclude` could not copy a notification names. */
const LISTED_COPY_FAILURES = 3;

/** What `_git.deleteWorktreeAt` returns (WT-8.6). */
type DeleteWorktreeAtResult =
	| { readonly kind: 'checked'; readonly files: readonly string[]; readonly ignoredPaths: readonly string[]; readonly submodules: boolean; readonly restrictions: readonly { readonly kind: 'locked'; readonly reason: string }[] }
	| { readonly kind: 'removed' }
	| WorktreeAtError;

/** What deleting a worktree would lose, as its confirmation names it. */
interface IDeletionLoss {
	readonly files: readonly string[];
	readonly ignoredPaths: readonly string[];
	readonly submodules: boolean;
	/** Unsaved editors of files inside it, wherever they are open or put away. */
	readonly unsaved: readonly string[];
}

export const IWorktreeService = createDecorator<IWorktreeService>('worktreeService');

/** Making and deleting the workspace bar's worktrees (WORKTREE.md WT-5 to WT-8). */
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

	/**
	 * A worktree of `main` on the new branch `branch`, made without asking anything, for a caller that
	 * has decided already - an agent sending a child out to a worktree of its own. Setup runs as for
	 * New Worktree. Throws, in the product's words, when it cannot be made.
	 *
	 * Nothing is asked, so nothing that would have been asked is done: a workspace or repository that
	 * is not trusted, or a folder with no commit yet, is refused rather than trusted or given one.
	 */
	makeWorktree(main: URI, branch: string, options?: IMakeWorktreeOptions): Promise<URI>;

	/** Says which worktrees' setup a window that closed was still sending, without sending it again (WT-7.7). */
	reportUnfinishedSetup(): Promise<void>;
}

/** Where a window notes the setup it is still sending, for the next window to report (WT-7.7). */
const SETUP_IN_FLIGHT_KEY = 'facade.worktrees.setupInFlight';

/** How `makeWorktree` makes a worktree. */
export interface IMakeWorktreeOptions {
	/** The commit it starts at, a full commit id; HEAD when there is none. */
	readonly startPoint?: string;
	/** Whether the window goes to it, as after New Worktree; it stays where it is otherwise. */
	readonly show?: boolean;
}

/** What `createDecided` came to: the worktree made, or why not. */
type CreateOutcome =
	| { readonly kind: 'created'; readonly worktree: URI; readonly result: Extract<CreateWorktreeAtResult, { kind: 'created' }> }
	| { readonly kind: 'failed'; readonly worktree: URI; readonly result: CreateWorktreeAtResult | undefined; readonly unreachable?: string };

export class WorktreeService implements IWorktreeService {

	declare readonly _serviceBrand: undefined;

	/**
	 * The repositories being given a worktree and the worktrees being deleted: one run for each at a
	 * time. A worktree being made for an agent is `waitedFor`: what comes for its repository meanwhile
	 * goes once it is made, rather than being dropped as a second click (WT-5.10).
	 */
	private readonly running: ResourceMap<{ readonly done: Promise<void>; readonly waitedFor: boolean }>;

	/** Worktrees whose setup this window has started, so that none is sent twice (WT-7.7). */
	private readonly setupStarted: ResourceMap<true>;

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
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		this.running = new ResourceMap(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		this.setupStarted = new ResourceMap(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
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
			this.notificationService.info(localize('worktrees.notWorktree', "'{0}' is not a recognized worktree in this workspace.", this.labelService.getUriLabel(target)));
			return;
		}

		await this.runOnce(worktree.uri, () => this.doDeleteWorktree(repository.main, worktree.uri, worktree.branch, worktreeNameFor(this.customizationService, worktree)));
	}

	async makeWorktree(main: URI, branch: string, options: IMakeWorktreeOptions = {}): Promise<URI> {
		const root = this.workspaceBarService.repositoryFor(main)?.main ?? main;
		const worktree = await this.runInTurn(root, () => this.doMakeWorktree(root, branch.trim(), options));

		// As after New Worktree: setup goes on in its own terminal, and holds nothing up.
		this.runSetup(root, worktree).catch(onUnexpectedError);
		return worktree;
	}

	/**
	 * Runs `task` for `uri` unless a run for it is still going - a second click on a row that is being
	 * worked on - and returns what it returned. A worktree being made for an agent is waited for
	 * instead: New Worktree goes once it is made (WT-5.10).
	 */
	private async runOnce<T>(uri: URI, task: () => Promise<T>): Promise<T | undefined> {
		for (let going = this.running.get(uri); going; going = this.running.get(uri)) {
			if (!going.waitedFor) {
				return undefined;
			}
			await going.done;
		}
		return this.run(uri, task, false);
	}

	/**
	 * Runs `task` for `uri` once what runs for it is done: the worktrees agents ask for in one repository
	 * are made one after another, none refused for another being made (WT-5.10).
	 */
	private async runInTurn<T>(uri: URI, task: () => Promise<T>): Promise<T> {
		for (let going = this.running.get(uri); going; going = this.running.get(uri)) {
			await going.done;
		}
		return this.run(uri, task, true);
	}

	private async run<T>(uri: URI, task: () => Promise<T>, waitedFor: boolean): Promise<T> {
		const done = new DeferredPromise<void>();
		this.running.set(uri, { done: done.p, waitedFor });
		try {
			return await task();
		} finally {
			this.running.delete(uri);
			done.complete();
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

		// No Manage button: it would leave the worktree being made or deleted for the trust editor
		const trustAndContinue: WorkspaceTrustRequestButton = {
			label: isSingleFolderWorkspaceIdentifier(toWorkspaceIdentifier(this.contextService.getWorkspace()))
				? localize({ key: 'worktrees.trustFolder', comment: ['&& denotes a mnemonic'] }, "&&Trust Folder & Continue")
				: localize({ key: 'worktrees.trustWorkspace', comment: ['&& denotes a mnemonic'] }, "&&Trust Workspace & Continue"),
			type: 'ContinueWithTrust'
		};
		if (!await this.workspaceTrustRequestService.requestWorkspaceTrust({
			message: localize('worktrees.restricted', "Worktrees require Git operations, which are disabled in Restricted Mode."),
			buttons: [trustAndContinue]
		})) {
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
			&& !await this.workspaceTrustRequestService.requestResourcesTrust({ uri: main, message: localize('worktrees.untrusted', "A worktree inherits trust from its parent repository '{0}'. Please trust the repository first.", this.labelService.getUriLabel(main)) })) {
			return undefined;
		}

		// WT-5.8: whether the folder has a commit to start from, and if not, what giving it one will take -
		// asked before the dialog, so the dialog can say so. Nothing on disk changes here.
		let base: WorktreeBaseAtResult | undefined;
		try {
			base = await this.progressService.withProgress(
				{ location: ProgressLocation.Window, title: localize('worktrees.inspecting', "Reading repository '{0}'...", basename(main)) },
				() => this.commandService.executeCommand<WorktreeBaseAtResult>('_git.prepareWorktreeBaseAt', main, 'inspect'));
		} catch (err) {
			this.notificationService.error(gitUnreachable('_git.prepareWorktreeBaseAt', err));
			return undefined;
		}

		if (!base || base.kind === 'error') {
			this.notificationService.error(explainFailure(base, main)
				?? localize('worktrees.inspectFailed', "Git failed to read repository '{0}': {1}", this.labelService.getUriLabel(main), gitMessage(base)));
			return undefined;
		}

		const prepare = base.kind === 'ready' ? undefined : {
			notice: [
				// A folder inside another repository is told so: "not a Git repository" would not be true of it.
				base.kind === 'uninitialized' && base.enclosing
					? localize('worktrees.insideRepository', "Folder '{0}' is inside the Git repository '{1}'. A new repository will be initialized.", basename(main), base.enclosing)
					: base.kind === 'uninitialized'
						? localize('worktrees.notRepositoryYet', "Folder '{0}' is not a Git repository. It will be initialized with 'git init'.", basename(main))
						: localize('worktrees.noCommitsYet', "Repository '{0}' contains no commits. An initial commit is required to branch off.", basename(main)),
				base.files === 0
					? localize('worktrees.firstCommitEmpty', "An empty initial commit will be created for the new worktree.")
					: base.files === 1
						? localize('worktrees.firstCommitOne', "An initial commit containing 1 file (excluding files ignored by Git) will be created.")
						: localize('worktrees.firstCommitMany', "An initial commit containing {0} files (excluding files ignored by Git) will be created.", base.files)
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
			? localize('worktrees.startsAtFirst', "Branches off the initial commit.")
			: localize('worktrees.startsAt', "Branches off HEAD of '{0}'.", basename(main));
		const answer = await this.workspaceBarDialogService.showNewWorktreeDialog(basename(main), origin, value => {
			const trimmed = value.trim();
			if (!trimmed) {
				// The folder it will be made in, waiting for the branch to finish its name.
				return { message: localize('worktrees.folder', "Location: {0}", parentLabel), valid: false };
			}

			const folder = worktreeFolderName(trimmed);
			if (!folder) {
				return { message: localize('worktrees.badName', "'{0}' is not a valid folder name on Windows.", trimmed), valid: false, error: true };
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
					{ location: ProgressLocation.Notification, title: localize('worktrees.preparing', "Creating initial commit in '{0}'...", basename(main)) },
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
					?? localize('worktrees.prepareFailed', "Failed to create the initial commit for '{0}': {1}", basename(main), message));
				return undefined;
			}
		}

		const created = await this.createDecided(main, branch, name, parent, answer.customization, undefined);
		if (created.kind === 'failed') {
			if (created.unreachable) {
				this.notificationService.error(created.unreachable);
			} else {
				this.reportCreateFailure(main, repository, branch, created.worktree, created.result);
			}
			return undefined;
		}

		const after = await this.afterCreate(main, created.worktree, trustEnabled, true);
		if (after !== 'shown' && after !== 'not asked') {
			this.reportCreatedNotOpened(main, created.worktree, after);
			return undefined;
		}
		return created.worktree;
	}

	/**
	 * `makeWorktree`: WT-5.6 with every question answered by the caller or refused - no dialog, no
	 * trust asked for, no repository or initial commit made - and the window left where it is unless
	 * asked. Git that is still starting, as a window just opened, is waited for as after trust is given.
	 */
	private async doMakeWorktree(main: URI, branch: string, options: IMakeWorktreeOptions): Promise<URI> {
		if (!branch) {
			throw new Error(localize('worktrees.noBranch', "A branch name is required to create a worktree."));
		}

		const name = worktreeFolderName(branch);
		if (!name) {
			throw new Error(localize('worktrees.badName', "'{0}' is not a valid folder name on Windows.", branch));
		}

		const trustEnabled = this.workspaceTrustEnablementService.isWorkspaceTrustEnabled();
		if (trustEnabled && !this.workspaceTrustManagementService.isWorkspaceTrusted()) {
			throw new Error(localize('worktrees.restrictedUnasked', "The workspace is in Restricted Mode. Please trust the workspace to run Git operations."));
		}

		if (trustEnabled && !(await this.workspaceTrustManagementService.getUriTrustInfo(main)).trusted) {
			throw new Error(localize('worktrees.untrustedUnasked', "Repository '{0}' is untrusted. Please trust the repository before creating a worktree.", this.labelService.getUriLabel(main)));
		}

		await whenRegistered('_git.prepareWorktreeBaseAt', GIT_START_TIMEOUT);
		let base: WorktreeBaseAtResult | undefined;
		try {
			base = await this.commandService.executeCommand<WorktreeBaseAtResult>('_git.prepareWorktreeBaseAt', main, 'inspect');
		} catch (err) {
			throw new Error(gitUnreachable('_git.prepareWorktreeBaseAt', err));
		}

		if (!base || base.kind === 'error') {
			throw new Error(explainFailure(base, main)
				?? localize('worktrees.inspectFailed', "Git failed to read repository '{0}': {1}", this.labelService.getUriLabel(main), gitMessage(base)));
		}

		if (base.kind === 'uninitialized') {
			throw new Error(localize('worktrees.notRepositoryUnasked', "Folder '{0}' is not a Git repository. Initialize the repository first.", basename(main)));
		}

		if (base.kind === 'unborn') {
			throw new Error(localize('worktrees.noBaseUnasked', "Repository '{0}' contains no commits. Create an initial commit first.", basename(main)));
		}

		const parent = joinPath(await this.pathService.userHome(), ...WORKTREES, basename(main));
		const created = await this.createDecided(main, branch, name, parent, {}, options.startPoint);
		if (created.kind === 'failed') {
			throw new Error(created.unreachable ?? this.createFailureMessage(main, branch, created.worktree, created.result));
		}

		// The worktree is made either way: what failed after is said, and the agent gets it (WT-5.7)
		const after = await this.afterCreate(main, created.worktree, trustEnabled, options.show === true);
		if (after !== 'shown' && after !== 'not asked') {
			this.notificationService.warn(localize('worktrees.createdForAgent', "Worktree was created at '{0}', but {1} failed: {2}", this.labelService.getUriLabel(created.worktree), after.step, after.reason));
		}
		return created.worktree;
	}

	/**
	 * WT-5.4 once the branch is decided: the folder, its customization, and git's worktree. Failures
	 * are returned, for New Worktree to say on screen and `makeWorktree` to throw.
	 */
	private async createDecided(main: URI, branch: string, name: string, parent: URI, given: IFolderCustomization, startPoint: string | undefined): Promise<CreateOutcome> {
		const worktree = await freeWorktreeUri(parent, name, candidate => this.fileService.exists(candidate));

		// A colour none of the repository's other worktrees has, unless one was chosen (WT-1.12)
		const siblings = this.workspaceBarService.repositoryFor(main)?.worktrees ?? [];
		const color = given.color ?? freeWorktreeColor(siblings.map(sibling => this.customizationService.get(sibling.uri)?.color));
		const customization: IFolderCustomization = color ? { ...given, color } : given;

		// Before git writes its record, which the bar reads a row from while the files are still being
		// checked out. Written even when nothing was chosen: customizations are kept by path, and one left
		// by a worktree deleted outside the bar would otherwise be worn by this one. Taken back if none is made.
		this.customizationService.set(worktree, customization);

		// WT-5.4: not cancellable - a half-made worktree is worse than waiting. The start point only when
		// there is one: the git extension's command takes HEAD without it.
		let result: CreateWorktreeAtResult | undefined;
		try {
			result = await this.progressService.withProgress(
				{ location: ProgressLocation.Notification, title: localize('worktrees.creating', "Creating worktree '{0}'...", customization.name || branch) },
				() => this.commandService.executeCommand<CreateWorktreeAtResult>('_git.createWorktreeAt', main, worktree, branch, ...(startPoint ? [startPoint] : [])));
		} catch (err) {
			this.customizationService.set(worktree, {});
			return { kind: 'failed', worktree, result: undefined, unreachable: gitUnreachable('_git.createWorktreeAt', err) };
		}

		if (!result || result.kind === 'error') {
			this.customizationService.set(worktree, {});
			this.logService.warn(`[worktrees] creating ${worktree.toString(true)} failed: ${result?.message ?? 'no answer'}`);
			return { kind: 'failed', worktree, result };
		}

		// WT-6.4: a file that did not copy is said once, and stops nothing.
		if (result.copyFailures.length > 0) {
			this.notificationService.warn(localize('worktrees.copyFailed', "Failed to copy {0} files specified in .worktreeinclude into the worktree: {1}", result.copyFailures.length, result.copyFailures.slice(0, LISTED_COPY_FAILURES).join(', ')));
		}

		// Nor does a hook that failed: git kept the worktree, and so does this.
		if (result.hookFailure) {
			this.notificationService.warn(localize('worktrees.hookFailed', "Worktree created successfully, but a Git hook failed: {0}", result.hookFailure));
		}

		return { kind: 'created', worktree, result };
	}

	/**
	 * Trusts, lists and opens a worktree git made, and shows it if `show` (WT-5.6). Returns the step that
	 * failed instead; the worktree is kept either way (WT-5.7).
	 */
	private async afterCreate(main: URI, worktree: URI, trustEnabled: boolean, show: boolean): Promise<'shown' | 'not asked' | { readonly step: string; readonly reason: string }> {
		try {
			if (trustEnabled) {
				await this.workspaceTrustManagementService.setUrisTrust([worktree], true);
			}
		} catch (err) {
			return { step: localize('worktrees.stepTrust', "trusting the worktree"), reason: toErrorMessage(err) };
		}

		try {
			// Listed before it joins the workspace, so that its row is under its repository from the start (WT-3.6)
			await this.workspaceBarService.whenListed(worktree);
		} catch (err) {
			return { step: localize('worktrees.stepRecord', "reading Git worktree metadata"), reason: toErrorMessage(err) };
		}

		// So the row the window is about to go to - or that just appeared - can be seen.
		this.workspaceBarService.setExpanded(main, true);

		if (!show) {
			return 'not asked';
		}

		// Awaited: setup opened before the restore settles would be closed by it
		const shown = await this.workspaceBarService.show(worktree);
		return shown.kind === 'shown' ? 'shown'
			: { step: localize('worktrees.stepOpen', "opening the worktree"), reason: shown.kind === 'failed' ? shown.reason : localize('worktrees.superseded', "a folder switch was requested before opening completed") };
	}

	/** Says a worktree was made but not opened, offering to open it; setup waits for that (WT-5.7). */
	private reportCreatedNotOpened(main: URI, worktree: URI, failure: { readonly step: string; readonly reason: string }): void {
		this.notificationService.prompt(Severity.Warning,
			localize('worktrees.createdNotOpened', "Worktree was created at '{0}', but {1} failed: {2}", this.labelService.getUriLabel(worktree), failure.step, failure.reason),
			[{
				label: localize('worktrees.openWorktree', "Open Worktree"),
				run: async () => {
					if ((await this.workspaceBarService.show(worktree)).kind === 'shown') {
						this.runSetup(main, worktree).catch(onUnexpectedError);
					}
				}
			}]);
	}

	/** WT-5.3 and WT-5.5: git's errors are the checks, each said in the product's words. */
	private createFailureMessage(main: URI, branch: string, worktree: URI, result: CreateWorktreeAtResult | undefined): string {
		const error = result?.kind === 'error' ? result : undefined;
		if (error?.code === 'BranchAlreadyExists') {
			return localize('worktrees.branchExists', "A branch named '{0}' already exists. Please choose a different name.", branch);
		}

		if (error?.code === 'WorktreeAlreadyExists') {
			return localize('worktrees.pathExists', "A file or folder already exists at '{0}'.", this.labelService.getUriLabel(worktree));
		}

		return explainFailure(error, main, branch) ?? localize('worktrees.createFailed', "Failed to create worktree: {0}", gitMessage(error));
	}

	/** Says on screen why New Worktree could not make its worktree; a branch a checkout has is offered to go to. */
	private reportCreateFailure(main: URI, repository: IWorkspaceBarRepository | undefined, branch: string, worktree: URI, result: CreateWorktreeAtResult | undefined): void {
		// Always `-b`, so this is any branch that exists. When a checkout has it, offer to go there.
		const holder = result?.kind !== 'error' || result.code !== 'BranchAlreadyExists'
			? undefined
			: repository?.branch === branch
				? repository.main
				: repository?.worktrees.find(candidate => candidate.branch === branch)?.uri;
		if (holder) {
			this.notificationService.prompt(Severity.Info,
				localize('worktrees.branchCheckedOut', "Branch '{0}' is already checked out in '{1}'.", branch, this.labelService.getUriLabel(holder)),
				[{ label: localize('worktrees.goThere', "Switch to Worktree"), run: () => this.workspaceBarService.show(holder) }]);
			return;
		}

		this.notificationService.error(this.createFailureMessage(main, branch, worktree, result));
	}

	/**
	 * WT-7: the lines of `.facade/worktrees.json`, run in a terminal of the worktree - in the person's
	 * own shell, with the output on screen. A failing line leaves the worktree usable.
	 */
	private async runSetup(main: URI, worktree: URI): Promise<void> {
		if (this.setupStarted.has(worktree)) {
			return;
		}
		this.setupStarted.set(worktree, true);

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
			this.notificationService.warn(localize('worktrees.badSetup', "Failed to parse .facade/worktrees.json: setup keys must contain an array of command strings. No commands were executed."));
			return;
		}

		// Noted until the last line is sent, so that a window closed meanwhile leaves the note for the next (WT-7.7)
		this.noteSetup(main, worktree, true);
		try {
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

			// One line at a time, each once shell integration says the last finished (WT-7.4)
			const detection = await this.commandDetection(terminal);
			for (const line of setup.lines) {
				if (!await runSetupLine(terminal, detection, line)) {
					return;
				}
			}
		} finally {
			this.noteSetup(main, worktree, false);
		}
	}

	async reportUnfinishedSetup(): Promise<void> {
		const notes = this.setupNotes();
		this.storageService.remove(SETUP_IN_FLIGHT_KEY, StorageScope.WORKSPACE);

		for (const { main, worktree } of notes) {
			// Passed over only when deleted: one on a drive not there yet still had its setup cut short (WORKSPACE.md WS-63)
			if ((await unreachable(this.fileService, worktree))?.kind === 'missing') {
				continue;
			}

			this.notificationService.prompt(Severity.Warning,
				localize('worktrees.setupUnfinished', "Setup script for worktree '{0}' may have been interrupted by a window reload or close. Check its terminal output before retrying.", this.labelService.getUriLabel(worktree)),
				[{
					label: localize('worktrees.runSetupAgain', "Rerun Setup"),
					// The only way setup runs twice for a worktree
					run: () => {
						this.setupStarted.delete(worktree);
						return this.runSetup(main, worktree);
					}
				}]);
		}
	}

	/** Notes that the setup of `worktree` is being sent, or takes the note back. */
	private noteSetup(main: URI, worktree: URI, inFlight: boolean): void {
		const notes = this.setupNotes().filter(note => !this.uriIdentityService.extUri.isEqual(note.worktree, worktree));
		if (inFlight) {
			notes.push({ main, worktree });
		}

		if (notes.length) {
			this.storageService.store(SETUP_IN_FLIGHT_KEY, JSON.stringify(notes.map(note => ({ main: note.main.toString(), worktree: note.worktree.toString() }))), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(SETUP_IN_FLIGHT_KEY, StorageScope.WORKSPACE);
		}
	}

	private setupNotes(): { readonly main: URI; readonly worktree: URI }[] {
		try {
			const raw = this.storageService.get(SETUP_IN_FLIGHT_KEY, StorageScope.WORKSPACE);
			return raw ? (JSON.parse(raw) as { main: string; worktree: string }[]).map(note => ({ main: URI.parse(note.main), worktree: URI.parse(note.worktree) })) : [];
		} catch {
			// A note that cannot be read is no setup half sent.
			return [];
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
			this.notificationService.error(CommandsRegistry.getCommand('_git.deleteWorktreeAt') ? localize('worktrees.noGitDelete', "Failed to execute the Git command to delete the worktree: {0}", toErrorMessage(err)) : gitExtensionNotRunning());
			return;
		}

		if (!check || check.kind !== 'checked') {
			const error = check?.kind === 'error' ? check : undefined;
			this.notificationService.error(explainFailure(error, main)
				?? localize('worktrees.checkFailed', "Failed to verify worktree state before deletion: {0}", gitMessage(error)));
			return;
		}

		// Refused before anything is asked or stopped, rather than found out at the end (WT-8, step 1)
		const lock = check.restrictions.find(restriction => restriction.kind === 'locked');
		if (lock) {
			this.notificationService.error(lock.reason
				? localize('worktrees.lockedBecause', "Worktree '{0}' is locked: {1}. Run 'git worktree unlock' to allow deletion.", name, lock.reason)
				: localize('worktrees.locked', "Worktree '{0}' is locked. Run 'git worktree unlock' to allow deletion.", name));
			return;
		}

		// 2  confirm, naming all that would be lost, unsaved editors and running terminals too (WT-8.1, WT-8.2)
		const unsaved = this.unsavedInside(worktree);
		const loss: IDeletionLoss = { ...check, unsaved: unsaved.map(workingCopy => this.uriIdentityService.extUri.relativePath(worktree, workingCopy.resource) ?? basename(workingCopy.resource)) };
		const running = [...await this.terminalsInside(worktree), ...this.folderTerminalsService.terminalsOf(worktree)].some(instance => instance.hasChildProcesses);
		if (!(await this.confirmDelete(name, branch, loss, running))) {
			return;
		}

		// 3 to 7 under one progress: a large tree takes a while to delete.
		const force = check.files.length > 0 || check.submodules;
		const result = await this.progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('worktrees.deleting', "Deleting worktree '{0}'...", name) },
			async (): Promise<DeleteWorktreeAtResult | undefined> => {
				// 3  move off, to the repository's own row rather than whichever folder is next in the list (WT-8.3).
				const active = this.activeFolderService.activeFolder;
				if (active && this.uriIdentityService.extUri.isEqual(active.uri, worktree)) {
					await this.workspaceBarService.show(main);
				}

				// Its row goes with the window off it, rather than once git has deleted it - which takes
				// seconds for a large worktree - and comes back if the deletion fails (WT-8.9).
				const hidden = this.workspaceBarService.hideWorktree(worktree);
				try {
					// 4  discard what the confirmation named: unsaved changes and their editors
					await this.discardInside(worktree, unsaved);

					// 5  leave folders[] without asking again (WT-8.4)
					await this.workspaceBarService.remove([worktree], { confirmed: true });

					// 6  close the terminals still inside it; git's delete waits for their shells to let go
					for (const instance of await this.terminalsInside(worktree)) {
						instance.dispose(TerminalExitReason.User);
					}

					// 7  delete. `force` only when the confirmation named what it throws away.
					try {
						return await run(force ? 'force' : 'remove');
					} catch (err) {
						return { kind: 'error', code: undefined, message: toErrorMessage(err) };
					}
				} finally {
					hidden.dispose();
				}
			});

		// 8  nothing to refresh: letting the row go read git's records again (WT-8.9, and WT-8.6 when it went wrong).
		if (result?.kind !== 'removed') {
			const error = result?.kind === 'error' ? result : undefined;
			const message = gitMessage(error);
			this.logService.warn(`[worktrees] deleting ${worktree.toString(true)} failed: ${message}`);
			this.notificationService.error(explainFailure(error, main) ?? localize('worktrees.deleteFailed', "Failed to delete worktree: {0}", message));
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

	/** The working copies with unsaved changes to files inside `worktree`, open on screen or put away. */
	private unsavedInside(worktree: URI): IWorkingCopy[] {
		return this.workingCopyService.dirtyWorkingCopies.filter(workingCopy => this.uriIdentityService.extUri.isEqualOrParent(workingCopy.resource, worktree));
	}

	/** Discards the unsaved changes inside `worktree` and closes the editors of its files. */
	private async discardInside(worktree: URI, unsaved: readonly IWorkingCopy[]): Promise<void> {
		for (const workingCopy of unsaved) {
			await workingCopy.revert({ soft: true });
		}
		const inside = this.editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => editor.resource && this.uriIdentityService.extUri.isEqualOrParent(editor.resource, worktree));
		if (inside.length) {
			await this.editorService.closeEditors(inside, { preserveFocus: true });
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

	/** Asks once, naming everything deleting the worktree loses (WT-8.1, WT-8.2). */
	private async confirmDelete(name: string, branch: string | undefined, loss: IDeletionLoss, running: boolean): Promise<boolean> {
		const { files, ignoredPaths, submodules, unsaved } = loss;

		// Laid out as VS Code's own delete confirmation: lists first, then one paragraph (WORKSPACE.md W10.7)
		const paragraphs: string[] = [];
		const list = (heading: string, entries: readonly string[], limit: number) => {
			if (!entries.length) {
				return;
			}
			const lines = [heading, ...entries.slice(0, limit)];
			if (entries.length > limit) {
				lines.push(localize('worktrees.andMore', "and {0} more", entries.length - limit));
			}
			paragraphs.push(lines.join('\n'));
		};

		list(localize('worktrees.loses', "The following uncommitted changes will be lost:"), files, LISTED_FILES);
		list(localize('worktrees.unsaved', "The following editors have unsaved changes that will be discarded:"), unsaved, LISTED_FILES);
		list(localize('worktrees.ignored', "The following files ignored by Git will be deleted:"), ignoredPaths, LISTED_IGNORED);

		const sentences: string[] = [];
		// Deleted for good, not moved to the Recycle Bin, so in VS Code's words for that
		sentences.push(submodules
			? localize('worktrees.folderAndSubmodulesDeleted', "The worktree folder, including its submodules and unpushed commits, will be deleted. This action cannot be undone.")
			: localize('worktrees.folderDeleted', "The worktree folder will be deleted from disk. This action cannot be undone."));
		if (running) {
			sentences.push(localize('worktrees.runningStops', "A process running in one of its terminals will be terminated."));
		}
		// A worktree on a detached HEAD has no branch to keep, and is not told it has one.
		if (branch) {
			sentences.push(localize('worktrees.branchKeptQuoted', "The branch '{0}' will be preserved.", branch));
		}
		paragraphs.push(sentences.join(' '));

		// No Save and Delete: a file saved there would be deleted all the same
		const discards = files.length > 0 || unsaved.length > 0;
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('worktrees.deleteQuestion', "Are you sure you want to delete the worktree '{0}'?", name),
			detail: paragraphs.join('\n\n'),
			primaryButton: discards
				? localize({ key: 'worktrees.deleteDiscardButton', comment: ['&& denotes a mnemonic'] }, "&&Delete and Discard Changes")
				: localize({ key: 'worktrees.deleteButton', comment: ['&& denotes a mnemonic'] }, "&&Delete")
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

/** Reports, once the window is up, the setup a previous window left half sent (WT-7.7). */
export class UnfinishedWorktreeSetup implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.unfinishedWorktreeSetup';

	constructor(@IWorktreeService worktreeService: IWorktreeService) {
		worktreeService.reportUnfinishedSetup().then(undefined, onUnexpectedError);
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
			// Off in the palette too while the bar lists no worktrees (WORKTREE.md WT-9).
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
