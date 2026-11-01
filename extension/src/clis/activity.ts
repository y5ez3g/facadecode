/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a run's CLI reports, as activity and title (CLIS-2.3, RULES-3.2). Only the root process's OSC 7501 reports count; a run
// counts as reporting once its CLI takes part in the protocol - it asked whether the terminal takes reports, or sent a valid
// one - whatever its version (CLIS-2.3). Without that its activity is unknown, which the card shows red with the reason once its
// run's startup is over (D81): a quiet screen proves nothing. Titles are the CLI's own words, sanitized and capped, the report's
// preferred over OSC 0/2.

import { displayLine } from '../base/text';
import { BUILT_IN_ADAPTERS } from './catalog';

/** A report's status, as ptyd keeps it for a run (OSC 7501): its state, what it waits for, its words and its title. */
export interface ReportedStatus {
	readonly state: 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'pending';
	/** Pending because the CLI asked whether the terminal takes reports and has not reported yet. */
	readonly negotiating?: true;
	readonly kind?: 'permission' | 'question' | 'auth';
	readonly msg?: string;
	readonly title?: string;
}

/** Activity as a run's reports establish it (RULES-3.1, 3.2). */
export interface ActivityFacts {
	readonly activity: 'working' | 'not_working' | 'unknown';
	/** Whether this run's CLI has taken part in the protocol (CLIS-2.3). */
	readonly reporting: boolean;
	/** Why activity is unknown: the CLI never reported, has not reported yet, or took its report back. */
	readonly unknown?: 'not_reporting' | 'waiting' | 'cleared';
	readonly blocker?: { readonly kind: 'permission' | 'question' | 'auth'; readonly text?: string };
	/** A known error the CLI reported, in its own words where it gave some. */
	readonly error?: { readonly text?: string };
}

/** The most code points of a title or status text a run shows (CLIS-2.3). */
export const MOST_SHOWN = 300;

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
			return { activity: 'not_working', reporting: true, ...status.kind ? { blocker: { kind: status.kind, ...text ? { text } : {} } } : {} };
		case 'error':
			return { activity: 'not_working', reporting: true, error: text ? { text } : {} };
		case 'pending':
			return { activity: 'unknown', reporting: true, unknown: status.negotiating ? 'waiting' : 'cleared' };
	}
}

/**
 * The title a run shows for its CLI (CLIS-2.3, D126): the report's nonempty title over the terminal's OSC 0/2 title, with visible
 * symbols and words intact. Invisible formatting and controls removed, at most 300 code points with an ellipsis.
 */
export function cliTitle(titles: { readonly reported?: string; readonly terminal?: string }): string | undefined {
	for (const raw of [titles.reported, titles.terminal]) {
		const text = displayLine(raw ?? '', MOST_SHOWN);
		if (text) {
			return text;
		}
	}
	return undefined;
}

/**
 * Whether an exit was the CLI's own handling of an interrupt the person typed, as its adapter verifies it (RULES-3.3); without an
 * adapter, it never is.
 */
export function interruptVerified(cli: string, exit: { readonly code?: number; readonly signal?: string; readonly ctrlC: boolean }): boolean {
	return BUILT_IN_ADAPTERS.find(adapter => adapter.id === cli)?.interruptExit(exit) ?? false;
}
