/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FacadeError } from '../core/errors';
import { Facade } from '../core/facade';
import { Caller } from '../record/events';
import { ideTool } from './ide';
import { instructionsFor } from './instructions';

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

const TOOLS: readonly ContractTool[] = [ideTool];

/**
 * The tools of Facade's MCP server, `facade`, as the model sees them (WORKTREE-AGENTS.md, section 5).
 * Each result is text the model reads whole, with the same facts as data. A failure is a result too,
 * marked as an error: it says what is wrong and what would be right, and its data carries one of five
 * codes (WA-5.7). M0 has one tool, `ide`; spawn, send and stop come with M1, and with them the
 * messages every result carries (WA-5.3).
 */
export class Contract {

	constructor(private readonly facade: Facade) { }

	hello(caller: Caller): Hello {
		return { name: caller.name, tools: TOOLS.map(tool => tool.definition), instructions: instructionsFor(this.facade, caller) };
	}

	/** Runs one tool for one caller. Whatever happens, the answer is a result the model reads. */
	async call(caller: Caller, name: string, args: unknown): Promise<ToolResult> {
		try {
			const tool = TOOLS.find(each => each.definition.name === name);
			if (!tool) {
				throw new FacadeError('INVALID', `Unknown tool ${name}. The tools: ${TOOLS.map(each => each.definition.name).join(', ')}.`);
			}
			return await tool.call(this.facade, caller, args);
		} catch (err) {
			return { text: (err as Error).message, isError: true, data: { code: err instanceof FacadeError ? err.code : 'FAILED' } };
		}
	}
}
