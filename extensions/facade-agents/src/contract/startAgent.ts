/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe } from '../record/events';
import { Args } from './args';
import type { ContractTool } from './tools';

const PARAMS = ['name', 'cli', 'model', 'effort', 'task?', 'folder?', 'new_worktree?'];

/**
 * `start_agent`: starts a child of the caller in its own UI, in any folder of the window or a new worktree.
 * It answers with the child's number once the child has started, or that its start is not confirmed.
 */
export const startAgentTool: ContractTool = {
	definition: {
		name: 'start_agent',
		title: 'Start a child agent',
		description: 'Starts a child agent called name in its own UI: a CLI on one of its models, thinking as hard as you say, with a task if you give it one. It works in your folder; in another folder of this window, by its absolute path; in a worktree of your repository, by the branch checked out in it; or, with new_worktree, in a new worktree of that folder\'s repository, on a new branch called name - starting at your commit in your own repository, so commit what the child needs first, and at the main checkout\'s in another. It answers once the child has started, with its number, as #a7; if it has not within the timeout, it answers that its start is not confirmed, and why - it stays starting, and list_agents and stop_agent take it. Facade gives the model and the effort to the CLI as they are, and no CLI checks them as it starts: a child given a model its CLI does not have starts all the same, then fails at its first step, on its screen, or works on the CLI\'s own default model. A child can take a minute to start: a slow start_agent is waiting, so do not call it again.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Its name, without the @: a label of lower-case letters, digits, dots, dashes and underscores, which other agents may have too. With new_worktree, its branch.' },
				cli: { type: 'string', description: 'The CLI, by its id.' },
				model: { type: 'string', description: 'The model, as that CLI\'s --model option takes it.' },
				effort: { type: 'string', description: 'How hard it thinks, as that CLI takes it: low, medium, high and so on. The levels differ from CLI to CLI, and from model to model.' },
				task: { type: 'string', description: 'Its task. Omitted: none, and it waits at its CLI\'s own prompt.' },
				folder: { type: 'string', description: 'Where it works: a folder of this window, by its absolute path, or a worktree of your repository, by the branch checked out in it. Omitted: your folder.' },
				new_worktree: { type: 'boolean', description: 'true: a new worktree of that folder\'s repository, on a new branch called name.' }
			},
			required: ['name', 'cli', 'model', 'effort'],
			additionalProperties: false
		}
	},
	/** Its definition with the CLIs this machine has. */
	describe(facade) {
		const installed = facade.clis();
		return {
			...this.definition,
			inputSchema: {
				...this.definition.inputSchema,
				properties: {
					...this.definition.inputSchema.properties,
					cli: { type: 'string', enum: installed.map(each => each.cli.id), description: `The CLI: ${installed.map(each => `${each.cli.id} (${each.cli.displayName})`).join(', ')}.` }
				}
			}
		};
	},
	async call(facade, caller, input, progress) {
		const args = new Args('start_agent', PARAMS, input);
		const started = await facade.startAgent(caller, {
			name: args.text('name'),
			cli: args.text('cli'),
			model: args.text('model'),
			effort: args.text('effort'),
			task: args.optionalText('task'),
			folder: args.optionalText('folder'),
			newWorktree: args.boolean('new_worktree')
		}, progress);
		const where = started.newWorktree ? `the new worktree ${started.worktree}, on the new branch ${started.worktree},` : `the worktree ${started.worktree}`;
		const what = `${facade.cliName(started.cli)} on ${started.model} at ${started.effort}, in ${where} at ${started.folder}`;
		return {
			text: started.status === 'started'
				? `Started ${describe(started)}: ${what}. ${started.task === 'none' ? 'It has no task, and waits at its own prompt.' : 'It has started, and has its task.'}`
				: `${describe(started)} is not confirmed to have started: ${started.why}. It stays starting - ${what} - and list_agents shows it, and stop_agent stops it.`,
			data: started
		};
	}
};
