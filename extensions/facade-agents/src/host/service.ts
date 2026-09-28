/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentCatalog, detectAgents } from '../common/agents';
import { CommandApprovals, Engine, EngineSettings, Principal } from '../common/engine';
import { Git } from '../common/git';
import { normalizePath } from '../common/glob';
import { IpcServer, pipePath } from '../common/ipc';
import { writeClaudePlugin } from '../common/plugin';
import { removeInstance, writeInstance } from '../common/registry';
import { which } from '../common/spawn';
import { GitExtensionWorktrees, gitPath, StoredTrustDecisions } from './hostParts';
import { TerminalRunner } from './terminalRunner';
import { AgentsUi } from './ui';

/*
 * Wires the engine to this window: its storage, its terminals, the git extension, the pipe the
 * agents call, the registry file leads find the pipe by, and the plugin a lead is started with.
 * Only runs while `facade.orchestration.enabled` is on; off, none of it exists.
 */

const PIPE_ID_KEY = 'facade.agents.pipeId';
const APPROVED_COMMANDS_KEY = 'facade.agents.approvedCommands';
const CATALOG_TTL_MS = 60_000;

export class AgentsService implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private engine: Engine | undefined;
	private server: IpcServer<Principal> | undefined;
	private pipeId = '';
	private leadToken = '';
	private pluginDir = '';
	private catalogCache: { value: AgentCatalog; at: number } | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) { }

	async start(): Promise<void> {
		const storage = this.context.storageUri!.fsPath;
		const globalStorage = this.context.globalStorageUri.fsPath;
		const shimPath = path.join(__dirname, 'shim.js');
		const shim = { command: process.execPath, args: [shimPath], env: { ELECTRON_RUN_AS_NODE: '1' } };
		const git = new Git(await gitPath());
		const ui = new AgentsUi();
		this.disposables.push(ui);
		const runner = new TerminalRunner(this.context.workspaceState, (name, exitCode) => this.engine?.workerExited(name, exitCode));
		this.disposables.push(runner);

		this.pipeId = this.context.workspaceState.get<string>(PIPE_ID_KEY) ?? crypto.randomBytes(8).toString('hex');
		await this.context.workspaceState.update(PIPE_ID_KEY, this.pipeId);

		const engine = this.engine = new Engine({
			storageDir: path.join(storage, 'programs'),
			worktreesRoot: path.join(os.homedir(), '.facade', 'worktrees'),
			git,
			worktrees: new GitExtensionWorktrees(git, this.log),
			runner,
			ui,
			commandApprovals: new StoredCommandApprovals(this.context.globalState),
			trust: new StoredTrustDecisions(this.context.globalState),
			shim,
			pipe: pipePath(this.pipeId),
			env: process.env,
			settings: readSettings,
			catalog: () => this.catalog(),
			log: message => this.log.info(message)
		});
		ui.attach(engine);
		await engine.start();

		this.server = await this.listen(engine);
		this.leadToken = engine.issueLeadToken('window');
		const instances = path.join(globalStorage, 'instances');
		this.writeRegistry(instances);
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.writeRegistry(instances)));
		this.disposables.push({ dispose: () => removeInstance(instances, this.pipeId) });
		this.pluginDir = writeClaudePlugin({ root: path.join(globalStorage, 'claude-plugin'), mcp: { ...shim, args: [...shim.args, 'mcp', '--registry', instances] } });

		this.disposables.push(
			vscode.commands.registerCommand('facade.agents.startLead', () => this.startLead()),
			vscode.commands.registerCommand('facade.agents.showPrograms', () => ui.showPrograms()),
			vscode.commands.registerCommand('facade.agents.reviewPlan', () => ui.reviewPlan()),
			vscode.commands.registerCommand('facade.agents.reviewShip', () => ui.reviewShip())
		);
		this.log.info(`Facade agents are on. Pipe ${this.server.path}; plugin ${this.pluginDir}; agents: ${[...this.catalog().installed.keys()].join(', ') || 'none'}.`);
	}

	dispose(): void {
		this.server?.dispose();
		this.engine?.dispose();
		for (const disposable of this.disposables.reverse()) {
			disposable.dispose();
		}
	}

	/** Listens on the window's pipe; a pipe another window holds gets this window a new one. */
	private async listen(engine: Engine): Promise<IpcServer<Principal>> {
		const handlers = {
			authenticate: (token: string) => engine.authenticate(token),
			hello: (principal: Principal) => engine.hello(principal),
			call: (principal: Principal, tool: string, args: unknown, cwd: string | undefined, context: { signal: AbortSignal; progress(message: string): void }) => engine.call(principal, tool, args, cwd, context.signal, message => context.progress(message))
		};
		try {
			return await IpcServer.listen(pipePath(this.pipeId), handlers);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
				throw err;
			}
			this.log.warn(`The pipe ${pipePath(this.pipeId)} is taken, probably by another window on this workspace; using a new one.`);
			this.pipeId = crypto.randomBytes(8).toString('hex');
			await this.context.workspaceState.update(PIPE_ID_KEY, this.pipeId);
			return IpcServer.listen(pipePath(this.pipeId), handlers);
		}
	}

	private writeRegistry(dir: string): void {
		writeInstance(dir, this.pipeId, {
			pipe: this.server!.path,
			token: this.leadToken,
			pid: process.pid,
			folders: (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
			updatedAt: Date.now()
		});
	}

	private catalog(): AgentCatalog {
		if (!this.catalogCache || Date.now() - this.catalogCache.at > CATALOG_TTL_MS) {
			this.catalogCache = { value: detectAgents(process.env), at: Date.now() };
		}
		return this.catalogCache.value;
	}

	/** Starts Claude Code as a lead: in a terminal of this window, with the facade plugin for this session only. */
	private async startLead(): Promise<void> {
		const claude = which('claude');
		if (!claude) {
			void vscode.window.showErrorMessage(vscode.l10n.t("Claude Code is not installed: the claude command is not on PATH."));
			return;
		}
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
		const folder = folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t("Which repository should the lead work in?") }) : folders[0];
		if (!folder) {
			return;
		}
		const terminal = vscode.window.createTerminal({
			name: vscode.l10n.t("Claude · lead"),
			shellPath: claude,
			shellArgs: ['--plugin-dir', this.pluginDir],
			cwd: folder.uri.fsPath,
			env: { FACADE_AGENTS_PIPE: this.server!.path, FACADE_AGENTS_TOKEN: this.leadToken },
			iconPath: new vscode.ThemeIcon('robot'),
			location: { viewColumn: vscode.ViewColumn.Active }
		});
		terminal.show();
	}
}

class StoredCommandApprovals implements CommandApprovals {

	constructor(private readonly state: vscode.Memento) { }

	approved(repoRoot: string): ReadonlySet<string> {
		return new Set(this.state.get<Record<string, string[]>>(APPROVED_COMMANDS_KEY, {})[repoKey(repoRoot)] ?? []);
	}

	approve(repoRoot: string, keys: readonly string[]): void {
		const all = this.state.get<Record<string, string[]>>(APPROVED_COMMANDS_KEY, {});
		const key = repoKey(repoRoot);
		all[key] = [...new Set([...(all[key] ?? []), ...keys])];
		void this.state.update(APPROVED_COMMANDS_KEY, all);
	}
}

function repoKey(repoRoot: string): string {
	const normalized = normalizePath(path.resolve(repoRoot));
	return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

function readSettings(): EngineSettings {
	const config = vscode.workspace.getConfiguration('facade.orchestration');
	return {
		maxParallel: config.get<number>('maxParallel', 4),
		checkSlots: config.get<number>('checkSlots', 2),
		ladder: config.get<string[]>('ladder', []),
		retriesPerRung: config.get<number>('retriesPerRung', 2),
		agentConcurrency: config.get<Record<string, number>>('agentConcurrency', {}),
		hotspots: config.get<string[]>('hotspots', []),
		stallMinutes: config.get<number>('stallMinutes', 20),
		closeVerifiedWorkers: config.get<boolean>('closeVerifiedWorkers', true),
		workerMode: config.get<string>('workerMode', 'interactive') === 'headless' ? 'headless' : 'interactive'
	};
}
