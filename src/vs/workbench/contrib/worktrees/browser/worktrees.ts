/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Event } from '../../../../base/common/event.js';
import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../base/common/htmlContent.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { isObject } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { asCodeSpan } from '../../../browser/parts/workspacebar/workspaceBar.js';
import { NEW_WORKTREE_COMMAND, WorkspaceBarContextMenu, WorkspaceBarRowKindContext } from '../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarRepository } from '../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IActiveFolderService } from '../../../services/activeFolder/common/activeFolder.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';

/*
 * Making a worktree from the workspace bar (WORKTREE.md sections 7 to 9).
 *
 * ⚠️ Here and not beside the bar: the bar lives in `vs/workbench/browser`, which may not reach
 * `contrib/terminal`, and the setup step runs in a terminal. The bar only calls the command.
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

export type SetupCommands =
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

	return { kind: 'lines', lines };
}

/** What `git.createWorktreeAt` answers - the shape `extensions/git/src/worktreeAt.ts` returns. */
type CreateWorktreeAtResult =
	| { readonly kind: 'created'; readonly path: string; readonly copyFailures: readonly string[] }
	| { readonly kind: 'error'; readonly code: string | undefined; readonly message: string };

/** A path as git, running beside the folder, spells it: the OS's own on disk, the URI's path on a remote. */
export function gitPath(uri: URI): string {
	return uri.scheme === Schemas.file ? uri.fsPath : uri.path;
}

/** How long to wait for the switch to put the new worktree's editors up before running setup anyway. */
const RESTORE_TIMEOUT = 5000;

export class NewWorktreeAction extends Action2 {

	constructor() {
		super({
			id: NEW_WORKTREE_COMMAND,
			title: localize2('worktrees.newWorktree', "New Worktree..."),
			category: localize2('worktrees.category', "Workspace"),
			f1: true,
			menu: { id: WorkspaceBarContextMenu, group: '3_worktree', order: 1, when: WorkspaceBarRowKindContext.isEqualTo('repository') }
		});
	}

	override async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		// ⚠️ All of them before the first `await`: a `ServicesAccessor` is only good for the synchronous
		// part of a run.
		const services = {
			workspaceBar: accessor.get(IWorkspaceBarService),
			quickInput: accessor.get(IQuickInputService),
			commands: accessor.get(ICommandService),
			notifications: accessor.get(INotificationService),
			progress: accessor.get(IProgressService),
			files: accessor.get(IFileService),
			paths: accessor.get(IPathService),
			trust: accessor.get(IWorkspaceTrustManagementService),
			trustEnablement: accessor.get(IWorkspaceTrustEnablementService),
			terminals: accessor.get(ITerminalService),
			labels: accessor.get(ILabelService),
			log: accessor.get(ILogService)
		};

		const target = uri ?? services.workspaceBar.folderForCommand();
		const repository = target && services.workspaceBar.repositoryFor(target);
		if (!target || !repository) {
			// WT-5.1: a folder without its own .git has no worktrees to make.
			if (target) {
				services.notifications.info(localize('worktrees.notRepository', "{0} is not a git repository, so it has no worktrees.", services.labels.getUriLabel(target)));
			}
			return;
		}

		await newWorktree(services, repository);
	}
}

type Services = {
	readonly workspaceBar: IWorkspaceBarService;
	readonly quickInput: IQuickInputService;
	readonly commands: ICommandService;
	readonly notifications: INotificationService;
	readonly progress: IProgressService;
	readonly files: IFileService;
	readonly paths: IPathService;
	readonly trust: IWorkspaceTrustManagementService;
	readonly trustEnablement: IWorkspaceTrustEnablementService;
	readonly terminals: ITerminalService;
	readonly labels: ILabelService;
	readonly log: ILogService;
};

/** WT-5.6, in its order: name, create, trust, show, wait, setup. */
async function newWorktree(services: Services, repository: IWorkspaceBarRepository): Promise<void> {
	const main = repository.main;
	const trustEnabled = services.trustEnablement.isWorkspaceTrustEnabled();

	// WT-5.1: an untrusted repository gets no worktree - a new one would inherit trust it was never given.
	if (trustEnabled && !(await services.trust.getUriTrustInfo(main)).trusted) {
		services.notifications.warn(localize('worktrees.untrusted', "Trust {0} before making a worktree of it.", services.labels.getUriLabel(main)));
		return;
	}

	const parent = joinPath(await services.paths.userHome(), ...WORKTREES, basename(main));

	// WT-5.2: one thing asked, and under it where the worktree goes and where it starts.
	const branch = (await services.quickInput.input({
		title: localize('worktrees.newTitle', "New Worktree in {0}", basename(main)),
		placeHolder: localize('worktrees.branchPlaceholder', "Branch name"),
		prompt: localize('worktrees.startsAt', "A new branch, starting at the current HEAD of {0}.", basename(main)),
		validateInput: async value => {
			if (!value.trim()) {
				return undefined;
			}

			const name = worktreeFolderName(value);
			if (!name) {
				return { content: localize('worktrees.badName', "\"{0}\" cannot be the name of a folder on Windows.", value.trim()), severity: Severity.Error };
			}

			return { content: localize('worktrees.where', "Goes in {0}", services.labels.getUriLabel(joinPath(parent, name))), severity: Severity.Info };
		}
	}))?.trim();

	const name = branch && worktreeFolderName(branch);
	if (!branch || !name) {
		return;
	}

	const worktree = await freeWorktreeUri(parent, name, candidate => services.files.exists(candidate));

	// WT-5.4: 20 to 30 seconds for a large repository, and not cancellable - a half-made worktree is
	// worse than waiting.
	let result: CreateWorktreeAtResult | undefined;
	try {
		result = await services.progress.withProgress(
			{ location: ProgressLocation.Notification, title: localize('worktrees.creating', "Creating worktree {0}...", branch) },
			() => services.commands.executeCommand<CreateWorktreeAtResult>('git.createWorktreeAt', gitPath(main), gitPath(worktree), branch));
	} catch (err) {
		// The command is the git extension's: missing when git is, or when the extension is off.
		services.notifications.error(localize('worktrees.noGit', "Git could not be reached to make the worktree: {0}", toErrorMessage(err)));
		return;
	}

	if (!result || result.kind === 'error') {
		reportCreateFailure(services, repository, branch, worktree, result);
		return;
	}

	// WT-6.4: a file that did not copy is said once, and stops nothing.
	if (result.copyFailures.length > 0) {
		services.notifications.warn(localize('worktrees.copyFailed', "{0} of what .worktreeinclude names could not be copied into the worktree: {1}", result.copyFailures.length, result.copyFailures.slice(0, 3).join(', ')));
	}

	if (trustEnabled) {
		await services.trust.setUrisTrust([worktree], true);
	}

	// ⚠️ WT-5.7: subscribed before the switch, awaited after it. The switch restores the worktree's
	// editors and closes whatever else is in the editor area, so a setup terminal opened as an editor
	// before that has finished is closed again.
	const restored = Event.toPromise(services.workspaceBar.onDidRestoreEditors);
	await services.workspaceBar.show(worktree);
	await raceTimeout(restored, RESTORE_TIMEOUT);

	await runSetup(services, main, worktree);
}

/** WT-5.3 and WT-5.5: git's errors are the checks, and each is said on screen in words. */
function reportCreateFailure(services: Services, repository: IWorkspaceBarRepository, branch: string, worktree: URI, result: CreateWorktreeAtResult | undefined): void {
	const error = result?.kind === 'error' ? result : undefined;
	services.log.warn(`[worktrees] creating ${worktree.toString(true)} failed: ${error?.message ?? 'no answer'}`);

	if (error?.code === 'BranchAlreadyExists') {
		// ⚠️ Always `-b`, so a branch that exists is this code whether or not it is checked out. When
		// a checkout has it, the only useful thing to offer is going there.
		const holder = repository.branch === branch
			? repository.main
			: repository.worktrees.find(candidate => candidate.branch === branch)?.uri;
		if (holder) {
			services.notifications.prompt(Severity.Info,
				localize('worktrees.branchCheckedOut', "Branch {0} is already checked out in {1}.", branch, services.labels.getUriLabel(holder)),
				[{ label: localize('worktrees.goThere', "Go There"), run: () => services.workspaceBar.show(holder) }]);
			return;
		}

		services.notifications.error(localize('worktrees.branchExists', "A branch named {0} already exists. Choose another name.", branch));
		return;
	}

	if (error?.code === 'WorktreeAlreadyExists') {
		services.notifications.error(localize('worktrees.pathExists', "Something is already at {0}.", services.labels.getUriLabel(worktree)));
		return;
	}

	services.notifications.error(localize('worktrees.createFailed', "The worktree could not be made: {0}", error?.message ?? localize('worktrees.noAnswer', "Git did not answer.")));
}

/**
 * WT-7: `.facade/worktrees.json`, run in one terminal of the worktree, every line in turn.
 *
 * ⚠️ A terminal rather than a process of ours: the output is on screen, the person's own shell and
 * environment run it, and there is nothing to time out, kill or recover. A failing line leaves the
 * worktree usable.
 */
async function runSetup(services: Services, main: URI, worktree: URI): Promise<void> {
	const content = await readFirst(services.files, [joinPath(worktree, '.facade', 'worktrees.json'), joinPath(main, '.facade', 'worktrees.json')]);
	if (content === undefined) {
		return;
	}

	// The OS the terminal will run on - the remote's, for a folder on a remote.
	const windows = (await services.paths.path).sep === '\\';
	const setup = readSetupCommands(content, windows);
	if (setup.kind === 'none') {
		return;
	}

	if (setup.kind === 'invalid') {
		services.notifications.warn(localize('worktrees.badSetup', ".facade/worktrees.json could not be read: each setup key has to be a list of command lines. Nothing was run."));
		return;
	}

	const terminal = await services.terminals.createTerminal({
		config: {
			name: localize('worktrees.setupTerminal', "Worktree Setup"),
			cwd: worktree,
			// Cursor's name for it, so a script written for Cursor's worktrees.json works here.
			env: { ROOT_WORKTREE_PATH: gitPath(main) }
		}
	});
	services.terminals.setActiveInstance(terminal);
	await services.terminals.revealTerminal(terminal);

	// WT-7.4: each line as its own, whatever the one before it did. Steps that depend on each other
	// belong in a script named on one line.
	for (const line of setup.lines) {
		await terminal.sendText(line, true);
	}
}

/** What `git.deleteWorktreeAt` answers - the shape `extensions/git/src/worktreeAt.ts` returns. */
type DeleteWorktreeAtResult =
	| { readonly kind: 'dirty'; readonly files: readonly string[] }
	| { readonly kind: 'removed' }
	| { readonly kind: 'error'; readonly code: string | undefined; readonly message: string };

/** How many files a confirmation names before it says how many more there are. */
const LISTED_FILES = 10;

/** How long to wait for a closed terminal's process to let go of the directory. */
const TERMINAL_EXIT_TIMEOUT = 3000;

export const DELETE_WORKTREE_COMMAND = 'facade.workspaceBar.deleteWorktree';

export class DeleteWorktreeAction extends Action2 {

	constructor() {
		super({
			id: DELETE_WORKTREE_COMMAND,
			title: localize2('worktrees.deleteWorktree', "Delete Worktree..."),
			category: localize2('worktrees.category', "Workspace"),
			f1: true,
			menu: { id: WorkspaceBarContextMenu, group: '9_remove', order: 2, when: WorkspaceBarRowKindContext.isEqualTo('worktree') }
		});
	}

	override async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		// ⚠️ All of them before the first `await`: a `ServicesAccessor` is only good for the synchronous
		// part of a run.
		const services = {
			workspaceBar: accessor.get(IWorkspaceBarService),
			activeFolder: accessor.get(IActiveFolderService),
			commands: accessor.get(ICommandService),
			dialogs: accessor.get(IDialogService),
			notifications: accessor.get(INotificationService),
			terminals: accessor.get(ITerminalService),
			labels: accessor.get(ILabelService),
			identity: accessor.get(IUriIdentityService),
			log: accessor.get(ILogService)
		};

		const target = uri ?? services.workspaceBar.folderForCommand();
		const repository = target && services.workspaceBar.repositoryFor(target);
		const worktree = target && repository?.worktrees.find(candidate => services.identity.extUri.isEqual(candidate.uri, target));
		if (!target || !repository || !worktree) {
			if (target) {
				services.notifications.info(localize('worktrees.notWorktree', "{0} is not a worktree the workspace knows.", services.labels.getUriLabel(target)));
			}
			return;
		}

		await deleteWorktree(services, repository.main, worktree.uri, worktree.branch ?? worktree.label);
	}
}

type DeleteServices = {
	readonly workspaceBar: IWorkspaceBarService;
	readonly activeFolder: IActiveFolderService;
	readonly commands: ICommandService;
	readonly dialogs: IDialogService;
	readonly notifications: INotificationService;
	readonly terminals: ITerminalService;
	readonly labels: ILabelService;
	readonly identity: IUriIdentityService;
	readonly log: ILogService;
};

/**
 * WT-8, in its order. The order is the design: everything that could hold the directory open is gone
 * before git is asked to delete it.
 */
async function deleteWorktree(services: DeleteServices, main: URI, worktree: URI, branch: string): Promise<void> {
	const run = (mode: 'check' | 'remove' | 'force') => services.commands.executeCommand<DeleteWorktreeAtResult>('git.deleteWorktreeAt', gitPath(main), gitPath(worktree), mode);

	// 1  check: what would be lost, before anybody is asked.
	let check: DeleteWorktreeAtResult | undefined;
	try {
		check = await run('check');
	} catch (err) {
		services.notifications.error(localize('worktrees.noGitDelete', "Git could not be reached to delete the worktree: {0}", toErrorMessage(err)));
		return;
	}

	if (!check || check.kind !== 'dirty') {
		services.notifications.error(localize('worktrees.checkFailed', "The worktree could not be checked before deleting it: {0}", check?.kind === 'error' ? check.message : localize('worktrees.noAnswer', "Git did not answer.")));
		return;
	}

	const terminals = services.terminals.instances.filter(instance => inside(services.identity, instance, worktree));

	// 2  confirm: always, naming what would be lost (WT-8.1, WT-8.2).
	if (!(await confirmDelete(services, worktree, branch, check.files, terminals.some(instance => instance.hasChildProcesses)))) {
		return;
	}

	// ⚠️ Every terminal working inside it, and a promise for each one's exit, taken now - before step 4.
	// Leaving folders[] makes folderTerminals dispose the ones it parked, and a terminal disposed there
	// is gone from `instances` by step 5 while its shell is still exiting with its working directory in
	// the worktree. Found live: git then failed on the directory with "Permission denied".
	const closing = new Map(services.terminals.instances
		.filter(instance => inside(services.identity, instance, worktree))
		.map(instance => [instance, Event.toPromise(instance.onExit)] as const));

	// 3  move off, to the repository's own row rather than whichever folder is next in the list (WT-8.3).
	const active = services.activeFolder.activeFolder;
	if (active && services.identity.extUri.isEqual(active.uri, worktree)) {
		await services.workspaceBar.show(main);
	}

	// 4  leave folders[] - which also makes folderTerminals dispose what it parked for it (WT-8.4).
	await services.workspaceBar.remove([worktree]);

	// 5  close whatever is still working inside it - the panel's terminals, say, or one opened while the
	//    confirmation was up - and wait for every process to let go: on Windows a working directory
	//    inside a folder stops it being deleted.
	for (const instance of services.terminals.instances.filter(candidate => inside(services.identity, candidate, worktree))) {
		if (!closing.has(instance)) {
			closing.set(instance, Event.toPromise(instance.onExit));
		}
	}
	for (const instance of closing.keys()) {
		instance.dispose(TerminalExitReason.User);
	}
	await raceTimeout(Promise.all(closing.values()), TERMINAL_EXIT_TIMEOUT);

	// 6  delete. `force` only when the confirmation named the changes it throws away.
	let result: DeleteWorktreeAtResult | undefined;
	try {
		result = await run(check.files.length > 0 ? 'force' : 'remove');
	} catch (err) {
		result = { kind: 'error', code: undefined, message: toErrorMessage(err) };
	}

	// 7  nothing to refresh: the bar's reader sees git's records change (WT-8.6 when it went wrong).
	if (result?.kind !== 'removed') {
		const message = result?.kind === 'error' ? result.message : localize('worktrees.noAnswer', "Git did not answer.");
		services.log.warn(`[worktrees] deleting ${worktree.toString(true)} failed: ${message}`);
		services.notifications.error(localize('worktrees.deleteFailed', "The worktree could not be deleted: {0}", message));
	}
}

/** Whether a terminal is working inside the worktree - where it is now, or where it started. */
function inside(identity: IUriIdentityService, instance: ITerminalInstance, worktree: URI): boolean {
	return [instance.cwd, instance.initialCwd].some(cwd => {
		if (!cwd) {
			return false;
		}

		const location = worktree.scheme === Schemas.file ? URI.file(cwd) : worktree.with({ path: cwd });
		return identity.extUri.isEqualOrParent(location, worktree);
	});
}

async function confirmDelete(services: DeleteServices, worktree: URI, branch: string, files: readonly string[], running: boolean): Promise<boolean> {
	const detail = new MarkdownString();
	detail.appendMarkdown(`${asCodeSpan(services.labels.getUriLabel(worktree))}\n\n`);

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

	if (running) {
		detail.appendMarkdown(escapeMarkdownSyntaxTokens(localize('worktrees.running', "Something is running in one of its terminals; it will be stopped.")));
		detail.appendMarkdown('\n\n');
	}

	detail.appendMarkdown(escapeMarkdownSyntaxTokens(localize('worktrees.branchKept', "The branch {0} is kept.", branch)));

	const { confirmed } = await services.dialogs.confirm({
		type: files.length > 0 ? 'warning' : 'none',
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

/** The first of these files that can be read. */
async function readFirst(files: IFileService, candidates: readonly URI[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		try {
			return (await files.readFile(candidate)).value.toString();
		} catch {
			// Not there; the next one, then.
		}
	}

	return undefined;
}
