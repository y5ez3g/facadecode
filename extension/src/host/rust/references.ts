/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentRef, MessageRef } from '../../base/coreProtocol';

/** Exact selectors stay valid across a machine rename and distinguish machines with the same name (RULES-2.2). */
export function machineSelector(machine: string): string {
	return `id:${machine.replace(/-/g, '')}`;
}

export function agentAddress(ref: AgentRef): string {
	return `#${ref.agent_id}@${machineSelector(ref.machine_id)}`;
}

export function messageAddress(ref: MessageRef): string {
	return `#${ref.message_id}@${machineSelector(ref.machine_id)}`;
}
