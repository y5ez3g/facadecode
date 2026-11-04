/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What an editor terminal answers for the questions a program asks it, kept from the program unless it is the answer it waits
// for, now (ARCHITECTURE-2.3). VS Code's terminal answers a question as it draws it, and its answer comes back to the program through
// the window and ptyd: for a terminal behind other tabs that is when its tab is opened, and for any terminal on a busy machine it can
// pass the moment a program waits - Codex 200 to 300 ms. A program that stopped waiting reads the answer as typed keys: an Escape that
// interrupts its turn, then `]10;rgb:cccc/cccc/cccc\` in its input, as Codex did on 2026-11-03. So ptyd answers, at once, what its
// headless terminal can - the cursor position, the device attributes, the terminal's status, a mode, a setting - and the colours, with
// the window's: the editor's answers to those reach no program, its colours only teach the window what they are. What only the
// editor knows - its kitty keyboard flags, its name, its size in pixels - reaches the program where the editor answers promptly.

/** How soon after such a question was written to the terminal its answer still reaches the program: VS Code answers within ~120 ms. */
export const FRESH_REPLY_MS = 150;

/** The questions only the editor's terminal answers, each by the kind of its answer. */
const QUESTIONS: readonly (readonly [RegExp, string])[] = [
	// eslint-disable-next-line no-control-regex
	[/\x1b\[\?u/g, 'kitty'],
	// eslint-disable-next-line no-control-regex
	[/\x1b\[>0?q/g, 'version'],
	// eslint-disable-next-line no-control-regex
	[/\x1b\[=0?c/g, 'unit'],
	// XTWINOPS reports: sizes and positions in pixels or cells, the window's state, its title
	// eslint-disable-next-line no-control-regex
	[/\x1b\[(?:1[134-689]|2[01])t/g, 'window']
];
/** A cursor position question, DSR 6: its answer has a modified F3 key's shape - Ctrl+F3 is `ESC [ 1 ; 5 R`. */
// eslint-disable-next-line no-control-regex
const CURSOR_QUESTION = /\x1b\[6n/g;

/**
 * Each answer a terminal types: a colour report, its colour captured; the cursor position, plain or DECXCPR's; the terminal's status;
 * primary, secondary and tertiary device attributes; a mode report (DECRPM); a setting (DECRQSS); the kitty keyboard flags; the
 * terminal's name and version (XTVERSION); a window report (XTWINOPS). None of them is a key but the plain cursor position's.
 */
// eslint-disable-next-line no-control-regex
const ANSWER = /\x1b\](?:(1[0-2])|4;\d+);rgb:([0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4})(?:\x07|\x1b\\)|\x1b\[(\?)?\d+;\d+(?:;\d+)?R|\x1b\[[03]n|\x1b\[[?>][\d;]*c|\x1b\[\??\d+;\d+\$y|\x1bP[01]\$r[^\x1b]*\x1b\\|\x1b\[\?\d+u|\x1bP>\|[^\x1b]*\x1b\\|\x1bP!\|[^\x1b]*\x1b\\|\x1b\[\d+(?:;\d+){1,2}t/g;

/** The kind of `answer` among the questions only the editor answers; undefined for one ptyd answers itself, or the cursor's. */
function editorKind(answer: string): string | undefined {
	if (/^\x1b\[\?\d+u$/.test(answer)) { return 'kitty'; } // eslint-disable-line no-control-regex
	if (answer.startsWith('\x1bP>|')) { return 'version'; }
	if (answer.startsWith('\x1bP!|')) { return 'unit'; }
	if (answer.startsWith('\x1b[') && answer.endsWith('t')) { return 'window'; }
	return undefined;
}

/** The questions written to one editor terminal, and what its answers let through to the program. */
export class TerminalReplies {
	/** When each question only the editor answers was written, oldest first, by the kind of its answer. */
	private readonly asked = new Map<string, number[]>();
	/** How many cursor questions were written that no answer took yet. */
	private cursors = 0;
	/** The window's own colour questions written to the terminal, by OSC, that no answer took yet: their answers are the window's. */
	private readonly own = new Map<string, number>();

	/** `learn` hears each colour the editor reports - OSC 10, 11 or 12 and its `rgb` - which is the window's to tell ptyd. */
	constructor(private readonly learn: (osc: '10' | '11' | '12', rgb: string) => void = () => undefined) { }

	/** The terminal went: what was asked of it is answered by none other, and a later cursor position is a key again. */
	reset(): void {
		this.asked.clear();
		this.cursors = 0;
		this.own.clear();
	}

	/** The window asked the terminal its colours itself, OSC 10, 11 and 12: their answers reach no program, whichever answers its own. */
	askedColours(): void {
		for (const osc of ['10', '11', '12']) {
			this.own.set(osc, (this.own.get(osc) ?? 0) + 1);
		}
	}

	/** `data` was written to the terminal at `at`: the questions in it are what its answers may answer. */
	wrote(data: string, at: number): void {
		if (!data.includes('\x1b')) {
			return;
		}
		for (const [question, kind] of QUESTIONS) {
			for (const _match of data.matchAll(question)) {
				this.asked.set(kind, [...this.asked.get(kind) ?? [], at]);
			}
		}
		this.cursors += data.match(CURSOR_QUESTION)?.length ?? 0;
	}

	/**
	 * `data`, as the terminal typed it at `at`, without the answers the program is not to have: the answers to the window's own colour
	 * questions, always; every answer ptyd gives itself - its colour reports too, which teach the window its colours - and one only the
	 * editor gives that does not answer a question of its kind written within {@link FRESH_REPLY_MS}, unless `passAnswers` - a ptyd of an
	 * earlier protocol answers none, and the editor's answers are the program's then. Keys, pastes and mouse reports go through as typed.
	 */
	typed(data: string, at: number, passAnswers = false): string {
		if (!data.includes('\x1b')) {
			return data;
		}
		return data.replace(ANSWER, (answer: string, colour: string | undefined, rgb: string | undefined, decxcpr: string | undefined) => {
			if (rgb !== undefined) {
				if (colour === '10' || colour === '11' || colour === '12') {
					this.learn(colour, rgb);
					// The window asked it: the first answers of its kind are those, answered in the order asked
					const own = this.own.get(colour) ?? 0;
					if (own > 0) {
						if (own === 1) {
							this.own.delete(colour);
						} else {
							this.own.set(colour, own - 1);
						}
						return '';
					}
				}
				return passAnswers ? answer : '';
			}
			if (passAnswers) {
				return answer;
			}
			const kind = editorKind(answer);
			if (kind !== undefined) {
				// A question of its kind the editor never answered - XTWINOPS has some it does not - is no question this one answers
				const asked = (this.asked.get(kind) ?? []).filter(when => at - when <= FRESH_REPLY_MS);
				const when = asked.shift();
				if (asked.length) {
					this.asked.set(kind, asked);
				} else {
					this.asked.delete(kind);
				}
				return when !== undefined ? answer : '';
			}
			if (answer.endsWith('R') && !decxcpr) {
				// A cursor position answers a cursor question ptyd answered already; with none waiting it is a modified F3 key
				if (this.cursors === 0) {
					return answer;
				}
				this.cursors--;
			}
			return '';
		});
	}
}
