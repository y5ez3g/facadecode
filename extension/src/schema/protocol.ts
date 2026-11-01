/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a run's MCP shim and the window that owns the run say about one tool call (MCP-6.1, 6.2): the call as the shim received it,
// with how long it has been under way, and the answer as MCP returns it - English text and the same facts structured.

/**
 * The tool protocol the shim and the window speak: the nine tools' names, arguments and results (MCP-6.2). Each call says it, and a
 * window of another refuses the call as `protocol_incompatible` before any effect (ARCHITECTURE-2.4), never translating it.
 */
export const TOOL_PROTOCOL = 2;

/** One tool call from a run's CLI, as its shim received it. */
export interface ToolCall {
	/** The tool protocol of the shim that asked it: {@link TOOL_PROTOCOL}. */
	readonly protocol: number;
	/** The calling run: the shim's launch run ID, an address rather than a credential (MCP-6.1). */
	readonly caller: string;
	readonly tool: string;
	/** The arguments as the CLI sent them, validated by the window before any effect (MCP-1.1). */
	readonly arguments: unknown;
	/**
	 * Milliseconds since the complete request reached the shim, measured where it is: each hop adds its own, so that a deadline is
	 * never restarted and no two hosts' clocks are compared (RULES-1.2, ARCHITECTURE-2.3).
	 */
	readonly elapsedMs: number;
	/** The MCP request's own ID at the shim, distinguishing concurrent calls of one run (MCP-1.3). */
	readonly callId: string;
	/**
	 * For a query, how long from the shim's ingress a window has to answer: once that passes, its route answers it unavailable, with no
	 * effect, and the window's late answer is handed back to nobody (MCP-1.3).
	 */
	readonly routeDeadlineMs?: number;
}

/** A tool call's answer, as the shim returns it to the CLI (MCP-1.2): text and structured facts that say the same. */
export interface ToolAnswer {
	readonly text: string;
	readonly structured: { readonly [key: string]: unknown };
	readonly isError: boolean;
}

/**
 * A call's answer as the window's tool service gives it, and what to do once that answer reached the run's shim - not before: a
 * read_messages counts what it returns as delivered only then (MCP-4.2, COLLABORATION-3.1).
 */
export interface ServedAnswer {
	readonly answer: ToolAnswer;
	readonly delivered?: () => void;
}
