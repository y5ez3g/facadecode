/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The adapters of added CLIs (CONFIGURATION-2.3): an entry of a built-in's type runs that built-in's adapter under its own
// name and settings; an entry of type `custom` is a program, started as configured with nothing of Facade's - no YOLO mapping,
// model, effort, prompt, trust or tools, and no capability is configured: an unproved one stays unavailable.

import type { CliAdapter } from './adapter';
import type { EntrySettings } from './entries';

/**
 * The adapter of a program (CONFIGURATION-2.3): its `command` as configured, and nothing of Facade's - no YOLO mapping, no trust given,
 * no status read from its screen. Its sandbox and approvals are its own configuration's, which Facade does not read.
 */
export function programAdapterOf(entry: EntrySettings): CliAdapter {
	return {
		id: entry.name,
		displayName: entry.name,
		setting: entry.setting,
		command: entry.command,
		groups: {},
		takes: { model: false, effort: false },
		values: () => ({}),
		sandbox: () => ({ state: 'unknown' }),
		approvals: () => ({ state: 'unknown' }),
		interruptExit: () => false
	};
}

/**
 * The adapter of an added entry of a built-in's type (CONFIGURATION-2.3): the built-in's own - every group, reader, integration and
 * fact - under the entry's name and settings; `builtIn` names the built-in, whose adapter it is, for what Facade keys by CLI.
 */
export function builtInAdapterOf(builtIn: CliAdapter, entry: EntrySettings): CliAdapter {
	return { ...builtIn, id: entry.name, displayName: entry.name, setting: entry.setting, builtIn: builtIn.id };
}
