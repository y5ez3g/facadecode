/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Args } from './args';
import type { ContractTool } from './tools';

/** `kill`: ends one of the caller's children, by its number or its name. */
export const killTool: ContractTool = {
	definition: {
		name: 'kill',
		title: 'End a child agent',
		description: 'Ends one of your children, by its number or its @name: its CLI ends and its terminal closes. Its worktree stays as it is. Its own children run on, and are the person\'s from then on.',
		inputSchema: {
			type: 'object',
			properties: {
				agent: { type: 'string', description: 'One of your children: its number, as #a7, or its name, as @name, where only one running agent has it.' }
			},
			required: ['agent'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('kill', ['agent'], input);
		const killed = await facade.kill(caller, args.text('agent'));
		return {
			text: killed.alreadyExited
				? `@${killed.name} #a${killed.id} had exited already (${killed.exit.kind}: ${killed.exit.reason}).`
				: `Killed @${killed.name} #a${killed.id}: its terminal closed. Its worktree stays as it is.`,
			data: killed
		};
	}
};
