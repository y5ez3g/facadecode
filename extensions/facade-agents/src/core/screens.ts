/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { AgentCli, isYolo } from '../clis/cli';
import { AgentTable } from '../record/agents';
import { Agent, AgentState, Caller, describe, Exit, isLive, namesThePerson } from '../record/events';
import { discardScreens, FinalScreen, finalScreenFile, readFinalScreen, writeScreenSnapshot } from '../record/screens';
import { FacadeError } from './errors';
import { CliCatalog, Ports, TerminalScreen, Timing } from './ports';

/** How many lines `read_screen` gives where it is not told. */
export const DEFAULT_LINES = 50;
/** The most lines `read_screen` gives, and the most an agent's final screen keeps. */
export const MOST_LINES = 2_000;
/** The most characters of a screen a result holds: past it, every line given goes to a file of its own. */
export const MOST_INLINE_CHARS = 8_000;
/** How many lines of the screen the answer to a failure gives. */
const ANSWER_LINES = 20;
/** How long an agent that just ended has for its final screen to be written: the window writes it as the terminal goes. */
const FINAL_SCREEN_WAIT_MS = 2_000;
/** How often a final screen still to be written is looked for. */
const FINAL_SCREEN_POLL_MS = 100;
/** What a final screen read gives before each part, where it gives both. */
const FRAME_HEADING = '[the last full-screen frame it drew before it left it]';
const FINAL_HEADING = '[its screen as its terminal ended]';

/** What the core gives the screens it reads, and the terminals it types into. */
export interface ScreensContext {
	readonly table: AgentTable;
	readonly ports: Ports;
	readonly clis: CliCatalog;
	/** The screens folder of the workspace's record. */
	readonly dir: string;
	/** How long the core waits, as the person sets it now. */
	timing(): Timing;
	/** A CLI Facade knows, by its id. */
	cliOf(id: string): AgentCli | undefined;
	/** The agent a tool names, as every Facade tool takes one. */
	agentNamed(target: string): Agent;
	/** The name of the terminal an agent runs in. */
	terminalOf(agent: Agent): string;
	/** A line of Facade's log. */
	log(message: string): void;
}

/** A part of a final screen, as a read gives it: how many of its lines, of how many. */
export interface ScreenReadPart {
	readonly kind: 'frame' | 'final';
	readonly lines: number;
	readonly of: number;
}

/**
 * Why a read gives no lines: its terminal not made yet; nothing shown on it yet; no final screen kept of
 * it; its screens deleted with those of the agents that ended before Facade started afresh; or its final
 * screen's file unreadable.
 */
export type EmptyScreen = 'not_created' | 'no_text' | 'not_kept' | 'discarded' | 'unreadable';

/** What a screen read gives: whose, read from where, and the lines. */
export interface ScreenRead {
	readonly id: number;
	readonly name: string;
	readonly cli: string;
	readonly state: AgentState;
	readonly exit?: Exit;
	/**
	 * Where the lines come from: the terminal's normal buffer, with its scrollback; a full-screen program's
	 * alternate buffer; the final screen kept as the terminal ended; none, where there is nothing to read.
	 */
	readonly source: 'normal' | 'alternate' | 'final' | 'none';
	/** Why there is nothing to read, where there is not. */
	readonly empty?: EmptyScreen;
	/** What is wrong with the file of a final screen that could not be read. */
	readonly problem?: string;
	/** When the screen was read, in milliseconds since 1970. */
	readonly capturedAt?: number;
	/** When the terminal last showed new output, where that is known. */
	readonly lastOutput?: number;
	/** For a terminal that runs: whether its process has ended, the terminal kept open, before Facade knows. */
	readonly exited?: boolean;
	/** How many lines were asked for. */
	readonly requested: number;
	/** How many lines the screen gave. */
	readonly selected: number;
	/** Whether the screen has lines above those given. */
	readonly older: boolean;
	/** Whether the terminal let go of lines above all it has: its scrollback is full. */
	readonly trimmed?: boolean;
	/** The lines as text: every line given, or the last of them where they are past {@link MOST_INLINE_CHARS}. */
	readonly text: string;
	/** What the text leaves out of the lines given. */
	readonly omitted?: { readonly lines: number; readonly chars: number; readonly partialFirstLine: boolean };
	/** The file every line given is in, where the text leaves some out of a screen read while it ran. */
	readonly snapshot?: string;
	/** For an agent that ended: the file its final screen is in, where it is there. */
	readonly finalScreen?: string;
	/** For an agent that ended: the parts of its final screen the lines come from. */
	readonly parts?: readonly ScreenReadPart[];
}

/** An ended agent's final screen as its file has it, or why there is none to read. */
interface KeptScreen {
	/** None where there is none to read. */
	readonly screen?: FinalScreen;
	/** Why there is none, where there is none. */
	readonly missing?: 'not_kept' | 'discarded' | 'unreadable';
	/** What is wrong with a file that holds none. */
	readonly problem?: string;
}

/**
 * Agents looking into agents (AGENT-DEBUGGING.md): an agent's screen read as its terminal draws it, and its
 * final screen once it ended. A caller reaches the agents its launch lets it: with YOLO on, every agent of
 * the window; with YOLO off, those of its own tree, ended ones too; the person, every agent. Facade reads a
 * screen only when a tool asks, and decides nothing by what it says: that is the caller's to judge.
 */
export class Screens {

	/** The agents whose screens were deleted as Facade started afresh: `discard`. */
	private readonly discarded = new Set<number>();

	constructor(private readonly context: ScreensContext) { }

	/** The bottom `lines` lines of the screen of the agent `target` names; for one that ended, of its final screen. */
	async read(caller: Caller, target: string, lines = DEFAULT_LINES): Promise<ScreenRead> {
		return this.screenOf(this.reachable(caller, target), lines);
	}

	/**
	 * The last {@link ANSWER_LINES} lines of an agent's screen, for the answer to a failure: of its terminal
	 * while it is open, else of its final screen. Undefined where there are none.
	 */
	async excerptOf(agent: Agent): Promise<ScreenRead | undefined> {
		try {
			const read = await this.screenOf(this.context.table.get(agent.id) ?? agent, ANSWER_LINES);
			return read.selected ? read : undefined;
		} catch (err) {
			this.context.log(`The last lines of ${describe(agent)}'s screen could not be read: ${messageOf(err)}`);
			return undefined;
		}
	}

	/** The file an agent's final screen is written to as its terminal ends. */
	finalScreenOf(agent: { readonly id: number }): string {
		return finalScreenFile(this.context.dir, agent.id);
	}

	/** Deletes the screens kept of the agents `ids`: those that ended before Facade started afresh. */
	discard(ids: ReadonlySet<number>): void {
		for (const id of ids) {
			this.discarded.add(id);
		}
		try {
			const discarded = discardScreens(this.context.dir, ids);
			if (discarded) {
				this.context.log(`Deleted ${discarded} screen files of agents that ended before Facade started again.`);
			}
		} catch (err) {
			this.context.log(`The screens of agents that ended before could not be deleted: ${messageOf(err)}`);
		}
	}

	/** The agent `target` names, which the caller reaches: the person has no terminal. */
	private reachable(caller: Caller, target: string): Agent {
		if (namesThePerson(target)) {
			throw new FacadeError('REFUSED', 'The person, @you, has no terminal of Facade\'s: read_screen reads agents\' terminals.');
		}
		const agent = this.context.agentNamed(target);
		const self = caller.id === undefined ? undefined : this.context.table.get(caller.id);
		if (self && !this.yoloOf(self) && this.rootOf(self) !== this.rootOf(agent)) {
			throw new FacadeError('REFUSED', `${describe(agent)} is outside your tree: you were started with YOLO off, so you reach only the agents of your own tree - the agent the person started it from and every agent started under it, those that ended too.`);
		}
		return agent;
	}

	/** The bottom `lines` lines of an agent's screen, or of its final screen once it ended. */
	private async screenOf(agent: Agent, lines: number): Promise<ScreenRead> {
		if (!isLive(agent)) {
			return this.finalScreen(agent, lines, await this.keptScreenOf(agent, agent.exit?.time ?? 0));
		}
		const screen = await this.context.ports.terminals.read(this.context.terminalOf(agent), lines);
		if (screen) {
			return this.liveScreen(agent, lines, screen);
		}
		const now = this.context.table.get(agent.id) ?? agent;
		if (!isLive(now)) {
			return this.screenOf(now, lines);
		}
		if (now.state === 'starting') {
			return { ...this.base(now, lines), source: 'none', empty: 'not_created', selected: 0, older: false, text: '' };
		}
		throw new FacadeError('UNAVAILABLE', `${describe(now)}'s terminal is not there now: the window may still be giving its terminals back after a reload. Try again in a moment.`);
	}

	/** A screen read from a terminal that runs: past {@link MOST_INLINE_CHARS}, every line in a file of its own too. */
	private liveScreen(agent: Agent, requested: number, screen: TerminalScreen): ScreenRead {
		const read = {
			...this.base(agent, requested),
			source: screen.buffer,
			capturedAt: screen.capturedAt,
			...(screen.lastOutput !== undefined ? { lastOutput: screen.lastOutput } : {}),
			...(screen.exited ? { exited: true } : {})
		};
		if (!screen.lines.length) {
			return { ...read, empty: 'no_text', selected: 0, older: false, text: '' };
		}
		const { text, omitted } = inlinePart(screen.lines);
		return {
			...read,
			selected: screen.lines.length,
			older: screen.older,
			...(screen.trimmed ? { trimmed: true } : {}),
			text,
			...(omitted ? { omitted, snapshot: writeScreenSnapshot(this.context.dir, agent.id, screen.capturedAt, screen.lines) } : {})
		};
	}

	/**
	 * An ended agent's final screen, as its file has it: the newest lines of the screen as its terminal
	 * ended first, then, while lines are left to give, the last frame of a full-screen program that left
	 * it - which a CLI that restores a nearly empty screen as it exits would otherwise hide.
	 */
	private finalScreen(agent: Agent, requested: number, kept: KeptScreen): ScreenRead {
		const base = this.base(agent, requested);
		if (!kept.screen) {
			return { ...base, source: 'none', empty: kept.missing ?? 'not_kept', ...(kept.problem ? { problem: kept.problem } : {}), selected: 0, older: false, text: '' };
		}
		const { final, frame } = kept.screen;
		const fromFinal = final.lines.slice(Math.max(0, final.lines.length - requested));
		const left = requested - fromFinal.length;
		const fromFrame = frame && left > 0 ? frame.slice(Math.max(0, frame.length - left)) : [];
		const both = fromFrame.length > 0 && fromFinal.length > 0;
		const lines = both ? [FRAME_HEADING, ...fromFrame, FINAL_HEADING, ...fromFinal] : [...fromFrame, ...fromFinal];
		const { text, omitted } = inlinePart(lines);
		// The headings are no lines of the screen: what the text leaves out counts its lines alone
		const headingsLeftOut = both && omitted ? [0, fromFrame.length + 1].filter(index => index < omitted.lines).length : 0;
		return {
			...base,
			source: 'final',
			selected: fromFrame.length + fromFinal.length,
			older: final.lines.length > fromFinal.length || (frame?.length ?? 0) > fromFrame.length,
			text,
			...(omitted ? { omitted: { ...omitted, lines: omitted.lines - headingsLeftOut } } : {}),
			finalScreen: this.finalScreenOf(agent),
			parts: [
				...(frame ? [{ kind: 'frame' as const, lines: fromFrame.length, of: frame.length }] : []),
				{ kind: 'final' as const, lines: fromFinal.length, of: final.lines.length }
			]
		};
	}

	/**
	 * An ended agent's final screen, or why there is none: waited for until a moment after `since`, where
	 * it just ended - the window writes it as the terminal goes.
	 */
	private async keptScreenOf(agent: Agent, since: number): Promise<KeptScreen> {
		if (this.discarded.has(agent.id)) {
			return { missing: 'discarded' };
		}
		const file = this.finalScreenOf(agent);
		const until = since + (this.context.timing().finalScreenWaitMs ?? FINAL_SCREEN_WAIT_MS);
		while (true) {
			try {
				const screen = readFinalScreen(file);
				if (screen) {
					return { screen };
				}
			} catch (err) {
				this.context.log(`The final screen of ${describe(agent)} could not be read from ${file}: ${messageOf(err)}`);
				return { missing: 'unreadable', problem: messageOf(err) };
			}
			if (Date.now() >= until) {
				return { missing: 'not_kept' };
			}
			await timeout(FINAL_SCREEN_POLL_MS);
		}
	}

	private base(agent: Agent, requested: number): Pick<ScreenRead, 'id' | 'name' | 'cli' | 'state' | 'exit' | 'requested'> {
		return { id: agent.id, name: agent.name, cli: agent.cli, state: agent.state, ...(agent.exit ? { exit: agent.exit } : {}), requested };
	}

	/** The agent the tree of `agent` grows from: the one the person started, which started the rest, those that ended too. */
	private rootOf(agent: Agent): number {
		let current = agent;
		for (let creator = current.parent === undefined ? undefined : this.context.table.get(current.parent); creator; creator = creator.parent === undefined ? undefined : this.context.table.get(creator.parent)) {
			current = creator;
		}
		return current.id;
	}

	/**
	 * Whether an agent runs with YOLO on, as its launch recorded it: its CLI started with its approvals and
	 * sandbox off. For an agent launched before Facade recorded it, as its CLI's settings say now; off for a
	 * CLI Facade does not know.
	 */
	private yoloOf(agent: Agent): boolean {
		if (agent.yolo !== undefined) {
			return agent.yolo;
		}
		const cli = this.context.cliOf(agent.cli);
		return !!cli && isYolo(this.context.clis.configOf(cli));
	}
}

/**
 * `lines` as one text, at most {@link MOST_INLINE_CHARS} characters of it: past that, the last whole
 * lines that fit - or, where the last line alone does not, its end - and what that leaves out.
 */
function inlinePart(lines: readonly string[]): { readonly text: string; readonly omitted?: { readonly lines: number; readonly chars: number; readonly partialFirstLine: boolean } } {
	const whole = lines.join('\n');
	if (whole.length <= MOST_INLINE_CHARS) {
		return { text: whole };
	}
	let kept = 0;
	let length = 0;
	while (kept < lines.length) {
		const next = lines[lines.length - 1 - kept].length + (kept ? 1 : 0);
		if (length + next > MOST_INLINE_CHARS) {
			break;
		}
		length += next;
		kept++;
	}
	if (!kept) {
		const text = [...lines[lines.length - 1]].slice(-MOST_INLINE_CHARS).join('');
		return { text, omitted: { lines: lines.length - 1, chars: whole.length - text.length, partialFirstLine: true } };
	}
	const text = lines.slice(lines.length - kept).join('\n');
	return { text, omitted: { lines: lines.length - kept, chars: whole.length - text.length, partialFirstLine: false } };
}
