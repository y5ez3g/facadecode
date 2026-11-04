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

	/** `learn` hears each colour the editor reports - OSC 10, 11 or 12 and its `rgb` - which is the window's to tell ptyd. */
	constructor(private readonly learn: (osc: '10' | '11' | '12', rgb: string) => void = () => undefined) { }

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
	 * `data`, as the terminal typed it at `at`, without the answers the program is not to have: every answer ptyd gives itself - its
	 * colour reports too, which teach the window its colours - and one only the editor gives that does not answer a question of its
	 * kind written within {@link FRESH_REPLY_MS}. Keys, pastes and mouse reports go through as typed.
	 */
	typed(data: string, at: number): string {
		if (!data.includes('\x1b')) {
			return data;
		}
		return data.replace(ANSWER, (answer: string, colour: string | undefined, rgb: string | undefined, decxcpr: string | undefined) => {
			if (rgb !== undefined) {
				if (colour === '10' || colour === '11' || colour === '12') {
					this.learn(colour, rgb);
				}
				return '';
			}
			const kind = editorKind(answer);
			if (kind !== undefined) {
				const asked = this.asked.get(kind) ?? [];
				const when = asked.shift();
				if (!asked.length) {
					this.asked.delete(kind);
				}
				return when !== undefined && at - when <= FRESH_REPLY_MS ? answer : '';
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
