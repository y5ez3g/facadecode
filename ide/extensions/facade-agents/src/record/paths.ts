/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

/** The variable that puts Facade's home elsewhere, for a test window beside the person's own (AGENT-ORCHESTRATION.md, O8). */
export const FACADE_HOME_VARIABLE = 'FACADE_HOME';

/**
 * Facade's home: `~/.facade`, or the folder `FACADE_HOME` names. Windows under different homes do not see each other
 * (AGENT-ORCHESTRATION.md, O1, O8).
 */
export function facadeHome(env: NodeJS.ProcessEnv = process.env): string {
	const named = env[FACADE_HOME_VARIABLE];
	return named && path.isAbsolute(named) ? named : path.join(os.homedir(), '.facade');
}

/** Where each workspace's record is: `<Facade's home>/workspaces/<its id>`. */
export function workspacesRoot(): string {
	return path.join(facadeHome(), 'workspaces');
}

/** Where Facade makes worktrees: `<Facade's home>/worktrees` (WORKTREE.md WT-2.1). */
export function worktreesRoot(): string {
	return path.join(facadeHome(), 'worktrees');
}

/** The machine's counters of agent and message numbers (AGENT-LAUNCHER.md, L12). */
export function countersFile(): string {
	return path.join(facadeHome(), 'counters.json');
}

/** The secret windows of the machine call each other with (AGENT-ORCHESTRATION.md, O8). */
export function windowKeyFile(): string {
	return path.join(facadeHome(), 'window.key');
}

/** Where the notices one workspace leaves for another wait, one folder per record (O8). */
export function outboxRoot(): string {
	return path.join(facadeHome(), 'outbox');
}

/** Where the machine's chat rooms are (AGENT-MESSAGES.md, M9). */
export function roomsRoot(): string {
	return path.join(facadeHome(), 'rooms');
}

/** Where the deletion marks of worktrees being deleted are (WORKTREE.md WT-8). */
export function deletionsRoot(): string {
	return path.join(facadeHome(), 'deleting');
}

/** Where the per-repository locks of worktree creation are (AGENT-ORCHESTRATION.md, O4). */
export function repositoryLocksRoot(): string {
	return path.join(facadeHome(), 'repositories');
}

/**
 * The record of the files Facade put into folders, which every window shares: always `~/.facade/injected.json`, whatever
 * Facade's home - it describes the person's own files, which a test window and the person's may share (O8, O10).
 */
export function injectedFile(): string {
	return path.join(os.homedir(), '.facade', 'injected.json');
}
