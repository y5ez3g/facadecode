/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Agent, describe, End } from './events';

/** The person's history of a workspace's agents, in its record. */
export const AGENTS_LOG = 'agents.log';

/** A time as the log writes it: the date and time of day, on this machine's clock. */
function logTime(time: number): string {
	const at = new Date(time);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * The person's history of a workspace's agents: a line for each start and each end, appended, never
 * rewritten, and kept for good, through new lists and new versions alike. It is not the ledger: nothing
 * is replayed from it. A line that cannot be written is left out, and no agent waits on it.
 */
export class AgentLog {

	constructor(readonly file: string) { }

	/** The log of the record in `dir`. */
	static of(dir: string): AgentLog {
		return new AgentLog(path.join(dir, AGENTS_LOG));
	}

	/** An agent started, by `creator`, as Facade's words name it. */
	started(agent: Agent, creator: string): void {
		this.write(`${logTime(agent.startTime)}  started  ${describe(agent)}  ${agent.cli} ${agent.model} ${agent.effort}  by ${creator}  in ${agent.folder}`);
	}

	/** An agent ended: how, by whom - as Facade's words name them - and why, which says its CLI's exit code where it is known. */
	ended(agent: Agent, end: End, by: string | undefined): void {
		this.write(`${logTime(end.time)}  ended    ${describe(agent)}  ${end.kind}${by === undefined ? '' : ` by ${by}`}: ${end.reason}`);
	}

	private write(line: string): void {
		try {
			fs.appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
		} catch {
			// The history is the person's to read, not what agents depend on.
		}
	}
}
