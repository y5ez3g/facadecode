/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentCatalog, detectAgents } from '../common/agents';
import { Git } from '../common/git';
import { pipePath } from '../common/ipc';
import { Delivery } from '../common/kernel/delivery';
import { JsonFileState } from '../common/kernel/fileState';
import { Kernel } from '../common/kernel/kernel';
import { LedgerLockedError } from '../common/kernel/ledger';
import { WorkspaceServer } from '../common/kernel/server';
import { writeProtocolPages, writeSkillsPlugin } from '../common/kernel/skills';
import { Spawner } from '../common/kernel/spawner';
import { workspaceDir, workspacesRoot } from '../common/kernel/workspace';
import { GitExtensionWorktrees, gitPath, StoredTrustDecisions } from './hostParts';
import { WindowIde } from './ide';
import { RowNotes } from './rowNotes';
import { FacadeViews } from './views';
import { TerminalRunner } from './terminalRunner';

/*
 * The workspace's collaboration primitives in this window (L2-PLAN, milestone 1): the ledger and the
 * notebook under ~/.facade/workspaces, the pipe every agent's MCP server calls, and the terminals
 * agents run in. Only runs while `facade.orchestration.enabled` is on; off, none of it exists.
 */

const PIPE_ID_KEY = 'facade.agents.pipeId';
const CATALOG_TTL_MS = 60_000;
/**
 * When a folder window becomes a workspace, its extension host starts again while the one before can
 * still be letting go of the ledger and the pipe: this long, what it holds is waited for.
 */
const HANDOVER_MS = 10_000;

export class WorkspaceService implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private kernel: Kernel | undefined;
	private server: WorkspaceServer | undefined;
	private spawner: Spawner | undefined;
	private catalogCache: { value: AgentCatalog; at: number } | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) { }

	async start(): Promise<void> {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
		if (!folders.length) {
			this.log.info('Facade agents need a folder on this machine in the workspace; nothing started.');
			return;
		}
		const dir = workspaceDir(workspacesRoot(), folders[0].uri.fsPath);
		try {
			this.kernel = await whenFree(() => Kernel.open({ dir, watch: true, log: message => this.log.info(message) }), err => err instanceof LedgerLockedError);
		} catch (err) {
			if (err instanceof LedgerLockedError) {
				this.log.warn(err.message);
				void vscode.window.showWarningMessage(vscode.l10n.t("Another Facade window has this workspace's agents. They stay in that window."));
				return;
			}
			throw err;
		}
		const kernel = this.kernel;
		this.disposables.push({ dispose: () => kernel.dispose() });
		writeProtocolPages(kernel);
		const pluginsRoot = path.join(this.context.globalStorageUri.fsPath, 'skills-plugin');

		const shim = { command: process.execPath, args: [shimPath()], env: { ELECTRON_RUN_AS_NODE: '1' } };
		const git = new Git(await gitPath());
		// Next to the ledger rather than in the workspace storage, which a folder window becoming a
		// workspace replaces while agents keep running.
		const windowState = new JsonFileState(path.join(dir, 'window-state.json'));
		const runner = new TerminalRunner(windowState, (name, exitCode) => this.spawner?.exited(name, exitCode), message => this.log.info(message));
		this.disposables.push(runner);

		let pipeId = windowState.get<string | undefined>(PIPE_ID_KEY, undefined) ?? crypto.randomBytes(8).toString('hex');
		await windowState.update(PIPE_ID_KEY, pipeId);

		const spawner = this.spawner = new Spawner({
			kernel,
			git,
			worktrees: new GitExtensionWorktrees(git, this.log),
			makeWorktree: await hasCommand('_facade.worktree.create') ? makeWorktree : undefined,
			runner,
			trust: new StoredTrustDecisions(this.context.globalState),
			shim,
			pipe: () => this.server?.pipe ?? pipePath(pipeId),
			env: process.env,
			catalog: () => this.catalog(),
			worktreesRoot: path.join(os.homedir(), '.facade', 'worktrees'),
			hooksDir: path.join(os.homedir(), '.facade', 'hooks'),
			// Made from the pages as they are when each Claude starts, the person's edits included.
			pluginDir: () => writeSkillsPlugin(pluginsRoot, kernel),
			notice: message => void vscode.window.showInformationMessage(message),
			log: message => this.log.info(message)
		});

		const start = (pipe: string) => WorkspaceServer.start({ kernel, pipe, agents: spawner, hooks: spawner, ide: new WindowIde(git), log: message => this.log.info(message) });
		const inUse = (err: unknown) => (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
		try {
			// The same pipe as before, which the agents still running call.
			this.server = await whenFree(() => start(pipePath(pipeId)), inUse);
		} catch (err) {
			if (!inUse(err)) {
				throw err;
			}
			this.log.warn(`The pipe ${pipePath(pipeId)} is taken; using a new one.`);
			pipeId = crypto.randomBytes(8).toString('hex');
			await windowState.update(PIPE_ID_KEY, pipeId);
			this.server = await start(pipePath(pipeId));
		}
		const server = this.server;
		this.disposables.push({ dispose: () => server.dispose() });
		await spawner.recover();
		const delivery = new Delivery({
			kernel,
			type: (name, text) => spawner.type(name, text),
			lastInputAt: name => spawner.lastInputAt(name),
			log: message => this.log.info(message)
		});
		this.disposables.push({ dispose: () => delivery.dispose() });
		// Messages that came while the window was away.
		for (const participant of kernel.state.participants.values()) {
			void delivery.deliver(participant.name);
		}
		this.disposables.push(new RowNotes(kernel, message => this.log.info(message)));
		this.disposables.push(new FacadeViews(kernel, spawner, message => this.log.info(message)));
		this.log.info(`Facade agents are on for ${folders[0].uri.fsPath}. Ledger ${dir}; pipe ${server.pipe}; agents: ${[...this.catalog().installed.keys()].join(', ') || 'none'}.`);
	}

	dispose(): void {
		for (const disposable of this.disposables.reverse()) {
			try {
				disposable.dispose();
			} catch (err) {
				this.log.error(`Stopping Facade agents: ${(err as Error).message}`);
			}
		}
		this.disposables.length = 0;
	}

	private catalog(): AgentCatalog {
		if (!this.catalogCache || Date.now() - this.catalogCache.at > CATALOG_TTL_MS) {
			this.catalogCache = { value: detectAgents(process.env), at: Date.now() };
		}
		return this.catalogCache.value;
	}
}

/** What `attempt` makes, tried again while `busy` says what it needs is still held, for {@link HANDOVER_MS} at most. */
async function whenFree<T>(attempt: () => T | Promise<T>, busy: (err: unknown) => boolean): Promise<T> {
	const deadline = Date.now() + HANDOVER_MS;
	for (; ;) {
		try {
			return await attempt();
		} catch (err) {
			if (!busy(err) || Date.now() >= deadline) {
				throw err;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
}

async function hasCommand(id: string): Promise<boolean> {
	return (await vscode.commands.getCommands(true)).includes(id);
}

/** The window's New Worktree without its dialog: the worktree's folder, its row and its setup. */
async function makeWorktree(repoRoot: string, branch: string, startPoint: string): Promise<string> {
	const made = await vscode.commands.executeCommand<{ readonly path: string }>('_facade.worktree.create', vscode.Uri.file(repoRoot), branch, startPoint, false);
	return made.path;
}

/**
 * The shim beside the extension's code: next to this file when bundled into `dist/`, one folder up
 * when compiled file by file into `out/`, as a development build runs it.
 */
function shimPath(): string {
	const bundled = path.join(__dirname, 'shim.js');
	return fs.existsSync(bundled) ? bundled : path.join(__dirname, '..', 'shim.js');
}
