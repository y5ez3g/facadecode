/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { withDeadline } from '../base/async';
import { isJsonObject } from '../base/json';

/** The window's answer to whether its previous session ended while it could not reach its remote (M1). */
export const WAS_AWAY_COMMAND = '_facade.window.wasAway';

/**
 * How long the service waits for the window's answer as it recovers: as long as the window waits for the
 * record (`LIVE_WAIT_MS`). The window, just connected and answering the recovery's other calls, reads the
 * answer from its own storage: one this late is no answer, and the latch it consumes on the way is lost.
 */
export const WAS_AWAY_ASK_MS = 30_000;

/**
 * Whether the window's previous session ended while it could not reach its remote: asked once, as the
 * service recovers - one-shot per window load, true at most the first ask. False where the window says not,
 * or has no such command; undefined where it cannot tell - no answer within `waitMs`, or the asking failed -
 * which the service recovers conservatively, saying so: no agent taken to have gone with the window.
 */
export async function windowWasAway(commands: () => Promise<readonly string[]>, ask: () => Promise<unknown>, waitMs: number = WAS_AWAY_ASK_MS): Promise<boolean | undefined> {
	const unanswered = Symbol('unanswered');
	try {
		const answer = await withDeadline<unknown>((async () => (await commands()).includes(WAS_AWAY_COMMAND) ? await ask() : { away: false })(), waitMs, () => unanswered);
		return answer === unanswered ? undefined : isJsonObject(answer) && answer.away === true;
	} catch {
		return undefined;
	}
}
