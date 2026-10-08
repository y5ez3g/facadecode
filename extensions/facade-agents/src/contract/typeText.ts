/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FacadeError } from '../core/errors';
import { ANSWER_DELAY_MS, MOST_TYPED } from '../core/screens';
import { Args } from './args';
import { screenAfter } from './readScreen';
import type { ContractTool } from './tools';

/** What a line typed may not have in it: a line break, Escape, a tab or another control character, a line or paragraph separator. */
const NOT_TYPED = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** `type_text`: one line typed into an agent's terminal, as one paste, and Enter after it if asked. */
export const typeTextTool: ContractTool = {
	definition: {
		name: 'type_text',
		title: 'Type into an agent\'s terminal',
		description: `Types one line into another agent's terminal, as one paste, as the person types into it - its CLI cannot tell the difference - and presses Enter after it with enter. It is for that CLI's own interface: answering what it asks, filling in what it wants, running its own commands such as /compact. What you type, its model takes as the person's words, and no message history has it. Up to ${MOST_TYPED} characters with no line break or control key in it: press keys with press_keys; give anything longer in a file, and type its path. It goes in its turn, after what Facade types there before, and waits while the person is typing there - for Enter, or ten seconds without a key. It answers with what went in and the bottom lines of the screen ${ANSWER_DELAY_MS / 1000} seconds on: read them before you type again. Nothing is typed twice: where it is not known what went in, read the screen first.`,
		inputSchema: {
			type: 'object',
			properties: {
				agent: { type: 'string', description: 'The agent: its number, as #7, or its @name, where only one running agent has it. It may be you.' },
				text: { type: 'string', description: `One line of plain text, up to ${MOST_TYPED} characters, typed as it is, spaces at its ends too.` },
				enter: { type: 'boolean', description: 'Press Enter after it, a fixed pause after the paste: the time its CLI is set to be given to take a paste in, which says nothing of whether it did. Without it, the text stays in the input.' }
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
			throw new FacadeError('INVALID', `text is ${[...text].length} characters, past the ${MOST_TYPED} type_text types: give more in a file, and type its path.`);
		}
		if (NOT_TYPED.test(text)) {
			throw new FacadeError('INVALID', 'text has a line break, Escape, a tab or another control character in it: type one line with type_text, and press Enter, Escape, Tab and the like with press_keys. Nothing was typed.');
		}
		const enter = args.boolean('enter') ?? false;
		const result = await facade.screens.type(caller, agent, text, enter);
		const typed = `Typed ${[...text].length} characters into @${result.name} #${result.id}'s terminal, as one paste${result.effect.entered ? ', and pressed Enter' : ', without Enter'}.`;
		return { text: `${typed} ${screenAfter(result, facade.cliName(facade.agent(result.id)?.cli ?? ''))}`, data: result };
	}
};
