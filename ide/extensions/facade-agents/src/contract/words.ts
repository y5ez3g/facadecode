/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A time as a tool's result gives it: the time of day, on this machine's clock. */
export function timeOfDay(time: number): string {
	return new Date(time).toTimeString().slice(0, 8);
}
