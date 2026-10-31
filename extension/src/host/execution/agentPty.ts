/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { messageOf } from '../../base/errors';

/** The most output an unopened terminal keeps for its first draw; beyond it, the run's screen is taken anew as it opens. */
const MOST_UNOPENED = 8 * 1024 * 1024;

/** The most names said for a tab that are still told from a person's as the tab shows them: far more than are ever on their way. */
const MOST_SAID = 32;

/** The most separators and CLI titles a person renaming a tab may have kept from what it showed, newest first. */
const MOST_KEPT = 4;

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
 * as it stands, then each numbered output after it, never one twice. Its tab reads the agent's name and, where the CLI gives
 * one, the native tabs separator and the CLI's title; never a status.
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
	private title: string | undefined;
	private ended = false;
	/** The name the terminal was created with, which the editor gives its tab once more after each open (LIFECYCLE-2.2). */
	private created: string;
	/** Whether the editor's naming of the tab by {@link created} is to come: from each open until it is seen or the agent renamed. */
	private resetDue = false;
	/** The names said for the tab, oldest first, each with its separator and CLI title: dropped once one said after it is seen. */
	private said: { readonly name: string; readonly suffix: string }[] = [];
	/** What the tab was last seen showing. */
	private seen: string;
	/** The separators and CLI titles of its names seen shown, newest first: what a person renaming the tab may have kept of them. */
	private kept: string[] = [];

	constructor(private name: string, private separator: string, private readonly log: (message: string) => void) {
		this.created = name;
		this.seen = name;
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
	 * which claimed the run - else the screen is taken as the terminal opens, or now where it is open.
	 */
	bind(binding: RunBinding, taken?: { readonly screen: string; readonly seq: number }): void {
		this.binding = binding;
		this.applied = undefined;
		if (taken) {
			this.draw(taken.screen, taken.seq);
		} else if (this.opened) {
			this.take();
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

	/** Output numbered `seq`: drawn once, after the screen it follows. */
	output(seq: number, data: string): void {
		if (this.early) {
			this.early.push({ seq, data });
		} else if (this.applied !== undefined && seq > this.applied) {
			this.applied = seq;
			this.write(data);
		}
	}

	/** The run's process ended: a dim line says how, once. */
	exited(text: string): void {
		if (!this.ended) {
			this.ended = true;
			this.write(`\r\n${noteLine(text)}`);
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

	/** The CLI's own title, sanitized; none where it gives none. */
	setTitle(title: string | undefined): void {
		if (title !== this.title) {
			this.title = title;
			this.say();
		}
	}

	/** `terminal.integrated.tabs.separator` changed. */
	setSeparator(separator: string): void {
		if (separator !== this.separator) {
			this.separator = separator;
			this.say();
		}
	}

	/** Gives its tab the name it has again, once open: the editor or a person named the tab otherwise meanwhile (LIFECYCLE-2.2). */
	sayName(): void {
		if (this.opened) {
			this.say();
		}
	}

	/** The tab's name (LIFECYCLE-2.2): the agent's, then the separator and the CLI's title where it gives one. */
	tabName(): string {
		return `${this.name}${this.suffix()}`;
	}

	/** The native terminal's initial name, including an already-known CLI title before VS Code opens the pseudoterminal. */
	creationName(): string {
		this.created = this.tabName();
		this.seen = this.created;
		return this.created;
	}

	/**
	 * The tab shows `title` now (LIFECYCLE-2.2): undefined where that is no change, or a name this terminal said - the editor shows
	 * them in the order they were said, each perhaps late; `reset` where the editor named the tab by the name the terminal was created
	 * with, as it does after each open; else the name the person gave it, without the separator and CLI title they kept.
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
		const at = this.said.findIndex(each => each.name === shown);
		if (at >= 0) {
			// The names said before it are shown already, or never will be
			this.said.splice(0, at);
			const { suffix } = this.said[0];
			if (suffix) {
				this.kept = [suffix, ...this.kept.filter(each => each !== suffix)].slice(0, MOST_KEPT);
			}
			return undefined;
		}
		const suffix = [shownAs(this.suffix()), ...this.kept].find(each => each && shown.endsWith(each));
		return { renamed: suffix ? shown.slice(0, -suffix.length) : shown };
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
			this.writeEmitter.fire(data);
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
		// Closing the tab is the window's to report as the person's close (LIFECYCLE-3.1); nothing ends here
	}

	handleInput(data: string): void {
		if (this.binding && !this.ended) {
			this.binding.input(data);
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
		this.binding = undefined;
		this.writeEmitter.dispose();
		this.nameEmitter.dispose();
	}

	/** The separator and the CLI's title the tab's name ends with; none where the CLI gives no title. */
	private suffix(): string {
		return this.title ? `${this.separator}${this.title}` : '';
	}

	/** Names the tab by {@link tabName}, noting it as said: as the tab shows it, it is not a person's name for it. */
	private say(): void {
		const name = this.tabName();
		this.said.push({ name: shownAs(name), suffix: shownAs(this.suffix()) });
		if (this.said.length > MOST_SAID) {
			this.said.shift();
		}
		this.nameEmitter.fire(name);
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
			if (this.binding === binding) {
				this.draw(screen, seq);
			}
		}, err => {
			this.early = undefined;
			this.log(`Could not show the run's screen: ${messageOf(err)}`);
		});
	}

	/** Draws the run's screen as it stood at output `seq`, then what came after it. */
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
	}

	private write(data: string): void {
		if (this.opened) {
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
