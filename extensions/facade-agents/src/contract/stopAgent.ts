/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clauseOf } from '../base/errors';
import { describe } from '../record/events';
import { Args } from './args';
import { endText } from './listAgents';
import type { ContractTool } from './tools';

/**
 * `stop_agent` (AGENT-ORCHESTRATION.md, O5): stops one agent the caller reaches, by its number or its
 * name, and with `delete_worktree` the other agents in its worktree and then the worktree.
 */
/**
 * Why a worktree was not deleted, as one sentence. A reason of Facade's is put in one, naming the folder; the
 * window's refusal is a sentence that names it already, in the person's words - wrapped again it read "…
 * was not deleted: ~/… was not deleted: …..", the second full stop the wrapper's (N-52).
 */
function notDeleted(folder: string, why: string): string {
	return / was not deleted: /.test(why) ? `${clauseOf(why)}.` : `${folder} was not deleted: ${clauseOf(why)}.`;
}

export const stopAgentTool: ContractTool = {
	definition: {
		name: 'stop_agent',
		title: 'Stop an agent',
		description: 'Stop a reachable run and close its terminal; children in other folders continue. delete_worktree:true also stops agents in that worktree and deletes the folder, keeping its branch. Uncommitted/untracked work or unsaved editors block deletion before any stop unless discard_changes:true. Main checkouts cannot be deleted. No confirmation dialog opens. Stopping yourself or deleting your worktree may disconnect this call. Inspect uncertain effects before retrying.',
		inputSchema: {
			type: 'object',
			properties: {
				agent: { type: 'string', description: 'Run ID (#a7) or unique active @name. Use IDs for ended runs. @human has no run.' },
				delete_worktree: { type: 'boolean', default: false, description: 'Also stop agents in the target worktree, then delete its folder and keep its branch.' },
				discard_changes: { type: 'boolean', default: false, description: 'With delete_worktree:true, allow discarding uncommitted/untracked work and unsaved edits. Otherwise refuse deletion that would lose work. True requires delete_worktree:true.' }
			},
			required: ['agent'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('stop_agent', ['agent', 'delete_worktree?', 'discard_changes?'], input);
		const agent = args.text('agent');
		const deleteWorktree = args.boolean('delete_worktree') ?? false;
		const discardChanges = args.boolean('discard_changes') ?? false;
		const stopped = await facade.stopAgent(caller, agent, { deleteWorktree, discardChanges });
		const ended = stopped.alreadyEnded && stopped.agent.end ? `${describe(stopped.agent)} had already ended (${endText(facade, stopped.agent.end)}).` : '';
		// One whose start was stopped before its CLI had a terminal had none to close: what is true of it is said (O4; OR-05)
		const closed = stopped.startStopped === 'creating_worktree' ? 'startup was stopped during worktree creation, before the CLI launched'
			: stopped.startStopped === 'running_setup' ? 'startup was stopped during worktree setup, before the CLI launched'
				: stopped.stopped.length === 1 ? 'its terminal closed' : 'their terminals closed';
		const others = stopped.stopped.length ? `Stopped ${stopped.stopped.map(each => describe(each)).join(', ')}: ${closed}.` : '';
		const worktree = stopped.worktree === undefined
			// An agent in no Git repository has a folder, not a worktree (N-57)
			? (stopped.alreadyEnded ? '' : stopped.startStopped === 'creating_worktree' ? ' Git may still finish creating its worktree; the worktree and branch will be kept.' : stopped.agent.outsideGit ? ' Its folder is unchanged.' : ' Its worktree is unchanged.')
			: stopped.worktree.deleted
				? ` ${stopped.worktree.folder} was deleted; its branch was kept.`
				: ` ${notDeleted(stopped.worktree.folder, stopped.worktree.why ?? '')}`;
		return { text: `${ended}${ended && others ? ' ' : ''}${others}${worktree}`.trim(), data: stopped };
	}
};
