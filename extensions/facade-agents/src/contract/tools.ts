/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { withDeadline } from '../base/async';
import { messageOf } from '../base/errors';
import { FacadeError } from '../core/errors';
import { Facade } from '../core/facade';
import { Caller } from '../record/events';
import type { ResultListener } from '../transport/pipe';
import { Hello, McpTool, Progress, ToolResult } from '../transport/protocol';
import { listAgentsTool } from './listAgents';
import { pressKeysTool } from './pressKeys';
import { instructionsFor } from './prompts';
import { readMessagesTool } from './readMessages';
import { readScreenTool } from './readScreen';
import { sendMessageTool } from './sendMessage';
import { startAgentTool } from './startAgent';
import { stopAgentTool } from './stopAgent';
import { typeTextTool } from './typeText';

/** A tool's input, as the JSON Schema its definition gives: an object, and its properties. */
export type ToolSchema = {
	readonly type: 'object';
	readonly properties: { readonly [name: string]: object };
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
};

/** A tool as `tools/list` shows it, with its schema as Facade writes one. */
export interface Tool extends McpTool {
	readonly title: string;
	readonly inputSchema: ToolSchema;
}

/**
 * How long a call that names the CLIs this machine has waits for them to be looked for again: a window
 * answers its questions in well under a second, even over a slow connection; one away from its remote
 * answers none, and the call goes on with those found last (REMOTE.md R2).
 */
const CLI_LOOK_WAIT_MS = 2_000;

/** One of the contract's tools: what the model is shown, and what a call does. */
export interface ContractTool {
	readonly definition: Tool;
	/** Whether its answer names the CLIs this machine has - those `list_agents` lists, those `start_agent` starts - which are looked for again first. */
	readonly findsClis?: boolean;
	/** Its definition as the model is shown it, where that depends on what this machine has. */
	describe?(facade: Facade): Tool;
	/**
	 * Runs it; `progress` tells the caller's client how a long call goes. A listener given to `whenWritten`
	 * hears whether its result went out to the caller: never so when the call fails.
	 */
	call(facade: Facade, caller: Caller, args: unknown, progress: Progress, whenWritten: (listener: ResultListener) => void): Promise<ToolResult>;
}

const TOOLS: readonly ContractTool[] = [startAgentTool, listAgentsTool, stopAgentTool, sendMessageTool, readMessagesTool, readScreenTool, typeTextTool, pressKeysTool];

/**
 * The eight tools as an agent's MCP server lists them while the window does not answer (AGENT-LAUNCHER.md, L1;
 * AGENT-ORCHESTRATION.md, O8): each as its definition has it - start_agent's without the agents this machine can
 * start, which only the window knows.
 */
export function toolDefinitions(): readonly Tool[] {
	return TOOLS.map(tool => tool.definition);
}

/**
 * How often a call that runs on tells its caller's client that it does: the client takes a window silent for long as
 * gone, and a call that waited its turn behind the person's typing past that would be said to have done who knows
 * what - then go in all the same (AGENT-DEBUGGING.md, D3).
 */
const STILL_GOING_MS = 30_000;

/**
 * The tools of Facade's MCP server, `facade`, as the model sees them: `start_agent`, `list_agents` and
 * `stop_agent`; `send_message` and `read_messages` (AGENT-MESSAGES.md); and `read_screen`, `type_text` and
 * `press_keys` (AGENT-DEBUGGING.md). Each result is text the model reads whole, with the same facts as data;
 * messages come only from `read_messages`, never along with another tool's result. A failure is a result
 * too, marked as an error: it says what is wrong and what would be right, and its data carries one of five
 * codes, with what happened all the same where something did.
 */
export class Contract {

	constructor(private readonly facade: Facade) { }

	/** Answers a new MCP server's hello; for an agent, its hello is also the news that it is running, and which process its server is. */
	hello(caller: Caller, server: { readonly pid?: number } = {}): Hello {
		this.facade.connected(caller, server.pid);
		return { name: caller.name, tools: TOOLS.map(tool => tool.describe?.(this.facade) ?? tool.definition), instructions: instructionsFor(this.facade, caller) };
	}

	/**
	 * Runs one tool for one caller. Whatever happens, the answer is a result the model reads. While the agent
	 * framework is off, every call answers at once that it is (AGENT-ORCHESTRATION.md, O7). Its listeners given
	 * to `whenWritten` hear whether it went out, as the pipe tells; those of a call that failed hear no.
	 */
	async call(caller: Caller, name: string, args: unknown, progress: Progress, whenWritten: (listener: ResultListener) => void = () => undefined): Promise<ToolResult> {
		if (!this.facade.frameworkOn()) {
			return { text: 'Facade tools are disabled by facade.orchestration.enabled. This call had no effect; existing agents keep running.', isError: true, data: { code: 'UNAVAILABLE', reason: 'framework_disabled' } };
		}
		const listeners: ResultListener[] = [];
		let result: ToolResult;
		try {
			const tool = TOOLS.find(each => each.definition.name === name);
			if (!tool) {
				throw new FacadeError('INVALID', `Unknown tool '${name}'. Available tools: ${TOOLS.map(each => each.definition.name).join(', ')}.`);
			}
			// What this machine has now, as a terminal finds it - a CLI the person installed, or took away, since -
			// for a call that names them; asked of the window, which a call waits on only so long
			if (tool.findsClis) {
				await withDeadline(this.facade.refreshClis(), CLI_LOOK_WAIT_MS, () => undefined);
			}
			const going = setInterval(() => progress(`${name} is still running.`), STILL_GOING_MS);
			try {
				result = await tool.call(this.facade, caller, args, progress, listener => listeners.push(listener));
			} finally {
				clearInterval(going);
			}
		} catch (err) {
			for (const listener of listeners) {
				listener(false);
			}
			return { text: messageOf(err), isError: true, data: { code: err instanceof FacadeError ? err.code : 'FAILED', ...(err instanceof FacadeError && err.outcome ? err.outcome : {}) } };
		}
		for (const listener of listeners) {
			whenWritten(listener);
		}
		return result;
	}
}
