/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal } from '@xterm/headless';
import type { TerminalColours } from '../../ptyd/protocol';

// Loaded as the first hidden tab of a run of an earlier supervisor needs them: every other run has ptyd's answers
const loadXterm = () => require('@xterm/headless') as typeof import('@xterm/headless');
const loadUnicode11 = () => require('@xterm/addon-unicode11') as typeof import('@xterm/addon-unicode11');

/**
 * The questions a program asks its terminal that a headless terminal answers - the device attributes, the terminal's status, the
 * cursor position, a mode, a setting - and the colour questions the window answers: what output already in the screen a stand-in
 * starts from still asks, as that screen holds no question (ARCHITECTURE-2.3).
 */
// eslint-disable-next-line no-control-regex
const QUESTION = /\x1b\[(?:>?0?c|[56]n|\?6n|\??\d+\$p)|\x1bP\$q[^\x1b]*\x1b\\|\x1b\]1[0-2];\?(?:\x07|\x1b\\)/g;

/** How long a stand-in let go answers what it was given at most, should its terminal never finish parsing it. */
const MOST_FINISH_MS = 2_000;

/** A run's screen as ptyd gave it: the number of the last output in it, and the size the run has where known. */
export interface RunScreen {
	readonly screen: string;
	readonly seq: number;
	readonly cols?: number;
	readonly rows?: number;
}

interface Output {
	readonly seq: number;
	readonly data: string;
}

/**
 * What answers the terminal queries of a run of an earlier supervisor - which leaves them to the window - while its tab is hidden
 * (ARCHITECTURE-2.3): a headless terminal starting from the run's screen as its tab is hidden and following the output the window
 * hears, as its editor terminal would - what only an editor knows aside: its kitty keyboard flags, its name, its size in pixels.
 * Each query is answered once. Output that came after the tab's last but is in that screen already has its questions asked again
 * on it; as the tab opens, output waits until the screen the tab draws is known, and what that screen holds is answered here,
 * what follows it by the tab.
 */
export class HiddenAnswers {
	private terminal: Terminal | undefined;
	/** Output heard before the screen it starts from. */
	private waiting: Output[] = [];
	/** Output heard while the tab opens, until the screen the tab draws is known. */
	private held: Output[] | undefined;
	/** The number of the last output written to its terminal. */
	private last = 0;
	/** Writes its terminal has not parsed yet: a stand-in let go answers them first. */
	private writing = 0;
	/** Let go: it takes no more output, and goes once what it was given is answered. */
	private closed = false;
	private disposed = false;
	private finishing: ReturnType<typeof setTimeout> | undefined;

	/** `answer` takes each answer, for the run's program; `colours` are the window's, which a colour question is answered. */
	constructor(private readonly answer: (reply: string) => void, private readonly colours: () => TerminalColours) { }

	/**
	 * Starts from `screen`, in the run's size - else `size`: output heard before it that the screen holds has its questions asked
	 * again, and output after it is written.
	 */
	begin(screen: RunScreen, size?: { readonly cols: number; readonly rows: number }): void {
		if (this.closed || this.terminal) {
			return;
		}
		this.terminal = this.create(screen.cols ?? size?.cols ?? 120, screen.rows ?? size?.rows ?? 30);
		this.put(screen.screen);
		this.last = screen.seq;
		const waiting = this.waiting;
		this.waiting = [];
		for (const each of waiting) {
			if (each.seq > screen.seq) {
				this.write(each);
			} else {
				this.put((each.data.match(QUESTION) ?? []).join(''));
			}
		}
	}

	/** Output numbered `seq`, as the window heard it. */
	output(seq: number, data: string): void {
		if (this.closed) {
			return;
		}
		if (this.held) {
			this.held.push({ seq, data });
		} else if (!this.terminal) {
			this.waiting.push({ seq, data });
		} else {
			this.write({ seq, data });
		}
	}

	/** The tab opens: output waits until the screen it draws is known ({@link handOver}). */
	hold(): void {
		if (!this.closed) {
			this.held ??= [];
		}
	}

	/** The tab draws nothing after all: what waited is answered here, and what follows. */
	resume(): void {
		const held = this.held ?? [];
		this.held = undefined;
		for (const each of held) {
			this.output(each.seq, each.data);
		}
	}

	/**
	 * The tab drew the run's screen as it stood at output `seq`: output up to it is answered here, what follows by the tab, and the
	 * stand-in goes once its last answers are out.
	 */
	handOver(seq: number): void {
		const held = (this.held ?? []).filter(each => each.seq <= seq);
		this.held = undefined;
		if (this.terminal) {
			for (const each of held) {
				this.write(each);
			}
		}
		this.closed = true;
		if (this.writing === 0) {
			this.dispose();
		} else {
			this.finishing = setTimeout(() => this.dispose(), MOST_FINISH_MS);
		}
	}

	dispose(): void {
		this.closed = true;
		this.disposed = true;
		clearTimeout(this.finishing);
		this.terminal?.dispose();
		this.terminal = undefined;
		this.waiting = [];
		this.held = undefined;
	}

	private create(cols: number, rows: number): Terminal {
		const { Terminal } = loadXterm();
		// Its answers need the screen alone: none of the scrollback a person reads
		const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
		// Characters as wide as the window's terminal draws them, by Unicode 11, so that the cursor it reports is where the editor's would be
		const { Unicode11Addon } = loadUnicode11();
		terminal.loadAddon(new Unicode11Addon() as never);
		terminal.unicode.activeVersion = '11';
		// Its colours as the editor's terminal would answer them, which the window knows; a program setting one is the terminal's to follow
		for (const osc of [10, 11, 12] as const) {
			terminal.parser.registerOscHandler(osc, data => {
				if (data !== '?') {
					return false;
				}
				const rgb = this.colours()[osc === 10 ? 'foreground' : osc === 11 ? 'background' : 'cursor'];
				if (rgb) {
					this.reply(`\x1b]${osc};rgb:${rgb}\x1b\\`);
				}
				return true;
			});
		}
		terminal.onData(reply => this.reply(reply));
		return terminal;
	}

	private write(output: Output): void {
		if (output.seq > this.last) {
			this.last = output.seq;
			this.put(output.data);
		}
	}

	/** Writes `data`, counted until its own callback says it is parsed: the terminal may drop an empty write's, so none is made. */
	private put(data: string): void {
		const terminal = this.terminal;
		if (!terminal || !data) {
			return;
		}
		this.writing++;
		terminal.write(data, () => {
			this.writing--;
			if (this.closed && this.writing === 0 && this.terminal === terminal) {
				this.dispose();
			}
		});
	}

	private reply(reply: string): void {
		if (!this.disposed) {
			this.answer(reply);
		}
	}
}
