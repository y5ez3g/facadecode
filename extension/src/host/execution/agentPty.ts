/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';
import { MouseReports } from '../../base/mouseReports';
import { TerminalReplies } from '../../base/terminalReplies';
import { SPINNER_FRAMES as FRAMES, spunName } from '../../base/tabSpinner';

/** The most output an unopened terminal keeps for its first draw; beyond it, the run's screen is taken anew as it opens. */
const MOST_UNOPENED = 8 * 1024 * 1024;

/** The window's own questions for an editor terminal's colours: foreground, background and cursor (OSC 10, 11, 12). */
const COLOUR_QUESTIONS = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\';

/** The most names said for a tab that are still told from a person's as the tab shows them: far more than are ever on their way. */
const MOST_SAID = 32;

/** How often a working agent's tab turns its spinner to the next frame (LIFECYCLE-2.2). */
const FRAME_MS = 100;

/** A tab title as the editor shows it, which drops line breaks and tabs from what it is given (LIFECYCLE-2.2). */
function shownAs(title: string): string {
	return title.replace(/[\n\r\t]/g, '');
}

/**
 * What an agent's tab showing a title means (LIFECYCLE-2.2): `reset`, the editor naming it by the name its terminal was created
 * with, as it does after each open of its pseudoterminal; or the name a person gave the tab.
 */
export type TabShown = 'reset' | { readonly renamed: string };

/** What an agent terminal shows of its run's process once it has one: its screen, and what it types. */
export interface RunBinding {
	/** The run's screen as it stands, with the number of the last output in it (ARCHITECTURE-2.3). */
	snapshot(): Promise<{ readonly screen: string; readonly seq: number }>;
	/** What the person typed: straight to the process. */
	input(data: string): void;
	resize(columns: number, rows: number): void;
}

/** A line of Facade's own in the terminal: dim, one line per line of text, no escape sequence of the text's own. */
function noteLine(text: string): string {
	// eslint-disable-next-line no-control-regex
	const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trimEnd());
	return lines.map(line => `\x1b[2m${line}\x1b[0m\r\n`).join('');
}

/**
 * An agent's editor terminal (LIFECYCLE-1.5, 2.2): a Pseudoterminal that exists from the accepted launch on, before any process.
 * It shows Facade's dim progress and failure lines; once the run's process starts, the same terminal shows the run - its screen
 * as it stands, then each numbered output after it, never one twice. Its tab reads only the agent's name; CLI titles and
 * status belong to the panel.
 */
export class AgentPty implements vscode.Pseudoterminal {

	private readonly writeEmitter = new vscode.EventEmitter<string>();
	readonly onDidWrite = this.writeEmitter.event;
	private readonly nameEmitter = new vscode.EventEmitter<string>();
	readonly onDidChangeName = this.nameEmitter.event;
	private opened = false;
	private completeOpen!: (opened: boolean) => void;
	/** VS Code has installed its listeners and opened this pseudoterminal, or it was disposed before that. */
	readonly ready = new Promise<boolean>(resolve => { this.completeOpen = resolve; });
	private size: vscode.TerminalDimensions | undefined;
	/** What waits for the terminal to open: VS Code drops what is written before. */
	private unopened: string[] = [];
	private unopenedLength = 0;
	/** Whether Facade's own lines are on screen, to be scrolled away before the run's screen is drawn. */
	private noted = false;
	private binding: RunBinding | undefined;
	/** The number of the last output drawn; undefined until the run's screen is. */
	private applied: number | undefined;
	/** Output that came while the run's screen was being taken, drawn after it. */
	private early: { seq: number; data: string }[] | undefined;
	/** Whether the run's screen must be taken anew as the terminal opens. */
	private stale = false;
	/** Whether a screen of the run was drawn: drawing another starts from a reset terminal. */
	private drawn = false;
	private ended = false;
	/** The line saying how its process ended, once it did: drawn after the run's screen. */
	private exitLine: string | undefined;
	/** The name the terminal was created with, which the editor gives its tab once more after each open (LIFECYCLE-2.2). */
	private created: string;
	/** Whether the editor's naming of the tab by {@link created} is to come: from each open until it is seen or the agent renamed. */
	private resetDue = false;
	/** The names said for the tab, oldest first: dropped once one said after it is seen. */
	private said: string[] = [];
	/** What the tab was last seen showing. */
	private seen: string;
	/** The mouse reports the person's clicks type, a release the editor could not measure given its press's position (LIFECYCLE-2.2). */
	private readonly mouse = new MouseReports();
	/** The program's questions written to the editor's terminal, by which its answers reach the program or not (ARCHITECTURE-2.3). */
	private readonly replies: TerminalReplies;
	/** Whether its tab spins while the agent works, the frame it shows and what turns it (LIFECYCLE-2.2). */
	private spinning = false;
	private frame = 0;
	private spinner: ReturnType<typeof setInterval> | undefined;

	/**
	 * `still` says whether the editor is to reduce motion: the tab then shows one frame while the agent works (LIFECYCLE-2.2). `learn`
	 * hears each colour the editor's terminal reports, the window's to tell ptyd (ARCHITECTURE-2.3).
	 */
	constructor(private name: string, private readonly log: (message: string) => void, private readonly still: () => boolean = () => false,
		learn?: (osc: '10' | '11' | '12', rgb: string) => void) {
		this.created = name;
		this.seen = name;
		this.replies = new TerminalReplies(learn);
	}

	/**
	 * Asks the editor's terminal for its colours, where it is open: its answers teach the window the colours ptyd answers a program
	 * asking them, and reach no program (ARCHITECTURE-2.3).
	 */
	askColours(): void {
		if (this.opened) {
			this.writeEmitter.fire(COLOUR_QUESTIONS);
		}
	}

	/** Its dimensions, once VS Code gave them. */
	get dimensions(): vscode.TerminalDimensions | undefined {
		return this.size;
	}

	get isOpen(): boolean {
		return this.opened;
	}

	/** Writes a dim line of startup progress or failure (UX-1.1). */
	note(text: string): void {
		this.noted = true;
		this.write(noteLine(text));
	}

	/**
	 * Shows the run's process from now on (ARCHITECTURE-2.3). `taken` is its screen where the caller has it already - a reattach,
	 * which claimed the run - drawn where the terminal is open; else the screen is taken as the terminal opens, or now where it is
	 * open. A terminal not open keeps none of the run's output for later, so it takes the screen anew as it opens.
	 */
	bind(binding: RunBinding, taken?: { readonly screen: string; readonly seq: number }): void {
		this.binding = binding;
		this.applied = undefined;
		if (taken && this.opened) {
			this.draw(taken.screen, taken.seq);
		} else {
			this.early = undefined;
			if (this.opened) {
				this.take();
			}
		}
		if (this.opened && this.size) {
			binding.resize(this.size.columns, this.size.rows);
		}
	}

	/**
	 * A screen of the run is coming - a reattach was asked for, which ptyd answers with its screen after claiming the run: output
	 * that comes before that answer is kept, to be drawn after the screen it follows (ARCHITECTURE-2.3).
	 */
	expectScreen(): void {
		this.early ??= [];
	}

	/** The screen expected will not come: what was kept for it goes, and output is drawn as before. */
	abandonScreen(): void {
		this.early = undefined;
	}

	/**
	 * Output numbered `seq`: drawn once, after the screen it follows, by a terminal open as it comes. A terminal not open does not
	 * keep it for later: replayed, the questions in it - its terminal's colours, its cursor - would be answered long after the program
	 * stopped waiting, and it would read the answer as typed keys, an Escape among them. It takes the run's screen anew as it opens,
	 * which holds no question (ARCHITECTURE-2.3).
	 */
	output(seq: number, data: string): void {
		if (this.early) {
			this.early.push({ seq, data });
		} else if (this.applied !== undefined && seq > this.applied) {
			if (this.opened) {
				this.applied = seq;
				this.write(data);
			} else {
				this.applied = undefined;
				this.stale = true;
			}
		}
	}

	/**
	 * The run's process ended: a dim line says how, after its last screen - now where that is drawn, else after the screen the
	 * terminal draws as it opens - and again after each screen drawn anew.
	 */
	exited(text: string): void {
		if (!this.ended) {
			this.ended = true;
			this.exitLine = `\r\n${noteLine(text)}`;
			// With no screen of the run to come - none bound, as for a run whose supervisor went - it is written as Facade's other lines
			if (!this.binding || (this.opened && this.applied !== undefined)) {
				this.write(this.exitLine);
			}
		}
	}

	/** The agent was renamed: the editor's naming of the tab by the name it was created with is no longer to come for this open. */
	rename(name: string): void {
		if (name !== this.name) {
			this.name = name;
			this.resetDue = false;
			this.say();
		}
	}

	/** Gives its tab the name it has again, once open: the editor or a person named the tab otherwise meanwhile (LIFECYCLE-2.2). */
	sayName(): void {
		if (this.opened) {
			this.say();
		}
	}

	/** The tab's name (LIFECYCLE-2.2): only the agent's display name, which its tab shows after the spinner while it is busy (LIFECYCLE-2.2). */
	tabName(): string {
		return this.name;
	}

	/** Spins a frame before the agent's name on its tab while it is busy, and shows the name alone once it is not (LIFECYCLE-2.2). */
	spin(working: boolean): void {
		if (working === this.spinning) {
			return;
		}
		this.spinning = working;
		clearInterval(this.spinner);
		this.spinner = undefined;
		this.frame = 0;
		if (working && !this.still()) {
			this.turn();
		}
		if (this.opened) {
			this.say();
		}
	}

	/** Whether motion is wanted changed: a busy tab's spinner stops on its frame, or turns again (LIFECYCLE-2.2). */
	motionChanged(): void {
		const still = this.still();
		if (!this.spinning || still === (this.spinner === undefined)) {
			return;
		}
		clearInterval(this.spinner);
		this.spinner = undefined;
		if (!still) {
			this.turn();
		}
	}

	private turn(): void {
		this.spinner = setInterval(() => {
			this.frame = (this.frame + 1) % FRAMES.length;
			if (this.opened) {
				this.nameEmitter.fire(this.titled());
			}
		}, FRAME_MS);
	}

	/** What its tab is given to show: the name, after the spinner's frame while the agent is busy (LIFECYCLE-2.2). */
	private titled(): string {
		return this.spinning ? `${FRAMES[this.frame]} ${this.name}` : this.name;
	}

	/** The native terminal's initial name, set before VS Code opens the pseudoterminal. */
	creationName(): string {
		this.created = this.tabName();
		this.seen = this.created;
		return this.created;
	}

	/**
	 * The tab shows `title` now (LIFECYCLE-2.2): undefined where that is no change, or a name this terminal said - the editor shows
	 * them in the order they were said, each perhaps late; `reset` where the editor named the tab by the name the terminal was created
	 * with, as it does after each open; else the complete name the person gave it.
	 */
	shown(title: string): TabShown | undefined {
		if (title === this.seen) {
			return undefined;
		}
		this.seen = title;
		const shown = shownAs(title);
		if (this.resetDue && shown === shownAs(this.created)) {
			this.resetDue = false;
			return 'reset';
		}
		// The spinner's frame before a name is its own: what the title names is the name after it (LIFECYCLE-2.2)
		const spun = spunName(shown);
		const named = spun ?? shown;
		const at = this.said.indexOf(named);
		if (at >= 0) {
			// The names said before it are shown already, or never will be
			this.said.splice(0, at);
			return undefined;
		}
		if (spun !== undefined && spun === shownAs(this.name)) {
			return undefined;
		}
		return { renamed: named };
	}

	open(dimensions: vscode.TerminalDimensions | undefined): void {
		const reopened = this.opened;
		this.opened = true;
		this.completeOpen(true);
		// The editor names the tab by the name it was created with once its process is ready, after each open - a relaunch's too
		this.resetDue = true;
		this.size = dimensions;
		const waiting = this.unopened;
		this.unopened = [];
		this.unopenedLength = 0;
		for (const data of waiting) {
			this.replies.wrote(data, Date.now());
			this.writeEmitter.fire(data);
		}
		if (!reopened) {
			this.askColours();
		}
		this.say();
		if (this.binding && (reopened || this.applied === undefined && !this.early || this.stale)) {
			// Relaunching the native terminal clears its renderer; the same live run needs its current screen drawn again.
			this.take();
		}
		if (this.binding && dimensions) {
			this.binding.resize(dimensions.columns, dimensions.rows);
		}
	}

	close(): void {
		// Closing the tab is the window's to report as the person's close (LIFECYCLE-3.1); nothing ends here. Its terminal is gone, though:
		// nothing more is written to it, and a terminal opened anew draws the run's screen anew (ARCHITECTURE-2.3)
		if (!this.opened) {
			return;
		}
		this.opened = false;
		this.early = undefined;
		this.applied = undefined;
		this.stale = true;
	}

	/**
	 * What the person typed, and what the editor's terminal answered for the program's questions, straight to its process - but for
	 * the answers ptyd gives itself and those that come too late for the program to wait for them (ARCHITECTURE-2.3).
	 */
	handleInput(data: string): void {
		if (this.binding && !this.ended) {
			const typed = this.mouse.repair(this.replies.typed(data, Date.now()));
			if (typed) {
				this.binding.input(typed);
			}
		}
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.size = dimensions;
		if (this.opened) {
			this.binding?.resize(dimensions.columns, dimensions.rows);
		}
	}

	dispose(): void {
		this.completeOpen(false);
		clearInterval(this.spinner);
		this.spinner = undefined;
		this.binding = undefined;
		this.writeEmitter.dispose();
		this.nameEmitter.dispose();
	}

	/** Names the tab by {@link tabName}, noting it as said: as the tab shows it, it is not a person's name for it. */
	private say(): void {
		const name = this.tabName();
		const said = shownAs(name);
		if (said === shownAs(this.seen)) {
			// The tab shows it already - a person named it so - and no change will say so: the names said before it are over, and a
			// person naming the tab one of them again renames the agent (LIFECYCLE-2.2)
			this.said = [said];
		} else {
			this.said.push(said);
			if (this.said.length > MOST_SAID) {
				this.said.shift();
			}
		}
		this.nameEmitter.fire(this.titled());
	}

	/** Takes the run's screen and draws it; output that comes meanwhile is drawn after it. */
	private take(): void {
		const binding = this.binding;
		if (!binding) {
			return;
		}
		this.stale = false;
		this.early = [];
		binding.snapshot().then(({ screen, seq }) => {
			if (this.binding !== binding) {
				return;
			}
			if (this.opened) {
				this.draw(screen, seq);
			} else {
				// Closed meanwhile: a screen kept for a terminal not open would be drawn twice; the one that opens takes its own
				this.early = undefined;
				this.stale = true;
			}
		}, err => {
			this.early = undefined;
			this.log(`Could not show the run's screen: ${messageOf(err)}`);
			// No screen to follow: the line saying how it ended goes as Facade's other lines do
			if (this.exitLine && this.binding === binding) {
				this.write(this.exitLine);
			}
		});
	}

	/** Draws the run's screen as it stood at output `seq`, then what came after it, then how its process ended where it did. */
	private draw(screen: string, seq: number): void {
		const later = (this.early ?? []).filter(each => each.seq > seq);
		this.early = undefined;
		// A redraw - the connection came back - starts from a reset terminal; Facade's own lines are scrolled away first, so that
		// the run's screen starts where its program's cursor positions expect it (ARCHITECTURE-2.3)
		const before = this.drawn ? '\x1bc' : this.noted ? `${'\r\n'.repeat(this.size?.rows ?? 30)}\x1b[H` : '';
		this.applied = seq;
		this.noted = false;
		this.drawn = true;
		this.write(before + screen);
		for (const each of later) {
			this.output(each.seq, each.data);
		}
		if (this.exitLine) {
			this.write(this.exitLine);
		}
	}

	private write(data: string): void {
		if (this.opened) {
			this.replies.wrote(data, Date.now());
			this.writeEmitter.fire(data);
			return;
		}
		this.unopenedLength += data.length;
		if (this.unopenedLength > MOST_UNOPENED && this.binding) {
			// Too much to keep for a terminal not yet open: its screen is taken anew as it opens
			this.unopened = [];
			this.unopenedLength = 0;
			this.applied = undefined;
			this.drawn = false;
			this.stale = true;
			return;
		}
		this.unopened.push(data);
	}
}
