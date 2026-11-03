/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RunFacts } from './ports';

/**
 * A run's dot (RULES-3.2, D183): red where something is wrong - an error, an end, Facade tools it cannot use or a start that did not
 * become ready within its bound - green while it starts or works, and none for anything else, a native question waiting for the
 * person included. Red before green; its tab's spinner turns while it is green (D185).
 */
export function dotOf(facts: RunFacts): 'working' | 'error' | 'none' {
	if (facts.error || facts.lifecycle === 'ended') {
		return 'error';
	}
	// What waits for the person is said on the second line, whatever else holds: answering it is what the person can do now
	if (facts.blocker) {
		return 'none';
	}
	if (facts.tools === 'unavailable' || facts.notReady) {
		return 'error';
	}
	const working = facts.lifecycle === 'running' && facts.reporting && facts.activity === 'working';
	return facts.lifecycle === 'starting' || facts.awaitingActivity || working ? 'working' : 'none';
}
