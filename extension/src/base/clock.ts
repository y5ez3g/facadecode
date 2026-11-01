/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { performance } from 'perf_hooks';

/**
 * This process's monotonic time, in milliseconds: what every deadline held within the process is a time of - never the wall clock,
 * which may be stepped while a deadline waits (ARCHITECTURE-2.3).
 */
export function monotonic(): number {
	return performance.now();
}
