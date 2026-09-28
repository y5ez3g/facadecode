/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TrustDecisions, WorktreeFactory } from '../common/engine';
import { Git } from '../common/git';

/*
 * What the window lends the agents: git worktrees made the way the person makes them, the person's
 * answers about trust, and the git the git extension found.
 */

const TRUST_KEY = 'facade.agents.trustedAgents';

/** Worktrees through the git extension, so they get `.worktreeinclude` and Git LFS like any other. */
export class GitExtensionWorktrees implements WorktreeFactory {

	constructor(private readonly git: Git, private readonly log: vscode.LogOutputChannel) { }

	async create(repoRoot: string, worktreePath: string, branch: string, startPoint: string): Promise<void> {
		type Result = { kind: 'created'; copyFailures: readonly string[]; hookFailure?: string } | { kind: 'error'; code: string; message: string };
		let result: Result | undefined;
		try {
			result = await vscode.commands.executeCommand<Result>('_git.createWorktreeAt', vscode.Uri.file(repoRoot), vscode.Uri.file(worktreePath), branch, startPoint);
		} catch (err) {
			// The git extension is off: git itself still makes the worktree, without the extras.
			this.log.warn(`_git.createWorktreeAt is unavailable (${(err as Error).message}); creating the worktree with git directly.`);
			await this.git.addWorktree(repoRoot, worktreePath, branch, startPoint);
			return;
		}
		if (!result || result.kind !== 'created') {
			throw new Error(result ? result.message : 'the git extension did not create the worktree');
		}
		for (const failure of [...result.copyFailures, ...(result.hookFailure ? [result.hookFailure] : [])]) {
			this.log.warn(`${worktreePath}: ${failure}`);
		}
	}
}

/**
 * Whether an agent may be started with its trust flag in the folders Facade gives it. The person
 * decides once per agent; the answer is kept. Asks at most once at a time per agent.
 */
export class StoredTrustDecisions implements TrustDecisions {

	private readonly asking = new Map<string, Promise<boolean>>();

	constructor(private readonly state: vscode.Memento) { }

	decide(agentId: string, displayName: string, detail: string): Promise<boolean> {
		const stored = this.state.get<Record<string, boolean>>(TRUST_KEY, {})[agentId];
		if (stored !== undefined) {
			return Promise.resolve(stored);
		}
		let pending = this.asking.get(agentId);
		if (!pending) {
			pending = this.ask(agentId, displayName, detail).finally(() => this.asking.delete(agentId));
			this.asking.set(agentId, pending);
		}
		return pending;
	}

	private async ask(agentId: string, displayName: string, detail: string): Promise<boolean> {
		const allow = vscode.l10n.t("Allow");
		const deny = vscode.l10n.t("Don't Allow");
		const choice = await vscode.window.showWarningMessage(vscode.l10n.t("Let Facade start {0} trusting the folders it gives it?", displayName), { modal: true, detail: `${detail}\n\n${vscode.l10n.t("Without it, {0} does not get Facade's tools there.", displayName)}` }, allow, deny);
		if (choice === undefined) {
			// Dismissed: ask again next time.
			return false;
		}
		const decisions = this.state.get<Record<string, boolean>>(TRUST_KEY, {});
		await this.state.update(TRUST_KEY, { ...decisions, [agentId]: choice === allow });
		return choice === allow;
	}
}

/** The git the git extension found, so both run the same one. */
export async function gitPath(): Promise<string> {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): { git: { path: string } } }>('vscode.git');
	try {
		const api = (extension?.isActive ? extension.exports : await extension?.activate())?.getAPI(1);
		return api?.git.path ?? 'git';
	} catch {
		return 'git';
	}
}
