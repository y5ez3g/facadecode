/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { instructionsFor } from '../schema/instructions';
import { SHIM_AGENT, SHIM_CONTEXT, SHIM_PTYD, SHIM_RUN } from './launch';

/** Antigravity omits MCP instructions from model requests. Its shared hook reads only this run's private environment. */
export function antigravityContext(env: Readonly<Record<string, string | undefined>>): object {
	const alias = env[SHIM_AGENT];
	if (!env[SHIM_RUN] || !env[SHIM_PTYD] || !alias) { return {}; }
	// Ephemeral steps apply to this invocation, including after resume, without accumulating in the native conversation.
	return { injectSteps: [{ ephemeralMessage: instructionsFor(alias, env[SHIM_CONTEXT]) }] };
}
