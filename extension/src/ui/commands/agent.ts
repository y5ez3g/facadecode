/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { invalid } from '../../core/errors';
import { labelOf, normalizeName } from '../../core/names';
import type { Agents, HumanPort, RunFacts, RunId } from '../../core/ports';
import { isAgentRunning } from '../cardView';
import { COMMANDS } from '../catalog';
import { PanelModel } from '../model';
import { reasonOf } from '../presentation';
import { BACK, Flow } from '../pickers/stepping';

export interface FrameworkCardActions {
	open(run: RunId): Promise<boolean>;
	stop(run: RunId): Promise<void>;
	remove(run: RunId): Promise<void>;
	setPinned(run: RunId, pinned: boolean): Promise<void>;
	rename(run: RunId, name: string): Promise<void>;
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

async function askName(facts: RunFacts, copy: { readonly placeholder: string; readonly prompt?: string }): Promise<string | undefined> {
	const flow = new Flow();
	const typed = await flow.text({ title: vscode.l10n.t("Rename Agent"), value: facts.name, ...copy });
	flow.close();
	const name = typed === undefined || typed === BACK ? undefined : normalizeName(typed);
	return name === facts.name ? undefined : name;
}

/** The workspace card's actions use its current run and the parent's Orchestrator callbacks (PANEL-4.2). */
export function registerFrameworkAgentCommands(deps: {
	readonly model: PanelModel;
	readonly notifyError: HumanPort['error'];
	readonly agents: Pick<Agents, 'get'>;
	readonly actions: FrameworkCardActions;
	readonly stopAgent: () => Promise<void>;
}): vscode.Disposable[] {
	const { agents, model, actions } = deps;
	type Failure = (name: string, reason: string) => string;
	const openFailure: Failure = (name, reason) => vscode.l10n.t("Could not open {0}: {1}", name, reason);
	const on = (id: string, does: (facts: RunFacts) => unknown, failure?: Failure, palette = true, pick?: () => Promise<void>) =>
		vscode.commands.registerCommand(id, async (arg?: unknown) => {
			if (arg === undefined && pick) { return pick(); }
			const run = targetOf(arg, model, agents, palette);
			const facts = run === undefined ? undefined : agents.get(run);
			if (!facts) { return undefined; }
			try {
				return await does(facts);
			} catch (err) {
				const reason = reasonOf(err);
				deps.notifyError(failure ? failure(labelOf(facts), reason) : reason, {});
				return undefined;
			}
		});
	const open = async (facts: RunFacts): Promise<boolean> => isAgentRunning(facts) && await actions.open(facts.id);
	return [
		on(COMMANDS.openTerminal, open, openFailure),
		on(COMMANDS.stopAgent, async facts => {
			if (isAgentRunning(facts)) { await actions.stop(facts.id); }
		}, (name, reason) => vscode.l10n.t("Could not stop {0}: {1}", name, reason), false, deps.stopAgent),
		on(COMMANDS.deleteAgent, facts => actions.remove(facts.id), (name, reason) => vscode.l10n.t("Could not remove {0}: {1}", name, reason)),
		on(COMMANDS.moveUp, facts => model.move(facts.id, -1), undefined, false),
		on(COMMANDS.moveDown, facts => model.move(facts.id, 1), undefined, false),
		on(COMMANDS.pinAgent, async facts => {
			if (facts.pinnable && !facts.pin) { await actions.setPinned(facts.id, true); }
		}, (name, reason) => vscode.l10n.t("Could not pin {0}: {1}", name, reason)),
		on(COMMANDS.unpinAgent, async facts => {
			if (facts.pin) { await actions.setPinned(facts.id, false); }
		}, (name, reason) => vscode.l10n.t("Could not unpin {0}: {1}", name, reason)),
		on(COMMANDS.renameAgent, async facts => {
			const name = await askName(facts, {
				placeholder: vscode.l10n.t("Leave blank to choose a name automatically"),
				...(facts.address ? { prompt: vscode.l10n.t("Rename {0}", facts.address) } : {})
			});
			if (name !== undefined && agents.get(facts.id)) { await actions.rename(facts.id, name); }
		}, (name, reason) => vscode.l10n.t("Could not rename {0}: {1}", name, reason)),
		on(COMMANDS.copyAgentReference, async facts => {
			if (facts.address) { await vscode.env.clipboard.writeText(facts.address); }
		}),
		// Navigation from an error names its run explicitly (UX-3.2).
		on(COMMANDS.revealAgent, open, openFailure, false)
	];
}
