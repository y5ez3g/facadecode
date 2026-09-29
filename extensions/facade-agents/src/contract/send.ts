/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Args } from './args';
import type { ContractTool } from './tools';

/**
 * `send` (WORKTREE-AGENTS.md, section 5): a message to the caller's parent or one of its children,
 * which Facade delivers into their session (section 6).
 */
export const sendTool: ContractTool = {
	definition: {
		name: 'send',
		title: 'Send a message',
		description: 'Sends a message to your parent or one of your children, as @name. Facade delivers it into their session, while they work or once their turn ends; their answers reach you the same way.',
		inputSchema: {
			type: 'object',
			properties: {
				to: { type: 'string', description: 'Your parent or one of your children, as @name.' },
				text: { type: 'string', description: 'The message.' }
			},
			required: ['to', 'text'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('send', ['to', 'text'], input);
		const sent = await facade.send(caller, args.text('to'), args.text('text'));
		return {
			text: sent.to === 'you' ? 'Sent to the person, as a notification in the window.' : `Sent to @${sent.to}.`,
			data: sent
		};
	}
};
