/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FacadeError } from '../core/errors';
import { CTRL_KEYS, keyOf, NAMED_KEYS } from '../core/keys';
import { ANSWER_DELAY_MS, ANSWER_LINES, MOST_KEYS } from '../core/screens';
import { describe } from '../record/events';
import { Args } from './args';
import { screenAfter } from './readScreen';
import type { ContractTool } from './tools';

/** The keys `press_keys` takes, as a refusal names them. */
const KEYS_TAKEN = `${NAMED_KEYS.join(', ')}, ${CTRL_KEYS[0]} through ${CTRL_KEYS[CTRL_KEYS.length - 1]}, or one printable character such as y or 1. Key names are case-insensitive and allow spaces between components. Aliases: Return, Esc, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, and ^A through ^Z`;

/** `press_keys`: keys pressed in an agent's terminal, in order, as the person presses them. */
export const pressKeysTool: ContractTool = {
	definition: {
		name: 'press_keys',
		title: 'Press keys in an agent\'s terminal',
		description: `Send keys in order, 50 ms apart, in the CLI's current terminal mode. Read its screen first and use the shortest useful sequence. Enter submits/selects; Escape or Ctrl+C usually interrupts; repeated Ctrl+C or Ctrl+D may exit. Use stop_agent to end a run. Shares type_text's queue and human-input guard. Returns keys actually sent and normally ${ANSWER_LINES} screen lines after ${ANSWER_DELAY_MS / 1000} seconds. Inspect the returned screen before more input; after an unknown outcome, call read_screen first.`,
		inputSchema: {
			type: 'object',
			properties: {
				agent: { type: 'string', description: 'Run ID (#a7) or unique active @name. You may target yourself; Escape or Ctrl+C can interrupt this caller.' },
				keys: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MOST_KEYS }], description: `1-${MOST_KEYS} keys: Enter, Escape, Tab, Shift+Tab, Backspace, Delete, Up/Down/Left/Right, Home, End, PageUp/PageDown, Space, Ctrl+A..Z, or one printable character. Names ignore case and spaces between components. Aliases: Return, Esc, ArrowUp/Down/Left/Right, ^A..Z. A single key may be a string.` }
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
			throw new FacadeError('INVALID', `Argument 'keys' has ${given.length} entries; provide 1-${MOST_KEYS} keys. No keys were sent.`);
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
			throw new FacadeError('INVALID', `Unknown keys: ${unknown.map(key => JSON.stringify(key)).join(', ')}. No keys were sent. Supported keys: ${KEYS_TAKEN}. Use type_text to paste text.`);
		}
		const result = await facade.screens.press(caller, agent, keys);
		const pressed = `Sent keys ${keys.join(', ')} to ${describe(result)}'s terminal.`;
		return { text: `${pressed}\n${screenAfter(result, facade.cliName(facade.agent(result.id)?.cli ?? ''))}`, data: { ...result, keys } };
	}
};
