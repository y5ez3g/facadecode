/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The mouse settings a CLI writes to an editor terminal, written only where they change its mouse (LIFECYCLE-2.2). VS Code's
// terminal (xterm.js) has one mouse protocol - the last of modes 9, 1000, 1002 and 1003 set, none once any of them is reset -
// and one encoding, 1006's or 1016's, the default once either is reset. Each protocol it is set to, even the one it has, stops
// the reporting of a drag in progress: it follows a drag only from a press on, and 1000's protocol reports none. Claude Code sets
// 1000, 1002, 1003 and 1006 again with its first input after five seconds without any, which is often the very press that starts
// a selection: the drag's motion then never reaches it, and nothing is selected.

/** The protocol each mode sets, as xterm.js has them. */
const PROTOCOLS: ReadonlyMap<number, string> = new Map([[9, 'x10'], [1000, 'vt200'], [1002, 'drag'], [1003, 'any']]);
/** The encoding each mode sets. UTF-8's 1005 and URXVT's 1015 are mouse settings xterm.js ignores. */
const ENCODINGS: ReadonlyMap<number, string> = new Map([[1006, 'sgr'], [1016, 'sgr-pixels']]);
const IGNORED: ReadonlySet<number> = new Set([1005, 1015]);
const NONE = 'none';
const DEFAULT = 'default';

/** A private mode setting or reset, `CSI ? Pm h` or `l`, with either CSI; or a full reset, `ESC c`. */
// eslint-disable-next-line no-control-regex
const SETTING = /(?:\x1b\[|\x9b)\?([\d;]*)([hl])|\x1bc/g;
/** What could still become such a setting or reset, cut off at the end of what was written: the next write completes it. */
// eslint-disable-next-line no-control-regex
const CUT = /^(?:\x1b(?:\[(?:\?[\d;]*)?)?|\x9b(?:\?[\d;]*)?)$/;

function isMouse(mode: number): boolean {
	return PROTOCOLS.has(mode) || ENCODINGS.has(mode) || IGNORED.has(mode);
}

/** One editor terminal's mouse, as what was written to it since it opened set it. */
export class MouseModes {
	private protocol = NONE;
	private encoding = DEFAULT;
	/** The end of the last write, cut off in the middle of what could be a setting, which is written with the next. */
	private held = '';

	/** The terminal opened anew or went, or is to be drawn from a reset: its mouse is the default, and nothing is held for it. */
	reset(): void {
		this.protocol = NONE;
		this.encoding = DEFAULT;
		this.held = '';
	}

	/**
	 * What of `data`, written after what came before, the terminal is to be written: all of it but each run of mouse settings written
	 * one right after another - in any number of sequences - that leaves its mouse as it was. A run that changes it goes whole, and so
	 * does a setting that sets other modes too. The end of `data` cut off in the middle of what could be a setting waits for the next.
	 */
	shown(data: string): string {
		let text = this.held + data;
		this.held = '';
		// Such a cut-off end holds one escape, at its start: the last one written
		const last = Math.max(text.lastIndexOf('\x1b'), text.lastIndexOf('\x9b'));
		if (last >= 0 && CUT.test(text.slice(last))) {
			this.held = text.slice(last);
			text = text.slice(0, last);
		}
		if (!text.includes('?') && !text.includes('\x1bc')) {
			return text;
		}
		let shown = '';
		// Where the text not yet shown starts, and the run of mouse settings being read: where it starts and ends, the mouse before it
		let from = 0;
		let run: { start: number; end: number; protocol: string; encoding: string } | undefined;
		const endRun = () => {
			if (run) {
				const unchanged = run.protocol === this.protocol && run.encoding === this.encoding;
				shown += text.slice(from, unchanged ? run.start : run.end);
				from = run.end;
				run = undefined;
			}
		};
		for (const match of text.matchAll(SETTING)) {
			const start = match.index!;
			const end = start + match[0].length;
			if (match[0] === '\x1bc') {
				endRun();
				this.protocol = NONE;
				this.encoding = DEFAULT;
				continue;
			}
			const modes = match[1].split(';').filter(each => each !== '').map(Number);
			const mouseOnly = modes.length > 0 && modes.every(isMouse);
			if (run && (!mouseOnly || start !== run.end)) {
				endRun();
			}
			if (mouseOnly && !run) {
				shown += text.slice(from, start);
				from = start;
				run = { start, end, protocol: this.protocol, encoding: this.encoding };
			}
			if (run) {
				run.end = end;
			}
			this.apply(modes, match[2] === 'h');
		}
		endRun();
		return shown + text.slice(from);
	}

	private apply(modes: readonly number[], set: boolean): void {
		for (const mode of modes) {
			const protocol = PROTOCOLS.get(mode);
			const encoding = ENCODINGS.get(mode);
			if (protocol) {
				this.protocol = set ? protocol : NONE;
			} else if (encoding) {
				this.encoding = set ? encoding : DEFAULT;
			}
		}
	}
}
