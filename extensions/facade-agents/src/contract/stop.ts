/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Args } from './args';
import type { ContractTool } from './tools';

/** `stop` (WORKTREE-AGENTS.md, section 5): ends one of the caller's children (WA-4.6). */
export const stopTool: ContractTool = {
	definition: {
		name: 'stop',
		title: 'Stop a child agent',
		description: 'Stops one of your children: its CLI ends and its terminal closes. Its worktree stays as it is.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'One of your children, as @name.' }
			},
			required: ['name'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('stop', ['name'], input);
		const stopped = await facade.stop(caller, args.text('name'));
		return { text: `Stopped @${stopped.name}. Its worktree ${stopped.worktree} stays as it is.`, data: stopped };
	}
};
