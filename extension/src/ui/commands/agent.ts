/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FacadeError, invalid } from '../../core/errors';
import { labelOf, normalizeName } from '../../core/names';
import type { Agents, ExecutionPort, HumanPort, RunId } from '../../core/ports';
import { referenceOf } from '../../core/reach';
import { COMMANDS } from '../catalog';
import { PanelModel } from '../model';
import { reasonOf } from '../presentation';
import { BACK, Flow } from '../pickers/stepping';

export interface AgentCommandDeps {
	readonly agents: Agents;
	readonly model: PanelModel;
	readonly execution: Pick<ExecutionPort, 'reveal' | 'tabOpen'>;
	readonly notifyError: HumanPort['error'];
}

/**
 * The run a command is about (UX-3.1, 3.2): the one named by `{run_id}` - a card's menu gives it - or, given nothing, the selected
 * run where the command is in the Command Palette (`palette`); a context-only command never substitutes it. Undefined where that run is not this window's now: a stale target does nothing.
 * Anything else is refused, never guessed at.
 */
export function targetOf(arg: unknown, model: Pick<PanelModel, 'selectedAgent'>, agents: Pick<Agents, 'get'>, palette: boolean): RunId | undefined {
	if (arg === undefined) {
		return palette ? model.selectedAgent()?.run : undefined;
	}
	const given = arg as { run_id?: unknown } | null;
	if (!given || typeof given !== 'object' || typeof given.run_id !== 'string') {
		throw invalid('invalid_argument', 'Expected { "run_id": "<run ID>" }.');
	}
	return agents.get(given.run_id) ? given.run_id : undefined;
}

/** The person's actions on one agent, shared by its card, the Command Palette and Go to Agent. */
export class AgentActions {
	constructor(private readonly deps: AgentCommandDeps) { }

	/** Shows the run's own terminal - a retained red one's too - and selects its card (PANEL-2.1, LIFECYCLE-2.2). */
	async reveal(run: RunId): Promise<boolean> {
		if (!this.deps.agents.get(run)) {
			return false;
		}
		this.deps.model.select(run);
		return this.deps.execution.reveal(run, { preserveFocus: false });
	}

	/**
	 * Pins or Unpins `run`, as the person asked - from its card, the Command Palette or a key: their attention to that agent. Saved, its
	 * tab is shown as a click on the card shows it, with the focus, and its mark goes on there; a Pin opens it where it has none open,
	 * while an Unpin leaves a hidden one hidden, and one not saved shows nothing (LIFECYCLE-3.4).
	 */
	pin(run: RunId, pinned: boolean): void {
		const facts = this.deps.agents.get(run);
		if (!facts) { return; }
		try {
			if (pinned) { this.deps.agents.pin(run); } else { this.deps.agents.unpin(run); }
			// Shown where it opens or is open now: a tab not open - hidden, or a pinned agent's before its turn - stays so on an Unpin
			if (pinned || this.deps.execution.tabOpen(run)) {
				this.deps.model.select(run);
				void this.deps.execution.reveal(run, { preserveFocus: false });
			}
		} catch (err) {
			// Closed meanwhile: nothing is left to pin, and no run's ID is said
			if (!(err instanceof FacadeError && err.code === 'NOT_FOUND')) {
				this.deps.notifyError(pinned ? vscode.l10n.t("Could not pin {0}: {1}", labelOf(facts), reasonOf(err))
					: vscode.l10n.t("Could not unpin {0}: {1}", labelOf(facts), reasonOf(err)), {});
			}
		}
	}

	/** Copies `@name #aN`, with no toast: Go to Agent's item button (LIFECYCLE-2.1). */
	async copyReference(run: RunId): Promise<void> {
		const facts = this.deps.agents.get(run);
		if (facts) {
			await vscode.env.clipboard.writeText(referenceOf(facts));
		}
	}

	/**
	 * End Agent (LIFECYCLE-3.1): its card and terminal go at once and its process ends in the background. An actual failure to end it
	 * goes to the person who asked; an unreachable process is not said to have ended.
	 */
	async close(run: RunId): Promise<void> {
		const facts = this.deps.agents.get(run);
		if (!facts) {
			return;
		}
		try {
			if (await this.deps.agents.close(run) === 'failed') {
				this.deps.notifyError(vscode.l10n.t("{0}'s card and terminal were closed, but its process could not be terminated.", labelOf(facts)), {});
			}
		} catch (err) {
			if (!(err instanceof FacadeError && err.code === 'NOT_FOUND')) {
				this.deps.notifyError(vscode.l10n.t("Could not end {0}: {1}", labelOf(facts), reasonOf(err)), {});
			}
		}
	}

	/** Rename Agent (LIFECYCLE-2.1): the editor's own input box for the label; the run keeps its every identity. */
	async rename(run: RunId): Promise<void> {
		const facts = this.deps.agents.get(run);
		if (!facts) {
			return;
		}
		const flow = new Flow();
		const typed = await flow.text({ title: vscode.l10n.t("Rename Agent"), value: facts.name, placeholder: vscode.l10n.t("Leave blank for an unused name, or its ID"), prompt: vscode.l10n.t("Rename {0}", referenceOf(facts)) });
		flow.close();
		if (typed === undefined || typed === BACK) {
			return;
		}
		const name = normalizeName(typed);
		if (name === facts.name) {
			return;
		}
		try {
			this.deps.agents.rename(run, name);
		} catch (err) {
			// Closed while its name was being typed: nothing is left to rename
			if (!(err instanceof FacadeError && err.code === 'NOT_FOUND')) {
				this.deps.notifyError(vscode.l10n.t("Could not rename {0}: {1}", labelOf(facts), reasonOf(err)), {});
			}
		}
	}
}

/**
 * The commands about one agent (UX-3.1, 3.2): Go to Agent, Pin and Unpin, Rename, End Agent, and the card's menu - Move Up and
 * Move Down among them (PANEL-2.2).
 */
export function registerAgentCommands(deps: AgentCommandDeps, actions: AgentActions, flows: { readonly goToAgent: () => Promise<void> }): vscode.Disposable[] {
	const { model, agents } = deps;
	/** A command about one run: `palette` where the Command Palette offers it for the selected run. */
	const on = (id: string, palette: boolean, does: (run: RunId) => unknown) => vscode.commands.registerCommand(id, (arg?: unknown) => {
		const run = targetOf(arg, model, agents, palette);
		return run === undefined ? undefined : does(run);
	});
	return [
		vscode.commands.registerCommand(COMMANDS.showActiveAgents, () => flows.goToAgent()),
		on(COMMANDS.pinAgent, true, run => actions.pin(run, true)),
		on(COMMANDS.unpinAgent, true, run => actions.pin(run, false)),
		on(COMMANDS.renameAgent, true, run => actions.rename(run)),
		on(COMMANDS.closeAgent, true, run => actions.close(run)),
		// Notification navigation: the exact run it names, never another (UX-3.2)
		vscode.commands.registerCommand(COMMANDS.revealAgent, (arg?: unknown) => {
			if (arg === undefined) {
				throw invalid('missing_argument', 'Expected { "run_id": "<run ID>" }.');
			}
			const run = targetOf(arg, model, agents, false);
			return run === undefined ? false : actions.reveal(run);
		}),
		on(COMMANDS.moveUp, false, run => model.move(run, -1)),
		on(COMMANDS.moveDown, false, run => model.move(run, 1))
	];
}
