/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Args } from './args';
import type { ContractTool } from './tools';

const PARAMS = ['cli', 'model', 'prompt', 'worktree?', 'name?'];

/**
 * `spawn` (WORKTREE-AGENTS.md, section 5): starts a child of the caller, in its own UI, beside it or
 * in a worktree of its own (WA-3.2).
 */
export const spawnTool: ContractTool = {
	definition: {
		name: 'spawn',
		title: 'Start a child agent',
		description: 'Starts a child agent in its own UI: a CLI on one of its models, with its first message. It runs beside you in your worktree, in a worktree of your repository you name, or in a new one: "new" makes a worktree on a new branch named after the child, starting at your worktree\'s HEAD, so commit what the child needs first. Its name is its worktree\'s unless you give one. It is your child: you and it can message each other, and you can stop it.',
		inputSchema: {
			type: 'object',
			properties: {
				cli: { type: 'string', description: 'The CLI, as claude.' },
				model: { type: 'string', description: 'One of that CLI\'s models, as sonnet.' },
				prompt: { type: 'string', description: 'Its first message: the task.' },
				worktree: { type: 'string', description: 'Omitted: yours. "new": a new one, named after the child. A name: that worktree of your repository.' },
				name: { type: 'string', description: 'Its name, without the @. Required with worktree "new".' }
			},
			required: ['cli', 'model', 'prompt'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('spawn', PARAMS, input);
		const spawned = await facade.spawn(caller, {
			cli: args.text('cli'),
			model: args.text('model'),
			prompt: args.text('prompt'),
			worktree: args.optionalText('worktree'),
			name: args.optionalText('name')
		});
		const where = spawned.madeWorktree ? `the new worktree ${spawned.worktree}` : `the worktree ${spawned.worktree}`;
		return {
			text: `Started @${spawned.name}: ${spawned.cliName} on ${spawned.model}, in ${where} at ${spawned.folder}${spawned.branch ? `, on the branch ${spawned.branch}` : ''}. Its messages reach you by themselves.`,
			data: spawned
		};
	}
};
