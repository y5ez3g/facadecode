/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe } from '../record/events';
import { Args } from './args';
import type { ContractTool } from './tools';

const PARAMS = ['cli', 'model', 'effort', 'task', 'worktree?', 'name?'];

/**
 * `start_agent`: starts a child of the caller in its own UI, beside it or in a worktree. It answers with
 * the child's number once the child is up.
 */
export const startAgentTool: ContractTool = {
	definition: {
		name: 'start_agent',
		title: 'Start a child agent',
		description: 'Starts a child agent in its own UI: a CLI on one of its models, thinking as hard as you say, with its task. It works beside you, in your folder; in a worktree of your repository, by name; or, with worktree "new" and a name, in a new worktree on a new branch of that name, starting at your worktree\'s HEAD - commit what the child needs first. It answers once the child is up, with its number, as #a7. The child is yours: list_agents lists it, and stop_agent stops it. Facade gives the model and the effort to the CLI as they are, and no CLI checks them as it starts: a child given a model its CLI does not have comes up all the same, then fails at its first step, on its screen, or works on the CLI\'s own default model. A child can take a minute or two to come up: a slow start_agent is waiting, so do not call it again.',
		inputSchema: {
			type: 'object',
			properties: {
				cli: { type: 'string', description: 'The CLI, by its id.' },
				model: { type: 'string', description: 'The model, as that CLI\'s --model option takes it.' },
				effort: { type: 'string', description: 'How hard it thinks, as that CLI takes it: low, medium, high and so on. The levels differ from CLI to CLI, and from model to model.' },
				task: { type: 'string', description: 'Its task.' },
				worktree: { type: 'string', description: 'Omitted: your folder. "new": a new worktree on the branch name. A name: that worktree of your repository.' },
				name: { type: 'string', description: 'Its name, without the @: a label, which other agents may have too. Required with worktree "new"; else your worktree\'s name.' }
			},
			required: ['cli', 'model', 'effort', 'task'],
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
			cli: args.text('cli'),
			model: args.text('model'),
			effort: args.text('effort'),
			task: args.text('task'),
			worktree: args.optionalText('worktree'),
			name: args.optionalText('name')
		}, progress);
		const where = started.newWorktree ? `the new worktree ${started.worktree}, on the new branch ${started.worktree},` : `the worktree ${started.worktree}`;
		return {
			text: `Started ${describe(started)}: ${facade.cliName(started.cli)} on ${started.model} at ${started.effort}, in ${where} at ${started.folder}. It is up and has its task.`,
			data: started
		};
	}
};
