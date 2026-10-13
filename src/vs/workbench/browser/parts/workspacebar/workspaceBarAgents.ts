/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';

/** The agents one folder runs. */
export interface IFolderAgents {
	readonly folder: URI;
	/** Each agent's icon - its maker's logo, or the robot - oldest first. */
	readonly icons: readonly ThemeIcon[];
}

/**
 * What runs in each folder of the bar, so that its row can show it (WORKTREE.md WT-1.15) - and, as a folder
 * is about to be removed, whether that terminates a process in its terminals (D30).
 *
 * ⚠️ The bar lives in `vs/workbench/browser`, below the terminals, and cannot reach them; the agent
 * launchers reach both. Its agents are told: the launchers say what runs where, and the bar draws it.
 * Its processes are asked, through the check the launchers register ({@link registerProcessCheck}).
 */
export interface IWorkspaceBarAgentsService {
	readonly _serviceBrand: undefined;

	/** Fires when what runs in some folder has changed. */
	readonly onDidChange: Event<void>;

	/** The icons of the agents running in `folder`, oldest first: none for a folder that runs none. */
	agentsIn(folder: URI): readonly ThemeIcon[];

	/** Says what runs in every folder, replacing what was said before: a folder left out runs none. */
	set(agents: readonly IFolderAgents[]): void;

	/**
	 * Whether taking `folder` out of the workspace terminates a process in one of its terminals that is no agent's, which
	 * VS Code would ask about before terminating it - "Do you want to terminate running processes?" - as the terminals
	 * answer: `false` until they have said how to know.
	 */
	terminatesProcessesIn(folder: URI): boolean;

	/**
	 * Says how to know {@link terminatesProcessesIn}, until the returned disposable is disposed. ⚠️ Asked, not told: a
	 * terminal's processes come and go without anything a row draws changing, and matter only when someone is about
	 * to remove a folder.
	 */
	registerProcessCheck(check: (folder: URI) => boolean): IDisposable;
}

export const IWorkspaceBarAgentsService = createDecorator<IWorkspaceBarAgentsService>('workspaceBarAgentsService');

export class WorkspaceBarAgentsService extends Disposable implements IWorkspaceBarAgentsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private agents = new Map<string, readonly ThemeIcon[]>();

	private processCheck: ((folder: URI) => boolean) | undefined;

	constructor(@IUriIdentityService private readonly uriIdentityService: IUriIdentityService) {
		super();
	}

	agentsIn(folder: URI): readonly ThemeIcon[] {
		return this.agents.get(this.uriIdentityService.extUri.getComparisonKey(folder)) ?? [];
	}

	set(agents: readonly IFolderAgents[]): void {
		const next = new Map<string, readonly ThemeIcon[]>();
		for (const { folder, icons } of agents) {
			if (icons.length) {
				next.set(this.uriIdentityService.extUri.getComparisonKey(folder), icons);
			}
		}

		// Said again on every change to any terminal: only a change in what the rows draw redraws them
		if (!sameAgents(this.agents, next)) {
			this.agents = next;
			this._onDidChange.fire();
		}
	}

	terminatesProcessesIn(folder: URI): boolean {
		return this.processCheck?.(folder) ?? false;
	}

	registerProcessCheck(check: (folder: URI) => boolean): IDisposable {
		this.processCheck = check;
		return toDisposable(() => {
			if (this.processCheck === check) {
				this.processCheck = undefined;
			}
		});
	}
}

function sameAgents(a: ReadonlyMap<string, readonly ThemeIcon[]>, b: ReadonlyMap<string, readonly ThemeIcon[]>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [folder, icons] of a) {
		const other = b.get(folder);
		if (!other || other.length !== icons.length || other.some((icon, index) => icon.id !== icons[index].id)) {
			return false;
		}
	}
	return true;
}

registerSingleton(IWorkspaceBarAgentsService, WorkspaceBarAgentsService, InstantiationType.Delayed);
