/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FacadeError } from '../core/errors';
import { ANSWER_DELAY_MS, ANSWER_LINES, MOST_TYPED } from '../core/screens';
import { describe } from '../record/events';
import { Args } from './args';
import { screenAfter } from './readScreen';
import type { ContractTool } from './tools';

/** What a line typed may not have in it: a line break, Escape, a tab or another control character, a line or paragraph separator. */
const NOT_TYPED = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** `type_text`: one line typed into an agent's terminal, as one paste, and Enter after it if asked. */
export const typeTextTool: ContractTool = {
	definition: {
		name: 'type_text',
		title: 'Type text into an agent\'s terminal',
		description: `Paste one line; enter:true submits it in the same queued operation. Use for CLI prompts or commands such as /compact; use send_message for agent work. Input appears as human input and is not in message history. Waits behind Facade input and human typing until submission, cancellation, or 10 idle seconds; may append to a draft. Returns actual writes and normally ${ANSWER_LINES} screen lines after ${ANSWER_DELAY_MS / 1000} seconds. Inspect the returned screen before more input; after an unknown outcome, call read_screen first.`,
		inputSchema: {
			type: 'object',
			properties: {
				agent: { type: 'string', description: 'Run ID (#a7) or unique active @name. You may target yourself; Escape or Ctrl+C can interrupt this caller.' },
				text: { type: 'string', description: `One nonempty line, at most ${MOST_TYPED} Unicode code points; spaces are preserved. No newlines, tabs, Escape, or other control characters. Use press_keys for keys or a file path for longer content.` },
				enter: { type: 'boolean', default: false, description: 'Send Enter after the CLI\'s configured paste delay. This does not guarantee acceptance. Default false leaves the text in the input.' }
			},
			required: ['agent', 'text'],
			additionalProperties: false
		}
	},
	async call(facade, caller, input) {
		const args = new Args('type_text', ['agent', 'text', 'enter?'], input);
		const agent = args.text('agent');
		const text = args.exactText('text');
		if ([...text].length > MOST_TYPED) {
			throw new FacadeError('INVALID', `Argument 'text' contains ${[...text].length} Unicode code points; the limit is ${MOST_TYPED}. Put longer content in a file and type its path. No text was pasted.`);
		}
		if (NOT_TYPED.test(text)) {
			throw new FacadeError('INVALID', 'Argument \'text\' must be one line with no control characters. Use press_keys for Enter, Escape, Tab, or other keys. No text was pasted.');
		}
		const enter = args.boolean('enter') ?? false;
		const result = await facade.screens.type(caller, agent, text, enter);
		const chars = [...text].length;
		const typed = `Pasted ${chars} ${chars === 1 ? 'character' : 'characters'} into ${describe(result)}'s terminal${result.effect.entered ? ' and sent Enter' : ' without Enter'}.`;
		// What was sent, as the text says it: the line and its count of characters (D4)
		return { text: `${typed}\n${screenAfter(result, facade.cliName(facade.agent(result.id)?.cli ?? ''))}`, data: { ...result, text, chars } };
	}
};
