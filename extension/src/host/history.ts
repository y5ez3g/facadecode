/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { messageOf } from '../base/errors';
import type { LaunchHistoryPort, LocationId, LogPort } from '../core/ports';

const KEY = 'facade.lastLaunch';

/**
 * The person's last successful launch in this workspace, kept in workspace storage (LIFECYCLE-1.2, ARCHITECTURE-3.1). A record of
 * another shape - an earlier development build's - is ignored with one line in the agents log (ARCHITECTURE-4.2).
 */
export class WorkspaceLaunchHistory implements LaunchHistoryPort {
	private ignored = false;

	constructor(private readonly state: vscode.Memento, private readonly log?: LogPort) { }

	last(): { readonly location?: LocationId; readonly cli?: string } {
		const value = this.state.get<unknown>(KEY);
		if (value === undefined) {
			return {};
		}
		const { location, cli } = (value && typeof value === 'object' ? value : {}) as { location?: unknown; cli?: unknown };
		if (typeof location !== 'string' || typeof cli !== 'string') {
			if (!this.ignored) {
				this.ignored = true;
				this.log?.event(`Ignored the stored last launch (${KEY}) this build does not read, as from an earlier build`);
			}
			return {};
		}
		return { location, cli };
	}

	remember(location: LocationId, cli: string): void {
		const failed = (err: unknown) => this.log?.event(`Could not save the last launch: ${messageOf(err)}`);
		try {
			// Saving a preference must not turn a CLI that already started into a failed launch.
			void Promise.resolve(this.state.update(KEY, { location, cli })).catch(failed);
		} catch (err) {
			failed(err);
		}
	}
}
