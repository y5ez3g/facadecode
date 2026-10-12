/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fetched, headingOf } from '../core/mail';
import { Args } from './args';
import type { ContractTool } from './tools';

/** What every result of `read_messages` ends with: CLIs fold tool results away, and printing is how the person sees a message. */
const PRINT = 'Print the new ones before you act on them, for the person, who watches your screen: one of 500 characters or fewer as it is, with its number and its sender; a longer one as its number, its sender and a sentence or two of what it says.';
/** What a result with a message given before says: the work it asked for may be done, or begun. */
const GIVEN_BEFORE = 'A message given before may have been acted on already: look at the work as it is before you do it again.';

/**
 * A fetch as the model reads it: how many messages, how many new; each one's heading - its number, mark,
 * sender and recipient, time, what it answers, length and whether it was delivered - and its text, or
 * the file that holds all their texts; then the request to print the new ones.
 */
function fetchedText(fetched: Fetched): string {
	const { messages } = fetched;
	if (!messages.length) {
		return fetched.way === 'all' ? 'No message has been sent to you.' : 'No unread messages.';
	}
	const fresh = messages.filter(message => message.mark === 'new').length;
	const count = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}, ${fresh} new`;
	const lines: string[] = [];
	if (fetched.file !== undefined) {
		const length = messages.reduce((total, message) => total + message.length, 0);
		lines.push(`${count}: ${length.toLocaleString('en-US')} characters, in the file ${fetched.file}. All of it is in the file: read the whole file before you act on any of it.`, '');
		lines.push(...messages.map(headingOf));
	} else {
		lines.push(`${count}.`);
		for (const message of messages) {
			lines.push('', headingOf(message), message.text ?? '');
		}
	}
	lines.push('');
	if (messages.some(message => message.mark === 'given before')) {
		lines.push(GIVEN_BEFORE);
	}
	lines.push(PRINT);
	return lines.join('\n');
}

/**
 * `read_messages`: the one way an agent gets messages. With nothing, its unread ones; by number, any
 * message in its reach; with `all`, every message sent to it. Each comes marked, and the caller's own
 * in a result that reached it are delivered.
 */
export const readMessagesTool: ContractTool = {
	definition: {
		name: 'read_messages',
		title: 'Read messages',
		description: 'Fetches messages. With nothing, your unread ones, oldest first; with ids, the messages of those numbers, as #m42, whoever they were sent to - with your YOLO off, those to or from your own tree; with all, every message sent to you, those you fetched before too - your task among them, after your context was cleared or compacted. Each comes marked: new; given before, and when; or returned, one that went back to its sender. A message can come twice: one number is one message. Call it when a line starting [facade] in your terminal says you have unread messages, and print the new ones before you act on them.',
		inputSchema: {
			type: 'object',
			properties: {
				ids: { type: 'array', items: { type: 'string' }, description: 'Messages by number, as #m42, whoever they were sent to: one at least; one alone is a list of one.' },
				all: { type: 'boolean', description: 'Every message sent to you, those you fetched before too. Not with ids.' }
			},
			additionalProperties: false
		}
	},
	async call(facade, caller, input, _progress, whenWritten) {
		const args = new Args('read_messages', ['ids?', 'all?'], input);
		const ids = args.optionalStrings('ids');
		const all = args.boolean('all');
		const fetched = await facade.mail.fetch(caller, { ...(ids ? { ids } : {}), ...(all ? { all } : {}) }, whenWritten);
		return { text: fetchedText(fetched), data: fetched };
	}
};
