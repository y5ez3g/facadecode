/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Facade } from '../core/facade';
import { Caller, YOU } from '../record/events';

const TOOLS = 'ide does what the person can do in the IDE.';

/**
 * What an agent's MCP server tells the model when it starts (WORKTREE-AGENTS.md, WA-5.2): who it is,
 * who started it, where it runs, and what the tools do. Nothing about how to work: that is a skill's.
 * With M1 the tools line names spawn, send and stop too, and a line says that messages arrive by
 * themselves.
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
		TOOLS
	].join('\n');
}
