/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { messageOf } from '../../base/errors';
import { isJsonObject } from '../../base/json';
import type { LogPort } from '../../core/ports';
import type { KeptWorkspaceState } from '../workspaceState';
import type { DismissedAgents } from './agents';

const KEY = 'facade.rust.dismissedAgents';

/** Actual abnormal exits whose cards the person dismissed in this workspace (LIFECYCLE-3.4). */
export class WorkspaceDismissedAgents implements DismissedAgents {

	constructor(private readonly state: Pick<KeptWorkspaceState, 'get' | 'keep'>, private readonly home: string, private readonly log: LogPort) { }

	has(agent: string): boolean {
		return this.agentsIn(this.read()).includes(agent);
	}

	set(agent: string, dismissed: boolean): void {
		const stored = this.read();
		const agents = this.agentsIn(stored);
		if (agents.includes(agent) !== dismissed) {
			this.write(stored, dismissed ? [...agents, agent] : agents.filter(id => id !== agent));
		}
	}

	retain(agents: ReadonlySet<string>): void {
		const stored = this.read();
		const before = this.agentsIn(stored);
		const after = before.filter(id => agents.has(id));
		if (before.length !== after.length) {
			this.write(stored, after);
		}
	}

	private read(): Readonly<Record<string, unknown>> {
		const value = this.state.get<unknown>(KEY);
		return isJsonObject(value) ? value : {};
	}

	private agentsIn(stored: Readonly<Record<string, unknown>>): readonly string[] {
		const value = stored[this.home];
		return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
	}

	private write(stored: Readonly<Record<string, unknown>>, agents: readonly string[]): void {
		const next = { ...stored };
		if (agents.length) {
			next[this.home] = agents;
		} else {
			delete next[this.home];
		}
		void Promise.resolve(this.state.keep(KEY, next)).catch(err => this.log.event(`Could not keep dismissed agent cards: ${messageOf(err)}`));
	}
}
