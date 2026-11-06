/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a run's CLI reports, as activity (CLIS-2.3, RULES-3.2). Only the root process's OSC 7501 reports count; a run counts as
// reporting once its CLI takes part in the protocol - it asked whether the terminal takes reports, or sent a valid one - whatever
// its version (CLIS-2.3). Without that its activity is unknown, which the card shows red with the reason once its run's startup is
// over (CLIS-2.3): a quiet screen proves nothing. Neither a report's title nor its terminal's (OSC 0/2) is shown: a run's title is
// its conversation's, as its CLI keeps it (CLIS-2.4).

import { displayLine } from '../base/text';
import { BUILT_IN_ADAPTERS } from './catalog';

/** A report's status, as ptyd keeps it for a run (OSC 7501): its state, what it waits for and its words. */
export interface ReportedStatus {
	readonly state: 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'pending';
	/** Pending because the CLI asked whether the terminal takes reports and has not reported yet. */
	readonly negotiating?: true;
	readonly unavailable?: 'screen_unrecognized' | 'screen_reset';
	readonly kind?: 'permission' | 'question' | 'auth';
	readonly msg?: string;
}

/** Activity as a run's reports establish it (RULES-3.1, 3.2). */
export interface ActivityFacts {
	readonly activity: 'working' | 'not_working' | 'unknown';
	/** Whether this run's CLI has taken part in the protocol (CLIS-2.3). */
	readonly reporting: boolean;
	/** Why activity is unknown: the CLI never reported, has not reported yet, or took its report back. */
	readonly unknown?: 'not_reporting' | 'waiting' | 'cleared' | 'screen_unrecognized' | 'screen_reset';
	readonly blocker?: { readonly kind: 'permission' | 'question' | 'auth' | 'unknown'; readonly text?: string };
	/** A known error the CLI reported, in its own words where it gave some. */
	readonly error?: { readonly text?: string };
}

/** Keep the complete bounded CLI text for the accessible label; card width is handled by CSS (CLIS-2.3). */
export const MOST_SHOWN = 4096;

/**
 * The activity `status` establishes (CLIS-2.3): working → working; idle, done and blocked → not working, a blocker with what it
 * waits for; error → a known error; a pending probe, a clear or a reset → unknown. No status at all: the CLI does not report.
 */
export function activityOf(status: ReportedStatus | undefined): ActivityFacts {
	if (!status) {
		return { activity: 'unknown', reporting: false, unknown: 'not_reporting' };
	}
	const text = status.msg === undefined ? undefined : displayLine(status.msg, MOST_SHOWN) || undefined;
	switch (status.state) {
		case 'working':
			return { activity: 'working', reporting: true };
		case 'idle':
		case 'done':
			return { activity: 'not_working', reporting: true };
		case 'blocked':
			return { activity: 'not_working', reporting: true, blocker: { kind: status.kind ?? 'unknown', ...text ? { text } : {} } };
		case 'error':
			return { activity: 'not_working', reporting: true, error: text ? { text } : {} };
		case 'pending':
			return { activity: 'unknown', reporting: true, unknown: status.unavailable ?? (status.negotiating ? 'waiting' : 'cleared') };
	}
}

/**
 * Whether an exit was the CLI's own handling of an interrupt the person typed, as its adapter verifies it (RULES-3.3); without an
 * adapter, it never is.
 */
export function interruptVerified(cli: string, exit: { readonly code?: number; readonly signal?: string; readonly ctrlC: boolean }): boolean {
	return BUILT_IN_ADAPTERS.find(adapter => adapter.id === cli)?.interruptExit(exit) ?? false;
}
