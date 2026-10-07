/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNumber, isObject, isString } from '../../../../base/common/types.js';
import { IReconnectionProperties } from '../../../../platform/terminal/common/terminal.js';

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
 * The owner a terminal made for an agent's run is marked with, in its `reconnectionProperties`: the field
 * upstream built for an owner to mark its terminals, as tasks mark theirs. The pty host keeps the mark
 * with the process, so a reload, a window that crashed and was reopened, and a move within the window
 * find it there, whatever the terminal's title.
 */
const FACADE_RUN_OWNER = 'facade.run';

/** The reconnection properties that mark a terminal as made for `run`. */
export function facadeRunProperties(run: IFacadeRun): IReconnectionProperties {
	return { ownerId: FACADE_RUN_OWNER, data: { workspace: run.workspace, id: run.id } };
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
