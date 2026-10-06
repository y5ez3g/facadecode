/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { messageOf } from '../base/errors';
import { FacadeError } from '../core/errors';
import { Facade } from '../core/facade';
import { Caller } from '../record/events';
import { Hello, McpTool, ToolResult } from '../transport/protocol';
import { killTool } from './kill';
import { instructionsFor } from './prompts';
import { psTool } from './ps';
import { spawnTool } from './spawn';

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

/** One of the contract's tools: what the model is shown, and what a call does. */
export interface ContractTool {
	readonly definition: Tool;
	/** Its definition as the model is shown it, where that depends on what this machine has. */
	describe?(facade: Facade): Tool;
	/** Runs it; `progress` tells the caller's client how a long call goes. */
	call(facade: Facade, caller: Caller, args: unknown, progress: (message: string) => void): Promise<ToolResult>;
}

const TOOLS: readonly ContractTool[] = [spawnTool, psTool, killTool];

/**
 * The tools of Facade's MCP server, `facade`, as the model sees them: `spawn`, `ps` and `kill`. Each
 * result is text the model reads whole, with the same facts as data. A failure is a result too, marked
 * as an error: it says what is wrong and what would be right, and its data carries one of five codes.
 */
export class Contract {

	constructor(private readonly facade: Facade) { }

	/** Answers a new MCP server's hello; for a process, its hello is also the news that it is running. */
	hello(caller: Caller): Hello {
		this.facade.connected(caller);
		return { name: caller.name, tools: TOOLS.map(tool => tool.describe?.(this.facade) ?? tool.definition), instructions: instructionsFor(this.facade, caller) };
	}

	/** Runs one tool for one caller. Whatever happens, the answer is a result the model reads. */
	async call(caller: Caller, name: string, args: unknown, progress: (message: string) => void): Promise<ToolResult> {
		try {
			const tool = TOOLS.find(each => each.definition.name === name);
			if (!tool) {
				throw new FacadeError('INVALID', `Unknown tool ${name}. The tools: ${TOOLS.map(each => each.definition.name).join(', ')}.`);
			}
			return await tool.call(this.facade, caller, args, progress);
		} catch (err) {
			return { text: messageOf(err), isError: true, data: { code: err instanceof FacadeError ? err.code : 'FAILED' } };
		}
	}
}
