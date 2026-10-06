/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Args } from './args';
import { MODELS_NAMED, orList } from './prompts';
import type { ContractTool } from './tools';

const PARAMS = ['cli', 'model', 'prompt', 'worktree?', 'name?'];

/**
 * `spawn`: starts a child of the caller in its own UI, beside it or in a worktree, as fork and exec
 * start a process. It answers with the child's PID once the child is up.
 */
export const spawnTool: ContractTool = {
	definition: {
		name: 'spawn',
		title: 'Start a child agent',
		description: 'Starts a child agent in its own UI, as a new process: a CLI on one of its models, with its task. It works beside you, in your folder; in a worktree of your repository, by name; or, with worktree "new" and a name, in a new worktree on a new branch of that name, starting at your worktree\'s HEAD - commit what the child needs first. It answers once the child is up, with its PID. The child is yours: ps lists it, and kill ends it. The first start of a CLI can wait for the person to allow it, and a child can take a minute or two to come up: a slow spawn is waiting, so do not call it again.',
		inputSchema: {
			type: 'object',
			properties: {
				cli: { type: 'string', description: 'The CLI, by its id.' },
				model: { type: 'string', description: 'One of that CLI\'s models.' },
				prompt: { type: 'string', description: 'Its task.' },
				worktree: { type: 'string', description: 'Omitted: your folder. "new": a new worktree on the branch name. A name: that worktree of your repository.' },
				name: { type: 'string', description: 'Its name, without the @: a label, which other agents may have too. Required with worktree "new"; else your worktree\'s name.' }
			},
			required: ['cli', 'model', 'prompt'],
			additionalProperties: false
		}
	},
	/** Its definition with the CLIs this machine has, and their first models. */
	describe(facade) {
		const clis = facade.clis().map(each => each.cli);
		return {
			...this.definition,
			inputSchema: {
				...this.definition.inputSchema,
				properties: {
					...this.definition.inputSchema.properties,
					cli: { type: 'string', enum: clis.map(cli => cli.id), description: `The CLI: ${clis.map(cli => `${cli.id} (${cli.displayName})`).join(', ')}.` },
					model: { type: 'string', description: `One of that CLI's models, as ${clis.map(cli => `${orList(cli.models.slice(0, MODELS_NAMED))} for ${cli.id}`).join('; ')}.` }
				}
			}
		};
	},
	async call(facade, caller, input, progress) {
		const args = new Args('spawn', PARAMS, input);
		const spawned = await facade.spawn(caller, {
			cli: args.text('cli'),
			model: args.text('model'),
			prompt: args.text('prompt'),
			worktree: args.optionalText('worktree'),
			name: args.optionalText('name')
		}, progress);
		const where = spawned.newWorktree ? `the new worktree ${spawned.worktree}, on the new branch ${spawned.worktree},` : `the worktree ${spawned.worktree}`;
		return {
			text: `Started @${spawned.name}, PID ${spawned.pid}: ${facade.cliName(spawned.cli)} on ${spawned.model}, in ${where} at ${spawned.folder}. It is up and has its task.`,
			data: spawned
		};
	}
};
