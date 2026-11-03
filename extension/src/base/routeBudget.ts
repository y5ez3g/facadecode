/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isJsonObject } from './json';
import type { RouteRequest, RouteResponse, ServedRoute } from './windowNetwork';

/** A local wait spent the remaining budget. This never cancels an already dispatched operation. */
export class RouteExpired extends Error { }

/** Bound a wait without cancelling a shared connection or initialization needed by other callers. */
export async function withinRoute<T>(pending: PromiseLike<T>, remainingMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([pending, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new RouteExpired()), Math.max(0, remainingMs));
		})]);
	} finally {
		clearTimeout(timer);
	}
}

/** Spend only time observed in this process. No timestamps from different processes are subtracted. */
export function spendRouteTime<T extends RouteRequest | ServedRoute>(request: T, elapsedMs: number): T {
	const spent = Math.max(0, elapsedMs);
	const args = request.args;
	return { ...request, deadlineMs: Math.max(0, request.deadlineMs - spent),
		...(['call', 'deliver'].includes(request.op) && isJsonObject(args) && typeof args.elapsedMs === 'number' && Number.isFinite(args.elapsedMs)
			? { args: { ...args, elapsedMs: args.elapsedMs + spent } } : {}) };
}

/** Refusal before dispatch is different from waiting for a reply to an operation that may already have acted. */
export function expiredRoute(dispatched: boolean): RouteResponse {
	return { ok: false, reason: 'timeout', effects: dispatched ? 'unknown' : 'none', message: dispatched
		? 'The window did not reply before the deadline. Whether the request took effect is unknown.'
		: 'The deadline passed before the request was forwarded. It had no effect.' };
}
