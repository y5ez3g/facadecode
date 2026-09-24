/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Event } from '../../../../base/common/event.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { isObject } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { NEW_WORKTREE_COMMAND, WorkspaceBarContextMenu, WorkspaceBarRowKindContext } from '../../../browser/parts/workspacebar/workspaceBarActions.js';
import { IWorkspaceBarRepository } from '../../../browser/parts/workspacebar/workspaceBarGit.js';
import { IWorkspaceBarService } from '../../../browser/parts/workspacebar/workspaceBarService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

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
