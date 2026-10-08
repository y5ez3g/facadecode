/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe } from '../record/events';
import { Args } from './args';
import { factsText } from './listAgents';
import type { ContractTool } from './tools';

const PARAMS = ['name', 'cli', 'model?', 'effort?', 'task?', 'folder?', 'new_worktree?'];

/**
 * `start_agent` (AGENT-ORCHESTRATION.md, O3): starts an agent in its own UI, in any folder of the window
 * or a new worktree. It answers with the agent's number once it has started, or that its start is not
 * confirmed.
 */
export const startAgentTool: ContractTool = {
	definition: {
		name: 'start_agent',
		title: 'Start an agent',
		description: 'Starts an agent called name in its own terminal: a CLI, on the model and effort you give or else its own, with a task if you give one - the task is kept as a message, and the agent is told where it is. It works in your folder; in another folder of this window, by its absolute path; in a worktree of your repository, by the branch checked out in it; or, with new_worktree, in a new worktree of that folder\'s repository, on a new branch called name - starting at your commit in your own repository, so commit what it needs first, and at the main checkout\'s in another. Its YOLO is yours. It answers once the agent has started, with its number, as #a7; if it has not within the timeout, it answers that its start is not confirmed, and why: it stays starting, and list_agents and stop_agent take it. A start can take a minute: do not call start_agent again just to wait. Facade gives the model and the effort to the CLI as they are, and no CLI checks them as it starts.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Its name, without the @: a label of lower-case letters, digits, dots, dashes and underscores, which other agents may have too. With new_worktree, its branch.' },
				cli: { type: 'string', description: 'The CLI, by its id, or a custom agent, by its name.' },
				model: { type: 'string', description: 'The model, as that CLI\'s --model option takes it. Omitted: the CLI\'s own default.' },
				effort: { type: 'string', description: 'How hard it thinks, as that CLI takes it: low, medium, high and so on. Omitted: the CLI\'s own default.' },
				task: { type: 'string', description: 'Its task. Omitted: none, and it waits at its CLI\'s own prompt.' },
				folder: { type: 'string', description: 'Where it works: a folder of this window, by its absolute path, or a worktree of your repository, by the branch checked out in it. Omitted: your folder.' },
				new_worktree: { type: 'boolean', description: 'true: a new worktree of that folder\'s repository, on a new branch called name.' }
			},
			required: ['name', 'cli'],
			additionalProperties: false
		}
	},
	/** Its definition with the agents this machine can start. */
	describe(facade) {
		const startable = facade.startable();
		return {
			...this.definition,
			inputSchema: {
				...this.definition.inputSchema,
				properties: {
					...this.definition.inputSchema.properties,
					cli: { type: 'string', enum: startable.map(each => each.id), description: `The CLI, or a custom agent: ${startable.map(each => each.custom ? `${each.id} (custom)` : `${each.id} (${each.displayName})`).join(', ') || 'none on this machine'}.` }
				}
			}
		};
	},
	async call(facade, caller, input, progress) {
		const args = new Args('start_agent', PARAMS, input);
		const name = args.text('name');
		const cli = args.text('cli');
		const model = args.optionalText('model');
		const effort = args.optionalText('effort');
		const task = args.optionalText('task');
		const folder = args.optionalText('folder');
		const newWorktree = args.boolean('new_worktree');
		const started = await facade.startAgent(caller, {
			name,
			cli,
			...(model !== undefined ? { model } : {}),
			...(effort !== undefined ? { effort } : {}),
			...(task !== undefined ? { task } : {}),
			...(folder !== undefined ? { folder } : {}),
			...(newWorktree !== undefined ? { newWorktree } : {})
		}, progress);
		const ignored = started.ignored.length ? ` The ${started.ignored.join(' and ')} you gave ${started.ignored.length === 1 ? 'was' : 'were'} not used: ${started.cli}'s launch has no group for ${started.ignored.length === 1 ? 'it' : 'them'}, so its own applies.` : '';
		const where = started.newWorktree ? `the new worktree ${started.worktree} (a new branch)` : `the worktree ${started.worktree}`;
		return {
			text: started.status === 'started'
				? `Started ${describe(started)} in ${where}: ${factsText(facade, started)}.${ignored}`
				: `${describe(started)} is not confirmed to have started: ${started.why}. It stays starting - ${factsText(facade, started)} - and may start yet: look at it with list_agents, or stop it with stop_agent; do not start it again.${ignored}`,
			data: started
		};
	}
};
