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

/** Something running in a folder that taking the folder out of the workspace stops (WORKSPACE.md W9.6). */
export interface IRunningWork {
	/** The same for as long as it runs: what a confirmation named is told apart from what started since. */
	readonly id: number;
	readonly kind: 'agent' | 'terminal';
	/** What its tab is called. */
	readonly name: string;
}

/** Says what runs in a folder now (`IWorkspaceBarAgentsService.registerWorkProvider`). */
export interface IRunningWorkProvider {
	/** The agents running in `folder`, and its terminals running a process, oldest first. */
	workIn(folder: URI): readonly IRunningWork[];
}

/** What runs in each folder, told by the agent launchers, which reach the terminals the bar cannot (WORKTREE.md WT-1.15). */
export interface IWorkspaceBarAgentsService {
	readonly _serviceBrand: undefined;

	/** Fires when what runs in some folder has changed. */
	readonly onDidChange: Event<void>;

	/** The icons of the agents running in `folder`, oldest first: none for a folder that runs none. */
	agentsIn(folder: URI): readonly ThemeIcon[];

	/** Says what runs in every folder, replacing what was said before: a folder left out runs none. */
	set(agents: readonly IFolderAgents[]): void;

	/** What runs in `folder` now, for a confirmation to name before stopping it. */
	workIn(folder: URI): readonly IRunningWork[];

	/** Answers `workIn` from now on, until disposed. */
	registerWorkProvider(provider: IRunningWorkProvider): IDisposable;
}

export const IWorkspaceBarAgentsService = createDecorator<IWorkspaceBarAgentsService>('workspaceBarAgentsService');

export class WorkspaceBarAgentsService extends Disposable implements IWorkspaceBarAgentsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private agents = new Map<string, readonly ThemeIcon[]>();

	private provider: IRunningWorkProvider | undefined;

	constructor(@IUriIdentityService private readonly uriIdentityService: IUriIdentityService) {
		super();
	}

	agentsIn(folder: URI): readonly ThemeIcon[] {
		return this.agents.get(this.uriIdentityService.extUri.getComparisonKey(folder)) ?? [];
	}

	workIn(folder: URI): readonly IRunningWork[] {
		return this.provider?.workIn(folder) ?? [];
	}

	registerWorkProvider(provider: IRunningWorkProvider): IDisposable {
		this.provider = provider;
		return toDisposable(() => {
			if (this.provider === provider) {
				this.provider = undefined;
			}
		});
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
