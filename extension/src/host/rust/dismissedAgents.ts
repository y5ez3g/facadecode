/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject } from '../../base/json';
import type { KeptWorkspaceState } from '../workspaceState';
import type { DismissedAgents } from './agents';

const KEY = 'facade.rust.dismissedAgents';

/** Actual abnormal exits whose cards the person dismissed in this workspace (LIFECYCLE-3.4). */
export class WorkspaceDismissedAgents implements DismissedAgents {

	constructor(private readonly state: Pick<KeptWorkspaceState, 'get' | 'mutate'>, private readonly machineId: () => string) { }

	has(agent: string): boolean {
		const value = this.state.get<unknown>(KEY);
		return isJsonObject(value) && agentsIn(value, this.machineId()).includes(agent);
	}

	set(agent: string, dismissed: boolean): void {
		const machine = this.machineId();
		this.state.mutate<unknown>(KEY, value => {
			const stored = isJsonObject(value) ? value : {};
			const agents = agentsIn(stored, machine);
			if (agents.includes(agent) === dismissed) { return value; }
			return withAgents(stored, machine, dismissed ? [...agents, agent] : agents.filter(id => id !== agent));
		});
	}

	retain(keep: (agent: string) => boolean): void {
		const machine = this.machineId();
		this.state.mutate<unknown>(KEY, value => {
			const stored = isJsonObject(value) ? value : {};
			const current = agentsIn(stored, machine);
			const kept = current.filter(keep);
			return current.length === kept.length ? value : withAgents(stored, machine, kept);
		});
	}
}

function agentsIn(stored: Readonly<Record<string, unknown>>, scope: string): readonly string[] {
	const value = stored[scope];
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function withAgents(stored: Readonly<Record<string, unknown>>, machine: string, agents: readonly string[]): Record<string, unknown> {
	const next = { ...stored };
	if (agents.length) {
		next[machine] = agents;
	} else {
		delete next[machine];
	}
	return next;
}
