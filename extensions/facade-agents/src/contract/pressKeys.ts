/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FacadeError } from '../core/errors';
import { CTRL_KEYS, keyOf, NAMED_KEYS } from '../core/keys';
import { ANSWER_DELAY_MS, MOST_KEYS } from '../core/screens';
import { describe } from '../record/events';
import { Args } from './args';
import { screenAfter } from './readScreen';
import type { ContractTool } from './tools';

/** The keys `press_keys` takes, as a refusal names them. */
const KEYS_TAKEN = `${NAMED_KEYS.join(', ')}, and ${CTRL_KEYS[0]} to ${CTRL_KEYS[CTRL_KEYS.length - 1]} - in any case, spaces between their parts or none; Return, Esc, ArrowUp, ArrowDown, ArrowLeft, ArrowRight and ^A to ^Z for them too; or one printable character, such as y or 1`;

/** `press_keys`: keys pressed in an agent's terminal, in order, as the person presses them. */
export const pressKeysTool: ContractTool = {
	definition: {
		name: 'press_keys',
		title: 'Press keys in an agent\'s terminal',
		description: `Presses keys in another agent's terminal, in order, a moment apart, as the person presses them, in the modes its CLI set: to pick from its menus, answer its questions, interrupt it. Its CLI does with each what it does when the person presses it: Enter sends its input or picks an item, Escape or Ctrl+C stops most CLIs in what they are doing, and some exit on Ctrl+C twice or on Ctrl+D - to end an agent, use stop_agent. Up to ${MOST_KEYS} keys: ${KEYS_TAKEN}. Read its screen first, to see where it is. They go in their turn, after what Facade types there before, and wait while the person is typing there. It answers with the keys that went in and the bottom lines of the screen ${ANSWER_DELAY_MS / 1000} seconds on. Nothing is pressed twice: where it is not known what went in, read the screen first.`,
		inputSchema: {
			type: 'object',
			properties: {
				agent: { type: 'string', description: 'The agent: its number, as #a7, or its @name, where only one agent that has not ended has it. It may be you.' },
				keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MOST_KEYS, description: `The keys, in order: names such as Enter, Down, Escape, Ctrl+C, or one printable character each, such as y or 1. Up to ${MOST_KEYS}; one alone is a list of one.` }
			},
			required: ['agent', 'keys'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('press_keys', ['agent', 'keys'], input);
		const agent = args.text('agent');
		const given = args.strings('keys');
		if (!given.length || given.length > MOST_KEYS) {
			throw new FacadeError('INVALID', `keys has ${given.length}: press 1 to ${MOST_KEYS} keys at a time.`);
		}
		const keys: string[] = [];
		const unknown: string[] = [];
		for (const key of given) {
			const known = keyOf(key);
			if (known === undefined) {
				unknown.push(key);
			} else {
				keys.push(known);
			}
		}
		if (unknown.length) {
			throw new FacadeError('INVALID', `press_keys does not know ${unknown.map(key => JSON.stringify(key)).join(', ')}, and pressed nothing. It takes ${KEYS_TAKEN}. Type text with type_text.`);
		}
		const result = await facade.screens.press(caller, agent, keys);
		const pressed = `Pressed ${keys.join(', ')} in ${describe(result)}'s terminal.`;
		return { text: `${pressed} ${screenAfter(result, facade.cliName(facade.agent(result.id)?.cli ?? ''))}`, data: { ...result, keys } };
	}
};
