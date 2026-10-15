/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { distinct } from '../../../../base/common/arrays.js';
import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { Schemas } from '../../../../base/common/network.js';
import { ResourceMap, ResourceSet } from '../../../../base/common/map.js';
import { basename, joinPath, toLocalResource } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { isObject, isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileSystemProviderCapabilities, IFileService, IFileStat } from '../../../../platform/files/common/files.js';
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
import { canonicalUri, unreachable, WORKTREES_FOLDER, worktreesFolderOf } from '../../../browser/parts/workspacebar/workspaceBar.js';
import { DELETE_WORKTREE_COMMAND, NEW_WORKTREE_COMMAND, WORKSPACE_BAR_CATEGORY, WORKTREES_SHOWN, WorkspaceBarContextMenu, WorkspaceBarRowKindContext, WorkspaceBarRowOffersWorktreeContext, WorkspaceBarRowToolbar } from '../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IRunningWork } from '../../../browser/parts/workspacebar/workspaceBarAgents.js';
import { freeWorktreeColor, IFolderCustomization, IWorkspaceBarCustomizationService, worktreeNameFor } from '../../../browser/parts/workspacebar/workspaceBarCustomization.js';
import { IWorkspaceBarDialogService } from '../../../browser/parts/workspacebar/workspaceBarCustomize.js';
import { findWorktree, IWorkspaceBarRepository } from '../../../browser/parts/workspacebar/workspaceBarGit.js';
import { agentsFirst, discardedHeading, listedFiles, listedSessions, terminatedHeading, workLine } from '../../../browser/parts/workspacebar/workspaceBarQuestions.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { EditorResourceAccessor, EditorsOrder } from '../../../common/editor.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IWorkingCopy } from '../../../services/workingCopy/common/workingCopy.js';
import { worktreeRepositoryOf } from '../../../services/workspaces/common/gitFiles.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { IFacadeRunsService } from '../../facadeCommands/browser/facadeRuns.js';
import { facadeRunOf, IFacadeRun } from '../../facadeCommands/common/facadeRun.js';
import { IFolderTerminalsService } from '../../folderTerminals/browser/folderTerminals.js';
import { ITerminalInstance, ITerminalInstanceService, ITerminalService } from '../../terminal/browser/terminal.js';
import { getFullBufferLineAsString } from '../../terminal/browser/xterm/xtermTerminal.js';
import { ITerminalLauncherService } from '../../terminalLaunchers/browser/terminalLauncherService.js';
import { runningWork } from '../../terminalLaunchers/browser/terminalLauncherWorkspaceBar.js';
import { getShellIntegrationTimeout } from '../../terminal/common/terminalEnvironment.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/*
 * Making and deleting worktrees from the workspace bar (WORKTREE.md WT-5 to WT-8). A contribution
 * rather than part of the bar, because setup runs in a terminal and `vs/workbench/browser` may not
 * import `contrib/terminal`.
 */

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

/**
 * WT-5.8's notice, one paragraph: what the folder is, and what continuing - Initialize and Create - does to it: `git init`,
 * and an initial commit with the number of its files. A folder inside another repository is told so, by that repository's
 * name: "not a Git repository" would not be true of it.
 */
function prepareNotice(base: Exclude<WorktreeBaseAtResult, { readonly kind: 'ready' } | WorktreeAtError>): string {
	if (base.kind === 'unborn') {
		return base.files === 0
			? localize('worktrees.prepare.unbornEmpty', "This repository has no commits yet. Continuing will create an empty initial commit.")
			: base.files === 1
				? localize('worktrees.prepare.unbornOne', "This repository has no commits yet. Continuing will create an initial commit with 1 file.")
				: localize('worktrees.prepare.unbornMany', "This repository has no commits yet. Continuing will create an initial commit with {0} files.", base.files);
	}

	if (base.enclosing) {
		const enclosing = basename(URI.file(base.enclosing));
		return base.files === 0
			? localize('worktrees.prepare.insideEmpty', "This folder is inside the '{0}' Git repository, but is not its root. Continuing will initialize a separate repository here ('git init') and create an empty initial commit.", enclosing)
			: base.files === 1
				? localize('worktrees.prepare.insideOne', "This folder is inside the '{0}' Git repository, but is not its root. Continuing will initialize a separate repository here ('git init') and create an initial commit with 1 file.", enclosing)
				: localize('worktrees.prepare.insideMany', "This folder is inside the '{0}' Git repository, but is not its root. Continuing will initialize a separate repository here ('git init') and create an initial commit with {1} files.", enclosing, base.files);
	}

	return base.files === 0
		? localize('worktrees.prepare.folderEmpty', "This folder is not a Git repository. Continuing will initialize it ('git init') and create an empty initial commit.")
		: base.files === 1
			? localize('worktrees.prepare.folderOne', "This folder is not a Git repository. Continuing will initialize it ('git init') and create an initial commit with 1 file.")
			: localize('worktrees.prepare.folderMany', "This folder is not a Git repository. Continuing will initialize it ('git init') and create an initial commit with {0} files.", base.files);
}

/** Why a worktree could not be looked at before it is deleted: as `explainFailure` says it, else in Git's words. */
function checkFailure(error: WorktreeAtError | undefined, main: URI): string {
	return explainFailure(error, main) ?? localize('worktrees.checkFailed', "Failed to verify worktree state before deletion: {0}", gitMessage(error));
}

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
			return localize('worktrees.inheritedEnvironment', "This window was started with GIT_DIR, GIT_WORK_TREE, or GIT_INDEX_FILE set, redirecting Git to another repository. Please open the folder in a new window.");
		case 'InvalidBranchName':
			return localize('worktrees.invalidBranchName', "'{0}' is not a valid branch name.", branch ?? '');
		case 'InitialBranch':
			return localize('worktrees.initialBranch', "The initial commit is on branch '{0}'. Please choose a different branch name for the new worktree.", branch ?? '');
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

/** Why the Git extension cannot be asked to delete a worktree: `err`, or that it is not running. */
function gitUnreachableToDelete(err: unknown): string {
	return CommandsRegistry.getCommand('_git.deleteWorktreeAt') ? localize('worktrees.noGitDelete', "Failed to execute the Git command to delete the worktree: {0}", toErrorMessage(err)) : gitExtensionNotRunning();
}

/** Why nothing is done for a caller that does not ask, where the person would have been asked for trust. */
function restrictedUnasked(): string {
	return localize('worktrees.restrictedUnasked', "The workspace is in Restricted Mode. Please trust the workspace to run Git operations.");
}

function noIdentityMessage(): string {
	return localize('worktrees.noIdentity', "Git author identity is not configured. Set '{0}' and '{1}' via '{2}', then try again.", 'user.name', 'user.email', 'git config --global');
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

/** How many files a deletion refused names before it says how many more there are. */
const LISTED_FILES = 10;

/**
 * How many files of a folder git ignores whole a caller's deletion compares with the main checkout's, to tell copies -
 * what .worktreeinclude copied - from work: a folder holding more is work, uncompared, as a dependency folder is.
 */
const COMPARED_IGNORED_FILES = 200;

/** How many of the files `.worktreeinclude` could not copy a notification names. */
const LISTED_COPY_FAILURES = 3;

/** What `_git.deleteWorktreeAt` returns (WT-8.6). */
type DeleteWorktreeAtResult =
	| { readonly kind: 'checked'; readonly files: readonly string[]; readonly ignoredPaths: readonly string[]; readonly submodules: boolean; readonly restrictions: readonly { readonly kind: 'locked'; readonly reason: string }[] }
	| { readonly kind: 'removed' }
	| { readonly kind: 'incomplete'; readonly path: string; readonly gitRecord: 'present' | 'absent' | 'unknown'; readonly recovery: string; readonly message: string }
	| WorktreeAtError;

/** What a worktree's `check` found: what deleting it would lose, and the locks git holds it by. */
type WorktreeCheck = Omit<Extract<DeleteWorktreeAtResult, { kind: 'checked' }>, 'kind'>;

/** What deleting a worktree would lose, as its confirmation names it (WT-8.1, WT-8.2). */
interface IDeletionLoss {
	/** Files git keeps no copy of, relative to it. */
	readonly files: readonly string[];
	/** What git ignores in it, which goes with it without a word from git: a wholly ignored folder as one. */
	readonly ignoredPaths: readonly string[];
	/** Whether it has submodules, which go with it with any of their commits not pushed. */
	readonly submodules: boolean;
	/** Unsaved editors of files inside it, wherever they are open or put away, relative to it. */
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
	 * has decided already - an agent sending a child out to a worktree of its own (WT-5.11). Answered once
	 * it is made and its setup started, in a terminal held under the worktree's row and not shown, with
	 * what of `.worktreeinclude` could not be copied and how a git hook failed: the caller's to say, not the
	 * person's to be told. The setup's outcome is `setupOutcome`'s. Throws, in the product's words, when it
	 * cannot be made.
	 *
	 * Nothing is asked, so nothing that would have been asked is done: a workspace or repository that
	 * is not trusted, or a folder with no commit yet, is refused rather than trusted or given one.
	 */
	makeWorktree(main: URI, branch: string, options?: IMakeWorktreeOptions): Promise<IMadeWorktree>;

	/**
	 * How the setup of `worktree`, which `makeWorktree` made, came out, once it has: with shell
	 * integration, once its last line has finished; without it, once its lines are sent (WT-5.11).
	 */
	setupOutcome(worktree: URI): Promise<WorktreeSetupOutcome>;

	/**
	 * How the setup of `worktree`, which `makeWorktree` made, stands now, for a caller waiting on it to see what it is
	 * doing (AGENT-ORCHESTRATION.md, O3): the line running, and the last lines of its terminal. Undefined where the
	 * window knows no setup of it: none to run, none it made, or one whose outcome was asked for.
	 */
	setupState(worktree: URI): IWorktreeSetupState | undefined;

	/** Closes the setup terminal of `worktree`, which `makeWorktree` made: its start was cancelled. The worktree stays. */
	stopSetup(worktree: URI): void;

	/**
	 * Deletes the worktree `target` as Delete Worktree does, without asking anything, for a caller that has
	 * decided already - an agent's stop_agent - its branch kept, the agents working in it stopped in the same
	 * order. Changes git would lose, as it finds them deleting it, refuse it unless `options` says to discard them
	 * (WT-8.10). Throws, in the product's words, when it cannot - with what it did all the same: those changes, a
	 * main checkout, which is never deleted, a folder that is no worktree, agents still stopping, and a worktree git
	 * will not delete - whose row comes back, to try again (WT-8.6).
	 */
	removeWorktree(target: URI, options?: IRemoveWorktreeOptions): Promise<void>;

	/**
	 * What deleting the worktree `target` as `removeWorktree` does with `options` would lose that the caller did not
	 * decide on, each named as its refusal names it, and nothing where nothing would be: the files git keeps no copy
	 * of but those the caller put there, as it wrote them; its editors with unsaved changes; its submodules. A look and
	 * nothing else - no agent stopped, no terminal or editor closed, nothing moved or removed - for a caller to refuse
	 * with before it stops anything (AGENT-ORCHESTRATION.md, O5). Throws as `removeWorktree` does where it
	 * cannot look: a main checkout, a folder that is no worktree, Restricted Mode, Git that cannot be asked.
	 */
	removalLoss(target: URI, options?: IRemoveWorktreeOptions): Promise<readonly string[]>;

	/**
	 * The terminals working inside `worktree` - where they are now, or where they started - which deleting it
	 * closes. Only terminals on the worktree's own machine: a cwd is a path of the machine its terminal runs on.
	 */
	terminalsInside(worktree: URI): Promise<ITerminalInstance[]>;

	/**
	 * The titles of the terminals of other windows' agents whose processes run inside `worktree` - the pty host
	 * holds every window's - which deleting it would leave without their folder, unasked.
	 */
	otherWindowsAgentsIn(worktree: URI): Promise<string[]>;

	/** Says which worktrees' setup a window that closed was still sending, without sending it again (WT-7.7). */
	reportUnfinishedSetup(): Promise<void>;
}

/** Where a window notes the setup it is still sending, for the next window to report (WT-7.7). */
const SETUP_IN_FLIGHT_KEY = 'facade.worktrees.setupInFlight';

/** What `removeWorktree` may lose of a worktree, and what the caller knows of it. */
export interface IRemoveWorktreeOptions {
	/** Whether its changes go with it, unsaved editors too; without, any change git would lose refuses its deletion. */
	readonly discardChanges?: boolean;
	/**
	 * Files that go with it all the same: what the caller put there and nobody changed, each relative to it
	 * with forward slashes, with the SHA-256 of what it wrote - looked at again right before git deletes it.
	 */
	readonly ownFiles?: readonly IOwnedWorktreeFile[];
	/**
	 * The main checkout of its repository, as the caller read it from git: the bar's own is taken where the
	 * bar lists worktrees, but while it lists none it knows no repository (WORKTREE.md WT-9).
	 */
	readonly main?: URI;
	/**
	 * The agents' runs working in it that the caller looked at, which the deletion stops: theirs are the only agents'
	 * terminals it closes. Another agent working inside it refuses it - it would be ended unasked.
	 */
	readonly runs?: readonly IFacadeRun[];
	/**
	 * Whether `target` is what a deletion in this window left of a worktree of `main`: a folder git no longer lists,
	 * whose files could not all be deleted then, which the caller has looked at (AGENT-ORCHESTRATION.md, O5: a retry
	 * finishes it). Only this window can tell it is still that folder (WORKTREE.md WT-4.5).
	 */
	readonly leftover?: boolean;
}

/** A file a caller of `removeWorktree` put into the worktree: where, and the SHA-256 of what it wrote, in hex. */
export interface IOwnedWorktreeFile {
	readonly path: string;
	readonly sha256: string;
}

/**
 * The files `loss` names, as a caller's refusal lists them: those git keeps no copy of, what git ignores, then the
 * editors with unsaved changes.
 */
function lostFiles(loss: IDeletionLoss): string[] {
	return [
		...loss.files,
		...loss.ignoredPaths.map(path => localize('worktrees.ignoredFile', "{0} (ignored by Git)", path)),
		...loss.unsaved.map(file => localize('worktrees.unsavedFile', "{0} (unsaved)", file))
	];
}

/** A deletion a caller decided on, nothing asked (WT-8.10). */
interface IDecidedDeletion {
	readonly kind: 'decided';
	/** The agents' runs working in it that the caller looked at: the only agents' terminals it closes. */
	readonly runs: readonly IFacadeRun[];
	/** Whether its unsaved changes go with it, as the caller said. */
	readonly discardChanges: boolean;
	/**
	 * Looks once more - before anything is moved, closed or removed, and again, with git's `check` then, right before
	 * git deletes it, once its terminals have closed: why it is not to be, where something came that nobody decided on.
	 */
	recheck(check?: WorktreeCheck): Promise<string | undefined>;
}

/** The person's Delete Worktree, confirmed (WT-8.1). */
interface IPersonDeletion {
	readonly kind: 'person';
	/** The unsaved working copies its confirmation named, which are discarded. */
	readonly unsaved: readonly IWorkingCopy[];
	/** Whether it still goes, given git's `check` right before git deletes it: what came since the confirmation is asked about. */
	confirmAgain(check: WorktreeCheck): Promise<boolean>;
}

/**
 * How a deletion ended: as git answered, or before git was asked - refused, the window not off it, not confirmed
 * again, not out of the workspace, or its agents still stopping once the stop timeout was over.
 */
type DeletionOutcome =
	| DeleteWorktreeAtResult
	| { readonly kind: 'refused'; readonly why: string }
	| { readonly kind: 'stayed' | 'kept' | 'notRemoved' }
	| { readonly kind: 'stopping' } & IAgentsStopping
	| undefined;

/** How a deletion went: how it ended, and what of it was done whatever the end (WT-8.6). */
interface IDeletion {
	readonly outcome: DeletionOutcome;
	/** Whether its folder left the workspace's folders. */
	readonly leftFolders: boolean;
	/** What ran in the terminals that went with it, which closing them ended. */
	readonly ended: readonly string[];
}

/**
 * What `_facade.agents.worktreeStopping` answers once the agents working in a worktree being deleted were stopped: those
 * still stopping when the stop timeout was over, by name, and - for a deletion an agent's call asked for - why, in that
 * call's words (AGENT-ORCHESTRATION.md, O5).
 */
interface IAgentsStopping {
	readonly stopping: readonly string[];
	readonly why?: string;
}

/** That the window could not go from the worktree `name` to its repository `main`, so it was not deleted (WT-8, step 4). */
function couldNotLeave(main: URI, name: string): string {
	return localize('worktrees.couldNotLeave', "Could not switch to '{0}'; worktree '{1}' was not deleted.", basename(main), name);
}

/** That git let go of a worktree whose folder could not all be deleted, where it is and why (WT-8.6). */
function leftBehind(leftover: { readonly path: string; readonly message: string }): string {
	return localize('worktrees.leftover', "Worktree was removed from Git, but its folder could not be deleted: {0}. {1}", leftover.path, leftover.message);
}

/** Why git did not delete a worktree: in the product's words where it has them, else in git's. */
function deleteFailure(error: WorktreeAtError | undefined, main: URI): string {
	return explainFailure(error, main) ?? localize('worktrees.deleteFailed', "Failed to delete worktree: {0}", gitMessage(error));
}

/** That the worktree `name` was not deleted, as the workspace did not let it go: nothing was stopped or discarded (WT-8, step 5). */
function notOutOfWorkspace(name: string): string {
	return localize('worktrees.notOut', "Worktree '{0}' could not be removed from the workspace, so it was not deleted.", name);
}

/** That the worktree `name` was not deleted, the agents `stopping` working in it not stopped in time (WT-8, step 6). */
function stillStopping(name: string, stopping: readonly string[], leftFolders: boolean): string {
	return leftFolders
		? localize('worktrees.stillStoppingOut', "Worktree '{0}' was not deleted because these agents have not stopped yet: {1}. It was removed from the workspace. Delete it again once they have stopped.", name, stopping.join(', '))
		: localize('worktrees.stillStopping', "Worktree '{0}' was not deleted because these agents have not stopped yet: {1}. Delete it again once they have stopped.", name, stopping.join(', '));
}

/** How much of a failed setup line's output its outcome keeps: its end, where the error is. */
const SETUP_OUTPUT_CHARS = 2000;

/** What `makeWorktree` made. */
export interface IMadeWorktree {
	readonly worktree: URI;
	/** What `.worktreeinclude` names that could not be copied into it (WT-6.4). */
	readonly copyFailures: readonly string[];
	/** How a git hook failed as it was made; git kept it all the same. */
	readonly hookFailure?: string;
}

/**
 * How a worktree's setup came out (WT-7): none to run, a `.facade/worktrees.json` that could not be read,
 * every line finished well, a line that failed - the first, with its exit code and output - its lines sent
 * without shell integration, their completion unknown, or its terminal closed before it had finished.
 */
export type WorktreeSetupOutcome =
	| { readonly kind: 'none' | 'invalid' | 'succeeded' | 'submitted' | 'stopped' }
	| { readonly kind: 'failed'; readonly line: string; readonly exitCode: number; readonly output?: string };

/** How a worktree's setup stands now (`IWorktreeService.setupState`). */
export interface IWorktreeSetupState {
	/** The line running now, where shell integration says when each line finishes; without it, which runs is not known. */
	readonly running?: string;
	/** The last lines of its terminal as plain text, {@link SETUP_STATE_LINES} at most: as `lastLinesOf` reads them. */
	readonly lines: readonly string[];
}

/** How many of the last lines of a setup's terminal `setupState` answers with. */
const SETUP_STATE_LINES = 20;

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
	 * The repositories Git is making a worktree of - preparing its base, adding it and copying into it - and the
	 * worktrees being deleted: one run for each at a time. A run is `waitedFor` - what comes for it meanwhile goes
	 * once it is done, rather than being dropped as a second click (WT-5.10) - but for the person's Delete Worktree
	 * (`runOnce`): a second click on the row it is deleting does nothing.
	 */
	private readonly running: ResourceMap<{ readonly done: Promise<void>; readonly waitedFor: boolean }>;

	/**
	 * The repositories the person's New Worktree is going for, from its first question to the window on the new
	 * worktree - questions that take as long as the person takes, and so hold no run of the repository's (O4;
	 * OR-06). A second New Worktree for one of them is a second click, and does nothing (WT-5.10).
	 */
	private readonly newWorktrees: ResourceSet;

	/** The setups of the worktrees `makeWorktree` made, until their outcome is asked for: each with the line it runs now. */
	private readonly setups: ResourceMap<{ readonly outcome: Promise<WorktreeSetupOutcome>; terminal?: ITerminalInstance; stopped?: boolean; running?: string }>;

	/**
	 * The folders worktrees are being made in, each with the last making there: a free path is chosen and
	 * taken one making at a time. Repositories whose folders have one name share theirs (WT-2.3; X-72).
	 */
	private readonly makingIn: ResourceMap<Promise<void>>;

	/** Worktrees whose setup this window has started, so that none is sent twice (WT-7.7). */
	private readonly setupStarted: ResourceMap<true>;

	/**
	 * What deletions in this window left of worktrees - git let go of each, but could not delete all of its folder - each
	 * with what `cleanup` deletes it by: a retry finishes it, and only while the window keeps that (WT-4.5).
	 */
	private readonly leftovers: ResourceMap<string>;

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
		@ITerminalInstanceService private readonly terminalInstanceService: ITerminalInstanceService,
		@ITerminalLauncherService private readonly launcherService: ITerminalLauncherService,
		@IFolderTerminalsService private readonly folderTerminalsService: IFolderTerminalsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILabelService private readonly labelService: ILabelService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IFacadeRunsService private readonly facadeRunsService: IFacadeRunsService,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService,
	) {
		this.running = new ResourceMap(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		this.newWorktrees = new ResourceSet(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		this.setups = new ResourceMap(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		this.makingIn = new ResourceMap(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		this.setupStarted = new ResourceMap(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		this.leftovers = new ResourceMap(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
	}

	async createWorktree(target: URI | undefined): Promise<void> {
		target ??= this.workspaceBarService.folderForCommand();
		if (!target) {
			return;
		}

		// WT-1.3: another tool's worktree is a folder to Facade, which makes no worktree of it
		if (await this.isAnotherToolsWorktree(target)) {
			this.notificationService.info(localize('worktrees.anotherToolsWorktree', "'{0}' is a worktree created outside Facade. Create a worktree from its repository's main checkout instead.", this.labelService.getUriLabel(target)));
			return;
		}

		const repository = this.workspaceBarService.repositoryFor(target);
		const main = repository?.main ?? target;
		if (this.newWorktrees.has(main)) {
			return;
		}
		this.newWorktrees.add(main);
		let worktree: URI | undefined;
		try {
			// One asked for while Git makes a worktree of the repository for an agent goes once that is made (WT-5.10)
			await this.whenIdle(main);
			worktree = await this.doCreateWorktree(main, repository);
		} finally {
			this.newWorktrees.delete(main);
		}

		// WT-7, once the run is over: a setup line can take minutes or never end - a server - and neither
		// holds up the repository's next worktree, nor whoever asked for this one, which is ready.
		if (worktree) {
			this.runSetup(main, worktree, false).catch(onUnexpectedError);
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
			this.notificationService.info(this.notAWorktree(target));
			return;
		}

		await this.runOnce(worktree.uri, () => this.doDeleteWorktree(repository.main, worktree.uri, worktree.branch, worktreeNameFor(this.customizationService, worktree)));
	}

	async makeWorktree(main: URI, branch: string, options: IMakeWorktreeOptions = {}): Promise<IMadeWorktree> {
		const root = this.workspaceBarService.repositoryFor(main)?.main ?? main;
		const made = await this.runInTurn(root, () => this.doMakeWorktree(root, branch.trim(), options));

		// Started after the run, so that the repository's next worktree is not held up by it, and answered
		// once it has started: its outcome is asked for apart (WT-5.11). Shown, it is set up as after New Worktree.
		const started = new DeferredPromise<void>();
		const setup: { outcome: Promise<WorktreeSetupOutcome>; terminal?: ITerminalInstance; stopped?: boolean; running?: string } = { outcome: Promise.resolve({ kind: 'none' }) };
		setup.outcome = this.runSetup(root, made.worktree, options.show !== true, terminal => {
			setup.terminal = terminal;
			started.complete();
		}, line => setup.running = line).then(outcome => setup.stopped ? { kind: 'stopped' as const } : outcome, err => {
			onUnexpectedError(err);
			return { kind: 'stopped' as const };
		}).finally(() => started.complete());
		this.setups.set(made.worktree, setup);
		await started.p;
		if (setup.stopped) {
			setup.terminal?.dispose();
		}
		return made;
	}

	async setupOutcome(worktree: URI): Promise<WorktreeSetupOutcome> {
		const setup = this.setups.get(worktree);
		if (!setup) {
			return { kind: 'none' };
		}
		try {
			return await setup.outcome;
		} finally {
			this.setups.delete(worktree);
		}
	}

	setupState(worktree: URI): IWorktreeSetupState | undefined {
		const setup = this.setups.get(worktree);
		if (!setup?.terminal) {
			return undefined;
		}
		return { ...(setup.running !== undefined ? { running: setup.running } : {}), lines: setup.terminal.isDisposed ? [] : lastLinesOf(setup.terminal, SETUP_STATE_LINES) };
	}

	stopSetup(worktree: URI): void {
		const setup = this.setups.get(worktree);
		if (setup) {
			setup.stopped = true;
			setup.terminal?.dispose();
		}
	}

	async removeWorktree(target: URI, options: IRemoveWorktreeOptions = {}): Promise<void> {
		const { main, worktree, name } = this.toRemove(target, options);
		// One at a time, as Delete Worktree: a second waits for the first, and finds no worktree there
		await this.runInTurn(worktree, () => this.doRemoveWorktree(main, worktree, name, options));
	}

	async removalLoss(target: URI, options: IRemoveWorktreeOptions = {}): Promise<readonly string[]> {
		const { main, worktree, name } = this.toRemove(target, options);
		// The deletion's own first look, the caller's own files applied as it applies them (O5)
		const loss = await this.undecidedLoss(main, worktree, await this.checkToRemove(main, worktree, name, options), options);
		return loss ? [...lostFiles(loss), ...(loss.submodules ? [localize('worktrees.submodulesLost', "its submodules (including any unpushed commits)")] : [])] : [];
	}

	/**
	 * What `removeWorktree` deletes for `target`: the worktree, of the main checkout `main`, and its name - or, thrown,
	 * why it deletes nothing.
	 */
	private toRemove(target: URI, options: IRemoveWorktreeOptions): { readonly main: URI; readonly worktree: URI; readonly name: string } {
		const extUri = this.uriIdentityService.extUri;
		if (options.leftover) {
			const main = options.main;
			if (!main || extUri.isEqual(main, target)) {
				throw new Error(this.notAWorktree(target));
			}
			return { main, worktree: target, name: basename(target) };
		}
		const repository = this.workspaceBarService.repositoryFor(target);
		const worktree = findWorktree(repository, target, extUri);
		// A bar that knows no repository of it - one listing no worktrees - takes the caller's word for its main
		// checkout, and git refuses a folder that is no worktree of it (X-41)
		const main = repository?.main ?? options.main;
		if (!main || extUri.isEqual(main, target) || (repository && !worktree)) {
			throw new Error(main && extUri.isEqual(main, target)
				? localize('worktrees.mainNotDeleted', "{0} is its repository's main checkout, which is never deleted.", this.labelService.getUriLabel(target))
				: this.notAWorktree(target));
		}
		const uri = worktree?.uri ?? target;
		return { main, worktree: uri, name: worktree ? worktreeNameFor(this.customizationService, worktree) : basename(uri) };
	}

	/**
	 * Runs `task` for `uri` unless a run for it is still going - a second click on a row that is being
	 * worked on - and returns what it returned. A run for a caller - an agent's deletion of the worktree -
	 * is waited for instead (WT-8.4).
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
		await this.whenIdle(uri);
		return this.run(uri, task, true);
	}

	/** Once nothing runs for `uri`: what runs now done, and whatever started meanwhile. */
	private async whenIdle(uri: URI): Promise<void> {
		for (let going = this.running.get(uri); going; going = this.running.get(uri)) {
			await going.done;
		}
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
			&& !await this.workspaceTrustRequestService.requestResourcesTrust({ uri: main, message: localize('worktrees.untrusted', "A worktree inherits trust from its parent repository '{0}'. Please trust the parent repository first.", this.labelService.getUriLabel(main)) })) {
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
			notice: [prepareNotice(base)],
			action: localize('worktrees.initializeAndCreate', "Initialize and Create"),
			// Said before anything is done: without a name and an email, git refuses the commit. Not when
			// that is for the new repository to decide, as `includeIf` can; then the commit says so.
			blocked: base.identity === false ? noIdentityMessage() : undefined
		};

		const parent = joinPath(await this.pathService.userHome(), ...WORKTREES_FOLDER, basename(main));

		// From the home folder, so the part the branch makes fits on the dialog's line.
		const separator = this.labelService.getSeparator(parent.scheme, parent.authority);
		const parentLabel = ['~', ...WORKTREES_FOLDER, basename(main)].join(separator) + separator;

		// The names already taken, so the Path line shows the `-1` the worktree will get.
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

		// WT-5.2: the branch, where it starts and the folder it goes in, with the name and colour beside it. Prepared,
		// it starts from the initial commit the notice above says continuing creates.
		const origin = prepare
			? localize('worktrees.startsAtFirst', "Created from the initial commit.")
			: localize('worktrees.startsAt', "Created from HEAD of '{0}'.", basename(main));
		const answer = await this.workspaceBarDialogService.showNewWorktreeDialog(basename(main), origin, value => {
			const trimmed = value.trim();
			if (!trimmed) {
				// The folder it will be made in, waiting for the branch to finish its name.
				return { message: localize('worktrees.folder', "Path: {0}", parentLabel), valid: false };
			}

			const folder = worktreeFolderName(trimmed);
			if (!folder) {
				return { message: localize('worktrees.badName', "'{0}' is not a valid folder name on Windows.", trimmed), valid: false, error: true };
			}

			return { message: localize('worktrees.folder', "Path: {0}", parentLabel + freeWorktreeName(folder, candidate => taken.has(nameKey(candidate)))), valid: true };
		}, prepare);

		const branch = answer?.branch;
		const name = branch && worktreeFolderName(branch);
		if (!answer || !branch || !name) {
			return undefined;
		}

		// WT-5.8: the repository and its initial commit, now that the button that says so was pressed. What Git
		// makes, it makes in the repository's turn: an agent's worktree asked for meanwhile is made before or after
		// it, not while it is (O4)
		if (prepare) {
			let prepared: WorktreeBaseAtResult | undefined;
			try {
				prepared = await this.runInTurn(main, () => this.progressService.withProgress(
					{ location: ProgressLocation.Notification, title: localize('worktrees.preparing', "Creating initial commit in '{0}'...", basename(main)) },
					// With the branch, so a name git refuses is caught before anything changes.
					() => this.commandService.executeCommand<WorktreeBaseAtResult>('_git.prepareWorktreeBaseAt', main, 'initialize', branch)));
			} catch (err) {
				this.notificationService.error(gitUnreachable('_git.prepareWorktreeBaseAt', err));
				return undefined;
			}

			if (prepared?.kind !== 'ready') {
				const error = prepared?.kind === 'error' ? prepared : undefined;
				const message = gitMessage(error);
				this.logService.warn(`[worktrees] Failed to prepare repository at '${main.toString(true)}': ${message}`);
				this.notificationService.error(explainFailure(error, main, branch)
					?? localize('worktrees.prepareFailed', "Failed to create the initial commit for '{0}': {1}", basename(main), message));
				return undefined;
			}
		}

		const created = await this.runInTurn(main, () => this.createDecided(main, branch, name, parent, answer.customization, undefined));
		if (created.kind === 'failed') {
			if (created.unreachable) {
				this.notificationService.error(created.unreachable);
			} else {
				this.reportCreateFailure(main, repository, branch, created.worktree, created.result);
			}
			return undefined;
		}

		const after = await this.afterCreate(main, created.worktree, true);
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
	private async doMakeWorktree(main: URI, branch: string, options: IMakeWorktreeOptions): Promise<IMadeWorktree> {
		if (!branch) {
			throw new Error(localize('worktrees.noBranch', "A branch name is required to create a worktree."));
		}

		const name = worktreeFolderName(branch);
		if (!name) {
			throw new Error(localize('worktrees.badName', "'{0}' is not a valid folder name on Windows.", branch));
		}

		const trustEnabled = this.workspaceTrustEnablementService.isWorkspaceTrustEnabled();
		if (trustEnabled && !this.workspaceTrustManagementService.isWorkspaceTrusted()) {
			throw new Error(restrictedUnasked());
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

		const parent = joinPath(await this.pathService.userHome(), ...WORKTREES_FOLDER, basename(main));
		// The agent's caller says what could not be copied and how a hook failed: the person is not told of it
		const created = await this.createDecided(main, branch, name, parent, {}, options.startPoint, true);
		if (created.kind === 'failed') {
			throw new Error(created.unreachable ?? this.createFailureMessage(main, branch, created.worktree, created.result));
		}

		// The worktree is made either way: what failed after is said, and the agent gets it (WT-5.7)
		const after = await this.afterCreate(main, created.worktree, options.show === true);
		if (after !== 'shown' && after !== 'not asked') {
			this.notificationService.warn(localize('worktrees.createdForAgent', "Worktree was created at '{0}', but {1} failed: {2}", this.labelService.getUriLabel(created.worktree), after.step, after.reason));
		}
		return { worktree: created.worktree, copyFailures: created.result.copyFailures, ...(created.result.hookFailure ? { hookFailure: created.result.hookFailure } : {}) };
	}

	/**
	 * WT-5.4 once the branch is decided: the folder, its customization, and git's worktree. Failures
	 * are returned, for New Worktree to say on screen and `makeWorktree` to throw.
	 */
	private async createDecided(main: URI, branch: string, name: string, parent: URI, given: IFolderCustomization, startPoint: string | undefined, quiet = false): Promise<CreateOutcome> {
		// A free path chosen and taken in one turn of `parent`: another repository of the same name making one
		// there meanwhile would choose the same (X-72)
		const previous = this.makingIn.get(parent) ?? Promise.resolve();
		const outcome = previous.then(() => this.createAtFreePath(main, branch, name, parent, given, startPoint, quiet));
		const settled = outcome.then(() => undefined, () => undefined);
		this.makingIn.set(parent, settled);
		try {
			return await outcome;
		} finally {
			if (this.makingIn.get(parent) === settled) {
				this.makingIn.delete(parent);
			}
		}
	}

	/** `createDecided`, in `parent`'s turn. */
	private async createAtFreePath(main: URI, branch: string, name: string, parent: URI, given: IFolderCustomization, startPoint: string | undefined, quiet: boolean): Promise<CreateOutcome> {
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
			const create = () => this.commandService.executeCommand<CreateWorktreeAtResult>('_git.createWorktreeAt', main, worktree, branch, ...(startPoint ? [startPoint] : []));
			// An agent's is made in the background: no notification of it (G8)
			result = quiet ? await create() : await this.progressService.withProgress(
				{ location: ProgressLocation.Notification, title: localize('worktrees.creating', "Creating worktree '{0}'...", customization.name || branch) },
				create);
		} catch (err) {
			this.customizationService.set(worktree, {});
			return { kind: 'failed', worktree, result: undefined, unreachable: gitUnreachable('_git.createWorktreeAt', err) };
		}

		if (!result || result.kind === 'error') {
			this.customizationService.set(worktree, {});
			this.logService.warn(`[worktrees] Failed to create worktree at '${worktree.toString(true)}': ${result?.message ?? 'no response'}`);
			return { kind: 'failed', worktree, result };
		}

		// WT-6.4: a file that did not copy is said once, and stops nothing - by the caller, where it is quiet
		if (result.copyFailures.length > 0 && !quiet) {
			this.notificationService.warn(localize('worktrees.copyFailed', "Failed to copy {0} files specified in .worktreeinclude into the worktree: {1}", result.copyFailures.length, result.copyFailures.slice(0, LISTED_COPY_FAILURES).join(', ')));
		}

		// Nor does a hook that failed: git kept the worktree, and so does this.
		if (result.hookFailure && !quiet) {
			this.notificationService.warn(localize('worktrees.hookFailed', "Worktree was created, but a Git hook failed: {0}", result.hookFailure));
		}

		// A worktree made where one was deleted is a new one, its setup not started (WT-7.7)
		this.setupStarted.delete(worktree);
		return { kind: 'created', worktree, result };
	}

	/**
	 * Lists and opens a worktree git made, and shows it if `show` (WT-5.6) - trusted as its repository is, with
	 * nothing to record for it (WORKTREE.md). Returns the step that failed instead; the worktree is kept either
	 * way (WT-5.7).
	 */
	private async afterCreate(main: URI, worktree: URI, show: boolean): Promise<'shown' | 'not asked' | { readonly step: string; readonly reason: string }> {
		try {
			// Listed before it joins the workspace, so that its row is under its repository from the start (WT-3.6)
			await this.workspaceBarService.whenListed(worktree);
		} catch (err) {
			return { step: localize('worktrees.stepRecord', "reading Git worktree metadata"), reason: toErrorMessage(err) };
		}

		// One made in the background leaves the person's view as it was: a repository row they collapsed stays
		// collapsed, its agents' marker on it (AGENT-ORCHESTRATION.md, O1; AGENT-LAUNCHER.md, L3; XS-06)
		if (!show) {
			return 'not asked';
		}

		// So the row the window is about to go to can be seen.
		this.workspaceBarService.setExpanded(main, true);

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
						this.runSetup(main, worktree, false).catch(onUnexpectedError);
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
	 * WT-7: the lines of `.facade/worktrees.json`, run in a terminal of the worktree - in the person's own
	 * shell, with the output on screen, or `held` under the worktree's row and not shown, for an agent's
	 * (WT-5.11), whose caller says how it went. A failing line leaves the worktree usable. Resolves with how
	 * it came out once the last line has finished - where shell integration says it did, else once it is
	 * typed - or once the terminal is gone; `opened` is told of its terminal, or of none, and `running` of
	 * each line as it starts and of none once it has finished, where shell integration says when that is.
	 * Started once for a worktree: only the person's Rerun Setup sends it again (WT-7.7).
	 */
	private async runSetup(main: URI, worktree: URI, held: boolean, opened: (terminal: ITerminalInstance | undefined) => void = () => { }, running: (line: string | undefined) => void = () => { }): Promise<WorktreeSetupOutcome> {
		if (this.setupStarted.has(worktree)) {
			opened(undefined);
			return { kind: 'none' };
		}
		this.setupStarted.set(worktree, true);

		const content = await this.readFirst([joinPath(worktree, '.facade', 'worktrees.json'), joinPath(main, '.facade', 'worktrees.json')]);
		if (content === undefined) {
			opened(undefined);
			return { kind: 'none' };
		}

		// The OS the terminal will run on - the remote's, for a folder on a remote.
		const windows = (await this.pathService.path).sep === '\\';
		const setup = readSetupCommands(content, windows);
		if (setup.kind === 'none') {
			opened(undefined);
			return { kind: 'none' };
		}

		if (setup.kind === 'invalid') {
			if (!held) {
				this.notificationService.warn(localize('worktrees.badSetup', "Failed to parse .facade/worktrees.json: setup keys must contain an array of command strings. No commands were executed."));
			}
			opened(undefined);
			return { kind: 'invalid' };
		}

		// Noted until the last line is sent, so that a window closed meanwhile leaves the note for the next (WT-7.7)
		this.noteSetup(main, worktree, true);
		try {
			const config = {
				name: localize('worktrees.setupTerminal', "Worktree Setup"),
				cwd: worktree,
				// Cursor's name for it, so a script written for Cursor's worktrees.json works here.
				env: { ROOT_WORKTREE_PATH: toOsPath(main, windows) }
			};
			let terminal: ITerminalInstance;
			if (held) {
				terminal = await this.folderTerminalsService.openFor(worktree, config);
			} else {
				terminal = await this.terminalService.createTerminal({ config });
				this.terminalService.setActiveInstance(terminal);
				await this.terminalService.revealTerminal(terminal);
			}

			opened(terminal);

			// WT-7.4: each line whatever the one before did, one at a time: the next is sent once shell
			// integration says the last finished, or straight after it without shell integration. The first that
			// failed is the setup's outcome.
			const detection = await this.commandDetection(terminal);
			if (terminal.isDisposed) {
				return { kind: 'stopped' };
			}
			let failed: WorktreeSetupOutcome | undefined;
			for (const [index, line] of setup.lines.entries()) {
				// Typed ahead without shell integration, a line is not known to be running, nor to have finished
				running(detection ? line : undefined);
				const ran = await runSetupLine(terminal, detection, line);
				running(undefined);
				if (!ran.finished) {
					return { kind: 'stopped' };
				}
				// With its shell gone, the lines after it cannot run: that it ended is the setup's failure, unless it failed
				const unrun = ran.shellEnded && index < setup.lines.length - 1;
				if ((ran.exitCode !== undefined && ran.exitCode !== 0) || unrun) {
					const output = [ran.output?.trimEnd(), unrun ? localize('worktrees.shellEnded', "The shell exited after this command, so the commands after it did not run.") : undefined].filter(Boolean).join('\n');
					failed ??= { kind: 'failed', line, exitCode: ran.exitCode ?? 0, ...(output ? { output: output.slice(-SETUP_OUTPUT_CHARS) } : {}) };
				}
				if (ran.shellEnded) {
					break;
				}
			}
			return failed ?? (detection ? { kind: 'succeeded' } : { kind: 'submitted' });
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
						return this.runSetup(main, worktree, false);
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
	 * terminal's own commands give it; undefined without it, and once the terminal is closed meanwhile.
	 */
	private async commandDetection(terminal: ITerminalInstance): Promise<ICommandDetectionCapability | undefined> {
		const detection = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (detection) {
			return detection;
		}

		const injected = this.configurationService.getValue(TerminalSettingId.ShellIntegrationEnabled) === true;
		const store = new DisposableStore();
		try {
			return await raceTimeout(Promise.race([
				Event.toPromise(terminal.capabilities.onDidAddCommandDetectionCapability, store),
				Event.toPromise(terminal.onDisposed, store).then(() => undefined)
			]), getShellIntegrationTimeout(this.configurationService, injected, terminal.hasRemoteAuthority));
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

		// 1  check: what would be lost, before anybody is asked - a lock refusing it before anything is asked or stopped,
		//    rather than found out at the end (WT-8, step 1).
		const check = await this.checkDeletion(main, worktree, name);
		if (isString(check)) {
			this.notificationService.error(check);
			return;
		}

		// 2  confirm, naming all that would be lost, unsaved editors and running terminals too (WT-8.1, WT-8.2): a terminal
		//    that goes with it, working inside it or one of its editor area whatever it started in
		const unsaved = await this.unsavedIn(worktree);
		const loss: IDeletionLoss = { ...check, unsaved: unsaved.map(each => each.path) };
		const running = this.runningAmong(await this.terminalsGoingWith(worktree));
		if (!(await this.confirmDelete(name, branch, loss, running, false))) {
			return;
		}

		const deletion = await this.deleteChecked(main, worktree, name, {
			kind: 'person',
			unsaved: unsaved.map(each => each.workingCopy),
			confirmAgain: async now => {
				const more = newLoss(loss, now);
				return !more || await this.confirmDelete(name, branch, more, [], true);
			}
		});
		this.reportDeletion(main, worktree, name, deletion);
	}

	/**
	 * `removeWorktree`: WT-8 with nothing asked - no confirmation, no trust asked for - its changes deleted
	 * with it where the caller said so, and refusing it otherwise (WT-8.10). Git that is still starting, as a
	 * window just opened, is waited for. What a deletion in this window left of one (`options.leftover`) has no
	 * git to ask what it holds - the caller has looked - but its unsaved editors refuse it unless discarded, and
	 * only the folder git's answer named then is deleted, while it is still that folder: no path alone is reason
	 * enough to delete a folder and all in it (WORKTREE.md WT-4.5).
	 */
	private async doRemoveWorktree(main: URI, worktree: URI, name: string, options: IRemoveWorktreeOptions): Promise<void> {
		const recovery = options.leftover ? this.leftovers.get(worktree) : undefined;
		if (options.leftover && recovery === undefined) {
			// Gone already - deleted by the person's Retry, say - there is nothing left to delete
			if (!await this.fileService.exists(worktree)) {
				return;
			}
			throw new Error(localize('worktrees.leftoverUnknown', "'{0}' was not recognized as a worktree folder left behind by a deletion in this window, so it was not deleted. Delete it manually if needed.", this.labelService.getUriLabel(worktree)));
		}

		const check = await this.checkToRemove(main, worktree, name, options);

		// Changes the caller did not decide on - come since it looked, say - are not deleted unasked (WT-8.10)
		const loss = options.discardChanges ? undefined : await this.undecidedLoss(main, worktree, check, options);
		if (loss) {
			throw new Error(this.describeLoss(worktree, loss, false));
		}

		const failure = this.deletionFailure(main, worktree, name, await this.deleteChecked(main, worktree, name, {
			kind: 'decided',
			runs: options.runs ?? [],
			discardChanges: !!options.discardChanges,
			// Looked at once more before the cleanup, and right before git deletes it, once its terminals have closed: what
			// came meanwhile - a file, an unsaved edit, the person's edit to a file the caller put there - is nobody's
			// decision (X-73; XS-07). What a deletion left has no git to ask again.
			recheck: async now => {
				if (options.discardChanges) {
					return undefined;
				}
				const again = now ?? (options.leftover ? check : await this.checkDeletion(main, worktree, name));
				if (isString(again)) {
					return again;
				}
				const late = await this.undecidedLoss(main, worktree, again, options);
				return late && this.describeLoss(worktree, late, true);
			}
		}, recovery));
		if (failure) {
			throw new Error(failure);
		}
	}

	/**
	 * Step 1 of a deletion nothing is asked for (WT-8.10): what git says deleting `worktree` would lose - of what a
	 * deletion left, which no git lists, nothing. Git that is still starting, as a window just opened, is waited for.
	 * Throws, in the product's words, where it cannot be asked: Restricted Mode, or Git not running or failing - and
	 * where git holds it by a lock.
	 */
	private async checkToRemove(main: URI, worktree: URI, name: string, options: IRemoveWorktreeOptions): Promise<WorktreeCheck> {
		if (this.workspaceTrustEnablementService.isWorkspaceTrustEnabled() && !this.workspaceTrustManagementService.isWorkspaceTrusted()) {
			throw new Error(restrictedUnasked());
		}

		await whenRegistered('_git.deleteWorktreeAt', GIT_START_TIMEOUT);
		if (options.leftover) {
			return { files: [], ignoredPaths: [], submodules: false, restrictions: [] };
		}
		const check = await this.checkDeletion(main, worktree, name);
		if (isString(check)) {
			throw new Error(check);
		}
		return check;
	}

	/**
	 * What git says deleting `worktree`, of the main checkout `main`, would lose - or, where it could not say, why: Git not
	 * running, or failing - in the product's words. A lock git holds it by refuses it here, before anything is asked or
	 * stopped, rather than at the end (WT-8, step 1).
	 */
	private async checkDeletion(main: URI, worktree: URI, name: string): Promise<WorktreeCheck | string> {
		let check: DeleteWorktreeAtResult | undefined;
		try {
			check = await this.deleteAt(main, worktree, 'check');
		} catch (err) {
			return gitUnreachableToDelete(err);
		}
		if (!check || check.kind !== 'checked') {
			return checkFailure(check?.kind === 'error' ? check : undefined, main);
		}

		const lock = check.restrictions.find(restriction => restriction.kind === 'locked');
		if (lock) {
			return lock.reason
				? localize('worktrees.lockedBecause', "Worktree '{0}' is locked: {1}. Run 'git worktree unlock' to allow deletion.", name, lock.reason)
				: localize('worktrees.locked', "Worktree '{0}' is locked. Run 'git worktree unlock' to allow deletion.", name);
		}
		return check;
	}

	/**
	 * What deleting `worktree`, of the main checkout `main`, would lose that `options` does not say goes: the files `check`
	 * found, and what git ignores there, but those the caller put there - unchanged since, by their hash - and, of what
	 * git ignores, what the main checkout holds as it is, as what .worktreeinclude copied does (WT-6); its editors with
	 * unsaved changes; and its submodules (AGENT-ORCHESTRATION.md, O5). Undefined for nothing.
	 */
	private async undecidedLoss(main: URI, worktree: URI, check: WorktreeCheck, options: IRemoveWorktreeOptions): Promise<IDeletionLoss | undefined> {
		const owned = new Map((options.ownFiles ?? []).map(file => [file.path, file.sha256]));
		const isOwned = async (file: string) => {
			const sha256 = owned.get(file);
			return sha256 !== undefined && await this.sha256Of(joinPath(worktree, ...file.split('/'))) === sha256;
		};
		const files: string[] = [];
		for (const file of check.files) {
			if (!await isOwned(file)) {
				files.push(file);
			}
		}
		// The same in the main checkout: deleting this copy loses nothing
		const isCopy = async (file: string) => {
			const sha256 = await this.sha256Of(joinPath(worktree, ...file.split('/')));
			return sha256 !== undefined && await this.sha256Of(joinPath(main, ...file.split('/'))) === sha256;
		};
		// A wholly ignored folder is one path, ending with a slash: lost unless each file in it is the caller's or such a copy
		const ignoredPaths: string[] = [];
		for (const ignored of check.ignoredPaths) {
			const inside = ignored.endsWith('/') ? await this.filesUnder(worktree, ignored, COMPARED_IGNORED_FILES) : [ignored];
			if (!inside || !(await Promise.all(inside.map(async file => await isOwned(file) || await isCopy(file)))).every(Boolean)) {
				ignoredPaths.push(ignored);
			}
		}
		const unsaved = (await this.unsavedIn(worktree)).map(each => each.path);
		return files.length || ignoredPaths.length || unsaved.length || check.submodules ? { files, ignoredPaths, unsaved, submodules: check.submodules } : undefined;
	}

	/**
	 * The files in the folder `path` of `worktree` - a path relative to it, ending with a slash - and in its folders, each
	 * by its path relative to the worktree; undefined where they cannot all be read, or there are more than `most`.
	 */
	private async filesUnder(worktree: URI, path: string, most: number): Promise<string[] | undefined> {
		const files: string[] = [];
		const folders = [path];
		for (let folder = folders.shift(); folder !== undefined; folder = folders.shift()) {
			let children: readonly IFileStat[];
			try {
				children = (await this.fileService.resolve(joinPath(worktree, ...folder.split('/').filter(Boolean)))).children ?? [];
			} catch {
				return undefined;
			}
			for (const child of children) {
				if (child.isDirectory) {
					folders.push(`${folder}${child.name}/`);
				} else if (files.push(`${folder}${child.name}`) > most) {
					return undefined;
				}
			}
		}
		return files;
	}

	/** The SHA-256 of what `file` holds, in hex; undefined where it cannot be read. */
	private async sha256Of(file: URI): Promise<string | undefined> {
		try {
			const content = (await this.fileService.readFile(file)).value.buffer;
			return encodeHex(VSBuffer.wrap(new Uint8Array(await crypto.subtle.digest('SHA-256', content as Uint8Array<ArrayBuffer>))));
		} catch {
			return undefined;
		}
	}

	/**
	 * The working copies of `worktree`'s files with unsaved changes - editors and notebooks alike, open on screen or put
	 * away - each with its path in the worktree: by its own path, or by its real one, for a file opened through a link to
	 * the worktree (X-71; SP-25).
	 */
	private async unsavedIn(worktree: URI): Promise<readonly { readonly workingCopy: IWorkingCopy; readonly path: string }[]> {
		const extUri = this.uriIdentityService.extUri;
		const found: { readonly workingCopy: IWorkingCopy; readonly path: string }[] = [];
		for (const workingCopy of this.workingCopyService.dirtyWorkingCopies) {
			let resource: URI | undefined = workingCopy.resource;
			if (!extUri.isEqualOrParent(resource, worktree)) {
				resource = workingCopy.resource.scheme === worktree.scheme ? await this.fileService.realpath(workingCopy.resource).catch(() => undefined) : undefined;
			}
			if (resource && extUri.isEqualOrParent(resource, worktree)) {
				found.push({ workingCopy, path: extUri.relativePath(worktree, resource) ?? resource.path });
			}
		}
		return found;
	}

	/**
	 * Discards the unsaved changes of `unsaved` and closes the editors of `worktree`'s files: those inside it, and those
	 * of `unsaved`, opened through a link to it too (X-71; SP-25).
	 */
	private async discardInside(worktree: URI, unsaved: readonly IWorkingCopy[]): Promise<void> {
		for (const workingCopy of unsaved) {
			await workingCopy.revert({ soft: true });
		}
		const extUri = this.uriIdentityService.extUri;
		const inside = this.editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => {
			const resource = EditorResourceAccessor.getCanonicalUri(editor);
			return !!resource && (extUri.isEqualOrParent(resource, worktree) || unsaved.some(workingCopy => extUri.isEqual(workingCopy.resource, resource)));
		});
		if (inside.length) {
			await this.editorService.closeEditors(inside, { preserveFocus: true });
		}
	}

	/** Why `loss` refuses deleting `worktree`, in the product's words: found first, or `late`, as it was being deleted. */
	private describeLoss(worktree: URI, loss: IDeletionLoss, late: boolean): string {
		const label = this.labelService.getUriLabel(worktree);
		const listed = lostFiles(loss);
		const named = listed.length > LISTED_FILES
			? localize('worktrees.namedMore', "{0} and {1} more", listed.slice(0, LISTED_FILES).join(', '), listed.length - LISTED_FILES)
			: listed.join(', ');
		if (late) {
			return listed.length
				? localize('worktrees.changedMeanwhile', "'{0}' was not deleted because new changes appeared in it during deletion and would be lost: {1}.", label, named)
				: localize('worktrees.submodulesMeanwhile', "'{0}' was not deleted because submodules were added to it during deletion; deleting it would lose any of their unpushed commits.", label);
		}
		return listed.length
			? localize('worktrees.wouldLose', "'{0}' has changes that would be lost if it were deleted: {1}. Nothing was deleted.", label, named)
			: localize('worktrees.wouldLoseSubmodules', "'{0}' has submodules; deleting it would lose any of their unpushed commits. Nothing was deleted.", label);
	}

	/** `_git.deleteWorktreeAt`, for `worktree` of `main`; `recovery` is what `cleanup` deletes by. */
	private deleteAt(main: URI, worktree: URI, mode: 'check' | 'remove' | 'force' | 'cleanup', recovery?: string): Promise<DeleteWorktreeAtResult | undefined> {
		return this.commandService.executeCommand<DeleteWorktreeAtResult>('_git.deleteWorktreeAt', main, worktree, mode, ...(recovery !== undefined ? [recovery] : []));
	}

	async otherWindowsAgentsIn(worktree: URI): Promise<string[]> {
		if (worktree.scheme !== Schemas.file) {
			return [];
		}
		const own = this.contextService.getWorkspace().id;
		try {
			const backend = await this.terminalInstanceService.getBackend();
			// Every window's, the attached ones too: another window's agent is attached to that window, no orphan (run 4: SP-18)
			const processes = await backend?.listProcesses({ attached: true }) ?? [];
			return processes
				.filter(each => facadeRunOf(each) !== undefined && each.workspaceId !== own && each.pid > 0 && !!each.cwd && this.uriIdentityService.extUri.isEqualOrParent(URI.file(each.cwd), worktree))
				.map(each => each.title);
		} catch {
			// The pty host does not answer: nothing more to tell than the window knows
			return [];
		}
	}

	/**
	 * WT-8 from step 3, once what would be lost is known and its deletion decided - by the person's confirmation, or by a
	 * caller (WT-8.10): the window off it and the workspace without it before anything of it is stopped or discarded, and
	 * everything that could hold the directory open gone before git is asked to delete it, by force where git's last look
	 * found changes or submodules - or, given the `leftover` recovery, what a deletion left deleted. Answers how it ended,
	 * with what of it was done whatever the end: that stays done, and is said (WT-8.6).
	 */
	private async deleteChecked(main: URI, worktree: URI, name: string, deletion: IPersonDeletion | IDecidedDeletion, leftover?: string): Promise<IDeletion> {
		const decided = deletion.kind === 'decided' ? deletion : undefined;
		const wasFolder = this.contextService.getWorkspace().folders.some(folder => this.uriIdentityService.extUri.isEqual(folder.uri, worktree));
		const done: { toldAgents: boolean; leftFolders: boolean; ended: readonly string[] } = { toldAgents: false, leftFolders: false, ended: [] };

		// 3 to 7 under one progress: a large tree takes a while to delete. A caller's in the status bar: nobody asked
		// for it where they would look for it
		const outcome = await this.progressService.withProgress(
			{ location: decided ? ProgressLocation.Window : ProgressLocation.Notification, title: localize('worktrees.deleting', "Deleting worktree '{0}'...", name) },
			async (): Promise<DeletionOutcome> => {
				// An agent of another window working inside it - the pty host has every window's terminals - would
				// lose its folder under it, and that window book its end as the person's: refused, before anything
				// is closed or moved (SP-18; N-37)
				const elsewhere = await this.otherWindowsAgentsIn(worktree);
				if (elsewhere.length) {
					return { kind: 'refused', why: localize('worktrees.agentElsewhere', "'{0}' was not deleted because an agent from another window is working in it ({1}). Stop that agent in its window first.", this.labelService.getUriLabel(worktree), elsewhere.join(', ')) };
				}

				// Decided by a caller, whether it goes is settled before anything is moved, closed or removed: a deletion
				// refused leaves the person's view, terminals and editors as they were (XS-07). An agent's terminal is
				// closed only where the caller stopped that agent: another, working inside it, is not ended unasked (X-74).
				if (decided) {
					const unnamed = (await this.terminalsInside(worktree)).filter(instance => {
						const run = facadeRunOf(instance);
						return run && instance.exitCode === undefined && !decided.runs.some(each => each.workspace === run.workspace && each.id === run.id);
					});
					if (unnamed.length) {
						return { kind: 'refused', why: localize('worktrees.agentInside', "'{0}' was not deleted because an agent that this deletion does not stop is working in it ({1}). Stop that agent first.", this.labelService.getUriLabel(worktree), unnamed.map(instance => instance.title).join(', ')) };
					}
				}

				// Its files open in the window are read-only from the last look to git's end: nothing typed into one
				// after that look goes unseen (N-41)
				const held = this.holdReadonly(worktree);
				let hidden: IDisposable | undefined;
				try {
					// The last look - decided by a caller - that nothing came that nobody decided on
					const why = await decided?.recheck();
					if (why) {
						return { kind: 'refused', why };
					}

					// 3  decided, no agent starts in it until the deletion is over: the person's says so here, a caller's
					//    has said so before it asked (WT-8, step 3; OR-10). Without Facade's agents there is none to tell.
					if (deletion.kind === 'person') {
						done.toldAgents = await this.tellAgentsDeleting(worktree);
					}

					// 4  move off, to the repository's own row (WT-8.3); a window that cannot stops the deletion
					if (!await this.moveOff(main, worktree, !!decided)) {
						return { kind: 'stayed' };
					}

					// Its row goes with the window off it, rather than once git has deleted it - which takes
					// seconds for a large worktree - and comes back if the deletion fails (WT-8.9).
					hidden = this.workspaceBarService.hideWorktree(worktree);

					// 5  leave folders[] without asking again (WT-8.4), its running work and unsaved changes left as they are: a
					//    workspace that refuses stops the deletion here, nothing of it stopped or discarded
					const removal = await this.workspaceBarService.remove([worktree], { confirmed: true, deleting: true });
					if (removal.kind !== 'removed') {
						return { kind: 'notRemoved' };
					}
					done.leftFolders = wasFolder;

					// 6  stop what goes with it: Facade's agents working in it, by whoever decided on the deletion, their starts
					//    cancelled, waited for - those still stopping keep it - then the terminals still going with it, working
					//    inside it or parked for it, closed for the person's deletion, which an agent's end says, not that a tab
					//    was closed (N-04). What closing them ended is said whatever comes after; git's delete waits for their
					//    shells to let go.
					const running = this.runningAmong(await this.terminalsGoingWith(worktree)).map(work => work.name);
					const stopping = await this.stopAgentsIn(worktree);
					if (stopping) {
						return { kind: 'stopping', ...stopping };
					}
					done.ended = running;
					for (const instance of await this.terminalsGoingWith(worktree)) {
						if (deletion.kind === 'person') {
							this.facadeRunsService.closingBecause(instance, 'worktreeDeleted');
						}
						instance.dispose(TerminalExitReason.User);
					}

					// What a deletion left: git has nothing more to say of it (WT-4.5)
					if (leftover !== undefined) {
						await this.discardDecided(worktree, deletion);
						return await this.deleteAt(main, worktree, 'cleanup', leftover);
					}

					// Read again, now that what ran in its terminals has stopped: a file one of them wrote as it stopped - a
					// log, say - was in no look before, and `--force` would delete it. More to lose is asked about again, or
					// refuses a caller's (WT-8, step 6; XS-07)
					const now = await this.deleteAt(main, worktree, 'check');
					if (now?.kind !== 'checked') {
						return now;
					}
					if (deletion.kind === 'decided') {
						const late = await deletion.recheck(now);
						if (late) {
							return { kind: 'refused', why: late };
						}
					} else if (!await deletion.confirmAgain(now)) {
						return { kind: 'kept' };
					}

					// Only now what it was decided to discard: what the confirmation named - all there is, where the
					// caller said to - its editors closed
					await this.discardDecided(worktree, deletion);

					// 7  delete. `force` only when what it throws away was confirmed, or the caller said it goes.
					return await this.deleteAt(main, worktree, now.files.length > 0 || now.submodules ? 'force' : 'remove');
				} catch (err) {
					return { kind: 'error', code: undefined, message: toErrorMessage(err) };
				} finally {
					held.dispose();
					hidden?.dispose();
				}
			});

		// The agents' record forgets a worktree Facade made, now that git is done: told so here, where the extension
		// host that asked for the deletion may have started again meanwhile (O5). Told of the person's that it is over
		// otherwise, which keeps agents from starting there until it is (OR-10).
		if (outcome?.kind === 'removed' && worktree.scheme === Schemas.file) {
			this.tellAgents('_facade.agents.worktreeDeleted', worktree, 'is deleted');
		} else if (done.toldAgents) {
			this.tellAgents('_facade.agents.worktreeDeleteFailed', worktree, 'is not deleted');
		}

		// Letting the row go reads git's records again: gone after a removal, back after a failure (WT-8.9). Its name,
		// colour, place and the trust it was given go with git's record: they are kept by path, and the next worktree of
		// the same branch lands on the same path (WT-8.6).
		if (outcome?.kind === 'removed' || outcome?.kind === 'incomplete') {
			await this.forgetWorktree(main, worktree);
		}
		if (outcome?.kind === 'incomplete') {
			this.leftovers.set(worktree, outcome.recovery);
		} else if (outcome?.kind === 'removed') {
			this.leftovers.delete(worktree);
		}

		return { outcome, leftFolders: done.leftFolders, ended: done.ended };
	}

	/**
	 * Discards the unsaved changes the deletion of `worktree` was decided with - those the person's confirmation named, or
	 * all there are where the caller said they go - and closes the editors of its files (WT-8, step 6).
	 */
	private async discardDecided(worktree: URI, deletion: IPersonDeletion | IDecidedDeletion): Promise<void> {
		const unsaved = deletion.kind === 'person' ? deletion.unsaved : deletion.discardChanges ? (await this.unsavedIn(worktree)).map(each => each.workingCopy) : [];
		await this.discardInside(worktree, unsaved);
	}

	/**
	 * Moves the window off `worktree` if it is on it, to its repository's own row (WT-8.3), and answers whether it is off
	 * it. A caller's deletion of one whose repository's folder is gone goes back to the folder the person was on before -
	 * or, with that gone too, leaves it to leaving folders[], which moves the window on (AGENT-ORCHESTRATION.md, O5).
	 */
	private async moveOff(main: URI, worktree: URI, decided: boolean): Promise<boolean> {
		const isOn = () => this.uriIdentityService.extUri.isEqual(this.activeFolderService.activeFolder?.uri, worktree);
		if (!isOn()) {
			return true;
		}
		if (!decided || await this.fileService.exists(main)) {
			await this.workspaceBarService.show(main);
			return !isOn();
		}
		const previous = this.activeFolderService.previousFolder;
		if (previous) {
			await this.activeFolderService.setActiveFolder(previous).catch(err => this.logService.trace(`[worktrees] Window could not return to '${previous.uri.toString(true)}': ${toErrorMessage(err)}`));
		}
		return true;
	}

	/**
	 * Tells the agents that the person decided to delete `worktree`: none starts there until the window says how it went
	 * (WT-8, step 3; OR-10). Answers whether they were told; without Facade's agents there are none to tell.
	 */
	private async tellAgentsDeleting(worktree: URI): Promise<boolean> {
		if (worktree.scheme !== Schemas.file) {
			return false;
		}
		try {
			await this.commandService.executeCommand('_facade.agents.worktreeDeleting', worktree);
		} catch (error) {
			this.logService.trace(`[worktrees] Could not tell the agents that '${worktree.toString(true)}' is being deleted: ${toErrorMessage(error)}`);
		}
		return true;
	}

	/**
	 * Stops Facade's agents working in `worktree` - their starts cancelled, its setup terminals closed - by whoever decided
	 * on its deletion, and waits for them (WT-8, step 6; N-34): undefined once all have ended, else those still stopping
	 * when the stop timeout was over (AGENT-ORCHESTRATION.md, O5). Without Facade's agents there are none.
	 */
	private async stopAgentsIn(worktree: URI): Promise<IAgentsStopping | undefined> {
		if (worktree.scheme !== Schemas.file || !CommandsRegistry.getCommand('_facade.agents.worktreeStopping')) {
			return undefined;
		}
		const answer = await this.commandService.executeCommand<IAgentsStopping>('_facade.agents.worktreeStopping', worktree);
		return answer?.stopping.length ? answer : undefined;
	}

	/** Says how the person's deletion of `worktree` ended, where it did not go as asked (WT-8.6). */
	private reportDeletion(main: URI, worktree: URI, name: string, deletion: IDeletion): void {
		const { outcome } = deletion;
		if (outcome?.kind === 'removed') {
			return;
		}
		if (outcome?.kind === 'incomplete') {
			this.reportLeftover(main, worktree, outcome);
			return;
		}

		this.logService.warn(`[worktrees] Deleting '${worktree.toString(true)}' concluded as ${outcome?.kind ?? 'unknown'}${outcome?.kind === 'error' ? `: ${outcome.message}` : ''}`);
		if (outcome?.kind === 'refused') {
			this.notificationService.error(outcome.why);
		} else if (outcome?.kind === 'stayed') {
			this.notificationService.error(couldNotLeave(main, name));
		} else if (outcome?.kind === 'kept') {
			this.notificationService.info(deletion.leftFolders
				? localize('worktrees.kept', "Worktree '{0}' was not deleted from disk. It has been removed from the workspace. Click its row to add it back.", name)
				: localize('worktrees.keptOutside', "Worktree '{0}' was not deleted from disk.", name));
		} else if (outcome?.kind === 'notRemoved') {
			// The workspace has said why; what was done before it is said as done (WT-8, step 5)
			this.notificationService.error(notOutOfWorkspace(name));
		} else if (outcome?.kind === 'stopping') {
			this.notificationService.error(stillStopping(name, outcome.stopping, deletion.leftFolders));
		} else if (outcome?.kind === 'error') {
			// Still registered, so its row comes back; what was done already is said (WT-8.6)
			const failure = deleteFailure(outcome, main);
			const sentence = /[.!?]$/.test(failure) ? failure : `${failure}.`;
			this.notificationService.error(deletion.leftFolders
				? localize('worktrees.alreadyOut', "{0} It was removed from the workspace, and its running terminals were terminated.", sentence)
				: deletion.ended.length
					? localize('worktrees.terminalsTerminated', "{0} Its running terminals were terminated.", sentence)
					: sentence);
		} else {
			// No answer at all: nothing is said to have happened that cannot be seen to have.
			this.notificationService.prompt(Severity.Error, localize('worktrees.deleteUnknown', "Unable to confirm deletion of worktree '{0}'. The workspace bar reflects the current Git status.", name),
				[{ label: revealLabel(), run: () => this.commandService.executeCommand('revealFileInOS', worktree) }]);
		}
	}

	/**
	 * Why a caller's deletion of `worktree` did not go as asked, in the product's words, with what of it was done all
	 * the same - the call's answer, not a notification (WT-8.10); undefined once it is deleted. What a deletion left is
	 * named, for a retry to finish (AGENT-ORCHESTRATION.md, O5).
	 */
	private deletionFailure(main: URI, worktree: URI, name: string, deletion: IDeletion): string | undefined {
		const { outcome } = deletion;
		if (outcome?.kind === 'removed') {
			return undefined;
		}

		let why: string;
		if (outcome?.kind === 'refused') {
			why = outcome.why;
		} else if (outcome?.kind === 'incomplete') {
			why = leftBehind(outcome);
		} else if (outcome?.kind === 'stayed') {
			why = couldNotLeave(main, name);
		} else if (outcome?.kind === 'notRemoved') {
			why = notOutOfWorkspace(name);
		} else if (outcome?.kind === 'stopping') {
			// Said in the caller's words, which name the agents its call stopped too
			why = outcome.why ?? stillStopping(name, outcome.stopping, false);
		} else {
			const error = outcome?.kind === 'error' ? outcome : undefined;
			this.logService.warn(`[worktrees] Failed to delete worktree '${worktree.toString(true)}': ${gitMessage(error)}`);
			why = deleteFailure(error, main);
		}

		const done = [
			deletion.leftFolders ? localize('worktrees.outOfWorkspace', "It was removed from the workspace.") : undefined,
			deletion.ended.length ? localize('worktrees.terminalsEnded', "Terminals associated with this worktree were closed and active processes terminated: {0}.", deletion.ended.join(', ')) : undefined
		].filter(isString);
		return [why, ...done].join('\n');
	}

	/**
	 * Forgets a deleted worktree's name, colour and place, which are kept by path, and any trust an earlier build
	 * recorded for that path: a worktree's own is its repository's now (WORKTREE.md).
	 */
	private async forgetWorktree(main: URI, worktree: URI): Promise<void> {
		this.customizationService.set(worktree, {});
		const order = this.customizationService.worktreeOrder(main);
		if (order) {
			this.customizationService.setWorktreeOrder(main, order.filter(candidate => !this.uriIdentityService.extUri.isEqual(candidate, worktree)));
		}
		if (this.workspaceTrustEnablementService.isWorkspaceTrustEnabled()) {
			await this.workspaceTrustManagementService.setUrisTrust([worktree], false);
		}
	}

	/** Reports a directory a removal left behind, with a way to see it and to retry (WT-8.6). */
	private reportLeftover(main: URI, worktree: URI, leftover: { readonly path: string; readonly recovery: string; readonly message: string }): void {
		this.notificationService.prompt(Severity.Error,
			leftBehind(leftover),
			[
				// Kept open, so that Retry is still there after a look at the folder
				{ label: revealLabel(), keepOpen: true, run: () => this.commandService.executeCommand('revealFileInOS', worktree) },
				{
					label: localize('worktrees.retry', "Retry"),
					run: async () => {
						let again: DeleteWorktreeAtResult | undefined;
						try {
							again = await this.deleteAt(main, worktree, 'cleanup', leftover.recovery);
						} catch (err) {
							again = { kind: 'error', code: undefined, message: toErrorMessage(err) };
						}
						if (again?.kind === 'incomplete') {
							this.reportLeftover(main, worktree, again);
						} else if (again?.kind === 'removed') {
							this.leftovers.delete(worktree);
							if (worktree.scheme === Schemas.file) {
								this.tellAgents('_facade.agents.worktreeDeleted', worktree, 'is deleted');
							}
						} else {
							this.notificationService.error(localize('worktrees.leftoverRefused', "Failed to delete folder: {0}", gitMessage(again?.kind === 'error' ? again : undefined)));
						}
					}
				}
			]);
	}

	/** The terminals that go with `worktree` as it is deleted, each once: those working inside it, and those of its editor area, whatever they started in. */
	private async terminalsGoingWith(worktree: URI): Promise<ITerminalInstance[]> {
		return distinct([...await this.terminalsInside(worktree), ...this.folderTerminalsService.terminalsOf(worktree)]);
	}

	/** What runs among `terminals`, which closing them ends: agents, and the processes of the others (W9.6). */
	private runningAmong(terminals: readonly ITerminalInstance[]): IRunningWork[] {
		return runningWork(terminals, new Set(this.launcherService.agentTerminals));
	}

	/**
	 * Tells the agents' record by `command` what became of `worktree` - `what`, as the log says it - without waiting. Not
	 * told is a warning where the agents' extension has the command, something having gone wrong there, and only traced
	 * where it has none: the window runs no Facade agents to tell.
	 */
	private tellAgents(command: '_facade.agents.worktreeDeleteFailed' | '_facade.agents.worktreeDeleted', worktree: URI, what: string): void {
		this.commandService.executeCommand(command, worktree).catch(err => {
			const message = `[worktrees] Could not tell the agents that ${worktree.toString(true)} ${what}: ${toErrorMessage(err)}`;
			if (CommandsRegistry.getCommand(command)) {
				this.logService.warn(message);
			} else {
				this.logService.trace(message);
			}
		});
	}

	/**
	 * Makes `worktree`'s files open in the window read-only for the session until disposed - those open now and
	 * any opened meanwhile - and then as they were. One read-only already is left as it is.
	 *
	 * ⚠️ Why the window and not git: the last look at what deleting it would lose runs here, and git's
	 * `worktree remove` in the extension host, a crossing later. An edit made in between - the extension host
	 * slow, or held in a debugger - would be in no look, and its file deleted under its editor (N-41).
	 */
	private holdReadonly(worktree: URI): IDisposable {
		const extUri = this.uriIdentityService.extUri;
		const held = new ResourceSet(uri => extUri.getComparisonKey(uri));
		const why = new MarkdownString(localize('worktrees.beingDeleted', "The worktree is being deleted."));
		const hold = (resources: readonly URI[]) => {
			const fresh = resources.filter(resource => extUri.isEqualOrParent(resource, worktree) && !held.has(resource) && !this.filesConfigurationService.isReadonly(resource));
			for (const resource of fresh) {
				held.add(resource);
			}
			if (fresh.length) {
				void this.filesConfigurationService.updateReadonly(fresh, why);
			}
		};
		const store = new DisposableStore();
		store.add(this.workingCopyService.onDidRegister(workingCopy => hold([workingCopy.resource])));
		store.add(toDisposable(() => {
			if (held.size) {
				void this.filesConfigurationService.updateReadonly([...held], 'reset');
			}
		}));
		hold(this.workingCopyService.workingCopies.map(workingCopy => workingCopy.resource));
		return store;
	}

	/** Whether `folder` is a worktree Facade did not make: a linked worktree outside `WORKTREES_FOLDER` (WT-1.3). */
	private async isAnotherToolsWorktree(folder: URI): Promise<boolean> {
		const extUri = this.uriIdentityService.extUri;
		if (!await worktreeRepositoryOf(this.fileService, extUri, folder)) {
			return false;
		}

		const [canonical, own] = await Promise.all([canonicalUri(this.fileService, folder), worktreesFolderOf(this.fileService, this.pathService)]);
		return !extUri.isEqualOrParent(canonical, own);
	}

	/** That `target` is no worktree the workspace knows. */
	private notAWorktree(target: URI): string {
		return localize('worktrees.notWorktree', "'{0}' is not a recognized worktree in this workspace.", this.labelService.getUriLabel(target));
	}

	/**
	 * The terminals working inside the worktree - where they are now, or where they started. Only
	 * terminals on the worktree's own machine: a cwd is a path of the machine its terminal runs on.
	 */
	async terminalsInside(worktree: URI): Promise<ITerminalInstance[]> {
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

	/**
	 * Asks once, naming everything deleting the worktree loses (WT-8.1, WT-8.2): the agents and terminals `running`, and
	 * what is lost with its folder. With `again`, asks only about what appeared since the first time.
	 */
	private async confirmDelete(name: string, branch: string | undefined, loss: IDeletionLoss, running: readonly IRunningWork[], again: boolean): Promise<boolean> {
		const { files, ignoredPaths, submodules, unsaved } = loss;

		// Laid out as VS Code's own delete confirmation: lists first, each under what becomes of it, one to a line, then
		// one paragraph (WORKSPACE.md W10.7). All of it is the worktree's, which the question names, so no line says where.
		const paragraphs: string[] = [];
		const list = (heading: string, lines: readonly string[]) => {
			if (lines.length) {
				paragraphs.push([heading, ...lines].join('\n'));
			}
		};

		const work = agentsFirst(running);
		list(terminatedHeading(work), listedSessions(work.map(item => workLine(item, undefined))));
		list(localize('worktrees.loses', "The following uncommitted changes will be lost:"), listedFiles(files));
		list(discardedHeading(unsaved.length), listedFiles(unsaved));
		list(localize('worktrees.ignored', "The following files ignored by Git will be deleted:"), listedFiles(ignoredPaths));

		const sentences: string[] = [];
		if (again) {
			if (paragraphs.length) {
				sentences.push(localize('worktrees.sinceAsked', "Additional files were modified since this prompt opened and will also be lost."));
			}
			if (submodules) {
				sentences.push(localize('worktrees.submodulesSince', "Submodules and any unpushed commits will also be deleted."));
			}
		} else {
			// Deleted for good, not moved to the Recycle Bin, so in VS Code's words for that
			sentences.push(submodules
				? localize('worktrees.folderAndSubmodulesDeleted', "The worktree folder, including its submodules and unpushed commits, will be deleted. This action cannot be undone.")
				: localize('worktrees.folderDeleted', "The worktree folder will be deleted from disk. This action cannot be undone."));
			// A worktree on a detached HEAD has no branch to keep, and is not told it has one.
			if (branch) {
				sentences.push(localize('worktrees.branchKeptQuoted', "The branch '{0}' will be preserved.", branch));
			}
		}
		if (sentences.length) {
			paragraphs.push(sentences.join(' '));
		}

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

/** What a second check finds that the first did not, or undefined when nothing new would be lost. */
function newLoss(confirmed: IDeletionLoss, now: { readonly files: readonly string[]; readonly ignoredPaths: readonly string[]; readonly submodules: boolean }): IDeletionLoss | undefined {
	const files = now.files.filter(file => !confirmed.files.includes(file));
	const ignoredPaths = now.ignoredPaths.filter(ignored => !confirmed.ignoredPaths.includes(ignored));
	const submodules = now.submodules && !confirmed.submodules;
	return files.length || ignoredPaths.length || submodules ? { files, ignoredPaths, submodules, unsaved: [] } : undefined;
}

/** The platform's own words for showing a folder where it lives, as the bar's menu has them. */
function revealLabel(): string {
	return isWindows ? localize('worktrees.revealInWindows', "Reveal in File Explorer")
		: isMacintosh ? localize('worktrees.revealInMac', "Reveal in Finder")
			: localize('worktrees.revealInLinux', "Open Containing Folder");
}

/**
 * Runs one setup line; false once the terminal is gone.
 *
 * With shell integration, it waits for the line's own command to finish - known by the id it is run
 * with, as the next command the shell reports finishing need not be this one. Without, the line is
 * typed straight after the last: nothing would say when that one finished.
 */
async function runSetupLine(terminal: ITerminalInstance, detection: ICommandDetectionCapability | undefined, line: string): Promise<{ readonly finished: boolean; readonly exitCode?: number; readonly output?: string; readonly shellEnded?: boolean }> {
	if (terminal.isDisposed) {
		return { finished: false };
	}

	if (!detection) {
		await terminal.sendText(line, true);
		return { finished: !terminal.isDisposed };
	}

	const store = new DisposableStore();
	try {
		const id = generateUuid();
		const finished = Event.toPromise(Event.filter(detection.onCommandFinished, command => command.id === id), store).then(command => ({ finished: true, exitCode: command.exitCode, output: command.getOutput() }));
		const disposed = Event.toPromise(terminal.onDisposed, store).then(() => ({ finished: false }));
		// A line that ends its shell - its `exit 7` - ends with it: finished, with the shell's code (AS-33)
		const exited = Event.toPromise(terminal.onExit, store).then(exit => typeof exit === 'number'
			? { finished: true, exitCode: exit, output: detection.executingCommandObject?.getOutput(), shellEnded: true }
			: { finished: false });
		await terminal.runCommand(line, true, id);
		return await Promise.race([finished, exited, disposed]);
	} finally {
		store.dispose();
	}
}

/**
 * The last `count` lines `terminal` shows, as plain text, oldest first: each read whole, the rows a line wraps over
 * joined as VS Code joins them (`getFullBufferLineAsString`); a blank line kept, but those at the end - the empty rows
 * below its output. None while it has no screen yet.
 */
function lastLinesOf(terminal: ITerminalInstance, count: number): string[] {
	const buffer = terminal.xterm?.raw.buffer.active;
	if (!buffer) {
		return [];
	}
	const lines: string[] = [];
	for (let row = buffer.length - 1; row >= 0 && lines.length < count; row--) {
		const { lineData, lineIndex } = getFullBufferLineAsString(row, buffer);
		row = lineIndex;
		if (lines.length || lineData?.trim()) {
			lines.push(lineData ?? '');
		}
	}
	return lines.reverse();
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
				// without a repository is made one first (WT-5.8). Not on another tool's worktree (WT-1.3).
				id: WorkspaceBarContextMenu, group: 'navigation', order: 1,
				when: ContextKeyExpr.and(WorkspaceBarRowKindContext.notEqualsTo('worktree'), WorkspaceBarRowOffersWorktreeContext, WORKTREES_SHOWN)
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
