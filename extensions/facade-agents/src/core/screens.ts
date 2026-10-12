/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../base/async';
import { messageOf } from '../base/errors';
import { AgentTable } from '../record/agents';
import { Agent, AgentState, Caller, describe, End, isLive, namesThePerson, PERSON, StartPhase } from '../record/events';
import { discardScreens, FinalScreen, finalScreenFile, readFinalScreen, writeScreenSnapshot } from '../record/screens';
import { FacadeError } from './errors';
import { InputEffect, Ports, TerminalScreen, Timing } from './ports';

/** How many lines `read_screen` gives where it is not told. */
export const DEFAULT_LINES = 50;
/** The most lines `read_screen` gives, and the most an agent's final screen keeps. */
export const MOST_LINES = 2_000;
/** The most characters of a screen a result holds: past it, every line given goes to a file of its own. */
export const MOST_INLINE_CHARS = 8_000;
/** The most characters `type_text` types at once. */
export const MOST_TYPED = 2_000;
/** The most keys `press_keys` presses at once. */
export const MOST_KEYS = 50;
/** How long after the last input the screen is read for the answer. */
export const ANSWER_DELAY_MS = 2_000;
/** How many lines of the screen an answer to an input, or a failure, gives. */
const ANSWER_LINES = 20;
/** How long an agent that just ended has for its final screen to be written: the window writes it as the terminal goes. */
const FINAL_SCREEN_WAIT_MS = 2_000;
/** How often a final screen still to be written is looked for. */
const FINAL_SCREEN_POLL_MS = 100;

/**
 * The last lines of agent `id`'s screen as a failure or an end says them: what they are, and how to read more of
 * them (AGENT-DEBUGGING.md D6).
 */
export function excerptText(id: number, lines: string): string {
	return `The last lines of its screen, as they were (read_screen #a${id} gives up to ${MOST_LINES} of them):\n${lines}`;
}
/** How many characters of a text typed the log says. */
const LOGGED_CHARS = 40;
/** What a final screen read gives before each part, where it gives both. */
const FRAME_HEADING = '[the last full-screen frame it drew before it left it]';
const FINAL_HEADING = '[its screen as its terminal ended]';

/** What the core gives the screens it reads, and the terminals it types into. */
export interface ScreensContext {
	readonly table: AgentTable;
	readonly ports: Ports;
	/** The screens folder of the workspace's record. */
	readonly dir: string;
	/** How long the core waits, as the person sets it now: a call waits its turn in a terminal no longer than its timeout. */
	timing(): Timing;
	/**
	 * The agent a tool names, as every Facade tool takes one (AGENT-ORCHESTRATION.md, O2): one the caller
	 * reaches (O1) - else refused, saying why.
	 */
	agentNamed(target: string, caller: Caller): Agent;
	/** How long after a paste into an agent's terminal Enter is pressed: its launch's `enterDelay`, as its start had it. */
	enterDelayOf(agent: Agent): number;
	/** A line of Facade's log. */
	log(message: string): void;
	/** A line of the person's history of the agents, `agents.log`: who is about to type or press what where, and what went in (D9). */
	audit(what: string): void;
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
	/** How it ended, for one that ended. */
	readonly end?: End;
	/** Where its start is, for one that has no terminal yet (AGENT-ORCHESTRATION.md, O4). */
	readonly phase?: StartPhase;
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

/** What typing or pressing keys did, and the agent's screen two seconds after. */
export interface InputResult {
	readonly id: number;
	readonly name: string;
	readonly effect: InputEffect;
	/** Its bottom {@link ANSWER_LINES} lines {@link ANSWER_DELAY_MS} after the last input. */
	readonly screen?: ScreenRead;
	/** Why the screen could not be read, where it could not. */
	readonly screenUnavailable?: string;
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
 * Agents looking into agents (AGENT-DEBUGGING.md): an agent's screen read as its terminal draws it, text
 * typed and keys pressed in its terminal as the person types and presses them, and its final screen once
 * it ended. A caller reaches the agents its launch lets it: with YOLO on, every agent of the window; with
 * YOLO off, those of its own tree, ended ones too; the person, every agent. Facade reads a screen only
 * when a tool asks, and decides nothing by what it says: that is the caller's to judge.
 */
export class Screens {

	/** The agents whose screens were deleted as Facade started afresh: `discard`. */
	private readonly discarded = new Set<number>();

	constructor(private readonly context: ScreensContext) { }

	/** The bottom `lines` lines of the screen of the agent `target` names; for one that ended, of its final screen. */
	async read(caller: Caller, target: string, lines = DEFAULT_LINES): Promise<ScreenRead> {
		return this.screenOf(this.reachable(caller, target), lines);
	}

	/** Types `text` into the terminal of the agent `target` names, as one paste, and Enter after it where `enter`. */
	async type(caller: Caller, target: string, text: string, enter: boolean): Promise<InputResult> {
		const chars = [...text];
		const shown = chars.length > LOGGED_CHARS ? `${chars.slice(0, LOGGED_CHARS).join('')}...` : text;
		const doing = `typing ${chars.length} ${chars.length === 1 ? 'character' : 'characters'}, ${JSON.stringify(shown)}${enter ? ', and Enter,' : ''} into`;
		const agent = this.inputTarget(caller, target, doing);
		const timing = this.context.timing();
		return this.input(caller, agent, doing, timing, id => this.context.ports.terminals.type(id, text, {
			enter,
			enterDelayMs: this.context.enterDelayOf(agent),
			queueTimeoutMs: timing.startTimeoutMs
		}));
	}

	/** Presses `keys`, as `keyOf` names them, in the terminal of the agent `target` names. */
	async press(caller: Caller, target: string, keys: readonly string[]): Promise<InputResult> {
		const doing = `pressing ${keys.join(', ')} in`;
		const agent = this.inputTarget(caller, target, doing);
		const timing = this.context.timing();
		return this.input(caller, agent, doing, timing, id => this.context.ports.terminals.keys(id, keys, { queueTimeoutMs: timing.startTimeoutMs }));
	}

	/**
	 * The last {@link ANSWER_LINES} lines of an agent's screen, for the answer to a failure: of its terminal
	 * while it is open, else of its final screen. With `ended`, its terminal just ended, which Facade may
	 * not know yet: its final screen, waited for a moment. Undefined where there are none.
	 */
	async excerptOf(agent: Agent, ended = false): Promise<ScreenRead | undefined> {
		try {
			const now = this.context.table.get(agent.id) ?? agent;
			const read = ended && isLive(now)
				? this.finalScreen(now, ANSWER_LINES, await this.keptScreenOf(now, Date.now()))
				: await this.screenOf(now, ANSWER_LINES);
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

	/** The agent `target` names, which the caller reaches (O1): the person has no terminal (AGENT-DEBUGGING.md, D2). */
	private reachable(caller: Caller, target: string): Agent {
		if (namesThePerson(target)) {
			throw new FacadeError('REFUSED', `The person, ${describe(PERSON)}, has no terminal of Facade's: these tools read and type into agents' terminals.`);
		}
		return this.context.agentNamed(target, caller);
	}

	/**
	 * The agent `target` names, which the caller may type into: one neither stopping nor ended (D9). A refusal is
	 * logged with what it was to be.
	 */
	private inputTarget(caller: Caller, target: string, doing: string): Agent {
		try {
			const agent = this.reachable(caller, target);
			if (agent.end) {
				throw new FacadeError('REFUSED', `${describe(agent)} ended (${agent.end.kind}: ${agent.end.reason}): its terminal takes nothing more. read_screen shows its last screen.`, { outcome: 'not_applied', reason: 'ended' });
			}
			if (agent.state === 'stopping') {
				throw new FacadeError('REFUSED', `${describe(agent)} is being stopped: its terminal takes nothing more.`, { outcome: 'not_applied', reason: 'ended' });
			}
			return agent;
		} catch (err) {
			this.context.log(`${describe(caller)} was refused ${doing} ${JSON.stringify(target)}'s terminal: ${messageOf(err)}`);
			throw err;
		}
	}

	/**
	 * Sends input to an agent's terminal: says in the log what is about to go in, then what did. Answers
	 * with what went in and the screen {@link ANSWER_DELAY_MS} on; fails with what went in, where that was
	 * not all, and with `outcome: unknown` where it cannot be known.
	 */
	private async input(caller: Caller, agent: Agent, doing: string, timing: Timing, send: (id: number) => Promise<InputEffect | undefined>): Promise<InputResult> {
		const who = `${describe(caller)} ${doing} ${describe(agent)}'s terminal`;
		this.context.log(`${who}.`);
		// Written before anything goes in: an intent, not that it went in (D9)
		this.context.audit(who);
		let effect: InputEffect | undefined;
		try {
			effect = await send(agent.id);
		} catch (err) {
			// One the window says outright, nothing gone in; any other leaves what went in unknown
			if (err instanceof FacadeError) {
				this.context.log(`${who}: ${err.message}`);
				this.context.audit(`${who}: nothing went in - ${err.message}`);
				throw err;
			}
			this.context.log(`${who}: what went in is not known: ${messageOf(err)}`);
			this.context.audit(`${who}: what went in is not known`);
			throw new FacadeError('UNAVAILABLE', `Whether it went into ${describe(agent)}'s terminal is not known: ${messageOf(err)}. Read its screen before you type or press anything again.`, { outcome: 'unknown' });
		}
		if (!effect) {
			this.context.log(`${who}: nothing went in, its terminal not there.`);
			this.context.audit(`${who}: nothing went in, its terminal not there`);
			throw this.context.table.get(agent.id)?.state === 'starting'
				? new FacadeError('REFUSED', `${describe(agent)} has no terminal yet: it is still starting. Nothing was typed.`, { outcome: 'not_applied' })
				: new FacadeError('UNAVAILABLE', `${describe(agent)}'s terminal is not there now: the window may still be giving its terminals back after a reload. Nothing was typed; try again in a moment.`, { outcome: 'not_applied' });
		}
		this.context.log(`${who}: ${effectText(effect)}.`);
		this.context.audit(`${who}: ${effectText(effect)}${effect.reason === 'timeout' ? ', its turn not come in time' : effect.reason === 'ended' && effect.outcome !== 'applied' ? ', its terminal ended' : ''}`);
		if (effect.outcome === 'not_applied') {
			const facts = { ...effect, outcome: effect.outcome };
			throw effect.reason === 'timeout'
				? new FacadeError('UNAVAILABLE', `Nothing went into ${describe(agent)}'s terminal: it waited ${Math.round(timing.startTimeoutMs / 1000)} seconds for its turn, behind what the person was typing there or what Facade typed before. Read its screen, then try again.`, facts)
				: new FacadeError('REFUSED', `Nothing went into ${describe(agent)}'s terminal: it ended first. read_screen shows its last screen.`, facts);
		}
		if (effect.outcome === 'partial') {
			const excerpt = await this.excerptOf(agent, true);
			throw new FacadeError('FAILED', `${describe(agent)}'s terminal ended partway: ${effectText(effect)}.${excerpt ? ` Its last lines:\n${excerpt.text}` : ''}`, { ...effect, outcome: effect.outcome, ...(excerpt?.finalScreen ? { finalScreen: excerpt.finalScreen } : {}) });
		}
		await timeout(ANSWER_DELAY_MS);
		try {
			return { id: agent.id, name: agent.name, effect, screen: await this.screenOf(this.context.table.get(agent.id) ?? agent, ANSWER_LINES) };
		} catch (err) {
			return { id: agent.id, name: agent.name, effect, screenUnavailable: messageOf(err) };
		}
	}

	/** The bottom `lines` lines of an agent's screen, or of its final screen once it ended. */
	private async screenOf(agent: Agent, lines: number): Promise<ScreenRead> {
		if (!isLive(agent)) {
			return this.finalScreen(agent, lines, await this.keptScreenOf(agent, agent.end?.time ?? 0));
		}
		const screen = await this.context.ports.terminals.read(agent.id, lines);
		if (screen) {
			return this.liveScreen(agent, lines, screen);
		}
		const now = this.context.table.get(agent.id) ?? agent;
		if (!isLive(now)) {
			return this.screenOf(now, lines);
		}
		// Its worktree being made or set up, or its CLI being launched: no terminal yet (D2)
		if (now.state === 'starting' && now.processId === undefined) {
			return { ...this.base(now, lines), ...(now.phase !== undefined ? { phase: now.phase } : {}), source: 'none', empty: 'not_created', selected: 0, older: false, text: '' };
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

	private base(agent: Agent, requested: number): Pick<ScreenRead, 'id' | 'name' | 'cli' | 'state' | 'end' | 'requested'> {
		return { id: agent.id, name: agent.name, cli: agent.cli, state: agent.state, ...(agent.end ? { end: agent.end } : {}), requested };
	}
}

/**
 * `lines` as one text, at most {@link MOST_INLINE_CHARS} characters of it: past that, the last whole
 * lines that fit, and what that leaves out. A line too long to fit alone is never given whole: its end
 * fills what the lines below it leave - the cursor's blank row, a prompt - and the text says so.
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
	const below = lines.slice(lines.length - kept);
	const over = lines[lines.length - 1 - kept];
	const room = MOST_INLINE_CHARS - length - (kept ? 1 : 0);
	if (over.length > MOST_INLINE_CHARS && room > 0) {
		const text = [[...over].slice(-room).join(''), ...below].join('\n');
		return { text, omitted: { lines: lines.length - kept - 1, chars: whole.length - text.length, partialFirstLine: true } };
	}
	const text = below.join('\n');
	return { text, omitted: { lines: lines.length - kept, chars: whole.length - text.length, partialFirstLine: false } };
}

/** What went in, as the log and an error say it. */
function effectText(effect: InputEffect): string {
	if (effect.keysSent !== undefined) {
		if (effect.outcome === 'applied') {
			return effect.keysSent === 1 ? 'the key went in' : `all ${effect.keysSent} keys went in`;
		}
		return `${effect.keysSent} of its keys went in`;
	}
	return effect.entered ? 'the text went in, and Enter' : effect.pasted ? 'the text went in, without Enter' : 'nothing went in';
}
