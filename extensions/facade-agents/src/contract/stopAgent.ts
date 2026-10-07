/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe } from '../record/events';
import { Args } from './args';
import type { ContractTool } from './tools';

/** `stop_agent`: stops one of the caller's children, by its number or its name. */
export const stopAgentTool: ContractTool = {
	definition: {
		name: 'stop_agent',
		title: 'Stop a child agent',
		description: 'Stops one of your children, by its number or its @name: its CLI ends and its terminal closes. Its worktree stays as it is. Its own children run on, and are @human\'s from then on.',
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
		const args = new Args('stop_agent', ['agent'], input);
		const stopped = await facade.stopAgent(caller, args.text('agent'));
		return {
			text: stopped.alreadyExited
				? `${describe(stopped)} had exited already (${stopped.exit.kind}: ${stopped.exit.reason}).`
				: `Stopped ${describe(stopped)}: its terminal closed. Its worktree stays as it is.`,
			data: stopped
		};
	}
};
