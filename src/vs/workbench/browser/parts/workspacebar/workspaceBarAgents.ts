/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
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
 * What runs in each folder of the bar, so that its row can show it (WORKTREE.md WT-1.15).
 *
 * ⚠️ Told, not asked. The bar lives in `vs/workbench/browser`, below the terminals, and cannot reach
 * them; the agent launchers reach both, so they say what runs where and the bar draws it.
 */
export interface IWorkspaceBarAgentsService {
	readonly _serviceBrand: undefined;

	/** Fires when what runs in some folder has changed. */
	readonly onDidChange: Event<void>;

	/** The icons of the agents running in `folder`, oldest first: none for a folder that runs none. */
	agentsIn(folder: URI): readonly ThemeIcon[];

	/** Says what runs in every folder, replacing what was said before: a folder left out runs none. */
	set(agents: readonly IFolderAgents[]): void;
}

export const IWorkspaceBarAgentsService = createDecorator<IWorkspaceBarAgentsService>('workspaceBarAgentsService');

export class WorkspaceBarAgentsService extends Disposable implements IWorkspaceBarAgentsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private agents = new Map<string, readonly ThemeIcon[]>();

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
