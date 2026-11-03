/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The mouse reports a terminal types for a program that asked for them, whole where the terminal could not measure one
// (LIFECYCLE-2.2). VS Code's terminal gives a click to a link before it reports the button's release, measuring the
// terminal for that report. A link that opens over an editor terminal - a file, or the browser for a localhost link - takes
// the terminal out of the page first, and the release goes as `ESC [ < 0 ; NaN ; NaN m`: a CLI reads its end as typed text
// ("aN;NaNm"). Such a release keeps the position of the report before it - the press of the same click, measured while
// the terminal was there - and one with no report before it is left out.

/** SGR and SGR-pixel reports, `ESC [ < button ; x ; y M` or `m` for a release, and URXVT's, `ESC [ button ; x ; y M`. */
// eslint-disable-next-line no-control-regex
const NUMBERED = /\x1b\[(<?)(\d+);(\d+|NaN);(\d+|NaN)([Mm])/g;
/** The default and UTF-8 encodings, `ESC [ M` and three characters: a position not measured is a NUL each. */
// eslint-disable-next-line no-control-regex
const CHARACTERS = /\x1b\[M([\s\S])([\s\S])([\s\S])/gu;

/** One terminal's mouse reports, as they are typed into it. */
export class MouseReports {
	/** The last measured position, in the form its encoding writes it. */
	private numbered: { readonly x: string; readonly y: string } | undefined;
	private characters: { readonly x: string; readonly y: string } | undefined;

	/** `data` with a report the terminal could not measure at the last measured position, or left out where there is none. */
	repair(data: string): string {
		if (!data.includes('\x1b[')) {
			return data;
		}
		return data
			.replace(NUMBERED, (report, sgr: string, button: string, x: string, y: string, final: string) => {
				// URXVT has no release of its own: an `m` is no report of its
				if (!sgr && final === 'm') {
					return report;
				}
				if (x !== 'NaN' && y !== 'NaN') {
					this.numbered = { x, y };
					return report;
				}
				return this.numbered ? `\x1b[${sgr}${button};${this.numbered.x};${this.numbered.y}${final}` : '';
			})
			.replace(CHARACTERS, (report, button: string, x: string, y: string) => {
				if (x !== '\0' && y !== '\0') {
					this.characters = { x, y };
					return report;
				}
				return this.characters ? `\x1b[M${button}${this.characters.x}${this.characters.y}` : '';
			});
	}
}
