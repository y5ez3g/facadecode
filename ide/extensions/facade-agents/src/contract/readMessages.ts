/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fetched, headingOf } from '../core/mail';
import { Args } from './args';
import type { ContractTool } from './tools';

/** What every result of `read_messages` ends with: CLIs fold tool results away, and printing is how the person sees a message. */
const PRINT = 'Show messages new to you in your terminal before acting. Include each ID and sender. Print messages of 500 characters or fewer verbatim; summarize longer messages in 1-2 sentences.';

/** What a fetch's delivery states are: as the messages stood before it, which says nothing of what was done with them. */
const STATES_BEFORE = 'Delivery states describe the messages before this fetch. delivered means fetched, not acted on or completed.';

/** The delivery states a fetch counts, in the order its count names them. */
const STATES = ['unread', 'delivered', 'returned'] as const;

/**
 * A fetch as the model reads it: how many messages, and how many in each delivery state - as they stood
 * before it; each one's heading - its number, sender and recipient, time, what it answers, length and
 * delivery state - and its text, or the file that holds all their texts; then the request to print those
 * new to the caller.
 */
function fetchedText(fetched: Fetched): string {
	const { messages } = fetched;
	const missing = fetched.silent?.length ? `Not included: the messages of ${fetched.silent.map(label => `workspace ${label}`).join(', ')}, which did not answer. Retry shortly for them.` : undefined;
	if (!messages.length) {
		const none = fetched.way === 'all' ? 'No messages have been sent to you.' : 'No unread messages.';
		return missing ? `${none}\n${missing}` : none;
	}
	const states = STATES.map(state => [state, messages.filter(message => message.state === state).length] as const).filter(([, total]) => total > 0);
	const count = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}: ${states.map(([state, total]) => `${total} ${state}`).join(', ')}`;
	const lines: string[] = [];
	if (fetched.file !== undefined) {
		const length = messages.reduce((total, message) => total + message.length, 0);
		lines.push(`${count}; ${length.toLocaleString('en-US')} characters. Full message bodies: ${fetched.file}. Read the entire file before acting.`, STATES_BEFORE, '');
		lines.push(...messages.map(headingOf));
	} else {
		lines.push(`${count}.`, STATES_BEFORE);
		for (const message of messages) {
			lines.push('', headingOf(message), message.text ?? '');
		}
	}
	lines.push('', PRINT);
	if (missing) {
		lines.push(missing);
	}
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
		description: 'Fetch unread messages oldest first after a [facade] notice. ids selects reachable messages; all:true retrieves your inbox history and task. Delivery states describe the messages before this fetch: delivered means fetched, not handled. Repeated reads keep IDs and available message text. Show new messages with sender and ID before acting. Read any returned file in full.',
		inputSchema: {
			type: 'object',
			properties: {
				ids: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Message ID or nonempty list, such as #m42. Can include others\' messages within reach; with YOLO off, a sender or recipient must be in your tree. Cannot be combined with all:true.' },
				all: { type: 'boolean', default: false, description: 'Retrieve your entire current-session inbox, including fetched and returned messages. all:true cannot be combined with ids.' }
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
