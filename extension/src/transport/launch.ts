/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// How a run's CLI starts the run's MCP shim (MCP-6.1, CLIS-2.2): the extension host's own runtime run as Node, the bundled shim,
// and the run and ptyd it routes by - addresses, never credentials.

/** An MCP stdio server as a CLI's configuration names it. */
export interface McpServerLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: { readonly [name: string]: string };
}

/** The variables the shim reads: the run it speaks for and the ptyd socket that routes its calls. */
export const SHIM_RUN = 'FACADE_RUN';
export const SHIM_PTYD = 'FACADE_PTYD';

/**
 * The run's short ID, `#aN`, explicitly supplied to the shim even where the CLI filters its environment (CLIS-1.2): the CLIs' own
 * `RUN_VARIABLE`, which the layers keep this one from importing - a test holds the two equal.
 */
export const SHIM_AGENT = 'FACADE_AGENT';
export const SHIM_CONTEXT = 'FACADE_LAUNCH_CONTEXT';

/** The shim of `run`, started with `runtime` (Electron run as Node) from `script`, routing through the ptyd at `socket`. */
export function shimLaunch(options: { readonly runtime: string; readonly script: string; readonly socket: string; readonly run: string; readonly alias: string; readonly context?: string }): McpServerLaunch {
	return {
		command: options.runtime,
		args: [options.script],
		env: { ELECTRON_RUN_AS_NODE: '1', [SHIM_RUN]: options.run, [SHIM_AGENT]: options.alias, [SHIM_PTYD]: options.socket, ...(options.context ? { [SHIM_CONTEXT]: options.context } : {}) }
	};
}
