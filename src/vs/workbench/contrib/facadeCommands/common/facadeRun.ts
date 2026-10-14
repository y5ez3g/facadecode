/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNumber, isObject, isString } from '../../../../base/common/types.js';
import { FACADE_RUN_OWNER, IReconnectionProperties } from '../../../../platform/terminal/common/terminal.js';

/** An agent's run: the record of its workspace, by the record's id, and the agent's number in that record. */
export interface IFacadeRun {
	readonly workspace: string;
	readonly id: number;
}

/** Whether `candidate` is an `IFacadeRun`: a record's id, and a number from 1 up. */
export function isFacadeRun(candidate: unknown): candidate is IFacadeRun {
	if (!isObject(candidate)) {
		return false;
	}

	const { workspace, id } = candidate as Record<string, unknown>;
	return isString(workspace) && !!workspace && isNumber(id) && Number.isInteger(id) && id > 0;
}

/**
 * An agent the agents' extension says is live that has no terminal yet: its worktree being made, or its setup running
 * (AGENT-ORCHESTRATION.md, O4) - counted on the agent button and listed among the active agents (AGENT-LAUNCHER.md, L3).
 */
export interface IPreparingRun {
	/** Its number in the record: the agent's `N` in `@name #aN`. */
	readonly id: number;
	/** Its name, as `@name #aN` writes it, without the `@`. */
	readonly name: string;
	/** What it is doing: making its worktree, or running the worktree's setup. */
	readonly phase: 'creating_worktree' | 'running_setup';
	/** Its worktree, once made. */
	readonly folder?: string;
}

/** Whether `candidate` is an `IPreparingRun`. */
export function isPreparingRun(candidate: unknown): candidate is IPreparingRun {
	if (!isObject(candidate)) {
		return false;
	}

	const { id, name, phase, folder } = candidate as Record<string, unknown>;
	return isNumber(id) && Number.isInteger(id) && id > 0 && isString(name) && (phase === 'creating_worktree' || phase === 'running_setup') && (folder === undefined || isString(folder));
}

/** The reconnection properties that mark a terminal as made for `run`. */
export function facadeRunProperties(run: IFacadeRun, opened?: IFacadeRunTerminal): IReconnectionProperties {
	return { ownerId: FACADE_RUN_OWNER, data: { workspace: run.workspace, id: run.id, ...(opened?.name ? { name: opened.name } : {}), ...(opened?.folder ? { folder: opened.folder } : {}), ...(opened?.finalScreen ? { finalScreen: opened.finalScreen } : {}) } };
}

/**
 * What a run's terminal was opened with, kept with its mark: its name - `@name #aN` - and the folder it is
 * for, so that a terminal taken back for its process after the window crashed reads and is held as it was,
 * not by where the process went since (X-31); and the file its final screen goes to, so that one given back
 * after a reload keeps it before the agents' extension registers it again (AGENT-DEBUGGING.md, D6; DB-05).
 */
export interface IFacadeRunTerminal {
	readonly name?: string;
	readonly folder?: string;
	/** The final screen's file, as a URI's string. */
	readonly finalScreen?: string;
}

/** What `terminal`'s run's terminal was opened with, as its mark keeps it; undefined for no run's, or one marked before it was kept. */
export function facadeRunTerminalOf(terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined): IFacadeRunTerminal | undefined {
	if (!facadeRunOf(terminal)) {
		return undefined;
	}
	const { name, folder, finalScreen } = terminal?.reconnectionProperties?.data as Record<string, unknown>;
	return isString(name) || isString(folder) || isString(finalScreen) ? { ...(isString(name) ? { name } : {}), ...(isString(folder) ? { folder } : {}), ...(isString(finalScreen) ? { finalScreen } : {}) } : undefined;
}

/** The run a terminal - or a process the pty host holds - was made for, by its mark; undefined for any other. */
export function facadeRunOf(terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined): IFacadeRun | undefined {
	const properties = terminal?.reconnectionProperties;
	return properties?.ownerId === FACADE_RUN_OWNER && isFacadeRun(properties.data) ? { workspace: properties.data.workspace, id: properties.data.id } : undefined;
}

/**
 * Whether a terminal is an agent's run's: kept in its window - no Detach Session, no moving into another
 * window - never relaunched, and never revived.
 */
export function isFacadeRunTerminal(terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined): boolean {
	return facadeRunOf(terminal) !== undefined;
}
