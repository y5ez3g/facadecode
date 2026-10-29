/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject } from '../base/json';

/**
 * How long an agent's MCP server waits for the window - as the agent starts, and through a reload - where
 * its launch does not say: Facade's timeout where the person sets nothing else, two minutes.
 */
export const WINDOW_WAIT_MS = 120_000;

/** The longest wait a timer takes: past it, Node fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A tool as MCP lists it. */
export interface McpTool {
	readonly name: string;
	readonly title?: string;
	readonly description: string;
	/** A JSON Schema of its arguments. */
	readonly inputSchema: object;
}

/** A tool call's result: text the model reads whole, and the same facts as data; `isError` when it failed. */
export interface ToolResult {
	readonly text: string;
	readonly data?: object;
	readonly isError?: boolean;
}

/** What the window says hello with to an agent's MCP server: its caller's name, the tools, and the instructions for its model. */
export interface Hello {
	readonly name: string;
	readonly tools: readonly McpTool[];
	readonly instructions: string;
}

/** A line of the window's answer to `/call`: progress while the call runs, then its result or why it failed. */
export type CallLine =
	/** `agent`: the run the call made, once it has made one - for a caller whose call is cut after, to name it. */
	| { readonly type: 'progress'; readonly message: string; readonly agent?: number }
	| { readonly type: 'result'; readonly result: unknown }
	| { readonly type: 'error'; readonly code: string; readonly message: string };

/**
 * The file beside the window's record of itself, in the workspace's record, that holds the tools the window serves: what an
 * agent's MCP server lists while the window does not answer, so that its tools are the same whatever the window's state
 * (AGENT-LAUNCHER.md, L1; AGENT-ORCHESTRATION.md, O8). It stays as the window goes, for the next to write again.
 */
export const TOOLS_FILE = 'tools.json';

/** Tools as the window gives them, each checked; undefined where `value` is no list of tools, or holds one it cannot read. */
export function toolsOf(value: unknown): McpTool[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const tools: McpTool[] = [];
	for (const tool of value as readonly unknown[]) {
		if (!isJsonObject(tool) || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !isJsonObject(tool.inputSchema)
			|| (tool.title !== undefined && typeof tool.title !== 'string')) {
			return undefined;
		}
		tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...(typeof tool.title === 'string' ? { title: tool.title } : {}) });
	}
	return tools;
}

/**
 * The window's hello, checked before an agent's MCP server passes it on; undefined when it is not one,
 * as from a window of another version.
 */
export function helloOf(value: unknown): Hello | undefined {
	if (!isJsonObject(value) || typeof value.name !== 'string' || typeof value.instructions !== 'string') {
		return undefined;
	}
	const tools = toolsOf(value.tools);
	return tools && { name: value.name, tools, instructions: value.instructions };
}

/** A tool's result from the window, checked before it is passed on; undefined when it is not one. */
export function toolResultOf(value: unknown): ToolResult | undefined {
	if (!isJsonObject(value) || typeof value.text !== 'string') {
		return undefined;
	}
	const { text, data, isError } = value;
	if ((data !== undefined && !isJsonObject(data)) || (isError !== undefined && typeof isError !== 'boolean')) {
		return undefined;
	}
	return { text, ...(data !== undefined ? { data } : {}), ...(isError !== undefined ? { isError } : {}) };
}

/**
 * The lines `text` - what a stream of newline-delimited JSON gave so far - holds whole, without their
 * line breaks, and what follows the last line break: the start of a line still to come.
 */
export function splitLines(text: string): { readonly lines: readonly string[]; readonly rest: string } {
	const lines = text.split('\n');
	const rest = lines.pop() ?? '';
	return { lines: lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line), rest };
}

/** Word of how a call goes: a message, with the run the call made once it has made one. */
export type Progress = (message: string, agent?: number) => void;

/** A line of the window's answer to `/call`, checked; undefined when it is not one. */
export function callLineOf(line: string): CallLine | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isJsonObject(value)) {
		return undefined;
	}
	const { type, message, result, code, agent } = value;
	if (type === 'progress' && typeof message === 'string') {
		return { type, message, ...(typeof agent === 'number' && Number.isInteger(agent) && agent > 0 ? { agent } : {}) };
	}
	if (type === 'result') {
		return { type, result };
	}
	if (type === 'error' && typeof code === 'string' && typeof message === 'string') {
		return { type, code, message };
	}
	return undefined;
}
