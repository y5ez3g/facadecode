/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExtUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IRunningWork } from './workspaceBarAgents.js';
import { folderRowNameFor, IWorkspaceBarCustomizationService, worktreeNameFor } from './workspaceBarCustomization.js';
import { findWorktree, IWorkspaceBarRepository } from './workspaceBarGit.js';

/** How many lines a list of a question shows before it counts the rest, as VS Code's lists of files do. */
const LISTED = 10;

/**
 * Where the folder at `uri` is, for a line of a question that lists what a close would stop or lose (WORKSPACE.md
 * W10.7), by the names the bar gives its rows: a worktree after the repository whose row it hangs under - `lab
 * (worktree: w2)` - any other folder by its row's name. `folder` is the workspace's folder there, when there is one.
 */
export function placeNameFor(customizationService: Pick<IWorkspaceBarCustomizationService, 'nameFor' | 'get'>, uri: URI, folder: IWorkspaceFolder | undefined, repository: IWorkspaceBarRepository | undefined, extUri: IExtUri): string {
	const worktree = findWorktree(repository, uri, extUri);
	return repository && worktree
		? localize('workspaceBar.worktreePlace', "{0} (worktree: {1})", folderRowNameFor(customizationService, repository.main, repository.folder), worktreeNameFor(customizationService, worktree))
		: folderRowNameFor(customizationService, uri, folder);
}

/** An agent's line - `Agent @claude #a1` - or a terminal's - `Terminal (npm run dev)` - with ` · ` and its place where the question names places. */
export function workLine(work: Pick<IRunningWork, 'kind' | 'name'>, place: string | undefined): string {
	if (work.kind === 'agent') {
		return place
			? localize('workspaceBar.agentLineAt', "Agent {0} · {1}", work.name, place)
			: localize('workspaceBar.agentLine', "Agent {0}", work.name);
	}
	return place
		? localize('workspaceBar.terminalLineAt', "Terminal ({0}) · {1}", work.name, place)
		: localize('workspaceBar.terminalLine', "Terminal ({0})", work.name);
}

/** A file's line: its name, with ` · ` and its place where the question names places. */
export function fileLine(name: string, place: string | undefined): string {
	return place ? localize('workspaceBar.fileLineAt', "{0} · {1}", name, place) : name;
}

/** `work` in the order a question lists it: the agents first, then the terminals, each in the order given. */
export function agentsFirst<T extends Pick<IRunningWork, 'kind'>>(work: readonly T[]): T[] {
	return [...work.filter(item => item.kind === 'agent'), ...work.filter(item => item.kind !== 'agent')];
}

/** What says, above the lines of `work`, that it will stop: agents and terminals counted apart, as the lines name them. */
export function terminatedHeading(work: readonly Pick<IRunningWork, 'kind'>[]): string {
	const agents = work.filter(item => item.kind === 'agent').length;
	const terminals = work.length - agents;
	if (agents && terminals) {
		return localize('workspaceBar.agentsAndTerminalsTerminated', "The following agents and terminals will be terminated:");
	}
	if (agents) {
		return agents === 1
			? localize('workspaceBar.agentTerminated', "The following agent will be terminated:")
			: localize('workspaceBar.agentsTerminated', "The following agents will be terminated:");
	}
	return terminals === 1
		? localize('workspaceBar.terminalTerminated', "The following terminal will be terminated:")
		: localize('workspaceBar.terminalsTerminated', "The following terminals will be terminated:");
}

/** What says, above the lines of `count` unsaved files, that their changes will be discarded. */
export function discardedHeading(count: number): string {
	return count === 1
		? localize('workspaceBar.fileDiscarded', "The following file has unsaved changes that will be discarded:")
		: localize('workspaceBar.filesDiscarded', "The following files have unsaved changes that will be discarded:");
}

/** `lines` - agents' and terminals' - ten at most, then how many more there are, in VS Code's words for the files it does not list. */
export function listedSessions(lines: readonly string[]): string[] {
	return listed(lines, count => count === 1
		? localize('workspaceBar.oneMoreSession', "...1 additional session not shown")
		: localize('workspaceBar.moreSessions', "...{0} additional sessions not shown", count));
}

/** `lines` - files' - ten at most, then how many more there are, in VS Code's words. */
export function listedFiles(lines: readonly string[]): string[] {
	return listed(lines, count => count === 1
		? localize('workspaceBar.oneMoreFile', "...1 additional file not shown")
		: localize('workspaceBar.moreFiles', "...{0} additional files not shown", count));
}

/** `lines`, ten at most, then the line `more` makes of how many it left out. */
function listed(lines: readonly string[], more: (count: number) => string): string[] {
	return lines.length > LISTED ? [...lines.slice(0, LISTED), more(lines.length - LISTED)] : [...lines];
}
