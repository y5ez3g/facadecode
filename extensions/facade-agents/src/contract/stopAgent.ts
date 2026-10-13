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
		description: 'Stops one agent you reach - one you started, another of your tree, your creator, yourself, one the person started - by its number or its @name: its CLI ends and its terminal closes. The agents it started run on. With delete_worktree, the other agents in its worktree are stopped too, then the worktree is deleted, its branch kept; if it holds uncommitted or untracked files, or editors with unsaved changes, nothing is stopped or deleted and the answer lists them, unless discard_changes is true. A main checkout is never deleted. No dialog asks anyone: delete_worktree and discard_changes are the decision. Stopping yourself, or deleting the worktree you are in, may end this call before you read its answer.',
		inputSchema: {
			type: 'object',
			properties: {
				agent: { type: 'string', description: 'The agent: its number, as #a7, or its name, as @name, where only one agent that has not ended has it.' },
				delete_worktree: { type: 'boolean', description: 'true: stop every agent in its worktree too, then delete the worktree, keeping its branch.' },
				discard_changes: { type: 'boolean', description: 'With delete_worktree: true loses the worktree\'s uncommitted work; omitted, a worktree with any refuses the call.' }
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
		const ended = stopped.alreadyEnded && stopped.agent.end ? `${describe(stopped.agent)} had ended already (${endText(facade, stopped.agent.end)}).` : '';
		// One whose start was stopped before its CLI had a terminal had none to close: what is true of it is said (O4; OR-05)
		const closed = stopped.startStopped === 'creating_worktree' ? 'its start was stopped as its worktree was being made, before its CLI was launched'
			: stopped.startStopped === 'running_setup' ? 'its start was stopped as its worktree was set up, before its CLI was launched'
				: stopped.stopped.length === 1 ? 'its terminal closed' : 'their terminals closed';
		const others = stopped.stopped.length ? `Stopped ${stopped.stopped.map(each => describe(each)).join(', ')}: ${closed}.` : '';
		const worktree = stopped.worktree === undefined
			// An agent in no Git repository has a folder, not a worktree (N-57)
			? (stopped.alreadyEnded ? '' : stopped.startStopped === 'creating_worktree' ? ' Git may still make its worktree, which would stay, with its branch.' : stopped.agent.outsideGit ? ' Its folder stays as it is.' : ' Its worktree stays as it is.')
			: stopped.worktree.deleted
				? ` ${stopped.worktree.folder} was deleted; its branch stays.`
				: ` ${notDeleted(stopped.worktree.folder, stopped.worktree.why ?? '')}`;
		return { text: `${ended}${ended && others ? ' ' : ''}${others}${worktree}`.trim(), data: stopped };
	}
};
