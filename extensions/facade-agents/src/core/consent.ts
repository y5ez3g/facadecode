/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { isJsonObject } from '../base/json';
import { AgentCli, fullAccessQuestion } from '../clis/cli';
import { Person } from './ports';

/** The person's answers to "Let Facade start ... with full access?", by CLI. */
const FULL_ACCESS_ANSWERS_KEY = 'facade.agents.fullAccessAnswers';

/** Where the person's answers are kept for every window: the window's global state. */
export interface AnswerStore {
	get(key: string): unknown;
	update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * The person's leave to start a CLI at full access, the only way Facade starts agents, and to give it
 * their trust in the worktrees Facade makes: asked in a modal dialog that says what that means for the
 * CLI, at most once at a time per CLI, and kept for every window. An Allow stands for good. A Don't
 * Allow stands for agents' spawns, which would otherwise ask the person again and again; the person
 * starting an agent of that CLI themselves is asked again, which is how they take it back. A dialog
 * dismissed keeps nothing.
 */
export class Consent {

	/** The questions on screen, by CLI: a spawn that needs one waits for its answer. */
	private readonly asking = new Map<string, Promise<boolean>>();

	constructor(private readonly answers: AnswerStore, private readonly person: Person) { }

	/** Whether the person lets Facade start `cli` at full access; `byThePerson` when they start the agent themselves. */
	allows(cli: AgentCli, byThePerson: boolean): Promise<boolean> {
		const standing = this.standing(cli.id, byThePerson);
		if (standing !== undefined) {
			return Promise.resolve(standing);
		}
		let asking = this.asking.get(cli.id);
		if (!asking) {
			asking = this.ask(cli);
			this.asking.set(cli.id, asking);
		}
		return asking;
	}

	private async ask(cli: AgentCli): Promise<boolean> {
		try {
			const question = fullAccessQuestion(cli);
			const allowed = await this.person.ask(question.message, question.detail, l10n.t("Allow"), l10n.t("Don't Allow"));
			if (allowed === undefined) {
				return false;
			}
			await this.answers.update(FULL_ACCESS_ANSWERS_KEY, { ...this.kept(), [cli.id]: allowed });
			return allowed;
		} finally {
			this.asking.delete(cli.id);
		}
	}

	/** The answer that stands for `cli`, the person starting the agent or an agent; undefined: ask. */
	private standing(cli: string, byThePerson: boolean): boolean | undefined {
		const kept = this.kept()[cli];
		return kept === false && byThePerson ? undefined : kept;
	}

	/** The answers kept, by CLI: each checked, what is no answer left out. */
	private kept(): { [cli: string]: boolean } {
		const kept = this.answers.get(FULL_ACCESS_ANSWERS_KEY);
		const answers: { [cli: string]: boolean } = {};
		for (const [cli, allowed] of Object.entries(isJsonObject(kept) ? kept : {})) {
			if (typeof allowed === 'boolean') {
				answers[cli] = allowed;
			}
		}
		return answers;
	}
}
