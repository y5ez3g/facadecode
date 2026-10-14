/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { isJsonObject } from '../base/json';
import { Agent, describe, End, WorktreeRemoval } from './events';

/** The person's history of a workspace's agents, in its record. */
export const AGENTS_LOG = 'agents.log';

/**
 * What an agent's terminal runs, as the log is given it at its launch: nothing of it is a token - a token's file's path
 * at most. The log writes the values of its environment and files by name alone (AGENT-ORCHESTRATION.md, O11).
 */
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

/**
 * A file's content as the log writes it, on one line: the keys of its JSON, a dot between a key and those under it,
 * without their values - the person's settings may hold a key of theirs, which the log never copies (O11; OR-16).
 */
function keysOf(content: string): string {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return 'invalid JSON; file contents omitted';
	}
	const keys: string[] = [];
	const walk = (at: unknown, under: string) => {
		if (!isJsonObject(at) || !Object.keys(at).length) {
			if (under) {
				keys.push(under);
			}
			return;
		}
		for (const [key, below] of Object.entries(at)) {
			walk(below, under ? `${under}.${key}` : key);
		}
	};
	walk(value, '');
	return `keys: ${keys.length ? keys.join(', ') : 'none'}`;
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
		this.write(`${logTime(agent.startTime)}  recorded ${describe(agent)}  ${agent.cli} ${agent.model ?? 'CLI default model'} ${agent.effort ?? 'CLI default effort'}  YOLO ${agent.yolo ? 'on' : 'off'}  creator ${creator}  folder ${agent.folder}`);
	}

	/**
	 * An agent's CLI launched in its terminal, at `time`: its command line, the variables its launch sets in its
	 * environment, and the files its arguments name - its settings, where it is given a file of them - with their keys
	 * (UI-14). Their values are the person's, a key of theirs among them maybe: those are in the run's plan alone (O11; OR-16).
	 */
	launched(agent: Agent, launch: LoggedLaunch, time: number): void {
		const environment = Object.keys(launch.environment);
		this.write([
			`${logTime(time)}  launched ${describe(agent)}  ${[launch.program, ...launch.args].map(shown).join(' ')}`,
			...environment.length ? [`environment: ${environment.join(' ')}`] : [],
			...launch.files.map(file => `${file.path} ${keysOf(file.content)}`)
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

	/** A worktree's removal with `stop_agent`, asked for by `by`, at `time`: deleted, or not and why (AGENT-ORCHESTRATION.md, O11). */
	removal(removal: WorktreeRemoval, time: number, by: string): void {
		this.write(`${logTime(time)}  ${removal.deleted ? 'deleted' : 'not deleted'}  ${removal.folder}  with stop_agent by ${by}${removal.deleted ? '' : `: ${removal.reason ?? 'no reason given'}`}`);
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
