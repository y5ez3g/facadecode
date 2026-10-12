/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Agent, describe, End } from './events';

/** The person's history of a workspace's agents, in its record. */
export const AGENTS_LOG = 'agents.log';

/** What an agent's terminal runs, as the log writes it at its launch: nothing of it is a token - a token's file's path at most. */
export interface LoggedLaunch {
	readonly program: string;
	readonly args: readonly string[];
	/** What its launch sets in its environment: not Facade's own variables. */
	readonly environment: { readonly [name: string]: string };
	/** The files its arguments name, as its launch wrote them: its settings, where it is given a file of them. */
	readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** A word of a command line as the log writes it: as it is, where it is one plain word, else quoted as JSON quotes a string. */
function shown(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word);
}

/** A file's content on one line: JSON as JSON writes it compactly, anything else quoted. */
function oneLine(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content));
	} catch {
		return JSON.stringify(content);
	}
}

/** A time as the log writes it: the date and time of day, on this machine's clock. */
function logTime(time: number): string {
	const at = new Date(time);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * The person's history of a workspace's agents - its lifecycle and debug audit log (AGENT-LAUNCHER.md, L5): a line
 * for each start, launch, connection, start completed and end, appended, never
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
		this.write(`${logTime(agent.startTime)}  started  ${describe(agent)}  ${agent.cli} ${agent.model ?? 'its own model'} ${agent.effort ?? 'its own effort'}  YOLO ${agent.yolo ? 'on' : 'off'}  by ${creator}  in ${agent.folder}`);
	}

	/**
	 * An agent's CLI launched in its terminal, at `time`: its command line, what its launch sets in its environment,
	 * and the files its arguments name - its settings, where it is given a file of them - as written (UI-14).
	 */
	launched(agent: Agent, launch: LoggedLaunch, time: number): void {
		const environment = Object.entries(launch.environment).map(([name, value]) => `${name}=${shown(value)}`);
		this.write([
			`${logTime(time)}  launched ${describe(agent)}  ${[launch.program, ...launch.args].map(shown).join(' ')}`,
			...environment.length ? [`environment ${environment.join(' ')}`] : [],
			...launch.files.map(file => `${file.path} ${oneLine(file.content)}`)
		].join('  '));
	}

	/** An agent's MCP server said hello, at `time`: it is connected (AGENT-LAUNCHER.md, L6: connection is a fact of its own). */
	connected(agent: Agent, time: number): void {
		this.write(`${logTime(time)}  connected ${describe(agent)}`);
	}

	/** An agent started, at `time`: it runs - its task told, where it has one (L6: starting -> running). */
	running(agent: Agent, time: number): void {
		this.write(`${logTime(time)}  running  ${describe(agent)}`);
	}

	/** An agent ended: how, by whom - as Facade's words name them - and why, which says its CLI's exit code where it is known. */
	ended(agent: Agent, end: End, by: string | undefined): void {
		this.write(`${logTime(end.time)}  ended    ${describe(agent)}  ${end.kind}${by === undefined ? '' : ` by ${by}`}: ${end.reason}`);
	}

	/**
	 * Input into an agent's terminal, at `time` (AGENT-DEBUGGING.md, D9): who is about to type or press what where -
	 * before anything goes in - and then what went in, or that it is not known. `what` is one line: its text quoted.
	 */
	input(time: number, what: string): void {
		this.write(`${logTime(time)}  input    ${what}`);
	}

	private write(line: string): void {
		try {
			fs.appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
		} catch {
			// The history is the person's to read, not what agents depend on.
		}
	}
}
