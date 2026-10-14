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
 * A send as the model reads it: what went to whom; that none is fetched yet, and that a reply comes to
 * the caller's mailbox; and where something holds a message up - a recipient still starting, one that
 * cannot reply - or the person has it.
 */
function sentText(sent: readonly SentMessage[]): string {
	const toAgents = sent.filter(message => !message.toPerson);
	const unfetched = toAgents.length === sent.length
		? (toAgents.length === 1 ? 'It has' : 'They have')
		: `${toAgents.map(message => `#m${message.id}`).join(', ')} ${toAgents.length === 1 ? 'has' : 'have'}`;
	const lines = [`Sent ${sent.map(message => `#m${message.id} to ${message.to}`).join(', ')}.${toAgents.length ? ` ${unfetched} not been fetched yet.` : ''}`];
	for (const message of toAgents) {
		if (message.starting) {
			lines.push(`${message.to} is still starting: its doorbell rings once it runs.`);
		}
		if (message.reconnecting) {
			lines.push(`${message.to} is not connected to Facade now: its doorbell rings once it connects again.`);
		}
		if (message.cannotReply) {
			lines.push(`${message.to} has its YOLO off, and you are not in its tree: it can reply to the person only, not to you.`);
		}
	}
	for (const message of sent.filter(each => each.toPerson)) {
		lines.push(`The person is told of #m${message.id}, and the chat room keeps it: whether they read it, Facade cannot tell. They answer by typing in your terminal.`);
	}
	if (toAgents.length) {
		lines.push('A reply will notify you through your mailbox.');
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
		description: `Sends a message to agents of this window, or to the person, ${describe(PERSON)}: to an agent with something for it - work, a question, a report, an answer - directly, never through the person. Each recipient gets a message of its own, with its own number, as #m42. It answers at once, once the messages are recorded: a reply comes to your mailbox and rings your doorbell, a line typed into your terminal, so do not wait or poll for one - end your turn. ${listAgentsTool.definition.name} shows whether a recipient has fetched its message. With your YOLO off, you reach the agents of your own tree only, and the person. Something for the person: print it whole on your screen first, then send it to ${describe(PERSON)}.`,
		inputSchema: {
			type: 'object',
			properties: {
				to: { type: 'array', items: { type: 'string' }, description: `The recipients: agents, each by its number as #a7, its @name, or as @name #a7; or the person, ${describe(PERSON)}. One alone is a list of one.` },
				text: { type: 'string', description: 'What the message says: plain text. Texts over 8,000 characters reach the recipient in a file; a call carries a megabyte at most: give a bigger body, or a file, by its path.' },
				reply_to: { type: 'string', description: 'The message this one answers, by its number, as #m40: one sent to you.' }
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
