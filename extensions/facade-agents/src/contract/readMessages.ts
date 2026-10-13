/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fetched, headingOf } from '../core/mail';
import { Args } from './args';
import type { ContractTool } from './tools';

/** What every result of `read_messages` ends with: CLIs fold tool results away, and printing is how the person sees a message. */
const PRINT = 'Print those new to you before you act on them, for the person, who watches your screen: one of 500 characters or fewer as it is, with its number and its sender; a longer one as its number, its sender and a sentence or two of what it says.';

/** The delivery states a fetch counts, in the order its count names them. */
const STATES = ['unread', 'delivered', 'returned'] as const;

/**
 * A fetch as the model reads it: how many messages, and how many in each delivery state; each one's
 * heading - its number, sender and recipient, time, what it answers, length and delivery state - and its
 * text, or the file that holds all their texts; then the request to print those new to the caller.
 */
function fetchedText(fetched: Fetched): string {
	const { messages } = fetched;
	if (!messages.length) {
		return fetched.way === 'all' ? 'No message has been sent to you.' : 'No unread messages.';
	}
	const states = STATES.map(state => [state, messages.filter(message => message.state === state).length] as const).filter(([, total]) => total > 0);
	const count = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}: ${states.map(([state, total]) => `${total} ${state}`).join(', ')}`;
	const lines: string[] = [];
	if (fetched.file !== undefined) {
		const length = messages.reduce((total, message) => total + message.length, 0);
		lines.push(`${count}; ${length.toLocaleString('en-US')} characters, in the file ${fetched.file}. All of it is in the file: read the whole file before you act on any of it.`, '');
		lines.push(...messages.map(headingOf));
	} else {
		lines.push(`${count}.`);
		for (const message of messages) {
			lines.push('', headingOf(message), message.text ?? '');
		}
	}
	lines.push('', PRINT);
	return lines.join('\n');
}

/**
 * `read_messages`: the one way an agent gets messages. With nothing, its unread ones; by number, any
 * message in its reach; with `all`, every message sent to it. Each comes with its delivery state, and the
 * caller's own in a result that reached it are delivered.
 */
export const readMessagesTool: ContractTool = {
	definition: {
		name: 'read_messages',
		title: 'Read messages',
		description: 'Fetches messages. With nothing, your unread ones, oldest first; with ids, the messages of those numbers, as #m42, whoever they were sent to - with your YOLO off, those to or from your own tree; with all, every message sent to you, those you fetched before too - your task among them, after your context was cleared or compacted. Each comes with its delivery state as you fetched it: unread, delivered - fetched before - or returned, one that went back to its sender. A message fetched again comes under the same number with the same text: keep track yourself of what you have handled. Call it when a line starting [facade] in your terminal says you have unread messages, and print those new to you before you act on them.',
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
