/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Facade } from '../core/facade';
import { Caller, YOU } from '../record/events';

const TOOLS = 'spawn starts a child agent; send messages your parent or a child; stop stops a child; ide does what the person can do in the IDE.';
const MESSAGES = 'Messages to you arrive by themselves. Never wait or poll for them: when you have nothing to do, end your turn.';

/**
 * What an agent's MCP server tells the model when it starts (WORKTREE-AGENTS.md, WA-5.2): who it is,
 * who started it, where it runs, what the tools do, and that messages come by themselves. Nothing
 * about how to work: that is a skill's.
 */
export function instructionsFor(facade: Facade, caller: Caller): string {
	const agent = facade.agentOf(caller);
	if (!agent) {
		return ['You act as the person, @you, in Facade Code.', TOOLS].join('\n');
	}
	const cli = facade.cliName(agent.cli);
	return [
		`You are @${agent.name}, ${/^[aeiou]/i.test(cli) ? 'an' : 'a'} ${cli} agent in Facade Code, started by ${agent.parent === YOU ? 'the person' : `@${agent.parent}`}.`,
		`You run in ${agent.folder}: the worktree ${agent.worktree}. You are in that folder already: run commands there without cd.`,
		TOOLS,
		MESSAGES
	].join('\n');
}
