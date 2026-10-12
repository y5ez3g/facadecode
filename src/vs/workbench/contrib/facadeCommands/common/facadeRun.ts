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

/** The reconnection properties that mark a terminal as made for `run`. */
export function facadeRunProperties(run: IFacadeRun, opened?: IFacadeRunTerminal): IReconnectionProperties {
	return { ownerId: FACADE_RUN_OWNER, data: { workspace: run.workspace, id: run.id, ...(opened?.name ? { name: opened.name } : {}), ...(opened?.folder ? { folder: opened.folder } : {}) } };
}

/**
 * What a run's terminal was opened with, kept with its mark: its name - `@name #aN` - and the folder it is
 * for, so that a terminal taken back for its process after the window crashed reads and is held as it was,
 * not by where the process went since (X-31).
 */
export interface IFacadeRunTerminal {
	readonly name?: string;
	readonly folder?: string;
}

/** What `terminal`'s run's terminal was opened with, as its mark keeps it; undefined for no run's, or one marked before it was kept. */
export function facadeRunTerminalOf(terminal: { readonly reconnectionProperties?: IReconnectionProperties } | undefined): IFacadeRunTerminal | undefined {
	if (!facadeRunOf(terminal)) {
		return undefined;
	}
	const { name, folder } = terminal?.reconnectionProperties?.data as Record<string, unknown>;
	return isString(name) || isString(folder) ? { ...(isString(name) ? { name } : {}), ...(isString(folder) ? { folder } : {}) } : undefined;
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
