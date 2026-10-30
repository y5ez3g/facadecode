/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The settings of a built-in CLI, read strictly (CLIS-1.2): its `path`. A value of the wrong kind is a configuration error naming its
// setting path; it is never translated or replaced by a default, and the person's value is left for them to correct.

import { truncateText } from '../base/text';

/** A CLI problem by its kind and values, for the person's language (UX-2.4); its English is said beside it. */
export interface CliSaid {
	readonly kind: string;
	readonly values: readonly string[];
}

/** A built-in's settings as read: its values where valid, and what is wrong, each naming its setting. */
export interface CliSettings {
	/** The configured program, trimmed; empty for the CLI's command on PATH (CLIS-1.2). */
	readonly path: string;
	readonly problems: readonly string[];
	/** The problem by kind and values, where there is one. */
	readonly said?: CliSaid;
}

/** A value as a problem quotes it: as JSON, cut short between whole code points. */
export function shown(value: unknown): string {
	return truncateText(JSON.stringify(value) ?? String(value), 60);
}

/** Whether `text` holds a character no path can carry to a process. */
function hasNul(text: string): boolean {
	return text.includes('\0');
}

/**
 * A built-in's settings under `setting` (`facade.claude`), as `read` gives its `path` (CLIS-1.2). A wrong value is a problem naming its
 * path; Facade's default stands in only so the rest can be shown.
 */
export function readCliSettings(setting: string, read: (key: 'path') => unknown): CliSettings {
	const problems: string[] = [];
	let said: CliSaid | undefined;
	const configured = read('path');
	if (configured !== undefined && typeof configured !== 'string') {
		problems.push(`${setting}.path must be a string; received ${shown(configured)}`);
		said = { kind: 'path_type', values: [setting, shown(configured)] };
	} else if (typeof configured === 'string' && configured !== '' && !configured.trim()) {
		// Never PATH's command in its place: a path set is the program it names (CLIS-1.2)
		problems.push(`${setting}.path contains only whitespace. Set the program's path, or leave it empty to find the CLI on PATH`);
		said = { kind: 'path_blank', values: [setting] };
	} else if (typeof configured === 'string' && hasNul(configured)) {
		problems.push(`${setting}.path contains a NUL character, which no path can hold`);
		said = { kind: 'path_nul', values: [setting] };
	}
	return {
		path: typeof configured === 'string' ? configured.trim() : '',
		problems,
		...(said ? { said } : {})
	};
}
