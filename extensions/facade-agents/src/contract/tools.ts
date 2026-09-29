/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { renderMessages } from '../core/delivery';
import { FacadeError } from '../core/errors';
import { Facade } from '../core/facade';
import { Caller, Message } from '../record/events';
import { ideTool } from './ide';
import { instructionsFor } from './instructions';
import { sendTool } from './send';
import { spawnTool } from './spawn';
import { stopTool } from './stop';

/** A tool as `tools/list` shows it. */
export interface Tool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: object;
}

/** What a tool did, in words and as data. */
export interface ToolOutput {
	readonly text: string;
	readonly data?: object;
}

export interface ToolResult extends ToolOutput {
	readonly isError?: boolean;
}

/** One of the contract's tools: what the model is shown, and what a call does. */
export interface ContractTool {
	readonly definition: Tool;
	call(facade: Facade, caller: Caller, args: unknown): Promise<ToolOutput>;
}

/** What a new MCP server is told of its caller (`/hello`). */
export interface Hello {
	readonly name: string;
	readonly tools: readonly Tool[];
	readonly instructions: string;
}

const TOOLS: readonly ContractTool[] = [spawnTool, sendTool, stopTool, ideTool];

/**
 * The tools of Facade's MCP server, `facade`, as the model sees them (WORKTREE-AGENTS.md, section 5).
 * Each result is text the model reads whole, with the same facts as data, and ends with the messages
 * the caller has not had yet (WA-5.3). A failure is a result too, marked as an error: it says what is
 * wrong and what would be right, and its data carries one of five codes (WA-5.7).
 */
export class Contract {

	constructor(private readonly facade: Facade) { }

	hello(caller: Caller): Hello {
		return { name: caller.name, tools: TOOLS.map(tool => tool.definition), instructions: instructionsFor(this.facade, caller) };
	}

	/** Runs one tool for one caller. Whatever happens, the answer is a result the model reads. */
	async call(caller: Caller, name: string, args: unknown): Promise<ToolResult> {
		this.facade.heard(caller);
		let result: ToolResult;
		try {
			const tool = TOOLS.find(each => each.definition.name === name);
			if (!tool) {
				throw new FacadeError('INVALID', `Unknown tool ${name}. The tools: ${TOOLS.map(each => each.definition.name).join(', ')}.`);
			}
			result = await tool.call(this.facade, caller, args);
		} catch (err) {
			result = { text: (err as Error).message, isError: true, data: { code: err instanceof FacadeError ? err.code : 'FAILED' } };
		}
		return withMessages(result, this.facade.messagesFor(caller));
	}
}

/** A result with the messages that came for its caller after it (WA-5.3). */
function withMessages(result: ToolResult, messages: readonly Message[]): ToolResult {
	if (!messages.length) {
		return result;
	}
	return {
		...result,
		text: `${result.text}\n\nMessages for you:\n${renderMessages(messages)}`,
		data: { ...result.data, messages: messages.map(message => ({ from: message.from, text: message.text })) }
	};
}
