/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Person } from '../core/ports';
import { HostTerminals } from './terminals';

/** The person's answers to "Let Facade start ... trusting the worktrees it makes for it?", by CLI. */
const FIRST_RUN_ANSWERS_KEY = 'facade.agents.firstRunAnswers';
/** How much of a message's first line a notification shows. */
const SHOWN_CHARS = 200;

/**
 * The core's Person port: messages for the person as notifications, from which they go to the agent's
 * terminal to answer (WORKTREE-AGENTS.md, WA-6.10), and the question whether Facade may answer a CLI's
 * first-run questions for them, asked once per CLI and kept for every window (section 8).
 */
export class HostPerson implements Person {

	private readonly asking = new Map<string, Promise<boolean>>();

	constructor(private readonly answers: vscode.Memento, private readonly terminals: HostTerminals) { }

	notify(from: string, text: string, terminal: string | undefined): void {
		void this.show(from, text, terminal);
	}

	allowsFirstRunAnswers(cli: { readonly id: string; readonly displayName: string }): Promise<boolean> {
		const answered = this.answers.get<Record<string, boolean>>(FIRST_RUN_ANSWERS_KEY, {})[cli.id];
		if (answered !== undefined) {
			return Promise.resolve(answered);
		}
		let asking = this.asking.get(cli.id);
		if (!asking) {
			asking = this.ask(cli);
			this.asking.set(cli.id, asking);
		}
		return asking;
	}

	private async show(from: string, text: string, terminal: string | undefined): Promise<void> {
		const firstLine = text.split('\n')[0];
		const shown = firstLine.length > SHOWN_CHARS ? `${firstLine.slice(0, SHOWN_CHARS)}...` : firstLine;
		const showTerminal = vscode.l10n.t("Show Terminal");
		const choice = await vscode.window.showInformationMessage(
			from === 'facade' ? vscode.l10n.t("Facade: {0}", shown) : vscode.l10n.t("@{0}: {1}", from, shown),
			...(terminal ? [showTerminal] : []));
		if (choice === showTerminal && terminal) {
			await this.terminals.reveal(terminal);
		}
	}

	private async ask(cli: { readonly id: string; readonly displayName: string }): Promise<boolean> {
		try {
			const allow = vscode.l10n.t("Allow");
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t("Let Facade start {0} trusting the worktrees it makes for it?", cli.displayName),
				{ modal: true, detail: vscode.l10n.t("{0} asks, in its terminal, whether you trust each folder it starts in. Facade answers yes for you in the worktrees it makes for agents, and nowhere else. {0} remembers each answer.", cli.displayName) },
				allow,
				vscode.l10n.t("Don't Allow"));
			// Dismissed: asked again next time.
			if (choice === undefined) {
				return false;
			}
			const allowed = choice === allow;
			await this.answers.update(FIRST_RUN_ANSWERS_KEY, { ...this.answers.get<Record<string, boolean>>(FIRST_RUN_ANSWERS_KEY, {}), [cli.id]: allowed });
			return allowed;
		} finally {
			this.asking.delete(cli.id);
		}
	}
}
