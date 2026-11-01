/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A built-in CLI's version, read from what its installation keeps beside the executable - never by running it (CLIS-1.1).
// It is kept with the launch: what decides whether an input adapter observed with that version reads the run's input field
// (CLIS-2.1), whether or not the CLI's own MCP client ever connects (RULES-1.4).

import * as fs from 'fs';
import * as path from 'path';

/** A version as an installation names it: digits and dots, and an optional pre-release or build tail. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The installed version of CLI `cli` whose executable `executable` resolves to, and where it was read; none where its installation says none. */
export function installedVersionOf(cli: string, executable: string): { readonly version: string; readonly source: string } | undefined {
	let real: string;
	try {
		real = fs.realpathSync(executable);
	} catch {
		return undefined;
	}
	switch (cli) {
		case 'claude': {
			// The native installer keeps each version as `.../claude/versions/<version>`, the command a link to the current one
			const name = path.basename(real);
			return path.basename(path.dirname(real)) === 'versions' && VERSION.test(name) ? { version: name, source: real } : undefined;
		}
		case 'codex': {
			// Its standalone package keeps `codex-package.json` in the release folder above `bin/`
			for (let dir = path.dirname(real), up = 0; up < 3; dir = path.dirname(dir), up++) {
				const file = path.join(dir, 'codex-package.json');
				try {
					const version: unknown = (JSON.parse(fs.readFileSync(file, 'utf8')) as { readonly version?: unknown }).version;
					return typeof version === 'string' && VERSION.test(version) ? { version, source: file } : undefined;
				} catch {
					// Not this folder
				}
			}
			return undefined;
		}
		case 'muse': {
			// Its binary is named by its version; its launcher script keeps the version it runs in `.muse-version` beside it, and runs
			// `muse-bin-<version>` there - having first downloaded another where that binary is not there, so then no version is known
			const named = /^muse-bin-(?<version>.+)$/.exec(path.basename(real).replace(/\.exe$/i, ''))?.groups?.version;
			if (named !== undefined) {
				return VERSION.test(named) ? { version: named, source: real } : undefined;
			}
			const file = path.join(path.dirname(real), '.muse-version');
			try {
				const version = fs.readFileSync(file, 'utf8').trim();
				return VERSION.test(version) && ['', '.exe'].some(suffix => fs.existsSync(path.join(path.dirname(real), `muse-bin-${version}${suffix}`))) ? { version, source: file } : undefined;
			} catch {
				return undefined;
			}
		}
		default:
			return undefined;
	}
}
