/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SentMessage } from '../core/mail';
import { describe, PERSON } from '../record/events';
import { Args } from './args';
import { listAgentsTool } from './listAgents';
import type { ContractTool } from './tools';

/**
 * A send as the model reads it: a line for each message, what went to whom and, to an agent, that it is not
 * fetched yet - with where something holds it up, a recipient still starting or one that cannot reply, or
 * that the person has it - then, where an agent got one, that a reply rings the caller's doorbell.
 */
function sentText(sent: readonly SentMessage[]): string {
	const lines: string[] = [];
	for (const message of sent) {
		if (message.toPerson) {
			lines.push(`Sent #m${message.id} to ${message.to}.`, `${describe(PERSON)} was notified of #m${message.id}; the chat room keeps a copy. Facade does not track whether the person reads it. They can reply in your terminal.`);
			continue;
		}
		lines.push(`Sent #m${message.id} to ${message.to}. Not yet fetched.`);
		if (message.starting) {
			lines.push(`${message.to} is starting; the doorbell waits until the run is ready.`);
		}
		if (message.reconnecting) {
			lines.push(`${message.to} is disconnected from Facade; the doorbell waits for reconnection.`);
		}
		if (message.cannotReply) {
			lines.push(`${message.to} has YOLO off and you are outside its tree. It cannot reply to you; it can contact ${describe(PERSON)}.`);
		}
	}
	if (sent.some(message => !message.toPerson)) {
		lines.push('Agent replies trigger your mailbox doorbell. Continue independent work, or end this turn if you need a reply to proceed. Do not poll or sleep for it.');
	}
	return lines.join('\n');
}

/**
 * `send_message`: a message to agents of the window, or to the person, each its own under its own number.
 * It answers as soon as the messages are recorded: a reply rings the caller's doorbell.
 */
export const sendMessageTool: ContractTool = {
	definition: {
		name: 'send_message',
		title: 'Send a message',
		description: `Send work, questions, answers, or reports to agents or ${describe(PERSON)}. Records a separate message ID per recipient without waiting for replies. Agent replies trigger a doorbell; continue independent work or end this turn if you need a reply. Do not poll or sleep. ${listAgentsTool.definition.name} shows delivery. With YOLO off, recipients must be in your tree or ${describe(PERSON)}. Print the full text before messaging ${describe(PERSON)}. Use terminal tools for CLI menus.`,
		inputSchema: {
			type: 'object',
			properties: {
				to: { type: 'array', items: { type: 'string' }, description: `Recipient or nonempty list: #a7, @name, @name #a7, or ${describe(PERSON)}. Duplicate recipients receive only one message.` },
				text: { type: 'string', description: 'Nonempty plain text, preserved exactly. Message bodies over 8,000 characters use a file. Encoded requests are limited to 1 MiB; share larger content by file path.' },
				reply_to: { type: 'string', description: 'ID of the message being answered, such as #m40. It must be addressed to you.' }
			},
			required: ['to', 'text'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('send_message', ['to', 'text', 'reply_to?'], input);
		const sent = facade.mail.send(caller, args.strings('to'), args.string('text'), args.optionalText('reply_to'));
		return {
			text: sentText(sent),
			data: { messages: sent.map(({ id, to, starting, reconnecting, cannotReply }) => ({ id, to, ...(starting ? { starting } : {}), ...(reconnecting ? { reconnecting } : {}), ...(cannotReply ? { cannotReply } : {}) })) }
		};
	}
};
